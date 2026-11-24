// api/_lib/gumroad.js — shared Gumroad license check (moved unchanged from diagnostic.js,
// plus: returns the purchase's sale id so stored runs are tied to the purchase).

export const GUMROAD_PRODUCT_ID = "yyzm9n6iAxsrLx2LbmW0AA=="; // not a secret — public product identifier

/* allowBadStanding: deletion requests are honoured even for refunded/disputed purchases —
   the buyer still owns the key and should be able to remove their data. */
export async function verifyGumroadLicense(licenseKey, { allowBadStanding = false } = {}) {
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
  const ok = { valid: true, productId: GUMROAD_PRODUCT_ID, saleId: typeof p.sale_id === "string" ? p.sale_id : (p.id ? String(p.id) : null) };
  if (allowBadStanding) return ok;
  if (p.refunded) return { valid: false, status: 403, error: "This purchase was refunded, so a report can no longer be generated with this key." };
  if (p.chargebacked) return { valid: false, status: 403, error: "This purchase is not in good standing, so a report cannot be generated with this key." };
  if (p.disputed && !p.dispute_won) return { valid: false, status: 403, error: "This purchase is under dispute, so a report cannot be generated right now." };
  return ok;
}

export function readLicenseKey(body) {
  const k = typeof body?.license_key === "string" ? body.license_key.trim() : "";
  return k && k.length <= 100 ? k : "";
}

export function applyCors(req, res) {
  const origin = req.headers.origin || "";
  const allowed = /^https:\/\/(diagnostic\.bloomsol\.co|bloomsol\.co|[a-z0-9-]+\.vercel\.app)$/.test(origin);
  res.setHeader("Access-Control-Allow-Origin", allowed ? origin : "https://diagnostic.bloomsol.co");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
}
