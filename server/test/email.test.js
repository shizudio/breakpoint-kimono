/* The buyer's confirmation email, against a stand-in Resend.

   The thing worth testing here is not that a template renders. It is the three
   ways this can go wrong quietly: a second copy of the same pass landing in a
   buyer's inbox because they reloaded the confirm step; the QR in the email
   encoding something other than the QR on screen, which only shows up at the
   counter; and a provider outage taking a sale down with it. So: a local
   endpoint that records what was sent, and assertions on what actually goes
   out — payload, attachment and all. */

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

var PORT = 4396, MAIL_PORT = 4395, BASE = "http://127.0.0.1:" + PORT;
var MAIL_API = "http://127.0.0.1:" + MAIL_PORT;
var adminKp = generateKeyPairSync("ed25519");
var ADMIN = encodeBase58(adminKp.publicKey.export({ format: "der", type: "spki" }).subarray(12));

var FROM = "Shizudio <kimono@example.test>";
/* A real-length address, because the thing being checked is that a 44-character
   wallet gets shortened — a six-character stand-in would pass by accident. */
var BUYER_WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
var BCC = "ledger@example.test";

/* A Resend that records instead of delivering. `fail` makes it answer 422 the
   way the real one does for an unverified sending domain — the failure this is
   most likely to meet in production. */
var sent = [], mailFail = false;
var mail = createServer(function (req, res) {
  var body = "";
  req.on("data", function (c) { body += c; });
  req.on("end", function () {
    if (req.headers.authorization !== "Bearer test-key") {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end('{"message":"API key is invalid"}');
    }
    if (mailFail) {
      res.writeHead(422, { "content-type": "application/json" });
      return res.end('{"message":"The example.test domain is not verified"}');
    }
    try { sent.push(JSON.parse(body)); } catch (e) { sent.push({ raw: body }); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"id":"re_' + sent.length + '"}');
  });
});
await new Promise(function (r) { mail.listen(MAIL_PORT, r); });

var pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (detail !== undefined ? "  <- " + JSON.stringify(detail) : "")); }
}
var sleep = ms => new Promise(r => setTimeout(r, ms));
var last = function () { return sent.length ? sent[sent.length - 1] : {}; };

/* ---------- in process: what sendConfirmation itself does ---------- */

process.env.DB_PATH = "../data/test/email.db";
process.env.ADMIN_WALLETS = ADMIN;
process.env.PUBLIC_ORIGIN = BASE;
process.env.SESSION_SECRET = "s".repeat(64);
process.env.RESEND_API = MAIL_API;
process.env.RESEND_API_KEY = "test-key";
process.env.EMAIL_FROM = FROM;
process.env.EMAIL_REPLY_TO = "shina@example.test";
process.env.EMAIL_BCC = BCC;

var store = await import("../src/db.js");
var { sendConfirmation } = await import("../src/email.js");
var { pickupTarget } = await import("../src/qr.js");

var pending = store.createPendingOrder({
  wallet: BUYER_WALLET, name: "Shina Foo", email: "buyer@example.test",
  x: "shizudio", tg: null, reference: "Rmail"
});
var order = store.markPaid(pending.id, encodeBase58(randomBytes(64)));

console.log("\nthe confirmation");
var first = await sendConfirmation(order);
check("it goes out on a paid order", first.ok === true, first);
check("one email was sent", sent.length === 1, sent.length);

var m = last();
check("to the address in the ledger", JSON.stringify(m.to) === '["buyer@example.test"]', m.to);
check("from the configured sender", m.from === FROM, m.from);
check("with a reply-to a person reads", m.reply_to === "shina@example.test", m.reply_to);
check("and a copy to the house address", JSON.stringify(m.bcc) === '["' + BCC + '"]', m.bcc);
check("the subject names the piece", /Piece 1 of 15/.test(String(m.subject)), m.subject);
check("and says what to do with it", /keep this to claim it/i.test(String(m.subject)), m.subject);
check("the pickup code is in the html", String(m.html).indexOf(order.pickup_code) !== -1);
/* Some people read mail as plain text, and a pass they cannot see is no pass. */
check("and in the plain-text part too", String(m.text).indexOf(order.pickup_code) !== -1);
check("the buyer is greeted by first name", /Shina\b/.test(String(m.html)) && !/Shina Foo/.test(String(m.html)));
/* The email has to read as the same object as the panel, not as a receipt
   from a different company. These are the panel's own pieces. */
check("it is the panel's black, not a light email", /background:#000000/.test(String(m.html)));
check("it carries the order card frame", /Your order card/.test(String(m.html)));
check("naming the buyer and the piece on it", /@shizudio · piece 1 of 15/.test(String(m.html)), "card-meta");
check("the accent is the site's purple", /#9945FF/.test(String(m.html)));
check("the code is set in the panel's mono", /ui-monospace/.test(String(m.html)));
check("it thanks them as an early owner", /one of the first to own/.test(String(m.text)), String(m.text).slice(0, 200));
check("it says the venue is still to come", /update you on the\s+claiming venue soon/.test(String(m.text)));
check("and how to get a refund", /@shizudio on X or @shina_foo on Telegram/.test(String(m.text)));
check("it warns the code is a bearer token", /Keep this like a ticket/.test(String(m.html)));
/* The wallet is 44 characters of noise in a confirmation, and printing it in
   full puts the buyer's whole address in an inbox for no benefit. */
/* The panel shows "Confirmation to" and "Paid" and no wallet, so neither does
   this — a buyer's whole address in an inbox buys nothing. */
check("the wallet is not in the email at all", String(m.html).indexOf(BUYER_WALLET) === -1 &&
  String(m.html).indexOf(BUYER_WALLET.slice(0, 8)) === -1);

console.log("\nwhat it attaches");
var att = (m.attachments || []).filter(function (a) { return a.content_id === "pickup-qr"; })[0] || {};
var card = (m.attachments || []).filter(function (a) { return a.content_id === "order-card"; })[0] || {};
var png = Buffer.from(String(att.content || ""), "base64");
check("the QR and the order card both ride along", (m.attachments || []).length === 2, (m.attachments || []).length);
/* Attached, not linked: the front end is a different origin in the split
   deployment, and a client that blocks remote images would leave a hole where
   the card is. */
check("the card is a JPEG", Buffer.from(String(card.content || ""), "base64").slice(6, 10).toString().indexOf("JF") !== -1 ||
  String(card.content_type) === "image/jpeg", card.content_type);
check("the html references it inline", /src="cid:order-card"/.test(String(m.html)));
check("no remote image the buyer's client can block", !/<img[^>]+src="https?:/.test(String(m.html)));
check("it is a PNG", png.slice(1, 4).toString() === "PNG", png.slice(0, 8).toString("hex"));
check("big enough to scan off a screen", png.length > 1000, png.length);
check("named for the piece", att.filename === "claim-piece-1.png", att.filename);
/* Inline, so it shows in the body — and still an attachment, so a client that
   blocks inline images leaves the buyer something to save. */
check("inline, under the id the html references", att.content_id === "pickup-qr", att.content_id);
check("the html references it", /src="cid:pickup-qr"/.test(String(m.html)));
/* The one that only fails at the counter: the email's QR and the panel's QR
   must encode the same string. Both build it here. */
check("the pass points at the admin fragment",
  pickupTarget(order) === BASE + "/admin#c=" + order.pickup_code, pickupTarget(order));
check("and the code is in the fragment, never the path",
  pickupTarget(order).split("#")[0].indexOf(order.pickup_code) === -1);

console.log("\nasked to send it twice");
var second = await sendConfirmation(order);
check("the second send is refused", second.ok === false && second.reason === "ALREADY_SENT", second);
check("and nothing more went out", sent.length === 1, sent.length);
check("the ledger records the send", store.hasEvent(order.id, "email.sent"));

console.log("\nan order nobody paid for");
var unpaid = store.createPendingOrder({
  wallet: "Wunpaid", name: "Nobody", email: "nobody@example.test", x: null, tg: null, reference: "Runpaid"
});
var no = await sendConfirmation(unpaid);
check("gets no pass", no.ok === false && no.reason === "NOT_PAID", no);
check("and sends nothing", sent.length === 1, sent.length);

console.log("\nwhen the provider refuses");
mailFail = true;
var broke = await sendConfirmation(order, { force: true });
check("it reports the failure rather than throwing", broke.ok === false && broke.reason === "SEND_FAILED", broke);
check("the reason is kept", /not verified/.test(String(broke.detail)), broke.detail);
check("and it lands in the order's event trail", store.hasEvent(order.id, "email.failed"));
mailFail = false;

store.db.close();

/* ---------- over the wire: the counter's resend button ---------- */

var child = spawn(process.execPath, ["--env-file=.env", "src/index.js"], {
  cwd: resolve(here, ".."),
  env: Object.assign({}, process.env, {
    PORT: String(PORT), DB_PATH: "../data/test/email.db", ADMIN_WALLETS: ADMIN,
    PUBLIC_ORIGIN: BASE, SESSION_SECRET: "s".repeat(64), SITE_DIR: "",
    TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "",
    RESEND_API: MAIL_API, RESEND_API_KEY: "test-key",
    EMAIL_FROM: FROM, EMAIL_REPLY_TO: "shina@example.test", EMAIL_BCC: BCC
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

  console.log("\nthe server says so");
  var health = await call("GET", "/api/health");
  check("health reports email is on", health.body && health.body.email === true, health.body);

  console.log("\nresending from the counter");
  var n = await call("POST", "/api/session/nonce", { pubkey: ADMIN });
  var sig = encodeBase58(edSign(null, Buffer.from(n.body.message, "utf8"), adminKp.privateKey));
  var v = await call("POST", "/api/session/verify", {
    pubkey: ADMIN, signature: sig, nonce: n.body.nonce, issuedAt: n.body.issuedAt
  });
  check("the admin wallet is recognised", v.body.isAdmin === true);

  var listed = await call("GET", "/api/admin/orders");
  var row = listed.body.orders.filter(function (r) { return r.id === order.id; })[0];
  /* The counter's first question about a buyer with an empty phone. */
  check("the ledger says whether the pass was emailed", row && row.emailed === true, row && row.emailed);

  var before = sent.length;
  var rs = await call("POST", "/api/admin/email", { id: order.id });
  check("the resend is accepted", rs.status === 200, rs.body);
  check("it says where it went", rs.body && rs.body.to === "buyer@example.test", rs.body);
  check("and one more email went out", sent.length === before + 1, sent.length - before);
  check("carrying the same code", String(last().html).indexOf(order.pickup_code) !== -1);

  console.log("\nresending what was never paid for");
  var bad = await call("POST", "/api/admin/email", { id: unpaid.id });
  check("is refused", bad.status === 409, bad.status);

  console.log("\nresending without an admin wallet");
  cookie = "";
  var anon = await call("POST", "/api/admin/email", { id: order.id });
  check("is refused too", anon.status === 401 || anon.status === 403, anon.status);
  check("and the pickup code is not in the refusal", JSON.stringify(anon.body).indexOf(order.pickup_code) === -1);

  console.log("\n" + pass + " passed, " + fail + " failed");
} catch (e) {
  console.error("\nTEST ERROR", e);
  console.error(log.slice(-2000));
  fail++;
} finally {
  child.kill("SIGTERM");
  mail.close();
}
process.exit(fail ? 1 : 0);
