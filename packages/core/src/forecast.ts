// Monte Carlo equity forecast.
//
// The one honest choice here is WHAT distribution to bootstrap from. We use the
// empirical per-trade return r = final_multiple / trigger_multiple − 1 over the
// recorder's closed, *triggered* candidates — i.e. each trade modeled as exiting
// at the recorder's 15-minute window close. That is the ZERO-PARAMETER null
// hypothesis: entry on the confirmation gate, NO trailing skill. It is temporally
// valid (window-close is always after the trigger, unlike the window peak, which
// can predate entry) and its tails are correct by construction (a rug → final≈0 →
// r≈−1). It deliberately UNDERSTATES the live system, because the whole thesis is
// that the ratcheting trail beats window-end final. As run 1g closes real trades,
// plot realized-per-trade against this baseline: if realized drifts above it, the
// exit logic is the edge. Do not add a "capture fraction" knob to make the fan
// point up — that manufactures the very result the baseline exists to test.
//
// This module is pure (numbers in, numbers out). The DB pulls live in the
// dashboard query layer.

export interface ForecastOptions {
  startEquity: number;
  /** Trades opened per hour. Bankroll/concurrency-bound, NOT the raw trigger
   *  supply. Unknown until live opens accumulate → surfaced as an assumption. */
  tradesPerHour: number;
  horizonHours: number;
  /** Average dollars deployed per position (risk-tier blended). */
  avgSizeUsd: number;
  nPaths?: number;
  bucketHours?: number;
  /** Circuit-breaker mirror: halt a path at this drawdown-from-peak (%). */
  breakerDrawdownPct?: number;
  /** Circuit-breaker mirror: halt a path at this cumulative loss ($). */
  dailyLossCapUsd?: number;
  /** Fixed seed so the fan is stable across renders (less jarring than a fan
   *  that reshuffles every page load). */
  seed?: number;
}

export interface ForecastBucket {
  tHours: number;
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
}

export interface ForecastResult {
  buckets: ForecastBucket[];
  startEquity: number;
  medianEnd: number;
  pProfit: number; // share of paths ending above start
  pBreaker: number; // share of paths that trip the breaker
  sampleN: number;
  /** Everything a reader needs to judge the fan — none of it buried. */
  assumptions: {
    tradesPerHour: number;
    horizonHours: number;
    avgSizeUsd: number;
    nPaths: number;
    breakerDrawdownPct: number;
    dailyLossCapUsd: number;
  };
}

// Small deterministic PRNG (mulberry32) — reproducible fan without a dependency.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Knuth's algorithm for a Poisson draw (trade counts per bucket). Fine for the
// small lambdas here (a few trades per bucket).
function poisson(lambda: number, rng: () => number): number {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > L);
  return k - 1;
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

/**
 * Bootstrap equity paths from an empirical per-trade return sample.
 * `returns` are fractional returns on cost (e.g. +0.13 = +13%, −1 = total loss).
 */
export function runForecast(returns: number[], opts: ForecastOptions): ForecastResult {
  const nPaths = opts.nPaths ?? 1000;
  const bucketHours = opts.bucketHours ?? 0.5;
  const breakerDD = opts.breakerDrawdownPct ?? 15;
  const dailyLossCap = opts.dailyLossCapUsd ?? 150;
  const nBuckets = Math.max(1, Math.round(opts.horizonHours / bucketHours));
  const rng = mulberry32(opts.seed ?? 0x9e3779b9);

  // If we have no sample, return a flat fan at start (the UI degrades on this).
  if (returns.length === 0) {
    const flat = Array.from({ length: nBuckets + 1 }, (_, i) => ({
      tHours: i * bucketHours,
      p5: opts.startEquity,
      p25: opts.startEquity,
      p50: opts.startEquity,
      p75: opts.startEquity,
      p95: opts.startEquity,
    }));
    return {
      buckets: flat,
      startEquity: opts.startEquity,
      medianEnd: opts.startEquity,
      pProfit: 0,
      pBreaker: 0,
      sampleN: 0,
      assumptions: {
        tradesPerHour: opts.tradesPerHour,
        horizonHours: opts.horizonHours,
        avgSizeUsd: opts.avgSizeUsd,
        nPaths,
        breakerDrawdownPct: breakerDD,
        dailyLossCapUsd: dailyLossCap,
      },
    };
  }

  // equityByBucket[b] = array of path equities at bucket boundary b (0..nBuckets)
  const equityByBucket: number[][] = Array.from({ length: nBuckets + 1 }, () => []);
  let breakerTrips = 0;

  for (let path = 0; path < nPaths; path++) {
    let equity = opts.startEquity;
    let peak = Math.max(opts.startEquity, 1000); // breaker peak floor = bankroll
    let halted = false;
    equityByBucket[0]!.push(equity);

    for (let b = 1; b <= nBuckets; b++) {
      if (!halted) {
        const nTrades = poisson(opts.tradesPerHour * bucketHours, rng);
        for (let t = 0; t < nTrades; t++) {
          const r = returns[Math.floor(rng() * returns.length)]!;
          equity += r * opts.avgSizeUsd;
          if (equity > peak) peak = equity;
          const ddHit = (peak - equity) / peak >= breakerDD / 100;
          const lossHit = opts.startEquity - equity >= dailyLossCap;
          if (ddHit || lossHit) {
            halted = true;
            breakerTrips++;
            break;
          }
        }
      }
      equityByBucket[b]!.push(equity);
    }
  }

  const buckets: ForecastBucket[] = equityByBucket.map((arr, b) => {
    const sorted = [...arr].sort((x, y) => x - y);
    return {
      tHours: b * bucketHours,
      p5: percentile(sorted, 0.05),
      p25: percentile(sorted, 0.25),
      p50: percentile(sorted, 0.5),
      p75: percentile(sorted, 0.75),
      p95: percentile(sorted, 0.95),
    };
  });

  const ends = equityByBucket[nBuckets]!;
  const medianEnd = buckets[nBuckets]!.p50;
  const pProfit = ends.filter((e) => e > opts.startEquity).length / ends.length;

  return {
    buckets,
    startEquity: opts.startEquity,
    medianEnd,
    pProfit,
    pBreaker: breakerTrips / nPaths,
    sampleN: returns.length,
    assumptions: {
      tradesPerHour: opts.tradesPerHour,
      horizonHours: opts.horizonHours,
      avgSizeUsd: opts.avgSizeUsd,
      nPaths,
      breakerDrawdownPct: breakerDD,
      dailyLossCapUsd: dailyLossCap,
    },
  };
}
