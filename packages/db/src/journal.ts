/**
 * LEDGER PHASE 4b — hot-path journal emission (GR-HERMES-LEDGER-SPEC-001).
 *
 * The trader writes the journal AT THE MOMENT money moves, instead of waiting
 * for the sentinel's 5-minute derivation sweep. The trick that makes this a
 * zero-risk migration: the hot path uses the SAME idempotency keys the sweep
 * derives ('backfill:fill:<id>'), so emission and sweep CONVERGE — whichever
 * runs first wins the insert, the other no-ops on conflict. The sweep stays in
 * place as the guarantee (a crashed emit is healed within one cycle) and as
 * the author of trip.close residuals, which need the settled position row.
 *
 * Best-effort by design: a journal hiccup must never fail a trade. The sweep
 * is the reason best-effort is safe.
 */
import { sql } from "drizzle-orm";
import { db } from "./client.js";

export interface JournalFillArgs {
  fillId: number;
  book: string; // 'paper' | 'live'
  side: "buy" | "sell";
  filledAt: Date;
  positionId: number;
  mint: string;
  qty: number;
  priceUsd: number;
  feeUsd: number;
  entryPriceUsd: number; // cost basis for sell-side inventory release
  reason: string | null;
  txSignature?: string | null;
}

export async function journalFill(a: JournalFillArgs): Promise<void> {
  try {
    const key = `backfill:fill:${a.fillId}`;
    const gross = a.qty * a.priceUsd;
    const fee = a.feeUsd || 0;
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO ledger_events (book, event_type, occurred_at, idempotency_key, position_ref, tx_signature, memo, evidence)
        VALUES (${a.book}, ${"fill." + a.side}, ${a.filledAt.toISOString()}::timestamptz, ${key}, ${a.positionId}, ${a.txSignature ?? null},
                ${a.reason ?? a.side + " fill"},
                ${JSON.stringify({ hotPath: true, fillId: a.fillId, qty: a.qty, priceUsd: a.priceUsd, feeUsd: fee })}::jsonb)
        ON CONFLICT (idempotency_key) DO NOTHING`);
      if (a.side === "buy") {
        await tx.execute(sql`
          INSERT INTO ledger_legs (event_id, account, amount_usd, amount_native, mint)
          SELECT e.id, l.acct, l.amt, l.native, l.m FROM ledger_events e,
          LATERAL (VALUES
            ('cash:sol', ${String(-(gross + fee))}::numeric, NULL::numeric, NULL::text),
            (${"inventory:" + a.mint}, ${String(gross)}::numeric, ${String(a.qty)}::numeric, ${a.mint}),
            ('expense:fee:network', ${String(fee)}::numeric, NULL::numeric, NULL::text)
          ) l(acct, amt, native, m)
          WHERE e.idempotency_key = ${key}
            AND NOT EXISTS (SELECT 1 FROM ledger_legs ll WHERE ll.event_id = e.id)`);
      } else {
        const cost = a.qty * a.entryPriceUsd;
        await tx.execute(sql`
          INSERT INTO ledger_legs (event_id, account, amount_usd, amount_native, mint)
          SELECT e.id, l.acct, l.amt, l.native, l.m FROM ledger_events e,
          LATERAL (VALUES
            ('cash:sol', ${String(gross - fee)}::numeric, NULL::numeric, NULL::text),
            (${"inventory:" + a.mint}, ${String(-cost)}::numeric, ${String(-a.qty)}::numeric, ${a.mint}),
            ('expense:fee:network', ${String(fee)}::numeric, NULL::numeric, NULL::text),
            ('pnl:realized', ${String(cost - gross)}::numeric, NULL::numeric, NULL::text)
          ) l(acct, amt, native, m)
          WHERE e.idempotency_key = ${key}
            AND NOT EXISTS (SELECT 1 FROM ledger_legs ll WHERE ll.event_id = e.id)`);
      }
    });
  } catch (err) {
    // The sweep heals within one cycle — log loudly, never fail the trade.
    console.warn(`journal emit failed (sweep will heal): ${err instanceof Error ? err.message + " " + (err as { cause?: unknown }).cause : err}`);
  }
}
