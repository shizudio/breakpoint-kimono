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
  mark            INTEGER
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

/* Slots that are gone: paid outright, or held by a live pending order. */
export function takenCount() {
  var r = q(`SELECT COUNT(*) AS n FROM orders
             WHERE status='paid' OR (status='pending' AND hold_expires_at >= ?)`).get(Date.now());
  return r.n;
}

export function paidCount() {
  return q("SELECT COUNT(*) AS n FROM orders WHERE status='paid'").get().n;
}

/* The leaderboard. Handles only — no names, no addresses, nothing that was
   given to us in confidence. A buyer who left no X handle stays anonymous. */
export function publicBuyers() {
  return q(`SELECT x_handle, piece_no FROM orders
            WHERE status='paid' ORDER BY piece_no DESC`).all()
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
    if (takenCount() >= config.cap) {
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
      mark: markValue(fields.mark)
    };
    q(`INSERT INTO orders (id,status,piece_no,wallet,name,email,x_handle,tg_handle,
         amount_usdc,reference,tx_signature,pickup_code,collected_at,collected_by,
         created_at,hold_expires_at,paid_at,notes,mark)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(row.id, row.status, row.piece_no, row.wallet, row.name, row.email,
           row.x_handle, row.tg_handle, row.amount_usdc, row.reference, row.tx_signature,
           row.pickup_code, row.collected_at, row.collected_by, row.created_at,
           row.hold_expires_at, row.paid_at, row.notes, row.mark);
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
    /* The hold may have lapsed while the transaction confirmed. The money is
       real either way, so we take the payment and only refuse a piece if the
       run is genuinely full — that case becomes a refund, not a silent loss. */
    if (paidCount() >= config.cap) {
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
