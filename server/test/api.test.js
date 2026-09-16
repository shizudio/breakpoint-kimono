/* Boots the real server against a scratch database and walks the buyer's path:
   connect, sign in, reserve, and every way those can be refused. The one step
   it cannot perform is the payment itself — that needs 300 USDC and a real
   wallet, so confirm() is tested for its refusals here and on devnet by hand. */

import { spawn } from "node:child_process";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { rmSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeBase58 } from "../src/base58.js";
import { execFileSync } from "node:child_process";

var here = dirname(fileURLToPath(import.meta.url));
var tmp = resolve(here, "../../data/test");
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

var PORT = 4399, BASE = "http://127.0.0.1:" + PORT;

/* The admin is a wallet now, so the suite needs a keypair for it before the
   server starts — its address goes into ADMIN_WALLETS. */
var adminKp = generateKeyPairSync("ed25519");
var ADMIN_ADDRESS = encodeBase58(adminKp.publicKey.export({ format: "der", type: "spki" }).subarray(12));

/* The static assertions below check the real deployment artifact, not the
   source tree: since the front end became a Vite app, site/public/ is served at
   the root and only the build has that shape. It takes about 150ms. */
execFileSync("npm", ["run", "build"], { cwd: resolve(here, "../.."), stdio: "pipe" });

var child = spawn(process.execPath, ["--env-file=.env", "src/index.js"], {
  cwd: resolve(here, ".."),
  env: Object.assign({}, process.env, {
    PORT: String(PORT), DB_PATH: "../data/test/api.db", ADMIN_WALLETS: ADMIN_ADDRESS,
    SITE_DIR: "../dist",
    SESSION_SECRET: "s".repeat(64), CAP: "2", PUBLIC_ORIGIN: BASE,
    /* Pinned, not inherited. The suite loads the real .env for RPC_URL, and a
       price changed there for a cheap rehearsal must not decide what the tests
       assert. */
    PRICE_USDC: "300",
    TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: ""
  }),
  stdio: ["ignore", "pipe", "pipe"]
});
var serverLog = "";
child.stdout.on("data", function (d) { serverLog += d; });
child.stderr.on("data", function (d) { serverLog += d; });

var pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (detail ? "  <- " + JSON.stringify(detail) : "")); }
}

var cookie = "";
async function call(method, path, body, headers) {
  var res = await fetch(BASE + path, {
    method: method,
    headers: Object.assign({ "content-type": "application/json", cookie: cookie }, headers || {}),
    body: body == null ? undefined : JSON.stringify(body)
  });
  var set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  var text = await res.text();
  var json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { status: res.status, body: json, text: text, headers: res.headers };
}

async function waitUntilUp() {
  for (var i = 0; i < 60; i++) {
    try { var r = await fetch(BASE + "/api/state"); if (r.ok) return true; } catch (e) {}
    await new Promise(function (r) { setTimeout(r, 250); });
  }
  return false;
}

try {
  if (!(await waitUntilUp())) throw new Error("server did not start:\n" + serverLog);

  console.log("\nstate");
  var st = await call("GET", "/api/state");
  check("200 with cap and price", st.status === 200 && st.body.cap === 2 && st.body.priceUsdc === 300, st.body);
  check("starts empty", st.body.sold === 0 && st.body.soldOut === false, st.body);
  check("no secrets in the payload", !st.text.includes("helius") && !st.text.includes("api-key"), st.text.slice(0, 200));

  console.log("\nauth required");
  check("orders needs a session", (await call("POST", "/api/orders", { name: "A", email: "a@b.co" })).status === 401);
  check("mine needs a session", (await call("GET", "/api/orders/mine")).status === 401);

  console.log("\nsign in");
  var kp = generateKeyPairSync("ed25519");
  var raw = kp.publicKey.export({ format: "der", type: "spki" }).subarray(12);
  var addr = encodeBase58(raw);
  check("rejects a non-address", (await call("POST", "/api/session/nonce", { pubkey: "nope" })).status === 400);
  var n = await call("POST", "/api/session/nonce", { pubkey: addr });
  check("issues a nonce and a message", n.status === 200 && !!n.body.nonce && n.body.message.includes(addr), n.body);
  var sig = encodeBase58(edSign(null, Buffer.from(n.body.message, "utf8"), kp.privateKey));
  check("rejects a bad signature",
    (await call("POST", "/api/session/verify", { pubkey: addr, signature: encodeBase58(Buffer.alloc(64, 1)), nonce: n.body.nonce, issuedAt: n.body.issuedAt })).status === 401);
  var n2 = await call("POST", "/api/session/nonce", { pubkey: addr });
  var sig2 = encodeBase58(edSign(null, Buffer.from(n2.body.message, "utf8"), kp.privateKey));
  var v = await call("POST", "/api/session/verify", { pubkey: addr, signature: sig2, nonce: n2.body.nonce, issuedAt: n2.body.issuedAt });
  check("accepts a real signature", v.status === 200 && v.body.wallet === addr, v.body);
  check("sets a HttpOnly cookie", /HttpOnly/i.test(v.headers.get("set-cookie") || ""), v.headers.get("set-cookie"));
  check("replaying the nonce fails",
    (await call("POST", "/api/session/verify", { pubkey: addr, signature: sig2, nonce: n2.body.nonce, issuedAt: n2.body.issuedAt })).status === 401);

  console.log("\nordering");
  var bad = await call("POST", "/api/orders", { name: "", email: "nope", x: "way-too-long-a-handle-here", tg: "ab" });
  check("rejects a bad form with per-field errors",
    bad.status === 400 && bad.body.fields.name && bad.body.fields.email && bad.body.fields.x && bad.body.fields.tg, bad.body);
  var o1 = await call("POST", "/api/orders", { name: "Shina Foo", email: "shina@example.com", x: "https://x.com/shizudio?s=21", tg: "@shizudio" });
  check("reserves a slot", o1.status === 200 && o1.body.order.status === "pending", o1.body);
  check("normalises a pasted profile URL", o1.body.order.x === "shizudio", o1.body.order);
  check("returns a signable transaction", typeof o1.body.transaction === "string" && o1.body.transaction.length > 100);
  check("reports the short balance", o1.body.balanceShort === true, o1.body.balanceUsdc);
  check("leaks no RPC url", !o1.text.includes("api-key"));

  var o2 = await call("POST", "/api/orders", { name: "Shina Foo", email: "shina@example.com" });
  check("a second attempt reuses the same hold", o2.body.order.id === o1.body.order.id, [o1.body.order.id, o2.body.order.id]);
  var afterTwo = await call("GET", "/api/state");
  check("one wallet holds exactly one slot", afterTwo.body.taken === 1, afterTwo.body);

  console.log("\nconfirm refusals");
  var c1 = await call("POST", "/api/orders/" + o1.body.order.id + "/confirm", { signature: "not-a-signature" });
  check("rejects a malformed signature", c1.status === 400 && c1.body.error === "BAD_SIGNATURE", c1.body);
  var c2 = await call("POST", "/api/orders/" + "f".repeat(16) + "/confirm", { signature: encodeBase58(Buffer.alloc(64, 3)) });
  check("rejects an unknown order", c2.status === 404, c2.body);
  var c3 = await call("POST", "/api/orders/" + o1.body.order.id + "/confirm", { signature: encodeBase58(Buffer.alloc(64, 3)) });
  check("rejects a signature the chain does not know", c3.status === 402 && c3.body.error === "NOT_FOUND", c3.body);
  check("and says it is worth retrying", c3.body.retryable === true, c3.body);

  console.log("\nownership");
  var other = generateKeyPairSync("ed25519");
  var otherAddr = encodeBase58(other.publicKey.export({ format: "der", type: "spki" }).subarray(12));
  var keep = cookie;
  var n3 = await call("POST", "/api/session/nonce", { pubkey: otherAddr });
  var sig3 = encodeBase58(edSign(null, Buffer.from(n3.body.message, "utf8"), other.privateKey));
  await call("POST", "/api/session/verify", { pubkey: otherAddr, signature: sig3, nonce: n3.body.nonce, issuedAt: n3.body.issuedAt });
  var otherCookie = cookie;
  var steal = await call("POST", "/api/orders/" + o1.body.order.id + "/confirm", { signature: encodeBase58(Buffer.alloc(64, 3)) });
  check("another wallet cannot confirm your order", steal.status === 403, steal.body);
  check("another wallet cannot read your order", (await call("GET", "/api/orders/" + o1.body.order.id)).status === 404);

  console.log("\ncap");
  // Still signed in as the second wallet: it takes the last of the two slots.
  var o3 = await call("POST", "/api/orders", { name: "Second Buyer", email: "b@example.com" });
  check("second wallet takes the last slot", o3.status === 200 && o3.body.order.id !== o1.body.order.id, o3.body);
  var full = await call("GET", "/api/state");
  check("both slots are now held", full.body.taken === 2, full.body);

  // A third wallet arrives to a full board.
  var third = generateKeyPairSync("ed25519");
  var thirdAddr = encodeBase58(third.publicKey.export({ format: "der", type: "spki" }).subarray(12));
  var n4 = await call("POST", "/api/session/nonce", { pubkey: thirdAddr });
  var sig4 = encodeBase58(edSign(null, Buffer.from(n4.body.message, "utf8"), third.privateKey));
  await call("POST", "/api/session/verify", { pubkey: thirdAddr, signature: sig4, nonce: n4.body.nonce, issuedAt: n4.body.issuedAt });
  var o4 = await call("POST", "/api/orders", { name: "Too Late", email: "c@example.com" });
  check("a third wallet is turned away", o4.status === 409 && o4.body.error === "SOLD_OUT", o4.body);
  cookie = keep;

  console.log("\nadmin");
  cookie = "";
  check("no session, no ledger", (await call("GET", "/api/admin/orders")).status === 401);
  check("no session, no events", (await call("GET", "/api/admin/events")).status === 401);
  check("no session, no collect", (await call("POST", "/api/admin/collect", { code: "ZZZZ-ZZZZ" })).status === 401);

  /* A signed-in buyer is still not an admin — the session alone is not enough. */
  cookie = keep;
  var asBuyer = await call("GET", "/api/admin/orders");
  check("a buyer's own session cannot open the ledger", asBuyer.status === 403 && asBuyer.body.error === "NOT_ADMIN", asBuyer.body);
  check("nor read the events", (await call("GET", "/api/admin/events")).status === 403);
  check("nor hand a piece over", (await call("POST", "/api/admin/collect", { code: "ZZZZ-ZZZZ" })).status === 403);

  // Sign in as the admin wallet.
  cookie = "";
  var an = await call("POST", "/api/session/nonce", { pubkey: ADMIN_ADDRESS });
  var asig = encodeBase58(edSign(null, Buffer.from(an.body.message, "utf8"), adminKp.privateKey));
  var av = await call("POST", "/api/session/verify", { pubkey: ADMIN_ADDRESS, signature: asig, nonce: an.body.nonce, issuedAt: an.body.issuedAt });
  check("sign-in reports the wallet as admin", av.body.isAdmin === true, av.body);

  var ad = await call("GET", "/api/admin/orders");
  check("the admin wallet lists every order", ad.status === 200 && ad.body.orders.length === 2,
    ad.body && ad.body.orders && ad.body.orders.map(function (o) { return o.name + ":" + o.status; }));
  check("collect refuses an unpaid order",
    (await call("POST", "/api/admin/collect", { id: o1.body.order.id })).status === 409);

  console.log("\npass");
  // An order is reachable two ways only: the wallet that paid, or the ledger.
  check("no lookup by code", (await call("GET", "/api/pass/ZZZZ-ZZZZ")).status === 404);
  check("no pickup code in any URL", (await fetch(BASE + "/api/pass/ZZZZ-ZZZZ/qr.svg")).status === 404);

  console.log("\npages and static");
  var idx = await fetch(BASE + "/");
  check("serves the landing page", idx.status === 200 && (await idx.text()).includes("Breakpoint Kimono"));
  check("serves the admin page", (await fetch(BASE + "/admin")).status === 200);
  check("no public pass page", (await fetch(BASE + "/pass")).status === 404);
  var vend = await fetch(BASE + "/vendor/solana-web3-1.99.0.min.js", { method: "HEAD" });
  check("serves the vendored web3 bundle", vend.status === 200);
  check("with an immutable cache header", /immutable/.test(vend.headers.get("cache-control") || ""), vend.headers.get("cache-control"));
  var esc = await fetch(BASE + "/../server/.env");
  check("refuses to walk out of site/", esc.status === 404, esc.status);
  var esc2 = await fetch(BASE + "/%2e%2e%2f%2e%2e%2fserver/.env");
  check("refuses an encoded traversal", esc2.status === 404, esc2.status);
  check("unknown api path is a 404", (await call("GET", "/api/nope")).status === 404);

  console.log("\n" + pass + " passed, " + fail + " failed");
} catch (e) {
  console.error("\nTEST ERROR", e);
  console.error(serverLog.slice(-3000));
  fail++;
} finally {
  child.kill("SIGTERM");
}
process.exit(fail ? 1 : 0);
