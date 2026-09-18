/* Forgeries.

   The scenario is: the page has been tampered with. It can send any signature
   it likes and report any outcome it likes. Every rule that stands between that
   and a free kimono lives in checkTransaction(), so each one is attacked here
   with a transaction built to slip past it.

   These are synthetic RPC payloads rather than live transactions — which is the
   point. A real attacker's transaction would be real; what matters is that the
   shapes below are refused, and building them by hand is the only way to test
   the refusals without spending 300 USDC a dozen times. */

/* Pinned before anything loads. config.js reads the environment once, at
   import, and a price or treasury changed in .env for a cheap rehearsal must
   not decide what these assertions mean — the whole file is about exact
   amounts. Hence the dynamic imports. */
process.env.PRICE_USDC = "300";
/* Pinning a price means pinning the struck-out one too, or a discount in the
   developer\'s own .env leaks in and the server refuses to start. */
process.env.LIST_PRICE_USDC = "0";
process.env.TREASURY = "DWDeu7snxGK9uscdJbtjcQ4oU9cCdpNZPaate6BVqEuD";
process.env.USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
process.env.NETWORK = "mainnet";

var { checkTransaction, AMOUNT } = await import("../src/solana.js");
var { config } = await import("../src/config.js");

var USDC = config.usdcMint;
var TREASURY = config.treasury;

if (AMOUNT !== 300000000n) {
  console.log("FAIL the fixture price did not pin: AMOUNT is " + AMOUNT);
  process.exit(1);
}
var USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

var BUYER = "BuyerBuyerBuyerBuyerBuyerBuyerBuyerBuyer111";
var THIEF = "ThiefThiefThiefThiefThiefThiefThiefThief111";
var REF   = "ReFeReNceReFeReNceReFeReNceReFeReNceReF1111";
var OTHER_TREASURY = "0therTreasury0therTreasury0therTreasury1111";

var ORDER_AT = Date.UTC(2026, 8, 16, 10, 0, 0);
var LANDED   = Math.floor((ORDER_AT + 60000) / 1000);   // a minute after the order

/* A transaction as getTransaction returns one. Defaults are the honest case;
   every test below bends exactly one thing. */
function tx(over) {
  var o = Object.assign({
    payer: BUYER, keys: [BUYER, REF], err: null, blockTime: LANDED,
    mint: USDC, owner: TREASURY, before: "1000000", after: "301000000", err_: null
  }, over || {});
  var keys = o.keys.slice();
  if (keys[0] !== o.payer) keys.unshift(o.payer);
  return {
    slot: 1234,
    blockTime: o.blockTime,
    meta: {
      err: o.err,
      preTokenBalances: o.pre !== undefined ? o.pre
        : [{ accountIndex: 3, mint: o.mint, owner: o.owner, uiTokenAmount: { amount: o.before } }],
      postTokenBalances: o.post !== undefined ? o.post
        : [{ accountIndex: 3, mint: o.mint, owner: o.owner, uiTokenAmount: { amount: o.after } }]
    },
    transaction: {
      message: {
        accountKeys: keys.map(function (k) { return { toBase58: function () { return k; } }; })
      }
    }
  };
}

var opts = { reference: REF, payer: BUYER, notBefore: ORDER_AT };

var pass = 0, fail = 0;
function refuses(label, transaction, reason, o) {
  var r = checkTransaction(transaction, o || opts);
  if (!r.ok && (!reason || r.reason === reason)) { pass++; console.log("  ok   refuses " + label + "  (" + r.reason + ")"); }
  else { fail++; console.log("  FAIL " + label + " was " + (r.ok ? "ACCEPTED" : "refused as " + r.reason) + ", expected " + reason); }
}
function accepts(label, transaction, o) {
  var r = checkTransaction(transaction, o || opts);
  if (r.ok) { pass++; console.log("  ok   accepts " + label + "  (" + (Number(r.amount) / 1e6) + " USDC)"); }
  else { fail++; console.log("  FAIL " + label + " was refused as " + r.reason); }
}

console.log("\nthe honest payment");
accepts("300 USDC to the treasury, carrying our reference", tx());
accepts("exactly 300, not a penny over", tx({ before: "0", after: String(AMOUNT) }));
accepts("a credit split across two treasury accounts", tx({
  pre:  [{ accountIndex: 3, mint: USDC, owner: TREASURY, uiTokenAmount: { amount: "0" } },
         { accountIndex: 4, mint: USDC, owner: TREASURY, uiTokenAmount: { amount: "0" } }],
  post: [{ accountIndex: 3, mint: USDC, owner: TREASURY, uiTokenAmount: { amount: "150000000" } },
         { accountIndex: 4, mint: USDC, owner: TREASURY, uiTokenAmount: { amount: "150000000" } }]
}));
accepts("a transaction that also did other things", tx({
  pre:  [{ accountIndex: 7, mint: USDT, owner: THIEF, uiTokenAmount: { amount: "5" } },
         { accountIndex: 3, mint: USDC, owner: TREASURY, uiTokenAmount: { amount: "0" } }],
  post: [{ accountIndex: 7, mint: USDT, owner: THIEF, uiTokenAmount: { amount: "9" } },
         { accountIndex: 3, mint: USDC, owner: TREASURY, uiTokenAmount: { amount: "300000000" } }]
}));

console.log("\nthe amount");
refuses("one base unit short of the price", tx({ before: "0", after: String(AMOUNT - 1n) }), "UNDERPAID");
refuses("a token amount of 300 with the decimals moved", tx({ before: "0", after: "300" }), "UNDERPAID");
refuses("zero", tx({ before: "500000000", after: "500000000" }), "UNDERPAID");
refuses("a withdrawal dressed as a payment", tx({ before: "500000000", after: "200000000" }), "UNDERPAID");

console.log("\nthe token");
refuses("300 USDT instead of USDC", tx({ mint: USDT }), "WRONG_MINT");
refuses("a token nobody has heard of", tx({ mint: "Fake1111111111111111111111111111111111111111" }), "WRONG_MINT");

console.log("\nthe destination");
refuses("300 USDC to somebody else", tx({ owner: OTHER_TREASURY }), "NO_TRANSFER");
refuses("300 USDC back to the buyer", tx({ owner: BUYER }), "NO_TRANSFER");
refuses("a transaction that moved no tokens at all", tx({ pre: [], post: [] }), "NO_TRANSFER");

console.log("\nwhose payment it is");
refuses("a real payment made by someone else", tx({ payer: THIEF, keys: [THIEF, REF] }), "WRONG_PAYER");
refuses("a real payment for a different order", tx({ keys: [BUYER, "0therReferenceZZZZZZZZZZZZZZZZZZZZZZZZZZZZ"] }), "WRONG_ORDER");
refuses("a payment with no reference at all", tx({ keys: [BUYER] }), "WRONG_ORDER");

console.log("\nthe transaction itself");
refuses("one that failed on chain", tx({ err: { InstructionError: [0, "Custom"] } }), "TX_FAILED");
refuses("one the chain has never seen", null, "NOT_FOUND");
refuses("an older payment replayed against a new order",
  tx({ blockTime: Math.floor((ORDER_AT - 3600000) / 1000) }), "TOO_OLD");
refuses("a transaction with no account keys", tx({ keys: [], payer: undefined }), "MALFORMED");

console.log("\nconfiguration is the authority");
/* If the configured treasury or mint changed, yesterday's valid payment stops
   verifying. That is the property worth having: the check reads config, never
   the transaction's own idea of where it should have gone. */
refuses("a payment to the old treasury after the address changed",
  tx(), "NO_TRANSFER", Object.assign({}, opts, { treasury: OTHER_TREASURY }));
refuses("a payment in the old token after the mint changed",
  tx(), "WRONG_MINT", Object.assign({}, opts, { mint: USDT }));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
