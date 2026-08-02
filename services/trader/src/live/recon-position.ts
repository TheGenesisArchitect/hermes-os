/**
 * CHAIN-TRUTH RECONCILE — read-only by default.
 *
 * Compares one live position's LEDGER state against what the wallet actually
 * holds on chain, and inspects a named transaction to see whether it moved any
 * tokens at all. Written for #7110 (JORDAN), whose chambered round confirmed
 * on-chain for 36,465 tokens while the wallet kept all 36,648 — the book ended
 * up carrying both the loss and the inventory.
 *
 *   read-only:  tsx src/live/recon-position.ts 7110
 *   apply:      tsx src/live/recon-position.ts 7110 --apply
 *
 * OWNER  Execution + Accounting
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
loadEnv({ path: resolve(import.meta.dirname, "../../../../.env") });

import { Connection, PublicKey } from "@solana/web3.js";
import { loadConfig } from "@hermes/core";
import { db } from "@hermes/db";
import { sql } from "drizzle-orm";
import { liveWallet } from "./wallet.js";

const POSITION_ID = Number(process.argv[2] ?? 0);
const APPLY = process.argv.includes("--apply");
if (!POSITION_ID) { console.error("usage: recon-position.ts <positionId> [--apply]"); process.exit(1); }

const cfg = await loadConfig();
const wallet = liveWallet();
if (!wallet) { console.error("no live wallet configured"); process.exit(1); }

const [pos] = (await db.execute(sql`
  SELECT id, mint, status, size_usd::float sz, qty_tokens::float q0,
         qty_remaining::float qr, realized_pnl_usd::float pnl, exit_reason
  FROM positions WHERE id = ${POSITION_ID}`)) as unknown as {
    id: number; mint: string; status: string; sz: number; q0: number;
    qr: number; pnl: number; exit_reason: string | null;
  }[];
if (!pos) { console.error(`position ${POSITION_ID} not found`); process.exit(1); }

const fills = (await db.execute(sql`
  SELECT id, side, qty_tokens::float q, price_usd::float px, fee_usd::float fee,
         reason, tx_signature FROM fills WHERE position_id = ${POSITION_ID} ORDER BY id`)) as unknown as
  { id: number; side: string; q: number; px: number; fee: number; reason: string | null; tx_signature: string | null }[];

const conn = new Connection(cfg.rpcUrls[0]!, "confirmed");

// ── CHAIN TRUTH: what does the wallet actually hold right now? ───────────────
const accts = await conn.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(pos.mint) });
let rawHeld = 0n; let decimals = 0;
for (const { account } of accts.value) {
  const amt = (account.data as { parsed?: { info?: { tokenAmount?: { amount: string; decimals: number } } } })
    .parsed?.info?.tokenAmount;
  if (amt) { rawHeld += BigInt(amt.amount); decimals = amt.decimals; }
}
const heldUi = decimals > 0 ? Number(rawHeld) / 10 ** decimals : Number(rawHeld);

console.log(`\n${"=".repeat(78)}`);
console.log(`POSITION #${pos.id}  ${pos.mint.slice(0, 12)}…  status=${pos.status}`);
console.log(`${"=".repeat(78)}`);
console.log(`  LEDGER   qty_tokens ${pos.q0}  qty_remaining ${pos.qr}  realized $${pos.pnl.toFixed(4)}`);
console.log(`  CHAIN    holds ${heldUi} tokens across ${accts.value.length} account(s), decimals ${decimals}`);
console.log(`  DELTA    ledger_remaining − chain_held = ${(pos.qr - heldUi).toFixed(6)}`);

console.log(`\nFILLS`);
let feePaid = 0, sellQty = 0, sellProceeds = 0, buyQty = 0, buyCost = 0;
for (const f of fills) {
  feePaid += f.fee ?? 0;
  if (f.side === "sell") { sellQty += f.q; sellProceeds += f.q * f.px; }
  else { buyQty += f.q; buyCost += f.q * f.px; }
  console.log(`  #${f.id} ${f.side.padEnd(4)} qty ${String(f.q).padEnd(16)} px ${f.px} fee $${(f.fee ?? 0).toFixed(5)} ${f.reason ?? ""}`);
}

// ── DID THE NAMED SELL ACTUALLY MOVE TOKENS? ────────────────────────────────
for (const f of fills.filter((x) => x.side === "sell" && x.tx_signature)) {
  const tx = await conn.getTransaction(f.tx_signature!, { maxSupportedTransactionVersion: 0 });
  if (!tx?.meta) { console.log(`\n  tx ${f.tx_signature!.slice(0, 12)}… NOT FOUND on chain`); continue; }
  const owner = wallet.publicKey.toBase58();
  const pre = (tx.meta.preTokenBalances ?? []).filter((b) => b.owner === owner && b.mint === pos.mint);
  const post = (tx.meta.postTokenBalances ?? []).filter((b) => b.owner === owner && b.mint === pos.mint);
  const preAmt = pre.reduce((s, b) => s + Number(b.uiTokenAmount.uiAmount ?? 0), 0);
  const postAmt = post.reduce((s, b) => s + Number(b.uiTokenAmount.uiAmount ?? 0), 0);
  console.log(`\n  SELL TX ${f.tx_signature!.slice(0, 16)}…`);
  console.log(`    on-chain error : ${tx.meta.err ? JSON.stringify(tx.meta.err) : "none (confirmed)"}`);
  console.log(`    our token bal  : pre ${preAmt}  →  post ${postAmt}   MOVED ${(preAmt - postAmt).toFixed(6)}`);
  console.log(`    ledger claims  : ${f.q} tokens sold`);
  console.log(`    VERDICT        : ${Math.abs(preAmt - postAmt) < 1e-9 ? "NO TOKENS MOVED — phantom fill" : "tokens moved"}`);
}

// ── THE CORRECTION ──────────────────────────────────────────────────────────
// The tokens that ACTUALLY left the wallet, from the transaction itself.
const movedUi = Math.max(0, pos.q0 - heldUi);
const phantom = fills.filter((f) => f.side === "sell" && f.px === 0 && f.q > movedUi + 1e-9);
// Convention MATCHED TO THE LIVE SELL PATH, deliberately: it books
// `proceeds − costBasis − SELL fee` and leaves the buy fee out of realized
// entirely (size_usd is qty×price, exclusive of the $0.037 entry fee). Booking
// the buy fee here would make this one row inconsistent with every other
// position in the book. The buy-fee gap is real but it is book-wide, and fixing
// it on a single position would be worse than leaving it visible.
const sellFees = fills.filter((f) => f.side === "sell").reduce((s, f) => s + (f.fee ?? 0), 0);
const basisMoved = pos.q0 > 0 ? pos.sz * (movedUi / pos.q0) : 0;
const trueRealized = sellProceeds - basisMoved - sellFees;
console.log(`\nPROPOSED CORRECTION`);
console.log(`  tokens that actually left the wallet: ${movedUi} (ledger claimed ${sellQty})`);
console.log(`  realized_pnl_usd  $${pos.pnl.toFixed(4)}  →  $${trueRealized.toFixed(4)}`);
console.log(`     = proceeds $${sellProceeds.toFixed(4)} − basis-of-moved $${basisMoved.toFixed(7)} − sell fees $${sellFees.toFixed(5)}`);
console.log(`  qty_remaining     ${pos.qr}  →  ${heldUi}   (chain truth${Math.abs(pos.qr - heldUi) < 1e-9 ? " — already correct" : ""})`);
console.log(`  overstated sell fills to correct: ${phantom.map((f) => "#" + f.id).join(", ") || "(none)"}  → qty ${movedUi}`);
console.log(`  buy fee $${(feePaid - sellFees).toFixed(5)} left UNBOOKED (book-wide convention, not fixed here)`);

if (!APPLY) { console.log(`\n  READ-ONLY. Re-run with --apply to write.\n`); await db.$client.end?.(); process.exit(0); }

console.log(`\n  APPLYING…`);
// `fills` and `ledger_legs` are FROZEN by design, and the trigger names the
// sanctioned remedy: "correct via a ledger reversal event". So the phantom fill
// row STAYS — it is the honest record of what the executor believed at 03:37:42
// — and a compensating event restores inventory and unwinds the false P&L. No
// hermes.unlock, no archaeology. History is evidence.
for (const f of phantom) {
  const [ev] = (await db.execute(sql`
    SELECT id FROM ledger_events WHERE idempotency_key = ${"backfill:fill:" + f.id}`)) as unknown as { id: number }[];
  if (!ev) { console.log(`    fill #${f.id}: no ledger event found — skipped`); continue; }
  const legs = (await db.execute(sql`
    SELECT account, amount_usd::float u, amount_native::float n FROM ledger_legs WHERE event_id = ${ev.id}`)) as unknown as
    { account: string; u: number; n: number | null }[];
  const inv = legs.find((l) => l.account.startsWith("inventory:"));
  if (!inv) { console.log(`    event ${ev.id}: no inventory leg — skipped`); continue; }

  // What the leg SHOULD have been, given what the chain says moved.
  const invUsdCorrect = -basisMoved;
  const invNativeCorrect = -movedUi;
  const dUsd = invUsdCorrect - inv.u;              // positive: restore inventory
  const dNative = invNativeCorrect - (inv.n ?? 0);

  await db.transaction(async (tx) => {
    const [ne] = (await tx.execute(sql`
      INSERT INTO ledger_events (book, event_type, occurred_at, idempotency_key, position_ref, tx_signature, memo, evidence)
      VALUES ('live','recon.adjust', now(), ${"recon:noxfer:fill:" + f.id}, ${POSITION_ID}, ${f.tx_signature},
        'reverse phantom inventory relief — settlement confirmed but moved no tokens',
        ${JSON.stringify({
          fillId: f.id, reversedEvent: ev.id,
          claimedSoldQty: f.q, actuallyMovedQty: movedUi,
          invUsdWas: inv.u, invUsdCorrect, invNativeWas: inv.n, invNativeCorrect,
          txSignature: f.tx_signature,
          note: "chambered round confirmed on-chain with no error but transferred 0.0103 tokens, not 36,465; the book carried the full loss AND the inventory",
        })}::jsonb)
      RETURNING id`)) as unknown as { id: number }[];
    await tx.execute(sql`
      INSERT INTO ledger_legs (event_id, account, amount_usd, amount_native, mint) VALUES
        (${ne!.id}, ${inv.account}, ${String(dUsd)}, ${String(dNative)}, ${pos.mint}),
        (${ne!.id}, 'pnl:realized', ${String(-dUsd)}, NULL, NULL)`);
  });
  console.log(`    ledger event ${ev.id} reversed → inventory ${dUsd >= 0 ? "+" : ""}$${dUsd.toFixed(7)} / ${dNative >= 0 ? "+" : ""}${dNative} tokens, pnl:realized ${(-dUsd).toFixed(7)}`);
}
await db.execute(sql`
  UPDATE positions SET realized_pnl_usd = ${String(trueRealized)}, qty_remaining = ${String(heldUi)}
  WHERE id = ${POSITION_ID} AND status = 'open'`);
console.log(`    position #${POSITION_ID}: realized → $${trueRealized.toFixed(4)}, qty_remaining → ${heldUi}`);
await db.execute(sql`
  INSERT INTO audit_log (actor, action, details) VALUES ('user','live_ledger_reconciled',
    ${JSON.stringify({
      positionId: POSITION_ID, mint: pos.mint,
      realizedWas: pos.pnl, realizedNow: trueRealized,
      qtyRemainingWas: pos.qr, qtyRemainingNow: heldUi,
      correctedFills: phantom.map((f) => f.id),
      claimedSoldQty: sellQty, actuallyMovedQty: movedUi,
      sellFees, buyFeeLeftUnbooked: feePaid - sellFees,
      reason: "chambered round confirmed on-chain but moved 0.0103 tokens, not 36,465; the book carried the full loss AND the inventory",
    })}::jsonb)`);
console.log(`    audit row written.\n`);
await db.$client.end?.();
