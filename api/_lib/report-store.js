// api/_lib/report-store.js — BSC-030 retained-report storage (Supabase via PostgREST RPC).
// Files under api/_lib are not exposed as Vercel routes.
//
// Everything that touches stored reports goes through the lbd_* SQL functions in
// db/migrations/0001_bsc030_report_retention.sql. Each function writes its audit event in
// the same transaction as the change, so this module never logs separately.
//
// Uses the existing SUPABASE_URL + SUPABASE_SERVICE_KEY env vars and plain fetch — no new
// dependency, no new vendor.

import crypto from "node:crypto";

export const INPUTS_FORMAT = "lbd.inputs.v1";
export const REPORT_FORMAT = "lbd.report.v1";

// The fixed input field set (requirement 1). Mirrors INTAKE_FIELDS in diagnostic.js. Postgres
// jsonb does not keep key order, so responses re-emit intake in this order.
export const INPUT_FIELD_ORDER = [
  "name", "email", "business", "location", "type",
  "website", "booking", "google", "social",
  "service", "ideal", "problem", "focus",
];

export const RETENTION_MIN_DAYS = 90;
export const MAX_GENERATION_ATTEMPTS = 3;   // requirement 5: retries are capped per purchase
export const STALE_ATTEMPT_SECONDS = 300;   // an attempt silent for 5 min is treated as dead
const RPC_TIMEOUT_MS = 8000;
const WRITE_RETRIES = 3;                    // for idempotent writes only (complete/fail)
const RETRY_BASE_MS = Number(process.env.LBD_RETRY_BASE_MS || 250);

export class StoreError extends Error {
  constructor(msg, { transient = true } = {}) { super(msg); this.name = "StoreError"; this.transient = transient; }
}

export function storeConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
}

export function retentionDays() {
  const n = Number(process.env.REPORT_RETENTION_DAYS || RETENTION_MIN_DAYS);
  return Number.isFinite(n) ? Math.max(RETENTION_MIN_DAYS, Math.floor(n)) : RETENTION_MIN_DAYS;
}

/* The raw license key is never stored or logged. Gumroad keys are long random strings,
   so an unsalted SHA-256 is not reversible by guessing; the prefix versions the scheme. */
export function licenseHash(licenseKey) {
  return crypto.createHash("sha256").update(`lbd:v1:${String(licenseKey).trim()}`).digest("hex");
}

/* ---------------------------------------------------------------- formats */

export function buildInputs(intake, now = new Date()) {
  const fixed = {};
  for (const k of INPUT_FIELD_ORDER) {
    if (typeof intake?.[k] !== "string") throw new StoreError(`inputs: field ${k} missing`, { transient: false });
    fixed[k] = intake[k];
  }
  return { format: INPUTS_FORMAT, received_at: now.toISOString(), intake: fixed };
}

export function buildStoredReport({ report, source_log, validation_notes, model }, now = new Date()) {
  if (!report || typeof report !== "object") throw new StoreError("report: missing", { transient: false });
  if (!Array.isArray(source_log)) throw new StoreError("report: source_log missing", { transient: false });
  return {
    format: REPORT_FORMAT,
    generated_at: now.toISOString(),
    model: model || null,
    report,
    source_log: source_log.map(({ label, url, status, reason }) => ({ label, url, status, reason: reason || "" })),
    validation_notes: Array.isArray(validation_notes) ? validation_notes : [],
  };
}

export function isValidStoredInputs(x) {
  return !!x && x.format === INPUTS_FORMAT && x.intake && INPUT_FIELD_ORDER.every(k => typeof x.intake[k] === "string");
}
export function isValidStoredReport(x) {
  return !!x && x.format === REPORT_FORMAT && x.report && Array.isArray(x.source_log) && Array.isArray(x.validation_notes);
}

/* The ONE response shape for a finished report. Generation, replay and retrieval all
   build it from the stored record, so the buyer sees byte-identical content each time. */
export function reportResponse({ inputs, report, retain_until }) {
  if (!isValidStoredInputs(inputs) || !isValidStoredReport(report)) {
    throw new StoreError("stored record failed format check", { transient: false });
  }
  return {
    verified: true,
    stored: true,
    retained_until: retain_until,
    generated_at: report.generated_at,
    intake: Object.fromEntries(INPUT_FIELD_ORDER.map(k => [k, inputs.intake[k]])), // fixed order on the wire
    report: report.report,
    source_log: report.source_log,
    validation_notes: report.validation_notes,
  };
}

/* ---------------------------------------------------------------- transport */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function rpcOnce(fn, args) {
  const base = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!base || !key) throw new StoreError("storage not configured", { transient: false });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${base}/rest/v1/rpc/${fn}`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        "apikey": key,
        "Authorization": `Bearer ${key}`,
      },
      body: JSON.stringify(args),
    });
  } catch (e) {
    throw new StoreError(`${fn}: network ${e.name === "AbortError" ? "timeout" : "error"}`);
  } finally { clearTimeout(timer); }
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    // 4xx from PostgREST = our request or a SQL exception (not worth retrying); 5xx = transient.
    throw new StoreError(`${fn}: HTTP ${res.status}`, { transient: res.status >= 500 || res.status === 429 });
  }
  return body;
}

async function rpc(fn, args, { retries = 0 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try { return await rpcOnce(fn, args); }
    catch (e) {
      lastErr = e;
      if (!e.transient || i === retries) break;
      await sleep(RETRY_BASE_MS * 2 ** i);
    }
  }
  throw lastErr;
}

/* ---------------------------------------------------------------- operations */

// Not retried: a lost response after a committed claim would read back as in_progress.
export function claim({ hash, productId, saleId, inputs }) {
  return rpc("lbd_claim", {
    p_license_hash: hash, p_product_id: productId, p_sale_id: saleId || null, p_inputs: inputs,
    p_retention_days: retentionDays(), p_stale_seconds: STALE_ATTEMPT_SECONDS,
    p_max_attempts: MAX_GENERATION_ATTEMPTS,
  });
}

// Idempotent in SQL (same attempt + identical report => ok), so safe to retry.
export function complete({ reportId, attempt, stored }) {
  return rpc("lbd_complete", { p_report_id: reportId, p_attempt: attempt, p_report: stored }, { retries: WRITE_RETRIES });
}

// Guarded by attempt number in SQL, so a duplicate is a no-op; safe to retry.
export function fail({ reportId, attempt, reason }) {
  return rpc("lbd_fail", { p_report_id: reportId, p_attempt: attempt, p_reason: String(reason || "unknown").slice(0, 200) }, { retries: WRITE_RETRIES });
}

export function retrieve({ hash }) {
  return rpc("lbd_retrieve", { p_license_hash: hash }, { retries: 1 });
}

export function remove({ hash = null, reportId = null, actor, reason = "" }) {
  return rpc("lbd_delete", { p_license_hash: hash, p_report_id: reportId, p_actor: actor, p_reason: reason });
}

export function extend({ hash = null, reportId = null, days, actor }) {
  return rpc("lbd_extend", { p_license_hash: hash, p_report_id: reportId, p_days: days, p_actor: actor });
}

export function purgeExpired(limit = 500) {
  return rpc("lbd_purge_expired", { p_limit: limit });
}
