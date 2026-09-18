/* Drives the real site/index.html against the real server in jsdom, with a
   wallet that signs with a real ed25519 key. Everything the buyer touches is
   exercised here except the transfer itself: connect, sign in, reserve, and the
   state the page must reach when a payment goes out but does not verify.

   The page is loaded from disk, not a copy — if a selector or a step name drifts
   out of step with the API, this fails. */

import { JSDOM, VirtualConsole } from "jsdom";
import { spawn } from "node:child_process";
import { readFileSync, rmSync, mkdirSync } from "node:fs";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeBase58, decodeBase58 } from "../src/base58.js";
import * as web3 from "@solana/web3.js";

var here = dirname(fileURLToPath(import.meta.url));
var root = resolve(here, "../..");
rmSync(resolve(root, "data/test"), { recursive: true, force: true });
mkdirSync(resolve(root, "data/test"), { recursive: true });

var PORT = 4398, BASE = "http://127.0.0.1:" + PORT;
var child = spawn(process.execPath, ["--env-file=.env", "src/index.js"], {
  cwd: resolve(here, ".."),
  env: Object.assign({}, process.env, {
    PORT: String(PORT), DB_PATH: "../data/test/page.db", PUBLIC_ORIGIN: BASE,
    SESSION_SECRET: "s".repeat(64), ADMIN_WALLETS: "DWDeu7snxGK9uscdJbtjcQ4oU9cCdpNZPaate6BVqEuD",
    SITE_DIR: "../dist",
    /* Pinned, not inherited. The suite loads the real .env for RPC_URL, and a
       price or treasury changed there for a rehearsal must not decide what the
       tests assert — this file checks for "Pay 300 USDC" and for the treasury's
       own token account by name. */
    PRICE_USDC: "300",
    /* These walk the undiscounted flow; the struck price has its own test. */
    LIST_PRICE_USDC: "0",
    TREASURY: "DWDeu7snxGK9uscdJbtjcQ4oU9cCdpNZPaate6BVqEuD",
    TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: ""
  }),
  stdio: ["ignore", "pipe", "pipe"]
});
var log = "";
child.stdout.on("data", function (d) { log += d; });
child.stderr.on("data", function (d) { log += d; });

var pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (detail !== undefined ? "  <- " + JSON.stringify(detail) : "")); }
}
var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

var mintedCode = null;
function store2Code() { return mintedCode; }

async function waitFor(fn, label, ms) {
  var until = Date.now() + (ms || 8000);
  while (Date.now() < until) {
    var v = fn();
    if (v) return v;
    await sleep(60);
  }
  throw new Error("timed out waiting for " + label);
}

try {
  for (var i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + "/api/state")).ok) break; } catch (e) {}
    await sleep(250);
  }

  var html = readFileSync(resolve(root, "site/index.html"), "utf8");
  var vc = new VirtualConsole();
  var pageErrors = [];
  vc.on("jsdomError", function (e) { pageErrors.push(String(e.message)); });
  vc.on("error", function () { pageErrors.push(Array.prototype.join.call(arguments, " ")); });

  var dom = new JSDOM(html, {
    url: BASE + "/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc
  });
  var win = dom.window, doc = win.document;

  /* One cookie jar, like a browser. The page sends credentials:"same-origin". */
  var cookie = "";
  var qrFetches = 0;
  win.fetch = function (input, init) {
    init = init || {};
    if (/\/qr$/.test(String(input))) qrFetches++;
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
  /* jsdom stops short of a few browser APIs the page leans on. Reduced motion
     is answered false so the loader, the scroll lock and the marquee all run —
     testing the path the overwhelming majority of visitors get. */
  win.matchMedia = function (q) {
    return { matches: false, media: q, addEventListener: function () {}, removeEventListener: function () {},
             addListener: function () {}, removeListener: function () {}, onchange: null, dispatchEvent: function () { return false; } };
  };
  win.scrollTo = function () {};
  // loadWeb3() short-circuits when the global is already there, so the 473KB
  // bundle does not have to be parsed by jsdom.
  win.solanaWeb3 = web3;

  /* A wallet that behaves like Phantom, down to signMessage returning an object. */
  var kp = generateKeyPairSync("ed25519");
  var address = encodeBase58(kp.publicKey.export({ format: "der", type: "spki" }).subarray(12));
  var walletCalls = { connect: 0, signMessage: 0, send: 0 };
  var lastTx = null;
  win.phantom = { solana: {
    isPhantom: true,
    connect: function () { walletCalls.connect++; return Promise.resolve({ publicKey: { toString: function () { return address; } } }); },
    signMessage: function (bytes) {
      walletCalls.signMessage++;
      return Promise.resolve({ signature: edSign(null, Buffer.from(bytes), kp.privateKey) });
    },
    signAndSendTransaction: function (tx) {
      walletCalls.send++;
      lastTx = tx;
      return Promise.resolve({ signature: encodeBase58(Buffer.alloc(64, 9)) });
    }
  }};

  /* Run the page's own script. It is a module script now, so it carries
     import.meta.env — which is a syntax error outside a module. Substitute it
     the way Vite does at build time: statically, before evaluation. Empty
     VITE_SERVER_URL is the same-origin default this suite exercises. */
  var script = html.match(/<script type="module">\n([\s\S]*?)\n<\/script>/)[1]
    .replace(/import\.meta\.env/g, '({ VITE_SERVER_URL: "" })');
  win.eval(script);

  var panel = function () { return doc.querySelector("#modal .panel"); };
  var panelText = function () { return (panel().textContent || "").replace(/\s+/g, " ").trim(); };
  var byText = function (sel, re) {
    return Array.prototype.slice.call(panel().querySelectorAll(sel))
      .filter(function (n) { return re.test(n.textContent || ""); })[0];
  };

  console.log("\nboot");
  await waitFor(function () { return doc.querySelector("#countNum").textContent === "0"; }, "state to load");
  check("count comes from the server", doc.querySelector("#countNum").textContent === "0");
  check("remaining comes from the server", doc.querySelector("#remaining").textContent === "15");
  check("leaderboard draws the whole run", doc.querySelectorAll("#leaderboard a").length === 15);
  check("every row is open", doc.querySelector("#leaderboard a .handle").textContent === "Open");
  check("no preview banner remains", !doc.querySelector(".preview-bar"));
  var countdown = doc.querySelector("#countdown").textContent;
  check("countdown is running off the server date", /\d+d/.test(countdown), countdown);

  console.log("\nstep one — connect");
  doc.querySelector(".cta").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  check("modal opens", !doc.querySelector("#modal").hidden);
  check("it opens on the wallet step", /Connect a wallet/.test(panelText()), panelText().slice(0, 80));
  check("all three wallets are listed", panel().querySelectorAll(".wallet-btn").length === 3);
  var tags = Array.prototype.slice.call(panel().querySelectorAll(".wallet-btn .tag")).map(function (n) { return n.textContent; });
  check("the two that are not installed offer a download", tags.length === 2 && tags.every(function (t) { return /Install/.test(t); }), tags);
  check("it promises no payment at this step", /No payment is approved here/.test(panelText()));

  byText(".wallet-btn", /Phantom/).dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await waitFor(function () { return /Your details/.test(panelText()); }, "the details step");
  check("connect was called", walletCalls.connect === 1);
  check("a message was signed", walletCalls.signMessage === 1);
  check("the wallet is shown, abbreviated", panel().querySelector(".wallet-chip").textContent.indexOf(address.slice(0, 4)) !== -1);

  console.log("\nstep two — details");
  check("the real form was adopted", !!panel().querySelector("#orderForm"));
  var form = doc.querySelector("#orderForm");
  form.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
  await sleep(250);
  check("an empty form is refused before any request", form.querySelectorAll(".field-row.invalid").length === 2,
        form.querySelectorAll(".field-row.invalid").length);

  form.querySelector("#fName").value = "Shina Foo";
  form.querySelector("#fEmail").value = "shina@example.com";
  form.querySelector("#fX").value = "https://x.com/shizudio?s=21";
  form.querySelector("#fTg").value = "@shizudio";
  form.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));

  console.log("\nstep three — the Solana mark");
  await waitFor(function () { return /The Solana mark/.test(panelText()); }, "the mark step");
  check("the reference photo is shown", !!panel().querySelector(".mark-shot"));
  check("both answers are offered", panel().querySelectorAll(".choice button").length === 2);
  /* Nothing preselected for someone who has not chosen yet. A default on the one
     question that decides what gets embroidered would be answering it for them. */
  check("neither answer is preselected the first time",
    [].every.call(panel().querySelectorAll(".choice button"),
      function (b) { return b.getAttribute("aria-pressed") === "false"; }));
  /* The mark is a manufacturing instruction, so it has to be settled before a
     piece leaves the board — not after. */
  var pre = await (await fetch(BASE + "/api/state")).json();
  check("no piece is held until the mark is answered", pre.taken === 0, pre);
  byText("button", /^Yes$/).dispatchEvent(new win.MouseEvent("click", { bubbles: true }));

  await waitFor(function () { return /Pay 300 USDC/.test(panelText()); }, "the pay step");
  check("a pasted profile URL was normalised in place", form.querySelector("#fX").value === "shizudio", form.querySelector("#fX").value);
  var st = await (await fetch(BASE + "/api/state")).json();
  check("the piece is now held server-side", st.taken === 1 && st.sold === 0, st);

  console.log("\nstep four — pay");
  check("the amount is shown", /300 USDC/.test(panelText()));
  check("the short balance is called out", /Top it up/.test(panelText()), panelText().slice(0, 200));
  check("the hold time is shown", /held until/.test(panelText()));
  check("the mark choice is restated before paying", /Solana mark on the inner pocket/.test(panelText()));

  byText("button", /^Pay 300 USDC$/).dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await waitFor(function () { return walletCalls.send === 1; }, "the wallet to be asked to send");
  check("the wallet was handed a transaction", walletCalls.send === 1);
  check("it was a real transaction object", !!lastTx && typeof lastTx.serialize === "function");

  /* The signature is real in shape but the chain has never seen it, so the
     server refuses it. This is the state that must not lose the signature. */
  await waitFor(function () { return /Check again/.test(panelText()); }, "the unverified-payment state", 90000);
  check("the payment is not silently accepted", !/is yours/.test(panelText()));
  check("the signature stays on screen", panelText().indexOf(encodeBase58(Buffer.alloc(64, 9)).slice(0, 20)) !== -1);
  check("and there is a way to try again", !!byText("button", /Check again/));
  var st2 = await (await fetch(BASE + "/api/state")).json();
  check("no piece was awarded", st2.sold === 0, st2);

  console.log("\ntransaction the server built");
  /* Read the ledger directly. This test is about the page, and going through
     /api/admin would only be exercising the admin wallet sign-in, which
     api.test.js and pickup.test.js already cover. Point this process at the
     scratch database before src/db.js loads — config.js reads the environment
     once, at import, and .env names the real ledger. */
  process.env.DB_PATH = "../data/test/page.db";
  var store = await import("../src/db.js");
  var orders = store.allOrders();
  check("one pending order exists", orders.length === 1 && orders[0].status === "pending", orders.map(function (o) { return o.status; }));
  check("it carries the buyer's details", orders[0].name === "Shina Foo" && orders[0].x_handle === "shizudio", orders[0]);
  var ix = lastTx.instructions[lastTx.instructions.length - 1];
  check("the transfer is to the treasury's token account",
    ix.keys.some(function (k) { return k.pubkey.toBase58() === "DzXXeN53SFeaqN9DmgGA37r1LeBP9h6yyCpyyzZ8LAja"; }));
  check("the amount is 300 USDC in base units",
    Buffer.from(ix.data).readBigUInt64LE(1) === 300000000n, Buffer.from(ix.data).toString("hex"));
  check("the buyer is the fee payer", lastTx.feePayer.toBase58() === address);

  console.log("\npage errors");
  check("the page threw nothing", pageErrors.length === 0, pageErrors.slice(0, 3));

  console.log("\nthe pickup code is masked");
  /* Reaching the confirmation panel for real needs 300 USDC on chain, so the
     order is marked paid straight in the ledger — then the page is driven the
     way a returning buyer drives it: press Reserve while still signed in. */
  var mineNow = store.ordersForWallet(address);
  mintedCode = store.markPaid(mineNow[0].id, "7".repeat(64)).pickup_code;
  store.db.close();

  doc.querySelector(".cta").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await waitFor(function () { return /is yours/.test(panelText()); }, "the confirmation panel");

  check("a paid wallet gets its pass back, not the order form", !/Your details/.test(panelText()));

  var code = store2Code();
  check("the panel opens masked", /••••-••••/.test(panelText()), panelText().slice(0, 160));
  check("the code is nowhere in the DOM", panelText().indexOf(code) === -1, code);
  check("no QR is fetched while masked", qrFetches === 0, qrFetches);
  check("it says the code is a ticket", /Keep this like a ticket/.test(panelText()), panelText().slice(0, 200));
  check("it says anyone holding it can collect", /Anyone who reads it can collect piece 1/.test(panelText()));
  check("it warns against posting it", /do not post it/.test(panelText()));

  byText("button", /Show code/).dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await waitFor(function () { return panelText().indexOf(code) !== -1; }, "the code to appear");
  check("revealing shows it", panelText().indexOf(code) !== -1);
  check("and only then is the QR fetched", qrFetches === 1, qrFetches);

  byText("button", /Hide/).dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  check("it can be masked again", panelText().indexOf(code) === -1);

  byText("button", /Show code/).dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  doc.querySelector("#modal").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  doc.querySelector(".cta").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await waitFor(function () { return /is yours/.test(panelText()); }, "the panel again");
  check("reopening starts masked again", panelText().indexOf(code) === -1, panelText().slice(0, 160));

  console.log("\nsave as PDF");
  var printed = 0; win.print = function () { printed++; };
  check("a Save as PDF button is offered with the pass", !!byText("button", /^Save as PDF$/));
  byText("button", /^Save as PDF$/).dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await waitFor(function () { return printed === 1; }, "the print dialog");
  check("the print dialog was opened", printed === 1);
  check("the code was revealed first, not printed masked", !panel().querySelector(".code.masked"));
  check("the QR had arrived before printing", !!panel().querySelector(".pass .qr svg"));
  console.log("\nreturning buyer");
  /* Reconnecting the same wallet is the only way back to an order. There is no
     link, and no code, that shows it to anyone else. */
  var mine = await (await fetch(BASE + "/api/orders/mine", { headers: { cookie: cookie } })).json();
  check("the wallet can see its own order", mine.orders.length === 1, mine);
  check("no shareable pass link is handed out", !JSON.stringify(mine).includes("/pass?code="), mine);
  /* The pickup code must not appear in any URL the page holds — URLs reach
     history, access logs and the Referer header. */
  var codeInUrl = JSON.stringify(mine).match(/"[^"]*\/[^"]*[0-9A-Z]{4}-[0-9A-Z]{4}[^"]*"/);
  check("no pickup code in any URL the API hands back", !codeInUrl, codeInUrl && codeInUrl[0]);
  check("a session is required", (await fetch(BASE + "/api/orders/mine")).status === 401);

  console.log("\n" + pass + " passed, " + fail + " failed");
} catch (e) {
  console.error("\nTEST ERROR", e);
  console.error(log.slice(-2000));
  fail++;
} finally {
  child.kill("SIGTERM");
}
process.exit(fail ? 1 : 0);
