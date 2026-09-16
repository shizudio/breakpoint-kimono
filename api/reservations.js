import { listOrders, isConfigured, PIECES } from "./_lib/db.js";

/* What the page reads on load. Public, so it carries handles only — never the
   email or name a buyer gave us. */
export default async function handler(req, res) {
  if (!isConfigured()) {
    return res.status(200).json({ configured: false, pieces: PIECES, buyers: [] });
  }
  try {
    const rows = await listOrders();
    const wave1 = rows.filter((r) => Number(r.wave) === 1);
    const wave2 = rows.filter((r) => Number(r.wave) === 2);
    return res.status(200).json({
      configured: true,
      pieces: PIECES,
      reserved: wave1.length,
      // The fifteen-row ledger is wave one; wave two is reported as a count only.
      buyers: wave1.slice().reverse().map((r) => ({ piece: r.piece, handle: r.x_handle || null })),
      wave2: { count: wave2.length }
    });
  } catch (e) {
    console.error("reservations failed", e);
    return res.status(500).json({ error: "failed" });
  }
}
