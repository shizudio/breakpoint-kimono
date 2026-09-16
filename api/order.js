import { claimPiece, isConfigured } from "./_lib/db.js";
import { readBody, clean } from "./_lib/validate.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const { value, errors } = clean(readBody(req));
  if (errors.length) return res.status(400).json({ error: "invalid", fields: errors });

  if (!isConfigured()) {
    // Say so rather than pretending the order was taken.
    return res.status(503).json({ error: "storage_not_configured" });
  }

  try {
    const result = await claimPiece(value);
    if (!result.ok && result.reason === "sold_out") {
      return res.status(409).json({ error: "sold_out" });
    }
    if (!result.ok) return res.status(500).json({ error: result.reason || "failed" });
    return res.status(200).json({ ok: true, piece: result.piece, already: !!result.already });
  } catch (e) {
    console.error("order failed", e);
    return res.status(500).json({ error: "failed" });
  }
}
