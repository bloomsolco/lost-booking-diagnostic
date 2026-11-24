// api/report-admin.js — BSC-030 operator actions on stored diagnostics. Server-to-server only.
//
//   POST  Authorization: Bearer $REPORT_ADMIN_TOKEN
//         { action: "extend", report_id | license_key, days }   retention can only move later
//         { action: "delete", report_id | license_key, reason } scrub inputs + report
//         { action: "purge" }                                    scrub everything past retention
//   GET   Authorization: Bearer $CRON_SECRET                     daily purge (Vercel Cron)
//
// Deliberately NO read action: an operator can extend or delete a record but cannot view
// its contents through this system. Only the buyer's license key retrieves a report.
// Disabled entirely (404) unless the token env var is set.

import crypto from "node:crypto";
import * as store from "./_lib/report-store.js";

function tokenMatches(header, secret) {
  if (!secret || secret.length < 24) return false;
  const m = /^Bearer (.+)$/.exec(header || "");
  if (!m) return false;
  const a = crypto.createHash("sha256").update(m[1]).digest();
  const b = crypto.createHash("sha256").update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const auth = req.headers.authorization || "";

  if (req.method === "GET") {
    if (!tokenMatches(auth, process.env.CRON_SECRET)) return res.status(404).end();
    try { return res.status(200).json(await store.purgeExpired()); }
    catch { return res.status(503).json({ error: "purge failed; will retry on next run" }); }
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!tokenMatches(auth, process.env.REPORT_ADMIN_TOKEN)) return res.status(404).end();
  if (!store.storeConfigured()) return res.status(503).json({ error: "storage not configured" });

  const b = req.body || {};
  const reportId = typeof b.report_id === "string" && UUID_RE.test(b.report_id) ? b.report_id : null;
  const key = typeof b.license_key === "string" ? b.license_key.trim() : "";
  const hash = !reportId && key ? store.licenseHash(key) : null;

  try {
    if (b.action === "purge") return res.status(200).json(await store.purgeExpired());
    if (!reportId && !hash) return res.status(400).json({ error: "report_id or license_key required" });
    if (b.action === "extend") {
      const days = Number(b.days);
      if (!Number.isInteger(days) || days < 1 || days > 3650) return res.status(400).json({ error: "days must be an integer 1..3650" });
      return res.status(200).json(await store.extend({ hash, reportId, days, actor: "admin" }));
    }
    if (b.action === "delete") {
      return res.status(200).json(await store.remove({ hash, reportId, actor: "admin", reason: String(b.reason || "admin_request").slice(0, 200) }));
    }
    return res.status(400).json({ error: "unknown action" });
  } catch (e) {
    return res.status(e && e.transient === false ? 400 : 503).json({ error: "storage error" });
  }
}
