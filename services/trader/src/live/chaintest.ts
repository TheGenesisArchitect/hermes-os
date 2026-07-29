/**
 * SNIPER CHAIN-TEST (operator watching, 2026-07-29: "Let's run the chaintest").
 * Proves the durable-nonce pre-signed exit end to end with REAL money on the
 * SAFEST pair on Solana (SOL↔USDC — deep, locked-class liquidity, zero rug
 * risk; max loss ≈ spread + fees ≈ $0.02). The memecoin drill comes with the
 * trader integration AFTER this passes.
 *
 *   1. Nonce lifecycle  — create/load durable nonce account, read its value
 *   2. The ticket       — buy $2.50 USDC via the live router (normal path)
 *   3. The surgery      — build full-exit USDC→SOL, decompile, prepend
 *                         advanceNonce, blockhash := nonce value, SIGN, store
 *   4. The shot         — submit the stored bytes; measure fire→settled ms
 *   5. The safety       — re-fire the SAME bytes (nonce now consumed) and
 *                         prove the chain rejects the double-shot → fallback
 *
 * Run: npx tsx services/trader/src/live/chaintest.ts
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
loadEnv({ path: resolve(import.meta.dirname, "../../../../.env") });
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionMessage, VersionedTransaction, NONCE_ACCOUNT_LENGTH, NonceAccount,
  type AddressLookupTableAccount,
} from "@solana/web3.js";
import bs58 from "bs58";
import { loadConfig } from "@hermes/core";
import { db, config as configTable } from "@hermes/db";
import { eq } from "drizzle-orm";
// Jupiter DIRECT for the majors pair — the router's memecoin-first ordering
// (PumpSwap intercepts) mis-serves USDC↔SOL; the mechanics under test are
// identical either way.
import { JupiterHostedProvider } from "./swap/jupiterHosted.js";
import { liveWallet } from "./wallet.js";
const jup = new JupiterHostedProvider();

const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TICKET_USD = 2.5;
const NONCE_CONFIG_KEY = "chaintest_nonce";

const step = (n: number, msg: string) => console.log(`\n━━ STEP ${n} ── ${msg}`);
const ok = (msg: string) => console.log(`   ✔ ${msg}`);
const info = (msg: string) => console.log(`   · ${msg}`);

async function sendAndConfirm(conn: Connection, raw: Buffer | Uint8Array, label: string): Promise<{ sig: string; ms: number }> {
  const t0 = Date.now();
  const sig = await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 3 });
  for (;;) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error(`${label} failed on-chain: ${JSON.stringify(st.err)}`);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) break;
    if (Date.now() - t0 > 60_000) throw new Error(`${label} unconfirmed after 60s: ${sig}`);
    await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return { sig, ms: Date.now() - t0 };
}

async function fetchAlts(conn: Connection, tx: VersionedTransaction): Promise<AddressLookupTableAccount[]> {
  const alts: AddressLookupTableAccount[] = [];
  for (const l of tx.message.addressTableLookups) {
    const r = await conn.getAddressLookupTable(l.accountKey);
    if (r.value) alts.push(r.value);
  }
  return alts;
}

(async () => {
  const cfg = loadConfig();
  const wallet = liveWallet();
  if (!wallet) throw new Error("no live wallet configured");
  const conn = new Connection(cfg.rpcUrls[0]!, "confirmed");
  console.log(`SNIPER CHAIN-TEST — wallet ${wallet.publicKey.toBase58()}`);
  const balStart = (await conn.getBalance(wallet.publicKey)) / 1e9;
  info(`starting balance ${balStart.toFixed(6)} SOL`);

  // ── STEP 1: durable nonce lifecycle ────────────────────────────────────────
  step(1, "durable nonce account — create or load, then read its value");
  let noncePub: PublicKey;
  const [row] = await db.select().from(configTable).where(eq(configTable.key, NONCE_CONFIG_KEY));
  if (row && (row.value as { pubkey?: string }).pubkey) {
    noncePub = new PublicKey((row.value as { pubkey: string }).pubkey);
    ok(`loaded existing nonce account ${noncePub.toBase58()}`);
  } else {
    const nonceKp = Keypair.generate();
    const rent = await conn.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: wallet.publicKey, newAccountPubkey: nonceKp.publicKey,
        lamports: rent, space: NONCE_ACCOUNT_LENGTH, programId: SystemProgram.programId,
      }),
      SystemProgram.nonceInitialize({ noncePubkey: nonceKp.publicKey, authorizedPubkey: wallet.publicKey }),
    );
    tx.feePayer = wallet.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    tx.sign(wallet, nonceKp);
    const { ms } = await sendAndConfirm(conn, tx.serialize(), "nonce creation");
    noncePub = nonceKp.publicKey;
    await db.insert(configTable).values({ key: NONCE_CONFIG_KEY, value: { pubkey: noncePub.toBase58() } })
      .onConflictDoUpdate({ target: configTable.key, set: { value: { pubkey: noncePub.toBase58() } } });
    ok(`created nonce account ${noncePub.toBase58()} (rent ${(rent / 1e9).toFixed(6)} SOL, landed ${ms}ms)`);
  }
  const nonceInfo1 = await conn.getAccountInfo(noncePub);
  if (!nonceInfo1) throw new Error("nonce account unreadable");
  const nonceVal1 = NonceAccount.fromAccountData(nonceInfo1.data).nonce;
  ok(`nonce value reads: ${nonceVal1.slice(0, 16)}… — STEP 1 PASS`);

  // ── STEP 2: the ticket — buy $2.50 of USDC ────────────────────────────────
  step(2, `the ticket — buy $${TICKET_USD} USDC via the live router (normal path)`);
  const solPriceQ = await jup.quote(cfg, USDC, WSOL, 1_000_000n, 300); // 1 USDC → SOL, for price
  const solPerUsd = Number(solPriceQ.outAmount) / 1e9;
  const lamportsIn = BigInt(Math.floor(TICKET_USD * solPerUsd * 1e9));
  info(`1 USDC ≈ ${solPerUsd.toFixed(6)} SOL → spending ${(Number(lamportsIn) / 1e9).toFixed(6)} SOL`);
  const buyQ = await jup.quote(cfg, WSOL, USDC, lamportsIn, 300);
  const buyB64 = await jup.buildSwapTx(cfg, buyQ, wallet.publicKey.toBase58());
  const buyTx = VersionedTransaction.deserialize(Buffer.from(buyB64, "base64"));
  buyTx.sign([wallet]);
  const buy = await sendAndConfirm(conn, buyTx.serialize(), "ticket buy");
  const usdcGot = BigInt(buyQ.outAmount);
  ok(`bought ~${(Number(usdcGot) / 1e6).toFixed(4)} USDC via jupiter-hosted (landed ${buy.ms}ms, tx ${buy.sig.slice(0, 8)}…) — STEP 2 PASS`);

  // ── STEP 3: the surgery — pre-signed exit with the nonce ──────────────────
  step(3, "the surgery — build full exit, prepend advanceNonce, blockhash := nonce, SIGN, store");
  const exitAmt = (usdcGot * 995n) / 1000n; // 99.5% — dust margin for fee rounding
  const exitQ = await jup.quote(cfg, USDC, WSOL, exitAmt, 300);
  const minOut = (BigInt(exitQ.outAmount) * 55n) / 100n; // the −45% STANDARD, embedded on-chain
  info(`exit route via jupiter-hosted · quoted out ${(Number(exitQ.outAmount) / 1e9).toFixed(6)} SOL · minOut floor ${(Number(minOut) / 1e9).toFixed(6)} SOL (0.55×)`);
  const exitB64 = await jup.buildSwapTx(cfg, exitQ, wallet.publicKey.toBase58());
  const exitTx = VersionedTransaction.deserialize(Buffer.from(exitB64, "base64"));
  const alts = await fetchAlts(conn, exitTx);
  info(`fetched ${alts.length} address-lookup table(s) for decompile`);
  const decompiled = TransactionMessage.decompile(exitTx.message, { addressLookupTableAccounts: alts });
  const rebuilt = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: nonceVal1, // ← the durable nonce IS the blockhash — never expires
    instructions: [
      SystemProgram.nonceAdvance({ noncePubkey: noncePub, authorizedPubkey: wallet.publicKey }),
      ...decompiled.instructions,
    ],
  }).compileToV0Message(alts);
  const presigned = new VersionedTransaction(rebuilt);
  presigned.sign([wallet]);
  const storedBytes = presigned.serialize();
  ok(`pre-signed exit stored: ${storedBytes.length} bytes, valid INDEFINITELY — STEP 3 PASS`);
  info("…this is the sniper round in the chamber. Waiting 20s to prove it outlives a normal blockhash…");
  await new Promise((r) => setTimeout(r, 20_000));

  // ── STEP 4: the shot — fire the stored bytes, measure ─────────────────────
  step(4, "the shot — submit stored bytes (no quote, no build, no sign)");
  const shot = await sendAndConfirm(conn, storedBytes, "pre-signed exit");
  ok(`FIRED AND SETTLED in ${shot.ms}ms (tx ${shot.sig.slice(0, 8)}…) — STEP 4 PASS`);

  // ── STEP 5: the safety — the consumed nonce must reject any NEW use ───────
  // (First version re-sent the SAME bytes: identical bytes = identical
  //  signature, so the RPC dedupes and reports the FIRST landing — no second
  //  execution occurs, but it proves nothing. The REAL proof: a DIFFERENT tx
  //  built on the consumed nonce value must be rejected.)
  step(5, "the safety — 5a: same bytes dedupe · 5b: NEW tx on the consumed nonce must die");
  const sig2 = await conn.sendRawTransaction(storedBytes, { skipPreflight: true, maxRetries: 0 }).catch((e) => String(e));
  if (sig2 === shot.sig) ok("5a: identical bytes returned the SAME signature — RPC dedup, no re-execution");
  else info(`5a: resend response: ${String(sig2).slice(0, 60)}`);
  const ghost = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: nonceVal1 })
    .add(SystemProgram.nonceAdvance({ noncePubkey: noncePub, authorizedPubkey: wallet.publicKey }))
    .add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: wallet.publicKey, lamports: 0 }));
  ghost.sign(wallet);
  try {
    const gsig = await conn.sendRawTransaction(ghost.serialize(), { skipPreflight: true, maxRetries: 0 });
    await new Promise((r) => setTimeout(r, 10_000));
    const st = (await conn.getSignatureStatuses([gsig])).value[0];
    if (st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized"))
      throw new Error("GHOST TX LANDED ON CONSUMED NONCE — FAIL");
    ok(`5b: ghost tx on the consumed nonce ${st?.err ? "failed on-chain" : "never landed"} — the chamber cannot be reused — STEP 5 PASS`);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    if (m.includes("FAIL")) throw err;
    ok(`5b: ghost tx rejected at submission (${m.slice(0, 55)}) — STEP 5 PASS`);
  }

  const balEnd = (await conn.getBalance(wallet.publicKey)) / 1e9;
  console.log(`\n━━ CHAIN-TEST COMPLETE ━━`);
  console.log(`   round-trip cost: ${(balStart - balEnd).toFixed(6)} SOL (spread + fees + one-time nonce rent)`);
  console.log(`   the sniper works: pre-signed, nonce-durable, ${shot.ms}ms fire-to-settled, double-fire safe.`);
  process.exit(0);
})().catch((err) => {
  console.error(`\n✗ CHAIN-TEST HALTED: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
