import type { ManagementCall } from "./classifier.js";

/**
 * TRADE DNA — the live per-trade health readout (docs/trade-dna-health.md). Fuses the
 * classifier verdict with the MOONSHOT CLOCK — the missing strand: a trade past the
 * ~1000s productive window that is NOT a proven runner is off-genome, so it tilts to
 * DECAY and its health discounts no matter how lukewarm-green the score. This is the fix
 * for holding a trade 27m when a moonshot's productive life is ~1000s. Proven runners
 * (>=3x, near highs) are exempt — never cap a moonshot.
 */
export type DnaState = "IGNITION" | "RIDE" | "PEAKING" | "DECAY" | "DEAD" | "STILLBORN";

// Genome-calibrated clock constants (from project_hermes_moonshot_anatomy). Promotable to config.
export const MOONSHOT_HORIZON_SEC = 1000; // productive window; past this a non-runner is off-genome
export const CLOCK_DECAY_START_SEC = 900; // winner median peak ~888s — health decays after here
export const PROVEN_RUNNER_MULT = 3.0; // >=3x AND near highs = exempt from the clock
const CLOCK_HEALTH_FLOOR = 0.4;

// STILLBORN — the DUD signature (measured 2026-07-19). A trade that hasn't lifted past
// STILLBORN_MAX_LIFT by STILLBORN_AGE_SEC is a dud with ~100% reliability (269/270; 1 winner).
// NOTE: it is a size/selection signal, NOT a cut — the sweep proved the pool has usually
// drained by the time the no-lift is confirmed (unsellable), so ~90% of the loss is locked in
// regardless of exit timing. The label flags it live and the sizer keys off it.
export const STILLBORN_AGE_SEC = 120; // 2min — where the signal is clean (0.4% false-cut)
export const STILLBORN_MAX_LIFT = 1.03; // never cleared +3% off entry = never followed through

export interface TradeDna {
  state: DnaState;
  healthScore: number; // 0..100 — continuation score modulated by the moonshot clock
  clockPct: number; // ageSec / horizon (0..1+): fraction of the productive window elapsed
  pastPrime: boolean; // past the clock AND not a proven runner
  provenRunner: boolean;
  stillborn: boolean; // confirmed no-lift dud — never followed through (size/selection signal)
}

const REGIME_TO_STATE: Record<string, DnaState> = {
  IGNITION: "IGNITION",
  RUNNER: "RIDE",
  BLOWOFF: "PEAKING",
  STALL: "DECAY",
  FADE: "DEAD",
  WATCH: "IGNITION",
};
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function tradeDna(call: ManagementCall, ageMinutes: number, markMultiple: number, peakMultiple: number): TradeDna {
  const ageSec = Math.max(0, ageMinutes * 60);
  const clockPct = ageSec / MOONSHOT_HORIZON_SEC;
  const provenRunner = peakMultiple >= PROVEN_RUNNER_MULT && markMultiple >= peakMultiple * 0.9;
  const pastPrime = clockPct >= 1 && !provenRunner;
  let state = REGIME_TO_STATE[call.regime] ?? "IGNITION";
  // clock override: past prime without a runner → DECAY (unless already PEAKING/DEAD).
  if (pastPrime && (state === "IGNITION" || state === "RIDE")) state = "DECAY";
  // STILLBORN override — the confirmed no-lift dud. Overrides the (saturated) classifier read:
  // never cleared the lift threshold by the confirm age = a non-starter (~100% dud in the data).
  const stillborn = ageSec >= STILLBORN_AGE_SEC && peakMultiple <= STILLBORN_MAX_LIFT;
  if (stillborn) state = "STILLBORN";
  // clock health: 1.0 until decay start, then linear to the floor at/after the horizon; runner exempt.
  const clockHealth = provenRunner
    ? 1
    : clamp(
        1 - (Math.max(0, ageSec - CLOCK_DECAY_START_SEC) / (MOONSHOT_HORIZON_SEC - CLOCK_DECAY_START_SEC)) * (1 - CLOCK_HEALTH_FLOOR),
        CLOCK_HEALTH_FLOOR,
        1,
      );
  const healthScore = stillborn ? 5 : Math.round(clamp(call.continuationScore * clockHealth, 0, 100));
  return { state, healthScore, clockPct, pastPrime, provenRunner, stillborn };
}

/**
 * HARVEST CLOCK — the book-level aggregate: the average moonshot-clock across every open
 * trade at this moment. Low = a young book still developing; high = the book as a whole is
 * maturing past prime → the portfolio-level "time to harvest" gauge that sits above the
 * per-trade chips.
 */
export interface HarvestClockView {
  n: number;
  avgClockPct: number; // the harvest clock — book-average of per-trade clockPct
  avgAgeSec: number;
  pastPrime: number; // count of open trades already past prime
}
export function harvestClock(clocks: { clockPct: number; pastPrime: boolean }[]): HarvestClockView {
  const n = clocks.length;
  if (n === 0) return { n: 0, avgClockPct: 0, avgAgeSec: 0, pastPrime: 0 };
  const avgClockPct = clocks.reduce((s, c) => s + c.clockPct, 0) / n;
  return { n, avgClockPct, avgAgeSec: avgClockPct * MOONSHOT_HORIZON_SEC, pastPrime: clocks.filter((c) => c.pastPrime).length };
}
