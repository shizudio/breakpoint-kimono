/* The order ledger. SQLite, one file, written only through this module.

   The 15-piece cap is enforced here and nowhere else. Every write that can
   consume a slot runs inside BEGIN IMMEDIATE, which takes SQLite's write lock
   before reading — so two buyers confirming in the same millisecond serialise
   rather than both seeing "14 sold". The client's fill bar is display only. */

import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

var here = dirname(fileURLToPath(import.meta.url));
var dbPath = resolve(here, "..", config.dbPath);
mkdirSync(dirname(dbPath), { recursive: true });

export var db = new DatabaseSync(dbPath);
/* busy_timeout must come first. Switching to WAL takes a brief exclusive lock,
   and without a timeout already in force another process opening the file at
   the same moment dies on "database is locked" before it can run a query. */
db.exec("PRAGMA busy_timeout = 5000");
enableWal(db);
db.exec("PRAGMA synchronous = FULL");   // money: durability over throughput
db.exec("PRAGMA foreign_keys = ON");

/* The conversion to WAL happens exactly once, on a brand-new file, and SQLite's
   busy handler does not cover it — a journal_mode change fails outright rather
   than waiting. Every later open is a no-op, so read the mode first and only
   retry when we are the one doing the conversion. Without this a restart while
   anything else holds the file (a backup, the sqlite3 CLI) can refuse to boot. */
function enableWal(handle) {
  var mode = handle.prepare("PRAGMA journal_mode").get().journal_mode;
  if (String(mode).toLowerCase() === "wal") return;
  for (var attempt = 0; ; attempt++) {
    try { handle.exec("PRAGMA journal_mode = WAL"); return; }
    catch (e) {
      if (attempt >= 9) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 + attempt * 30);
    }
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id              TEXT PRIMARY KEY,
  status          TEXT NOT NULL CHECK (status IN ('pending','paid','expired','cancelled','overflow')),
  piece_no        INTEGER UNIQUE,
  wallet          TEXT NOT NULL,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL,
  x_handle        TEXT,
  tg_handle       TEXT,
  amount_usdc     REAL NOT NULL,
  reference       TEXT NOT NULL UNIQUE,
  tx_signature    TEXT UNIQUE,
  pickup_code     TEXT UNIQUE,
  collected_at    INTEGER,
  collected_by    TEXT,
  created_at      INTEGER NOT NULL,
  hold_expires_at INTEGER NOT NULL,
  paid_at         INTEGER,
  notes           TEXT,
  /* The Solana mark on the inner pocket: 1 chose it, 0 declined, NULL was never
     asked. Three states, not two — an order taken before the question existed
     is not the same as one where the buyer said no, and the difference decides
     whether someone has to be asked before the piece is cut. */
  mark            INTEGER,
  /* 1 is the run of fifteen. 2 is the second cut, which is confirmed by volume
     rather than capped by it — so it never sells out and never takes one of the
     fifteen. Rows default to 1 because every row that existed before this column
     did belongs to the first run. */
  wave            INTEGER NOT NULL DEFAULT 1,
  /* Position within wave two. Kept apart from piece_no because piece_no is
     UNIQUE across the table and wave two starts counting at one again; a shared
     column would have wave two colliding with the run on its first order. A
     wave-two row carries no piece_no at all — there is no piece yet. */
  wave_no         INTEGER
);
CREATE INDEX IF NOT EXISTS orders_status   ON orders(status);
CREATE INDEX IF NOT EXISTS orders_wallet   ON orders(wallet);
CREATE INDEX IF NOT EXISTS orders_pickup   ON orders(pickup_code);

CREATE TABLE IF NOT EXISTS nonces (
  nonce      TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  used_at    INTEGER
);

/* Append-only. Every state change lands here as well as on the row, so a
   disputed order can be reconstructed even if the row was later edited. */
CREATE TABLE IF NOT EXISTS events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       INTEGER NOT NULL,
  order_id TEXT,
  kind     TEXT NOT NULL,
  detail   TEXT
);
`);

/* CREATE TABLE IF NOT EXISTS does nothing to a ledger that already has rows, so
   a column added after the first sale has to arrive this way. Adding one is
   cheap and safe in SQLite — existing rows read NULL, which is exactly the
   "never asked" state — but it must be idempotent, because this runs on every
   boot. */
function addColumn(table, column, decl) {
  var has = db.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ?").get(table, column);
  if (!has) db.exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + decl);
}
addColumn("orders", "mark", "INTEGER");
/* NOT NULL needs a default to be added to a populated table, and 1 is the right
   one: everything written before wave two existed is the first run. */
addColumn("orders", "wave", "INTEGER NOT NULL DEFAULT 1");
addColumn("orders", "wave_no", "INTEGER");
/* Whether this wave-two row was converted after missing the run rather than
   chosen. A column and not a reading of the notes prose, because it decides
   which refund a buyer is offered — the unconditional one, or the one that
   depends on the cut going ahead — and that is not a thing to infer from a
   sentence someone may reword later. */
addColumn("orders", "wave_missed", "INTEGER");
db.exec("CREATE INDEX IF NOT EXISTS orders_wave ON orders(wave)");

var q = function (sql) { return db.prepare(sql); };

/* ---------- small helpers ---------- */

export function logEvent(orderId, kind, detail) {
  q("INSERT INTO events (at, order_id, kind, detail) VALUES (?,?,?,?)")
    .run(Date.now(), orderId || null, kind, detail == null ? null : String(detail));
}

/* Crockford base32 minus the vowels that turn into words and the glyphs that
   get misread aloud across a counter: no I, L, O, U. Read out as "K7M2 dash
   9QX4" it survives a noisy hall. */
var CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function pickupCode() {
  var bytes = randomBytes(8), out = "";
  for (var i = 0; i < 8; i++) {
    if (i === 4) out += "-";
    out += CODE_ALPHABET[bytes[i] % 32];
  }
  return out;
}

function orderId() { return randomUUID().replace(/-/g, "").slice(0, 16); }

/* SQLite has no boolean. Undefined and null both mean "not asked" and must stay
   NULL rather than collapsing into 0, which would read as "declined". */
function markValue(v) { return v == null ? null : (v ? 1 : 0); }

/* ---------- reads ---------- */

export function expireStaleHolds() {
  var now = Date.now();
  var rows = q("SELECT id FROM orders WHERE status='pending' AND hold_expires_at < ?").all(now);
  if (!rows.length) return 0;
  q("UPDATE orders SET status='expired' WHERE status='pending' AND hold_expires_at < ?").run(now);
  rows.forEach(function (r) { logEvent(r.id, "hold.expired", null); });
  return rows.length;
}

/* Slots that are gone: paid outright, or held by a live pending order.

   Wave one only, here and in paidCount. Both of these decide whether the run of
   fifteen is full, and a wave-two order is by definition not competing for it —
   counting one would close the run early and tell the page it had sold fifteen
   kimonos it has not made. */
export function takenCount() {
  var r = q(`SELECT COUNT(*) AS n FROM orders
             WHERE wave = 1 AND (status='paid' OR (status='pending' AND hold_expires_at >= ?))`)
    .get(Date.now());
  return r.n;
}

export function paidCount() {
  return q("SELECT COUNT(*) AS n FROM orders WHERE status='paid' AND wave = 1").get().n;
}

/* How many have committed to the second cut. This is the number the promise on
   the page is anchored to — wave two goes ahead once there are enough of these
   to cut it and reach Breakpoint on time. */
export function wave2Count() {
  return q("SELECT COUNT(*) AS n FROM orders WHERE status='paid' AND wave = 2").get().n;
}

/* Which wave a new order belongs in. Decided here rather than taken from the
   request: the client has no business choosing, and one that asked for wave one
   after the run filled would be asking for a piece that does not exist. */
export function currentWave() {
  expireStaleHolds();
  return takenCount() >= config.cap && config.waveTwo ? 2 : 1;
}

/* The leaderboard. Handles only — no names, no addresses, nothing that was
   given to us in confidence. A buyer who left no X handle stays anonymous. */
export function publicBuyers() {
  return q(`SELECT x_handle, piece_no FROM orders
            WHERE status='paid' AND wave = 1 ORDER BY piece_no DESC`).all()
    .map(function (r) { return { handle: r.x_handle || null, piece: r.piece_no }; });
}

export function getOrder(id) {
  return q("SELECT * FROM orders WHERE id = ?").get(id) || null;
}
export function getOrderByReference(ref) {
  return q("SELECT * FROM orders WHERE reference = ?").get(ref) || null;
}
export function getOrderBySignature(sig) {
  return q("SELECT * FROM orders WHERE tx_signature = ?").get(sig) || null;
}
export function getOrderByPickupCode(code) {
  return q("SELECT * FROM orders WHERE pickup_code = ?").get(String(code || "").toUpperCase()) || null;
}
export function ordersForWallet(wallet) {
  return q(`SELECT * FROM orders WHERE wallet = ? AND status IN ('pending','paid')
            ORDER BY created_at DESC`).all(wallet);
}
export function allOrders() {
  return q("SELECT * FROM orders ORDER BY created_at DESC").all();
}
export function recentEvents(limit) {
  return q("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit || 100);
}

/* The events table is append-only, so it is also the record of what has already
   been done to an order. The confirmation email asks it whether it has sent
   before: a buyer who reloads the confirm step, or a retry after a network
   blip, must not mean a second copy of the same pass in their inbox. */
export function hasEvent(orderId, kind) {
  return !!q("SELECT 1 FROM events WHERE order_id = ? AND kind = ? LIMIT 1").get(orderId, kind);
}

/* ---------- writes ---------- */

function tx(fn) {
  db.exec("BEGIN IMMEDIATE");
  try { var out = fn(); db.exec("COMMIT"); return out; }
  catch (e) { try { db.exec("ROLLBACK"); } catch (_) {} throw e; }
}

/* Reserves a slot and returns the pending order, or throws SOLD_OUT.
   The cap check and the insert are one transaction — checking first and
   inserting after is precisely the race this is here to close. */
export function createPendingOrder(fields) {
  return tx(function () {
    expireStaleHolds();
    /* Wave one is a fixed run and can run out. Wave two is confirmed by volume
       rather than capped by it, so there is no cap to check and nobody is turned
       away — which is the whole point of it existing. With wave two switched
       off, a full run is a closed shop again and this throws as it always did. */
    var full = takenCount() >= config.cap;
    var wave = full && config.waveTwo ? 2 : 1;
    if (wave === 1 && full) {
      var err = new Error("SOLD_OUT");
      err.code = "SOLD_OUT";
      throw err;
    }
    var now = Date.now();
    var row = {
      id: orderId(),
      status: "pending",
      piece_no: null,
      wallet: fields.wallet,
      name: fields.name,
      email: fields.email,
      x_handle: fields.x || null,
      tg_handle: fields.tg || null,
      amount_usdc: config.priceUsdc,
      reference: fields.reference,
      tx_signature: null,
      pickup_code: null,
      collected_at: null,
      collected_by: null,
      created_at: now,
      hold_expires_at: now + config.holdMinutes * 60000,
      paid_at: null,
      notes: null,
      mark: markValue(fields.mark),
      wave: wave,
      wave_no: null
    };
    q(`INSERT INTO orders (id,status,piece_no,wallet,name,email,x_handle,tg_handle,
         amount_usdc,reference,tx_signature,pickup_code,collected_at,collected_by,
         created_at,hold_expires_at,paid_at,notes,mark,wave,wave_no)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(row.id, row.status, row.piece_no, row.wallet, row.name, row.email,
           row.x_handle, row.tg_handle, row.amount_usdc, row.reference, row.tx_signature,
           row.pickup_code, row.collected_at, row.collected_by, row.created_at,
           row.hold_expires_at, row.paid_at, row.notes, row.mark, row.wave, row.wave_no);
    logEvent(row.id, "order.pending", row.wallet);
    return row;
  });
}

/* One wallet, one live hold. Without this a buyer who reopens the modal, or
   presses the button twice, takes a second piece off the board and holds it for
   twenty minutes — with fifteen pieces that empties the run in eight clicks.
   Returns null when the wallet has no live hold, so the caller can reserve. */
export function reusePendingOrder(wallet, fields) {
  return tx(function () {
    expireStaleHolds();
    var o = q(`SELECT * FROM orders WHERE wallet = ? AND status = 'pending'
               AND hold_expires_at >= ? ORDER BY created_at DESC LIMIT 1`).get(wallet, Date.now());
    if (!o) return null;
    /* A hold taken while the run still had stock is not a wave-two order, and
       the reverse is just as wrong. If the world changed underneath it, let it
       lapse and take a fresh one in the wave that is actually open. */
    if (o.wave === 1 && takenCount() >= config.cap) return null;
    var now = Date.now();
    /* The mark moves with the rest: reopening the modal is exactly where someone
       changes their mind about it, and a stale answer here is a wrong garment. */
    q(`UPDATE orders SET name=?, email=?, x_handle=?, tg_handle=?, reference=?, hold_expires_at=?, mark=?
       WHERE id=?`).run(fields.name, fields.email, fields.x || null, fields.tg || null,
                        fields.reference, now + config.holdMinutes * 60000,
                        markValue(fields.mark), o.id);
    logEvent(o.id, "order.reused", wallet);
    return q("SELECT * FROM orders WHERE id = ?").get(o.id);
  });
}

/* Records a verified payment. Assigns the piece number and the pickup code.
   Idempotent: confirming the same order twice returns the same row rather than
   burning a second piece, because the buyer's browser will retry. */
export function markPaid(orderId_, signature) {
  return tx(function () {
    var o = q("SELECT * FROM orders WHERE id = ?").get(orderId_);
    if (!o) { var e = new Error("NO_ORDER"); e.code = "NO_ORDER"; throw e; }
    if (o.status === "paid") return o;                       // already done
    if (o.status === "overflow") return o;                   // already flagged

    var clash = q("SELECT id FROM orders WHERE tx_signature = ? AND id <> ?").get(signature, orderId_);
    if (clash) { var e2 = new Error("SIGNATURE_USED"); e2.code = "SIGNATURE_USED"; throw e2; }

    var now = Date.now();

    /* Wave two settles differently, and the difference is the product. There is
       no piece number because there is no piece yet, and no pickup code because
       there is nothing at the counter to hand over — the cut is confirmed by
       volume first. What the buyer gets now is a place in the queue and the
       promise on the page: if wave two does not go ahead, the payment comes
       back in full. It also cannot overflow; wave two has no cap to exceed. */
    if (o.wave === 2) {
      var nextInWave = q(`SELECT COALESCE(MAX(wave_no), 0) + 1 AS n FROM orders
                          WHERE wave = 2 AND status = 'paid'`).get().n;
      q(`UPDATE orders SET status='paid', wave_no=?, tx_signature=?, paid_at=? WHERE id=?`)
        .run(nextInWave, signature, now, orderId_);
      logEvent(orderId_, "order.paid.wave2", signature);
      return q("SELECT * FROM orders WHERE id = ?").get(orderId_);
    }

    /* The hold may have lapsed while the transaction confirmed, and the last
       piece can go in those few seconds. The money is real either way, so the
       payment is taken and only the piece is refused.

       Where that lands depends on whether there is a second cut to land in.
       With wave two open the order moves into it rather than becoming a refund:
       they wanted this kimono enough to pay for it, and wave two is the next one
       being made. It is a conversion, not a purchase they made — so it is
       recorded as one, the confirmation says the piece was missed and offers the
       refund outright, and they can take it at a word until the cut is
       confirmed. With wave two off there is nowhere to put them, and the money
       goes back. */
    if (paidCount() >= config.cap) {
      if (config.waveTwo) {
        var nextAfterMiss = q(`SELECT COALESCE(MAX(wave_no), 0) + 1 AS n FROM orders
                               WHERE wave = 2 AND status = 'paid'`).get().n;
        q(`UPDATE orders SET status='paid', wave=2, wave_no=?, wave_missed=1, tx_signature=?, paid_at=?,
             notes='Paid as the run sold out — moved to wave two, refundable on request.'
           WHERE id=?`).run(nextAfterMiss, signature, now, orderId_);
        /* Its own kind, so the trail says this row was converted rather than
           chosen — the route reads it back to send the right letter, and it is
           the first thing to look for if this buyer asks for their money. */
        logEvent(orderId_, "order.overflow.wave2", signature);
        return q("SELECT * FROM orders WHERE id = ?").get(orderId_);
      }
      q(`UPDATE orders SET status='overflow', tx_signature=?, paid_at=?,
           notes='Paid after the run sold out — refund owed.' WHERE id=?`)
        .run(signature, now, orderId_);
      logEvent(orderId_, "order.overflow", signature);
      return q("SELECT * FROM orders WHERE id = ?").get(orderId_);
    }

    var next = q("SELECT COALESCE(MAX(piece_no), 0) + 1 AS n FROM orders").get().n;
    var code = pickupCode();
    while (q("SELECT 1 AS x FROM orders WHERE pickup_code = ?").get(code)) code = pickupCode();

    q(`UPDATE orders SET status='paid', piece_no=?, tx_signature=?, pickup_code=?, paid_at=?
       WHERE id=?`).run(next, signature, code, now, orderId_);
    logEvent(orderId_, "order.paid", signature);
    return q("SELECT * FROM orders WHERE id = ?").get(orderId_);
  });
}

export function markCollected(orderId_, by) {
  return tx(function () {
    var o = q("SELECT * FROM orders WHERE id = ?").get(orderId_);
    if (!o) { var e = new Error("NO_ORDER"); e.code = "NO_ORDER"; throw e; }
    if (o.status !== "paid") { var e2 = new Error("NOT_PAID"); e2.code = "NOT_PAID"; throw e2; }
    if (o.collected_at) return o;  // idempotent — a second scan is not an error
    q("UPDATE orders SET collected_at=?, collected_by=? WHERE id=?").run(Date.now(), by || "staff", orderId_);
    logEvent(orderId_, "order.collected", by || "staff");
    return q("SELECT * FROM orders WHERE id = ?").get(orderId_);
  });
}

export function cancelOrder(orderId_) {
  q("UPDATE orders SET status='cancelled' WHERE id=? AND status='pending'").run(orderId_);
  logEvent(orderId_, "order.cancelled", null);
}

/* ---------- sign-in nonces ---------- */

export function issueNonce() {
  var nonce = randomBytes(16).toString("hex");
  q("INSERT INTO nonces (nonce, created_at) VALUES (?,?)").run(nonce, Date.now());
  return nonce;
}

/* Single-use, five-minute window. Returns false for replay or expiry. */
export function consumeNonce(nonce) {
  return tx(function () {
    var row = q("SELECT * FROM nonces WHERE nonce = ?").get(nonce);
    if (!row || row.used_at) return false;
    if (Date.now() - row.created_at > 5 * 60000) return false;
    q("UPDATE nonces SET used_at = ? WHERE nonce = ?").run(Date.now(), nonce);
    return true;
  });
}

export function sweepNonces() {
  q("DELETE FROM nonces WHERE created_at < ?").run(Date.now() - 24 * 3600000);
}
