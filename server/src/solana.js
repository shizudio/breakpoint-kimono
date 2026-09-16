/* Everything that touches the chain.

   The transaction is built here, on the server, and handed to the browser
   already formed — the wallet only signs and sends it. That keeps the amount,
   the mint and the destination out of reach of the page, and it means the
   RPC key never leaves this process.

   Payment is then verified against the chain itself, not against what the
   browser claims. The browser's word for "I paid" is worth nothing; a
   confirmed transaction crediting the treasury is worth 300 USDC. */

import {
  Connection, PublicKey, Transaction, Keypair
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createTransferCheckedInstruction,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import { config } from "./config.js";

var connection = new Connection(config.rpcUrl, "confirmed");
var MINT = new PublicKey(config.usdcMint);
var TREASURY = new PublicKey(config.treasury);

/* 300 USDC in base units. BigInt throughout — USDC has 6 decimals and a float
   would be fine today, but "close enough" has no place in a payment check. */
export var AMOUNT = BigInt(Math.round(config.priceUsdc * 10 ** config.usdcDecimals));

/* A throwaway public key stamped into the transaction as a read-only account.
   It does not sign, hold funds or cost anything — it is a tag, the Solana Pay
   convention, and it is what ties one on-chain transaction to one order row. */
export function newReference() {
  return Keypair.generate().publicKey.toBase58();
}

export async function buildPaymentTransaction(payerB58, referenceB58) {
  var payer = new PublicKey(payerB58);
  var reference = new PublicKey(referenceB58);

  var fromAta = await getAssociatedTokenAddress(MINT, payer);
  var toAta = await getAssociatedTokenAddress(MINT, TREASURY);

  var tx = new Transaction();

  /* If the treasury has never held USDC there is no account to credit. Creating
     it costs the buyer ~0.002 SOL in rent, so do it only when it is genuinely
     missing — after the first sale this branch never runs again. */
  var toInfo = await connection.getAccountInfo(toAta);
  if (!toInfo) {
    tx.add(createAssociatedTokenAccountInstruction(payer, toAta, TREASURY, MINT));
  }

  var ix = createTransferCheckedInstruction(
    fromAta, MINT, toAta, payer, AMOUNT, config.usdcDecimals, [], TOKEN_PROGRAM_ID
  );
  // The reference rides along as a read-only, non-signing key.
  ix.keys.push({ pubkey: reference, isSigner: false, isWritable: false });
  tx.add(ix);

  var latest = await connection.getLatestBlockhash("confirmed");
  tx.feePayer = payer;
  tx.recentBlockhash = latest.blockhash;

  return {
    transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight
  };
}

/* Does the buyer actually hold enough USDC? Asked before we build anything, so
   a short balance surfaces as a sentence rather than as a wallet error. */
export async function usdcBalance(payerB58) {
  try {
    var ata = await getAssociatedTokenAddress(MINT, new PublicKey(payerB58));
    var bal = await connection.getTokenAccountBalance(ata);
    return BigInt(bal.value.amount);
  } catch (e) {
    return 0n;   // no token account at all reads as a zero balance
  }
}

function accountKeysOf(tx) {
  var msg = tx.transaction.message;
  var keys = typeof msg.getAccountKeys === "function"
    ? msg.getAccountKeys({ accountKeysFromLookups: tx.meta && tx.meta.loadedAddresses })
    : null;
  if (keys) {
    var out = [];
    for (var i = 0; i < keys.length; i++) out.push(keys.get(i).toBase58());
    return out;
  }
  return (msg.accountKeys || []).map(function (k) { return k.toBase58(); });
}

/* Fetch with a little patience: a signature returned by the wallet is usually
   a second or two ahead of the RPC node that has to serve it back to us.

   Deliberately short. The browser retries on top of this, so a long poll here
   multiplies: at twelve tries the two ladders together left a buyer watching a
   spinner for nearly three minutes before being told anything. Six seconds
   covers the ordinary lag, and the client's own retries cover the rest. */
export async function fetchTransaction(signature, attempts) {
  var tries = attempts || 5;
  for (var i = 0; i < tries; i++) {
    var tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0
    });
    if (tx) return tx;
    if (i < tries - 1) await new Promise(function (r) { setTimeout(r, 1200); });
  }
  return null;
}

/* The gate.

   Everything the browser tells us about a payment is a claim. What follows is
   the whole of what we actually believe, and it comes from the chain:

     1. the transaction exists and did not fail
     2. it carries THIS order's reference key — a fresh random pubkey the server
        minted for this order and nothing else, so no other transaction in
        history can contain it
     3. its fee payer is the wallet that signed in and placed the order
     4. it is not older than the order it claims to pay for
     5. the token credited is the configured mint, to the penny of its decimals
     6. the account credited is owned by the configured treasury
     7. the amount credited is at least the configured price

   Points 5, 6 and 7 are read off the transaction's own pre/post token balances
   rather than by parsing instructions, so the answer is the same whether the
   wallet sent `transfer` or `transferChecked`, whether the token account was
   created in the same transaction, and whatever else the transaction also did.

   That is what makes a forged client harmless. The server builds the payment,
   but a tampered page could build its own — and a transfer of the wrong token,
   to the wrong address, or of the wrong amount fails 5, 6 or 7 no matter how
   convincingly the page reports success. A transfer with none of our reference
   fails 2. A transfer someone else made fails 3.

   Kept free of network and database so it can be exercised directly: see
   test/forgery.test.js, which feeds it a dozen forgeries. */
export function checkTransaction(tx, opts) {
  var reference = opts.reference;
  var expectPayer = opts.payer;
  var notBefore = opts.notBefore || 0;
  var mint = opts.mint || config.usdcMint;
  var treasury = opts.treasury || config.treasury;
  var minimum = opts.minimum == null ? AMOUNT : opts.minimum;

  if (!tx) return { ok: false, reason: "NOT_FOUND" };
  if (tx.meta && tx.meta.err) return { ok: false, reason: "TX_FAILED" };

  var keys = accountKeysOf(tx);
  if (!keys.length) return { ok: false, reason: "MALFORMED" };

  // (2) Our reference, or this transaction is not this order's.
  if (keys.indexOf(reference) === -1) return { ok: false, reason: "WRONG_ORDER" };

  // (3) The fee payer is the first signer. Without this, one buyer could paste
  //     another buyer's signature and claim a piece they never paid for.
  if (expectPayer && keys[0] !== expectPayer) return { ok: false, reason: "WRONG_PAYER" };

  // (4) A transaction cannot pay for an order that did not exist when it landed.
  if (notBefore && tx.blockTime && tx.blockTime * 1000 < notBefore) {
    return { ok: false, reason: "TOO_OLD" };
  }

  var meta = tx.meta || {};
  var pre = meta.preTokenBalances || [], post = meta.postTokenBalances || [];

  /* (5) and (6). Sum every token account the treasury owns holding the right
     mint — a transfer split across two of them still adds up, and a credit of
     any other token, or to anybody else, is simply not counted. */
  var sawTreasuryToken = false, sawWrongMint = false;
  var before = 0n, after = 0n;
  post.forEach(function (b) {
    if (b.owner !== treasury) return;
    if (b.mint !== mint) { sawWrongMint = true; return; }
    sawTreasuryToken = true;
    after += BigInt(b.uiTokenAmount.amount);
    var match = pre.find(function (p) { return p.accountIndex === b.accountIndex; });
    before += match ? BigInt(match.uiTokenAmount.amount) : 0n;
  });

  if (!sawTreasuryToken) {
    // Distinguish the two, because they mean different things to whoever reads
    // the log: one is a mistake, the other is an attempt.
    return { ok: false, reason: sawWrongMint ? "WRONG_MINT" : "NO_TRANSFER" };
  }

  // (7) An outgoing transfer computes as a negative delta and fails here too.
  var delta = after - before;
  if (delta < minimum) return { ok: false, reason: "UNDERPAID", paid: delta.toString() };

  return {
    ok: true,
    payer: keys[0],
    amount: delta.toString(),
    slot: tx.slot,
    blockTime: tx.blockTime || null
  };
}

/* Fetches, then checks. The split keeps every rule above testable without a
   network, and keeps this function down to the part that can only be done live. */
export async function verifyPayment(signature, referenceB58, expectPayer, notBefore) {
  var tx = await fetchTransaction(signature);
  return checkTransaction(tx, {
    reference: referenceB58,
    payer: expectPayer,
    notBefore: notBefore
  });
}

export async function rpcHealth() {
  try {
    var v = await connection.getVersion();
    return { ok: true, version: v["solana-core"] };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}
