/* Same rules the browser applies. The client check is a courtesy; this one is
   the boundary, because anything can POST to these routes. */
export function normHandle(v) {
  return String(v || "").trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^(www\.)?(x\.com|twitter\.com|t\.me|telegram\.me)\//i, "")
    .replace(/[?#].*$/, "")
    .replace(/^@+/, "")
    .replace(/\/+$/, "")
    .trim();
}

export function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body || "{}"); } catch { return {}; }
}

export function clean(raw) {
  const name = String(raw.name || "").trim().slice(0, 120);
  const email = String(raw.email || "").trim().slice(0, 200);
  const x = normHandle(raw.x).slice(0, 15);
  const tg = normHandle(raw.tg).slice(0, 32);

  const errors = [];
  if (!name) errors.push("name");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.push("email");
  if (x && !/^[A-Za-z0-9_]{1,15}$/.test(x)) errors.push("x");
  if (tg && !/^[A-Za-z0-9_]{5,32}$/.test(tg)) errors.push("tg");

  return { value: { name, email, x, tg }, errors };
}
