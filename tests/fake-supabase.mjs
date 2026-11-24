// tests/fake-supabase.mjs — a stand-in for Supabase's PostgREST RPC endpoint, backed by a REAL
// Postgres (PGlite, in-process WASM). The migration file is applied unmodified, so these tests
// exercise the actual SQL functions, constraints, grants and audit trigger — not a JS imitation.
// No network, no real Supabase project, no customer data.

import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATION = path.join(here, "..", "db", "migrations", "0001_bsc030_report_retention.sql");

export const FAKE_URL = "https://fake-project.supabase.test";
export const FAKE_KEY = "TEST_SERVICE_ROLE_KEY";

// Argument types per function, so named-notation calls get explicit casts.
const SIGS = {
  lbd_claim:   { p_license_hash: "text", p_product_id: "text", p_sale_id: "text", p_inputs: "jsonb", p_retention_days: "int", p_stale_seconds: "int", p_max_attempts: "int" },
  lbd_complete:{ p_report_id: "uuid", p_attempt: "int", p_report: "jsonb" },
  lbd_fail:    { p_report_id: "uuid", p_attempt: "int", p_reason: "text" },
  lbd_retrieve:{ p_license_hash: "text" },
  lbd_delete:  { p_license_hash: "text", p_report_id: "uuid", p_actor: "text", p_reason: "text" },
  lbd_extend:  { p_license_hash: "text", p_report_id: "uuid", p_days: "int", p_actor: "text" },
  lbd_purge_expired: { p_limit: "int" },
};

export async function createFakeSupabase() {
  const db = new PGlite();
  // Mirrors Supabase: service_role bypasses RLS; anon/authenticated do not.
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
  await db.exec(fs.readFileSync(MIGRATION, "utf8"));

  const state = {
    db,
    mode: "up",            // up | down | drop_response:<fn> (commit, then lose the response once)
    calls: [],             // every RPC: { fn, args, status }
    badKeyCalls: 0,
  };

  state.handle = async (url, opts = {}) => {
    const m = String(url).match(/\/rest\/v1\/rpc\/([a-z_]+)$/);
    const fn = m && m[1];
    const h = opts.headers || {};
    if (h.apikey !== FAKE_KEY || h.Authorization !== `Bearer ${FAKE_KEY}`) {
      state.badKeyCalls++;
      return json(401, { message: "invalid key" });
    }
    if (state.mode === "down") { state.calls.push({ fn, status: 503 }); return json(503, { message: "unavailable" }); }
    if (!fn || !SIGS[fn]) return json(404, { message: "no such function" });

    const args = JSON.parse(String(opts.body || "{}"));
    const sig = SIGS[fn];
    const names = Object.keys(args);
    for (const n of names) if (!sig[n]) return json(400, { message: `unknown arg ${n}` });
    const params = names.map(n => (sig[n] === "jsonb" && args[n] !== null ? JSON.stringify(args[n]) : args[n]));
    const sql = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}::${sig[n]}`).join(", ")}) as r`;
    let row;
    try {
      // Run as the service role, exactly as PostgREST would with the service key.
      await db.exec("set role service_role");
      row = (await db.query(sql, params)).rows[0];
    } catch (e) {
      state.calls.push({ fn, args, status: 400, error: e.message });
      return json(400, { message: e.message });
    } finally {
      await db.exec("reset role");
    }
    state.calls.push({ fn, args, status: 200 });
    if (state.mode === `drop_response:${fn}`) {
      state.mode = "up";
      throw new TypeError("fetch failed (simulated lost response after commit)");
    }
    return json(200, row.r);
  };

  state.rows = async () => (await db.query("select * from diagnostic_reports order by created_at")).rows;
  state.events = async () => (await db.query("select id, report_id, license_hash, event, outcome, actor, detail from diagnostic_report_events order by id")).rows;
  state.q = async (sql, p) => (await db.query(sql, p)).rows;
  return state;
}

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
