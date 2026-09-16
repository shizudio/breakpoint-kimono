/* Telegram notifications.

   Deliberately best-effort: a sale is recorded the moment SQLite commits, and
   nothing about telling you may stand between the buyer and their confirmation
   screen. Every send is fire-and-forget and every failure is logged, never
   thrown. */

import { config, explorerTx } from "./config.js";
import { logEvent } from "./db.js";

var enabled = !!(config.telegramToken && config.telegramChat);

export function telegramEnabled() { return enabled; }

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* Overridable so the suite can point this at a local endpoint and assert that
   each notification really goes out. Nothing else should ever set it. */
var API = process.env.TELEGRAM_API || "https://api.telegram.org";

async function send(html) {
  if (!enabled) return false;
  try {
    var res = await fetch(API + "/bot" + config.telegramToken + "/sendMessage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: config.telegramChat,
        text: html,
        parse_mode: "HTML",
        disable_web_page_preview: true
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) {
      var body = await res.text().catch(function () { return ""; });
      console.error("[telegram] send failed", res.status, body.slice(0, 200));
      logEvent(null, "telegram.failed", res.status + " " + body.slice(0, 200));
      return false;
    }
    return true;
  } catch (e) {
    console.error("[telegram] send error", e.message);
    logEvent(null, "telegram.error", e.message);
    return false;
  }
}

export function notifyPaid(order) {
  var lines = [
    "<b>Piece " + order.piece_no + " of " + config.cap + " reserved</b>",
    "",
    esc(order.name),
    esc(order.email),
    order.x_handle ? "X: @" + esc(order.x_handle) : null,
    order.tg_handle ? "TG: @" + esc(order.tg_handle) : null,
    "",
    "Pickup code: <code>" + esc(order.pickup_code) + "</code>",
    "Order: <code>" + esc(order.id) + "</code>",
    config.priceUsdc + " USDC · <a href=\"" + explorerTx(order.tx_signature) + "\">transaction</a>",
    "",
    (config.cap - order.piece_no) + " left"
  ];
  return send(lines.filter(function (l) { return l !== null; }).join("\n"));
}

/* Someone paid after the last piece was claimed. This is the message that has
   to arrive: there is money in the treasury that owes a refund. */
export function notifyOverflow(order) {
  return send([
    "<b>⚠ Payment after sell-out — refund owed</b>",
    "",
    esc(order.name) + " · " + esc(order.email),
    order.x_handle ? "X: @" + esc(order.x_handle) : null,
    "Wallet: <code>" + esc(order.wallet) + "</code>",
    config.priceUsdc + " USDC · <a href=\"" + explorerTx(order.tx_signature) + "\">transaction</a>",
    "",
    "Refund to the wallet above."
  ].filter(function (l) { return l !== null; }).join("\n"));
}

/* Sent the moment a piece leaves the table. Repeat scans of the same code do
   not resend: handing over is idempotent, and a buyer whose code gets scanned
   twice at a busy counter should not read as a second kimono going out. */
export function notifyCollected(order, by, remaining) {
  var who = shortWallet(by);
  return send([
    "<b>Piece " + order.piece_no + " of " + config.cap + " handed over</b>",
    "",
    esc(order.name) + (order.x_handle ? " · @" + esc(order.x_handle) : ""),
    "Code: <code>" + esc(order.pickup_code) + "</code>",
    "",
    "Released by <code>" + esc(who) + "</code>",
    new Date(order.collected_at || Date.now()).toLocaleString("en-GB", { timeZone: "Asia/Singapore" }) + " SGT",
    "",
    remaining === 0 ? "That was the last one." : remaining + " still to hand over"
  ].join("\n"));
}

/* Admin wallets are 44 characters and unreadable on a phone. The first and last
   four are enough to tell two people at a counter apart. */
function shortWallet(w) {
  var v = String(w || "");
  return v.length > 12 ? v.slice(0, 4) + "…" + v.slice(-4) : v;
}

export async function notifyStartup(state) {
  return send([
    "<b>Presale server up</b>",
    config.network + " · " + state.sold + "/" + config.cap + " sold",
    "Treasury: <code>" + esc(config.treasury) + "</code>"
  ].join("\n"));
}
