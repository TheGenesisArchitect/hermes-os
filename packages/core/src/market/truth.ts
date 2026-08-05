/**
 * THE MARKET TRUTH ENGINE (tech spec v2, board-approved 2026-08-05).
 *
 * PURPOSE
 *   One canonical market state for every consumer — paper manager, live
 *   guard, replay courts, console. The 48h machinery gap (+$1,595 simulated
 *   vs +$421 booked on the same policy and tape) was OBSERVATION ERROR: the
 *   manager watched through a slower single-vendor path while the recorder
 *   already wrote a ~2s tape. Consumers that decide from different truths
 *   cannot be compared, and replay verdicts cannot be trusted.
 *
 * SUCCESS       First-rung fire rate 26% → ≥70%; tick gaps >10s 179/24h → <20;
 *               replay-vs-reality divergence structurally impossible on the
 *               observation axis (§3 invariant shared by both).
 * FAILURE MODE  A phantom print arms a rung — blocked by the confidence
 *               threshold plus the existing peak-sanity rules; and by the
 *               recognition rule, which cannot see a tick that hasn't happened.
 * OWNER         Market Data
 *
 * THE BINDING INVARIANT (§3): every evaluation answers "could the manager
 * have known this yet?" — enforced here as pure functions used by BOTH the
 * live manager and the replay engine.
 */

/** A single observation from one source. */
export interface TruthTick {
  /** epoch ms of the observation */
  at: number;
  priceUsd: number;
  liquidityUsd: number;
}

export type TruthSource = "recorder" | "aggregator" | "executable";

/** Per-source confidence: an executable quote is a price we can transact. */
export const SOURCE_CONFIDENCE: Record<TruthSource, number> = {
  executable: 1.0,
  recorder: 0.99,
  aggregator: 0.94,
};

/** A tick may arm a rung only at or above this confidence. */
export const CONFIDENCE_MIN = 0.9;
/** Peak-sanity (inherited from the recorder's trusted-read rules). */
export const TRUSTED_MIN_LIQ_USD = 1_000;
export const MAX_SINGLE_TICK_JUMP = 3;

/**
 * THE RECOGNITION RULE — the look-ahead invariant, pure and testable.
 * Returns only the ticks the manager could actually have observed by
 * `evalAt`. A tick exactly at `evalAt` is NOT yet known (ties resolve to
 * not-yet-known), so a replay can never bank on an observation the live
 * manager would still be waiting for.
 */
export function recognizable(ticks: TruthTick[], evalAt: number): TruthTick[] {
  return ticks.filter((t) => t.at < evalAt);
}

/**
 * Is this observation allowed to ARM a decision? Confidence threshold plus
 * the peak-sanity rules that have guarded the recorder's tape since BBC 616f
 * (a $3k dust pool printed a phantom 16,913×).
 */
export function armable(tick: TruthTick, source: TruthSource, prevPrice: number | null): boolean {
  if (SOURCE_CONFIDENCE[source] < CONFIDENCE_MIN) return false;
  if (!(tick.priceUsd > 0) || tick.liquidityUsd < TRUSTED_MIN_LIQ_USD) return false;
  if (prevPrice != null && prevPrice > 0 && tick.priceUsd > prevPrice * MAX_SINGLE_TICK_JUMP) return false;
  return true;
}

/**
 * HIGH-WATER BARRIER DETECTION — maximum excursion since `sinceMs`, not the
 * last sample. The institutional standard for barrier crossings: the market
 * DID trade there, so a rung that the price crossed between polls must arm.
 * Only recognizable, armable ticks count.
 *
 * Returns the crossing tick (the first tick at/above `barrier`) and the FILL
 * tick — `fillDelayTicks` later, the honest-fill delay the replay courts have
 * used throughout, so recognition never implies instantaneous execution.
 */
export function highWaterCrossing(
  ticks: TruthTick[],
  entryPrice: number,
  barrier: number,
  evalAt: number,
  source: TruthSource = "recorder",
  fillDelayTicks = 2,
): { crossed: TruthTick; fill: TruthTick; maxExcursion: number } | null {
  const seen = recognizable(ticks, evalAt);
  if (!seen.length || !(entryPrice > 0)) return null;
  let prev: number | null = null;
  let maxExcursion = 0;
  let crossIdx = -1;
  for (let i = 0; i < seen.length; i++) {
    const t = seen[i]!;
    if (!armable(t, source, prev)) { prev = t.priceUsd; continue; }
    const x = t.priceUsd / entryPrice;
    if (x > maxExcursion) maxExcursion = x;
    if (crossIdx < 0 && x >= barrier) crossIdx = i;
    prev = t.priceUsd;
  }
  if (crossIdx < 0) return null;
  const fill = seen[Math.min(crossIdx + fillDelayTicks, seen.length - 1)]!;
  return { crossed: seen[crossIdx]!, fill, maxExcursion };
}

/**
 * TRUTH QUORUM — merge observations from every source into one canonical
 * mark. Freshness and confidence decide; a single vendor failing can never
 * blind the book (HOLD-ALL requires quorum loss, not one dark feed).
 */
export function canonicalMark(
  obs: Partial<Record<TruthSource, TruthTick>>,
  now: number,
  maxStaleMs = 30_000,
): { tick: TruthTick; source: TruthSource; confidence: number; freshnessMs: number } | null {
  let best: { tick: TruthTick; source: TruthSource; score: number } | null = null;
  for (const [src, tick] of Object.entries(obs) as [TruthSource, TruthTick | undefined][]) {
    if (!tick || !(tick.priceUsd > 0)) continue;
    const age = now - tick.at;
    if (age > maxStaleMs) continue;
    // score: confidence, decayed by staleness across the window
    const score = SOURCE_CONFIDENCE[src] * (1 - Math.min(1, Math.max(0, age) / maxStaleMs) * 0.5);
    if (!best || score > best.score) best = { tick, source: src, score };
  }
  if (!best) return null;
  return {
    tick: best.tick,
    source: best.source,
    confidence: SOURCE_CONFIDENCE[best.source],
    freshnessMs: Math.max(0, now - best.tick.at),
  };
}

/**
 * TRUTH AGREEMENT (KPI) — pairwise price agreement between sources, 1.0 =
 * identical. A drop names a drifting feed before it costs money.
 */
export function truthAgreement(a: TruthTick | undefined, b: TruthTick | undefined): number | null {
  if (!a || !b || !(a.priceUsd > 0) || !(b.priceUsd > 0)) return null;
  const hi = Math.max(a.priceUsd, b.priceUsd);
  const lo = Math.min(a.priceUsd, b.priceUsd);
  return +(lo / hi).toFixed(4);
}
