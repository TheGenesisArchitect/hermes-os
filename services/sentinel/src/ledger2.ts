/**
 * LEDGER PHASE 2 — continuous journal sync + the chain reconciler.
 * (GR-HERMES-LEDGER-SPEC-001 §3, §6.2)
 *
 * SYNC: the Phase-1 derivation is fully idempotent and set-based, so Phase 2's
 * "dual-write" is implemented as a continuous derivation sweep — every new fill
 * and close lands in the journal within one cycle, with identical semantics to
 * the backfill (one code path, one truth). Direct event emission from the
 * trader's hot paths can replace this in Phase 4 without changing a single
 * downstream consumer.
 *
 * RECONCILER: the chain is the auditor. Every cycle, read the live wallet's
 * SOL on-chain and compare its movement against the journal's cash movement
 * since the last anchor. Small drift = green heartbeat. Drift beyond tolerance
 * = a recon.adjust event with the measured delta (never silently absorbed),
 * a phone alert, and a fresh anchor. The KNOWN gap this will surface first:
 * live's real priority/DEX fees are barely recorded ($1.35 ever), so drift
 * should accumulate at roughly fee-rate while live trades — that visibility
 * is the point, and Phase 2's tx parsing closes it.
 */
import { sql } from "drizzle-orm";
import { db, config } from "@hermes/db";
import { eq } from "drizzle-orm";
import { fetchJupiterPrice, resilientFetch, type HermesConfig } from "@hermes/core";

const WSOL = "So11111111111111111111111111111111111111112";
const LIVE_WALLET = "rEPAt2uXrLHpN3J7By4PaAjbdi21V7rXozDipw5X1Q5";
/** Drift tolerance. Wide while live fees are unledgered; tighten with Phase-2 tx parsing. */
const DRIFT_TOLERANCE_USD = 0.5;

/** One idempotent derivation sweep — new fills/closes since the last sweep land in the journal. */
export async function runLedgerSync(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO ledger_events (book, event_type, occurred_at, idempotency_key, position_ref, tx_signature, memo, evidence)
      SELECT p.lane, 'fill.' || f.side, f.filled_at, 'backfill:fill:' || f.id, f.position_id, f.tx_signature,
             coalesce(f.reason, f.side || ' fill'),
             jsonb_build_object('backfill', true, 'fillId', f.id, 'qty', f.qty_tokens, 'priceUsd', f.price_usd,
                                'feeUsd', f.fee_usd, 'slippagePct', f.slippage_pct)
      FROM fills f JOIN positions p ON p.id = f.position_id
      ON CONFLICT (idempotency_key) DO NOTHING`);
    await tx.execute(sql`
      INSERT INTO ledger_legs (event_id, account, amount_usd, amount_native, mint)
      SELECT e.id, leg.account, leg.amount, leg.native, leg.mint
      FROM ledger_events e
      JOIN fills f ON 'backfill:fill:' || f.id = e.idempotency_key
      JOIN positions p ON p.id = f.position_id,
      LATERAL (VALUES
        ('cash:sol',                 -(f.qty_tokens * f.price_usd + coalesce(f.fee_usd, 0)), NULL::numeric, NULL::text),
        ('inventory:' || p.mint,      (f.qty_tokens * f.price_usd),                          f.qty_tokens,  p.mint),
        ('expense:fee:network',       coalesce(f.fee_usd, 0),                                NULL,          NULL)
      ) AS leg(account, amount, native, mint)
      WHERE e.event_type = 'fill.buy'
        AND NOT EXISTS (SELECT 1 FROM ledger_legs ll WHERE ll.event_id = e.id)`);
    await tx.execute(sql`
      INSERT INTO ledger_legs (event_id, account, amount_usd, amount_native, mint)
      SELECT e.id, leg.account, leg.amount, leg.native, leg.mint
      FROM ledger_events e
      JOIN fills f ON 'backfill:fill:' || f.id = e.idempotency_key
      JOIN positions p ON p.id = f.position_id,
      LATERAL (VALUES
        ('cash:sol',              (f.qty_tokens * f.price_usd - coalesce(f.fee_usd, 0)),      NULL::numeric, NULL::text),
        ('inventory:' || p.mint,  -(f.qty_tokens * p.entry_price_usd),                        -f.qty_tokens, p.mint),
        ('expense:fee:network',    coalesce(f.fee_usd, 0),                                    NULL,          NULL),
        ('pnl:realized',          (f.qty_tokens * p.entry_price_usd) - (f.qty_tokens * f.price_usd), NULL,  NULL)
      ) AS leg(account, amount, native, mint)
      WHERE e.event_type = 'fill.sell'
        AND NOT EXISTS (SELECT 1 FROM ledger_legs ll WHERE ll.event_id = e.id)`);
    await tx.execute(sql`
      INSERT INTO ledger_events (book, event_type, occurred_at, idempotency_key, position_ref, memo, evidence)
      SELECT p.lane, 'trip.close', coalesce(p.closed_at, now()), 'backfill:close:' || p.id, p.id,
             coalesce(p.exit_reason, 'closed'),
             jsonb_build_object('backfill', true, 'exitReason', p.exit_reason, 'bookedPnl', p.realized_pnl_usd)
      FROM positions p WHERE p.status = 'closed'
      ON CONFLICT (idempotency_key) DO NOTHING`);
    await tx.execute(sql`
      INSERT INTO ledger_legs (event_id, account, amount_usd)
      SELECT e.id, leg.account, leg.amount
      FROM ledger_events e
      JOIN positions p ON 'backfill:close:' || p.id = e.idempotency_key,
      LATERAL (
        SELECT coalesce(p.realized_pnl_usd, 0)
               - coalesce((SELECT -sum(ll.amount_usd)
                           FROM ledger_legs ll
                           JOIN ledger_events ev ON ev.id = ll.event_id
                           WHERE ev.position_ref = p.id AND ll.account = 'pnl:realized'), 0) AS resid
      ) r,
      LATERAL (VALUES
        ('pnl:realized',            -r.resid),
        ('inventory:' || p.mint,     CASE WHEN r.resid < 0 THEN r.resid ELSE 0 END),
        ('equity:adjustment',        CASE WHEN r.resid >= 0 THEN r.resid ELSE 0 END)
      ) AS leg(account, amount)
      WHERE e.event_type = 'trip.close'
        AND abs(r.resid) > 0.000001
        AND NOT EXISTS (SELECT 1 FROM ledger_legs ll2 WHERE ll2.event_id = e.id)`);
    // ── CLOSE CORRECTIONS (panel audit, 2026-07-23) ─────────────────────────
    // The trip.close residual is keyed by position id ONLY, so a row healed
    // AFTER its close event exists (finn, COW — the late-fill race) could
    // never re-reconcile: DO NOTHING kept the stale journal and the Ledger
    // panel drifted from the book (paper −$29.27, live −$4.51 at audit time).
    // Corrections are keyed by id + the row's CURRENT value, so each new
    // healed value posts exactly one balancing event and the journal follows
    // the book wherever the audited heals take it. Append-only, Σ=0 legs.
    await tx.execute(sql`
      INSERT INTO ledger_events (book, event_type, occurred_at, idempotency_key, position_ref, memo, evidence)
      SELECT p.lane, 'trip.correction', now(),
             'close-correction:' || p.id || ':' || round(coalesce(p.realized_pnl_usd, 0)::numeric, 4)::text,
             p.id, 'row-vs-journal residual (post-heal re-reconcile)',
             jsonb_build_object('rowPnl', p.realized_pnl_usd, 'exitReason', p.exit_reason)
      FROM positions p
      WHERE p.status = 'closed'
        AND abs(coalesce(p.realized_pnl_usd, 0)
                - coalesce((SELECT -sum(ll.amount_usd)
                            FROM ledger_legs ll JOIN ledger_events ev ON ev.id = ll.event_id
                            WHERE ev.position_ref = p.id AND ll.account = 'pnl:realized'), 0)) > 0.01
      ON CONFLICT (idempotency_key) DO NOTHING`);
    await tx.execute(sql`
      INSERT INTO ledger_legs (event_id, account, amount_usd)
      SELECT e.id, leg.account, leg.amount
      FROM ledger_events e
      JOIN positions p ON p.id = e.position_ref::int AND e.event_type = 'trip.correction',
      LATERAL (
        SELECT coalesce(p.realized_pnl_usd, 0)
               - coalesce((SELECT -sum(ll.amount_usd)
                           FROM ledger_legs ll
                           JOIN ledger_events ev ON ev.id = ll.event_id
                           WHERE ev.position_ref = p.id AND ll.account = 'pnl:realized'), 0) AS resid
      ) r,
      LATERAL (VALUES
        ('pnl:realized',      -r.resid),
        ('equity:adjustment',  r.resid)
      ) AS leg(account, amount)
      WHERE abs(r.resid) > 0.000001
        AND NOT EXISTS (SELECT 1 FROM ledger_legs ll2 WHERE ll2.event_id = e.id)`);
  });
}

interface Anchor { sol: number; journalCashUsd: number; at: string }

async function journalLiveCashUsd(): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT coalesce(sum(l.amount_usd), 0)::float8 AS cash
    FROM ledger_legs l JOIN ledger_events e ON e.id = l.event_id
    WHERE e.book = 'live' AND l.account = 'cash:sol'`)) as unknown as { cash: number }[];
  return Number(rows[0]?.cash ?? 0);
}

async function chainSol(cfg: HermesConfig): Promise<number | null> {
  try {
    const res = await resilientFetch(cfg.rpcUrls[0]!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [LIVE_WALLET] }),
      timeoutMs: 8_000,
    });
    const body = (await res.json()) as { result?: { value?: number } };
    const lamports = body.result?.value;
    return typeof lamports === "number" ? lamports / 1e9 : null;
  } catch {
    return null; // an RPC blip is not drift — skip the cycle
  }
}

/**
 * Prove the live journal against the chain. Returns a status line for the log;
 * pushes `notify` only when drift exceeds tolerance.
 */
export async function runReconciler(
  cfg: HermesConfig,
  notify: (title: string, lines: string[]) => Promise<void>,
): Promise<string> {
  const sol = await chainSol(cfg);
  if (sol == null) return "recon: skipped (RPC unreachable)";
  const price = (await fetchJupiterPrice(cfg.JUPITER_PRICE_URL, WSOL).catch(() => null)) ?? null;
  if (price == null || !(price > 0)) return "recon: skipped (no SOL price)";
  const cashNow = await journalLiveCashUsd();

  const [row] = await db.select().from(config).where(eq(config.key, "ledger_anchor_live"));
  const anchor = (row?.value ?? null) as Anchor | null;
  if (!anchor) {
    const fresh: Anchor = { sol, journalCashUsd: cashNow, at: new Date().toISOString() };
    await db
      .insert(config)
      .values({ key: "ledger_anchor_live", value: fresh })
      .onConflictDoUpdate({ target: config.key, set: { value: fresh, updatedAt: new Date() } });
    return `recon: ANCHORED at ${sol.toFixed(6)} SOL ($${(sol * price).toFixed(2)})`;
  }

  // Drift = what the chain says moved minus what the journal says moved.
  const chainMoveUsd = (sol - anchor.sol) * price;
  const journalMoveUsd = cashNow - anchor.journalCashUsd;
  const drift = chainMoveUsd - journalMoveUsd;

  // Heartbeat row for the dashboard — the Ledger workspace renders this as the
  // "proven against the chain N min ago" tick. Written every cycle, green or not.
  const status = { at: new Date().toISOString(), driftUsd: drift, chainSol: sol, solUsd: price, green: Math.abs(drift) <= DRIFT_TOLERANCE_USD };
  await db
    .insert(config)
    .values({ key: "ledger_recon_status", value: status })
    .onConflictDoUpdate({ target: config.key, set: { value: status, updatedAt: new Date() } });

  if (Math.abs(drift) <= DRIFT_TOLERANCE_USD) {
    return `recon: ✅ green — drift $${drift.toFixed(3)} (chain ${sol.toFixed(6)} SOL ≈ $${(sol * price).toFixed(2)})`;
  }

  // Drift beyond tolerance: book it, say it, re-anchor. Never silently absorbed.
  const key = `recon:${new Date().toISOString()}`;
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO ledger_events (book, event_type, occurred_at, idempotency_key, memo, evidence)
      VALUES ('live', 'recon.adjust', now(), ${key},
              'chain-vs-journal drift beyond tolerance — see evidence',
              ${JSON.stringify({ chainSol: sol, solUsd: price, chainMoveUsd, journalMoveUsd, driftUsd: drift, anchor })}::jsonb)
      ON CONFLICT (idempotency_key) DO NOTHING`);
    await tx.execute(sql`
      INSERT INTO ledger_legs (event_id, account, amount_usd)
      SELECT e.id, l.acct, l.amt FROM ledger_events e,
      LATERAL (VALUES ('cash:sol', ${drift}::numeric), ('equity:adjustment', ${-drift}::numeric)) l(acct, amt)
      WHERE e.idempotency_key = ${key}
        AND NOT EXISTS (SELECT 1 FROM ledger_legs ll WHERE ll.event_id = e.id)`);
  });
  const fresh: Anchor = { sol, journalCashUsd: cashNow + drift, at: new Date().toISOString() };
  await db
    .insert(config)
    .values({ key: "ledger_anchor_live", value: fresh })
    .onConflictDoUpdate({ target: config.key, set: { value: fresh, updatedAt: new Date() } });
  await notify(`LEDGER · drift $${drift.toFixed(2)}`, [
    `chain moved $${chainMoveUsd.toFixed(2)} · journal moved $${journalMoveUsd.toFixed(2)}`,
    `booked as recon.adjust with evidence · re-anchored at ${sol.toFixed(4)} SOL`,
    `likely cause while live trades: unledgered priority/DEX fees`,
  ]);
  return `recon: ⚠ drift $${drift.toFixed(2)} — booked + re-anchored`;
}
