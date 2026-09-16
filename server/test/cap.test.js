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
  console.log(JSON.stringify({ i: +i, status: paid.status, piece: paid.piece_no }));
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

var paid = results.filter(function (r) { return r.status === "paid"; });
var soldOut = results.filter(function (r) { return r.error === "SOLD_OUT"; });
var other = results.filter(function (r) { return r.status !== "paid" && r.error !== "SOLD_OUT"; });
var pieces = paid.map(function (r) { return r.piece; }).sort(function (a, b) { return a - b; });
var expected = Array.from({ length: CAP }, function (_, i) { return i + 1; });

var fails = [];
if (paid.length !== CAP) fails.push("expected " + CAP + " paid, got " + paid.length);
if (JSON.stringify(pieces) !== JSON.stringify(expected)) fails.push("piece numbers are " + JSON.stringify(pieces));
if (soldOut.length !== RACERS - CAP) fails.push("expected " + (RACERS - CAP) + " SOLD_OUT, got " + soldOut.length);
if (other.length) fails.push("unexpected outcomes: " + JSON.stringify(other.slice(0, 5)));

console.log(RACERS + " processes raced for " + CAP + " pieces");
console.log("  paid:     " + paid.length);
console.log("  sold out: " + soldOut.length);
console.log("  pieces:   " + pieces.join(","));
if (fails.length) { console.log("\nFAIL\n - " + fails.join("\n - ")); process.exit(1); }
console.log("\nPASS — no oversell, no duplicate or skipped piece number");
