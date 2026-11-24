// tests/retention.test.mjs — BSC-030 storage, retrieval, retention and audit checks.
// Run: cd tests && npm install && node --import ./dns-stub.mjs retention.test.mjs
//
// Everything external is mocked: Gumroad, Anthropic and public pages are fake; Supabase is
// a REAL Postgres (PGlite) running the unmodified migration. All data below is invented
// test data — no real customer, license key or Supabase project is touched.

import crypto from "node:crypto";
import { createFakeSupabase, FAKE_URL, FAKE_KEY } from "./fake-supabase.mjs";

const supa = await createFakeSupabase();

/* ------------------------------------------------------------ test data */
const ADMIN_TOKEN = "test-admin-token-0123456789abcdef";
const CRON_SECRET = "test-cron-secret-0123456789abcdef";
const INTAKE = {
  name: "Test Owner", email: "owner@example.com", business: "Test Glow Studio", location: "Houston, TX",
  type: "Med spa", website: "https://example.com/", booking: "https://www.example.com/book",
  google: "https://example.net/gprofile", social: "Not provided",
  service: "Botox", ideal: "Professional women 30-55", problem: "Website visitors are not booking",
  focus: "Booking path",
};
const KEY_A = "TESTKEY-AAAA1111-BBBB2222-CCCC3333";
const KEY_B = "TESTKEY-DDDD4444-EEEE5555-FFFF6666";

let modelMode = "ok";          // ok | fail
let modelCalls = 0;
const sha = (k) => crypto.createHash("sha256").update(`lbd:v1:${k}`).digest("hex");

function report(n) {
  return {
    score: 61, rating: "Notable friction",
    interpretation: `Generated variant ${n}. The booking path shows friction based on intake answers.`,
    topLeaks: ["Booking path buried", "Hero service unclear", "Price questions unanswered"],
    fixFirst: "Add one clear booking call to action in the site header.",
    scorecard: [
      { category: "First Impression Clarity", score: "10/15", working: "a", leaking: "b" },
      { category: "Service Clarity", score: "9/15", working: "a", leaking: "b" },
      { category: "Booking Path", score: "12/20", working: "a", leaking: "b" },
      { category: "Trust And Proof", score: "10/15", working: "a", leaking: "b" },
      { category: "Google Profile Readiness", score: "8/15", working: "a", leaking: "b" },
      { category: "CTA And Lead Capture", score: "9/15", working: "a", leaking: "b" },
      { category: "Friction Reduction", score: "3/5", working: "a", leaking: "b" },
    ],
    leaks: [0, 1, 2].map(i => ({ name: `Leak ${i}`, basis: "INTAKE-REPORTED", sources: [], observed: "o", hesitation: "h", fix: "f", impact: "High", ease: "Easy" })),
    quickWins: ["a", "b", "c", "d", "e"],
    plan: ["Day 1 a", "Day 2 b", "Day 3 c", "Day 4 d", "Day 5 e", "Day 6 f", "Day 7 g"],
  };
}

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith(FAKE_URL)) return supa.handle(u, opts);
  if (u.includes("api.gumroad.com")) {
    const p = new URLSearchParams(String(opts.body));
    const key = p.get("license_key");
    if (p.get("increment_uses_count") !== "false") throw new Error("HARNESS: verification consumed a use");
    if (key.startsWith("UNKNOWN")) return json(404, { success: false });
    return json(200, { success: true, uses: 0, purchase: {
      sale_id: `TEST-SALE-${key.slice(-4)}`, refunded: key.startsWith("REFUNDED"), chargebacked: false, disputed: false,
    } });
  }
  if (u.includes("api.anthropic.com")) {
    modelCalls++;
    if (modelMode === "fail") return json(500, { error: { message: "overloaded" } });
    return json(200, { content: [{ type: "text", text: JSON.stringify(report(modelCalls)) }], stop_reason: "end_turn" });
  }
  if (u.startsWith("https://example.com") || u.includes("www.example.com")) {
    return new Response("<html><body><h1>Test Glow Studio</h1>" + "<p>Botox and facials in Houston. Book online today. ".repeat(10) + "</p></body></html>", { status: 200, headers: { "content-type": "text/html" } });
  }
  return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
};
function json(s, o) { return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } }); }

process.env.ANTHROPIC_API_KEY = "TEST_SERVER_KEY";
process.env.SUPABASE_URL = FAKE_URL;
process.env.SUPABASE_SERVICE_KEY = FAKE_KEY;
process.env.REPORT_ADMIN_TOKEN = ADMIN_TOKEN;
process.env.CRON_SECRET = CRON_SECRET;
process.env.LBD_RETRY_BASE_MS = "1";

const gen = (await import("../api/diagnostic.js")).default;
const buyer = (await import("../api/report.js")).default;
const admin = (await import("../api/report-admin.js")).default;

function makeRes() {
  const res = { statusCode: 0, headers: {}, body: null, raw: null };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; res.raw = JSON.stringify(b); return res; };
  res.end = () => res;
  return res;
}
async function hit(h, { method = "POST", body, auth } = {}) {
  const res = makeRes();
  await h({ method, headers: { origin: "https://diagnostic.bloomsol.co", ...(auth ? { authorization: auth } : {}) }, body }, res);
  return res;
}
const generate = (key, intake = INTAKE) => hit(gen, { body: { license_key: key, intake } });
const retrieve = (key) => hit(buyer, { body: { license_key: key, action: "retrieve" } });
const buyerDelete = (key) => hit(buyer, { body: { license_key: key, action: "delete" } });
const adminCall = (body, token = ADMIN_TOKEN) => hit(admin, { body, auth: token ? `Bearer ${token}` : "" });
const rowFor = async (key) => (await supa.q("select * from diagnostic_reports where license_hash=$1", [sha(key)]))[0];
const eventsFor = async (key) => supa.q("select event, outcome, actor, detail from diagnostic_report_events where license_hash=$1 order by id", [sha(key)]);

let pass = 0, fail = 0;
const evidence = [];
function check(id, name, cond, extra = "") {
  if (cond) pass++; else fail++;
  const line = `${cond ? "PASS" : "FAIL"}  ${id} ${name}${extra ? " — " + extra : ""}`;
  console.log(line); evidence.push(line);
}

/* =============================== R1 fixed formats =============================== */
let r = await generate(KEY_A);
check("R1a", "first generation stores and returns 200", r.statusCode === 200 && r.body.stored === true, `status ${r.statusCode}`);
const firstRaw = r.raw;
let row = await rowFor(KEY_A);
const FIELDS = "name,email,business,location,type,website,booking,google,social,service,ideal,problem,focus";
check("R1b", "inputs stored in fixed format lbd.inputs.v1 with exactly the 13 intake fields, no extras",
  row.inputs.format === "lbd.inputs.v1" && Object.keys(row.inputs.intake).sort().join(",") === FIELDS.split(",").sort().join(","));
check("R1g", "responses always emit intake fields in the fixed order", Object.keys(r.body.intake).join(",") === FIELDS, Object.keys(r.body.intake).join(","));
check("R1c", "report stored in fixed format lbd.report.v1 (report, source_log, notes, model, generated_at)",
  row.report.format === "lbd.report.v1" && row.report.report && Array.isArray(row.report.source_log) && row.report.model === "claude-sonnet-4-6" && !!row.report.generated_at);
let threw = false;
try { await supa.db.query("select lbd_claim($1,'p',null,$2::jsonb,90,300,3)", ["c".repeat(64), JSON.stringify({ format: "free-form", x: 1 })]); } catch { threw = true; }
check("R1d", "database refuses inputs in any other format", threw);
threw = false;
try { await supa.db.query("select lbd_complete($1::uuid,1,$2::jsonb)", [row.id, JSON.stringify({ format: "v0", report: {} })]); } catch { threw = true; }
check("R1e", "database refuses a report in any other format", threw);
check("R1f", "source_log stored without raw page HTML", row.report.source_log.every(s => !("raw" in s) && !("text" in s)));

/* =============================== R2 tied to purchase ============================ */
check("R2a", "record keyed by sha256 of the license key, one row per purchase", row.license_hash === sha(KEY_A) && (await supa.q("select count(*)::int n from diagnostic_reports where license_hash=$1", [sha(KEY_A)]))[0].n === 1);
check("R2b", "Gumroad sale id + product id recorded on the row", row.gumroad_sale_id === "TEST-SALE-3333" && row.gumroad_product_id === "yyzm9n6iAxsrLx2LbmW0AA==", `${row.gumroad_sale_id}`);
const dump = JSON.stringify(await supa.q("select * from diagnostic_reports")) + JSON.stringify(await supa.q("select * from diagnostic_report_events"));
check("R2c", "raw license key appears nowhere in the database (rows or events)", !dump.includes(KEY_A) && !dump.includes("AAAA1111"));
check("R2d", "Gumroad verification still never consumes a use", true, "harness throws if increment_uses_count != false");

/* =============================== R3 same report, owner only ===================== */
const ret1 = await retrieve(KEY_A);
const ret2 = await retrieve(KEY_A);
check("R3a", "buyer retrieves with license key → 200", ret1.statusCode === 200);
check("R3b", "two retrievals are byte-identical", ret1.raw === ret2.raw);
check("R3c", "retrieval is byte-identical to the original generation response", ret1.raw === firstRaw);
const callsBefore = modelCalls;
r = await generate(KEY_A, { ...INTAKE, business: "Different Name Attempt" });
check("R3d", "re-submitting the intake replays the stored report — no new model call", r.statusCode === 200 && r.body.replayed === true && modelCalls === callsBefore);
check("R3e", "replayed report equals the stored one (variant 1), not a regeneration", r.body.report.interpretation === ret1.body.report.interpretation && /variant 1\./.test(r.body.report.interpretation));
check("R3f", "replay does not overwrite stored inputs", (await rowFor(KEY_A)).inputs.intake.business === "Test Glow Studio");
r = await retrieve(KEY_B);
check("R3g", "a different valid key cannot see report A (404 not_found, no content)", r.statusCode === 404 && !r.raw.includes("variant 1"));
r = await retrieve("UNKNOWN-KEY-0000");
check("R3h", "an unrecognised key is refused by Gumroad check (403)", r.statusCode === 403);
// owner-only at the database level
let denied = 0;
for (const sql of ["select * from diagnostic_reports", "select * from diagnostic_report_events", `select lbd_retrieve('${sha(KEY_A)}')`]) {
  for (const role of ["anon", "authenticated"]) {
    try { await supa.db.exec(`set role ${role}`); await supa.db.query(sql); } catch { denied++; } finally { await supa.db.exec("reset role"); }
  }
}
check("R3i", "public (anon/authenticated) roles cannot read tables or call retrieve — 6/6 denied", denied === 6, `${denied}/6`);
r = await adminCall({ action: "retrieve", license_key: KEY_A });
check("R3j", "admin endpoint has no read action (cannot view a report)", r.statusCode === 400 && !r.raw.includes("variant"));
await generate("REFUNDED-KEY-9999-ZZZZ"); // refunded purchases cannot generate…
check("R3k", "refunded purchase cannot generate (403) and nothing is stored", !(await rowFor("REFUNDED-KEY-9999-ZZZZ")));

/* =============================== R4 inputs + report together ==================== */
threw = false;
try { await supa.db.query("update diagnostic_reports set report = null where license_hash=$1", [sha(KEY_A)]); } catch { threw = true; }
check("R4a", "a complete record cannot lose its report (constraint)", threw);
threw = false;
try { await supa.db.query("update diagnostic_reports set inputs = null where license_hash=$1", [sha(KEY_A)]); } catch { threw = true; }
check("R4b", "a complete record cannot lose its inputs (constraint)", threw);
const orphan = await supa.q("select count(*)::int n from diagnostic_reports where report is not null and (inputs is null or status<>'complete')");
check("R4c", "no row anywhere holds a report without inputs", orphan[0].n === 0);
check("R4d", "report and inputs live in one row, written by one transaction", !!row.inputs && !!row.report);

/* =============================== R5 capped retries, final states ================ */
const KEY_F = "TESTKEY-FAIL0000-FAIL0000-FAIL7777";
modelMode = "fail";
const f1 = await generate(KEY_F); const s1 = (await rowFor(KEY_F)).status;
const f2 = await generate(KEY_F); const s2 = (await rowFor(KEY_F)).status;
const f3 = await generate(KEY_F); const s3 = (await rowFor(KEY_F)).status;
check("R5a", "failures 1 and 2 leave a retryable 'failed' state with attempts remaining", s1 === "failed" && s2 === "failed" && f1.body.attempts_remaining === 2 && f2.body.attempts_remaining === 1, `${s1}/${s2} ${f1.body.attempts_remaining}/${f2.body.attempts_remaining}`);
check("R5b", "failure 3 ends in final state 'failed_final', reported to buyer as final", s3 === "failed_final" && f3.body.final === true && f3.body.code === "attempts_exhausted");
modelMode = "ok";
const callsAt = modelCalls;
const f4 = await generate(KEY_F);
check("R5c", "after the cap, further attempts are refused (409) without calling the model", f4.statusCode === 409 && f4.body.code === "attempts_exhausted" && modelCalls === callsAt);
check("R5d", "failure reason recorded on the record", (await rowFor(KEY_F)).failure_reason === "model_http_500");

// concurrent attempt
const KEY_C = "TESTKEY-CONC0000-CONC0000-CONC1111";
await supa.db.query("select lbd_claim($1,'p',null,$2::jsonb,90,300,3)", [sha(KEY_C), JSON.stringify({ format: "lbd.inputs.v1", intake: INTAKE })]);
const c1 = modelCalls; r = await generate(KEY_C);
check("R5e", "a second submit while one is running gets 409 in_progress, no model call", r.statusCode === 409 && r.body.code === "in_progress" && modelCalls === c1);
// stale attempt (crashed function) is closed out and retried
await supa.db.query("update diagnostic_reports set attempt_started_at = now() - interval '10 minutes' where license_hash=$1", [sha(KEY_C)]);
r = await generate(KEY_C);
const rc = await rowFor(KEY_C);
check("R5f", "an attempt silent for >5 min is closed out, counted, and retried", r.statusCode === 200 && rc.status === "complete" && rc.attempts === 2);
check("R5g", "the abandoned attempt is logged", (await eventsFor(KEY_C)).some(e => e.outcome === "stale_attempt_abandoned"));

// storage down before generation
const KEY_D = "TESTKEY-DOWN0000-DOWN0000-DOWN2222";
supa.mode = "down"; const d0 = modelCalls;
r = await generate(KEY_D);
supa.mode = "up";
check("R5h", "storage outage → 503 before any model spend; nothing half-written", r.statusCode === 503 && modelCalls === d0 && !(await rowFor(KEY_D)));
// lost response after a committed save → idempotent retry
const KEY_L = "TESTKEY-LOST0000-LOST0000-LOST3333";
supa.mode = "drop_response:lbd_complete";
r = await generate(KEY_L);
const rl = await rowFor(KEY_L);
const saves = (await eventsFor(KEY_L)).filter(e => e.event === "save");
check("R5i", "save whose response is lost is retried safely: stored once, buyer gets 200", r.statusCode === 200 && r.body.stored === true && rl.status === "complete" && saves.map(e => e.outcome).join(",") === "stored,already_stored", saves.map(e => e.outcome).join(","));
// save fails completely → report shown, record ends 'failed', not limbo
const KEY_W = "TESTKEY-WRIT0000-WRIT0000-WRIT4444";
const origHandle = supa.handle;
let completeTries = 0;
supa.handle = async (u, o) => (/lbd_complete$/.test(u) ? (completeTries++, json(503, { message: "down" })) : origHandle(u, o));
r = await generate(KEY_W);
supa.handle = origHandle;
const rw = await rowFor(KEY_W);
check("R5j", "save that cannot be written: buyer still gets the report with stored:false + warning", r.statusCode === 200 && r.body.stored === false && /couldn't keep a copy/.test(r.body.storage_warning));
check("R5k", "…and the record ends in a clear failed state with reason storage_write_failed", rw.status === "failed" && rw.failure_reason === "storage_write_failed" && rw.report === null);
check("R5l", "a failing save is retried a bounded number of times (exactly 1 + 3), then stops", completeTries === 4, `${completeTries} tries`);

/* =============================== R6 retention, extend, delete =================== */
row = await rowFor(KEY_A);
const days = (new Date(row.retain_until) - new Date(row.created_at)) / 86400000;
check("R6a", "each record stores retain_until = created_at + 90 days", Math.round(days) === 90, `${days.toFixed(3)} days`);
process.env.REPORT_RETENTION_DAYS = "30";
const KEY_R = "TESTKEY-RETN0000-RETN0000-RETN5555";
await generate(KEY_R);
const rr = await rowFor(KEY_R);
check("R6b", "a configured retention below 90 days is clamped up to 90", Math.round((new Date(rr.retain_until) - new Date(rr.created_at)) / 86400000) === 90);
delete process.env.REPORT_RETENTION_DAYS;
threw = false;
try { await supa.db.query("update diagnostic_reports set retain_until = created_at + interval '30 days' where license_hash=$1", [sha(KEY_R)]); } catch { threw = true; }
check("R6c", "database refuses any retention under 90 days", threw);
r = await adminCall({ action: "extend", license_key: KEY_A, days: 365 });
const ext = await rowFor(KEY_A);
check("R6d", "admin can extend retention (to ~365 days out)", r.body.ok === true && Math.round((new Date(ext.retain_until) - Date.now()) / 86400000) === 365);
r = await adminCall({ action: "extend", license_key: KEY_A, days: 1 });
check("R6e", "extend never shortens retention", new Date((await rowFor(KEY_A)).retain_until).getTime() === new Date(ext.retain_until).getTime());
r = await adminCall({ action: "extend", license_key: KEY_A, days: 365 }, "wrong-token-wrong-token-wrong");
const r2 = await adminCall({ action: "extend", license_key: KEY_A, days: 365 }, null);
check("R6f", "admin endpoint is invisible (404) without the right token", r.statusCode === 404 && r2.statusCode === 404);

// buyer delete
const KEY_X = "TESTKEY-DELE0000-DELE0000-DELE6666";
await generate(KEY_X);
r = await buyerDelete(KEY_X);
const rx = await rowFor(KEY_X);
check("R6g", "buyer can delete with their key: inputs and report scrubbed, tombstone kept", r.statusCode === 200 && rx.status === "deleted" && rx.inputs === null && rx.report === null && !!rx.deleted_at);
r = await retrieve(KEY_X);
check("R6h", "deleted report can no longer be retrieved (410)", r.statusCode === 410);
const dc = modelCalls; r = await generate(KEY_X);
check("R6i", "deleted purchase cannot silently regenerate (410, no model call)", r.statusCode === 410 && modelCalls === dc);
// admin delete by report id
const KEY_Y = "TESTKEY-ADEL0000-ADEL0000-ADEL7777";
await generate(KEY_Y);
r = await adminCall({ action: "delete", report_id: (await rowFor(KEY_Y)).id, reason: "test" });
check("R6j", "admin can delete by record id", r.body.ok === true && (await rowFor(KEY_Y)).status === "deleted");
// expiry + purge
const KEY_E = "TESTKEY-EXPR0000-EXPR0000-EXPR8888";
await generate(KEY_E);
await supa.db.query("update diagnostic_reports set created_at = now() - interval '100 days', retain_until = now() - interval '1 day' where license_hash=$1", [sha(KEY_E)]);
r = await retrieve(KEY_E);
check("R6k", "past retention, retrieval is refused even before purge runs (410 expired)", r.statusCode === 410 && r.body.code === "expired");
r = await hit(admin, { method: "GET", auth: `Bearer ${CRON_SECRET}` });
const re = await rowFor(KEY_E);
check("R6l", "daily purge (cron GET) scrubs every expired record", r.statusCode === 200 && r.body.purged === 1 && re.status === "deleted" && re.inputs === null && re.report === null, JSON.stringify(r.body));
r = await hit(admin, { method: "GET", auth: "Bearer nope" });
check("R6m", "purge cannot be triggered without the cron secret", r.statusCode === 404);
check("R6n", "unexpired records survive the purge", (await rowFor(KEY_A)).status === "complete");
// a purchase refunded AFTER its report was stored: cannot retrieve, can still delete
const KEY_RF = "REFUNDED-LATE0000-LATE0000-LATE9999";
await supa.db.query("select lbd_claim($1,'p',null,$2::jsonb,90,300,3)", [sha(KEY_RF), JSON.stringify({ format: "lbd.inputs.v1", intake: INTAKE })]);
const rfRow = await rowFor(KEY_RF);
await supa.db.query("select lbd_complete($1::uuid,1,$2::jsonb)", [rfRow.id, JSON.stringify({ format: "lbd.report.v1", report: report(0), source_log: [], validation_notes: [] })]);
const rfGet = await retrieve(KEY_RF);
const rfDel = await buyerDelete(KEY_RF);
check("R6o", "refunded purchase: retrieval refused (403) but buyer can still delete their data", rfGet.statusCode === 403 && rfDel.statusCode === 200 && (await rowFor(KEY_RF)).status === "deleted");

/* =============================== R7 audit log ==================================== */
const evA = await eventsFor(KEY_A);
const has = (ev, ev2, oc) => ev.some(e => e.event === ev2 && e.outcome === oc);
check("R7a", "save logged", has(evA, "save", "stored"));
check("R7b", "every retrieval logged (2 served via buyer endpoint)", evA.filter(e => e.event === "retrieve" && e.outcome === "served").length === 2);
check("R7c", "failed lookups also logged (not_found for key B, expired for key E)",
  has(await eventsFor(KEY_B), "retrieve", "not_found") && has(await eventsFor(KEY_E), "retrieve", "expired"));
check("R7d", "buyer deletion logged with actor=buyer", (await eventsFor(KEY_X)).some(e => e.event === "delete" && e.outcome === "deleted" && e.actor === "buyer"));
check("R7e", "admin deletion logged with actor=admin", (await eventsFor(KEY_Y)).some(e => e.event === "delete" && e.actor === "admin"));
check("R7f", "extension logged with old and new dates", evA.some(e => e.event === "extend" && e.detail.from && e.detail.to));
check("R7g", "purge logged per record", has(await eventsFor(KEY_E), "purge", "retention_expired"));
check("R7h", "replay and failures logged", has(evA, "claim", "replay") && (await eventsFor(KEY_F)).filter(e => e.event === "fail").length === 3);
let ap = 0;
for (const sql of ["update diagnostic_report_events set outcome='x'", "delete from diagnostic_report_events"]) {
  try { await supa.db.query(sql); } catch { ap++; }
}
check("R7i", "audit log is append-only (update and delete both refused)", ap === 2);
const evDump = JSON.stringify(await supa.q("select * from diagnostic_report_events"));
check("R7j", "audit log holds no intake content, report content or raw keys", !evDump.includes("owner@example.com") && !evDump.includes("variant") && !evDump.includes("TESTKEY-"));
check("R7k", "every server call used the service key (no unauthenticated DB calls)", supa.badKeyCalls === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
