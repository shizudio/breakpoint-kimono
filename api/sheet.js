import { listOrders, listWaitlist, isConfigured } from "./_lib/db.js";

/* CSV for Google Sheets' IMPORTDATA.
 *
 * Deliberately separate from /api/admin and gated by its own SHEET_KEY: the key
 * has to live in a sheet formula where every viewer of that sheet can read it,
 * so it must not be the key that also unlocks the full JSON dump. Rotate this
 * one if a sheet is shared too widely and ADMIN_KEY is untouched.
 */
export default async function handler(req, res) {
  const expected = process.env.SHEET_KEY;
  if (!expected) return res.status(503).send("SHEET_KEY is not set on this project");

  const given = (req.query && req.query.key) || "";
  if (given !== expected) return res.status(401).send("unauthorized");

  if (!isConfigured()) return res.status(503).send("storage not configured");

  try {
    const [orders, waitlist] = await Promise.all([listOrders(), listWaitlist()]);
    const esc = (v) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const day = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace("T", " ") : "");
    const mark = (m) => (m === true ? "yes" : m === false ? "no" : "");

    const rows = [["list", "wave", "piece", "status", "solana_mark", "name", "email", "x", "telegram", "created"]];
    orders.forEach((o) => rows.push(
      ["order", o.wave, o.piece, o.status, mark(o.solana_mark), o.name, o.email, o.x_handle, o.tg_handle, day(o.created_at)]));
    waitlist.forEach((w) => rows.push(
      ["notify", "", "", "", "", w.name, w.email, w.x_handle, w.tg_handle, day(w.created_at)]));

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    // IMPORTDATA caches; this keeps Google from holding a stale copy longer than it must.
    res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
    return res.status(200).send(rows.map((r) => r.map(esc).join(",")).join("\n"));
  } catch (e) {
    console.error("sheet failed", e);
    return res.status(500).send("failed");
  }
}
