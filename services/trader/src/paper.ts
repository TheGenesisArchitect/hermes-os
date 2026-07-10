import { fetchTokenMarket, type HermesConfig, type TokenMarket } from "@hermes/core";
import { auditLog, db, fills, pnlSnapshots, positions, signals, tokens } from "@hermes/db";
import { and, eq, gte, sql } from "drizzle-orm";

const FEE_PCT = 0.25; // per-side swap fee estimate
const FIXED_FEE_USD = 0.02; // priority fee / network cost per fill

/** Rough AMM slippage estimate: order size as a share of pool depth, capped. */
function slippagePct(sizeUsd: number, liquidityUsd: number): number {
  if (liquidityUsd <= 0) return 10;
  return Math.min((sizeUsd / liquidityUsd) * 100, 10);
}

function n(v: string | null): number {
  return v === null ? 0 : Number(v);
}

type Position = typeof positions.$inferSelect;

async function audit(action: string, details: Record<string, unknown>): Promise<void> {
  await db.insert(auditLog).values({ actor: "trader", action, details });
}

function short(mint: string): string {
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

/** Open paper positions for fresh, high-scoring signals. */
export async function openNewPositions(cfg: HermesConfig): Promise<void> {
  const cutoff = new Date(Date.now() - cfg.SIGNAL_MAX_AGE_MIN * 60_000);
  const candidates = await db
    .select({ signal: signals, token: tokens })
    .from(signals)
    .innerJoin(tokens, eq(tokens.mint, signals.mint))
    .where(
      and(
        eq(signals.status, "new"),
        gte(signals.createdAt, cutoff),
        gte(signals.score, String(cfg.SIGNAL_MIN_SCORE)),
      ),
    );

  for (const { signal, token } of candidates) {
    const market = await fetchTokenMarket(signal.mint).catch(() => null);
    if (!market) {
      await db.update(signals).set({ status: "expired" }).where(eq(signals.id, signal.id));
      continue;
    }

    const sizeUsd = cfg.PAPER_POSITION_USD;
    const slip = slippagePct(sizeUsd, market.liquidityUsd);
    const entryPrice = market.priceUsd * (1 + slip / 100);
    const feeUsd = (sizeUsd * FEE_PCT) / 100 + FIXED_FEE_USD;
    const qty = (sizeUsd - feeUsd) / entryPrice;

    await audit("paper_open", {
      mint: signal.mint,
      signalId: signal.id,
      score: signal.score,
      markPrice: market.priceUsd,
      entryPrice,
      slippagePct: slip,
      sizeUsd,
    });

    const [position] = await db
      .insert(positions)
      .values({
        signalId: signal.id,
        mint: signal.mint,
        lane: "paper",
        sizeUsd: String(sizeUsd),
        qtyTokens: String(qty),
        qtyRemaining: String(qty),
        entryPriceUsd: String(entryPrice),
        peakPriceUsd: String(entryPrice),
        realizedPnlUsd: "0",
      })
      .returning();
    if (!position) continue;

    await db.insert(fills).values({
      positionId: position.id,
      side: "buy",
      qtyTokens: String(qty),
      priceUsd: String(entryPrice),
      slippagePct: String(slip),
      feeUsd: String(feeUsd),
    });
    await db.update(signals).set({ status: "traded_paper" }).where(eq(signals.id, signal.id));

    console.log(
      `📈 OPEN   ${token.symbol ?? "?"} ${short(signal.mint)} $${sizeUsd} @ $${entryPrice.toPrecision(4)} (slip ${slip.toFixed(2)}%, score ${signal.score})`,
    );
  }
}

interface ExitDecision {
  reason: string;
  fraction: number; // fraction of remaining qty to sell
}

function decideExit(
  cfg: HermesConfig,
  position: Position,
  market: TokenMarket,
  peak: number,
): ExitDecision | null {
  const entry = n(position.entryPriceUsd);
  const price = market.priceUsd;
  const ageHours = (Date.now() - position.openedAt.getTime()) / 3_600_000;
  const tpTaken = n(position.qtyRemaining) < n(position.qtyTokens) - 1e-9;

  if (price <= entry * (1 - cfg.HARD_STOP_PCT / 100)) {
    return { reason: "hard_stop", fraction: 1 };
  }
  if (price <= peak * (1 - cfg.TRAIL_DROP_PCT / 100)) {
    return { reason: "trail_stop", fraction: 1 };
  }
  if (ageHours >= cfg.MAX_HOLD_HOURS) {
    return { reason: "stop_time", fraction: 1 };
  }
  // volume collapse: current 5-min pace under 20% of the last hour's pace,
  // only meaningful once the position has had time to breathe
  if (ageHours > 0.5 && market.volUsd.h1 > 0 && market.volUsd.m5 * 12 < 0.2 * market.volUsd.h1) {
    return { reason: "stop_volume", fraction: 1 };
  }
  if (!tpTaken && price >= entry * cfg.TP_MULTIPLIER) {
    return { reason: "tp_ladder", fraction: cfg.TP_SELL_FRACTION };
  }
  return null;
}

async function sell(
  position: Position,
  market: TokenMarket,
  fraction: number,
  reason: string,
): Promise<void> {
  const qtySold = n(position.qtyRemaining) * fraction;
  const grossUsd = qtySold * market.priceUsd;
  const slip = slippagePct(grossUsd, market.liquidityUsd);
  const exitPrice = market.priceUsd * (1 - slip / 100);
  const feeUsd = (qtySold * exitPrice * FEE_PCT) / 100 + FIXED_FEE_USD;
  const proceeds = qtySold * exitPrice - feeUsd;
  const costBasis = qtySold * n(position.entryPriceUsd);
  const pnl = proceeds - costBasis;

  const remaining = n(position.qtyRemaining) - qtySold;
  const closing = remaining <= 1e-9 || fraction >= 1;

  await audit("paper_sell", {
    positionId: position.id,
    mint: position.mint,
    reason,
    qtySold,
    exitPrice,
    slippagePct: slip,
    pnlUsd: pnl,
    closing,
  });

  await db.insert(fills).values({
    positionId: position.id,
    side: "sell",
    qtyTokens: String(qtySold),
    priceUsd: String(exitPrice),
    slippagePct: String(slip),
    feeUsd: String(feeUsd),
  });

  const newRealized = n(position.realizedPnlUsd) + pnl;
  await db
    .update(positions)
    .set({
      qtyRemaining: String(Math.max(remaining, 0)),
      realizedPnlUsd: String(newRealized),
      ...(closing
        ? {
            status: "closed",
            exitPriceUsd: String(exitPrice),
            exitReason: reason,
            closedAt: new Date(),
          }
        : {}),
    })
    .where(eq(positions.id, position.id));

  const tag = closing ? "CLOSE" : "TRIM ";
  const emoji = newRealized >= 0 ? "🟢" : "🔴";
  console.log(
    `${emoji} ${tag}  ${short(position.mint)} ${reason} @ $${exitPrice.toPrecision(4)} — pnl $${pnl.toFixed(2)} (total $${newRealized.toFixed(2)})`,
  );
}

/** Mark open positions to market and execute the exit rules. */
export async function managePositions(cfg: HermesConfig): Promise<void> {
  const open = await db.select().from(positions).where(eq(positions.status, "open"));

  for (const position of open) {
    const market = await fetchTokenMarket(position.mint).catch(() => null);
    if (!market) {
      // no pair left — token pulled/rugged; write it off at zero
      await audit("paper_writeoff", { positionId: position.id, mint: position.mint });
      await db.insert(fills).values({
        positionId: position.id,
        side: "sell",
        qtyTokens: position.qtyRemaining,
        priceUsd: "0",
        feeUsd: "0",
      });
      const loss = -n(position.qtyRemaining) * n(position.entryPriceUsd);
      await db
        .update(positions)
        .set({
          status: "closed",
          qtyRemaining: "0",
          exitPriceUsd: "0",
          exitReason: "delisted",
          realizedPnlUsd: String(n(position.realizedPnlUsd) + loss),
          closedAt: new Date(),
        })
        .where(eq(positions.id, position.id));
      console.log(`🔴 CLOSE  ${short(position.mint)} delisted — wrote off $${(-loss).toFixed(2)}`);
      continue;
    }

    const peak = Math.max(n(position.peakPriceUsd), market.priceUsd);
    if (peak > n(position.peakPriceUsd)) {
      await db
        .update(positions)
        .set({ peakPriceUsd: String(peak) })
        .where(eq(positions.id, position.id));
    }

    const exit = decideExit(cfg, position, market, peak);
    if (exit) await sell(position, market, exit.fraction, exit.reason);
  }
}

/** Record an equity snapshot: bankroll + realized + unrealized (marked to market). */
export async function snapshotEquity(cfg: HermesConfig): Promise<void> {
  const [realizedRow] = await db
    .select({ total: sql<string>`coalesce(sum(${positions.realizedPnlUsd}), 0)` })
    .from(positions)
    .where(eq(positions.lane, "paper"));
  const open = await db
    .select()
    .from(positions)
    .where(and(eq(positions.status, "open"), eq(positions.lane, "paper")));

  let unrealized = 0;
  for (const position of open) {
    const market = await fetchTokenMarket(position.mint).catch(() => null);
    const mark = market?.priceUsd ?? 0;
    unrealized += n(position.qtyRemaining) * (mark - n(position.entryPriceUsd));
  }

  const realized = n(realizedRow?.total ?? "0");
  const equity = cfg.PAPER_BANKROLL_USD + realized + unrealized;
  await db.insert(pnlSnapshots).values({
    lane: "paper",
    equityUsd: String(equity),
    openPositions: open.length,
  });
  console.log(
    `💰 EQUITY $${equity.toFixed(2)} (realized $${realized.toFixed(2)}, unrealized $${unrealized.toFixed(2)}, ${open.length} open)`,
  );
}
