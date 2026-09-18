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

store.db.close();
console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
