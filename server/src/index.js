/* The presale server.

   Serves site/ and the API behind it, from one origin — which is what lets the
   session ride in a SameSite=Lax cookie instead of a token the page has to
   hold. Nothing here returns RPC_URL or SESSION_SECRET, and the
   browser never learns any of the three. */

import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { config, explorerTx } from "./config.js";
import * as store from "./db.js";
import { startSignIn, verifySignIn, mintToken, cookieHeader, walletFromRequest } from "./session.js";
import { newReference, buildPaymentTransaction, verifyPayment, usdcBalance, rpcHealth, AMOUNT } from "./solana.js";
import { notifyPaid, notifyOverflow, notifyCollected, notifyStartup, notifyWaveTwo, telegramEnabled } from "./telegram.js";
import { sendConfirmation, sendWaveTwoConfirmation, emailEnabled } from "./email.js";
import { pickupQrSvg } from "./qr.js";
import { avatarUrl, avatarFile, warmAvatars, fetchAvatar, avatarsEnabled, validHandle } from "./avatars.js";
import { json, fail, readJson, validateOrder, rateLimit, clientIp, publicOrder } from "./util.js";
import { serveStatic } from "./static.js";
import { isSignature } from "./base58.js";

var TRUST_PROXY = process.env.TRUST_PROXY === "1";
var adminHtml = readFileSync(fileURLToPath(new URL("./admin.html", import.meta.url)), "utf8");

function requireWallet(req, res) {
  var wallet = walletFromRequest(req);
  if (!wallet) { fail(res, 401, "NO_SESSION", "Connect your wallet first."); return null; }
  return wallet;
}

export function isAdminWallet(wallet) {
  return !!wallet && config.adminWallets.indexOf(wallet) !== -1;
}

/* The ledger carries every buyer's name, email and wallet. Reaching it needs a
   wallet signature from an address named in ADMIN_WALLETS — the same sign-in
   the buyers go through, checked against a list. There is no token, no header
   and no shared secret: nothing an onlooker can read off a screen, and nothing
   that keeps working after it has been pasted into a chat. */
function requireAdmin(req, res) {
  var wallet = walletFromRequest(req);
  if (!wallet) {
    fail(res, 401, "NO_SESSION", "Connect an admin wallet first.");
    return null;
  }
  if (!isAdminWallet(wallet)) {
    // Deliberately the same sentence either way: a wrong wallet learns nothing
    // about whether it guessed a real one.
    fail(res, 403, "NOT_ADMIN", "That wallet cannot open the ledger.");
    return null;
  }
  return wallet;
}

function presaleOver() { return Date.now() > config.presaleEndsAt; }

/* The buyer list, each with a picture if we have one. Whatever is missing is
   fetched in the background and turns up on the next load — which is also how
   orders taken before any of this existed get one. */
function buyersWithAvatars() {
  var buyers = store.publicBuyers();
  warmAvatars(buyers.map(function (b) { return b.handle; }).filter(Boolean));
  return buyers.map(function (b) {
    return { handle: b.handle, piece: b.piece, avatar: b.handle ? avatarUrl(b.handle) : null };
  });
}

function stateBody(wallet) {
  store.expireStaleHolds();
  var sold = store.paidCount();
  return {
    cap: config.cap,
    sold: sold,
    taken: store.takenCount(),
    soldOut: sold >= config.cap,
    priceUsdc: config.priceUsdc,
    currency: "USDC",
    network: config.network,
    presaleEndsAt: config.presaleEndsAt,
    presaleOver: presaleOver(),
    buyers: buyersWithAvatars(),
    /* The run is what sells out; wave two is what opens when it does. Both
       numbers go out so the page can say which shop it is showing without a
       second request. */
    waveTwo: config.waveTwo,
    wave: store.currentWave(),
    wave2Count: store.wave2Count(),
    wallet: wallet || null
  };
}

/* ---------- routes ---------- */

var routes = [];
function route(method, pattern, handler) {
  routes.push({ method: method, pattern: pattern, handler: handler });
}

route("GET", /^\/api\/state$/, async function (req, res) {
  json(res, 200, stateBody(walletFromRequest(req)));
});

route("GET", /^\/api\/health$/, async function (req, res) {
  json(res, 200, {
    ok: true,
    network: config.network,
    telegram: telegramEnabled(),
    email: emailEnabled(),
    avatars: avatarsEnabled(),
    rpc: await rpcHealth(),      // reports reachability, never the URL
    sold: store.paidCount(),
    cap: config.cap
  });
});

/* The cached picture. Served from here rather than from the front end because
   this is where it lands, and under /api/ so the reverse proxy already forwards
   it. The handle is matched by the route itself, so nothing shaped like a path
   ever reaches the filesystem. */
route("GET", /^\/api\/avatars\/([A-Za-z0-9_]{1,15})\.jpg$/, async function (req, res, m) {
  var file = avatarFile(m[1]);
  if (!file || !existsSync(file)) return fail(res, 404, "NO_AVATAR", "No picture for that handle.");
  res.writeHead(200, {
    "content-type": "image/jpeg",
    /* Content can change under a stable name — someone changes their picture —
       so this revalidates rather than being immutable. */
    "cache-control": "public, max-age=3600"
  });
  createReadStream(file).pipe(res);
});

/* --- sign in --- */

route("POST", /^\/api\/session\/nonce$/, async function (req, res) {
  var limit = rateLimit("nonce:" + clientIp(req, TRUST_PROXY), 30, 60000);
  if (!limit.ok) return fail(res, 429, "RATE_LIMIT", "Too many attempts. Try again shortly.");
  var body = await readJson(req);
  try {
    json(res, 200, startSignIn(String(body.pubkey || "")));
  } catch (e) {
    fail(res, 400, "BAD_PUBKEY", "That is not a Solana address.");
  }
});

route("POST", /^\/api\/session\/verify$/, async function (req, res) {
  var limit = rateLimit("verify:" + clientIp(req, TRUST_PROXY), 30, 60000);
  if (!limit.ok) return fail(res, 429, "RATE_LIMIT", "Too many attempts. Try again shortly.");
  var b = await readJson(req);
  var out = verifySignIn(String(b.pubkey || ""), String(b.signature || ""), String(b.nonce || ""), Number(b.issuedAt));
  if (!out.ok) return fail(res, 401, out.reason, "That signature did not check out. Try connecting again.");
  var orders = store.ordersForWallet(out.pubkey).map(function (o) { return publicOrder(o, config.publicOrigin); });
  json(res, 200, { wallet: out.pubkey, isAdmin: isAdminWallet(out.pubkey), orders: orders, state: stateBody(out.pubkey) },
       { "set-cookie": cookieHeader(mintToken(out.pubkey)) });
});

route("POST", /^\/api\/session\/logout$/, async function (req, res) {
  json(res, 200, { ok: true }, { "set-cookie": cookieHeader(null) });
});

/* --- ordering --- */

route("GET", /^\/api\/orders\/mine$/, async function (req, res) {
  var wallet = requireWallet(req, res); if (!wallet) return;
  json(res, 200, {
    orders: store.ordersForWallet(wallet).map(function (o) { return publicOrder(o, config.publicOrigin); })
  });
});

/* Reserves a slot and hands back a transaction the wallet only has to sign.
   The slot is held for HOLD_MINUTES; the piece number is not assigned until
   the money actually lands. */
route("POST", /^\/api\/orders$/, async function (req, res) {
  var wallet = requireWallet(req, res); if (!wallet) return;
  var limit = rateLimit("order:" + wallet, 12, 60000);
  if (!limit.ok) return fail(res, 429, "RATE_LIMIT", "Too many attempts. Try again shortly.");
  if (presaleOver()) return fail(res, 409, "PRESALE_OVER", "The presale has closed.");

  var body = await readJson(req);
  var v = validateOrder(body);
  if (!v.ok) return fail(res, 400, "INVALID", "Check the form.", { fields: v.errors });

  var reference = newReference();
  var order;
  try {
    order = store.reusePendingOrder(wallet, Object.assign({}, v.value, { reference: reference }))
         || store.createPendingOrder(Object.assign({}, v.value, { wallet: wallet, reference: reference }));
  } catch (e) {
    if (e.code === "SOLD_OUT") return fail(res, 409, "SOLD_OUT", "All fifteen are accounted for.");
    throw e;
  }

  /* Tell them about a short balance now, in a sentence, rather than letting the
     wallet throw a simulation error at them after they have approved. */
  var balance = await usdcBalance(wallet);
  var built;
  try {
    built = await buildPaymentTransaction(wallet, order.reference);
  } catch (e) {
    console.error("[order] could not build transaction", e.message);
    store.logEvent(order.id, "tx.build_failed", e.message);
    return fail(res, 502, "RPC_DOWN", "We could not reach the network. Try again in a moment.");
  }

  json(res, 200, {
    order: publicOrder(order, config.publicOrigin),
    transaction: built.transaction,
    blockhash: built.blockhash,
    lastValidBlockHeight: built.lastValidBlockHeight,
    amountUsdc: config.priceUsdc,
    treasury: config.treasury,
    balanceShort: balance < AMOUNT,
    balanceUsdc: Number(balance) / 10 ** config.usdcDecimals
  });
});

/* The only place a piece is actually awarded. Everything it trusts comes from
   the chain; the body supplies a signature and nothing else. */
route("POST", /^\/api\/orders\/([A-Za-z0-9]{16})\/confirm$/, async function (req, res, m) {
  var wallet = requireWallet(req, res); if (!wallet) return;
  var limit = rateLimit("confirm:" + wallet, 20, 60000);
  if (!limit.ok) return fail(res, 429, "RATE_LIMIT", "Too many attempts. Try again shortly.");

  var order = store.getOrder(m[1]);
  if (!order) return fail(res, 404, "NO_ORDER", "We cannot find that order.");
  if (order.wallet !== wallet) return fail(res, 403, "NOT_YOURS", "That order belongs to another wallet.");
  if (order.status === "paid") {
    return json(res, 200, { order: publicOrder(order, config.publicOrigin), already: true });
  }

  var body = await readJson(req);
  var signature = String(body.signature || "");
  if (!isSignature(signature)) return fail(res, 400, "BAD_SIGNATURE", "That is not a transaction signature.");

  var clash = store.getOrderBySignature(signature);
  if (clash && clash.id !== order.id) {
    return fail(res, 409, "SIGNATURE_USED", "That transaction is already against another order.");
  }

  /* The order's own creation time is the floor: a transaction that landed
     before the order existed cannot be the one that paid for it. */
  var check = await verifyPayment(signature, order.reference, order.wallet, order.created_at);
  if (!check.ok) {
    store.logEvent(order.id, "payment.rejected", check.reason + " " + signature);
    var messages = {
      NOT_FOUND: "We cannot see that transaction yet. Give it a few seconds and try again.",
      TX_FAILED: "That transaction failed on chain. Nothing was charged.",
      WRONG_ORDER: "That transaction does not belong to this order.",
      WRONG_PAYER: "That transaction came from a different wallet.",
      NO_TRANSFER: "That transaction did not move USDC to us.",
      WRONG_MINT: "That transaction sent a different token. We only take USDC.",
      TOO_OLD: "That transaction is older than this order.",
      MALFORMED: "We could not read that transaction.",
      UNDERPAID: "That transaction was short of " + config.priceUsdc + " USDC."
    };
    return fail(res, 402, check.reason, messages[check.reason] || "We could not verify that payment.", {
      retryable: check.reason === "NOT_FOUND"
    });
  }

  var paid = store.markPaid(order.id, signature);

  if (paid.status === "overflow") {
    notifyOverflow(paid);
    return fail(res, 409, "SOLD_OUT_AFTER_PAYMENT",
      "Your payment landed just after the last piece went. We have it, and we will refund you in full — " +
      "we have been alerted and will be in touch.",
      { order: publicOrder(paid, config.publicOrigin) });
  }

  if (paid.wave === 2) {
    /* No piece, no pickup code, nothing at a counter yet — so none of the
       wave-one apparatus fires. What goes out says what was actually bought:
       a place in the second cut, and the refund if it does not happen. */
    notifyWaveTwo(paid, store.wave2Count());
    sendWaveTwoConfirmation(paid).catch(function (e) {
      console.error("[email] wave two", e.message);
    });
    if (paid.x_handle) fetchAvatar(paid.x_handle).catch(function () {});
    return json(res, 200, {
      order: publicOrder(paid, config.publicOrigin),
      explorer: explorerTx(signature),
      state: stateBody(wallet)
    });
  }

  notifyPaid(paid);
  /* Not awaited, and that is the whole point: the buyer's confirmation screen
     does not wait on a mail provider. A send that fails leaves an email.failed
     event on the order and the pass is still on screen and still behind the
     wallet — nothing is lost but the convenience, and /admin can resend. */
  sendConfirmation(paid).catch(function (e) {
    console.error("[email] confirmation", e.message);
  });
  /* Their face on the wall, fetched now so it is there by the time anyone
     reloads. Like everything else after markPaid: not awaited, cannot fail the
     sale, and a miss just leaves the initial. */
  if (paid.x_handle) fetchAvatar(paid.x_handle).catch(function () {});
  json(res, 200, {
    order: publicOrder(paid, config.publicOrigin),
    explorer: explorerTx(signature),
    state: stateBody(wallet)
  });
});

route("GET", /^\/api\/orders\/([A-Za-z0-9]{16})$/, async function (req, res, m) {
  var wallet = requireWallet(req, res); if (!wallet) return;
  var order = store.getOrder(m[1]);
  if (!order || order.wallet !== wallet) return fail(res, 404, "NO_ORDER", "We cannot find that order.");
  json(res, 200, { order: publicOrder(order, config.publicOrigin) });
});

/* --- the pickup pass --- */

/* There is no endpoint that trades a pickup code for an order. A buyer sees
   their own by connecting the wallet that paid — the sign-in placing the order
   already required — and staff see it in the ledger, behind an admin wallet.
   Those are the only two ways in.

   The code is never in a URL either, here or in what the QR encodes. URLs are
   written to browser history, proxy and server access logs, and travel in the
   Referer header to anywhere the page later links; a pickup code is a bearer
   token for a physical object and has no business in any of them. */

/* The buyer's own QR, for their own order, behind their own session. The code
   travels in the response body and never in the path. */
route("POST", /^\/api\/orders\/([A-Za-z0-9]{16})\/qr$/, async function (req, res, m) {
  var wallet = requireWallet(req, res); if (!wallet) return;
  var o = store.getOrder(m[1]);
  if (!o || o.wallet !== wallet) return fail(res, 404, "NO_ORDER", "We cannot find that order.");
  if (o.status !== "paid" || !o.pickup_code) return fail(res, 409, "NOT_PAID", "That order has no pass yet.");

  /* The target is built in qr.js, so this image and the one attached to the
     confirmation email always encode the same string. */
  var svg = await pickupQrSvg(o);
  res.writeHead(200, {
    "content-type": "image/svg+xml; charset=utf-8",
    "cache-control": "no-store, private"
  });
  res.end(svg);
});

/* --- admin --- */

route("GET", /^\/api\/admin\/orders$/, async function (req, res) {
  if (!requireAdmin(req, res)) return;
  store.expireStaleHolds();
  json(res, 200, {
    cap: config.cap,
    sold: store.paidCount(),
    waveTwo: config.waveTwo,
    wave2Count: store.wave2Count(),
    wave2Target: config.waveTwoTarget,
    treasury: config.treasury,
    network: config.network,
    orders: store.allOrders().map(function (o) {
      return {
        id: o.id, status: o.status, piece: o.piece_no, name: o.name, email: o.email,
        x: o.x_handle, tg: o.tg_handle, wallet: o.wallet, pickupCode: o.pickup_code,
        mark: o.mark == null ? null : !!o.mark,
        wave: o.wave || 1,
        waveNo: o.wave_no == null ? null : o.wave_no,
        signature: o.tx_signature, explorer: o.tx_signature ? explorerTx(o.tx_signature) : null,
        createdAt: o.created_at, paidAt: o.paid_at, collectedAt: o.collected_at,
        collectedBy: o.collected_by, notes: o.notes,
        /* Read off the event log rather than a column: "did they get the
           email?" is the first thing asked when a buyer turns up with nothing
           on their phone, and it should be answerable from this screen. */
        emailed: o.status === "paid" ? store.hasEvent(o.id, "email.sent") : false
      };
    })
  });
});

route("POST", /^\/api\/admin\/collect$/, async function (req, res) {
  var actor = requireAdmin(req, res);
  if (!actor) return;
  var b = await readJson(req);
  var o = b.code ? store.getOrderByPickupCode(b.code) : store.getOrder(String(b.id || ""));
  if (!o) return fail(res, 404, "NO_ORDER", "No order under that code.");
  try {
    /* Recorded as the wallet that signed in, not as a name typed into a box.
       Whoever released a piece is then a fact rather than a claim. */
    var updated = store.markCollected(o.id, actor);
    if (!o.collected_at) {
      var outstanding = store.allOrders().filter(function (r) {
        return r.status === "paid" && !r.collected_at;
      }).length;
      notifyCollected(updated, actor, outstanding);
    }
    json(res, 200, { ok: true, piece: updated.piece_no, collectedAt: updated.collected_at });
  } catch (e) {
    if (e.code === "NOT_PAID") return fail(res, 409, "NOT_PAID", "That order was never paid.");
    throw e;
  }
});

/* Resend a confirmation. Every send is best-effort by design, so there has to
   be a way to try again — a bounced address corrected in person, a provider
   that was down during the sale, a buyer who deleted it. Behind an admin wallet
   like everything else here, and it sends to the address in the ledger and
   nowhere else: an endpoint that took a destination would turn the ledger into
   a way to mail a stranger's pickup code anywhere. */
route("POST", /^\/api\/admin\/email$/, async function (req, res) {
  var actor = requireAdmin(req, res);
  if (!actor) return;
  if (!emailEnabled()) return fail(res, 503, "EMAIL_OFF", "Email is not configured on this server.");
  var b = await readJson(req);
  var o = b.code ? store.getOrderByPickupCode(b.code) : store.getOrder(String(b.id || ""));
  if (!o) return fail(res, 404, "NO_ORDER", "We cannot find that order.");
  if (o.status !== "paid") return fail(res, 409, "NOT_PAID", "That order was never paid.");

  var limit = rateLimit("resend:" + o.id, 5, 300000);
  if (!limit.ok) return fail(res, 429, "RATE_LIMIT", "That pass has been resent five times in five minutes.");

  var out = await sendConfirmation(o, { force: true });
  if (!out.ok) return fail(res, 502, "SEND_FAILED", "The provider refused it: " + (out.detail || out.reason));
  store.logEvent(o.id, "email.resent", actor);
  json(res, 200, { ok: true, to: o.email });
});

route("GET", /^\/api\/admin\/events$/, async function (req, res) {
  if (!requireAdmin(req, res)) return;
  json(res, 200, { events: store.recentEvents(200) });
});

/* --- pages --- */

function page(res, html) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin"
  });
  res.end(html);
}
route("GET", /^\/admin\/?$/, async function (req, res) { page(res, adminHtml); });

/* The QR decoder for the ledger's scanner. Served from here rather than from
   the front end's public/ because /admin may be opened on the API's own origin,
   where the site is not necessarily present. Fetched only when Scan is pressed. */
route("GET", /^\/vendor\/jsqr\.js$/, async function (req, res) {
  var file = fileURLToPath(new URL("../vendor/jsqr.js", import.meta.url));
  var body;
  try { body = readFileSync(file); }
  catch (e) { return fail(res, 404, "NO_VENDOR", "Run `npm run vendor` in server/."); }
  res.writeHead(200, {
    "content-type": "text/javascript; charset=utf-8",
    "content-length": body.length,
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff"
  });
  res.end(body);
});

/* ---------- server ---------- */

/* CORS, only for origins named in ALLOWED_ORIGINS.
 *
 * The allowlist is exact and echoed back one origin at a time — never "*",
 * which browsers refuse alongside credentials anyway, and never a reflection of
 * whatever Origin arrived. With a SameSite=None cookie this list is what stands
 * in for SameSite as the CSRF defence, so it is applied to every request and
 * not only to the preflight. */
function applyCors(req, res) {
  var origin = req.headers.origin;
  if (!origin || !config.allowedOrigins.length) return true;
  var allowed = config.allowedOrigins.indexOf(origin.replace(/\/+$/, "")) !== -1;
  // Vary regardless, so a cache never serves one origin's answer to another.
  res.setHeader("Vary", "Origin");
  if (!allowed) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Max-Age", "600");
  return true;
}

var server = createServer(async function (req, res) {
  var url;
  try { url = new URL(req.url, "http://localhost"); }
  catch (e) { return fail(res, 400, "BAD_URL", "Bad request."); }
  var path = url.pathname;

  if (!applyCors(req, res)) {
    return fail(res, 403, "BAD_ORIGIN", "That origin is not allowed to call this API.");
  }
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  for (var i = 0; i < routes.length; i++) {
    var r = routes[i];
    var m = r.pattern.exec(path);
    if (!m) continue;
    if (r.method !== req.method && !(r.method === "GET" && req.method === "HEAD")) {
      return fail(res, 405, "BAD_METHOD", "Method not allowed.");
    }
    try {
      return await r.handler(req, res, m, url);
    } catch (e) {
      console.error("[500]", req.method, path, e);
      store.logEvent(null, "server.error", req.method + " " + path + " " + e.message);
      if (!res.headersSent) return fail(res, 500, "SERVER", "Something went wrong on our side.");
      return res.end();
    }
  }

  if (path.indexOf("/api/") === 0) return fail(res, 404, "NO_ROUTE", "No such endpoint.");
  /* Only when SITE_DIR names a build. The front end is `npm run start` at the
     repo root; this exists for a single-origin deployment that wants one
     process to hand out both. */
  if (config.siteDir && (req.method === "GET" || req.method === "HEAD")) {
    if (serveStatic(req, res, path)) return;
  }
  fail(res, 404, "NOT_FOUND", "Not found.");
});

/* Housekeeping: nothing here is time-critical, so once a minute is plenty. */
setInterval(function () {
  try { store.expireStaleHolds(); store.sweepNonces(); }
  catch (e) { console.error("[sweep]", e.message); }
}, 60000).unref();

server.listen(config.port, function () {
  var sold = store.paidCount();
  console.log("Breakpoint Kimono presale server");
  console.log("  listening   http://localhost:" + config.port);
  console.log("  network     " + config.network);
  console.log("  treasury    " + config.treasury);
  console.log("  price       " + config.priceUsdc + " USDC");
  console.log("  sold        " + sold + " / " + config.cap);
  console.log("  telegram    " + (telegramEnabled() ? "on" : "off (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)"));
  console.log("  wave two    " + (config.waveTwo
    ? "on · " + store.wave2Count() + " committed, cuts at " + config.waveTwoTarget
    : "off (a full run closes the shop)"));
  console.log("  avatars     " + (avatarsEnabled() ? "on · " + config.avatarSource + "<handle>" : "off (initials only)"));
  console.log("  email       " + (emailEnabled() ? "on · from " + config.emailFrom : "off (set RESEND_API_KEY and EMAIL_FROM)"));
  console.log("  admin       " + config.publicOrigin + "/admin");
  console.log("  site        " + (config.siteDir
    ? "serving " + config.siteDir
    : "not served here — run `npm run start` at the repo root"));
  if (config.allowedOrigins.length) {
    console.log("  cors        " + config.allowedOrigins.join(", ") + "  (cookie: SameSite=None)");
  }
  notifyStartup({ sold: sold });
});

function shutdown() {
  console.log("\nshutting down");
  server.close(function () { try { store.db.close(); } catch (e) {} process.exit(0); });
  setTimeout(function () { process.exit(0); }, 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
