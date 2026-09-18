/* Wave two: what happens after the fifteenth.

   The run used to end in a closed shop. It now opens a second cut, which is
   confirmed by volume rather than capped by it — so the assertions that matter
   are about the seam between the two. A wave-two order must never consume one
   of the fifteen, never be handed a piece number or a pickup code, and never be
   told it sold out. And the run's own counters must not drift: the moment a
   wave-two order starts counting as "sold", the page tells the world it sold
   fifteen kimonos it has not made. */

import { rmSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { encodeBase58 } from "../src/base58.js";

var here = dirname(fileURLToPath(import.meta.url));
var root = resolve(here, "../..");
rmSync(resolve(root, "data/test"), { recursive: true, force: true });
mkdirSync(resolve(root, "data/test"), { recursive: true });

var pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (detail !== undefined ? "  <- " + JSON.stringify(detail) : "")); }
}

process.env.DB_PATH = "../data/test/wave.db";
process.env.CAP = "15";
process.env.WAVE_TWO = "1";
var store = await import("../src/db.js");
var { config } = await import("../src/config.js");

var sig = function () { return encodeBase58(randomBytes(64)); };
function buy(n, opts) {
  var p = store.createPendingOrder({
    wallet: "W" + n, name: "Buyer " + n, email: "b" + n + "@example.test",
    x: null, tg: null, reference: "R" + n + "-" + Date.now(), mark: (opts && opts.mark) || null
  });
  return store.markPaid(p.id, sig());
}

console.log("\nfilling the run");
var run = [];
for (var i = 1; i <= 15; i++) run.push(buy(i));
check("fifteen pieces went out", store.paidCount() === 15, store.paidCount());
check("numbered one to fifteen", run.map(function (o) { return o.piece_no; }).join(",") === "1,2,3,4,5,6,7,8,9,10,11,12,13,14,15");
check("all in wave one", run.every(function (o) { return o.wave === 1; }));
check("every one has a pickup code", run.every(function (o) { return !!o.pickup_code; }));

console.log("\nthe sixteenth buyer");
check("the shop now points at wave two", store.currentWave() === 2, store.currentWave());
/* The old behaviour was a thrown SOLD_OUT. Nobody is turned away any more. */
var w2a = buy(16, { mark: true });
check("is not refused", !!w2a);
check("and lands in wave two", w2a.wave === 2, w2a.wave);
check("with no piece number — there is no piece yet", w2a.piece_no === null, w2a.piece_no);
check("and no pickup code — nothing to hand over", w2a.pickup_code === null, w2a.pickup_code);
check("but a place in the queue", w2a.wave_no === 1, w2a.wave_no);
check("and it is paid, not pending", w2a.status === "paid", w2a.status);
check("their answer about the mark is kept", w2a.mark === 1, w2a.mark);

console.log("\nwhat wave two must not disturb");
/* The seam. Every one of these is a number the page shows. */
check("the run still reads fifteen sold", store.paidCount() === 15, store.paidCount());
check("and fifteen taken", store.takenCount() === 15, store.takenCount());
check("the buyer wall shows only the run", store.publicBuyers().length === 15, store.publicBuyers().length);
check("wave two is counted separately", store.wave2Count() === 1, store.wave2Count());

console.log("\nmore of them");
var w2b = buy(17), w2c = buy(18);
check("each takes the next number in the wave", w2b.wave_no === 2 && w2c.wave_no === 3, [w2b.wave_no, w2c.wave_no]);
check("wave two keeps counting", store.wave2Count() === 3, store.wave2Count());
check("the run is still fifteen", store.paidCount() === 15, store.paidCount());
/* Wave two is confirmed by volume, not capped by it — it cannot sell out. */
check("and wave two never reads as sold out", store.currentWave() === 2);

console.log("\nmissing the run by seconds");
/* The hold lapsed and the last piece went while the transaction confirmed. The
   money is real, so the only question is where it lands. */
var late = store.createPendingOrder({
  wallet: "Wlate", name: "Late Buyer", email: "late@example.test",
  x: null, tg: null, reference: "Rlate" + Date.now(), mark: false
});
/* Force the race: put the order in wave one, as it was when it was taken, and
   only then let the run fill. */
store.db.prepare("UPDATE orders SET wave = 1 WHERE id = ?").run(late.id);
var lateePaid = store.markPaid(late.id, sig());
check("the payment is taken, not refused", lateePaid.status === "paid", lateePaid.status);
check("and moved into wave two", lateePaid.wave === 2, lateePaid.wave);
check("with a place in it", lateePaid.wave_no === 4, lateePaid.wave_no);
check("no piece, because there is none", lateePaid.piece_no === null);
check("and no pickup code", lateePaid.pickup_code === null);
/* The trail has to say this was done to them, not chosen by them — it decides
   which letter goes out and it is the first thing to check if they ask for the
   money back. */
check("the trail records it as a conversion", store.hasEvent(late.id, "order.overflow.wave2"));
check("and not as an ordinary wave-two order", !store.hasEvent(late.id, "order.paid.wave2"));
check("the note says so in words", /moved to wave two/.test(lateePaid.notes || ""), lateePaid.notes);
/* A column, not the prose: it decides which refund the buyer is offered, and it
   has to survive them closing the tab and coming back. */
check("and a column records it", lateePaid.wave_missed === 1, lateePaid.wave_missed);
var reread = store.getOrder(late.id);
check("which survives a reload", reread.wave_missed === 1);
var chosenAgain = store.getOrder(w2a.id);
check("while a chosen wave-two order carries none", !chosenAgain.wave_missed, chosenAgain.wave_missed);
check("nothing is left owing a refund", store.allOrders().filter(function (o) { return o.status === "overflow"; }).length === 0);
check("the run is still exactly fifteen", store.paidCount() === 15, store.paidCount());

console.log("\nthe letter it produces");
var em = await import("../src/email.js");
var missedText = em.waveTwoText(lateePaid, { missed: true });
var chosenText = em.waveTwoText(lateePaid, { missed: false });
check("says the piece was missed", /missed it by seconds/i.test(missedText), missedText.slice(0, 80));
check("says we did this, not them", /not something you chose/.test(missedText));
check("and offers the money back outright", /rather have the refund/.test(missedText));
/* Someone who chose wave two must not be told they missed anything. */
check("the ordinary letter says none of that", !/missed it by seconds/i.test(chosenText) && !/rather have the refund/.test(chosenText));

console.log("\nwhat it promises about the code");
var withTg = em.waveTwoText(Object.assign({}, lateePaid, { tg_handle: "shina_foo" }), { missed: true });
var withoutTg = em.waveTwoText(Object.assign({}, lateePaid, { tg_handle: null }), { missed: true });
check("it says a code comes when the cut is confirmed", /Once wave two is confirmed we send your claim code by email/.test(withoutTg));
check("Telegram is promised when we have a handle", /by email and on Telegram, to @shina_foo/.test(withTg), withTg.slice(0, 40));
/* The field is optional. Promising to message an address we do not have is a
   promise broken on the day it matters most. */
check("and not promised when we do not", !/Telegram/.test(withoutTg));

console.log("\na discount that is not one");
/* The struck-out price is a claim about money. A value at or below what is
   actually charged advertises a saving the receipt contradicts, so the server
   refuses to start rather than run a shop that lies about its own price. */
var badPrice = (await import("node:child_process")).spawnSync(process.execPath, ["--env-file=.env", "-e", `
  process.env.DB_PATH = "../data/test/wave.db";
  process.env.PRICE_USDC = "260";
  process.env.LIST_PRICE_USDC = "260";
  await import("./src/config.js");
  console.log("BOOTED");
`], { cwd: resolve(here, ".."), encoding: "utf8" });
check("the server refuses to boot", !/BOOTED/.test(badPrice.stdout || ""), badPrice.stdout);
check("and says why", /must be greater than PRICE_USDC/.test(badPrice.stderr || ""), (badPrice.stderr || "").slice(0, 120));

console.log("\nwith wave two switched off");
var offRun = (await import("node:child_process")).spawnSync(process.execPath, ["--env-file=.env", "-e", `
  process.env.DB_PATH = "../data/test/wave.db";
  process.env.CAP = "15";
  process.env.WAVE_TWO = "0";
  var store = await import("./src/db.js");
  var out;
  try {
    store.createPendingOrder({ wallet: "Woff", name: "Off", email: "off@example.test",
      x: null, tg: null, reference: "Roff" + Date.now(), mark: null });
    out = { threw: null };
  } catch (e) { out = { threw: e.code }; }
  console.log(JSON.stringify(Object.assign(out, { wave: store.currentWave() })));
  store.db.close();
`], { cwd: resolve(here, ".."), encoding: "utf8" });
var off = {};
try { off = JSON.parse((offRun.stdout || "").trim().split("\n").pop()); }
catch (e) { check("the off-run reported", false, (offRun.stderr || "").slice(-300)); }
/* The shop closes again, exactly as it did before wave two existed. */
check("a full run refuses the order", off.threw === "SOLD_OUT", off);
check("and never points at wave two", off.wave === 1, off);

console.log("\nand a late payment, with wave two off");
var offLate = (await import("node:child_process")).spawnSync(process.execPath, ["--env-file=.env", "-e", `
  process.env.DB_PATH = "../data/test/wave.db";
  process.env.CAP = "15";
  process.env.WAVE_TWO = "0";
  var store = await import("./src/db.js");
  /* Inserted directly: this is a hold taken while the run still had stock, and
     createPendingOrder would rightly refuse to make one now that it has none. */
  var id = "lateoff" + Date.now().toString(16).slice(-9);
  var now = Date.now();
  store.db.prepare(\`INSERT INTO orders
    (id,status,piece_no,wallet,name,email,amount_usdc,reference,created_at,hold_expires_at,wave)
    VALUES (?,'pending',NULL,?,?,?,?,?,?,?,1)\`)
    .run(id, "WlateOff", "Late Off", "lateoff@example.test", 300, "RlateOff" + now, now, now + 600000);
  var paid = store.markPaid(id, "Z".repeat(64));
  console.log(JSON.stringify({ status: paid.status, wave: paid.wave, notes: paid.notes }));
  store.db.close();
`], { cwd: resolve(here, ".."), encoding: "utf8" });
var ol = {};
try { ol = JSON.parse((offLate.stdout || "").trim().split("\n").pop()); }
catch (e) { check("the off-late run reported", false, (offLate.stderr || "").slice(-300)); }
/* With nowhere to put them, the money goes back — the behaviour this replaced. */
check("becomes an overflow owing a refund", ol.status === "overflow", ol);
check("and says so in the note", /refund owed/.test(ol.notes || ""), ol.notes);

store.db.close();
console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
