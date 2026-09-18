/* The returning visitor.

   A session outlives a page load: the cookie is good for 72 hours, so someone
   who signed in earlier comes back to a page that knows their address without
   ever having called connect(). Everything that needs the *wallet* rather than
   the session breaks in that state unless it is put back deliberately.

   It did break. Paying did nothing at all — `pay()` began with
   `if (!state.provider) return`, and after a reload there was no provider, so
   the button was dead and silent. This is that regression, pinned. */

import { JSDOM, VirtualConsole } from "jsdom";
import { spawn } from "node:child_process";
import { readFileSync, rmSync, mkdirSync } from "node:fs";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeBase58 } from "../src/base58.js";
import * as web3 from "@solana/web3.js";

var here = dirname(fileURLToPath(import.meta.url));
var root = resolve(here, "../..");
rmSync(resolve(root, "data/test"), { recursive: true, force: true });
mkdirSync(resolve(root, "data/test"), { recursive: true });

var PORT = 4392, BASE = "http://127.0.0.1:" + PORT;
var child = spawn(process.execPath, ["--env-file=.env", "src/index.js"], {
  cwd: resolve(here, ".."),
  env: Object.assign({}, process.env, {
    PORT: String(PORT), DB_PATH: "../data/test/reconnect.db", PUBLIC_ORIGIN: BASE,
    SESSION_SECRET: "s".repeat(64), PRICE_USDC: "300",
    /* These walk the undiscounted flow; the struck price has its own test. */
    LIST_PRICE_USDC: "0", SITE_DIR: "",
    ADMIN_WALLETS: "DWDeu7snxGK9uscdJbtjcQ4oU9cCdpNZPaate6BVqEuD",
    TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: ""
  }),
  stdio: ["ignore", "pipe", "pipe"]
});
var log = ""; child.stdout.on("data", d => log += d); child.stderr.on("data", d => log += d);

var pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (detail !== undefined ? "  <- " + JSON.stringify(detail) : "")); }
}
var sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, label, ms) {
  var until = Date.now() + (ms || 10000);
  while (Date.now() < until) { var v = fn(); if (v) return v; await sleep(50); }
  throw new Error("timed out waiting for " + label);
}

var kp = generateKeyPairSync("ed25519");
var ADDRESS = encodeBase58(kp.publicKey.export({ format: "der", type: "spki" }).subarray(12));
var html = readFileSync(resolve(root, "site/index.html"), "utf8");
var script = html.match(/<script type="module">\n([\s\S]*?)\n<\/script>/)[1]
  .replace(/import\.meta\.env/g, '({ VITE_SERVER_URL: "" })');

/* One cookie jar across both page loads — that is the whole point. The wallet
   remembers its approval the same way a real extension does, so the second load
   can reconnect silently. */
var cookie = "";
var approved = false;

function loadPage(wallet) {
  var vc = new VirtualConsole();
  var errors = [];
  vc.on("jsdomError", function (e) { errors.push(String(e.message)); });
  var dom = new JSDOM(html, { url: BASE + "/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  var win = dom.window;
  win.fetch = function (input, init) {
    init = init || {};
    var headers = Object.assign({}, init.headers || {});
    if (cookie) headers.cookie = cookie;
    return fetch(new URL(String(input), BASE).toString(), Object.assign({}, init, { headers: headers }))
      .then(function (r) {
        var sc = r.headers.get("set-cookie");
        if (sc) cookie = sc.split(";")[0];
        return r;
      });
  };
  win.TextEncoder = TextEncoder;
  win.matchMedia = function (q) { return { matches: false, media: q, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){}, dispatchEvent(){ return false; } }; };
  win.scrollTo = function () {};
  win.solanaWeb3 = web3;
  win.phantom = { solana: wallet };
  win.eval(script);
  return { dom: dom, win: win, doc: win.document, errors: errors };
}

var calls = [];
function phantom() {
  return {
    isPhantom: true,
    connect: function (opts) {
      calls.push("connect" + (opts && opts.onlyIfTrusted ? "(onlyIfTrusted)" : ""));
      if (opts && opts.onlyIfTrusted && !approved) {
        return Promise.reject(Object.assign(new Error("not trusted"), { code: 4001 }));
      }
      approved = true;
      return Promise.resolve({ publicKey: { toString: function () { return ADDRESS; } } });
    },
    signMessage: function (bytes) {
      calls.push("signMessage");
      return Promise.resolve({ signature: edSign(null, Buffer.from(bytes), kp.privateKey) });
    },
    signAndSendTransaction: function () {
      calls.push("signAndSendTransaction");
      return Promise.resolve({ signature: encodeBase58(Buffer.alloc(64, 5)) });
    },
    disconnect: function () { approved = false; calls.push("disconnect"); return Promise.resolve(); }
  };
}

try {
  for (var i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + "/api/state")).ok) break; } catch (e) {}
    await sleep(250);
  }

  /* ---------- first visit: sign in, leave a pending order ---------- */
  console.log("\nfirst visit");
  var a = loadPage(phantom());
  var panelA = function () { return (a.doc.querySelector("#modal .panel").textContent || "").replace(/\s+/g, " "); };
  await waitFor(function () { return a.doc.querySelector("#countNum").textContent === "0"; }, "state");
  a.doc.querySelector(".cta").dispatchEvent(new a.win.MouseEvent("click", { bubbles: true }));
  await waitFor(function () { return /Connect a wallet/.test(panelA()); }, "wallet step");
  Array.prototype.slice.call(a.doc.querySelectorAll(".wallet-btn"))
    .filter(function (b) { return /Phantom/.test(b.textContent); })[0]
    .dispatchEvent(new a.win.MouseEvent("click", { bubbles: true }));
  await waitFor(function () { return /Your details/.test(panelA()); }, "details step");
  check("signing in works", calls.indexOf("signMessage") !== -1, calls);

  var formA = a.doc.querySelector("#orderForm");
  formA.querySelector("#fName").value = "Shina Foo";
  formA.querySelector("#fEmail").value = "shina@example.com";
  formA.querySelector("#fX").value = "shizudio";
  formA.dispatchEvent(new a.win.Event("submit", { bubbles: true, cancelable: true }));
  /* The mark stands between the details and the money now. */
  await waitFor(function () { return /The Solana mark/.test(panelA()); }, "mark step");
  Array.prototype.slice.call(a.doc.querySelectorAll("#modal .panel .choice button"))
    .filter(function (x) { return /^Yes$/.test(x.textContent); })[0]
    .dispatchEvent(new a.win.MouseEvent("click", { bubbles: true }));
  await waitFor(function () { return /Pay 300 USDC/.test(panelA()); }, "pay step");
  check("a piece is held", true);
  a.dom.window.close();

  /* ---------- second visit: same cookie, no connect() in this load ---------- */
  console.log("\nback later, same session");
  calls = [];
  var b2 = loadPage(phantom());
  var panelB = function () { return (b2.doc.querySelector("#modal .panel").textContent || "").replace(/\s+/g, " "); };
  await waitFor(function () { return b2.doc.querySelector("#countNum").textContent === "0"; }, "state");
  await sleep(600);
  check("the session is recognised without signing in again", calls.indexOf("signMessage") === -1, calls);
  check("and the wallet is reattached quietly", calls.indexOf("connect(onlyIfTrusted)") !== -1, calls);

  b2.doc.querySelector(".cta").dispatchEvent(new b2.win.MouseEvent("click", { bubbles: true }));
  await waitFor(function () { return /Your details/.test(panelB()); }, "details step");
  /* It used to render "null · 5U1J…pKqb", because the name only ever got set
     inside connectWallet(). */
  check("the wallet is named, not null", !/null/.test(panelB()), panelB().slice(0, 90));

  /* The piece is already held and the details are already on the server, so
     asking for them again is asking twice for nothing. */
  var formB = b2.doc.querySelector("#orderForm");
  check("the name comes back", formB.querySelector("#fName").value === "Shina Foo", formB.querySelector("#fName").value);
  check("the address comes back", formB.querySelector("#fEmail").value === "shina@example.com", formB.querySelector("#fEmail").value);
  check("and the handle", formB.querySelector("#fX").value === "shizudio", formB.querySelector("#fX").value);
  check("it says where they left off", /Picking up where you left off/.test(panelB()), panelB().slice(-160));
  check("and until when the piece is held", /held until \d/.test(panelB()), panelB().slice(-120));

  /* Prefilling must never fight the person typing. Change a field, force a
     re-render by submitting something invalid, and the edit has to survive. */
  formB.querySelector("#fName").value = "Shina Foo Edited";
  formB.querySelector("#fEmail").value = "";
  formB.dispatchEvent(new b2.win.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(function () { return b2.doc.querySelectorAll("#orderForm .field-row.invalid").length > 0; }, "a validation error");
  check("an edit survives the re-render", formB.querySelector("#fName").value === "Shina Foo Edited", formB.querySelector("#fName").value);
  check("and a deliberately cleared field is not refilled", formB.querySelector("#fEmail").value === "", formB.querySelector("#fEmail").value);

  formB.querySelector("#fEmail").value = "shina@example.com";
  formB.dispatchEvent(new b2.win.Event("submit", { bubbles: true, cancelable: true }));

  /* This load never ran connectWallet, so nothing in the page remembers the
     answer — it has to come off the order. Asking again from blank is how a
     manufacturing instruction gets flipped by a stray click, and
     reusePendingOrder would write the new answer without a murmur. */
  await waitFor(function () { return /The Solana mark/.test(panelB()); }, "mark step");
  var markButtons = Array.prototype.slice.call(b2.doc.querySelectorAll("#modal .panel .choice button"));
  var chosen = markButtons.filter(function (x) { return x.getAttribute("aria-pressed") === "true"; });
  check("the earlier answer comes back chosen",
    chosen.length === 1 && /^Yes$/.test(chosen[0].textContent), chosen.map(function (x) { return x.textContent; }));
  check("and the panel says so rather than asking cold",
    /chose the mark last time/.test(panelB()), panelB().slice(0, 160));
  chosen[0].dispatchEvent(new b2.win.MouseEvent("click", { bubbles: true }));

  await waitFor(function () { return /Pay 300 USDC/.test(panelB()); }, "pay step");
  check("the same hold is reused, not a second piece", true);
  /* Confirming the restored answer must leave the ledger saying what it said. */
  var mineB = await (await fetch(BASE + "/api/orders/mine", { headers: { cookie: cookie } })).json();
  check("and the mark is unchanged in the ledger",
    mineB.orders && mineB.orders[0] && mineB.orders[0].mark === true,
    mineB.orders && mineB.orders[0] && mineB.orders[0].mark);

  calls = [];
  Array.prototype.slice.call(b2.doc.querySelectorAll("#modal .panel button"))
    .filter(function (x) { return /^Pay 300 USDC$/.test(x.textContent); })[0]
    .dispatchEvent(new b2.win.MouseEvent("click", { bubbles: true }));


  /* The regression: this used to do nothing whatsoever. */
  await waitFor(function () { return calls.indexOf("signAndSendTransaction") !== -1; }, "the wallet to be asked to pay", 15000);
  check("paying asks the wallet after a reload", true);
  var st = await (await fetch(BASE + "/api/state")).json();
  check("still only one piece held", st.taken === 1, st);
  /* Left open on purpose. The payment above never confirms here, so the page is
     sitting in confirmPayment's retry — a real browser stops that timer when the
     tab goes, but jsdom's close() only takes the document away and the next tick
     then renders into nothing. Closing this one crashes the third visit. */

  /* ---------- third visit: the wallet has forgotten us ---------- */
  console.log("\nback later, wallet no longer approved");
  approved = false;
  calls = [];
  var c = loadPage(phantom());
  var panelC = function () { return (c.doc.querySelector("#modal .panel").textContent || "").replace(/\s+/g, " "); };
  await waitFor(function () { return c.doc.querySelector("#countNum").textContent === "0"; }, "state");
  await sleep(600);
  c.doc.querySelector(".cta").dispatchEvent(new c.win.MouseEvent("click", { bubbles: true }));
  await waitFor(function () { return /Your details/.test(panelC()); }, "details step");
  var formC = c.doc.querySelector("#orderForm");
  formC.querySelector("#fName").value = "Shina Foo";
  formC.querySelector("#fEmail").value = "shina@example.com";
  formC.dispatchEvent(new c.win.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(function () { return /The Solana mark/.test(panelC()); }, "mark step");
  Array.prototype.slice.call(c.doc.querySelectorAll("#modal .panel .choice button"))
    .filter(function (x) { return x.getAttribute("aria-pressed") === "true"; })[0]
    .dispatchEvent(new c.win.MouseEvent("click", { bubbles: true }));
  await waitFor(function () { return /Pay 300 USDC/.test(panelC()); }, "pay step");

  Array.prototype.slice.call(c.doc.querySelectorAll("#modal .panel button"))
    .filter(function (x) { return /^Pay 300 USDC$/.test(x.textContent); })[0]
    .dispatchEvent(new c.win.MouseEvent("click", { bubbles: true }));

  /* Silence is the one thing this must not do. It cannot pay, so it has to say
     so and offer the way back. */
  await waitFor(function () { return /Connect a wallet/.test(panelC()); }, "the wallet step", 15000);
  check("an unreachable wallet sends you back to connect", true);
  check("with a sentence rather than a dead button", /not connected in this tab/.test(panelC()), panelC().slice(0, 200));
  check("and says the piece is still held", /still held/.test(panelC()));
  check("nothing was signed", calls.indexOf("signAndSendTransaction") === -1, calls);
  check("the page threw nothing", c.errors.length === 0, c.errors.slice(0, 2));
  c.dom.window.close();

  console.log("\n" + pass + " passed, " + fail + " failed");
} catch (e) {
  console.error("\nTEST ERROR", e);
  console.error(log.slice(-1500));
  fail++;
} finally {
  child.kill("SIGTERM");
}
process.exit(fail ? 1 : 0);
