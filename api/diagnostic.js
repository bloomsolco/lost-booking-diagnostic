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

/* Platforms that redirect datacenter traffic to a login wall no matter how clean the
   profile URL is (confirmed live for Instagram: the canonical profile 302s straight back
   to /accounts/login/). Fetching them burns a request to produce an UNAVAILABLE row that
   reads like a product defect. We skip the fetch, say plainly why, and recover the signal
   that actually matters — whether the site links to social at all — from the site HTML. */
const UNREADABLE_SOCIAL_HOST_RE = /(^|\.)(instagram\.com|facebook\.com|tiktok\.com)$/i;

function isUnreadableSocialHost(rawUrl) {
  try { return UNREADABLE_SOCIAL_HOST_RE.test(new URL(rawUrl).hostname); }
  catch { return false; }
}

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
    const social = normalizeSocialUrl(d.social);
    const googleIsSearch = isGoogleSearchNotProfile(d.google);

    const fetchList = [
      { label: "WEBSITE", url: d.website },
      { label: "BOOKING", url: d.booking },
      ...(gbpViaPlaces || googleIsSearch ? [] : [{ label: "GOOGLE_PROFILE", url: d.google }]),
      ...(social.url && !isUnreadableSocialHost(social.url) ? [{ label: "SOCIAL", url: social.url }] : []),
    ];
    const fetched = await retrieveSources(fetchList);

    /* Social platforms that block automated review get an explicit, non-defect-sounding
       row rather than a fetch failure. Findings about social must come from intake. */
    const socialSkipped = social.url && isUnreadableSocialHost(social.url)
      ? [{
          label: "SOCIAL", url: social.url, status: "UNAVAILABLE", text: "",
          reason: "This platform blocks automated review, so the profile was not opened. Social findings come from your intake answers.",
        }]
      : [];

    /* A Maps search URL never had profile content to read. Say that, rather than
       reporting a generic Maps blurb as though the profile were reviewed. */
    const gbpEntry = gbpViaPlaces || (googleIsSearch ? {
      label: "GOOGLE_PROFILE", url: d.google, status: "UNAVAILABLE",
      reason: "Link is a Google Maps search, not a business profile page", text: "",
    } : null);
    const withGbp = gbpEntry ? [...fetched.slice(0, 2), gbpEntry, ...fetched.slice(2)] : fetched;
    const base = [...withGbp, ...socialSkipped];

    /* Deep-page discovery (BSC-010): the homepage rarely contains the service and pricing
       language a buyer is actually evaluated on. Follow up to two same-domain pages that
       look like service/pricing/about pages so findings can cite what the clinic really
       says, not merely that a page appears to be missing. */
    const deep = await retrieveDeepPages(base, d);

    /* Fold the site's outbound-social observation into the WEBSITE source text. */
    const siteEntry = base.find(s => s.label === "WEBSITE" && s.status === "RETRIEVED" && s.raw);
    if (siteEntry) {
      siteEntry.text = `${describeSiteSocialLinks(siteEntry.raw)}\n\n${siteEntry.text}`.slice(0, MAX_SOURCE_CHARS);
    }

    const sourceLog = [...base, ...deep];

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
    const v = validateAndRepairReport(report, citableLabels, sourceLog);
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

/* ---- URL normalization (BSC-010) ----
   Owners paste whatever their browser gave them. Two observed failure modes:
   (a) Instagram logged-out copy yields .../accounts/login/?next=%2Fhandle%2F — the handle
       is present but the URL is a login wall, so retrieval dies on a link that contains
       exactly what we need;
   (b) Google yields a Maps *search* URL rather than a place page, which has no profile
       content to read.
   Normalizing first turns both into something retrievable (or correctly identifies (b)
   as not-a-profile so the Places path is used instead of pretending we read something). */

function normalizeSocialUrl(raw) {
  const s = String(raw || "").trim();
  if (!s || s === "Not provided") return { url: "", handle: "" };

  // Bare handle: "@clinic" or "clinic"
  if (/^@?[A-Za-z0-9._]{1,30}$/.test(s) && !s.includes(".com")) {
    const h = s.replace(/^@/, "");
    return { url: `https://www.instagram.com/${h}/`, handle: h };
  }

  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); }
  catch { return { url: s, handle: "" }; }

  const RESERVED = /^(accounts|explore|reels|p|direct|login|signup|privacy|terms)$/i;

  /* Login wall: the profile the owner meant is hiding in ?next=. This is host-generic
     on purpose — the same pattern shows up across platforms, and the redirect target
     is the only part that identifies the business. */
  const next = u.searchParams.get("next");
  if (next) {
    let path = next;
    try { path = decodeURIComponent(next); } catch {}
    let host = u.hostname;
    try {
      if (/^https?:\/\//i.test(path)) { const nu = new URL(path); host = nu.hostname; path = nu.pathname; }
    } catch {}
    const h = (path.match(/^\/?([A-Za-z0-9._]{1,30})\/?/) || [])[1];
    if (h && !RESERVED.test(h)) return { url: `https://${host}/${h}/`, handle: h };
  }

  // Already a clean profile path
  const h = (u.pathname.match(/^\/([A-Za-z0-9._]{1,30})\/?$/) || [])[1];
  if (h && !RESERVED.test(h)) return { url: `https://${u.hostname}/${h}/`, handle: h };

  return { url: u.href, handle: "" };
}

/* A Google Maps *search* URL is a query, not a business profile. Flagging it lets the
   source log say so plainly instead of reporting a generic Maps blurb as a review. */
function isGoogleSearchNotProfile(raw) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); }
  catch { return false; }
  if (!/google\./i.test(u.hostname)) return false;
  return /\/maps\/search\//i.test(u.pathname) || /\/search/i.test(u.pathname);
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

/* B9: derive a page name a clinic owner would recognise. <title> first, falling back to
   the final path segment title-cased. Trailing site-name suffixes ("| Clinic Name") are
   trimmed so the name stays short enough to sit inside a 30-word finding. */
function pageTitle(html, url) {
  let t = "";
  const m = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (m) t = decodeEntities(m[1]).replace(/\s+/g, " ").split(/\s[|\u2013\u2014-]\s/)[0].trim();
  if (!t || t.length > 70) {
    try {
      const seg = new URL(url).pathname.split("/").filter(Boolean).pop() || "";
      t = seg.replace(/\.\w+$/, "").replace(/[-_]+/g, " ").trim();
      t = t ? t.replace(/\b\w/g, c => c.toUpperCase()) : "";
    } catch { t = ""; }
  }
  return t.slice(0, 70);
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
    /* B9: a readable page name so findings can say "the Botox page" instead of leaking
       our internal source label into customer-facing copy. */
    entry.title = pageTitle(raw, currentUrl);
    entry.raw = raw; // kept in-process only for deep-page link discovery; never returned
    entry.text = text.slice(0, MAX_SOURCE_CHARS);
    return entry;
  }
  entry.reason = "Too many redirects";
  return entry;
}

async function retrieveSources(list) {
  return Promise.all(list.map(s => fetchOneSource(s.label, s.url)));
}

/* ---- Deep-page discovery (BSC-010) ----
   A homepage tells you almost nothing about whether the priority service is sellable.
   The pages that decide a booking — the service page, the pricing page — are one click
   down. We follow at most two, same-domain only, ranked by how well the link text and
   href match the owner's stated priority service and commercial intent words. Same SSRF
   guards and caps as any other source; failures are silent and non-fatal. */
const MAX_DEEP_PAGES = 2;

function extractSameDomainLinks(html, baseUrl) {
  let base;
  try { base = new URL(baseUrl); } catch { return []; }
  const out = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 300) {
    let href = m[1];
    if (/^(#|mailto:|tel:|javascript:)/i.test(href)) continue;
    let u;
    try { u = new URL(href, base); } catch { continue; }
    if (u.hostname !== base.hostname) continue;
    if (!/^https?:$/.test(u.protocol)) continue;
    if (/\.(pdf|jpg|jpeg|png|gif|webp|svg|mp4|zip|doc|docx)$/i.test(u.pathname)) continue;
    u.hash = "";
    const anchor = htmlToText(m[2]).slice(0, 120);
    out.push({ url: u.href, anchor, path: u.pathname.toLowerCase() });
  }
  return out;
}

function scoreDeepLink(link, d, baseUrl) {
  const svcWords = String(d.service || "").toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3);
  const hay = `${link.path} ${link.anchor.toLowerCase()}`;
  let score = 0;
  for (const w of svcWords) if (hay.includes(w)) score += 6;          // the money service
  if (/\bprice|pricing|cost|fees|rates|specials|membership|financing/.test(hay)) score += 5;
  if (/\bservice|treatment|procedure|menu\b/.test(hay)) score += 3;
  if (/\bconsult/.test(hay)) score += 3;
  if (/\babout|team|provider|staff|doctor|injector/.test(hay)) score += 2;
  if (/\bfaq|result|before|gallery|review|testimonial/.test(hay)) score += 2;
  if (/\bblog|news|career|privacy|terms|accessibility|contact|login|cart|account/.test(hay)) score -= 6;
  try { if (new URL(link.url).href.replace(/\/$/, "") === new URL(baseUrl).href.replace(/\/$/, "")) score -= 20; }
  catch {}
  const depth = link.path.split("/").filter(Boolean).length;
  if (depth > 3) score -= 2;
  return score;
}

/* ---- Site social-link detection (BSC-010 B4) ----
   We cannot read the social profile itself, but we CAN observe whether the site points to
   it at all. "Your homepage never links to your Instagram" is a real, checkable leak for a
   business whose discovery happens on social — and it costs nothing, since the homepage
   HTML is already in hand. Appended to the WEBSITE source so it stays properly OBSERVED. */
const SOCIAL_LINK_PATTERNS = [
  ["Instagram", /instagram\.com\/[A-Za-z0-9._]/i],
  ["Facebook", /facebook\.com\/[A-Za-z0-9._]/i],
  ["TikTok", /tiktok\.com\/@?[A-Za-z0-9._]/i],
  ["YouTube", /youtube\.com\/(@|channel\/|c\/)/i],
];

function describeSiteSocialLinks(html) {
  const found = SOCIAL_LINK_PATTERNS.filter(([, re]) => re.test(html)).map(([n]) => n);
  return found.length
    ? `SITE SOCIAL LINKS: the site links out to ${found.join(", ")}.`
    : "SITE SOCIAL LINKS: no link to any social profile was found anywhere in the homepage HTML.";
}

async function retrieveDeepPages(base, d) {
  const site = base.find(s => s.label === "WEBSITE" && s.status === "RETRIEVED" && s.raw);
  if (!site) return [];
  const already = new Set(base.filter(s => s.url).map(s => String(s.url).replace(/\/$/, "")));

  const seen = new Set();
  const candidates = [];
  for (const link of extractSameDomainLinks(site.raw, site.url)) {
    const key = link.url.replace(/\/$/, "");
    if (seen.has(key) || already.has(key)) continue;
    seen.add(key);
    candidates.push({ ...link, score: scoreDeepLink(link, d, site.url) });
  }
  const picks = candidates.filter(c => c.score > 3).sort((a, b) => b.score - a.score).slice(0, MAX_DEEP_PAGES);
  if (!picks.length) return [];

  const results = await Promise.all(
    picks.map((p, i) => fetchOneSource(`SITE_PAGE_${i + 1}`, p.url).catch(() => null))
  );
  // Only surface pages we actually read; a failed guess is noise, not evidence.
  return results.filter(r => r && r.status === "RETRIEVED").map(r => { delete r.raw; return r; });
}

/* ---- Optional Google Places retriever for the GBP source ----
   Enabled only when PLACES_API_KEY is set in Vercel env vars (founder-provisioned,
   quota-capped). One Text Search call resolves the business by name + location and
   returns live profile data (rating, review count, hours, website) — turning
   GOOGLE_PROFILE into a fully OBSERVED source. Guards: the returned business name
   must confidently match the intake business name, otherwise we discard the result
   and fall back to the normal fetch path (PARTIAL/UNAVAILABLE). Any API error also
   falls back. Absence of the key = exactly the pre-existing behavior. */
/* ---- B5 (Places audit): location guard ----
   namesMatch alone is not sufficient. A multi-location brand ("Queen Aesthetics") returns
   a perfect name match for a DIFFERENT suite, and we would then report another location's
   rating, review count, hours and address as this owner's profile. That is worse than
   returning nothing. We therefore also require the resolved address to contain the city
   the owner gave. Deliberately biased toward false negatives: a nearby-suburb address
   ("Bellaire" for a Houston intake) is discarded and falls back to UNAVAILABLE, which
   costs us a source but never attributes a stranger's data to the customer. */
function locationMatches(address, intakeLocation) {
  const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const addr = norm(address);
  const city = norm(String(intakeLocation || "").split(",")[0]);
  if (!addr || !city) return false;
  return addr.includes(city);
}

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
        "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.businessStatus,places.rating,places.userRatingCount,places.websiteUri,places.nationalPhoneNumber,places.regularOpeningHours.weekdayDescriptions",
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
  // B5: same brand, different location is still the wrong profile for this owner.
  if (!locationMatches(p.formattedAddress, d.location)) return null;

  const lines = [
    "GOOGLE BUSINESS PROFILE — live data via Google Places API:",
    `Business: ${foundName}`,
    p.businessStatus ? `Status: ${p.businessStatus}` : "",
    p.formattedAddress ? `Address: ${p.formattedAddress}` : "",
    (typeof p.rating === "number") ? `Rating: ${p.rating} (${p.userRatingCount || 0} reviews)` : "Rating: none shown on profile",
    /* B6: a field absent from the API response does not reliably mean the business
       omitted it. The previous all-caps framing pushed the model toward a leak — the
       same mechanism that produced B3. Absent means unknown, not deficient. */
    p.websiteUri ? `Website listed: ${p.websiteUri}` : "Website listed: not returned by the data source — treat as unknown, not as a missing link.",
    p.nationalPhoneNumber ? `Phone listed: ${p.nationalPhoneNumber}` : "Phone listed: none",
    (p.regularOpeningHours && Array.isArray(p.regularOpeningHours.weekdayDescriptions) && p.regularOpeningHours.weekdayDescriptions.length)
      ? `Hours listed: yes (listed on the profile — we cannot verify they are correct) — ${p.regularOpeningHours.weekdayDescriptions.join("; ")}`
      : "Hours listed: not returned by the data source — treat as unknown, not as missing hours.",
    /* B7 (CP0 live, second occurrence): the photo line is GONE, and the field is no
       longer even requested. Places returns a limited set of place photos; that count is
       not the profile's photo total and excludes customer-uploaded images, which is most
       of what a searcher actually sees. B3 tried to fix this with a ceiling rule, but a
       value BELOW the ceiling is equally unreliable — proven when a clinic with 303
       reviews was reported as having "only 9 photos". We cannot distinguish "few photos"
       from "few photos exposed by the API" at ANY value, so the field cannot support a
       finding and must never reach the model. Do not reintroduce without a source that
       reports a true profile photo total. */
  ].filter(Boolean);

  return { label: "GOOGLE_PROFILE", url: d.google, status: "RETRIEVED", reason: "", text: lines.join("\n").slice(0, MAX_SOURCE_CHARS) };
}

/* ============================== PROMPTS ============================== */

function buildSystemPrompt(fullLabels, partialLabels) {
  const citable = [...fullLabels, ...partialLabels];
  const hasSources = citable.length > 0;
  return `You are Bloom Sol, a strategic digital growth and visibility diagnostic company for med spas, aesthetic clinics, and premium appointment-based local businesses. You are generating The Bloom Sol Lost Booking Diagnostic, reviewing the business from the perspective of a normal prospective client deciding whether to trust, contact, or book.

You are not a generalist. You are an operator who has diagnosed hundreds of aesthetics and elective-care businesses, and you write like someone who already knows how this industry converts. Bring that judgment to every finding:

- ELECTIVE CASH-PAY BEHAVES DIFFERENTLY. These are discretionary, self-funded, appearance-related purchases. Price silence does not create intrigue; it creates exit. A visitor who cannot form a price expectation assumes "more than I want to spend" and leaves without contacting anyone. "Starting at" anchoring, ranges, and financing mentions convert better than "call for pricing".
- THE FIRST BOOKING IS USUALLY A DECISION, NOT A TRANSACTION. High-consideration treatments convert through a consultation path; low-consideration or repeat services convert through direct booking. A clinic that funnels everything into one generic "Book Now" loses both: the nervous first-timer wants reassurance, the returning client wants speed.
- TRUST IN AESTHETICS IS PERSON-SHAPED. Buyers choose an injector or provider, not a building. Named providers, credentials, faces, and their actual work outrank brand polish. A beautiful site with no visible human is a common and expensive gap.
- PROOF MEANS OUTCOMES. Before/after imagery, specific results, and recent reviews do the persuading. Stock photography of unrelated models actively erodes trust with this audience.
- A LONG TREATMENT MENU IS A DECISION BURDEN. Twenty services with no guided entry point produces stalling, not choice. "Not sure where to start" is a conversion problem with a known fix: a guided path, quiz, or named first-visit consultation.
- OFF-SITE BOOKING TOOLS LEAK. Redirects to a third-party scheduler abandon the trust the site just built and offer no re-entry for a visitor who is not ready yet.
- LOCAL DISCOVERY IS PART OF THE FUNNEL. For appointment-based local businesses the Google profile is often the real homepage. Review recency and volume, hours, and a working booking link carry disproportionate weight. (Photo volume is NOT observable through our sources — never comment on it.)
- REPEAT ECONOMICS MATTER. Many of these services recur. A path that captures one appointment and no way to return leaves most of a client's value uncollected.

Write findings that could only have been written about THIS business. Name what you actually saw: the specific service, the specific page, the specific wording. A finding that would read identically for any clinic is a weak finding — replace it with a sharper one grounded in the retrieved content. Prefer the diagnosis a seasoned operator would reach over the obvious observation anyone could make.

This is NOT a full marketing strategy, SEO audit, website redesign, legal/medical/compliance review, analytics or ad audit, or revenue forecast. Never guarantee bookings, revenue, rankings, or outcomes. Never invent revenue figures, booking counts, ranking positions, ROI numbers, or performance results. Never state a price, rating, review count, or statistic that does not appear in the retrieved source content. Voice: clear, grounded, commercially sharp, calm, elegant, practical, anti-jargon. Every recommendation ties to booking friction, trust, clarity, confidence, next-step action, local discoverability, or conversion readiness.

EXPERTISE NEVER OVERRIDES EVIDENCE. The industry knowledge above tells you what to look for and how to interpret it. It never licenses a claim about this business that the retrieved sources do not support. When your expertise suggests a likely problem you could not verify, either ground it in the owner's intake answers and label it INTAKE-REPORTED, or leave it out.

NEVER WRITE AN INTERNAL SOURCE LABEL IN CUSTOMER-FACING TEXT. Labels such as WEBSITE, BOOKING, GOOGLE_PROFILE, SOCIAL and SITE_PAGE_1 exist only to tag evidence in the "sources" array. The reader is a clinic owner who has never seen them. In every visible field — interpretation, topLeaks, observed, hesitation, fix, quickWins, plan and the scorecard — refer to a page by its name or its role ("the Botox page", "your booking page", "your Google profile"), never by its label.

NEVER ASSERT THAT LISTED INFORMATION IS ACCURATE. Sources can show that hours, a phone number or an address are PRESENT. They cannot show that those details are correct. Write "listed" or "shown", never "accurate", "correct", "up to date" or "verified". Likewise, when the same figure appears with different values from different sources, do not silently pick one: name the source for each, or use only the retrieved source.

NEVER BUILD A FINDING ON A MEASUREMENT CEILING. Some source values are capped by the data source rather than by the business. Where a source says a value is capped, at least, or unknown, treat it as unknown — never as a low number, never as evidence of a deficiency, and never as one of the three leaks.

EVIDENCE RULES — these are strict:
- The user message contains source content for these sources only: FULL PAGE TEXT for [${fullLabels.join(", ") || "—"}]; PUBLIC PREVIEW METADATA ONLY for [${partialLabels.join(", ") || "—"}]. Sources marked UNAVAILABLE could not be read; you know nothing about their content.
- A finding may be labeled basis "OBSERVED" ONLY when it describes something actually present in the provided source content, and it must list which of [${citable.join(", ") || "—"}] it came from.
- For PREVIEW-METADATA sources, an OBSERVED finding may describe only what the preview itself shows (e.g. the bio text, follower count, or the absence of a booking link in the bio) — never anything about the page beyond the preview.
- Anything grounded only in the owner's intake answers must be labeled basis "INTAKE-REPORTED" with sources [].
- Never present an assumption or an unavailable source as an observation. Never describe the content of an UNAVAILABLE source.
- Do not build a leak out of our own retrieval limits. "Your Google profile could not be verified" describes our tooling, not the customer's business, and must never be one of the three leaks. If a source was unreadable, spend that leak on something you did observe.${hasSources ? "" : "\n- Since NO sources were readable, every leak must use basis \"INTAKE-REPORTED\" and the interpretation must state the review is based on the owner's answers only."}

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
      // B9: the page NAME is what the customer recognises; the label is internal plumbing.
      const named = s.title ? `page name: "${s.title}" — ` : "";
      return `=== SOURCE ${s.label} — RETRIEVED (${named}${s.url}) ===\n${s.text}\n=== END ${s.label} ===`;
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

/* B9: internal source labels must never appear in customer-facing copy. The prompt
   forbids it, but prompts are requests, not guarantees - CP0 run #4 shipped "SITE_PAGE_1"
   into a quick win and two plan days. This rewrites any label that survives into a
   readable page reference, using the real page name where we captured one. Repair rather
   than reject: the finding itself is sound, only the wording is wrong. */
const LABEL_TEXT_RE = /\b(SITE_PAGE_\d+|GOOGLE_PROFILE|WEBSITE|BOOKING|SOCIAL)\b/g;

function scrubSourceLabels(value, nameByLabel) {
  if (typeof value === "string") {
    return value.replace(LABEL_TEXT_RE, (lbl) => nameByLabel[lbl] || "that page");
  }
  if (Array.isArray(value)) return value.map(v => scrubSourceLabels(v, nameByLabel));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubSourceLabels(v, nameByLabel);
    return out;
  }
  return value;
}

function validateAndRepairReport(r, citableLabels, sourceLog) {
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

  /* Scrub labels from visible fields only. leak.sources deliberately keeps the raw
     labels - that array drives the badge rendering, not the prose. */
  const nameByLabel = {};
  for (const src of (sourceLog || [])) {
    if (src.title) nameByLabel[src.label] = `the ${src.title} page`;
    else if (src.label === "GOOGLE_PROFILE") nameByLabel[src.label] = "your Google profile";
    else if (src.label === "BOOKING") nameByLabel[src.label] = "your booking page";
    else if (src.label === "WEBSITE") nameByLabel[src.label] = "your website";
    else if (src.label === "SOCIAL") nameByLabel[src.label] = "your social profile";
  }
  const before = JSON.stringify([r.interpretation, r.topLeaks, r.fixFirst, r.quickWins, r.plan, r.scorecard, r.leaks.map(l => [l.name, l.observed, l.hesitation, l.fix])]);
  r.interpretation = scrubSourceLabels(r.interpretation, nameByLabel);
  r.topLeaks = scrubSourceLabels(r.topLeaks, nameByLabel);
  r.fixFirst = scrubSourceLabels(r.fixFirst, nameByLabel);
  r.quickWins = scrubSourceLabels(r.quickWins, nameByLabel);
  r.plan = scrubSourceLabels(r.plan, nameByLabel);
  r.scorecard = scrubSourceLabels(r.scorecard, nameByLabel);
  for (const leak of r.leaks) {
    leak.name = scrubSourceLabels(leak.name, nameByLabel);
    leak.observed = scrubSourceLabels(leak.observed, nameByLabel);
    leak.hesitation = scrubSourceLabels(leak.hesitation, nameByLabel);
    leak.fix = scrubSourceLabels(leak.fix, nameByLabel);
  }
  const after = JSON.stringify([r.interpretation, r.topLeaks, r.fixFirst, r.quickWins, r.plan, r.scorecard, r.leaks.map(l => [l.name, l.observed, l.hesitation, l.fix])]);
  if (before !== after) notes.push("Internal source labels were rewritten as readable page references.");

  // Banned outcome claims — no invented revenue/booking/ranking/ROI results.
  const textPool = JSON.stringify([r.interpretation, r.topLeaks, r.fixFirst, r.leaks, r.quickWins, r.plan]);
  for (const pat of BANNED_CLAIM_PATTERNS) {
    const hit = textPool.match(pat);
    if (hit) return { ok: false, error: `Report failed validation: contains a prohibited outcome claim ("${hit[0]}").` };
  }

  return { ok: true, report: r, notes };
}
