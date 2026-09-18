/* All configuration lives in the environment. `npm start` loads server/.env via
   --env-file; nothing here is ever sent to the browser. In particular RPC_URL
   carries the Helius API key, so it must not appear in any /api response. */

function req(name) {
  var v = process.env[name];
  if (!v) throw new Error("Missing required env var " + name + " (see server/.env.example)");
  return v;
}
function opt(name, fallback) {
  var v = process.env[name];
  return v == null || v === "" ? fallback : v;
}
function num(name, fallback) {
  var v = opt(name, null);
  if (v == null) return fallback;
  var n = Number(v);
  if (!Number.isFinite(n)) throw new Error(name + " must be a number, got " + JSON.stringify(v));
  return n;
}

var NETWORK = opt("NETWORK", "mainnet");
if (NETWORK !== "mainnet" && NETWORK !== "devnet") {
  throw new Error('NETWORK must be "mainnet" or "devnet", got ' + JSON.stringify(NETWORK));
}

/* Circle's USDC. The devnet mint is a different token entirely — paying on the
   wrong network is the one mistake that looks like success to the buyer, so the
   mint is pinned per network rather than guessed. */
var DEFAULT_MINTS = {
  mainnet: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  devnet: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
};

export var config = {
  port: num("PORT", 4321),
  network: NETWORK,
  /* Held secret. Logged redacted, never serialised into a response. */
  rpcUrl: req("RPC_URL"),
  treasury: req("TREASURY"),
  usdcMint: opt("USDC_MINT", DEFAULT_MINTS[NETWORK]),
  usdcDecimals: 6,
  priceUsdc: num("PRICE_USDC", 300),
  cap: num("CAP", 15),
  /* A pending order holds a slot for this long. Long enough to approve a wallet
     prompt and land a transaction; short enough that an abandoned checkout does
     not take a piece off the board for the rest of the presale. */
  holdMinutes: num("HOLD_MINUTES", 20),
  presaleEndsAt: Date.parse(opt("PRESALE_ENDS", "2026-09-29T12:00:00Z")),
  sessionSecret: req("SESSION_SECRET"),
  sessionHours: num("SESSION_HOURS", 72),
  /* Who may open the ledger. Addresses, not a password: staff prove themselves
     with the same wallet signature the buyers use, so there is no shared secret
     to leak in a screenshot, a chat message or a server log. One or several,
     comma-separated — each person at the counter can use their own. */
  adminWallets: req("ADMIN_WALLETS").split(",").map(function (w) { return w.trim(); }).filter(Boolean),
  telegramToken: opt("TELEGRAM_BOT_TOKEN", ""),
  telegramChat: opt("TELEGRAM_CHAT_ID", ""),
  /* The buyer's confirmation. Leave RESEND_API_KEY blank and nothing is sent —
     orders still record, and the pass is still in the panel behind the wallet.
     EMAIL_FROM must be on a domain verified with the provider, or every send is
     rejected at the API and the buyer hears nothing. */
  resendKey: opt("RESEND_API_KEY", ""),
  emailFrom: opt("EMAIL_FROM", ""),
  emailReplyTo: opt("EMAIL_REPLY_TO", ""),
  /* An optional copy of every confirmation, to an address you control. Worth
     setting: it is the only record of what the buyer was actually sent. */
  emailBcc: opt("EMAIL_BCC", ""),
  /* Where buyers' profile pictures come from, and where they are kept once
     fetched. The handle is appended to the source; empty turns the whole thing
     off and the panel keeps its initials. unavatar resolves an X handle without
     an API key — X's own user lookup is behind a paid tier. */
  /* Not opt(), deliberately. opt() reads an empty value as "use the default",
     which for every other setting is a convenience and here would be a trap:
     the documented way to switch this off is to blank it, and blanking it would
     quietly keep calling a third party with buyers' handles. Unset means the
     default; empty means off, and means it. */
  avatarSource: process.env.AVATAR_SOURCE == null
    ? "https://unavatar.io/x/"
    : String(process.env.AVATAR_SOURCE).trim(),
  avatarDir: opt("AVATAR_DIR", "../data/avatars"),
  /* The order card shown in the confirmation email, attached rather than linked.
     Empty uses site/public/web/share-card.jpg next to this checkout — set it
     only if the two apps are deployed apart and that path does not exist. */
  emailCardImage: opt("EMAIL_CARD_IMAGE", ""),
  dbPath: opt("DB_PATH", "../data/orders.db"),
  /* The front end is its own app now (`npm run start` at the repo root). This
     stays so a single-origin deployment can still hand out the built files —
     point it at ../dist and put both behind one hostname. Empty serves the API
     and /admin only. */
  siteDir: opt("SITE_DIR", ""),
  /* Origins allowed to call the API with credentials, comma-separated. Needed
     only when the app is served from somewhere else — an empty list means
     same-origin, which is the safer arrangement and needs nothing here. */
  allowedOrigins: opt("ALLOWED_ORIGINS", "").split(",").map(function (o) { return o.trim().replace(/\/+$/, ""); }).filter(Boolean),
  publicOrigin: opt("PUBLIC_ORIGIN", "http://localhost:" + num("PORT", 4321)),
  /* Behind a reverse proxy the cookie must still be Secure; set to "1" in prod.
     It is also mandatory once ALLOWED_ORIGINS is in use: a cross-site session
     cookie has to be SameSite=None, and browsers reject SameSite=None without
     Secure — silently, which is the worst way to find out. */
  secureCookies: opt("SECURE_COOKIES", "") === "1"
};

/* Cross-site sessions have one hard requirement, and failing it looks like
   "sign-in does nothing" rather than like an error. Refuse to start instead. */
if (config.allowedOrigins.length && !config.secureCookies) {
  throw new Error(
    "ALLOWED_ORIGINS is set, so the session cookie must be SameSite=None; Secure — " +
    "set SECURE_COOKIES=1. Browsers drop a SameSite=None cookie that is not Secure, " +
    "and sign-in will appear to do nothing. (https://localhost counts as secure in " +
    "Chrome; in Safari, use the Vite proxy instead by leaving VITE_SERVER_URL empty.)"
  );
}

if (!config.adminWallets.length) {
  throw new Error("ADMIN_WALLETS must name at least one Solana address");
}

if (!Number.isFinite(config.presaleEndsAt)) {
  throw new Error("PRESALE_ENDS must be an ISO 8601 instant, e.g. 2026-09-29T12:00:00Z");
}

export function explorerTx(sig) {
  return "https://explorer.solana.com/tx/" + sig +
    (config.network === "devnet" ? "?cluster=devnet" : "");
}
