// api/diagnostic.js — Vercel serverless proxy for the Lost Booking Diagnostic
// Keeps your Anthropic key server-side. Front-end calls /api/diagnostic, never Anthropic directly.

export default async function handler(req, res) {
  // Allow the custom domain and the *.vercel.app preview/prod URLs
  const origin = req.headers.origin || "";
  const allowed = /(^https:\/\/bloomsol\.co$)|(\.vercel\.app$)/.test(origin);
  res.setHeader("Access-Control-Allow-Origin", allowed ? origin : "https://bloomsol.co");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { model, max_tokens, system, messages } = req.body || {};
    if (!messages) return res.status(400).json({ error: "Missing messages" });

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,   // set in Vercel env vars
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: model || "claude-sonnet-4-6",
        max_tokens: max_tokens || 4000,
        system,
        messages
      })
    });

    const data = await r.json();
    return res.status(r.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: String(err && err.message || err) });
  }
}
