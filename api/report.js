// api/report.js — BSC-030 buyer self-service for a stored diagnostic.
//
//   POST { license_key, action: "retrieve" }  -> the stored report, exactly as first returned
//   POST { license_key, action: "delete" }    -> scrubs that purchase's inputs + report
//
// The license key is the only credential, sent in the POST body (never a URL, so it stays
// out of access logs and browser history). Lookup is by its hash only. There is no list,
// search or by-id read anywhere in the system, so nobody without the key can reach a report.
// Every call — found or not — is written to diagnostic_report_events inside the database.

import { verifyGumroadLicense, readLicenseKey, applyCors } from "./_lib/gumroad.js";
import * as store from "./_lib/report-store.js";

const DOWN = "Report storage is temporarily unavailable. Please try again in a few minutes.";

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = req.body || {};
    const licenseKey = readLicenseKey(body);
    if (!licenseKey) return res.status(400).json({ error: "Enter the license key from your Gumroad receipt." });
    const action = body.action === "delete" ? "delete" : body.action === "retrieve" || body.action == null ? "retrieve" : null;
    if (!action) return res.status(400).json({ error: "Unknown action." });

    // Retrieval needs a purchase in good standing; deletion is honoured regardless.
    const lic = await verifyGumroadLicense(licenseKey, { allowBadStanding: action === "delete" });
    if (!lic.valid) return res.status(lic.status).json({ error: lic.error });
    if (!store.storeConfigured()) return res.status(503).json({ error: DOWN, code: "storage_unavailable" });

    const hash = store.licenseHash(licenseKey);

    if (action === "delete") {
      let r;
      try { r = await store.remove({ hash, actor: "buyer", reason: "buyer_request" }); }
      catch { return res.status(503).json({ error: DOWN, code: "storage_unavailable" }); }
      if (r && r.ok) return res.status(200).json({ deleted: true });
      return res.status(404).json({ code: "not_found", error: "No stored report was found for this license key." });
    }

    let r;
    try { r = await store.retrieve({ hash }); }
    catch { return res.status(503).json({ error: DOWN, code: "storage_unavailable" }); }

    if (r && r.found) return res.status(200).json(store.reportResponse(r));
    const msg = {
      not_found: [404, "No stored report was found for this license key. If you haven't generated your diagnostic yet, fill in the intake form above."],
      not_ready: [409, "Your report isn't finished yet. If you just submitted, wait a few minutes and try again."],
      deleted:   [410, "The report for this license key was deleted."],
      expired:   [410, "The report for this license key is past its storage period."],
    }[r && r.reason] || [503, DOWN];
    return res.status(msg[0]).json({ code: (r && r.reason) || "storage_unavailable", error: msg[1] });
  } catch {
    return res.status(500).json({ error: "Unexpected server error. Please try again." });
  }
}
