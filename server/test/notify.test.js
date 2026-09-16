/* The Telegram notifications, against a stand-in Telegram.

   These had never been exercised: every other suite runs with the bot token
   blank, so `send()` returned early and the messages were only ever read by
   eye. This starts a local endpoint, points the server at it, and asserts what
   actually goes out — and, for the one that must never block a buyer, what
   happens when it fails. */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { rmSync, mkdirSync } from "node:fs";
import { generateKeyPairSync, sign as edSign, randomBytes } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeBase58 } from "../src/base58.js";

var here = dirname(fileURLToPath(import.meta.url));
var root = resolve(here, "../..");
rmSync(resolve(root, "data/test"), { recursive: true, force: true });
mkdirSync(resolve(root, "data/test"), { recursive: true });

var PORT = 4394, TG_PORT = 4393, BASE = "http://127.0.0.1:" + PORT;
var adminKp = generateKeyPairSync("ed25519");
var ADMIN = encodeBase58(adminKp.publicKey.export({ format: "der", type: "spki" }).subarray(12));

/* A Telegram that records instead of delivering. `fail` makes it answer 500, to
   check that a sale still completes when the bot is down. */
var sent = [], tgFail = false;
var telegram = createServer(function (req, res) {
  var body = "";
  req.on("data", function (c) { body += c; });
  req.on("end", function () {
    if (tgFail) { res.writeHead(500, { "content-type": "application/json" }); return res.end('{"ok":false,"description":"chat not found"}'); }
    try { sent.push(JSON.parse(body)); } catch (e) { sent.push({ raw: body }); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
});
await new Promise(function (r) { telegram.listen(TG_PORT, r); });

var pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (detail !== undefined ? "  <- " + JSON.stringify(detail) : "")); }
}
var sleep = ms => new Promise(r => setTimeout(r, ms));
var lastText = function () { return sent.length ? String(sent[sent.length - 1].text || "") : ""; };
async function settle() { await sleep(400); }        // notifications are fire-and-forget

// Seed two paid orders to hand over.
process.env.DB_PATH = "../data/test/notify.db";
process.env.ADMIN_WALLETS = ADMIN;
/* Before the first import of anything under src/: config.js reads the
   environment once, at module load, so a token set later leaves telegram.js
   disabled and every in-process send silently returns false. */
process.env.TELEGRAM_API = "http://127.0.0.1:" + TG_PORT;
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHAT_ID = "12345";
var store = await import("../src/db.js");
var made = [];
for (var i = 0; i < 2; i++) {
  var p = store.createPendingOrder({
    wallet: "W" + i, name: ["Shina Foo", "Gizmo"][i], email: ["shina", "gizmo"][i] + "@example.com",
    x: ["shizudio", "gizmothegizzer"][i], tg: null, reference: "R" + i,
    mark: [true, false][i]
  });
  made.push(store.markPaid(p.id, encodeBase58(randomBytes(64))));
}
store.db.close();

var child = spawn(process.execPath, ["--env-file=.env", "src/index.js"], {
  cwd: resolve(here, ".."),
  env: Object.assign({}, process.env, {
    PORT: String(PORT), DB_PATH: "../data/test/notify.db", ADMIN_WALLETS: ADMIN,
    PUBLIC_ORIGIN: BASE, SESSION_SECRET: "s".repeat(64), SITE_DIR: "",
    TELEGRAM_API: "http://127.0.0.1:" + TG_PORT,
    TELEGRAM_BOT_TOKEN: "test-token", TELEGRAM_CHAT_ID: "12345"
  }),
  stdio: ["ignore", "pipe", "pipe"]
});
var log = ""; child.stdout.on("data", d => log += d); child.stderr.on("data", d => log += d);

var cookie = "";
async function call(method, path, body) {
  var r = await fetch(BASE + path, {
    method: method,
    headers: { "content-type": "application/json", cookie: cookie },
    body: body == null ? undefined : JSON.stringify(body)
  });
  var sc = r.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  return { status: r.status, body: await r.json().catch(() => null) };
}

try {
  for (var i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + "/api/state")).ok) break; } catch (e) {}
    await sleep(250);
  }
  await settle();

  console.log("\non startup");
  check("it says the server is up", /Presale server up/.test(lastText()), lastText().slice(0, 80));
  // Two orders were seeded before the server started, so this is what it must say.
  check("and how much is sold", /2\/15 sold/.test(lastText()), lastText());
  check("and which network", /mainnet|devnet/.test(lastText()));

  console.log("\nsigning in as the counter");
  var n = await call("POST", "/api/session/nonce", { pubkey: ADMIN });
  var sig = encodeBase58(edSign(null, Buffer.from(n.body.message, "utf8"), adminKp.privateKey));
  var v = await call("POST", "/api/session/verify", { pubkey: ADMIN, signature: sig, nonce: n.body.nonce, issuedAt: n.body.issuedAt });
  check("the admin wallet is recognised", v.body.isAdmin === true);

  console.log("\nhanding over the first piece");
  var before = sent.length;
  var c1 = await call("POST", "/api/admin/collect", { code: made[0].pickup_code });
  check("the hand-over is accepted", c1.status === 200, c1.body);
  await settle();
  check("a message went out", sent.length === before + 1, sent.length - before);

  var msg = lastText();
  check("it names the piece", /Piece 1 of 15 handed over/.test(msg), msg);
  check("it names the buyer", /Shina Foo/.test(msg));
  check("and their handle", /@shizudio/.test(msg));
  check("it carries the pickup code", msg.indexOf(made[0].pickup_code) !== -1, msg);
  check("it says which wallet released it", msg.indexOf(ADMIN.slice(0, 4)) !== -1 && msg.indexOf(ADMIN.slice(-4)) !== -1, msg);
  check("the full wallet is not dumped in", msg.indexOf(ADMIN) === -1, msg);
  check("it says how many are left", /1 still to hand over/.test(msg), msg);
  check("it is HTML, as the bot is told to expect", sent[sent.length - 1].parse_mode === "HTML");
  check("to the configured chat", String(sent[sent.length - 1].chat_id) === "12345");

  console.log("\nscanning the same code twice");
  before = sent.length;
  var again = await call("POST", "/api/admin/collect", { code: made[0].pickup_code });
  check("the second scan still succeeds", again.status === 200);
  await settle();
  /* Handing over is idempotent, so a repeat scan is not a second kimono going
     out and must not read like one. */
  check("but sends nothing", sent.length === before, sent.length - before);

  console.log("\nthe last piece");
  before = sent.length;
  await call("POST", "/api/admin/collect", { code: made[1].pickup_code });
  await settle();
  check("a message went out", sent.length === before + 1);
  check("and it says that was the last", /That was the last one/.test(lastText()), lastText());

  console.log("\nwhat the sale message says about the pocket");
var tg = await import("../src/telegram.js");
var beforeMark = sent.length;
await tg.notifyPaid(Object.assign({}, made[0], { mark: 1 }));
check("a mark is called out", /Inner pocket: <b>Solana mark<\/b>/.test(lastText()), lastText());
await tg.notifyPaid(Object.assign({}, made[0], { mark: 0 }));
check("so is declining one", /Inner pocket: <b>no mark<\/b>/.test(lastText()), lastText());
/* An order taken before the question existed must read as a question, not as a
   no — someone has to go and ask before that piece is cut. */
await tg.notifyPaid(Object.assign({}, made[0], { mark: null }));
check("and an unasked order says so", /Inner pocket: <b>not asked<\/b>/.test(lastText()), lastText());
check("three messages went out", sent.length === beforeMark + 3, sent.length - beforeMark);

console.log("\nwhen Telegram is down");
  /* A sale must never wait on a notification, let alone fail with one. */
  tgFail = true;
  var store3 = await import("../src/db.js?reopen");
  var extra = store3.createPendingOrder({
    wallet: "W9", name: "Third", email: "t@example.com", x: null, tg: null, reference: "R9"
  });
  var paid3 = store3.markPaid(extra.id, encodeBase58(randomBytes(64)));
  store3.db.close();
  var c3 = await call("POST", "/api/admin/collect", { code: paid3.pickup_code });
  check("the hand-over still succeeds", c3.status === 200, c3.body);
  await settle();
  await settle();
  /* The send failed; the order must still read as collected, and the failure
     must be in the log and the event trail rather than in the buyer's face. */
  var after = await call("GET", "/api/admin/orders");
  var row = after.body.orders.filter(function (r) { return r.pickupCode === paid3.pickupCode || r.name === "Third"; })[0];
  check("the piece is recorded as collected anyway", !!row && !!row.collectedAt, row && row.collectedAt);
  check("and the failure was logged, not thrown", /telegram/i.test(log), log.slice(-300));
  tgFail = false;

  console.log("\n" + pass + " passed, " + fail + " failed");
} catch (e) {
  console.error("\nTEST ERROR", e);
  console.error(log.slice(-2000));
  fail++;
} finally {
  child.kill("SIGTERM");
  telegram.close();
}
process.exit(fail ? 1 : 0);
