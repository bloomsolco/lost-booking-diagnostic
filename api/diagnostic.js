// api/diagnostic.js — Vercel serverless endpoint for the Bloom Sol Lost Booking Diagnostic
// BSC-009 Stage-0 repair. Responsibilities, in order:
//   1. Verify the Gumroad purchase server-side (non-consuming) before doing anything else.
//   2. Accept ONLY a bounded intake payload — the server owns model, system prompt,
//      messages, tools and token limits. The browser controls none of them.
//   3. Actually retrieve the supplied public URLs (with SSRF protection) and build a
//      server-truth source log. Sources that cannot be retrieved are UNAVAILABLE and
//      can never back an OBSERVED finding.
//   4. Call the Anthropic Messages API with a server-side key only.
//   5. Validate the report (structure, score arithmetic, source traceability, banned
//      outcome claims) before returning it.
// ANTHROPIC_API_KEY stays in Vercel env vars. It is never sent to, or readable by, the client.

import dns from "node:dns/promises";
import net from "node:net";

/* ============================== CONSTANTS ============================== */

const GUMROAD_PRODUCT_ID = "yyzm9n6iAxsrLx2LbmW0AA=="; // not a secret — public product identifier
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 8000;
const TEMPERATURE = 0.4;

const FETCH_TIMEOUT_MS = 12000;
const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 600 * 1024;   // per source, raw
const MAX_SOURCE_CHARS = 9000;       // per source, extracted text passed to the model
const MIN_USEFUL_CHARS = 180;        // below this, treat as dynamically unreadable

const SCORECARD_SPEC = [
  ["First Impression Clarity", 15],
  ["Service Clarity", 15],
  ["Booking Path", 20],
  ["Trust And Proof", 15],
  ["Google Profile Readiness", 15],
  ["CTA And Lead Capture", 15],
  ["Friction Reduction", 5],
];

const RATING_BANDS = [
  [85, "Strong"],
  [70, "Solid — leaks present"],
  [55, "Notable friction"],
  [0, "High leakage"],
];

// Fields the client may send inside `intake`, with max lengths. Anything else is dropped.
const INTAKE_FIELDS = {
  name: 120, email: 254, business: 160, location: 160, type: 80,
  website: 500, booking: 500, google: 500, social: 500,
  service: 200, ideal: 800, problem: 600, focus: 120,
};
const REQUIRED_INTAKE = ["name","email","business","location","type","website","booking","google","service","ideal","problem","focus"];

/* ============================== HANDLER ============================== */

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  const allowed = /^https:\/\/(diagnostic\.bloomsol\.co|bloomsol\.co|[a-z0-9-]+\.vercel\.app)$/.test(origin);
  res.setHeader("Access-Control-Allow-Origin", allowed ? origin : "https://diagnostic.bloomsol.co");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    /* ---- 1. Bounded payload: license_key + intake only. Everything else ignored. ---- */
    const body = req.body || {};
    const licenseKey = typeof body.license_key === "string" ? body.license_key.trim() : "";
    if (!licenseKey || licenseKey.length > 100) {
      return res.status(400).json({ error: "A license key from your Gumroad receipt is required." });
    }
    const intake = sanitizeIntake(body.intake);
    if (!intake.ok) return res.status(400).json({ error: intake.error });
    const d = intake.data;

    /* ---- 2. Server-side purchase verification (non-consuming) ---- */
    const lic = await verifyGumroadLicense(licenseKey);
    if (!lic.valid) return res.status(lic.status).json({ error: lic.error });

    /* ---- 3. Real public-source retrieval with server-truth source log ---- */
    const gbpViaPlaces = await tryPlacesGbp(d); // null unless PLACES_API_KEY set + confident name match
    const fetchList = [
      { label: "WEBSITE", url: d.website },
      { label: "BOOKING", url: d.booking },
      ...(gbpViaPlaces ? [] : [{ label: "GOOGLE_PROFILE", url: d.google }]),
      ...(d.social && d.social !== "Not provided" ? [{ label: "SOCIAL", url: d.social }] : []),
    ];
    const fetched = await retrieveSources(fetchList);
    const sourceLog = gbpViaPlaces ? [...fetched.slice(0, 2), gbpViaPlaces, ...fetched.slice(2)] : fetched;
    const fullLabels = sourceLog.filter(s => s.status === "RETRIEVED").map(s => s.label);
    const partialLabels = sourceLog.filter(s => s.status === "PARTIAL").map(s => s.label);
    const citableLabels = [...fullLabels, ...partialLabels];

    /* ---- 4. Server-owned Anthropic request ---- */
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE,
        system: buildSystemPrompt(fullLabels, partialLabels),
        messages: [{ role: "user", content: buildUserMessage(d, sourceLog) }],
      }),
    });
    const apiData = await anthropicRes.json();
    if (!anthropicRes.ok) {
      return res.status(502).json({ error: "The report engine is temporarily unavailable. Please try again in a moment." });
    }
    if (apiData.stop_reason === "max_tokens") {
      return res.status(502).json({ error: "The report came back incomplete. Please try again." });
    }

    /* ---- 5. Parse + validate before returning anything ---- */
    let report;
    try {
      report = parseModelJson(apiData);
    } catch (e) {
      return res.status(502).json({ error: "The report could not be read cleanly. Please try again." });
    }
    const v = validateAndRepairReport(report, citableLabels);
    if (!v.ok) return res.status(422).json({ error: v.error });

    return res.status(200).json({
      verified: true,
      report: v.report,
      source_log: sourceLog.map(({ label, url, status, reason }) => ({ label, url, status, reason })),
      validation_notes: v.notes,
    });
  } catch (err) {
    return res.status(500).json({ error: "Unexpected server error. Please try again." });
  }
}

/* ============================== INTAKE ============================== */

function sanitizeIntake(raw) {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Missing intake data." };
  const data = {};
  for (const [k, max] of Object.entries(INTAKE_FIELDS)) {
    const val = typeof raw[k] === "string" ? raw[k].trim().slice(0, max) : "";
    data[k] = val;
  }
  for (const k of REQUIRED_INTAKE) {
    if (!data[k]) return { ok: false, error: `Missing required field: ${k}.` };
  }
  if (!data.social) data.social = "Not provided";
  return { ok: true, data };
}

/* ============================== GUMROAD ============================== */

async function verifyGumroadLicense(licenseKey) {
  let r, j;
  try {
    r = await fetch("https://api.gumroad.com/v2/licenses/verify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        product_id: GUMROAD_PRODUCT_ID,
        license_key: licenseKey,
        increment_uses_count: "false", // non-consuming: internal QA must not burn uses
      }),
    });
    j = await r.json();
  } catch (e) {
    return { valid: false, status: 502, error: "Purchase verification is temporarily unavailable. Please try again in a moment." };
  }
  if (!j || j.success !== true || !j.purchase) {
    return { valid: false, status: 403, error: "That license key was not recognized for this product. Check your Gumroad receipt and try again." };
  }
  const p = j.purchase;
  if (p.refunded) return { valid: false, status: 403, error: "This purchase was refunded, so a report can no longer be generated with this key." };
  if (p.chargebacked) return { valid: false, status: 403, error: "This purchase is not in good standing, so a report cannot be generated with this key." };
  if (p.disputed && !p.dispute_won) return { valid: false, status: 403, error: "This purchase is under dispute, so a report cannot be generated right now." };
  return { valid: true };
}

/* ============================== SOURCE RETRIEVAL ============================== */

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254);
  }
  const low = ip.toLowerCase();
  return low === "::1" || low === "::" || low.startsWith("fc") || low.startsWith("fd") || low.startsWith("fe80") || low.startsWith("::ffff:127.") || low.startsWith("::ffff:10.") || low.startsWith("::ffff:192.168.");
}

async function assertPublicHttpUrl(rawUrl) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`); }
  catch { throw { code: "invalid_url", msg: "Not a valid URL" }; }
  if (!/^https?:$/.test(u.protocol)) throw { code: "invalid_url", msg: "Only http(s) links are supported" };
  if (net.isIP(u.hostname) && isPrivateAddress(u.hostname)) throw { code: "private_address", msg: "Address not publicly reachable" };
  if (!net.isIP(u.hostname)) {
    let addrs;
    try { addrs = await dns.lookup(u.hostname, { all: true }); }
    catch { throw { code: "dns_failure", msg: "Domain could not be resolved" }; }
    if (addrs.some(a => isPrivateAddress(a.address))) throw { code: "private_address", msg: "Address not publicly reachable" };
  }
  return u;
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/[ \t\r\f]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function looksLoginGated(text) {
  const t = text.slice(0, 2500).toLowerCase();
  return /(log ?in|sign ?in|sign ?up) to (see|view|continue|use|access)|(log ?in|sign ?in) to [a-z]{1,20} to (see|continue)|create an account to|enable javascript|javascript is (required|disabled)|checking your browser|verify you are human|access denied|you must be logged in|please (log ?in|sign ?in)/.test(t);
}

/* ---- Auth-path detection (BSC-009 B1) ----
   Body-text matching alone is not sufficient: platforms serve logged-out interstitials
   whose wording does not match any phrase list (Instagram's /accounts/login/ page is the
   observed case). If the FINAL url after redirects sits on a known auth path, the page is
   a login wall no matter what its body says, and must never be reported as "Reviewed".
   Checked against the path only — a business page such as /services/login-help is not
   caught, because the path must BE the auth route rather than merely contain the word. */
const AUTH_PATH_RE = /^\/(accounts\/(login|signup|emailsignup)|login|log-in|signin|sign-in|signup|sign-up|register|auth|session\/new|oauth\/authorize|u\/\d+\/login)\/?$/i;

function isAuthWallUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return false; }
  if (AUTH_PATH_RE.test(u.pathname)) return true;
  // Accounts-style hosts (accounts.google.com/...) are auth infrastructure by definition.
  if (/^accounts\./i.test(u.hostname)) return true;
  return false;
}

/* ---- Preview-metadata fallback (PARTIAL) ----
   Instagram and Google Maps serve JS-shell pages to plain fetches, but both publish
   Open Graph / meta tags so link previews work — that content is public by design
   (e.g. Instagram's og:description carries follower counts + the bio). When full page
   text is unreadable, we fall back to this metadata as a PARTIAL source. Guards:
   never accept metadata that is itself a login page or bare platform boilerplate,
   since a redirect to a login screen must stay UNAVAILABLE. */
function decodeEntities(s) {
  return (s || "").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"').trim();
}

function extractPreviewMetadata(html) {
  const grab = (re) => { const m = html.match(re); return m ? decodeEntities(m[1]) : ""; };
  const meta = (name) =>
    grab(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*?content=["']([^"']*)["']`, "i")) ||
    grab(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*?(?:property|name)=["']${name}["']`, "i"));
  const fields = {
    title: meta("og:title") || grab(/<title[^>]*>([\s\S]*?)<\/title>/i),
    description: meta("og:description") || meta("description") || meta("twitter:description"),
    site: meta("og:site_name"),
  };
  const combined = [fields.title, fields.description].filter(Boolean).join(" ");
  if (combined.length < 40) return null; // too thin to ground anything
  // Reject login screens and bare platform boilerplate — that is not the business's page.
  const low = combined.toLowerCase();
  if (/\b(log ?in|sign ?in|sign ?up)\b/.test(low)) return null;
  const bare = (fields.title || "").trim().toLowerCase();
  if (["instagram", "google maps", "facebook", "google"].includes(bare) && !fields.description) return null;
  const lines = [];
  if (fields.title) lines.push(`Preview title: ${fields.title}`);
  if (fields.site) lines.push(`Platform: ${fields.site}`);
  if (fields.description) lines.push(`Preview description: ${fields.description}`);
  return lines.join("\n");
}

async function fetchOneSource(label, rawUrl) {
  const entry = { label, url: rawUrl, status: "UNAVAILABLE", reason: "", text: "" };
  let u;
  try { u = await assertPublicHttpUrl(rawUrl); }
  catch (e) { entry.reason = e.msg || "Invalid URL"; return entry; }

  let currentUrl = u.href;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(currentUrl, {
        redirect: "manual",
        signal: ctrl.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; BloomSolDiagnostic/1.0; +https://bloomsol.co)",
          "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        },
      });
    } catch (e) {
      clearTimeout(timer);
      entry.reason = e.name === "AbortError" ? "Timed out" : "Could not be reached";
      return entry;
    }
    clearTimeout(timer);

    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get("location");
      if (!loc || hop === MAX_REDIRECTS) { entry.reason = "Too many redirects"; return entry; }
      let next;
      try { next = new URL(loc, currentUrl); await assertPublicHttpUrl(next.href); }
      catch { entry.reason = "Redirected to an unreachable address"; return entry; }
      currentUrl = next.href;
      continue;
    }
    if (resp.status === 401 || resp.status === 403) { entry.reason = `Blocked or login-gated (HTTP ${resp.status})`; return entry; }
    if (!resp.ok) { entry.reason = `HTTP ${resp.status}`; return entry; }

    const ctype = (resp.headers.get("content-type") || "").toLowerCase();
    if (ctype && !/text\/|application\/xhtml|application\/xml/.test(ctype)) {
      entry.reason = "Not a readable page"; return entry;
    }
    let raw;
    try {
      const buf = await resp.arrayBuffer();
      raw = new TextDecoder("utf-8", { fatal: false }).decode(buf.slice(0, MAX_BODY_BYTES));
    } catch { entry.reason = "Content could not be read"; return entry; }

    const text = htmlToText(raw);
    // A login wall is never a reviewable source, and its own metadata describes the login
    // screen rather than the business — so it cannot become PARTIAL either.
    if (isAuthWallUrl(currentUrl)) {
      entry.url = currentUrl;
      entry.reason = "Link leads to a login page; no public content was visible";
      return entry;
    }
    if (text.length < MIN_USEFUL_CHARS || looksLoginGated(text)) {
      const preview = extractPreviewMetadata(raw);
      if (preview) {
        entry.status = "PARTIAL";
        entry.reason = "Public preview metadata only (full page requires login or scripts)";
        entry.url = currentUrl;
        entry.text = preview.slice(0, MAX_SOURCE_CHARS);
        return entry;
      }
      entry.reason = "Page requires login or scripts to display content"; return entry;
    }
    entry.status = "RETRIEVED";
    entry.reason = "";
    entry.url = currentUrl;
    entry.text = text.slice(0, MAX_SOURCE_CHARS);
    return entry;
  }
  entry.reason = "Too many redirects";
  return entry;
}

async function retrieveSources(list) {
  return Promise.all(list.map(s => fetchOneSource(s.label, s.url)));
}

/* ---- Optional Google Places retriever for the GBP source ----
   Enabled only when PLACES_API_KEY is set in Vercel env vars (founder-provisioned,
   quota-capped). One Text Search call resolves the business by name + location and
   returns live profile data (rating, review count, hours, website, photos) — turning
   GOOGLE_PROFILE into a fully OBSERVED source. Guards: the returned business name
   must confidently match the intake business name, otherwise we discard the result
   and fall back to the normal fetch path (PARTIAL/UNAVAILABLE). Any API error also
   falls back. Absence of the key = exactly the pre-existing behavior. */
function namesMatch(a, b) {
  const tok = s => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(w => w.length > 1);
  const A = tok(a), B = tok(b);
  if (!A.length || !B.length) return false;
  const setB = new Set(B);
  const overlap = A.filter(w => setB.has(w)).length;
  const ja = A.join(" "), jb = B.join(" ");
  return ja.includes(jb) || jb.includes(ja) || overlap >= Math.min(2, A.length, B.length);
}

async function tryPlacesGbp(d) {
  const key = process.env.PLACES_API_KEY;
  if (!key) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  let data;
  try {
    const resp = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.businessStatus,places.rating,places.userRatingCount,places.websiteUri,places.nationalPhoneNumber,places.regularOpeningHours.weekdayDescriptions,places.photos.name",
      },
      body: JSON.stringify({ textQuery: `${d.business} ${d.location}`, pageSize: 1 }),
    });
    if (!resp.ok) return null;
    data = await resp.json();
  } catch { return null; }
  finally { clearTimeout(timer); }

  const p = data && Array.isArray(data.places) ? data.places[0] : null;
  if (!p) return null;
  const foundName = p.displayName && p.displayName.text ? p.displayName.text : "";
  if (!namesMatch(foundName, d.business)) return null; // wrong business — never report a stranger's profile

  const lines = [
    "GOOGLE BUSINESS PROFILE — live data via Google Places API:",
    `Business: ${foundName}`,
    p.businessStatus ? `Status: ${p.businessStatus}` : "",
    p.formattedAddress ? `Address: ${p.formattedAddress}` : "",
    (typeof p.rating === "number") ? `Rating: ${p.rating} (${p.userRatingCount || 0} reviews)` : "Rating: none shown on profile",
    p.websiteUri ? `Website listed: ${p.websiteUri}` : "Website listed: NO WEBSITE LINK ON PROFILE",
    p.nationalPhoneNumber ? `Phone listed: ${p.nationalPhoneNumber}` : "Phone listed: none",
    (p.regularOpeningHours && Array.isArray(p.regularOpeningHours.weekdayDescriptions) && p.regularOpeningHours.weekdayDescriptions.length)
      ? `Hours listed: yes — ${p.regularOpeningHours.weekdayDescriptions.join("; ")}`
      : "Hours listed: NO HOURS ON PROFILE",
    Array.isArray(p.photos) ? `Photos on profile: ${p.photos.length}` : "Photos on profile: none",
  ].filter(Boolean);

  return { label: "GOOGLE_PROFILE", url: d.google, status: "RETRIEVED", reason: "", text: lines.join("\n").slice(0, MAX_SOURCE_CHARS) };
}

/* ============================== PROMPTS ============================== */

function buildSystemPrompt(fullLabels, partialLabels) {
  const citable = [...fullLabels, ...partialLabels];
  const hasSources = citable.length > 0;
  return `You are Bloom Sol, a strategic digital growth and visibility diagnostic company for med spas, aesthetic clinics, and premium appointment-based local businesses. You are generating The Bloom Sol Lost Booking Diagnostic, reviewing the business from the perspective of a normal prospective client deciding whether to trust, contact, or book.

This is NOT a full marketing strategy, SEO audit, website redesign, legal/medical/compliance review, analytics or ad audit, or revenue forecast. Never guarantee bookings, revenue, rankings, or outcomes. Never invent revenue figures, booking counts, ranking positions, ROI numbers, or performance results. Voice: clear, grounded, commercially sharp, calm, elegant, practical, anti-jargon. Every recommendation ties to booking friction, trust, clarity, confidence, next-step action, local discoverability, or conversion readiness.

EVIDENCE RULES — these are strict:
- The user message contains source content for these sources only: FULL PAGE TEXT for [${fullLabels.join(", ") || "—"}]; PUBLIC PREVIEW METADATA ONLY for [${partialLabels.join(", ") || "—"}]. Sources marked UNAVAILABLE could not be read; you know nothing about their content.
- A finding may be labeled basis "OBSERVED" ONLY when it describes something actually present in the provided source content, and it must list which of [${citable.join(", ") || "—"}] it came from.
- For PREVIEW-METADATA sources, an OBSERVED finding may describe only what the preview itself shows (e.g. the bio text, follower count, or the absence of a booking link in the bio) — never anything about the page beyond the preview.
- Anything grounded only in the owner's intake answers must be labeled basis "INTAKE-REPORTED" with sources [].
- Never present an assumption or an unavailable source as an observation. Never describe the content of an UNAVAILABLE source.${hasSources ? "" : "\n- Since NO sources were readable, every leak must use basis \"INTAKE-REPORTED\" and the interpretation must state the review is based on the owner's answers only."}

Scoring rubric (total 100): First Impression Clarity 15, Service Clarity 15, Booking Path 20, Trust And Proof 15, Google Profile Readiness 15, CTA And Lead Capture 15, Friction Reduction 5. Rating bands: 85-100 "Strong", 70-84 "Solid — leaks present", 55-69 "Notable friction", below 55 "High leakage". The score must equal the sum of the 7 scorecard numerators.

Return ONLY valid minified JSON (no markdown, no code fences, no preamble) matching exactly:
{"score":<int>,"rating":"<band label>","interpretation":"<2-3 sentences>","topLeaks":["","",""],"fixFirst":"","scorecard":[{"category":"First Impression Clarity","score":"<n>/15","working":"","leaking":""},{"category":"Service Clarity","score":"<n>/15","working":"","leaking":""},{"category":"Booking Path","score":"<n>/20","working":"","leaking":""},{"category":"Trust And Proof","score":"<n>/15","working":"","leaking":""},{"category":"Google Profile Readiness","score":"<n>/15","working":"","leaking":""},{"category":"CTA And Lead Capture","score":"<n>/15","working":"","leaking":""},{"category":"Friction Reduction","score":"<n>/5","working":"","leaking":""}],"leaks":[{"name":"","basis":"OBSERVED|INTAKE-REPORTED","sources":["WEBSITE"],"observed":"","hesitation":"","fix":"","impact":"High|Medium|Low","ease":"Easy|Moderate|Hard"},{...},{...}],"quickWins":["","","","",""],"plan":["Day 1 ...","Day 2 ...","Day 3 ...","Day 4 ...","Day 5 ...","Day 6 ...","Day 7 ..."]}
Provide exactly 3 leaks, 5 quick wins, 7 plan days.

STRICT LENGTH LIMITS: interpretation max 45 words. Each scorecard working/leaking max 10 words. Each leak observed/hesitation/fix max 30 words. Each quick win max 22 words. Each plan day max 18 words. fixFirst max 40 words.`;
}

function buildUserMessage(d, sourceLog) {
  const intakeBlock = `INTAKE (owner-reported — supports INTAKE-REPORTED findings only):
Business name: ${d.business}
Business location: ${d.location}
Business type: ${d.type}
Priority service: ${d.service}
Ideal client: ${d.ideal}
Current booking problem: ${d.problem}
Area to pay closest attention to: ${d.focus}`;

  const sourceBlocks = sourceLog.map(s => {
    if (s.status === "RETRIEVED") {
      return `=== SOURCE ${s.label} — RETRIEVED (${s.url}) ===\n${s.text}\n=== END ${s.label} ===`;
    }
    if (s.status === "PARTIAL") {
      return `=== SOURCE ${s.label} — PREVIEW METADATA ONLY (${s.url}) — full page not readable; observe only what this preview shows ===\n${s.text}\n=== END ${s.label} ===`;
    }
    return `=== SOURCE ${s.label} — UNAVAILABLE (${s.url}) — reason: ${s.reason}. Content unknown; must not be described or cited. ===`;
  }).join("\n\n");

  return `${intakeBlock}\n\nRETRIEVED SOURCE CONTENT:\n\n${sourceBlocks}`;
}

/* ============================== VALIDATION ============================== */

function parseModelJson(apiData) {
  let txt = (apiData.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  txt = txt.replace(/```json/gi, "").replace(/```/g, "").trim();
  const first = txt.indexOf("{"), last = txt.lastIndexOf("}");
  if (first === -1 || last === -1) throw new Error("no json");
  return JSON.parse(txt.slice(first, last + 1));
}

const BANNED_CLAIM_PATTERNS = [
  /\bguarantee[ds]?\b/i,
  /\$\s?\d[\d,.]*\s*(k\b)?\s*(in|of|more|extra|additional|lost|per)\s*(revenue|bookings?|sales|month|year)/i,
  /\b\d{1,3}\s?%\s*(more|increase|boost|lift|growth)\b/i,
  /\brank(ing|ed)?\s*(#\s?1|number one|first)\b/i,
  /\b(double|triple)\s+(your\s+)?(revenue|bookings?|sales)\b/i,
];

function validateAndRepairReport(r, citableLabels) {
  const notes = [];
  if (!r || typeof r !== "object") return { ok: false, error: "Report was empty." };

  // Structural counts (hard requirements)
  if (!Array.isArray(r.leaks) || r.leaks.length !== 3) return { ok: false, error: "Report failed validation: expected exactly 3 leaks." };
  if (!Array.isArray(r.quickWins) || r.quickWins.length !== 5) return { ok: false, error: "Report failed validation: expected exactly 5 quick wins." };
  if (!Array.isArray(r.plan) || r.plan.length !== 7) return { ok: false, error: "Report failed validation: expected exactly 7 action-plan days." };
  if (!Array.isArray(r.topLeaks) || r.topLeaks.length !== 3) return { ok: false, error: "Report failed validation: expected exactly 3 top leaks." };
  if (!Array.isArray(r.scorecard) || r.scorecard.length !== SCORECARD_SPEC.length) return { ok: false, error: "Report failed validation: scorecard incomplete." };

  // Scorecard arithmetic — score must equal the sum of numerators; rating must match band.
  let sum = 0;
  for (let i = 0; i < SCORECARD_SPEC.length; i++) {
    const [name, denom] = SCORECARD_SPEC[i];
    const sc = r.scorecard[i] || {};
    const m = String(sc.score || "").match(/^(\d{1,3})\s*\/\s*(\d{1,3})$/);
    if (!m || Number(m[2]) !== denom || sc.category !== name) {
      return { ok: false, error: `Report failed validation: scorecard row ${i + 1} malformed.` };
    }
    const n = Number(m[1]);
    if (n < 0 || n > denom) return { ok: false, error: `Report failed validation: score out of range for ${name}.` };
    sum += n;
  }
  if (r.score !== sum) {
    notes.push(`Score corrected from ${r.score} to scorecard sum ${sum}.`);
    r.score = sum;
  }
  const band = RATING_BANDS.find(([min]) => r.score >= min)[1];
  if (r.rating !== band) {
    notes.push(`Rating aligned to band "${band}" for score ${r.score}.`);
    r.rating = band;
  }

  // Source traceability — OBSERVED requires ≥1 successfully retrieved source.
  const retrieved = new Set(citableLabels);
  for (const leak of r.leaks) {
    const cited = Array.isArray(leak.sources) ? leak.sources.filter(s => retrieved.has(s)) : [];
    if (leak.basis === "OBSERVED" && cited.length === 0) {
      leak.basis = "INTAKE-REPORTED";
      leak.sources = [];
      notes.push(`A finding labeled OBSERVED cited no retrieved source and was downgraded to INTAKE-REPORTED ("${String(leak.name).slice(0, 60)}").`);
    } else {
      leak.sources = cited;
      if (leak.basis !== "OBSERVED") { leak.basis = "INTAKE-REPORTED"; leak.sources = []; }
    }
  }
  if (retrieved.size === 0 && r.leaks.some(l => l.basis === "OBSERVED")) {
    return { ok: false, error: "Report failed validation: observation claims with no readable sources." };
  }

  // Banned outcome claims — no invented revenue/booking/ranking/ROI results.
  const textPool = JSON.stringify([r.interpretation, r.topLeaks, r.fixFirst, r.leaks, r.quickWins, r.plan]);
  for (const pat of BANNED_CLAIM_PATTERNS) {
    const hit = textPool.match(pat);
    if (hit) return { ok: false, error: `Report failed validation: contains a prohibited outcome claim ("${hit[0]}").` };
  }

  return { ok: true, report: r, notes };
}
