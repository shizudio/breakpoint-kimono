import { addWaitlist, isConfigured } from "./_lib/db.js";
import { readBody, clean } from "./_lib/validate.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const { value, errors } = clean(readBody(req));
  if (errors.length) return res.status(400).json({ error: "invalid", fields: errors });

  if (!isConfigured()) return res.status(503).json({ error: "storage_not_configured" });

  try {
    await addWaitlist(value);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("waitlist failed", e);
    return res.status(500).json({ error: "failed" });
  }
}
