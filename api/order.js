import { claimPiece, isConfigured } from "./_lib/db.js";
import { readBody, clean } from "./_lib/validate.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const raw = readBody(req);
  const wave = Number(raw.wave) === 2 ? 2 : 1;
  // null when unanswered, so an unchosen mark is distinguishable from a declined one
  const mark = raw.mark === true ? true : raw.mark === false ? false : null;
  const { value, errors } = clean(raw);
  if (errors.length) return res.status(400).json({ error: "invalid", fields: errors });

  if (!isConfigured()) {
    // Say so rather than pretending the order was taken.
    return res.status(503).json({ error: "storage_not_configured" });
  }

  try {
    const result = await claimPiece({ ...value, wave, mark });
    // Only wave one can sell out; wave two is confirmed by volume, not capped.
    if (!result.ok && result.reason === "sold_out") {
      return res.status(409).json({ error: "sold_out" });
    }
    if (!result.ok) return res.status(500).json({ error: result.reason || "failed" });
    return res.status(200).json({
      ok: true, piece: result.piece, wave: result.wave, already: !!result.already
    });
  } catch (e) {
    console.error("order failed", e);
    return res.status(500).json({ error: "failed" });
  }
}
