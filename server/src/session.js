/* Wallet sign-in.

   The buyer proves they hold the key by signing a nonce; we hand back an
   HMAC-signed cookie. No password, no account, nothing to leak — and it means
   a returning buyer can reopen their pickup pass from the same wallet.

   Ed25519 verification goes through node:crypto rather than a library. A raw
   Solana public key is 32 bytes; node wants SPKI DER, which for Ed25519 is a
   fixed 12-byte prefix and nothing else. */

import { createPublicKey, verify, createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { decodeBase58, isAddress } from "./base58.js";
import { config } from "./config.js";
import { issueNonce, consumeNonce } from "./db.js";

var SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

function ed25519PublicKey(raw32) {
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519, raw32]),
    format: "der",
    type: "spki"
  });
}

/* The exact text the wallet displays and signs. Built on the server both times
   — at issue and at verification — so the bytes cannot drift between them.
 *
 * This is Sign In With Solana, and the format is not decorative. The opening
 * line makes Phantom parse the whole message against the SIWS grammar, and a
 * message that opens that way but does not parse is refused outright: "The
 * app's signature request cannot be shown due to invalid formatting." There is
 * no partial credit and no fallback to showing the raw text. So:
 *
 *   - the statement is ONE line. A newline inside it ends the statement as far
 *     as the grammar is concerned and the rest fails to parse.
 *   - URI, Version and Chain ID are required fields, not optional garnish, and
 *     the five fields must appear in this order.
 *   - the domain on the first line and URI must match the origin the page is
 *     served from, which is what PUBLIC_ORIGIN is for. Opening the app on any
 *     other host — the API's own IP, say — makes the wallet reject the request
 *     even though the text is well-formed.
 */
export function signInMessage(pubkey, nonce, issuedAt) {
  var origin = new URL(config.publicOrigin);
  return [
    origin.host + " wants you to sign in with your Solana account:",
    pubkey,
    "",
    "Sign in to reserve a Breakpoint Kimono. This signature proves you hold the key; it approves no payment and moves no funds.",
    "",
    "URI: " + origin.origin,
    "Version: 1",
    "Chain ID: " + config.network,
    "Nonce: " + nonce,
    "Issued At: " + new Date(issuedAt).toISOString()
  ].join("\n");
}

export function startSignIn(pubkey) {
  if (!isAddress(pubkey)) throw Object.assign(new Error("BAD_PUBKEY"), { code: "BAD_PUBKEY" });
  var nonce = issueNonce();
  var issuedAt = Date.now();
  // created_at is the row's own timestamp; keep them identical so the message
  // rebuilt at verification is byte-for-byte the one that was signed.
  return { nonce: nonce, issuedAt: issuedAt, message: signInMessage(pubkey, nonce, issuedAt) };
}

export function verifySignIn(pubkey, signatureB58, nonce, issuedAt) {
  if (!isAddress(pubkey)) return { ok: false, reason: "BAD_PUBKEY" };
  if (!consumeNonce(nonce)) return { ok: false, reason: "BAD_NONCE" };  // replayed or stale

  var message, signature, key;
  try {
    message = Buffer.from(signInMessage(pubkey, nonce, issuedAt), "utf8");
    signature = decodeBase58(signatureB58);
    key = ed25519PublicKey(decodeBase58(pubkey));
  } catch (e) {
    return { ok: false, reason: "MALFORMED" };
  }
  if (signature.length !== 64) return { ok: false, reason: "MALFORMED" };
  if (!verify(null, message, key, signature)) return { ok: false, reason: "BAD_SIGNATURE" };
  return { ok: true, pubkey: pubkey };
}

/* ---------- cookie ---------- */

var COOKIE = "bk_session";

function b64url(buf) { return Buffer.from(buf).toString("base64url"); }

function sign(payload) {
  return createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
}

export function mintToken(pubkey) {
  var body = b64url(JSON.stringify({ w: pubkey, exp: Date.now() + config.sessionHours * 3600000 }));
  return body + "." + sign(body);
}

export function readToken(token) {
  if (typeof token !== "string") return null;
  var dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  var body = token.slice(0, dot), mac = token.slice(dot + 1);
  var expected = Buffer.from(sign(body));
  var given = Buffer.from(mac);
  // Length check first: timingSafeEqual throws on a mismatch rather than returning false.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    var claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!claims || typeof claims.w !== "string" || !(claims.exp > Date.now())) return null;
    return claims.w;
  } catch (e) { return null; }
}

export function cookieHeader(token) {
  /* Lax while the app and the API share an origin: it is what stops a
     cross-site POST from carrying the session, and it is our CSRF story.
     Serving the app from somewhere else forces None, which gives that up — so
     the CORS allowlist becomes the thing standing in its place, and it is
     checked on every request rather than only on preflight. */
  var crossSite = config.allowedOrigins.length > 0;
  var parts = [
    COOKIE + "=" + (token || ""),
    "Path=/",
    "HttpOnly",
    "SameSite=" + (crossSite ? "None" : "Lax"),
    token ? "Max-Age=" + Math.floor(config.sessionHours * 3600) : "Max-Age=0"
  ];
  if (config.secureCookies) parts.push("Secure");
  return parts.join("; ");
}

export function walletFromRequest(req) {
  var raw = req.headers.cookie || "";
  var found = null;
  raw.split(";").forEach(function (pair) {
    var i = pair.indexOf("=");
    if (i < 0) return;
    if (pair.slice(0, i).trim() === COOKIE) found = pair.slice(i + 1).trim();
  });
  return found ? readToken(found) : null;
}

export { randomBytes };
