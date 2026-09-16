import { listOrders, isConfigured, PIECES } from "./_lib/db.js";

/* What the page reads on load. Public, so it carries handles only — never the
   email or name a buyer gave us. */
export default async function handler(req, res) {
  if (!isConfigured()) {
    return res.status(200).json({ configured: false, pieces: PIECES, buyers: [] });
  }
  try {
    const rows = await listOrders();
    return res.status(200).json({
      configured: true,
      pieces: PIECES,
      reserved: rows.length,
      buyers: rows
        .slice()
        .reverse()
        .map((r) => ({ piece: r.piece, handle: r.x_handle || null }))
    });
  } catch (e) {
    console.error("reservations failed", e);
    return res.status(500).json({ error: "failed" });
  }
}
