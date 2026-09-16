/* Base58 (Bitcoin alphabet) — the encoding Solana uses for public keys and
   signatures. Written out rather than pulled in, so signature verification has
   no dependency of its own: this file is the only thing standing between a
   forged signature and a session.

   Both loops start from an empty digit array, not [0]. Seeding with a zero is
   the usual shorthand, but it survives an all-zero input as a spurious extra
   byte/character — which is exactly the System Program address, 32 zero bytes
   written as 32 '1's. */

var ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
var MAP = (function () {
  var m = Object.create(null);
  for (var i = 0; i < ALPHABET.length; i++) m[ALPHABET[i]] = i;
  return m;
})();

export function decodeBase58(str) {
  if (typeof str !== "string" || str.length === 0) throw new Error("base58: empty input");
  var bytes = [];
  for (var i = 0; i < str.length; i++) {
    var value = MAP[str[i]];
    if (value === undefined) throw new Error("base58: invalid character " + JSON.stringify(str[i]));
    var carry = value;
    for (var j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  // Each leading '1' is a leading zero byte, which the arithmetic cannot produce.
  for (var k = 0; k < str.length && str[k] === "1"; k++) bytes.push(0);
  return Buffer.from(bytes.reverse());
}

export function encodeBase58(buf) {
  var bytes = Buffer.from(buf);
  var digits = [];
  for (var i = 0; i < bytes.length; i++) {
    var carry = bytes[i];
    for (var j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  var out = "";
  for (var k = 0; k < bytes.length && bytes[k] === 0; k++) out += "1";
  for (var d = digits.length - 1; d >= 0; d--) out += ALPHABET[digits[d]];
  return out;
}

/* A Solana address is 32 bytes; anything else is a typo or an attack. */
export function isAddress(str) {
  try { return decodeBase58(str).length === 32; } catch (e) { return false; }
}

/* A signature is 64. */
export function isSignature(str) {
  try { return decodeBase58(str).length === 64; } catch (e) { return false; }
}
