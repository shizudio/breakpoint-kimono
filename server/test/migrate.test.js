/* Adding a column to a ledger that already holds sales.

   CREATE TABLE IF NOT EXISTS does nothing to an existing table, so the `mark`
   column arrives through ALTER TABLE on boot. That path only ever runs against
   a real, populated database — the one place it cannot be rehearsed — so it is
   rehearsed here: an old-schema file with a paid order in it, opened by the
   current db.js, twice.

   What must hold: the server boots, the order survives, and its mark reads NULL
   rather than 0. An order taken before the question existed is not a buyer who
   declined, and whoever cuts the piece has to be able to tell the difference. */

import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { rmSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

var here = dirname(fileURLToPath(import.meta.url));
var root = resolve(here, "../..");
var dir = resolve(root, "data/test");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
var file = resolve(dir, "migrate.db");

var pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label + (detail !== undefined ? "  <- " + JSON.stringify(detail) : "")); }
}

/* The schema exactly as it shipped, before the mark existed. */
var old = new DatabaseSync(file);
old.exec(`
CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending','paid','expired','cancelled','overflow')),
  piece_no INTEGER UNIQUE, wallet TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL,
  x_handle TEXT, tg_handle TEXT, amount_usdc REAL NOT NULL,
  reference TEXT NOT NULL UNIQUE, tx_signature TEXT UNIQUE, pickup_code TEXT UNIQUE,
  collected_at INTEGER, collected_by TEXT, created_at INTEGER NOT NULL,
  hold_expires_at INTEGER NOT NULL, paid_at INTEGER, notes TEXT
);
CREATE TABLE nonces (nonce TEXT PRIMARY KEY, created_at INTEGER NOT NULL, used_at INTEGER);
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, order_id TEXT, kind TEXT, detail TEXT);
`);
old.prepare(`INSERT INTO orders (id,status,piece_no,wallet,name,email,amount_usdc,reference,
  pickup_code,created_at,hold_expires_at,paid_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run("old00000000000001", "paid", 1, "Wold", "Early Bird", "early@example.test",
       300, "Rold", "AAAA-BBBB", Date.now(), Date.now() + 1200000, Date.now());
old.close();

/* A separate process each time: db.js binds to DB_PATH at import and runs the
   migration once, on load. */
function boot(label) {
  var r = spawnSync(process.execPath, ["--env-file=.env", "-e", `
    process.env.DB_PATH = "../data/test/migrate.db";
    var store = await import("./src/db.js");
    var row = store.db.prepare("SELECT * FROM orders WHERE id = ?").get("old00000000000001");
    var cols = store.db.prepare("SELECT name FROM pragma_table_info('orders')").all().map(c => c.name);
    console.log(JSON.stringify({ mark: row.mark, piece: row.piece_no, code: row.pickup_code, cols: cols }));
    store.db.close();
  `], { cwd: resolve(here, ".."), encoding: "utf8" });
  if (r.status !== 0) {
    check(label + " boots", false, (r.stderr || "").slice(-400));
    return null;
  }
  var line = (r.stdout || "").trim().split("\n").pop();
  try { return JSON.parse(line); } catch (e) { check(label + " boots", false, r.stdout); return null; }
}

console.log("\nopening a pre-mark ledger");
var first = boot("first open");
check("the server opens it at all", !!first);
if (first) {
  check("the column is added", first.cols.indexOf("mark") !== -1, first.cols);
  check("the existing sale survives", first.piece === 1 && first.code === "AAAA-BBBB", first);
  /* The whole point. 0 here would tell the workshop this buyer declined. */
  check("and reads as never asked, not as declined", first.mark === null, first.mark);
}

console.log("\nopening it again");
/* Every boot runs the migration, so it has to be a no-op the second time —
   ALTER TABLE ADD COLUMN on an existing column is an error, not a shrug. */
var second = boot("second open");
check("it opens a second time", !!second);
if (second) {
  check("without trying to add the column twice", second.cols.filter(c => c === "mark").length === 1, second.cols);
  check("and the order is still there", second.piece === 1, second);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
