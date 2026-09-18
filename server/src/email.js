/* The buyer's confirmation.

   Same contract as telegram.js, and for the same reason: a sale is recorded the
   moment SQLite commits, and nothing about telling anyone may stand between the
   buyer and their confirmation screen. Every send is fire-and-forget and every
   failure is logged, never thrown. If the provider is down the buyer still sees
   their pass on screen and can always reopen it with the wallet that paid — the
   email is a convenience, not the system of record.

   What goes in it is a deliberate loosening. The pickup code is a bearer token
   for a physical object, and the rest of this codebase keeps it out of URLs,
   logs and Referer headers on purpose. Email is none of those things: it sits
   in an inbox, gets forwarded, and outlives the device it was read on. It is in
   here anyway because the alternative — a buyer at a counter in a hall with no
   signal, asked to connect a wallet — fails more often and more visibly. The
   mitigation is at the counter, not here: staff ask for a name, and a name is
   in the ledger while a passer-by with a forwarded email does not have one. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { config, explorerTx } from "./config.js";
import { logEvent, hasEvent } from "./db.js";
import { pickupQrPng } from "./qr.js";

var enabled = !!(config.resendKey && config.emailFrom);

export function emailEnabled() { return enabled; }

/* The order card, attached rather than linked.

   A remote <img> would depend on the front end being up and on the same origin
   as the API, which it is not in the split deployment — and a mail client that
   blocks remote images would leave a hole where the card is. Read once at
   startup: the file does not change under a running server, and a send is not
   the moment to discover it is missing.

   Missing is survivable. The card is the brand; the code underneath it is the
   thing that gets someone a kimono, so a confirmation still goes out without
   it, with the frame collapsed rather than a broken image in its place. */
var CARD_PATH = config.emailCardImage
  ? config.emailCardImage
  : fileURLToPath(new URL("../../site/public/web/share-card.jpg", import.meta.url));
var cardImage = null;
try {
  cardImage = readFileSync(CARD_PATH);
} catch (e) {
  console.error("[email] order card image not found at " + CARD_PATH + " — sending without it");
}

/* Overridable so the suite can point this at a local endpoint and assert what
   actually goes out. Nothing else should ever set it. */
var API = process.env.RESEND_API || "https://api.resend.com";

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* What the buyer chose for the inner pocket, in the words the panel used.
   Null is "never asked" — an order taken before the question existed — and says
   so rather than claiming they declined. */
function markLine(order) {
  if (order.mark == null) return null;
  return order.mark ? "Solana mark" : "No mark";
}

/* "Shina Foo" -> "Shina". A confirmation that opens with someone's full legal
   name reads like a letter from a bank. */
function firstName(name) {
  return String(name || "").trim().split(/\s+/)[0] || "there";
}

function shortWallet(w) {
  var v = String(w || "");
  return v.length > 12 ? v.slice(0, 4) + "…" + v.slice(-4) : v;
}

async function send(payload) {
  if (!enabled) return false;
  try {
    var res = await fetch(API + "/emails", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + config.resendKey
      },
      body: JSON.stringify(payload),
      /* Longer than Telegram's: this request carries the QR image with it. */
      signal: AbortSignal.timeout(20000)
    });
    if (!res.ok) {
      var body = await res.text().catch(function () { return ""; });
      console.error("[email] send failed", res.status, body.slice(0, 200));
      return { ok: false, detail: res.status + " " + body.slice(0, 200) };
    }
    var out = await res.json().catch(function () { return {}; });
    return { ok: true, id: out.id || "" };
  } catch (e) {
    console.error("[email] send error", e.message);
    return { ok: false, detail: e.message };
  }
}

/* ---------- the confirmation sheet ---------- */

/* The panel's palette, flattened.

   The site is black ground, off-white ink, and one purple. Its panel builds the
   softer greys out of rgba() over that black, which Outlook will not do — so
   each one is precomputed here against #000 at the opacity the stylesheet uses.
   Change a value in site/index.html and the matching constant here has to move
   with it; there is no way for an email to read the page's variables. */
var GROUND = "#000000",
    INK    = "#F7F4EE",
    INK_72 = "#B2B0AB",   /* --ink at .72, body copy */
    INK_45 = "#6F6E6B",   /* at .45, labels */
    INK_40 = "#636260",   /* at .40, the card-meta label */
    HAIR   = "#1E1E1D",   /* --hair, rgba(247,244,238,.12) */
    ACCENT = "#9945FF",
    LINK   = "#9B89A3";

/* Cormorant Garamond is a webfont; a mail client will not fetch it, and the one
   that has it installed is the exception. Georgia is the fallback the page
   already names, and it is the closest thing to the display face that ships on
   every machine. DM Sans falls back the same way. */
var ED = "'Cormorant Garamond',Georgia,'Times New Roman',serif";
var UI = "'DM Sans',-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";
var MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

export function sheetHtml(order) {
  var piece = order.piece_no, n = config.cap;
  var handle = order.x_handle ? "@" + esc(order.x_handle) : "@you";
  var tx = explorerTx(order.tx_signature);

  /* Tables, bgcolor attributes and inline styles throughout: this has to hold
     its shape in Outlook, which has no flexbox, no grid and no rgba. */
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">
<title>Piece ${piece} of ${n}</title></head>
<body style="margin:0;padding:0;background:${GROUND};color:${INK};" bgcolor="${GROUND}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Piece ${piece} of ${n} is yours. Your claim code is inside — keep this email.</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${GROUND}" style="background:${GROUND};">
<tr><td align="center" style="padding:44px 16px;">
<table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;">

  <!-- .eyebrow -->
  <tr><td style="font:300 9px/1.4 ${UI};letter-spacing:.34em;text-transform:uppercase;color:${ACCENT};padding-bottom:14px;">
    Reserved
  </td></tr>

  <!-- the panel title -->
  <tr><td style="font:300 32px/1.2 ${ED};color:${INK};padding-bottom:22px;">
    Piece ${piece} is yours.
  </td></tr>

  <tr><td style="font:300 14.5px/1.75 ${UI};color:${INK_72};padding-bottom:10px;">
    Thank you for being one of the first to own the 2026 Breakpoint Kimono,
    ${esc(firstName(order.name))}.
  </td></tr>
  <tr><td style="font:300 14.5px/1.75 ${UI};color:${INK_72};padding-bottom:28px;">
    Keep this email to claim yours at Breakpoint. We will update you on the
    claiming venue soon.
  </td></tr>

  <!-- .card-frame — the order card, exactly as it appears in the panel -->
  <tr><td style="border:1px solid ${HAIR};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      ${cardImage ? `<tr><td style="font-size:0;line-height:0;">
        <img src="cid:order-card" width="518" alt="The 2026 Breakpoint Kimono — reserved"
             style="display:block;width:100%;max-width:518px;height:auto;border:0;background:#0E0E0E;">
      </td></tr>` : ""}
      <!-- .card-meta -->
      <tr><td style="border-top:1px solid ${HAIR};padding:11px 14px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td align="left" style="font:300 9px/1.4 ${UI};letter-spacing:.28em;text-transform:uppercase;color:${INK_40};">
            Your order card
          </td>
          <td align="right" style="font:300 11px/1.4 ${UI};letter-spacing:.06em;color:${INK_72};">
            ${handle} · piece ${piece} of ${n}
          </td>
        </tr></table>
      </td></tr>
    </table>
  </td></tr>

  <tr><td style="height:17px;line-height:17px;font-size:0;">&nbsp;</td></tr>

  <!-- .pass — the QR and the code, side by side as in the panel -->
  <tr><td style="border:1px solid ${HAIR};padding:14px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td width="104" valign="middle" style="width:104px;padding-right:16px;">
          <!-- .pass .qr — light ground under the code, as on the page -->
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" bgcolor="${INK}"
                 style="background:${INK};"><tr><td style="padding:7px;font-size:0;line-height:0;">
            <img src="cid:pickup-qr" width="90" height="90" alt="Claim QR for piece ${piece}"
                 style="display:block;width:90px;height:90px;border:0;">
          </td></tr></table>
        </td>
        <td valign="middle">
          <!-- .pass .lbl -->
          <div style="font:300 9px/1.4 ${UI};letter-spacing:.3em;text-transform:uppercase;color:${INK_45};">
            Claim at Breakpoint
          </div>
          <!-- .pass .code -->
          <div style="font:400 20px/1.3 ${MONO};letter-spacing:.14em;color:${INK};padding-top:5px;">
            ${esc(order.pickup_code)}
          </div>
        </td>
      </tr>
    </table>
    <!-- .keepsafe -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:11px;">
      <tr><td style="border-left:2px solid ${ACCENT};padding:10px 12px;font:300 11.5px/1.7 ${UI};color:${INK_72};">
        <span style="color:${INK};">Keep this like a ticket.</span> Anyone who reads
        this code can claim piece ${piece} — do not post it, and do not forward
        this email.
      </td></tr>
    </table>
  </td></tr>

  <tr><td style="height:20px;line-height:20px;font-size:0;">&nbsp;</td></tr>

  <!-- .ordrow — the garment first, then the receipt -->
  ${markLine(order) ? `<tr><td style="border-bottom:1px solid ${HAIR};padding:9px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td align="left" style="font:300 12px/1.5 ${UI};letter-spacing:.06em;color:${INK_45};">Inner pocket</td>
      <td align="right" style="font:300 12px/1.5 ${UI};color:${INK};">${esc(markLine(order))}</td>
    </tr></table>
  </td></tr>` : ""}
  <tr><td style="border-bottom:1px solid ${HAIR};padding:9px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td align="left" style="font:300 12px/1.5 ${UI};letter-spacing:.06em;color:${INK_45};">Confirmation to</td>
      <td align="right" style="font:300 12px/1.5 ${UI};color:${INK};word-break:break-word;">${esc(order.email)}</td>
    </tr></table>
  </td></tr>
  <tr><td style="border-bottom:1px solid ${HAIR};padding:9px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td align="left" style="font:300 12px/1.5 ${UI};letter-spacing:.06em;color:${INK_45};">Paid</td>
      <td align="right" style="font:300 12px/1.5 ${UI};color:${INK};">
        ${config.priceUsdc} USDC
        <span style="color:${HAIR};padding:0 8px;">·</span>
        <a href="${esc(tx)}" style="color:${LINK};text-decoration:none;">on chain ↗</a>
      </td>
    </tr></table>
  </td></tr>

  <tr><td style="font:300 12.5px/1.8 ${UI};color:${INK_72};padding-top:26px;">
    If you'd like to get a refund, contact
    <a href="https://x.com/shizudio" style="color:${LINK};text-decoration:none;">@shizudio</a> on X or
    <a href="https://t.me/shina_foo" style="color:${LINK};text-decoration:none;">@shina_foo</a> on Telegram.
  </td></tr>

  <tr><td style="font:300 9px/1.4 ${UI};letter-spacing:.3em;text-transform:uppercase;color:${INK_40};padding-top:30px;">
    Shizudio · Order ${esc(order.id)}
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
}

export function sheetText(order) {
  return [
    "Piece " + order.piece_no + " is yours.",
    "",
    "Thank you for being one of the first to own the 2026 Breakpoint Kimono, " +
      firstName(order.name) + ".",
    "",
    "Keep this email to claim yours at Breakpoint. We will update you on the",
    "claiming venue soon.",
    "",
    "CLAIM CODE   " + order.pickup_code,
    "",
    "Keep this like a ticket. Anyone who reads this code can claim piece " +
      order.piece_no + " — do not post it, and do not forward this email.",
    "(The QR attached to this email carries the same code.)",
    "",
    markLine(order) ? "Inner pocket      " + markLine(order) : null,
    "Confirmation to   " + order.email,
    "Paid              " + config.priceUsdc + " USDC",
    "On chain          " + explorerTx(order.tx_signature),
    "Piece             " + order.piece_no + " of " + config.cap,
    "Order             " + order.id,
    "",
    "If you'd like to get a refund, contact @shizudio on X or @shina_foo on Telegram."
  ].filter(function (l) { return l !== null; }).join("\n");
}

/* ---------- wave two ---------- */

/* A different letter, because a different thing was bought. There is no pickup
   code and no QR: nothing exists to collect yet, and a pass for a garment that
   may not be cut would be worse than no pass at all. What this has to carry
   instead is the condition and the refund, stated plainly and early — the buyer
   has paid in full for something conditional, and the page said so, so the
   confirmation must say so too rather than reading like a normal receipt. */
export function waveTwoHtml(order, opts) {
  var missed = !!(opts && opts.missed);
  var tx = explorerTx(order.tx_signature);
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">
<title>${missed ? "You just missed the run" : "You are in wave two"}</title></head>
<body style="margin:0;padding:0;background:${GROUND};color:${INK};" bgcolor="${GROUND}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Your place in the second cut is held. If it does not go ahead, your payment comes back in full.</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${GROUND}" style="background:${GROUND};">
<tr><td align="center" style="padding:44px 16px;">
<table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;">

  <tr><td style="font:300 9px/1.4 ${UI};letter-spacing:.34em;text-transform:uppercase;color:${ACCENT};padding-bottom:14px;">
    Wave two
  </td></tr>

  <tr><td style="font:300 32px/1.2 ${ED};color:${INK};padding-bottom:22px;">
    ${missed ? "You missed it by seconds." : "You are in wave two."}
  </td></tr>

  ${missed ? `<tr><td style="font:300 14.5px/1.75 ${UI};color:${INK_72};padding-bottom:10px;">
    ${esc(firstName(order.name))}, the fifteenth piece went while your payment
    was confirming — by seconds. Your ${config.priceUsdc} USDC arrived and we
    have it.
  </td></tr>
  <tr><td style="font:300 14.5px/1.75 ${UI};color:${INK_72};padding-bottom:28px;">
    Rather than simply send it back, we have put you first in wave two, the next
    cut of the same kimono. That is our doing, not something you chose — so if
    you would rather have the refund, say the word and it goes back the same day.
  </td></tr>` : `<tr><td style="font:300 14.5px/1.75 ${UI};color:${INK_72};padding-bottom:10px;">
    Thank you for backing a second cut of the 2026 Breakpoint Kimono,
    ${esc(firstName(order.name))}. The first fifteen went, and you are in the
    run that follows them.
  </td></tr>
  <tr><td style="font:300 14.5px/1.75 ${UI};color:${INK_72};padding-bottom:28px;">
    We confirm wave two once enough orders come in to cut it and reach
    Breakpoint on time. You will hear either way.
  </td></tr>`}

  ${cardImage ? `<tr><td style="border:1px solid ${HAIR};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td style="font-size:0;line-height:0;">
        <img src="cid:order-card" width="518" alt="The 2026 Breakpoint Kimono"
             style="display:block;width:100%;max-width:518px;height:auto;border:0;background:#0E0E0E;">
      </td></tr>
    </table>
  </td></tr>
  <tr><td style="height:20px;line-height:20px;font-size:0;">&nbsp;</td></tr>` : ""}

  <!-- the condition, in the place a pickup pass would have been -->
  <tr><td style="border-left:2px solid ${ACCENT};padding:14px 16px;font:300 13px/1.8 ${UI};color:${INK_72};">
    <span style="color:${INK};">If wave two does not go ahead, your ${config.priceUsdc} USDC
    comes back in full.</span> You do not have to ask, and you can cancel any
    time before it is confirmed by replying to this email.
  </td></tr>

  <tr><td style="height:20px;line-height:20px;font-size:0;">&nbsp;</td></tr>

  <tr><td style="border-bottom:1px solid ${HAIR};padding:9px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td align="left" style="font:300 12px/1.5 ${UI};letter-spacing:.06em;color:${INK_45};">Wave two, order</td>
      <td align="right" style="font:300 12px/1.5 ${UI};color:${INK};">no. ${order.wave_no}</td>
    </tr></table>
  </td></tr>
  ${markLine(order) ? `<tr><td style="border-bottom:1px solid ${HAIR};padding:9px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td align="left" style="font:300 12px/1.5 ${UI};letter-spacing:.06em;color:${INK_45};">Inner pocket</td>
      <td align="right" style="font:300 12px/1.5 ${UI};color:${INK};">${esc(markLine(order))}</td>
    </tr></table>
  </td></tr>` : ""}
  <tr><td style="border-bottom:1px solid ${HAIR};padding:9px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td align="left" style="font:300 12px/1.5 ${UI};letter-spacing:.06em;color:${INK_45};">Paid</td>
      <td align="right" style="font:300 12px/1.5 ${UI};color:${INK};">
        ${config.priceUsdc} USDC
        <span style="color:${HAIR};padding:0 8px;">·</span>
        <a href="${esc(tx)}" style="color:${LINK};text-decoration:none;">on chain ↗</a>
      </td>
    </tr></table>
  </td></tr>

  <tr><td style="font:300 12.5px/1.8 ${UI};color:${INK_72};padding-top:26px;">
    Questions, or want to cancel? Reply here, or
    <a href="https://x.com/shizudio" style="color:${LINK};text-decoration:none;">@shizudio</a> on X.
  </td></tr>

  <tr><td style="font:300 9px/1.4 ${UI};letter-spacing:.3em;text-transform:uppercase;color:${INK_40};padding-top:30px;">
    Shizudio · Order ${esc(order.id)}
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
}

export function waveTwoText(order, opts) {
  var missed = !!(opts && opts.missed);
  var lead = missed ? [
    "You missed it by seconds.",
    "",
    firstName(order.name) + ", the fifteenth piece went while your payment was",
    "confirming. Your " + config.priceUsdc + " USDC arrived and we have it.",
    "",
    "Rather than simply send it back, we have put you first in wave two, the next",
    "cut of the same kimono. That is our doing, not something you chose — so if",
    "you would rather have the refund, say the word and it goes back the same day."
  ] : [
    "You are in wave two.",
    "",
    "Thank you for backing a second cut of the 2026 Breakpoint Kimono, " +
      firstName(order.name) + ". The first fifteen went, and you are in the run",
    "that follows them.",
    "",
    "We confirm wave two once enough orders come in to cut it and reach",
    "Breakpoint on time. You will hear either way."
  ];
  return lead.concat([
    "",
    "IF WAVE TWO DOES NOT GO AHEAD, YOUR " + config.priceUsdc + " USDC COMES BACK IN FULL.",
    "You do not have to ask, and you can cancel any time before it is confirmed",
    "by replying to this email.",
    "",
    "Wave two, order   no. " + order.wave_no,
    markLine(order) ? "Inner pocket      " + markLine(order) : null,
    "Paid              " + config.priceUsdc + " USDC",
    "On chain          " + explorerTx(order.tx_signature),
    "Order             " + order.id,
    "",
    "Questions, or want to cancel? Reply here, or @shizudio on X."
  ]).filter(function (l) { return l !== null; }).join("\n");
}

/* Same contract as the pass: fire-and-forget, refused if it has already gone,
   and unable to fail the sale. */
export async function sendWaveTwoConfirmation(order, opts) {
  var force = !!(opts && opts.force);
  if (!enabled) return { ok: false, reason: "DISABLED" };
  if (!order || order.status !== "paid" || order.wave !== 2) {
    return { ok: false, reason: "NOT_WAVE_TWO" };
  }
  /* Whether they chose wave two or were moved into it after missing the run by
     seconds. Two different things happened to them, so two different letters. */
  var missed = !!(opts && opts.missed);
  if (!force && hasEvent(order.id, "email.sent")) return { ok: false, reason: "ALREADY_SENT" };

  var payload = {
    from: config.emailFrom,
    to: [order.email],
    subject: missed
      ? "You missed the run by seconds — your options"
      : "You are in wave two — the second cut of the Breakpoint Kimono",
    html: waveTwoHtml(order, { missed: missed }),
    text: waveTwoText(order, { missed: missed }),
    attachments: []
  };
  if (cardImage) payload.attachments.push({
    filename: "breakpoint-kimono.jpg",
    content: cardImage.toString("base64"),
    content_type: "image/jpeg",
    content_id: "order-card"
  });
  if (config.emailReplyTo) payload.reply_to = config.emailReplyTo;
  if (config.emailBcc) payload.bcc = [config.emailBcc];

  var out = await send(payload);
  if (!out || !out.ok) {
    logEvent(order.id, "email.failed", (out && out.detail) || "unknown");
    return { ok: false, reason: "SEND_FAILED", detail: out && out.detail };
  }
  logEvent(order.id, "email.sent", order.email + (out.id ? " " + out.id : ""));
  return { ok: true, id: out.id };
}

/* The one call the confirm route makes. Returns a reason rather than throwing,
   so the caller can log it and get on with answering the buyer.

   `force` is for the admin resend button and nothing else: it is the only way
   past the already-sent guard, which exists because a buyer who reloads the
   confirm step must not get a second pass in their inbox. */
export async function sendConfirmation(order, opts) {
  var force = !!(opts && opts.force);
  if (!enabled) return { ok: false, reason: "DISABLED" };
  if (!order || order.status !== "paid" || !order.pickup_code) {
    return { ok: false, reason: "NOT_PAID" };
  }
  if (!force && hasEvent(order.id, "email.sent")) return { ok: false, reason: "ALREADY_SENT" };

  var png;
  try {
    png = await pickupQrPng(order);
  } catch (e) {
    logEvent(order.id, "email.failed", "qr " + e.message);
    return { ok: false, reason: "QR_FAILED" };
  }

  var payload = {
    from: config.emailFrom,
    to: [order.email],
    subject: "Piece " + order.piece_no + " of " + config.cap + " is yours — keep this to claim it",
    html: sheetHtml(order),
    text: sheetText(order),
    attachments: [{
      filename: "claim-piece-" + order.piece_no + ".png",
      content: png.toString("base64"),
      content_type: "image/png",
      /* Inline, so the pass shows in the body — and still an attachment, so a
         client that refuses inline images leaves something to save. */
      content_id: "pickup-qr"
    }]
  };
  if (cardImage) payload.attachments.push({
    filename: "breakpoint-kimono.jpg",
    content: cardImage.toString("base64"),
    content_type: "image/jpeg",
    content_id: "order-card"
  });
  if (config.emailReplyTo) payload.reply_to = config.emailReplyTo;
  if (config.emailBcc) payload.bcc = [config.emailBcc];

  var out = await send(payload);
  if (!out || !out.ok) {
    logEvent(order.id, "email.failed", (out && out.detail) || "unknown");
    return { ok: false, reason: "SEND_FAILED", detail: out && out.detail };
  }
  /* Recorded against the order, not just the console: at a counter, "did they
     ever get the email?" is a question the ledger should be able to answer. */
  logEvent(order.id, "email.sent", order.email + (out.id ? " " + out.id : ""));
  return { ok: true, id: out.id };
}
