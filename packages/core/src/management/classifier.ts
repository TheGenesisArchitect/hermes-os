/**
 * Management-time "ride vs cut" classifier — a transparent quant factor model.
 *
 * The lesson from run 1c: at ENTRY, winners and losers are indistinguishable
 * (score ~47, ~1 min old, 100% buys, all of them). They only diverge over the
 * next few minutes — the one 327x runner kept printing new highs on real buy
 * flow while the 1.5x wigglers rolled over and died. So the tractable edge is
 * not entry selection (a speed war against snipers we lose) but POSITION
 * MANAGEMENT: ride confirmed continuation, bank convex spikes before they
 * round-trip, cut wigglers fast.
 *
 * This is a *factor model*, not a trained ML model, and deliberately so: with a
 * single winner in the sample, any learned model would be fiction. Each factor
 * is an explicit, human-readable microstructure feature contributing signed
 * points to a continuation score; the regime + action fall out of that score
 * and a few shape rules. The WEIGHTS below are calibration priors — the schema
 * persists every call so run 1d+ trajectories can later fit real weights
 * (logistic / gradient-boosted) without changing this interface.
 */

/** One management observation of an open position. Most-recent-last in a series. */
export interface Tick {
  markMultiple: number; // price / entry
  drawdownFromPeakPct: number; // (peak - price) / peak * 100, >= 0
  buyShareM5: number; // buys / (buys + sells) over 5m, 0..1
  volM5: number;
  volH1: number;
  priceChangeM5Pct: number; // DexScreener 5m price change %
  ageMinutes: number;
}

export interface ManagementFeature {
  key: string;
  label: string;
  /** Raw feature value, for display. */
  value: number;
  /** Signed points this factor pushed onto the continuation score. */
  contribution: number;
  note: string;
}

export type Regime = "IGNITION" | "RUNNER" | "BLOWOFF" | "STALL" | "FADE" | "WATCH";
export type Action = "RIDE" | "TRIM" | "CUT" | "HOLD";

export interface ManagementCall {
  regime: Regime;
  action: Action;
  /** 0..100, probability-like lean toward continued upside. */
  continuationScore: number;
  reason: string;
  features: ManagementFeature[];
  /** Ticks since the position last printed a new high — staleness. */
  ticksSinceNewHigh: number;
}

/** Calibration priors. Tunable knobs, later fittable from labeled trajectories. */
export interface ClassifierConfig {
  blowoffMult: number; // mark multiple that arms blow-off (bank convex gains)
  blowoffMomFadePct: number; // 5m momentum at/below this while high = exhaustion
  blowoffMaxDrawdownPct: number; // must still be near peak to TRIM vs already-CUT
  runnerMult: number; // mark multiple above which a strong score = RUNNER
  ignitionAgeMin: number; // young enough that a strong score = IGNITION
  stallDrawdownPct: number; // off-peak enough to consider stalled
  rideScore: number; // continuation score at/above which we ride
  cutScore: number; // continuation score at/below which we lean cut
}

export const DEFAULT_CLASSIFIER: ClassifierConfig = {
  blowoffMult: 8,
  blowoffMomFadePct: 0,
  blowoffMaxDrawdownPct: 20,
  runnerMult: 3,
  ignitionAgeMin: 8,
  stallDrawdownPct: 22,
  rideScore: 62,
  cutScore: 42,
};

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Ticks since the series last made a new peak markMultiple. */
function ticksSinceNewHigh(series: Tick[]): number {
  let best = -Infinity;
  let bestIdx = 0;
  series.forEach((t, i) => {
    if (t.markMultiple >= best) {
      best = t.markMultiple;
      bestIdx = i;
    }
  });
  return series.length - 1 - bestIdx;
}

/**
 * Classify an open position's trajectory into a ride/cut call.
 * `series` is chronological (most recent last); a single tick is valid but
 * yields lower-confidence, momentum-only calls.
 */
export function classify(series: Tick[], cfg: ClassifierConfig = DEFAULT_CLASSIFIER): ManagementCall {
  const last = series[series.length - 1];
  if (!last) {
    return {
      regime: "WATCH",
      action: "HOLD",
      continuationScore: 50,
      reason: "no observations yet",
      features: [],
      ticksSinceNewHigh: 0,
    };
  }

  const stale = ticksSinceNewHigh(series);
  const volPace = last.volH1 > 0 ? (last.volM5 * 12) / last.volH1 : 1; // m5 annualized vs h1

  const features: ManagementFeature[] = [];
  const push = (key: string, label: string, value: number, contribution: number, note: string) =>
    features.push({ key, label, value, contribution: Math.round(contribution * 10) / 10, note });

  // 1. New-high recency — a runner keeps printing highs; a wiggler goes cold.
  const recency = clamp(20 - 9 * stale, -25, 20);
  push(
    "recency",
    "New-high recency",
    stale,
    recency,
    stale === 0 ? "printing new highs" : `${stale} tick(s) since last high`,
  );

  // 2. Momentum — DexScreener 5m price change.
  const momentum = clamp(last.priceChangeM5Pct * 0.5, -25, 25);
  push("momentum", "5m momentum", last.priceChangeM5Pct, momentum, `${last.priceChangeM5Pct.toFixed(0)}% / 5m`);

  // 3. Drawdown from peak — the "rolling over" signal.
  const drawdown = -clamp(last.drawdownFromPeakPct, 0, 60) * 0.5;
  push("drawdown", "Drawdown from peak", last.drawdownFromPeakPct, drawdown, `${last.drawdownFromPeakPct.toFixed(0)}% off peak`);

  // 4. Order flow — buy share; distribution starts when buys fade.
  const flow = clamp((last.buyShareM5 - 0.5) * 60, -30, 30);
  push("flow", "Buy pressure", last.buyShareM5, flow, `${(last.buyShareM5 * 100).toFixed(0)}% buys (5m)`);

  // 5. Volume trend — fresh volume is the fuel; collapse kills continuation.
  const volTrend = clamp((volPace - 1) * 18, -20, 20);
  push("volume", "Volume trend", volPace, volTrend, volPace >= 1 ? "5m pace accelerating" : "5m pace fading");

  // 6. Survival — being underwater is a distinct danger from being off-peak.
  const survival = last.markMultiple < 1 ? -clamp((1 - last.markMultiple) * 40, 0, 30) : 0;
  if (survival !== 0) push("survival", "Below entry", last.markMultiple, survival, "underwater");

  const continuationScore = Math.round(
    clamp(50 + features.reduce((s, f) => s + f.contribution, 0), 0, 100),
  );

  // --- regime + action from the score and a few shape rules (order matters) ---
  const mm = last.markMultiple;
  const dd = last.drawdownFromPeakPct;
  let regime: Regime;
  let action: Action;
  let reason: string;

  if (mm >= cfg.blowoffMult && dd <= cfg.blowoffMaxDrawdownPct && (last.priceChangeM5Pct <= cfg.blowoffMomFadePct || last.buyShareM5 < 0.5)) {
    regime = "BLOWOFF";
    action = "TRIM";
    reason = `${mm.toFixed(0)}x with momentum stalling near the peak — bank the convex gain before it round-trips`;
  } else if (mm < 1 && volPace < 0.6 && continuationScore <= cfg.cutScore) {
    regime = "FADE";
    action = "CUT";
    reason = "below entry with volume drying up — dead money, recycle the capital";
  } else if (dd >= cfg.stallDrawdownPct && continuationScore <= cfg.cutScore) {
    regime = "STALL";
    action = "CUT";
    reason = `rolled ${dd.toFixed(0)}% off peak and gone cold — the classic wiggler fade`;
  } else if (continuationScore >= cfg.rideScore && mm >= cfg.runnerMult) {
    regime = "RUNNER";
    action = "RIDE";
    reason = `sustained higher-highs at ${mm.toFixed(1)}x on real buy flow — let it run`;
  } else if (continuationScore >= cfg.rideScore && last.ageMinutes <= cfg.ignitionAgeMin) {
    regime = "IGNITION";
    action = "RIDE";
    reason = "young and climbing on strong flow — the first leg, give it room";
  } else {
    regime = "WATCH";
    action = "HOLD";
    reason = "no decisive continuation or breakdown signal yet — hold and watch";
  }

  return { regime, action, continuationScore, reason, features, ticksSinceNewHigh: stale };
}

/** Build a Tick from a market snapshot + position marks. Shared by trader & replay. */
export function tickFrom(input: {
  priceUsd: number;
  entryPriceUsd: number;
  peakPriceUsd: number;
  buysM5: number;
  sellsM5: number;
  volM5: number;
  volH1: number;
  priceChangeM5Pct: number;
  ageMinutes: number;
}): Tick & { markMultiple: number; peakMultiple: number } {
  const markMultiple = input.priceUsd / input.entryPriceUsd;
  const peakMultiple = input.peakPriceUsd / input.entryPriceUsd;
  const drawdownFromPeakPct =
    input.peakPriceUsd > 0 ? Math.max(0, ((input.peakPriceUsd - input.priceUsd) / input.peakPriceUsd) * 100) : 0;
  const flow = input.buysM5 + input.sellsM5;
  return {
    markMultiple,
    peakMultiple,
    drawdownFromPeakPct,
    buyShareM5: flow > 0 ? input.buysM5 / flow : 0.5,
    volM5: input.volM5,
    volH1: input.volH1,
    priceChangeM5Pct: input.priceChangeM5Pct,
    ageMinutes: input.ageMinutes,
  };
}
