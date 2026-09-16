/* Pre-flight. Run it before you take a single real payment, and again after any
   change to .env — it checks the things that are silently wrong rather than
   loudly wrong: a devnet mint on mainnet, a treasury that cannot receive USDC,
   a Telegram bot that was never started, a closing date already in the past. */

import { config, explorerTx } from "../src/config.js";
import { isAddress } from "../src/base58.js";
import * as store from "../src/db.js";
import { rpcHealth } from "../src/solana.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";

var problems = [], warnings = [];
function ok(label, detail) { console.log("  \x1b[32mok\x1b[0m   " + label + (detail ? "  " + detail : "")); }
function bad(label, detail) { problems.push(label + (detail ? " — " + detail : "")); console.log("  \x1b[31mFAIL\x1b[0m " + label + (detail ? "  " + detail : "")); }
function warn(label, detail) { warnings.push(label); console.log("  \x1b[33mwarn\x1b[0m " + label + (detail ? "  " + detail : "")); }

console.log("\nconfiguration");
console.log("  network     " + config.network);
console.log("  price       " + config.priceUsdc + " USDC × " + config.cap + " pieces");
console.log("  origin      " + config.publicOrigin);

var KNOWN_MINTS = {
  mainnet: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  devnet: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
};

console.log("\nsecrets");
if (config.sessionSecret.length < 32) bad("SESSION_SECRET is too short", "use: openssl rand -hex 32");
else ok("SESSION_SECRET set");
if (!config.adminWallets.length) bad("ADMIN_WALLETS is empty");
else {
  var badWallets = config.adminWallets.filter(function (w) { return !isAddress(w); });
  if (badWallets.length) bad("ADMIN_WALLETS contains something that is not an address", badWallets.join(" "));
  else ok("ADMIN_WALLETS", config.adminWallets.length + " wallet(s) may open the ledger");
  /* A wallet that also buys is fine, but worth saying out loud — it means one
     signature reaches both the checkout and every buyer's name and email. */
  config.adminWallets.forEach(function (w) {
    if (w === config.treasury) warn("an admin wallet is also the treasury", w);
  });
}
if (/REPLACE_ME/.test(config.rpcUrl)) bad("RPC_URL still says REPLACE_ME");
else ok("RPC_URL set", "(key hidden)");
if (config.publicOrigin.indexOf("https://") !== 0) warn("PUBLIC_ORIGIN is not https", "fine locally; required in production");
if (config.publicOrigin.indexOf("https://") === 0 && !config.secureCookies) bad("SECURE_COOKIES is off on an https origin", "set SECURE_COOKIES=1");

console.log("\naddresses");
if (!isAddress(config.treasury)) bad("TREASURY is not a Solana address", config.treasury);
else ok("treasury", config.treasury);
if (!isAddress(config.usdcMint)) bad("USDC_MINT is not a Solana address", config.usdcMint);
else if (config.usdcMint !== KNOWN_MINTS[config.network]) {
  bad("USDC_MINT is not Circle's mint for " + config.network, "expected " + KNOWN_MINTS[config.network]);
} else ok("USDC mint matches " + config.network);

console.log("\nnetwork");
var health = await rpcHealth();
if (!health.ok) bad("RPC unreachable", health.error);
else {
  ok("RPC reachable", "solana-core " + health.version);
  try {
    var conn = new Connection(config.rpcUrl, "confirmed");
    var genesis = await conn.getGenesisHash();
    var MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
    var isMainnet = genesis === MAINNET_GENESIS;
    if (isMainnet && config.network !== "mainnet") bad("RPC_URL points at mainnet but NETWORK=" + config.network);
    else if (!isMainnet && config.network === "mainnet") bad("NETWORK=mainnet but RPC_URL is not mainnet");
    else ok("RPC cluster agrees with NETWORK");

    var ata = await getAssociatedTokenAddress(new PublicKey(config.usdcMint), new PublicKey(config.treasury));
    var info = await conn.getAccountInfo(ata);
    if (info) {
      var bal = await conn.getTokenAccountBalance(ata);
      ok("treasury can receive USDC", ata.toBase58() + " · holds " + bal.value.uiAmountString);
    } else {
      warn("treasury has no USDC account yet", "the first buyer pays ~0.002 SOL of rent to create it");
    }
  } catch (e) {
    bad("could not inspect the treasury", e.message);
  }
}

console.log("\ntelegram");
if (!config.telegramToken || !config.telegramChat) {
  warn("notifications are off", "set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to be told about each sale");
} else {
  try {
    var me = await (await fetch("https://api.telegram.org/bot" + config.telegramToken + "/getMe")).json();
    if (!me.ok) bad("the bot token is not valid", me.description);
    else {
      ok("bot", "@" + me.result.username);
      var sent = await (await fetch("https://api.telegram.org/bot" + config.telegramToken + "/sendMessage", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: config.telegramChat, text: "Pre-flight check — notifications are working." })
      })).json();
      if (!sent.ok) bad("the bot cannot message that chat", sent.description + " — send your bot a message first, then re-check");
      else ok("test message delivered", "look in Telegram");
    }
  } catch (e) { bad("could not reach Telegram", e.message); }
}

console.log("\nledger");
try {
  store.expireStaleHolds();
  var sold = store.paidCount();
  ok("database writable", sold + " / " + config.cap + " sold");
  var overflow = store.allOrders().filter(function (o) { return o.status === "overflow"; });
  if (overflow.length) bad(overflow.length + " order(s) paid after sell-out and owe a refund",
    overflow.map(function (o) { return explorerTx(o.tx_signature); }).join(" "));
} catch (e) { bad("database not writable", e.message); }

console.log("\ndates");
if (Date.now() > config.presaleEndsAt) bad("PRESALE_ENDS is in the past", new Date(config.presaleEndsAt).toISOString());
else ok("presale closes", new Date(config.presaleEndsAt).toISOString());

console.log("");
if (problems.length) {
  console.log("\x1b[31m" + problems.length + " problem(s) to fix before taking payments:\x1b[0m");
  problems.forEach(function (p) { console.log("  · " + p); });
  process.exit(1);
}
console.log("\x1b[32mReady to take payments.\x1b[0m" + (warnings.length ? "  (" + warnings.length + " warning(s) above)" : ""));
