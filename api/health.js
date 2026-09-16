import { isConfigured, selfTest } from "./_lib/db.js";

/* Run this once the database is connected. It proves the schema landed, the
   indexes that enforce the cap exist, and the free-piece query — the one thing
   standing between you and selling the same piece twice — actually returns what
   it should. Gated by ADMIN_KEY because it reports internals. */
export default async function handler(req, res) {
  const expected = process.env.ADMIN_KEY;
  if (!expected) return res.status(503).json({ ok: false, error: "admin_key_not_set" });
  const given = req.headers["x-admin-key"] || (req.query && req.query.key) || "";
  if (given !== expected) return res.status(401).json({ ok: false, error: "unauthorized" });

  if (!isConfigured()) {
    return res.status(503).json({ ok: false, error: "storage_not_configured", hint: "DATABASE_URL is not set on this project" });
  }
  try {
    return res.status(200).json(await selfTest());
  } catch (e) {
    console.error("health failed", e);
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
}
