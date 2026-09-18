/* Hammers the cap from many processes at once. SQLite's write lock is the only
   thing standing between 15 pieces and 16 refunds, so it gets a real test:
   N processes race to reserve and pay, and exactly CAP must come away with a
   piece, numbered 1..CAP with no gaps and no repeats.

   spawn, not spawnSync — a synchronous loop would serialise the racers and the
   test would pass without ever taking the lock under contention. */
import { spawn } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

var here = dirname(fileURLToPath(import.meta.url));
var tmp = resolve(here, "../../data/test");
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

var CAP = 15, RACERS = 40;
var env = Object.assign({}, process.env, {
  DB_PATH: "../data/test/cap.db",
  CAP: String(CAP),
  HOLD_MINUTES: "20",
  RPC_URL: "http://unused",
  TREASURY: "DWDeu7snxGK9uscdJbtjcQ4oU9cCdpNZPaate6BVqEuD",
  SESSION_SECRET: "t".repeat(64),
  ADMIN_WALLETS: "DWDeu7snxGK9uscdJbtjcQ4oU9cCdpNZPaate6BVqEuD"
});

var worker = resolve(tmp, "worker.mjs");
writeFileSync(worker, `
import { createPendingOrder, markPaid } from ${JSON.stringify(resolve(here, "../src/db.js"))};
var i = process.argv[2];
// Line them all up on the same starting gun so the lock is genuinely contended.
var gun = Number(process.argv[3]);
while (Date.now() < gun) {}
try {
  var o = createPendingOrder({
    wallet: "W" + i, name: "Racer " + i, email: i + "@example.com",
    x: "racer" + i, tg: null, reference: "REF" + i
  });
  var paid = markPaid(o.id, "SIG" + i);
  console.log(JSON.stringify({ i: +i, status: paid.status, piece: paid.piece_no, wave: paid.wave, waveNo: paid.wave_no }));
} catch (e) {
  console.log(JSON.stringify({ i: +i, error: e.code || e.message }));
}
`);

function race(i, gun) {
  return new Promise(function (res) {
    var out = "", err = "";
    var cp = spawn(process.execPath, [worker, String(i), String(gun)], { env: env });
    cp.stdout.on("data", function (d) { out += d; });
    cp.stderr.on("data", function (d) { err += d; });
    cp.on("close", function (code) {
      var line = out.trim().split("\n").filter(Boolean).pop();
      if (!line) return res({ i: i, error: "no output (exit " + code + ") " + err.slice(0, 300) });
      try { res(JSON.parse(line)); } catch (e) { res({ i: i, error: "bad output: " + line }); }
    });
  });
}

var gun = Date.now() + 1500;   // all workers spin until this instant
var results = await Promise.all(Array.from({ length: RACERS }, function (_, i) { return race(i, gun); }));

/* Nobody is refused any more: the losers of the race land in wave two, which is
   confirmed by volume rather than capped by it. The cap still has to hold, and
   now so does the seam — a racer must come away with a piece or a place, never
   both and never neither. */
var wave1 = results.filter(function (r) { return r.status === "paid" && r.wave === 1; });
var wave2 = results.filter(function (r) { return r.status === "paid" && r.wave === 2; });
var soldOut = results.filter(function (r) { return r.error === "SOLD_OUT"; });
var other = results.filter(function (r) { return r.status !== "paid" && r.error !== "SOLD_OUT"; });
var pieces = wave1.map(function (r) { return r.piece; }).sort(function (a, b) { return a - b; });
var expected = Array.from({ length: CAP }, function (_, i) { return i + 1; });

var fails = [];
if (JSON.stringify(pieces) !== JSON.stringify(expected)) fails.push("piece numbers are " + JSON.stringify(pieces));
if (soldOut.length) fails.push("wave two is open, so nobody should have been refused — " + soldOut.length + " were");
if (wave2.length !== RACERS - CAP) fails.push("expected " + (RACERS - CAP) + " in wave two, got " + wave2.length);
if (wave1.length !== CAP) fails.push("expected " + CAP + " pieces, got " + wave1.length);
/* The same lock that stops two buyers being handed piece 7 has to stop two
   being handed wave-two place 7. */
var waveNos = wave2.map(function (r) { return r.waveNo; }).sort(function (a, b) { return a - b; });
var wantWave = Array.from({ length: RACERS - CAP }, function (_, k) { return k + 1; });
if (waveNos.join(",") !== wantWave.join(",")) {
  fails.push("wave two numbers are not 1.." + (RACERS - CAP) + " exactly: " + waveNos.join(","));
}
if (wave2.some(function (r) { return r.piece !== null; })) fails.push("a wave-two order was handed a piece number");
if (other.length) fails.push("unexpected outcomes: " + JSON.stringify(other.slice(0, 5)));

console.log(RACERS + " processes raced for " + CAP + " pieces");
console.log("  pieces:   " + wave1.length);
console.log("  wave two: " + wave2.length);
console.log("  pieces:   " + pieces.join(","));
if (fails.length) { console.log("\nFAIL\n - " + fails.join("\n - ")); process.exit(1); }
console.log("\nPASS — no oversell, no duplicate or skipped piece number");
