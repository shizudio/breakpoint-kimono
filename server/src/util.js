import { explorerTx } from "./config.js";

/* HTTP plumbing and input validation.

   The validation here deliberately mirrors the rules in site/index.html. That
   duplication is the point: the client's copy is there to give a helpful error
   before a round trip, this one is there because the client's copy can be
   deleted from the console. */

export function json(res, status, body, headers) {
  var payload = JSON.stringify(body);
  var h = Object.assign({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  }, headers || {});
  res.writeHead(status, h);
  res.end(payload);
}

export function fail(res, status, code, message, extra) {
  json(res, status, Object.assign({ error: code, message: message }, extra || {}));
}

/* 16KB is far more than four short fields; anything larger is not a buyer. */
export function readJson(req, limit) {
  var max = limit || 16 * 1024;
  return new Promise(function (resolve, reject) {
    var chunks = [], size = 0;
    req.on("data", function (c) {
      size += c.length;
      if (size > max) { reject(Object.assign(new Error("TOO_LARGE"), { code: "TOO_LARGE" })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", function () {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (e) { reject(Object.assign(new Error("BAD_JSON"), { code: "BAD_JSON" })); }
    });
    req.on("error", reject);
  });
}

/* ---------- field rules, same shapes the page enforces ---------- */

export function normHandle(v) {
  return String(v == null ? "" : v).trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^(www\.)?(x\.com|twitter\.com|t\.me|telegram\.me)\//i, "")
    .replace(/[?#].*$/, "")
    .replace(/^@+/, "")
    .replace(/\/+$/, "")
    .trim();
}

export function validateOrder(input) {
  var v = {
    name: String(input.name == null ? "" : input.name).trim().slice(0, 120),
    email: String(input.email == null ? "" : input.email).trim().slice(0, 200),
    x: normHandle(input.x).slice(0, 40),
    tg: normHandle(input.tg).slice(0, 60),
    /* Three states, deliberately. The panel makes the buyer choose, so a body
       without it is an older client or a hand-rolled request — recorded as
       "never asked" rather than quietly as "no". */
    mark: input.mark == null ? null : !!input.mark
  };
  var errs = {};
  if (!v.name) errs.name = "We need a name for the piece.";
  // Loose on purpose: the only authority on an address is sending to it.
  if (!v.email) errs.email = "We send payment details here, so we need an address.";
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.email)) errs.email = "That address looks incomplete.";
  if (v.x && !/^[A-Za-z0-9_]{1,15}$/.test(v.x)) errs.x = "That does not look like an X handle.";
  if (v.tg && !/^[A-Za-z0-9_]{5,32}$/.test(v.tg)) errs.tg = "Telegram handles are 5–32 letters, digits or underscores.";
  if (input.mark != null && typeof input.mark !== "boolean") errs.mark = "Choose the mark, or leave it off.";
  return { value: v, errors: errs, ok: Object.keys(errs).length === 0 };
}

/* ---------- rate limiting ---------- */

/* A fixed window per IP, held in memory. The presale is one small server and
   fifteen pieces; this exists to blunt a script, not to survive a flood. */
var buckets = new Map();
export function rateLimit(key, max, windowMs) {
  var now = Date.now();
  var b = buckets.get(key);
  if (!b || now > b.reset) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.count++;
  if (buckets.size > 5000) {
    buckets.forEach(function (v, k) { if (now > v.reset) buckets.delete(k); });
  }
  return { ok: b.count <= max, retryAfter: Math.ceil((b.reset - now) / 1000) };
}

export function clientIp(req, trustProxy) {
  if (trustProxy) {
    var fwd = req.headers["x-forwarded-for"];
    if (fwd) return String(fwd).split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

/* ---------- shaping rows for the browser ---------- */


/* What the buyer is allowed to see of their own order. Wallet, email and name
   come back because it is theirs; nothing here reaches another visitor. */
export function publicOrder(o, origin) {
  if (!o) return null;
  return {
    id: o.id,
    status: o.status,
    piece: o.piece_no,
    name: o.name,
    email: o.email,
    x: o.x_handle,
    tg: o.tg_handle,
    mark: o.mark == null ? null : !!o.mark,
    wave: o.wave || 1,
    waveNo: o.wave_no == null ? null : o.wave_no,
    /* Survives a reload, so someone who comes back to their order still sees
       that the piece was missed and that the refund is theirs for the asking. */
    missedRun: !!o.wave_missed,
    amountUsdc: o.amount_usdc,
    signature: o.tx_signature,
    explorer: o.tx_signature ? explorerTx(o.tx_signature) : null,
    pickupCode: o.pickup_code,
    collectedAt: o.collected_at,
    createdAt: o.created_at,
    paidAt: o.paid_at,
    holdExpiresAt: o.status === "pending" ? o.hold_expires_at : null,
    // No pickup code in a URL, ever. The page POSTs to this for the image.
    qrUrl: o.pickup_code ? "/api/orders/" + o.id + "/qr" : null
  };
}
