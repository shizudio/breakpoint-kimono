import { listOrders, listWaitlist, isConfigured } from "./_lib/db.js";

/* Your view of both tables. Guarded by ADMIN_KEY, which you set in the Vercel
   dashboard alongside the database — this returns names and email addresses, so
   it must never be reachable without it. */
export default async function handler(req, res) {
  const expected = process.env.ADMIN_KEY;
  if (!expected) return res.status(503).json({ error: "admin_key_not_set" });

  const given = req.headers["x-admin-key"] || (req.query && req.query.key) || "";
  if (given !== expected) return res.status(401).json({ error: "unauthorized" });

  if (!isConfigured()) return res.status(503).json({ error: "storage_not_configured" });

  try {
    const [orders, waitlist] = await Promise.all([listOrders(), listWaitlist()]);

    if ((req.query && req.query.format) === "csv") {
      const esc = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
      const lines = ["list,wave,piece,status,solana_mark,name,email,x,telegram,created_at"];
      orders.forEach((o) => lines.push(
        ["order", o.wave, o.piece, o.status, o.solana_mark, o.name, o.email, o.x_handle, o.tg_handle, o.created_at].map(esc).join(",")));
      waitlist.forEach((w) => lines.push(
        ["notify", "", "", "", "", w.name, w.email, w.x_handle, w.tg_handle, w.created_at].map(esc).join(",")));
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="breakpoint-kimono.csv"');
      return res.status(200).send(lines.join("\n"));
    }

    const wave1 = orders.filter((o) => Number(o.wave) === 1);
    const wave2 = orders.filter((o) => Number(o.wave) === 2);
    return res.status(200).json({
      wave1: { count: wave1.length, of: 15, rows: wave1 },
      wave2: { count: wave2.length, status: "pending_confirmation", rows: wave2 },
      notify: { count: waitlist.length, rows: waitlist }
    });
  } catch (e) {
    console.error("admin failed", e);
    return res.status(500).json({ error: "failed" });
  }
}
