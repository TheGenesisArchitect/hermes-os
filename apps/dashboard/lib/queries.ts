import {
  candidateOutcomes,
  candidateTicks,
  config,
  db,
  fills,
  managementIntents,
  marketNews,
  pnlSnapshots,
  positionTicks,
  positions,
  safetyChecks,
  signals,
  tokens,
} from "@hermes/db";
import {
  OVERRIDE_KNOBS,
  classify,
  convexSlippagePct,
  loadConfig,
  resilientFetch,
  resolveOverrides,
  runForecast,
  tickFrom,
  type ForecastResult,
  type ManagementCall,
  type OverrideGroup,
  type OverrideKnob,
  type RegimeState,
  type ResolvedKnob,
  type Tick,
} from "@hermes/core";
import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";

const DAY_AGO = () => new Date(Date.now() - 24 * 3600 * 1000);

// Mirror the trader's exit-fee model so the float box's realizable P&L matches
// what a real close would bank (paper.ts FEE_PCT / FIXED_FEE_USD).
const EXIT_FEE_PCT = 0.25;
const EXIT_FIXED_FEE_USD = 0.02;

// DexScreener flips between a token's real pool and an empty/garbage pool, so a
// single liquidity poll can read ~$10 for a genuinely ~$18k pool (mark stays put
// while liquidity flickers — the same artifact REF_MIN_LIQ fixed in the recorder).
// The float box feeds liquidity into convex slippage, so one garbage read would
// fabricate a fake ~99% exit haircut on a healthy position. Guard it: ignore
// sub-threshold reads and take a robust estimate over the recent ticks.
const REF_MIN_LIQ = 1000;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Trustworthy liquidity for a position from its tick history: median of the last
 * few reads that clear REF_MIN_LIQ (resists the empty-pool flicker without
 * cherry-picking the peak). Falls back to the best real read ever seen; null
 * only if the pool never once read above threshold (implausible for a
 * safety-gated entry) — in which case we decline to fabricate a slippage number.
 */
function robustLiquidity(liqs: (number | null)[]): number | null {
  const recentGood = liqs.slice(-8).filter((v): v is number => v !== null && v >= REF_MIN_LIQ);
  if (recentGood.length) return median(recentGood);
  const everGood = liqs.filter((v): v is number => v !== null && v >= REF_MIN_LIQ);
  return everGood.length ? Math.max(...everGood) : null;
}

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

export interface RecentTrade {
  id: number;
  side: string;
  qtyTokens: string;
  priceUsd: string;
  feeUsd: string | null;
  slippagePct: string | null;
  fillReason: string | null; // per-fill reason (rung/exit/entry-path); null on pre-migration rows
  filledAt: string; // ISO
  mint: string;
  symbol: string | null;
  exitReason: string | null;
  positionStatus: string;
  realizedPnlUsd: string | null;
}

/**
 * Whole-history fills accounting, computed SQL-side so the strip can never be
 * poisoned by the row cap. `netFlow + openCost ≡ realized` is the bridge that
 * ties the Fill Ledger to the Accounting Ledger — the two panels MUST agree.
 */
export interface FillsSummary {
  totalFills: number;
  buysUsd: number; // cash out: buy value + buy fees
  sellsUsd: number; // cash in: sell value − sell fees
  feesUsd: number;
  netFlow: number; // sellsUsd − buysUsd
  openCostUsd: number; // cost basis still deployed
  realizedUsd: number; // Σ positions.realized (post fee-basis fix)
}

export async function getFillsSummary(): Promise<FillsSummary> {
  const rows = await db.execute(sql`
    WITH f AS (
      SELECT coalesce(sum(qty_tokens*price_usd) FILTER (WHERE side='sell'),0)::float sg,
        coalesce(sum(fee_usd) FILTER (WHERE side='sell'),0)::float sf,
        coalesce(sum(qty_tokens*price_usd) FILTER (WHERE side='buy'),0)::float bv,
        coalesce(sum(fee_usd) FILTER (WHERE side='buy'),0)::float bf,
        count(*)::int n
      FROM fills),
    p AS (SELECT coalesce(sum(realized_pnl_usd),0)::float realized,
        coalesce(sum(size_usd*qty_remaining/NULLIF(qty_tokens,0)) FILTER (WHERE status='open'),0)::float oc
      FROM positions WHERE lane='paper')
    SELECT f.n, f.sg-f.sf AS cash_in, f.bv+f.bf AS cash_out, f.sf+f.bf AS fees, p.oc, p.realized FROM f,p
  `);
  const r = (rows as unknown as Array<Record<string, unknown>>)[0] ?? {};
  const buysUsd = Number(r.cash_out) || 0;
  const sellsUsd = Number(r.cash_in) || 0;
  return {
    totalFills: Number(r.n) || 0,
    buysUsd,
    sellsUsd,
    feesUsd: Number(r.fees) || 0,
    netFlow: sellsUsd - buysUsd,
    openCostUsd: Number(r.oc) || 0,
    realizedUsd: Number(r.realized) || 0,
  };
}

// Cap is generous (covers the whole current run of ~400 fills with headroom) so
// the client-side time-range filter never silently truncates. The Fills surface
// renders "showing N of M in range" so any future cap is VISIBLE, not silent.
export async function getRecentTrades(limit = 1000): Promise<RecentTrade[]> {
  const rows = await db
    .select({
      id: fills.id,
      side: fills.side,
      qtyTokens: fills.qtyTokens,
      priceUsd: fills.priceUsd,
      feeUsd: fills.feeUsd,
      slippagePct: fills.slippagePct,
      fillReason: fills.reason,
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
  return rows.map((r) => ({ ...r, filledAt: r.filledAt.toISOString() }));
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

  // --- Recorder drill-down: how the scout saw this token unfold ---
  const [recorderOutcome] = await db
    .select()
    .from(candidateOutcomes)
    .where(eq(candidateOutcomes.mint, mint));
  const recorderTickRows = await db
    .select()
    .from(candidateTicks)
    .where(eq(candidateTicks.mint, mint))
    .orderBy(asc(candidateTicks.snappedAt))
    .limit(120);
  const recorderTrajectory = recorderTickRows.map((r) => ({
    watchMinutes: num(r.watchMinutes),
    markMultiple: num(r.markMultiple),
    drawdownFromPeakPct: num(r.drawdownFromPeakPct),
    buyShareM5: r.buyShareM5 === null ? null : num(r.buyShareM5),
    continuationScore: r.continuationScore === null ? null : num(r.continuationScore),
    action: r.action,
    liquidityUsd: r.liquidityUsd === null ? null : num(r.liquidityUsd),
  }));

  // --- Trade drill-down: fills + the classifier's tick-by-tick management calls ---
  const posIds = tokenPositions.map((p) => p.id);
  const tokenFills = posIds.length
    ? await db
        .select()
        .from(fills)
        .where(eq(fills.positionId, posIds[0]!)) // most-recent position's fills (list is desc)
        .orderBy(asc(fills.filledAt))
    : [];
  const managementTicks = posIds.length
    ? await db
        .select()
        .from(positionTicks)
        .where(eq(positionTicks.positionId, posIds[0]!))
        .orderBy(asc(positionTicks.snappedAt))
        .limit(200)
    : [];
  const mgmtTrajectory = managementTicks.map((r) => ({
    markMultiple: num(r.markMultiple),
    peakMultiple: num(r.peakMultiple),
    drawdownFromPeakPct: num(r.drawdownFromPeakPct),
    continuationScore: r.continuationScore === null ? null : num(r.continuationScore),
    regime: r.regime,
    action: r.action,
    ageMinutes: num(r.ageMinutes),
    liquidityUsd: r.liquidityUsd === null ? null : num(r.liquidityUsd), // exposes the pool-flip flicker
  }));

  return {
    token,
    checks,
    signals: tokenSignals,
    positions: tokenPositions,
    recorderOutcome: recorderOutcome ?? null,
    recorderTrajectory,
    fills: tokenFills,
    mgmtTrajectory,
  };
}

const num = (v: string | null): number => (v === null ? 0 : Number(v));

export interface ManagedPosition {
  id: number;
  mint: string;
  symbol: string | null;
  dex: string | null;
  sizeUsd: number;
  entryPriceUsd: number;
  markMultiple: number;
  peakMultiple: number;
  drawdownFromPeakPct: number;
  openedAt: Date;
  call: ManagementCall | null; // live classifier verdict, recomputed for full factors
  spark: { i: number; mm: number }[]; // markMultiple trajectory
  pendingIntent: "ride" | "cut" | null;
  ticks: number;
  // Float — unrealized P&L on the open portion. `net` is what we'd actually bank
  // by selling now: mark value minus convex exit-slippage and fees (the honest
  // number). `gross` is the naive mark, kept only to expose the slippage haircut.
  liquidityUsd: number | null;
  costBasisRemaining: number; // cost of the still-held qty
  markValueUsd: number; // qtyRemaining × current price (gross mark value)
  exitSlipPct: number; // convex price impact to exit the remaining size now
  unrealizedGrossUsd: number; // markValue − costBasis (pre-slippage)
  unrealizedNetUsd: number; // realizable − costBasis (post-slippage + fees) ← the truth
  unrealizedNetPct: number; // net / costBasis × 100
  realizedBankedUsd: number; // profit already locked from partial trims
  // TRUE iff the LATEST tick read real liquidity (≥ $1k) — the trader's harvest
  // sweep only sells positions whose live read passes this same bar, so a green
  // that isn't sellableNow will be SKIPPED by a harvest click this cycle.
  sellableNow: boolean;
}

/**
 * Open positions with the ride-vs-cut classifier recomputed over their live
 * trajectory. We recompute (rather than read the stored regime) so the card can
 * show the full factor breakdown; the result is identical to what the trader
 * stored on the latest tick.
 */
export async function getManagedPositions(): Promise<ManagedPosition[]> {
  const open = await db
    .select({
      id: positions.id,
      mint: positions.mint,
      symbol: tokens.symbol,
      dex: tokens.dex,
      sizeUsd: positions.sizeUsd,
      entryPriceUsd: positions.entryPriceUsd,
      peakPriceUsd: positions.peakPriceUsd,
      qtyTokens: positions.qtyTokens,
      qtyRemaining: positions.qtyRemaining,
      realizedPnlUsd: positions.realizedPnlUsd,
      openedAt: positions.openedAt,
    })
    .from(positions)
    .innerJoin(tokens, eq(tokens.mint, positions.mint))
    .where(eq(positions.status, "open"))
    .orderBy(desc(positions.openedAt));

  const out: ManagedPosition[] = [];
  for (const p of open) {
    const rows = await db
      .select()
      .from(positionTicks)
      .where(eq(positionTicks.positionId, p.id))
      .orderBy(asc(positionTicks.snappedAt))
      .limit(200);
    const series: Tick[] = rows.map((r) => ({
      markMultiple: num(r.markMultiple),
      drawdownFromPeakPct: num(r.drawdownFromPeakPct),
      buyShareM5: r.buyShareM5 === null ? 0.5 : num(r.buyShareM5),
      volM5: num(r.volM5),
      volH1: num(r.volH1),
      priceChangeM5Pct: num(r.priceChangeM5Pct),
      ageMinutes: num(r.ageMinutes),
    }));
    const call = series.length ? classify(series) : null;
    const last = rows[rows.length - 1];
    const [intent] = await db
      .select()
      .from(managementIntents)
      .where(and(eq(managementIntents.positionId, p.id), eq(managementIntents.applied, false)))
      .orderBy(desc(managementIntents.createdAt))
      .limit(1);

    // Float / realizable-P&L — value the still-held qty at the current price, then
    // haircut it by the convex slippage to EXIT that size now (never show gross
    // mark P&L on a thin pool — that overstatement is what this whole engine
    // fights). Fees mirror the trader's exit model.
    const markMultiple = last ? num(last.markMultiple) : 1;
    const entryPrice = num(p.entryPriceUsd);
    const qtyRemaining = num(p.qtyRemaining);
    const qtyTokens = num(p.qtyTokens);
    const sizeUsd = num(p.sizeUsd);
    // Robust liquidity over the tick history — a single empty-pool poll can't
    // fabricate a fake exit haircut on a healthy position (the flicker artifact).
    const liquidityUsd = robustLiquidity(rows.map((r) => (r.liquidityUsd === null ? null : Number(r.liquidityUsd))));
    const currentPrice = entryPrice * markMultiple;
    const markValueUsd = qtyRemaining * currentPrice;
    const heldFraction = qtyTokens > 0 ? qtyRemaining / qtyTokens : 1;
    const costBasisRemaining = sizeUsd * heldFraction;
    // If liquidity never read above threshold, we can't estimate slippage
    // honestly — decline to invent a haircut rather than show a fake corpse.
    const exitSlipPct = liquidityUsd === null ? 0 : convexSlippagePct(markValueUsd, liquidityUsd);
    const realizableUsd = markValueUsd * (1 - exitSlipPct / 100) - (markValueUsd * EXIT_FEE_PCT) / 100 - EXIT_FIXED_FEE_USD;
    const unrealizedGrossUsd = markValueUsd - costBasisRemaining;
    const unrealizedNetUsd = realizableUsd - costBasisRemaining;
    const unrealizedNetPct = costBasisRemaining > 0 ? (unrealizedNetUsd / costBasisRemaining) * 100 : 0;

    out.push({
      id: p.id,
      mint: p.mint,
      symbol: p.symbol,
      dex: p.dex,
      sizeUsd,
      entryPriceUsd: entryPrice,
      markMultiple,
      peakMultiple: last ? num(last.peakMultiple) : 1,
      drawdownFromPeakPct: last ? num(last.drawdownFromPeakPct) : 0,
      openedAt: p.openedAt,
      call,
      spark: series.map((t, i) => ({ i, mm: t.markMultiple })),
      pendingIntent: intent ? (intent.intent === "cut" ? "cut" : "ride") : null,
      ticks: series.length,
      liquidityUsd,
      costBasisRemaining,
      markValueUsd,
      exitSlipPct,
      unrealizedGrossUsd,
      unrealizedNetUsd,
      unrealizedNetPct,
      realizedBankedUsd: num(p.realizedPnlUsd),
      sellableNow: last ? Number(last.liquidityUsd ?? 0) >= 1000 : false,
    });
  }
  return out;
}

// ── TIMING GRID ────────────────────────────────────────────────────────────
// The live time×multiple field: every trade a trajectory on a 0→maxSec seconds
// floor (polled ~6.5s) against a 1.0× baseline, TP rails, and DNA time-zones
// (danger <150s where rugs peak, runner >300s where real winners live). This is
// the exit doctrine made watchable — floor set fast on the downside, ceiling open
// on the upside.
export interface TimingTradePoint {
  t: number; // seconds since entry
  mm: number; // mark multiple
}
export interface TimingTrade {
  id: number;
  mint: string;
  symbol: string | null;
  isFarm: boolean;
  sizeUsd: number;
  points: TimingTradePoint[];
  curMult: number;
  peakMult: number;
  lockedMult: number; // the protected floor — what a close-now can't drop below (ratchets up with peak)
  armed: boolean; // profit-lock engaged (shown green, never close red)
  ageSec: number;
  state: "rising" | "stalling" | "falling";
  status: "open" | "closed";
  exit: { t: number; mm: number; reason: string; pnl: number } | null;
}
export interface TimingGridView {
  trades: TimingTrade[];
  maxSec: number;
  pollSec: number;
  tpLevels: { mult: number; label: string }[];
  zones: { fromSec: number; toSec: number; label: string; tone: "danger" | "develop" | "runner" }[];
  counts: { rising: number; stalling: number; falling: number };
}

const TIMING_POLL_SEC = 6.5; // measured median gap between position_ticks
const TIMING_CLOSED_WINDOW_MIN = 20; // recently-closed trades linger then fade off the grid

function timingState(points: TimingTradePoint[]): "rising" | "stalling" | "falling" {
  if (points.length < 2) return "rising";
  const cur = points[points.length - 1]!.mm;
  const peak = Math.max(...points.map((p) => p.mm));
  const ddPct = peak > 0 ? ((peak - cur) / peak) * 100 : 0;
  if (ddPct <= 1.5) return "rising"; // at/near a fresh high
  if (ddPct >= 8) return "falling"; // rolled decisively off the peak
  return "stalling"; // drifting below the high but not broken
}

export async function getTimingGrid(): Promise<TimingGridView> {
  const cfg = loadConfig();
  const closedSince = new Date(Date.now() - TIMING_CLOSED_WINDOW_MIN * 60 * 1000);
  const [open, closed] = await Promise.all([
    db
      .select({
        id: positions.id,
        mint: positions.mint,
        symbol: tokens.symbol,
        dex: tokens.dex,
        sizeUsd: positions.sizeUsd,
        entryPriceUsd: positions.entryPriceUsd,
        openedAt: positions.openedAt,
      })
      .from(positions)
      .innerJoin(tokens, eq(tokens.mint, positions.mint))
      .where(eq(positions.status, "open")),
    db
      .select({
        id: positions.id,
        mint: positions.mint,
        symbol: tokens.symbol,
        dex: tokens.dex,
        sizeUsd: positions.sizeUsd,
        entryPriceUsd: positions.entryPriceUsd,
        exitPriceUsd: positions.exitPriceUsd,
        exitReason: positions.exitReason,
        realizedPnlUsd: positions.realizedPnlUsd,
        openedAt: positions.openedAt,
        closedAt: positions.closedAt,
      })
      .from(positions)
      .innerJoin(tokens, eq(tokens.mint, positions.mint))
      .where(and(eq(positions.status, "closed"), gte(positions.closedAt, closedSince))),
  ]);

  const ids = [...open.map((p) => p.id), ...closed.map((p) => p.id)];
  const tickRows = ids.length
    ? await db
        .select({
          positionId: positionTicks.positionId,
          ageMinutes: positionTicks.ageMinutes,
          markMultiple: positionTicks.markMultiple,
        })
        .from(positionTicks)
        .where(inArray(positionTicks.positionId, ids))
        .orderBy(asc(positionTicks.snappedAt))
    : [];
  const byPos = new Map<number, TimingTradePoint[]>();
  for (const r of tickRows) {
    const mm = num(r.markMultiple);
    if (!(mm > 0)) continue; // skip garbage/empty-pool reads — never plot a fake dip
    const arr = byPos.get(r.positionId) ?? [];
    arr.push({ t: Math.max(0, num(r.ageMinutes) * 60), mm });
    byPos.set(r.positionId, arr);
  }

  const trades: TimingTrade[] = [];
  const isFarm = (dex: string | null) => (dex ?? "").toLowerCase() === "meteora-damm-v2";

  // The protected floor a close-now can't drop below — armed once green (by mult OR
  // the $ floor), then the ratcheting trail rides up under the peak. Approximates
  // the trader's effective stop (tight-trail representative) so the lock line on
  // each bar shows what's banked vs what's still floating.
  const lockOf = (sizeUsd: number, peakMult: number) => {
    const armed = peakMult >= cfg.PROFIT_LOCK_ARM_MULT || sizeUsd * (peakMult - 1) >= cfg.PROFIT_FLOOR_USD;
    const lockedMult = armed
      ? Math.max(cfg.PROFIT_LOCK_FLOOR_MULT, peakMult * (1 - cfg.TRAIL_TIGHT_PCT / 100))
      : 1 - cfg.HARD_STOP_PCT / 100;
    return { armed, lockedMult };
  };

  for (const p of open) {
    const points = byPos.get(p.id) ?? [];
    if (!points.length) continue;
    const peakMult = Math.max(...points.map((x) => x.mm));
    const last = points[points.length - 1]!;
    const { armed, lockedMult } = lockOf(num(p.sizeUsd), peakMult);
    trades.push({
      id: p.id,
      mint: p.mint,
      symbol: p.symbol,
      isFarm: isFarm(p.dex),
      sizeUsd: num(p.sizeUsd),
      points,
      curMult: last.mm,
      peakMult,
      lockedMult,
      armed,
      ageSec: last.t,
      state: timingState(points),
      status: "open",
      exit: null,
    });
  }
  for (const p of closed) {
    const points = byPos.get(p.id) ?? [];
    const entry = num(p.entryPriceUsd);
    const exitT = p.closedAt ? Math.max(0, (p.closedAt.getTime() - p.openedAt.getTime()) / 1000) : 0;
    const exitMm = entry > 0 && p.exitPriceUsd !== null ? num(p.exitPriceUsd) / entry : (points[points.length - 1]?.mm ?? 1);
    const peakMult = points.length ? Math.max(...points.map((x) => x.mm)) : Math.max(1, exitMm);
    trades.push({
      id: p.id,
      mint: p.mint,
      symbol: p.symbol,
      isFarm: isFarm(p.dex),
      sizeUsd: num(p.sizeUsd),
      points,
      curMult: exitMm,
      peakMult,
      lockedMult: exitMm,
      armed: false,
      ageSec: exitT,
      state: "falling",
      status: "closed",
      exit: { t: exitT, mm: exitMm, reason: p.exitReason ?? "closed", pnl: num(p.realizedPnlUsd) },
    });
  }

  const maxAge = trades.reduce((m, t) => Math.max(m, t.ageSec), 0);
  // Fixed 1000s moonshot horizon by default; expand (bounded) if a live runner has
  // outlasted it so nothing clips off the right edge.
  const maxSec = Math.min(2400, Math.max(1000, Math.ceil(maxAge / 100) * 100));
  const openTrades = trades.filter((t) => t.status === "open");
  const counts = {
    rising: openTrades.filter((t) => t.state === "rising").length,
    stalling: openTrades.filter((t) => t.state === "stalling").length,
    falling: openTrades.filter((t) => t.state === "falling").length,
  };

  return {
    trades,
    maxSec,
    pollSec: TIMING_POLL_SEC,
    // The rails the trader ACTUALLY trades: base config resolved through the
    // live runtime overrides (manual pins > auto policy > base). Hardcoded
    // values here once showed TP0 1.15x while the effective pin was 1.10x —
    // the board must never disagree with the ladder that fires.
    tpLevels: await (async () => {
      const [row] = await db.select().from(config).where(eq(config.key, "runtime_overrides"));
      const eff = resolveOverrides(cfg, row?.value ?? null).effective;
      return [
        { mult: eff.TP0_MULT, label: "TP0" },
        { mult: eff.TP1_MULT, label: "TP1" },
        { mult: eff.TP2_MULT, label: "TP2" },
      ];
    })(),
    zones: [
      { fromSec: 0, toSec: 150, label: "danger", tone: "danger" },
      { fromSec: 150, toSec: 300, label: "develop", tone: "develop" },
      { fromSec: 300, toSec: 100000, label: "runner", tone: "runner" },
    ],
    counts,
  };
}

export interface RetroTrade {
  id: number;
  mint: string;
  symbol: string | null;
  dex: string | null;
  peakMultiple: number;
  exitMultiple: number;
  givenBackPct: number; // how much of the peak it round-tripped before exit
  holdMinutes: number;
  openedAt: string; // ISO — when we entered
  closedAt: string | null; // ISO — when the exit filled
  exitReason: string | null;
  pnl: number;
  regime: string;
  action: string;
}

/**
 * Closed trades re-examined through the classifier — PRICE-SHAPE ONLY. Buy-flow
 * and volume factors weren't recorded in run 1c, so they're held neutral here;
 * this is a sanity-check on the regime logic against real tokens, not a
 * backtest. The "given back from peak" column is 100% real and is the point:
 * it shows how much each trail-stop exit round-tripped.
 */
export async function getClassifierRetrospective(): Promise<RetroTrade[]> {
  const closed = await db
    .select({
      id: positions.id,
      mint: positions.mint,
      symbol: tokens.symbol,
      dex: tokens.dex,
      entry: positions.entryPriceUsd,
      peak: positions.peakPriceUsd,
      exit: positions.exitPriceUsd,
      openedAt: positions.openedAt,
      closedAt: positions.closedAt,
      exitReason: positions.exitReason,
      pnl: positions.realizedPnlUsd,
    })
    .from(positions)
    .innerJoin(tokens, eq(tokens.mint, positions.mint))
    .where(eq(positions.status, "closed"))
    // Chronological ledger by default now that time is a first-class column —
    // pnl stays a sortable column client-side. (Was pnl-desc, an accident here.)
    .orderBy(desc(positions.closedAt));

  return closed.map((c) => {
    const entry = num(c.entry);
    const peak = Math.max(num(c.peak), entry);
    const exit = num(c.exit);
    const peakMultiple = entry > 0 ? peak / entry : 1;
    const exitMultiple = entry > 0 ? exit / entry : 0;
    const givenBackPct = peak > 0 ? Math.max(0, ((peak - exit) / peak) * 100) : 0;
    const holdMinutes = c.closedAt ? (c.closedAt.getTime() - c.openedAt.getTime()) / 60_000 : 0;
    // Price-shape-only [peak → exit] series; flow/volume/momentum held neutral.
    // The two points let the classifier see the roll-off from the high rather
    // than crediting a spurious new-high bonus to a lone exit tick.
    const shared = { entryPriceUsd: entry || 1, peakPriceUsd: peak || 1, buysM5: 1, sellsM5: 1, volM5: 0, volH1: 0, priceChangeM5Pct: 0 };
    const peakTick = tickFrom({ ...shared, priceUsd: peak || 1, ageMinutes: holdMinutes / 2 });
    const exitTick = tickFrom({ ...shared, priceUsd: exit, ageMinutes: holdMinutes });
    const call = classify([peakTick, exitTick]);
    return {
      id: c.id,
      mint: c.mint,
      symbol: c.symbol,
      dex: c.dex,
      peakMultiple,
      exitMultiple,
      givenBackPct,
      holdMinutes,
      openedAt: c.openedAt.toISOString(),
      closedAt: c.closedAt ? c.closedAt.toISOString() : null,
      exitReason: c.exitReason,
      pnl: num(c.pnl),
      regime: call.regime,
      action: call.action,
    };
  });
}

// ---------------------------------------------------------------------------
// ACCOUNTING LEDGER — the single reconciled truth for closed trades. Positions,
// fills, and equity must provably agree; the panel shows the identity live:
//   cash in (sells − fees) − cash out (buys + fees) + cost still deployed
//     ≡ realized P&L   (gap = dust-close residue/rounding, flagged if it grows)
// The forecaster half projects from OUR OWN history: expectancy, run rate, dry
// powder, top setups, and the hour-of-day windows where big movers cluster.
// ---------------------------------------------------------------------------

export interface LedgerRow {
  id: number;
  mint: string;
  symbol: string | null;
  dex: string | null;
  sizeUsd: number;
  qualityMult: number | null; // confirm-quality sizing tier at open
  peakMultiple: number;
  exitMultiple: number;
  holdMinutes: number;
  exitReason: string | null;
  pnl: number;
  cumulativePnl: number; // running realized total in CHRONOLOGICAL order
  openedAt: string; // ISO
  closedAt: string | null; // ISO
}

export interface LedgerRecon {
  cashInSells: number; // Σ sell fills net of sell fees
  cashOutBuys: number; // Σ buy fills + buy fees (full cost)
  openCostBasis: number; // cost of qty still held
  realizedTotal: number; // Σ positions.realized_pnl
  gap: number; // identity residual — should stay ~pennies
}

export interface HotHour {
  utcHour: number;
  n: number;
  winPct: number;
  bigMovers: number; // winners peaking ≥3x
}

export interface LedgerForecast {
  realizedTotal: number;
  openCostBasis: number;
  closedTrades: number;
  wins: number;
  expectancyUsd: number | null; // avg realized per closed trade
  avgWinUsd: number | null;
  avgLossUsd: number | null;
  pnl6h: number;
  trades6h: number;
  ratePerHour: number; // realized $/hr over the last 6h
  projectedDailyUsd: number; // ratePerHour × 24 — a run-rate, not a promise
  topWinners: { symbol: string | null; mint: string; pnl: number; peak: number }[];
  hotHours: HotHour[]; // n≥30 buckets, sorted by win rate
  moonshotWindow: { fromHour: number; toHour: number; bigMovers: number } | null;
}

export interface AccountingLedger {
  rows: LedgerRow[];
  recon: LedgerRecon;
  forecast: LedgerForecast;
}

export async function getAccountingLedger(): Promise<AccountingLedger> {
  // Closed positions, chronological, with a running realized total.
  const closed = await db
    .select({
      id: positions.id,
      mint: positions.mint,
      symbol: tokens.symbol,
      dex: tokens.dex,
      sizeUsd: positions.sizeUsd,
      qualityMult: positions.qualityMult,
      entry: positions.entryPriceUsd,
      peak: positions.peakPriceUsd,
      exit: positions.exitPriceUsd,
      openedAt: positions.openedAt,
      closedAt: positions.closedAt,
      exitReason: positions.exitReason,
      pnl: positions.realizedPnlUsd,
    })
    .from(positions)
    .innerJoin(tokens, eq(tokens.mint, positions.mint))
    .where(and(eq(positions.status, "closed"), eq(positions.lane, "paper")))
    .orderBy(asc(positions.closedAt));

  let running = 0;
  const rows: LedgerRow[] = closed.map((c) => {
    const entry = num(c.entry);
    const peak = Math.max(num(c.peak), entry);
    const pnl = num(c.pnl);
    running += pnl;
    return {
      id: c.id,
      mint: c.mint,
      symbol: c.symbol,
      dex: c.dex,
      sizeUsd: num(c.sizeUsd),
      qualityMult: c.qualityMult === null ? null : num(c.qualityMult),
      peakMultiple: entry > 0 ? peak / entry : 1,
      exitMultiple: entry > 0 ? num(c.exit) / entry : 0,
      holdMinutes: c.closedAt ? (c.closedAt.getTime() - c.openedAt.getTime()) / 60_000 : 0,
      exitReason: c.exitReason,
      pnl,
      cumulativePnl: Number(running.toFixed(2)),
      openedAt: c.openedAt.toISOString(),
      closedAt: c.closedAt ? c.closedAt.toISOString() : null,
    };
  });

  // The reconciliation identity, computed straight from the two ledgers.
  const reconRows = await db.execute(sql`
    WITH f AS (
      SELECT
        coalesce(sum(qty_tokens*price_usd) FILTER (WHERE side='sell'),0)::float sell_gross,
        coalesce(sum(fee_usd) FILTER (WHERE side='sell'),0)::float sell_fees,
        coalesce(sum(qty_tokens*price_usd) FILTER (WHERE side='buy'),0)::float buy_val,
        coalesce(sum(fee_usd) FILTER (WHERE side='buy'),0)::float buy_fees
      FROM fills),
    p AS (
      SELECT coalesce(sum(realized_pnl_usd),0)::float realized,
        coalesce(sum(size_usd * qty_remaining / NULLIF(qty_tokens,0)) FILTER (WHERE status='open'),0)::float open_cost
      FROM positions WHERE lane='paper')
    SELECT f.sell_gross - f.sell_fees AS cash_in, f.buy_val + f.buy_fees AS cash_out,
      p.open_cost, p.realized FROM f, p
  `);
  const r0 = (reconRows as unknown as Array<Record<string, unknown>>)[0] ?? {};
  const cashInSells = Number(r0.cash_in) || 0;
  const cashOutBuys = Number(r0.cash_out) || 0;
  const openCostBasis = Number(r0.open_cost) || 0;
  const realizedTotal = Number(r0.realized) || 0;
  const recon: LedgerRecon = {
    cashInSells,
    cashOutBuys,
    openCostBasis,
    realizedTotal,
    gap: Number((cashInSells - cashOutBuys + openCostBasis - realizedTotal).toFixed(2)),
  };

  // Forecast inputs — expectancy from closed trades, run rate from the last 6h.
  const wins = rows.filter((r) => r.pnl > 0);
  const losses = rows.filter((r) => r.pnl <= 0);
  const sixHoursAgo = Date.now() - 6 * 3_600_000;
  const recent = rows.filter((r) => r.closedAt && new Date(r.closedAt).getTime() >= sixHoursAgo);
  const pnl6h = recent.reduce((s, r) => s + r.pnl, 0);
  const ratePerHour = pnl6h / 6;
  const topWinners = [...rows]
    .sort((a, b) => b.pnl - a.pnl)
    .slice(0, 3)
    .filter((r) => r.pnl > 0)
    .map((r) => ({ symbol: r.symbol, mint: r.mint, pnl: r.pnl, peak: r.peakMultiple }));

  // Hour-of-day windows — from the RECORDER dataset (market-wide, n-guarded),
  // because our own closed sample is far too thin to slice by hour honestly.
  const hourRows = await db.execute(sql`
    SELECT extract(hour from first_seen_at)::int utc_hr, count(*)::int n,
      round(100.0*count(*) FILTER (WHERE label='winner')/count(*),1)::float win_pct,
      count(*) FILTER (WHERE label='winner' AND peak_multiple>=3)::int big_movers
    FROM candidate_outcomes WHERE label IN ('winner','dud','rug')
    GROUP BY 1 HAVING count(*) >= 30 ORDER BY win_pct DESC
  `);
  const hotHours: HotHour[] = (hourRows as unknown as Array<Record<string, unknown>>).map((h) => ({
    utcHour: Number(h.utc_hr),
    n: Number(h.n),
    winPct: Number(h.win_pct),
    bigMovers: Number(h.big_movers),
  }));
  // Moonshot window = the contiguous 4h block holding the most ≥3x movers.
  let moonshotWindow: LedgerForecast["moonshotWindow"] = null;
  if (hotHours.length > 0) {
    const byHour = new Map(hotHours.map((h) => [h.utcHour, h.bigMovers]));
    let best = { from: 0, movers: -1 };
    for (let h = 0; h < 24; h++) {
      let m = 0;
      for (let k = 0; k < 4; k++) m += byHour.get((h + k) % 24) ?? 0;
      if (m > best.movers) best = { from: h, movers: m };
    }
    if (best.movers > 0) moonshotWindow = { fromHour: best.from, toHour: (best.from + 4) % 24, bigMovers: best.movers };
  }

  const forecast: LedgerForecast = {
    realizedTotal,
    openCostBasis,
    closedTrades: rows.length,
    wins: wins.length,
    expectancyUsd: rows.length > 0 ? Number((realizedTotal / rows.length).toFixed(2)) : null,
    avgWinUsd: wins.length > 0 ? wins.reduce((s, r) => s + r.pnl, 0) / wins.length : null,
    avgLossUsd: losses.length > 0 ? losses.reduce((s, r) => s + r.pnl, 0) / losses.length : null,
    pnl6h,
    trades6h: recent.length,
    ratePerHour,
    projectedDailyUsd: Number((ratePerHour * 24).toFixed(0)),
    topWinners,
    hotHours: hotHours.slice(0, 3),
    moonshotWindow,
  };

  return { rows: rows.reverse(), recon, forecast }; // newest-first for display; cumulative stays chronological
}

// ---------------------------------------------------------------------------
// The Recorder — the data flywheel. Read models for the "watch the edge emerge"
// surface: every safety-passed candidate tracked for its first minutes, whether
// we entered it or not, so we finally have the labeled dataset to fit weights on.
// ---------------------------------------------------------------------------

const FIT_TARGET = 40; // labeled candidates before a weight fit is worth running
const EARLY_MIN = 5; // "confirmation window" — max classifier score by this minute

export interface RecorderStats {
  total: number;
  watching: number;
  labeled: number;
  winners: number;
  duds: number;
  rugs: number;
  entered: number;
  triggered: number; // candidates the recorder-as-scout confirmed for entry
  totalTicks: number;
  fitTarget: number;
}

export async function getRecorderStats(): Promise<RecorderStats> {
  const [c] = await db
    .select({
      total: sql<number>`count(*)::int`,
      watching: sql<number>`count(*) filter (where ${candidateOutcomes.label} = 'open')::int`,
      winners: sql<number>`count(*) filter (where ${candidateOutcomes.label} = 'winner')::int`,
      duds: sql<number>`count(*) filter (where ${candidateOutcomes.label} = 'dud')::int`,
      rugs: sql<number>`count(*) filter (where ${candidateOutcomes.label} = 'rug')::int`,
      entered: sql<number>`count(*) filter (where ${candidateOutcomes.entered})::int`,
      triggered: sql<number>`count(*) filter (where ${candidateOutcomes.triggeredAt} is not null)::int`,
    })
    .from(candidateOutcomes);
  const [t] = await db.select({ n: sql<number>`count(*)::int` }).from(candidateTicks);
  const winners = c?.winners ?? 0;
  const duds = c?.duds ?? 0;
  const rugs = c?.rugs ?? 0;
  return {
    total: c?.total ?? 0,
    watching: c?.watching ?? 0,
    labeled: winners + duds + rugs,
    winners,
    duds,
    rugs,
    entered: c?.entered ?? 0,
    triggered: c?.triggered ?? 0,
    totalTicks: t?.n ?? 0,
    fitTarget: FIT_TARGET,
  };
}

export interface WatchingCandidate {
  mint: string;
  symbol: string | null;
  dex: string | null;
  markMultiple: number;
  peakMultiple: number;
  drawdownFromPeakPct: number;
  watchMinutes: number;
  ticks: number;
  regime: string | null;
  action: string | null;
  continuationScore: number;
  triggered: boolean; // recorder-as-scout confirmed this one for entry
  triggerMultiple: number | null;
  armed: boolean; // qualifies RIGHT NOW — the trader will take the shot
  entered: boolean; // we hold (or held) a position on it
  // What the trader actually DID with this candidate — the armed-vs-traded
  // transparency chip. null = not armed/triggered (nothing to explain).
  disposition: string | null;
  spark: { i: number; mm: number }[];
}

/** Candidates currently inside their watch window — the live trajectory feed. */
export async function getWatchingNow(): Promise<WatchingCandidate[]> {
  const open = await db
    .select({
      mint: candidateOutcomes.mint,
      symbol: tokens.symbol,
      dex: tokens.dex,
      peakMultiple: candidateOutcomes.peakMultiple,
      finalMultiple: candidateOutcomes.finalMultiple,
      maxDd: candidateOutcomes.maxDrawdownFromPeakPct,
      ticks: candidateOutcomes.ticks,
      triggeredAt: candidateOutcomes.triggeredAt,
      triggerMultiple: candidateOutcomes.triggerMultiple,
      armed: candidateOutcomes.armed,
      entered: candidateOutcomes.entered,
    })
    .from(candidateOutcomes)
    .innerJoin(tokens, eq(tokens.mint, candidateOutcomes.mint))
    .where(eq(candidateOutcomes.label, "open"))
    .orderBy(desc(candidateOutcomes.updatedAt))
    .limit(24);

  // Recent trader verdicts per mint (last 5 min) — names WHY an armed row
  // isn't a trade yet, so "armed but queued" never reads as "missed".
  const mints = open.map((o) => o.mint);
  // drizzle spreads a JS array in sql`` into scalar params (breaks `= any($1)`)
  // — bind as an explicit IN list, same as adaptive.ts farmCond.
  const mintList = sql.join(
    mints.map((m) => sql`${m}`),
    sql`, `,
  );
  const verdictRows =
    mints.length > 0
      ? ((await db.execute(sql`
          select distinct on (details->>'mint') details->>'mint' as mint, action
          from audit_log
          where created_at > now() - interval '5 minutes'
            and action in ('entry_farm_cap_defer','capacity_full','lane_full','entry_feed_divergence_skip','entry_filtered','entry_concentration_defer')
            and details->>'mint' in (${mintList})
          order by details->>'mint', id desc
        `)) as unknown as { mint: string; action: string }[])
      : [];
  const verdictLabel: Record<string, string> = {
    entry_farm_cap_defer: "queued · farm cap",
    capacity_full: "queued · book full",
    lane_full: "queued · lane full",
    entry_feed_divergence_skip: "held · price disputed",
    entry_filtered: "skipped · filtered",
    entry_concentration_defer: "queued · concentration",
  };
  const verdicts = new Map(verdictRows.map((r) => [r.mint, verdictLabel[r.action] ?? r.action]));

  // Position truth per mint: `entered` on the outcome row means "we took this
  // trade" and stays true after the close — but the Matrix/Positions surfaces
  // only show OPEN positions. The chip must say which it is, or the boards
  // read as disagreeing (2 of 3 "in book" chips pointed at closed trades).
  const posRows =
    mints.length > 0
      ? await db
          .select({ mint: positions.mint, status: positions.status, pnl: positions.realizedPnlUsd })
          .from(positions)
          .where(inArray(positions.mint, mints))
      : [];
  const posState = new Map<string, { open: boolean; pnl: number }>();
  for (const r of posRows) {
    const cur = posState.get(r.mint) ?? { open: false, pnl: 0 };
    cur.open = cur.open || r.status === "open";
    cur.pnl += num(r.pnl);
    posState.set(r.mint, cur);
  }

  const out: WatchingCandidate[] = [];
  for (const o of open) {
    const rows = await db
      .select()
      .from(candidateTicks)
      .where(eq(candidateTicks.mint, o.mint))
      .orderBy(asc(candidateTicks.snappedAt))
      .limit(120);
    // TRUSTED reads only for the live mark/spark — a $0-liquidity pool-flip tick
    // (the on-board 38,087x Cyclospora read) must never paint the board. Fall
    // back to raw rows only if no trusted tick exists yet.
    const good = rows.filter((r) => num(r.liquidityUsd) >= 1000);
    const view = good.length > 0 ? good : rows;
    const last = view[view.length - 1];
    out.push({
      mint: o.mint,
      symbol: o.symbol,
      dex: o.dex,
      markMultiple: last ? num(last.markMultiple) : 1,
      peakMultiple: num(o.peakMultiple),
      drawdownFromPeakPct: last ? num(last.drawdownFromPeakPct) : 0,
      watchMinutes: last ? num(last.watchMinutes) : 0,
      ticks: o.ticks,
      regime: last?.regime ?? null,
      action: last?.action ?? null,
      continuationScore: last ? num(last.continuationScore) : 50,
      triggered: o.triggeredAt != null,
      triggerMultiple: o.triggerMultiple == null ? null : num(o.triggerMultiple),
      armed: o.armed,
      entered: o.entered,
      disposition: o.entered
        ? posState.get(o.mint)?.open
          ? "in book ✓" // an OPEN position — visible on the Matrix + Positions now
          : `traded ${(posState.get(o.mint)?.pnl ?? 0) >= 0 ? "✓ +" : "· −"}$${Math.abs(posState.get(o.mint)?.pnl ?? 0).toFixed(2)}` // closed — lives in the ghost tape / fills
        : o.armed
          ? (verdicts.get(o.mint) ?? "queued · next scan")
          : o.triggeredAt != null
            ? "disarmed"
            : null,
      spark: view.map((r, i) => ({ i, mm: num(r.markMultiple) })),
    });
  }
  return out;
}

export interface RecorderOutcome {
  mint: string;
  symbol: string | null;
  dex: string | null;
  peakMultiple: number;
  finalMultiple: number;
  maxDrawdownFromPeakPct: number;
  minutesToPeak: number | null;
  ticks: number;
  label: string;
  entered: boolean;
  earlyScore: number | null; // max classifier continuation score within EARLY_MIN
}

/**
 * Closed candidates — the labeled rows. `earlyScore` is the crux: the highest
 * continuation score the classifier reached within the first EARLY_MIN minutes
 * (the "would we have confirmed it?" reading). If winners carry a higher early
 * score than duds, that column IS the edge, and the weight fit will find it.
 */
export async function getRecorderOutcomes(limit = 150): Promise<RecorderOutcome[]> {
  const rows = await db
    .select({
      mint: candidateOutcomes.mint,
      symbol: tokens.symbol,
      dex: tokens.dex,
      peakMultiple: candidateOutcomes.peakMultiple,
      finalMultiple: candidateOutcomes.finalMultiple,
      maxDd: candidateOutcomes.maxDrawdownFromPeakPct,
      minutesToPeak: candidateOutcomes.minutesToPeak,
      ticks: candidateOutcomes.ticks,
      label: candidateOutcomes.label,
      entered: candidateOutcomes.entered,
      earlyScore: sql<
        number | null
      >`(select max(${candidateTicks.continuationScore})::float from ${candidateTicks} where ${candidateTicks.mint} = ${candidateOutcomes.mint} and ${candidateTicks.watchMinutes} <= ${EARLY_MIN})`,
    })
    .from(candidateOutcomes)
    .innerJoin(tokens, eq(tokens.mint, candidateOutcomes.mint))
    .where(sql`${candidateOutcomes.label} <> 'open'`)
    .orderBy(desc(candidateOutcomes.peakMultiple))
    .limit(limit);

  return rows.map((r) => ({
    mint: r.mint,
    symbol: r.symbol,
    dex: r.dex,
    peakMultiple: num(r.peakMultiple),
    finalMultiple: num(r.finalMultiple),
    maxDrawdownFromPeakPct: num(r.maxDd),
    minutesToPeak: r.minutesToPeak === null ? null : num(r.minutesToPeak),
    ticks: r.ticks,
    label: r.label,
    entered: r.entered,
    earlyScore: r.earlyScore === null ? null : Number(r.earlyScore),
  }));
}

/**
 * The separation readout — the whole point of the flywheel. Mean early
 * classifier score for winners vs duds, once there's data. If winnersMean pulls
 * meaningfully above dudsMean, the early trajectory carries a real edge.
 */
export interface EdgeSeparation {
  winnersMean: number | null;
  dudsMean: number | null;
  winnersN: number;
  dudsN: number;
}

export async function getEdgeSeparation(): Promise<EdgeSeparation> {
  const early = sql<number>`(select max(${candidateTicks.continuationScore})::float from ${candidateTicks} where ${candidateTicks.mint} = ${candidateOutcomes.mint} and ${candidateTicks.watchMinutes} <= ${EARLY_MIN})`;
  const [w] = await db
    .select({ mean: sql<number | null>`avg(${early})`, n: sql<number>`count(${early})::int` })
    .from(candidateOutcomes)
    .where(eq(candidateOutcomes.label, "winner"));
  const [d] = await db
    .select({ mean: sql<number | null>`avg(${early})`, n: sql<number>`count(${early})::int` })
    .from(candidateOutcomes)
    .where(sql`${candidateOutcomes.label} in ('dud','rug')`);
  return {
    winnersMean: w?.mean == null ? null : Number(w.mean),
    dudsMean: d?.mean == null ? null : Number(d.mean),
    winnersN: w?.n ?? 0,
    dudsN: d?.n ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Intel Report — the ML digest. A KEYLESS, transparent synthesis of what the
// engine is actually doing, computed entirely from the DB (no Claude API — the
// "ML" here is the transparent factor model, and the report shows its real
// numbers so the user becomes a subject-matter expert instead of trusting a
// black box). Two rules, both from hard-won honesty: every performance stat
// carries its sample size inline, and anything below MIN_COHORT_N is reported
// as "not enough data yet" rather than dressed up as a pattern. The funnel and
// the methodology are the parts that teach regardless of n — they're the spine.
// ---------------------------------------------------------------------------

const MIN_COHORT_N = 4; // fewer closed trades than this in a bucket = noise, not a pattern

export interface CohortStat {
  key: string;
  trades: number;
  wins: number;
  pnl: number;
}

/**
 * A position that died almost instantly for a catastrophic loss — held < 5s and
 * gave back > 50% of its size. This is the tripwire the phantom-loss fix left
 * behind: post-fix, a feed divergence at entry SKIPS the trade, so a fast total
 * loss should now only ever be a real atomic rug. Each row is tagged so the Intel
 * Report auto-splits a REGRESSION (a divergence slipped through the entry guard)
 * from a REAL fast death (the recorder independently labeled the mint a rug).
 */
export interface FastLoss {
  mint: string;
  symbol: string | null;
  heldSeconds: number;
  pnlUsd: number;
  lossPct: number; // |loss| as a fraction of size, 0..1+
  exitReason: string | null;
  openedAt: string;
  classification: "phantom_divergence" | "real_rug" | "review";
}

export interface QualityTier {
  tier: "full" | "reduced";
  openN: number;
  closedN: number;
  wins: number;
  netPnlUsd: number;
  avgPnlUsd: number | null;
}

export interface IntelReport {
  funnel: {
    scanned24h: number;
    safetyPassed24h: number; // signals cleared safety in 24h
    triggeredTotal: number; // recorder-as-scout confirmations in the dataset
    enteredTotal: number; // candidates we actually took a position on
  };
  fastLossTriage: FastLoss[];
  // Confirm-quality sizing validation: do reduced-size (fading buy-share) entries
  // actually underperform full-conviction ones live? Rows appear as tiers close.
  qualityTiers: QualityTier[];
  edge: {
    winnersTotal: number;
    winnersTriggered: number;
    dudsTotal: number;
    dudsTriggered: number;
  };
  performance: {
    closedTrades: number;
    wins: number;
    realizedPnlUsd: number;
    avgWinUsd: number | null;
    avgLossUsd: number | null;
  };
  cohorts: {
    byVenue: CohortStat[];
    byRegime: CohortStat[];
    minN: number;
  };
}

export async function getIntelReport(): Promise<IntelReport> {
  const [scanned] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tokens)
    .where(gte(tokens.firstSeenAt, DAY_AGO()));
  const [sig] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(signals)
    .where(gte(signals.createdAt, DAY_AGO()));
  const [funnelC] = await db
    .select({
      triggered: sql<number>`count(*) filter (where ${candidateOutcomes.triggeredAt} is not null)::int`,
      entered: sql<number>`count(*) filter (where ${candidateOutcomes.entered})::int`,
    })
    .from(candidateOutcomes);

  // The live analog of the replay calibration: of the candidates the recorder
  // labeled winner vs dud, how many did the confirmation gate actually fire on?
  const [edgeC] = await db
    .select({
      winnersTotal: sql<number>`count(*) filter (where ${candidateOutcomes.label} = 'winner')::int`,
      winnersTriggered: sql<number>`count(*) filter (where ${candidateOutcomes.label} = 'winner' and ${candidateOutcomes.triggeredAt} is not null)::int`,
      dudsTotal: sql<number>`count(*) filter (where ${candidateOutcomes.label} in ('dud','rug'))::int`,
      dudsTriggered: sql<number>`count(*) filter (where ${candidateOutcomes.label} in ('dud','rug') and ${candidateOutcomes.triggeredAt} is not null)::int`,
    })
    .from(candidateOutcomes);

  // Realized performance on CLOSED trades — the least reliable numbers here (tiny
  // n), guarded hardest: averages are null until there's at least one of each.
  const [perf] = await db
    .select({
      closed: sql<number>`count(*)::int`,
      wins: sql<number>`count(*) filter (where ${positions.realizedPnlUsd}::numeric > 0)::int`,
      realized: sql<string>`coalesce(sum(${positions.realizedPnlUsd}), 0)`,
      avgWin: sql<
        string | null
      >`avg(${positions.realizedPnlUsd}) filter (where ${positions.realizedPnlUsd}::numeric > 0)`,
      avgLoss: sql<
        string | null
      >`avg(${positions.realizedPnlUsd}) filter (where ${positions.realizedPnlUsd}::numeric <= 0)`,
    })
    .from(positions)
    .where(and(eq(positions.lane, "paper"), eq(positions.status, "closed")));

  const byVenue = await db
    .select({
      key: sql<string>`coalesce(${tokens.dex}, 'unknown')`,
      trades: sql<number>`count(*)::int`,
      wins: sql<number>`count(*) filter (where ${positions.realizedPnlUsd}::numeric > 0)::int`,
      pnl: sql<string>`coalesce(sum(${positions.realizedPnlUsd}), 0)`,
    })
    .from(positions)
    .innerJoin(tokens, eq(tokens.mint, positions.mint))
    .where(and(eq(positions.lane, "paper"), eq(positions.status, "closed")))
    .groupBy(sql`coalesce(${tokens.dex}, 'unknown')`)
    .orderBy(desc(sql`count(*)`));

  // triggerReason is a freeform per-event string ("1.27x green, 99% buys at
  // 6.2m") — grouping on it explodes into a list of n=1 rows that teaches
  // nothing. Bucket instead by TIME-TO-CONFIRM (triggered_at − first_seen_at),
  // an actual lever (CONFIRM_MIN/MAX_WATCH_MIN): does a fast or a late
  // confirmation convert to a 2×+ winner more often? Three bands, always usable.
  const confirmBand = sql<string>`case
      when extract(epoch from (${candidateOutcomes.triggeredAt} - ${candidateOutcomes.firstSeenAt})) / 60 < 4 then '2–4 min · fast'
      when extract(epoch from (${candidateOutcomes.triggeredAt} - ${candidateOutcomes.firstSeenAt})) / 60 < 8 then '4–8 min · mid'
      else '8–12 min · late'
    end`;
  const byRegime = await db
    .select({
      key: confirmBand,
      trades: sql<number>`count(*)::int`,
      wins: sql<number>`count(*) filter (where ${candidateOutcomes.label} = 'winner')::int`,
      pnl: sql<string>`0`,
    })
    .from(candidateOutcomes)
    .where(sql`${candidateOutcomes.triggeredAt} is not null`)
    .groupBy(confirmBand)
    .orderBy(confirmBand);

  const toCohort = (r: { key: string; trades: number; wins: number; pnl: string | number }): CohortStat => ({
    key: r.key,
    trades: r.trades,
    wins: r.wins,
    pnl: Number(r.pnl),
  });

  // Fast-loss tripwire: closed paper positions held < 5s that lost > 50% of size.
  // had_divergence = a feed-divergence audit for this mint fired around entry (post-
  // fix that should NEVER coincide with an actual open — if it does, the guard let a
  // phantom through = regression). recorder_label independently corroborates a real
  // rug. Newest first, capped — this is a triage queue, not an analytic.
  const fastLossRows = await db.execute(sql`
    SELECT p.mint,
      t.symbol AS symbol,
      extract(epoch from (p.closed_at - p.opened_at))::float AS held_s,
      p.realized_pnl_usd::float AS pnl,
      p.size_usd::float AS size_usd,
      p.exit_reason AS exit_reason,
      p.opened_at AS opened_at,
      EXISTS (
        SELECT 1 FROM audit_log a
        WHERE a.action IN ('entry_feed_divergence_skip', 'entry_jupiter_reject')
          AND a.details->>'mint' = p.mint
          AND a.created_at BETWEEN p.opened_at - interval '90 seconds' AND p.opened_at + interval '3 seconds'
      ) AS had_divergence,
      co.label AS recorder_label
    FROM positions p
    LEFT JOIN tokens t ON t.mint = p.mint
    LEFT JOIN candidate_outcomes co ON co.mint = p.mint
    WHERE p.lane = 'paper' AND p.status = 'closed'
      AND p.closed_at IS NOT NULL AND p.opened_at IS NOT NULL
      AND p.size_usd::numeric > 0
      AND p.closed_at >= now() - interval '24 hours'
      AND extract(epoch from (p.closed_at - p.opened_at)) < 5
      AND p.realized_pnl_usd::numeric <= -0.5 * p.size_usd::numeric
    ORDER BY p.closed_at DESC
    LIMIT 25
  `);
  const fastLossTriage: FastLoss[] = (fastLossRows as unknown as Array<Record<string, unknown>>).map((r) => {
    const size = Number(r.size_usd) || 0;
    const pnl = Number(r.pnl) || 0;
    const hadDivergence = r.had_divergence === true;
    const label = (r.recorder_label as string) ?? null;
    return {
      mint: String(r.mint),
      symbol: (r.symbol as string) ?? null,
      heldSeconds: Number(r.held_s) || 0,
      pnlUsd: pnl,
      lossPct: size > 0 ? Math.abs(pnl) / size : 0,
      exitReason: (r.exit_reason as string) ?? null,
      openedAt: new Date(r.opened_at as string).toISOString(),
      classification: hadDivergence ? "phantom_divergence" : label === "rug" ? "real_rug" : "review",
    };
  });

  // Confirm-quality sizing scoreboard: full-conviction vs reduced-size (fading
  // buy-share) entries, open counts + closed win rate + P&L per tier. Only rows
  // with quality_mult set (post-deploy entries) — the tiers must be comparable.
  const qualityRows = await db.execute(sql`
    SELECT CASE WHEN quality_mult::numeric < 1 THEN 'reduced' ELSE 'full' END AS tier,
      count(*) FILTER (WHERE status = 'open')::int AS open_n,
      count(*) FILTER (WHERE status = 'closed')::int AS closed_n,
      count(*) FILTER (WHERE status = 'closed' AND realized_pnl_usd::numeric > 0)::int AS wins,
      COALESCE(sum(realized_pnl_usd::numeric) FILTER (WHERE status = 'closed'), 0)::float AS net_pnl,
      avg(realized_pnl_usd::numeric) FILTER (WHERE status = 'closed')::float AS avg_pnl
    FROM positions
    WHERE lane = 'paper' AND quality_mult IS NOT NULL
    GROUP BY 1
    ORDER BY 1
  `);
  const qualityTiers: QualityTier[] = (qualityRows as unknown as Array<Record<string, unknown>>).map((r) => ({
    tier: r.tier === "reduced" ? "reduced" : "full",
    openN: Number(r.open_n) || 0,
    closedN: Number(r.closed_n) || 0,
    wins: Number(r.wins) || 0,
    netPnlUsd: Number(r.net_pnl) || 0,
    avgPnlUsd: r.avg_pnl == null ? null : Number(r.avg_pnl),
  }));

  return {
    funnel: {
      scanned24h: scanned?.n ?? 0,
      safetyPassed24h: sig?.n ?? 0,
      triggeredTotal: funnelC?.triggered ?? 0,
      enteredTotal: funnelC?.entered ?? 0,
    },
    fastLossTriage,
    qualityTiers,
    edge: {
      winnersTotal: edgeC?.winnersTotal ?? 0,
      winnersTriggered: edgeC?.winnersTriggered ?? 0,
      dudsTotal: edgeC?.dudsTotal ?? 0,
      dudsTriggered: edgeC?.dudsTriggered ?? 0,
    },
    performance: {
      closedTrades: perf?.closed ?? 0,
      wins: perf?.wins ?? 0,
      realizedPnlUsd: Number(perf?.realized ?? 0),
      avgWinUsd: perf?.avgWin == null ? null : Number(perf.avgWin),
      avgLossUsd: perf?.avgLoss == null ? null : Number(perf.avgLoss),
    },
    cohorts: {
      byVenue: byVenue.map(toCohort),
      byRegime: byRegime.map(toCohort),
      minN: MIN_COHORT_N,
    },
  };
}

/**
 * The live edge, tracked over time. 6-hour buckets of winners-fired% vs
 * duds-fired% — the same separation the replay measured, but as a trend so decay
 * is visible. On fresh data (a couple of days) 6h buckets give ~8-12 points each
 * with a stable n (~70), where daily buckets would be a two-dot line. Widen the
 * bucket as the dataset grows past a week.
 */
export interface EdgePoint {
  bucket: string; // ISO start of the bucket
  winnersPct: number | null; // % of that bucket's winners the gate fired on
  dudsPct: number | null; // % of that bucket's duds+rugs the gate fired on
  sep: number | null; // winnersPct / dudsPct
  nWin: number;
  nDud: number;
  fired: number;
}

export async function getEdgeSeries(bucketHours = 6, windowHours = 72): Promise<EdgePoint[]> {
  const span = bucketHours * 3600;
  const rows = (await db.execute(sql`
    select
      to_timestamp(floor(extract(epoch from first_seen_at) / ${span}) * ${span}) as bucket,
      count(*) filter (where label = 'winner')::int as win_total,
      count(*) filter (where label = 'winner' and triggered_at is not null)::int as win_fired,
      count(*) filter (where label in ('dud','rug'))::int as dud_total,
      count(*) filter (where label in ('dud','rug') and triggered_at is not null)::int as dud_fired,
      count(*) filter (where triggered_at is not null)::int as fired
    from candidate_outcomes
    where first_seen_at > now() - make_interval(hours => ${windowHours}) and label <> 'open'
    group by 1
    order by 1
  `)) as unknown as Array<{
    bucket: string;
    win_total: number;
    win_fired: number;
    dud_total: number;
    dud_fired: number;
    fired: number;
  }>;
  return rows.map((r) => {
    const wp = r.win_total > 0 ? (100 * r.win_fired) / r.win_total : null;
    const dp = r.dud_total > 0 ? (100 * r.dud_fired) / r.dud_total : null;
    return {
      bucket: new Date(r.bucket).toISOString(),
      winnersPct: wp,
      dudsPct: dp,
      sep: wp !== null && dp !== null && dp > 0 ? wp / dp : null,
      nWin: Number(r.win_total),
      nDud: Number(r.dud_total),
      fired: Number(r.fired),
    };
  });
}

export type KpiFormat = "ratio" | "pct" | "usd" | "int";
export interface Kpi {
  key: string;
  label: string;
  value: number | null; // null = no data yet
  format: KpiFormat;
  delta: number | null; // signed change vs the prior 24h window (metric's own units; pct = points)
  higherIsBetter: boolean; // how to color the delta
  spark: number[]; // sparkline series (may be empty → tile renders without one)
  sub?: string; // e.g. "n=12"
}

/** Cumulative winners/duds fire separation over a time window [from, to). */
async function edgeSepInWindow(from: Date, to: Date): Promise<number | null> {
  const [r] = await db
    .select({
      winT: sql<number>`count(*) filter (where ${candidateOutcomes.label} = 'winner')::int`,
      winF: sql<number>`count(*) filter (where ${candidateOutcomes.label} = 'winner' and ${candidateOutcomes.triggeredAt} is not null)::int`,
      dudT: sql<number>`count(*) filter (where ${candidateOutcomes.label} in ('dud','rug'))::int`,
      dudF: sql<number>`count(*) filter (where ${candidateOutcomes.label} in ('dud','rug') and ${candidateOutcomes.triggeredAt} is not null)::int`,
    })
    .from(candidateOutcomes)
    .where(and(gte(candidateOutcomes.firstSeenAt, from), lt(candidateOutcomes.firstSeenAt, to)));
  if (!r) return null;
  const wp = r.winT > 0 ? (100 * r.winF) / r.winT : null;
  const dp = r.dudT > 0 ? (100 * r.dudF) / r.dudT : null;
  return wp !== null && dp !== null && dp > 0 ? wp / dp : null;
}

async function countTriggersInWindow(from: Date, to: Date): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(candidateOutcomes)
    .where(and(gte(candidateOutcomes.triggeredAt, from), lt(candidateOutcomes.triggeredAt, to)));
  return r?.n ?? 0;
}

/**
 * The KPI strip — the six numbers that read at a glance, each with its change vs
 * the prior 24h and a sparkline where a cheap series exists. Recorder-derived
 * KPIs (edge, triggers, conversion) are data-rich; trade-derived ones (win-rate,
 * realized) stay honest about a thin post-slate sample via `sub`.
 */
export async function getKpiStrip(): Promise<Kpi[]> {
  const now = new Date();
  const d1 = new Date(now.getTime() - 24 * 3600 * 1000);
  const d2 = new Date(now.getTime() - 48 * 3600 * 1000);
  const buckets = await getEdgeSeries(6, 72);

  const [intel, sep24, sepPrev, trig24, trigPrev, equitySeries] = await Promise.all([
    getIntelReport(),
    edgeSepInWindow(d1, now),
    edgeSepInWindow(d2, d1),
    countTriggersInWindow(d1, now),
    countTriggersInWindow(d2, d1),
    getEquitySeries(),
  ]);

  const { edge, funnel, performance } = intel;
  const sepCum = edge.dudsTotal > 0 && edge.dudsTriggered > 0
    ? (edge.winnersTriggered / edge.winnersTotal) / (edge.dudsTriggered / edge.dudsTotal)
    : null;
  const conv = funnel.triggeredTotal > 0 ? (100 * funnel.enteredTotal) / funnel.triggeredTotal : null;
  const winRate = performance.closedTrades > 0 ? (100 * performance.wins) / performance.closedTrades : null;
  const equitySpark = equitySeries.map((p) => Number(p.equity));

  return [
    {
      key: "edge",
      label: "Edge separation",
      value: sepCum,
      format: "ratio",
      delta: sep24 !== null && sepPrev !== null ? sep24 - sepPrev : null,
      higherIsBetter: true,
      spark: buckets.map((b) => b.sep).filter((s): s is number => s !== null),
      sub: `${edge.winnersTotal}W / ${edge.dudsTotal}D`,
    },
    {
      key: "triggers",
      label: "⚡ Confirmed · 24h",
      value: trig24,
      format: "int",
      delta: trig24 - trigPrev,
      higherIsBetter: true,
      spark: buckets.map((b) => b.fired),
    },
    {
      key: "conversion",
      label: "Confirm→entry",
      value: conv,
      format: "pct",
      delta: null,
      higherIsBetter: true,
      spark: [],
      sub: `${funnel.enteredTotal}/${funnel.triggeredTotal}`,
    },
    {
      key: "winrate",
      label: "Win rate · closed",
      value: winRate,
      format: "pct",
      delta: null,
      higherIsBetter: true,
      spark: [],
      sub: `n=${performance.closedTrades}`,
    },
    {
      key: "realized",
      label: "Realized P&L",
      value: performance.realizedPnlUsd,
      format: "usd",
      delta: equitySpark.length >= 2 ? equitySpark[equitySpark.length - 1]! - equitySpark[0]! : null,
      higherIsBetter: true,
      spark: equitySpark,
    },
    {
      key: "safety",
      label: "Safety pass · 24h",
      value: funnel.scanned24h > 0 ? (100 * funnel.safetyPassed24h) / funnel.scanned24h : null,
      format: "pct",
      delta: null,
      higherIsBetter: false, // a trap-only gate passing MORE isn't inherently good; neutral-ish
      spark: [],
      sub: `${funnel.safetyPassed24h}/${funnel.scanned24h}`,
    },
  ];
}

export async function getKillSwitch(): Promise<boolean> {
  const [row] = await db.select().from(config).where(eq(config.key, "kill_switch"));
  return (row?.value as { enabled?: boolean } | undefined)?.enabled === true;
}

// ── News desk ───────────────────────────────────────────────────────────────
export interface NewsThemeStat {
  category: string;
  launches: number;
  winners: number;
  winRatePct: number;
  volumeGrowthPct: number;
  emergingScore: number;
}
export interface NewsStory {
  id: number;
  kind: string;
  mint: string | null;
  category: string | null;
  narrative: string | null;
  headline: string;
  whyItMatters: string | null;
  importance: number;
  contentDrafts: { xPost?: string; shortTake?: string; xThread?: string[] } | null;
  refs: Record<string, unknown> | null;
  model: string | null;
  createdAt: string;
}
export interface NewsView {
  brief: NewsStory | null;
  themes: NewsThemeStat[];
  movers: NewsStory[];
  generatedAt: string | null;
  model: string | null;
}

const toStory = (r: typeof marketNews.$inferSelect): NewsStory => ({
  id: r.id,
  kind: r.kind,
  mint: r.mint,
  category: r.category,
  narrative: r.narrative,
  headline: r.headline,
  whyItMatters: r.whyItMatters,
  importance: r.importance,
  contentDrafts: (r.contentDrafts as NewsStory["contentDrafts"]) ?? null,
  refs: (r.refs as Record<string, unknown>) ?? null,
  model: r.model,
  createdAt: r.createdAt.toISOString(),
});

export async function getNews(): Promise<NewsView> {
  const [brief] = await db
    .select()
    .from(marketNews)
    .where(eq(marketNews.kind, "brief"))
    .orderBy(desc(marketNews.createdAt))
    .limit(1);
  const movers = await db
    .select()
    .from(marketNews)
    .where(eq(marketNews.kind, "mover"))
    .orderBy(desc(marketNews.createdAt), desc(marketNews.importance))
    .limit(24);
  const themes = ((brief?.themes as { stats?: NewsThemeStat[] } | null)?.stats ?? [])
    .slice()
    .sort((a, b) => b.emergingScore - a.emergingScore);
  return {
    brief: brief ? toStory(brief) : null,
    themes,
    movers: movers.map(toStory),
    generatedAt: brief ? brief.createdAt.toISOString() : (movers[0]?.createdAt.toISOString() ?? null),
    model: brief?.model ?? movers[0]?.model ?? null,
  };
}

// ── System health ───────────────────────────────────────────────────────────
// One lightweight read of whether the whole machine is alive: per-service
// last-write age (proves each daemon is doing its job, not just running),
// per-feed reachability (a filtered host on this box returns nothing), the
// PumpPortal WebSocket canary (silent-death is the failure mode that stalled
// us before), and the end-to-end funnel. Prepping for live production: this is
// the surface the operator watches instead of tailing four log files.

export interface ServiceHealth {
  name: string;
  lastWriteAt: string | null;
  ageSec: number | null;
  ok: boolean;
  detail: string;
}
export interface FeedHealth {
  name: string;
  ok: boolean;
  latencyMs: number | null;
  note: string;
  // essential = the reachable stack we actually depend on (DexScreener price/ingest,
  // RugCheck safety). Optional feeds (Jupiter, GeckoTerminal) are filtered on this
  // host and the pipeline is architected to run without them — their being down is
  // shown but must not drag the overall roll-up into a permanent false alarm.
  essential: boolean;
}
export interface PumpPortalHealthView {
  connected: boolean;
  heartbeatAgeSec: number | null;
  lastMigrationAgeSec: number | null;
  migrationsSeen: number;
  reconnects: number;
}
export interface SystemHealthView {
  at: string;
  services: ServiceHealth[];
  feeds: FeedHealth[];
  pumpportal: PumpPortalHealthView | null;
  pipeline: {
    scanned24h: number;
    signals24h: number;
    watching: number;
    armed: number;
    openPositions: number;
    equity: number | null;
    killSwitch: boolean;
  };
  overall: "ok" | "warn" | "down";
}

const ageSec = (d: Date | null): number | null =>
  d ? Math.max(0, Math.round((Date.now() - d.getTime()) / 1000)) : null;

/** Reachability probe: any HTTP response (even 4xx) means the host is reachable;
 * a throw/timeout means the filter dropped it (curl http_code 000 equivalent). */
async function probeFeed(name: string, url: string, essential: boolean): Promise<FeedHealth> {
  const started = Date.now();
  try {
    // resilientFetch mirrors what the services do (curl fallback through GoodbyeDPI
    // for SNI-filtered hosts), so the panel reports true reachability, not undici's.
    const res = await resilientFetch(url, { headers: { accept: "application/json" }, timeoutMs: 3500 });
    return { name, essential, ok: true, latencyMs: Date.now() - started, note: `HTTP ${res.status}` };
  } catch (err) {
    return {
      name,
      essential,
      ok: false,
      latencyMs: null,
      note: err instanceof Error && err.name === "TimeoutError" ? "timeout" : "unreachable",
    };
  }
}

const WSOL = "So11111111111111111111111111111111111111112";

export async function getSystemHealth(): Promise<SystemHealthView> {
  // ── service liveness (each daemon writes a cheap config heartbeat every cycle) ──
  // Heartbeats, not data-table ages: candidate_ticks / pnl_snapshots are only
  // written when there's work, so an idle-but-healthy service would look dead.
  const heartbeatRows = await db
    .select()
    .from(config)
    .where(inArray(config.key, ["scout_health", "recorder_health", "trader_health"]));
  const hb = new Map(heartbeatRows.map((r) => [r.key, r.value as Record<string, unknown>]));

  const scoutHealth = hb.get("scout_health") as
    | { ts?: number; streamQueue?: number; pumpportal?: PumpPortalHealthView & { lastMessageAt?: number | null; lastMigrationAt?: number | null } }
    | undefined;
  const recorderHb = hb.get("recorder_health") as { ts?: number; watching?: number } | undefined;
  const traderHb = hb.get("trader_health") as { ts?: number; halted?: boolean } | undefined;

  const scoutAt = scoutHealth?.ts ? new Date(scoutHealth.ts) : null;
  const recorderAt = recorderHb?.ts ? new Date(recorderHb.ts) : null;
  const traderAt = traderHb?.ts ? new Date(traderHb.ts) : null;

  const scoutAge = ageSec(scoutAt);
  const recorderAge = ageSec(recorderAt);
  const traderAge = ageSec(traderAt);

  // Thresholds allow ~2 missed cycles: scout polls 45s, recorder 20s, trader
  // heartbeats every 15s. Generous enough to avoid flapping on one slow tick.
  const services: ServiceHealth[] = [
    {
      name: "SCOUT",
      lastWriteAt: scoutAt?.toISOString() ?? null,
      ageSec: scoutAge,
      ok: scoutAge !== null && scoutAge < 120,
      detail: scoutHealth?.streamQueue != null ? `${scoutHealth.streamQueue} maturing in queue` : "ingest + safety",
    },
    {
      name: "RECORDER",
      lastWriteAt: recorderAt?.toISOString() ?? null,
      ageSec: recorderAge,
      ok: recorderAge !== null && recorderAge < 90,
      detail: recorderHb?.watching != null ? `${recorderHb.watching} in window` : "flywheel tick",
    },
    {
      name: "TRADER",
      lastWriteAt: traderAt?.toISOString() ?? null,
      ageSec: traderAge,
      ok: traderAge !== null && traderAge < 60,
      detail: traderHb?.halted ? "halted (kill switch)" : "manage loop",
    },
  ];

  // ── PumpPortal WS canary (from scout's heartbeat) ──
  const pp = scoutHealth?.pumpportal;
  const pumpportal: PumpPortalHealthView | null = pp
    ? {
        connected: !!pp.connected,
        heartbeatAgeSec: pp.lastMessageAt ? Math.max(0, Math.round((Date.now() - pp.lastMessageAt) / 1000)) : null,
        lastMigrationAgeSec: pp.lastMigrationAt ? Math.max(0, Math.round((Date.now() - pp.lastMigrationAt) / 1000)) : null,
        migrationsSeen: pp.migrationsSeen ?? 0,
        reconnects: pp.reconnects ?? 0,
      }
    : null;

  // ── feed reachability (live probes, in parallel) ──
  const feeds = await Promise.all([
    probeFeed("DexScreener", "https://api.dexscreener.com/token-profiles/latest/v1", true),
    probeFeed("RugCheck", `https://api.rugcheck.xyz/v1/tokens/${WSOL}/report`, true),
    // Discovery-only + a flaky marketing host; the WS canary (connected + heartbeat
    // age) is its real liveness signal, and DexScreener still covers ingest if it
    // blips — so a down HTTP probe here must not drag the overall roll-up.
    probeFeed("PumpPortal", "https://pumpportal.fun", false),
    // Essential to the full "winning formula": Jupiter = real-time block-level
    // price marks (truer exits), GeckoTerminal = new-pools firehose (earliest
    // discovery). Currently SNI-blocked on this host — surfaced as a real gap,
    // not written off, until the DPI filter is bypassed/allowlisted.
    probeFeed("Jupiter", `https://datapi.jup.ag/v1/pools?assetIds=${WSOL}`, true),
    probeFeed("GeckoTerminal", "https://api.geckoterminal.com/api/v2/networks/solana/new_pools", true),
  ]);

  // ── funnel ──
  const [scanned] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tokens)
    .where(gte(tokens.firstSeenAt, DAY_AGO()));
  const [signalCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(signals)
    .where(gte(signals.createdAt, DAY_AGO()));
  const [watching] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(candidateOutcomes)
    .where(eq(candidateOutcomes.label, "open"));
  const [armed] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(candidateOutcomes)
    .where(eq(candidateOutcomes.armed, true));
  const [openCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(positions)
    .where(eq(positions.status, "open"));
  const [equitySnap] = await db
    .select({ equity: pnlSnapshots.equityUsd })
    .from(pnlSnapshots)
    .where(eq(pnlSnapshots.lane, "paper"))
    .orderBy(desc(pnlSnapshots.snappedAt))
    .limit(1);
  const killSwitch = await getKillSwitch();

  // ── overall roll-up ──
  // Down: any service dead OR the load-bearing price/ingest feed (DexScreener) gone.
  // Warn: another essential feed degraded (RugCheck/PumpPortal). Optional feeds
  // (Jupiter/GeckoTerminal) are known-filtered here and never drive the roll-up.
  const anyServiceDown = services.some((s) => !s.ok);
  const dexDown = feeds.find((f) => f.name === "DexScreener")?.ok === false;
  const essentialDown = feeds.some((f) => f.essential && !f.ok);
  const overall: SystemHealthView["overall"] =
    anyServiceDown || dexDown ? "down" : essentialDown ? "warn" : "ok";

  return {
    at: new Date().toISOString(),
    services,
    feeds,
    pumpportal,
    pipeline: {
      scanned24h: scanned?.n ?? 0,
      signals24h: signalCount?.n ?? 0,
      watching: watching?.n ?? 0,
      armed: armed?.n ?? 0,
      openPositions: openCount?.n ?? 0,
      equity: equitySnap ? Number(equitySnap.equity) : null,
      killSwitch,
    },
    overall,
  };
}

// ── Monte Carlo performance forecast ────────────────────────────────────────
// Fan of where paper equity could go over the test horizon, bootstrapped from
// the empirical per-trade return distribution. See packages/core/forecast.ts for
// why we bootstrap final/trigger−1 (the zero-parameter window-end baseline) and
// NOT a capture-fraction model. Prefers realized returns from the current run as
// they accumulate; falls back to the recorder baseline until then.

const FORECAST_HORIZON_HOURS = 8;
const FORECAST_MIN_REALIZED = 20; // switch the fan onto live data past this many closed trades
const FORECAST_DEFAULT_RATE = 6; // trades/hr — conservative default until live opens set it
const FORECAST_DEFAULT_SIZE = 40; // $/position — risk-tier blend, until live opens set it

export interface ForecastView {
  forecast: ForecastResult;
  basis: {
    source: "baseline" | "realized";
    nBaseline: number;
    nRealized: number;
    meanBaselinePct: number;
    medianBaselinePct: number;
    pctProfitableBaseline: number;
    meanRealizedPct: number | null;
    tradeRateAssumed: boolean; // true = default guess; false = derived from live opens
  };
}

const meanOf = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const medOf = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export async function getForecast(): Promise<ForecastView> {
  // Run start — realized returns/rate are scoped to the current run only, because
  // archived runs carry now-fixed exit bugs that would forecast disaster.
  const [runRow] = await db.select().from(config).where(eq(config.key, "paper_run_start"));
  const startedAtRaw = (runRow?.value as { startedAt?: string } | undefined)?.startedAt;
  const runStart = startedAtRaw ? new Date(startedAtRaw) : new Date(Date.now() - 24 * 3600 * 1000);

  // Start equity — latest paper snapshot, else fresh bankroll.
  const [snap] = await db
    .select({ equity: pnlSnapshots.equityUsd })
    .from(pnlSnapshots)
    .where(eq(pnlSnapshots.lane, "paper"))
    .orderBy(desc(pnlSnapshots.snappedAt))
    .limit(1);
  const startEquity = snap ? Number(snap.equity) : 1000;

  // Baseline sample: r = final_multiple / trigger_multiple − 1 over closed,
  // triggered recorder candidates (the trades the gate would actually take).
  const baseRows = await db
    .select({
      r: sql<number>`(${candidateOutcomes.finalMultiple} / nullif(${candidateOutcomes.triggerMultiple}, 0)) - 1`,
    })
    .from(candidateOutcomes)
    .where(
      and(
        sql`${candidateOutcomes.triggeredAt} is not null`,
        sql`${candidateOutcomes.label} <> 'open'`,
        sql`${candidateOutcomes.triggerMultiple} > 0`,
      ),
    );
  const baseline = baseRows.map((x) => Number(x.r)).filter((x) => Number.isFinite(x));

  // Realized sample: closed positions opened during THIS run. r = pnl / cost.
  const realRows = await db
    .select({ pnl: positions.realizedPnlUsd, size: positions.sizeUsd })
    .from(positions)
    .where(and(eq(positions.status, "closed"), gte(positions.openedAt, runStart)));
  const realized = realRows
    .map((x) => (x.pnl != null && Number(x.size) > 0 ? Number(x.pnl) / Number(x.size) : NaN))
    .filter((x) => Number.isFinite(x));

  // Live trade rate + avg size from this run's opens (self-sharpening); until we
  // have enough opens, fall back to conservative, clearly-flagged defaults.
  const openRows = await db
    .select({ openedAt: positions.openedAt, size: positions.sizeUsd })
    .from(positions)
    .where(gte(positions.openedAt, runStart))
    .orderBy(asc(positions.openedAt));
  let tradesPerHour = FORECAST_DEFAULT_RATE;
  let avgSizeUsd = FORECAST_DEFAULT_SIZE;
  let tradeRateAssumed = true;
  if (openRows.length >= 8) {
    const spanH = (openRows[openRows.length - 1].openedAt.getTime() - openRows[0].openedAt.getTime()) / 3_600_000;
    if (spanH > 0.25) {
      tradesPerHour = openRows.length / spanH;
      tradeRateAssumed = false;
    }
    avgSizeUsd = meanOf(openRows.map((o) => Number(o.size)).filter((s) => s > 0)) || FORECAST_DEFAULT_SIZE;
  }

  const useRealized = realized.length >= FORECAST_MIN_REALIZED;
  const sample = useRealized ? realized : baseline;

  const forecast = runForecast(sample, {
    startEquity,
    tradesPerHour,
    horizonHours: FORECAST_HORIZON_HOURS,
    avgSizeUsd,
  });

  return {
    forecast,
    basis: {
      source: useRealized ? "realized" : "baseline",
      nBaseline: baseline.length,
      nRealized: realized.length,
      meanBaselinePct: meanOf(baseline) * 100,
      medianBaselinePct: medOf(baseline) * 100,
      pctProfitableBaseline: baseline.length ? (100 * baseline.filter((r) => r > 0).length) / baseline.length : 0,
      meanRealizedPct: realized.length ? meanOf(realized) * 100 : null,
      tradeRateAssumed,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Live control terminal — the effective config the trader is running RIGHT NOW,
// broken out per knob: base default, adaptive recommendation, manual pin, and
// which channel won. The panel renders one dial per knob plus the regime read.
// ─────────────────────────────────────────────────────────────────────────────

export interface ControlKnobView extends OverrideKnob {
  value: number;
  base: number;
  auto: number | null;
  manual: number | null;
  source: ResolvedKnob["source"];
}

export interface ControlTerminalView {
  autoMode: "off" | "advisory" | "live";
  regime: RegimeState | null;
  updatedAt: number | null;
  groups: { group: OverrideGroup; label: string; knobs: ControlKnobView[] }[];
  // The REAL money that hits the next trade, so the book never lies again. Base
  // is the size knob; the off-hours throttle applies now if we're off-prime;
  // per-candidate risk (speculative→clean) and quality then modulate, so the
  // actual bet lands in [perTradeLo, perTradeHi].
  sizing: {
    base: number;
    offHoursMult: number;
    primeNow: boolean;
    sessionAdjusted: number; // base × (primeNow ? 1 : offHoursMult)
    perTradeLo: number; // × most-shrunk risk/quality
    perTradeHi: number; // × clean/full
    riskFloor: number; // the speculative multiplier
    autoMode: "off" | "advisory" | "live";
  };
}

const GROUP_LABELS: Record<OverrideGroup, string> = {
  size: "Size & book",
  tp: "Take-profit ladder",
  stop: "Stops & trail",
};

export async function getControlTerminal(): Promise<ControlTerminalView> {
  const cfg = loadConfig();
  const [row] = await db.select().from(config).where(eq(config.key, "runtime_overrides"));
  const raw = (row?.value ?? null) as { updatedAt?: number } | null;
  const { resolved, autoMode, regime } = resolveOverrides(cfg, raw);

  const knobViews: ControlKnobView[] = OVERRIDE_KNOBS.map((k) => ({
    ...k,
    ...resolved[k.key],
  }));

  const order: OverrideGroup[] = ["size", "tp", "stop"];
  const groups = order.map((group) => ({
    group,
    label: GROUP_LABELS[group],
    knobs: knobViews.filter((k) => k.group === group),
  }));

  const base = resolved.PAPER_POSITION_USD.value;
  const offHoursMult = resolved.OFF_HOURS_SIZE_MULT.value;
  const primeNow = cfg.PRIME_HOURS_UTC.has(new Date().getUTCHours());
  const sessionAdjusted = base * (primeNow ? 1 : offHoursMult);
  const riskFloor = cfg.RISK_SIZE_SPECULATIVE; // most-shrunk speculative candidate
  const qualityFloor = cfg.CONFIRM_QUALITY_SIZE_MULT; // fading-demand confirm

  return {
    autoMode,
    regime,
    updatedAt: raw?.updatedAt ?? null,
    groups,
    sizing: {
      base,
      offHoursMult,
      primeNow,
      sessionAdjusted: Number(sessionAdjusted.toFixed(2)),
      perTradeLo: Number((sessionAdjusted * riskFloor * qualityFloor).toFixed(2)),
      perTradeHi: Number(sessionAdjusted.toFixed(2)),
      riskFloor,
      autoMode,
    },
  };
}
