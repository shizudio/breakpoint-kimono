/* Backs up the ledger while the server is running.

   VACUUM INTO, not `cp`. In WAL mode the live .db file is only part of the
   story — recent writes sit in the -wal until a checkpoint, so a plain copy can
   land mid-transaction and produce a file that is short of the last few orders
   or will not open at all. VACUUM INTO takes a consistent snapshot of the whole
   database, including whatever is still in the WAL, and writes it compacted.

   It is fifteen people who have paid you. Run it on a timer. */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../src/config.js";

var here = dirname(fileURLToPath(import.meta.url));
var dbPath = resolve(here, "..", config.dbPath);
var outDir = resolve(here, "..", process.env.BACKUP_DIR || "../data/backups");
var keep = Number(process.env.BACKUP_KEEP || 30);

mkdirSync(outDir, { recursive: true });

var stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
var out = join(outDir, "orders-" + stamp + ".db");

// Read-only handle: a backup must never be able to change what it is copying.
var db = new DatabaseSync(dbPath, { readOnly: true });
var orders = db.prepare("SELECT COUNT(*) n FROM orders WHERE status='paid'").get().n;
// Bound, not interpolated: SQLite reads a double-quoted token as an identifier,
// so a pasted-in path comes back as "no such column".
db.prepare("VACUUM INTO ?").run(out);
db.close();

var size = statSync(out).size;
console.log("backed up " + orders + " paid order(s) -> " + out + "  (" + Math.round(size / 1024) + "KB)");

/* Keep the last N. A backup directory that grows without limit is a disk-full
   incident waiting for the worst possible moment. */
var mine = readdirSync(outDir).filter(function (f) { return /^orders-.*\.db$/.test(f); }).sort();
while (mine.length > keep) {
  var drop = mine.shift();
  unlinkSync(join(outDir, drop));
  console.log("  pruned " + drop);
}
console.log(mine.length + " backup(s) retained (BACKUP_KEEP=" + keep + ")");
