/**
 * THE SNIPER — durable-nonce pre-signed exits (chain-test PASSED 2026-07-29,
 * all five steps, operator watching: chaintest.ts is the permanent drill).
 *
 * Every live fill chambers its own full-exit transaction at boarding: quoted,
 * built, nonce-armed, SIGNED — so a guard fire is one network send with zero
 * build work, racing the drain from the 95% side of the recovery cliff.
 *
 * Gated behind LIVE_PRESIGNED_EXITS (default false). The fallback (live-quote
 * flee path) is always armed behind it — the sniper can only make exits
 * faster, never worse.
 */
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionMessage, VersionedTransaction, NONCE_ACCOUNT_LENGTH, NonceAccount,
  type AddressLookupTableAccount,
} from "@solana/web3.js";
import { sql } from "drizzle-orm";
import type { HermesConfig } from "@hermes/core";
import { db } from "@hermes/db";
import { swapRouter } from "./swap/router.js";
import { liveWallet } from "./wallet.js";

const WSOL = "So11111111111111111111111111111111111111112";
const NONCES_KEY = "presigned_nonces";
const CHAMBER_MAX_AGE_MS = 5 * 60_000;
const MIN_OUT_FRAC = 55n; // ×/100 — the −45% STANDARD embedded on-chain

interface Chamber {
  bytes: Uint8Array;
  noncePub: string;
  builtAt: number;
  qtyRaw: bigint;
  provider: string;
}
const chambers = new Map<number, Chamber>(); // positionId → round in the chamber
const nonceInUse = new Map<string, number>(); // noncePub → positionId

async function conn(cfg: HermesConfig): Promise<Connection> {
  return new Connection(cfg.rpcUrls[0]!, "confirmed");
}

/** Load-or-create the persisted nonce pool, growing it to `need` accounts. */
async function noncePool(cfg: HermesConfig, need: number): Promise<string[]> {
  const wallet = liveWallet();
  if (!wallet) return [];
  const c = await conn(cfg);
  const [row] = (await db.execute(sql`SELECT value FROM config WHERE key=${NONCES_KEY}`)) as unknown as { value: { pubkeys?: string[] } }[];
  const pubkeys: string[] = row?.value?.pubkeys ?? [];
  while (pubkeys.length < need) {
    const kp = Keypair.generate();
    const rent = await c.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: wallet.publicKey, newAccountPubkey: kp.publicKey,
        lamports: rent, space: NONCE_ACCOUNT_LENGTH, programId: SystemProgram.programId,
      }),
      SystemProgram.nonceInitialize({ noncePubkey: kp.publicKey, authorizedPubkey: wallet.publicKey }),
    );
    tx.feePayer = wallet.publicKey;
    tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
    tx.sign(wallet, kp);
    const sig = await c.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
    for (let i = 0; i < 30; i++) {
      const st = (await c.getSignatureStatuses([sig])).value[0];
      if (st?.err) throw new Error(`nonce creation failed: ${JSON.stringify(st.err)}`);
      if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") break;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    pubkeys.push(kp.publicKey.toBase58());
    console.log(`🎯 sniper: nonce account ${pubkeys.length} created ${kp.publicKey.toBase58()}`);
  }
  await db.execute(sql`
    INSERT INTO config (key, value) VALUES (${NONCES_KEY}, ${JSON.stringify({ pubkeys })}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify({ pubkeys })}::jsonb`);
  return pubkeys;
}

function freeNonce(pubkeys: string[], positionId: number): string | null {
  const held = [...nonceInUse.entries()].find(([, pid]) => pid === positionId)?.[0];
  if (held) return held; // re-chamber reuses the same (un-advanced) nonce
  return pubkeys.find((pk) => !nonceInUse.has(pk)) ?? null;
}

/** Chamber (or re-chamber) the full exit for a live position. Never throws. */
export async function chamberExit(
  cfg: HermesConfig,
  positionId: number,
  mint: string,
): Promise<boolean> {
  if (!cfg.LIVE_PRESIGNED_EXITS) return false;
  const wallet = liveWallet();
  if (!wallet) return false;
  try {
    const c = await conn(cfg);
    const pubkeys = await noncePool(cfg, Math.max(4, nonceInUse.size + 1));
    const noncePub = freeNonce(pubkeys, positionId);
    if (!noncePub) return false;
    // Raw balance straight from the chain — the chamber sells what we HOLD.
    const bal = await c.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(mint) });
    const amtInfo = bal.value[0]?.account.data as { parsed?: { info?: { tokenAmount?: { amount: string } } } } | undefined;
    const rawStr = amtInfo?.parsed?.info?.tokenAmount?.amount ?? "0";
    const qtyRaw = (BigInt(rawStr) * 995n) / 1000n; // dust margin
    if (qtyRaw <= 0n) return false;
    const q = await swapRouter.quote(cfg, mint, WSOL, qtyRaw, cfg.LIVE_STOP_SLIPPAGE_BPS);
    const b64 = await swapRouter.buildSwapTx(
      { ...cfg, PUMPPORTAL_PRIORITY_FEE: cfg.PUMPPORTAL_PRIORITY_FEE * 3 }, // flee fee pre-paid
      q, wallet.publicKey.toBase58(),
    );
    const built = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
    const alts: AddressLookupTableAccount[] = [];
    for (const l of built.message.addressTableLookups) {
      const r = await c.getAddressLookupTable(l.accountKey);
      if (r.value) alts.push(r.value);
    }
    const ni = await c.getAccountInfo(new PublicKey(noncePub));
    if (!ni) return false;
    const nonceVal = NonceAccount.fromAccountData(ni.data).nonce;
    const decompiled = TransactionMessage.decompile(built.message, { addressLookupTableAccounts: alts });
    const msg = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: nonceVal,
      instructions: [
        SystemProgram.nonceAdvance({ noncePubkey: new PublicKey(noncePub), authorizedPubkey: wallet.publicKey }),
        ...decompiled.instructions,
      ],
    }).compileToV0Message(alts);
    const tx = new VersionedTransaction(msg);
    tx.sign([wallet]);
    chambers.set(positionId, { bytes: tx.serialize(), noncePub, builtAt: Date.now(), qtyRaw, provider: q.provider });
    nonceInUse.set(noncePub, positionId);
    return true;
  } catch (err) {
    console.warn(`🎯 sniper: chamber failed for #${positionId} (fallback path stands): ${err instanceof Error ? err.message.slice(0, 80) : err}`);
    return false;
  }
}

/** Fire the chambered round. Returns the signature + landMs, or null → caller
 *  falls back to the live-quote flee path. The nonce advances on landing. */
export async function fireChambered(
  cfg: HermesConfig,
  positionId: number,
): Promise<{ signature: string; landMs: number; qtyRaw: bigint; provider: string } | null> {
  const round = chambers.get(positionId);
  if (!round) return null;
  if (Date.now() - round.builtAt > CHAMBER_MAX_AGE_MS) {
    // stale round: still VALID (nonce never expires) but the route may have
    // rotted — fire it anyway (fastest option), fallback covers a miss.
    console.log(`🎯 sniper: firing a stale round for #${positionId} (${Math.round((Date.now() - round.builtAt) / 1000)}s old)`);
  }
  try {
    const c = await conn(cfg);
    const t0 = Date.now();
    const sig = await c.sendRawTransaction(round.bytes, { skipPreflight: true, maxRetries: 3 });
    for (;;) {
      const st = (await c.getSignatureStatuses([sig])).value[0];
      if (st?.err) throw new Error(`chambered round failed on-chain: ${JSON.stringify(st.err)}`);
      if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") break;
      if (Date.now() - t0 > 30_000) throw new Error("chambered round unconfirmed after 30s");
      await c.sendRawTransaction(round.bytes, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1_000));
    }
    releaseChamber(positionId);
    return { signature: sig, landMs: Date.now() - t0, qtyRaw: round.qtyRaw, provider: round.provider };
  } catch (err) {
    console.warn(`🎯 sniper: chambered fire MISSED for #${positionId} → fallback: ${err instanceof Error ? err.message.slice(0, 80) : err}`);
    releaseChamber(positionId);
    return null;
  }
}

/** Drop the round and free its nonce (position closed, or fire consumed it). */
export function releaseChamber(positionId: number): void {
  const round = chambers.get(positionId);
  if (round) nonceInUse.delete(round.noncePub);
  chambers.delete(positionId);
}

/** Age check for the refresh loop. */
export function chamberAgeMs(positionId: number): number | null {
  const round = chambers.get(positionId);
  return round ? Date.now() - round.builtAt : null;
}
