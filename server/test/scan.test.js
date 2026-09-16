/* The ledger's camera scanner, against a real camera.

   Chrome will play a file in place of a webcam, so the QR a buyer would hold up
   is rendered into a video and pointed at the page. That makes this an honest
   test of the whole path: getUserMedia, the decoder, reading the code out of
   the fragment, and filtering the ledger down to one row.

   The video is written here rather than shelled out to ffmpeg, which is not on
   every machine. Y4M is uncompressed and trivial, and `qrcode` hands back the
   module matrix directly, so no image decoding is needed either. */

import puppeteer from "puppeteer-core";
import QRCode from "qrcode";
import { spawn } from "node:child_process";
import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { generateKeyPairSync, sign as edSign, randomBytes } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeBase58 } from "../src/base58.js";

var here = dirname(fileURLToPath(import.meta.url));
var root = resolve(here, "../..");
var tmp = resolve(root, "data/test");
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

var CHROME = process.env.CHROME || "/usr/bin/google-chrome";
var PORT = 4396, BASE = "http://127.0.0.1:" + PORT;

var adminKp = generateKeyPairSync("ed25519");
var ADMIN = encodeBase58(adminKp.publicKey.export({ format: "der", type: "spki" }).subarray(12));

/* ---------- a QR, as a webcam would see it ---------- */

function y4m(text, opts) {
  var W = (opts && opts.width) || 640, H = (opts && opts.height) || 480, FRAMES = 8;
  var qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  var n = qr.modules.size, bits = qr.modules.data;

  // Scale to about two thirds of the frame, on a white field with a quiet zone.
  var scale = Math.floor(Math.min(W, H) * 0.66 / n);
  var side = scale * n;
  var x0 = Math.floor((W - side) / 2), y0 = Math.floor((H - side) / 2);

  var Y = Buffer.alloc(W * H, 235);            // white
  for (var my = 0; my < n; my++) {
    for (var mx = 0; mx < n; mx++) {
      if (!bits[my * n + mx]) continue;        // 1 = dark module
      for (var dy = 0; dy < scale; dy++) {
        var row = (y0 + my * scale + dy) * W + x0 + mx * scale;
        Y.fill(16, row, row + scale);          // black
      }
    }
  }
  var U = Buffer.alloc((W / 2) * (H / 2), 128), V = Buffer.alloc((W / 2) * (H / 2), 128);

  var parts = [Buffer.from("YUV4MPEG2 W" + W + " H" + H + " F15:1 Ip A1:1 C420\n")];
  for (var f = 0; f < FRAMES; f++) parts.push(Buffer.from("FRAME\n"), Y, U, V);
  return Buffer.concat(parts);
}

var pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (detail !== undefined ? "  <- " + JSON.stringify(detail) : "")); }
}
var sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- a paid order to scan ---------- */

process.env.DB_PATH = "../data/test/scan.db";
process.env.ADMIN_WALLETS = ADMIN;
process.env.PUBLIC_ORIGIN = BASE;
var store = await import("../src/db.js");
var pending = store.createPendingOrder({
  wallet: "So11111111111111111111111111111111111111112",
  name: "Shina Foo", email: "shina@example.com", x: "shizudio", tg: null,
  reference: "ReF00000000000000000000000000000000000000001"
});
var paid = store.markPaid(pending.id, encodeBase58(randomBytes(64)));
// A second order, so "filtered to one row" means something.
var other = store.createPendingOrder({
  wallet: "So11111111111111111111111111111111111111113",
  name: "Someone Else", email: "else@example.com", x: "someone", tg: null,
  reference: "ReF00000000000000000000000000000000000000002"
});
store.markPaid(other.id, encodeBase58(randomBytes(64)));
store.db.close();

var QR_TARGET = BASE + "/admin#c=" + paid.pickup_code;
var videoPath = join(tmp, "qr.y4m");
writeFileSync(videoPath, y4m(QR_TARGET));

var child = spawn(process.execPath, ["--env-file=.env", "src/index.js"], {
  cwd: resolve(here, ".."),
  env: Object.assign({}, process.env, {
    PORT: String(PORT), DB_PATH: "../data/test/scan.db", ADMIN_WALLETS: ADMIN,
    PUBLIC_ORIGIN: BASE, SESSION_SECRET: "s".repeat(64),
    TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "", SITE_DIR: ""
  }),
  stdio: ["ignore", "pipe", "pipe"]
});
var log = ""; child.stdout.on("data", d => log += d); child.stderr.on("data", d => log += d);

var browser;
try {
  for (var i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + "/api/state")).ok) break; } catch (e) {}
    await sleep(250);
  }

  console.log("\nthe QR the buyer shows");
  check("encodes this page with the code in the fragment", /#c=/.test(QR_TARGET), QR_TARGET);
  check("the code is not in the path or the query", QR_TARGET.split("#")[0].indexOf(paid.pickup_code) === -1);

  browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: [
      "--no-sandbox", "--disable-dev-shm-usage",
      "--use-fake-ui-for-media-stream",              // grant the camera without a prompt
      "--use-fake-device-for-media-stream",
      "--use-file-for-fake-video-capture=" + videoPath
    ]
  });
  var page = await browser.newPage();
  await page.setViewport({ width: 420, height: 860, deviceScaleFactor: 2 });
  page.on("console", function (m) { if (m.type() === "error") log += "\n[page] " + m.text(); });
  await page.goto(BASE + "/admin", { waitUntil: "networkidle2", timeout: 30000 });

  console.log("\nsigning in");
  // A wallet for the ledger, installed before the page's own script runs.
  await page.evaluate(function (addr) { window.__addr = addr; }, ADMIN);
  await page.exposeFunction("__sign", function (bytes) {
    return Array.from(edSign(null, Buffer.from(bytes), adminKp.privateKey));
  });
  await page.evaluate(function () {
    window.phantom = { solana: {
      isPhantom: true,
      connect: async () => ({ publicKey: { toString: () => window.__addr } }),
      signMessage: async (b) => ({ signature: Uint8Array.from(await window.__sign(Array.from(b))) }),
      disconnect: async () => {}
    }};
  });
  await page.click("#enter");
  try {
    await page.waitForFunction(function () {
      return !document.querySelector("#app").hidden;
    }, { timeout: 20000 });
  } catch (e) {
    var why = await page.evaluate(function () {
      return {
        gateErr: document.querySelector("#gateErr").textContent,
        hasProvider: !!(window.phantom && window.phantom.solana),
        hasSign: typeof window.__sign,
        addr: window.__addr
      };
    });
    console.log("  sign-in did not complete:", JSON.stringify(why));
    throw e;
  }
  check("the ledger opens for an admin wallet", true);
  check("two paid orders are listed",
    (await page.$$eval("#list .row", function (n) { return n.length; })) === 2);

  console.log("\nthe wallet is on every row");
  /* Without this on screen there is no way to tell four rows apart as four
     people, rather than one person who pressed Reserve four times. */
  var wallets = await page.$$eval("#list .wallet", function (n) {
    return n.map(function (x) { return { shown: x.textContent, full: x.getAttribute("title") }; });
  });
  check("every row shows one", wallets.length === 2, wallets.length);
  check("abbreviated, not 44 characters", wallets.every(function (w) { return w.shown.length < 14; }), wallets);
  check("with the full address kept for a hover", wallets.every(function (w) { return w.full && w.full.length > 30; }), wallets);
  check("and they differ, so two rows read as two buyers",
    wallets[0].full !== wallets[1].full, wallets);

  console.log("\ncodes start masked");
  var listed = await page.$eval("#list", function (n) { return n.textContent; });
  check("no code is on screen", listed.indexOf(paid.pickup_code) === -1);
  check("they are shown as dots", /••••-••••/.test(listed));

  console.log("\nscanning");
  check("there is a scan button", !!(await page.$("#scanBtn")));
  await page.click("#scanBtn");
  check("the scanner opens", !(await page.$eval("#scanner", function (n) { return n.hidden; })));

  // The decoder is 251KB and fetched on first use; the camera needs a moment.
  await page.waitForFunction(function (code) {
    return document.querySelector("#find").value === code;
  }, { timeout: 30000 }, paid.pickup_code);
  check("the code was read off the camera", true);
  check("and the scanner closed itself", await page.$eval("#scanner", function (n) { return n.hidden; }));

  console.log("\nwhat the scan left on screen");
  var hit = await page.$eval("#hit", function (n) { return n.textContent.replace(/\s+/g, " "); });
  check("filtered to the right buyer", /Shina Foo/.test(hit), hit.slice(0, 120));
  check("the other order is not shown", !/Someone Else/.test(hit));
  check("with a Hand over button ready", !!(await page.$("#hit .act")));
  /* Handing over is a decision made looking at the person, not something a
     scan does on its own. */
  check("nothing was handed over by scanning alone",
    !(await page.$eval("#hit", function (n) { return /collected/.test(n.textContent); })));

  console.log("\nhanding it over");
  /* No browser dialog to accept any more — the page has its own, which can show
     the piece number and the name. If a window.confirm ever comes back, this
     listener fails the run rather than silently accepting it. */
  page.on("dialog", async function (d) {
    fail++; console.log("  FAIL a browser dialog appeared: " + d.message());
    await d.dismiss();
  });
  /* Read the tile by its own label rather than by scanning the whole string —
     "2 / 15" contains a 1, so a looser test passed before the reload had even
     happened and proved nothing. */
  function collectedCount() {
    return page.evaluate(function () {
      var tile = Array.from(document.querySelectorAll("#counts > div"))
        .find(function (d) { return d.querySelector(".l").textContent === "collected"; });
      return tile ? Number(tile.querySelector(".n").textContent) : null;
    });
  }
  check("nothing is collected before the click", (await collectedCount()) === 0);
  await page.click("#hit .act");

  await page.waitForFunction(function () {
    return !document.querySelector("#confirm").hidden;
  }, { timeout: 10000 });
  var dialog = await page.$eval("#confirm", function (n) { return n.textContent.replace(/\s+/g, " "); });
  check("the page's own dialog opens", true);
  check("it shows the piece number", /Release this piece\? 1 /.test(dialog), dialog.slice(0, 120));
  check("it shows the name to check against", /Shina Foo/.test(dialog));
  check("and says it cannot be undone", /cannot be undone/.test(dialog));

  // Cancelling must leave the piece alone.
  await page.click("#confirmNo");
  await page.waitForFunction(function () { return document.querySelector("#confirm").hidden; }, { timeout: 5000 });
  check("cancelling collects nothing", (await collectedCount()) === 0);
  check("and the row is still actionable", !(await page.$eval("#hit .act", function (n) { return n.disabled; })));

  await page.click("#hit .act");
  await page.waitForFunction(function () { return !document.querySelector("#confirm").hidden; }, { timeout: 10000 });
  await page.click("#confirmYes");
  await page.waitForFunction(function () {
    var tile = Array.from(document.querySelectorAll("#counts > div"))
      .find(function (d) { return d.querySelector(".l").textContent === "collected"; });
    return tile && tile.querySelector(".n").textContent === "1";
  }, { timeout: 20000 });
  check("the ledger counts one collected", (await collectedCount()) === 1);
  check("and one still to hand over", await page.evaluate(function () {
    var tile = Array.from(document.querySelectorAll("#counts > div"))
      .find(function (d) { return d.querySelector(".l").textContent === "to hand over"; });
    return tile && tile.querySelector(".n").textContent === "1";
  }));

  process.env.DB_PATH = "../data/test/scan.db";
  var store2 = await import("../src/db.js?after");
  var row = store2.getOrderByPickupCode(paid.pickup_code);
  check("against the wallet that scanned", row.collected_by === ADMIN, row.collected_by);
  store2.db.close();

  console.log("\n" + pass + " passed, " + fail + " failed");
} catch (e) {
  console.error("\nTEST ERROR", e);
  console.error(log.slice(-2500));
  fail++;
} finally {
  if (browser) await browser.close();
  child.kill("SIGTERM");
}
process.exit(fail ? 1 : 0);
