/* The counter at Breakpoint. A paid order is written straight into the ledger
   (the payment itself is the one step that needs real money), then the pass and
   the hand-over are driven exactly as they will be on the day. */

import { spawn } from "node:child_process";
import { rmSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { encodeBase58 } from "../src/base58.js";

var here = dirname(fileURLToPath(import.meta.url));
var root = resolve(here, "../..");
rmSync(resolve(root, "data/test"), { recursive: true, force: true });
mkdirSync(resolve(root, "data/test"), { recursive: true });

var PORT = 4397, BASE = "http://127.0.0.1:" + PORT;
var adminKp = generateKeyPairSync("ed25519");
var ADMIN_ADDRESS = encodeBase58(adminKp.publicKey.export({ format: "der", type: "spki" }).subarray(12));
var env = Object.assign({}, process.env, {
  PORT: String(PORT), DB_PATH: "../data/test/pickup.db", PUBLIC_ORIGIN: BASE,
  SESSION_SECRET: "s".repeat(64), ADMIN_WALLETS: ADMIN_ADDRESS, PRICE_USDC: "300", LIST_PRICE_USDC: "0", CAP: "15",
  TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: ""
});

// Seed a paid order the way a verified payment would.
process.env.DB_PATH = "../data/test/pickup.db";
process.env.SESSION_SECRET = "s".repeat(64);
process.env.ADMIN_WALLETS = ADMIN_ADDRESS;
var store = await import("../src/db.js");
var pending = store.createPendingOrder({
  wallet: "So11111111111111111111111111111111111111112",
  name: "Shina Foo", email: "shina@example.com", x: "shizudio", tg: "shizudio",
  reference: "ReF00000000000000000000000000000000000000001"
});
var paid = store.markPaid(pending.id, "5".repeat(64));
store.db.close();

var child = spawn(process.execPath, ["--env-file=.env", "src/index.js"],
  { cwd: resolve(here, ".."), env: env, stdio: ["ignore", "pipe", "pipe"] });
var log = ""; child.stdout.on("data", d => log += d); child.stderr.on("data", d => log += d);

var pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (detail !== undefined ? "  <- " + JSON.stringify(detail) : "")); }
}
var sleep = ms => new Promise(r => setTimeout(r, ms));

try {
  for (var i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + "/api/state")).ok) break; } catch (e) {}
    await sleep(250);
  }

  console.log("\nwhat the payment produced");
  check("a piece number was assigned", paid.piece_no === 1, paid.piece_no);
  check("a pickup code was minted", /^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(paid.pickup_code), paid.pickup_code);
  check("the code avoids I, L, O and U", !/[ILOU]/.test(paid.pickup_code), paid.pickup_code);

  console.log("\nthere is no public lookup by code");
  var byCode = await fetch(BASE + "/api/pass/" + paid.pickup_code);
  check("the code alone returns no order", byCode.status === 404, byCode.status);
  check("the standalone pass page is gone", (await fetch(BASE + "/pass?code=" + paid.pickup_code)).status === 404);

  console.log("\nthe pickup code is never in a URL");
  check("no QR endpoint takes a code in the path",
    (await fetch(BASE + "/api/pass/" + paid.pickup_code + "/qr.svg")).status === 404);
  check("the buyer's QR needs their session",
    (await fetch(BASE + "/api/orders/" + paid.id + "/qr", { method: "POST" })).status === 401);

  console.log("\nthe counter");
  var cookie = "";
  async function admin(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ "content-type": "application/json", cookie: cookie }, opts.headers || {});
    var r = await fetch(BASE + path, opts);
    var sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    return { status: r.status, body: await r.json().catch(function () { return null; }) };
  }

  check("no session, no ledger", (await admin("/api/admin/orders")).status === 401);

  var n = await admin("/api/session/nonce", { method: "POST", body: JSON.stringify({ pubkey: ADMIN_ADDRESS }) });
  var sig = encodeBase58(edSign(null, Buffer.from(n.body.message, "utf8"), adminKp.privateKey));
  var v = await admin("/api/session/verify", {
    method: "POST",
    body: JSON.stringify({ pubkey: ADMIN_ADDRESS, signature: sig, nonce: n.body.nonce, issuedAt: n.body.issuedAt })
  });
  check("the admin wallet signs in", v.status === 200 && v.body.isAdmin === true, v.body);

  var c1 = await admin("/api/admin/collect", { method: "POST", body: JSON.stringify({ code: paid.pickup_code }) });
  check("handing it over is recorded", c1.status === 200 && c1.body.piece === 1, c1.body);

  var again = await admin("/api/admin/collect", { method: "POST", body: JSON.stringify({ code: paid.pickup_code }) });
  check("a second scan is not an error, and does not move the time",
    again.status === 200 && again.body.collectedAt === c1.body.collectedAt, [c1.body.collectedAt, again.body.collectedAt]);

  var ledAfter = await admin("/api/admin/orders");
  check("the ledger now says collected", !!ledAfter.body.orders[0].collectedAt);
  /* Who released it is the wallet that signed, not a name someone typed. */
  check("and records which wallet released it", ledAfter.body.orders[0].collectedBy === ADMIN_ADDRESS, ledAfter.body.orders[0].collectedBy);

  check("an unknown code is refused",
    (await admin("/api/admin/collect", { method: "POST", body: JSON.stringify({ code: "ZZZZ-ZZZZ" }) })).status === 404);

  console.log("\nthe ledger");
  var led = (await admin("/api/admin/orders")).body;
  check("staff can see the wallet and email", !!led.orders[0].wallet && !!led.orders[0].email);

  console.log("\n" + pass + " passed, " + fail + " failed");
} catch (e) {
  console.error("\nTEST ERROR", e); console.error(log.slice(-1500)); fail++;
} finally { child.kill("SIGTERM"); }
process.exit(fail ? 1 : 0);
