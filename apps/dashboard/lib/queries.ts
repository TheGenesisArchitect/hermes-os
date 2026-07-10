import {
  config,
  db,
  fills,
  pnlSnapshots,
  positions,
  safetyChecks,
  signals,
  tokens,
} from "@hermes/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";

const DAY_AGO = () => new Date(Date.now() - 24 * 3600 * 1000);

export async function getEquitySeries() {
  return db
    .select({ at: pnlSnapshots.snappedAt, equity: pnlSnapshots.equityUsd })
    .from(pnlSnapshots)
    .where(eq(pnlSnapshots.lane, "paper"))
    .orderBy(pnlSnapshots.snappedAt)
    .limit(1000);
}

export async function getStats() {
  const [scanned] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tokens)
    .where(gte(tokens.firstSeenAt, DAY_AGO()));
  const [signalCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(signals)
    .where(gte(signals.createdAt, DAY_AGO()));
  const [openCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(positions)
    .where(eq(positions.status, "open"));
  const [realized] = await db
    .select({ total: sql<string>`coalesce(sum(${positions.realizedPnlUsd}), 0)` })
    .from(positions)
    .where(eq(positions.lane, "paper"));
  const [lastSnap] = await db
    .select({ equity: pnlSnapshots.equityUsd, at: pnlSnapshots.snappedAt })
    .from(pnlSnapshots)
    .where(eq(pnlSnapshots.lane, "paper"))
    .orderBy(desc(pnlSnapshots.snappedAt))
    .limit(1);
  const [closed] = await db
    .select({
      n: sql<number>`count(*)::int`,
      wins: sql<number>`count(*) filter (where ${positions.realizedPnlUsd}::numeric > 0)::int`,
    })
    .from(positions)
    .where(and(eq(positions.lane, "paper"), eq(positions.status, "closed")));

  return {
    scanned24h: scanned?.n ?? 0,
    signals24h: signalCount?.n ?? 0,
    openPositions: openCount?.n ?? 0,
    realizedPnl: Number(realized?.total ?? 0),
    equity: lastSnap ? Number(lastSnap.equity) : null,
    equityAt: lastSnap?.at ?? null,
    closedTrades: closed?.n ?? 0,
    wins: closed?.wins ?? 0,
  };
}

export async function getRecentSignals(limit = 30) {
  return db
    .select({
      id: signals.id,
      mint: signals.mint,
      symbol: tokens.symbol,
      name: tokens.name,
      dex: tokens.dex,
      score: signals.score,
      status: signals.status,
      createdAt: signals.createdAt,
      liquidityUsd: tokens.liquidityUsd,
    })
    .from(signals)
    .innerJoin(tokens, eq(tokens.mint, signals.mint))
    .orderBy(desc(signals.createdAt))
    .limit(limit);
}

export async function getOpenPositions() {
  return db
    .select({
      id: positions.id,
      mint: positions.mint,
      symbol: tokens.symbol,
      sizeUsd: positions.sizeUsd,
      entryPriceUsd: positions.entryPriceUsd,
      peakPriceUsd: positions.peakPriceUsd,
      qtyRemaining: positions.qtyRemaining,
      qtyTokens: positions.qtyTokens,
      realizedPnlUsd: positions.realizedPnlUsd,
      openedAt: positions.openedAt,
      lane: positions.lane,
    })
    .from(positions)
    .innerJoin(tokens, eq(tokens.mint, positions.mint))
    .where(eq(positions.status, "open"))
    .orderBy(desc(positions.openedAt));
}

export async function getRecentTrades(limit = 25) {
  return db
    .select({
      id: fills.id,
      side: fills.side,
      qtyTokens: fills.qtyTokens,
      priceUsd: fills.priceUsd,
      feeUsd: fills.feeUsd,
      filledAt: fills.filledAt,
      mint: positions.mint,
      symbol: tokens.symbol,
      exitReason: positions.exitReason,
      positionStatus: positions.status,
      realizedPnlUsd: positions.realizedPnlUsd,
    })
    .from(fills)
    .innerJoin(positions, eq(positions.id, fills.positionId))
    .innerJoin(tokens, eq(tokens.mint, positions.mint))
    .orderBy(desc(fills.filledAt))
    .limit(limit);
}

export async function getTokenDetail(mint: string) {
  const [token] = await db.select().from(tokens).where(eq(tokens.mint, mint));
  if (!token) return null;
  const checks = await db
    .select()
    .from(safetyChecks)
    .where(eq(safetyChecks.mint, mint))
    .orderBy(desc(safetyChecks.checkedAt));
  const tokenSignals = await db
    .select()
    .from(signals)
    .where(eq(signals.mint, mint))
    .orderBy(desc(signals.createdAt));
  const tokenPositions = await db
    .select()
    .from(positions)
    .where(eq(positions.mint, mint))
    .orderBy(desc(positions.openedAt));
  return { token, checks, signals: tokenSignals, positions: tokenPositions };
}

export async function getKillSwitch(): Promise<boolean> {
  const [row] = await db.select().from(config).where(eq(config.key, "kill_switch"));
  return (row?.value as { enabled?: boolean } | undefined)?.enabled === true;
}
