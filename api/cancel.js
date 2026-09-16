import { cancelOrder, isConfigured } from "./_lib/db.js";
import { readBody } from "./_lib/validate.js";

/* The page promises "cancel any time by writing to @shizudio" — this is how you
 * honour that. Cancelling sets status='cancelled' rather than deleting the row,
 * so the piece number frees up for the next buyer while the history of who held
 * it survives. ADMIN_KEY-gated: only you can cancel, never the buyer directly.
 */
export default async function handler(req, res) {
  const expected = process.env.ADMIN_KEY;
  if (!expected) return res.status(503).json({ error: "admin_key_not_set" });
  const given = req.headers["x-admin-key"] || (req.query && req.query.key) || "";
  if (given !== expected) return res.status(401).json({ error: "unauthorized" });
  if (!isConfigured()) return res.status(503).json({ error: "storage_not_configured" });

  const body = readBody(req);
  const email = String(body.email || (req.query && req.query.email) || "").trim();
  const wave = Number(body.wave || (req.query && req.query.wave) || 1) === 2 ? 2 : 1;
  if (!email) return res.status(400).json({ error: "email_required" });

  try {
    const rows = await cancelOrder(email, wave);
    if (!rows.length) return res.status(404).json({ error: "no_live_order", email, wave });
    return res.status(200).json({ ok: true, cancelled: rows, freed: rows.map((r) => r.piece) });
  } catch (e) {
    console.error("cancel failed", e);
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
