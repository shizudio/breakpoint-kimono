/* Measures the confirmation panel in a real browser.

   jsdom has no layout, so "does this need scrolling" cannot be answered there —
   and that was the complaint. This drives Chrome against the running dev
   server: sign in with a real key, take an order all the way to paid, then open
   the panel at the sizes people actually use and report its height.

   Two things this script learned the hard way. #orderForm lives in the DOM at
   all times, hidden in #formHolder, so waiting on that selector proves nothing —
   wait on the panel's text. And cookies are shared across pages in one browser,
   so after the first sign-in every later page is already signed in; that is
   used deliberately below rather than fought. */

import puppeteer from "puppeteer-core";
import { generateKeyPairSync, sign as edSign, randomBytes } from "node:crypto";
import { encodeBase58 } from "../src/base58.js";

var BASE = process.env.MEASURE_URL || "http://localhost:5173";
var CHROME = process.env.CHROME || "/usr/bin/google-chrome";

var kp = generateKeyPairSync("ed25519");
var address = encodeBase58(kp.publicKey.export({ format: "der", type: "spki" }).subarray(12));

var WALLET = `
  window.phantom = { solana: {
    isPhantom: true,
    connect: async () => ({ publicKey: { toString: () => ${JSON.stringify(address)} } }),
    signMessage: async (bytes) => ({ signature: Uint8Array.from(await window.__sign(Array.from(bytes))) }),
    disconnect: async () => {}
  }};
`;

var browser = await puppeteer.launch({
  executablePath: CHROME, headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"]
});

async function open(w, h) {
  var page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 2 });
  await page.exposeFunction("__sign", function (bytes) {
    return Array.from(edSign(null, Buffer.from(bytes), kp.privateKey));
  });
  await page.evaluateOnNewDocument(WALLET);
  await page.goto(BASE, { waitUntil: "networkidle2", timeout: 30000 });
  // The hero locks the page until the turntable finishes; nothing here needs it.
  await page.evaluate(function () {
    var l = document.querySelector("#loader"); if (l) l.remove();
    document.documentElement.style.overflow = ""; document.body.style.overflow = "";
  });
  return page;
}
var panelText = function (page) {
  return page.evaluate(function () {
    var p = document.querySelector("#modal .panel");
    return p ? p.textContent.replace(/\s+/g, " ") : "";
  });
};
var untilPanel = function (page, re, ms) {
  return page.waitForFunction(function (src) {
    var p = document.querySelector("#modal .panel");
    return !!p && new RegExp(src).test(p.textContent);
  }, { timeout: ms || 20000 }, re.source);
};

/* --- once: sign in and get a paid order on the board --- */
var setup = await open(1440, 900);
await setup.click(".cta");
await untilPanel(setup, /Connect a wallet/);
await setup.evaluate(function () {
  Array.from(document.querySelectorAll(".wallet-btn"))
    .find(function (b) { return /Phantom/.test(b.textContent); }).click();
});
await untilPanel(setup, /Your details/);

var orderId = await setup.evaluate(async function () {
  var r = await fetch("/api/orders", {
    method: "POST", credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Shina Foo", email: "shina@example.com", x: "shizudio" })
  });
  var b = await r.json();
  return b.order ? b.order.id : "ERR " + JSON.stringify(b).slice(0, 140);
});
if (String(orderId).startsWith("ERR")) {
  console.log("could not reserve: " + orderId);
  await browser.close(); process.exit(1);
}
await setup.close();

/* This script has to write to whatever ledger the running server uses — it is
   measuring the real page against the real API. That makes it the one tool here
   that can put rows in front of a buyer, so it does two things about it: it
   refuses to run against a ledger that already holds a paid order, and it
   deletes its own row on the way out, whatever happens.

   It did not always. An earlier version defaulted to ../data/orders.db and left
   six fabricated orders in it, which is how this paragraph came to be written. */
process.env.DB_PATH = process.env.MEASURE_DB || "../data/orders.db";
var store = await import("../src/db.js");

if (store.paidCount() > 0 && process.env.MEASURE_FORCE !== "1") {
  console.log("\nrefusing to run: the ledger already holds " + store.paidCount() + " paid order(s).");
  console.log("This writes a fabricated order to measure the panel, and it would sit among real ones.");
  console.log("Use a scratch ledger — start the server with DB_PATH=../data/test/measure.db and run");
  console.log("this with MEASURE_DB=../data/test/measure.db — or set MEASURE_FORCE=1 if you are sure.");
  store.db.close();
  await browser.close();
  process.exit(1);
}

var order = store.getOrder(orderId);
// Unique per run: tx_signature is unique in the ledger, which is the point.
if (order.status !== "paid") order = store.markPaid(order.id, encodeBase58(randomBytes(64)));
console.log("\nseeded piece " + order.piece_no + ", code " + order.pickup_code + "  (removed at the end)");

/* Nothing this script invents should outlive it — including when a measurement
   throws, which is exactly when it is tempting to leave the mess behind. */
var cleanedUp = false;
function removeSeeded() {
  if (cleanedUp) return;
  cleanedUp = true;
  try {
    store.db.exec("BEGIN IMMEDIATE");
    store.db.prepare("DELETE FROM orders WHERE id = ?").run(orderId);
    store.db.exec("COMMIT");
    console.log("\nremoved the seeded order (" + orderId + ")");
  } catch (e) {
    console.log("\nCOULD NOT REMOVE the seeded order " + orderId + ": " + e.message);
    console.log("Delete it by hand before anyone sees the ledger.");
  }
  try { store.db.close(); } catch (e) {}
}
process.on("SIGINT", function () { removeSeeded(); process.exit(130); });

/* --- measure --- */
var sizes = [
  { name: "macbook air 1440x900", w: 1440, h: 900 },
  { name: "macbook 13 1512x832", w: 1512, h: 832 },
  { name: "laptop 1280x800", w: 1280, h: 800 },
  { name: "small laptop 1366x768", w: 1366, h: 768 },
  { name: "iphone 390x844", w: 390, h: 844 },
  { name: "iphone se 375x667", w: 375, h: 667 }
];

console.log("\nconfirmation panel, measured in Chrome\n");
var worst = 0, worstAt = "";
try {
for (var size of sizes) {
  var page = await open(size.w, size.h);
  // The session cookie is already set, so Reserve goes straight to the pass.
  await page.click(".cta");
  await untilPanel(page, /is yours/);
  await new Promise(function (r) { setTimeout(r, 450); });   // let the card image lay out

  var m = await page.evaluate(function () {
    var p = document.querySelector("#modal .panel");
    return { content: p.scrollHeight, visible: p.clientHeight, viewport: window.innerHeight };
  });
  var over = Math.max(0, m.content - m.visible);
  if (over > worst) { worst = over; worstAt = size.name; }
  console.log("  " + size.name.padEnd(22) +
    "content " + String(m.content).padStart(4) + "px   fits " + String(m.visible).padStart(4) + "px   " +
    (over ? "SCROLLS by " + over + "px" : "no scroll"));

  if (process.env.SHOT && size.w === 1440) await page.screenshot({ path: process.env.SHOT });
  if (process.env.SHOT_SM && size.w === 390) await page.screenshot({ path: process.env.SHOT_SM });
  await page.close();
}
} finally {
  removeSeeded();
  await browser.close();
}
console.log(worst ? "\nworst overflow " + worst + "px at " + worstAt : "\nfits without scrolling at every size");
