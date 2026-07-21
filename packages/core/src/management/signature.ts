/**
 * TRADE SIGNATURES — one genome per class.
 *
 * The system ran one entry rule and one exit profile against five populations
 * that behave nothing alike. Measured 2026-07-15→21 over 15.5k candidates,
 * leak-free (every observable read at or before the qualifying tick, every
 * outcome scored strictly after it), with costs modelled:
 *
 *   class          holdout EV   win%   evidence
 *   RISER            1.349       86    CONFIRMED — 8/8 plateau, improves OOS
 *   BASE             1.180       57    CONFIRMED — 8/8 plateau
 *   CLIMBER          0.952       38    sample-limited (n=36/40)
 *   MOON_FAST          —          —    sample-limited (n=17/45) but rugs 11.6%
 *   MOON_STEADY      0.855       30    sample-limited (n=38/96)
 *   MOON_SLOW        0.863       44    sample-limited (n=25/63)
 *   MOON_VIOLENT       —          —    sample-limited (n=4/10)
 *
 * The moon grades are SAMPLE-LIMITED, not disproven: their population statistics
 * are strong (MOON_FAST rugs 11.6%, less than RISER's 12.7%, with a 6.90× p90)
 * but no tradeable configuration confirms on 6 days of tape. They are traded at
 * reduced size so the sample accumulates under real conditions — 17-per-side only
 * becomes 200-per-side by trading it, and the harness re-runs against the same
 * split whenever we want to re-check.
 */

export type Signature =
  | "RISER"
  | "BASE"
  | "CLIMBER"
  | "MOON_FAST"
  | "MOON_STEADY"
  | "MOON_SLOW"
  | "MOON_VIOLENT"
  | "RUG_RISK";

/** Everything the router needs, all known at the qualifying tick. */
export interface SignatureInputs {
  /** Liquidity at the first trusted read. */
  liq0: number;
  /** Liquidity now. */
  liqNow: number;
  /** buys ÷ (buys+sells) over 5m, 0..1. */
  buyShare: number;
  /** 1 − trough ÷ pre-dip high: the FALSE STEP. */
  dipDepth: number;
  /** Percent recovered off the trough PER MINUTE: the tell's velocity. */
  snapRate: number;
}

export interface SignatureProfile {
  /** Whether real capital may be committed. */
  trade: boolean;
  /** Rise off the trough required to confirm — the pullback tell, per class. */
  minSnap: number;
  /** Hard floor as a fraction of entry — the COVER. */
  floor: number;
  /** Trail width as a fraction off the running peak. */
  trail: number;
  /** First take-profit: [entry-relative multiple, fraction of position]. */
  tp1: [number, number];
  /** Second take-profit. */
  tp2: [number, number];
  /** Seconds after entry to close the remainder; 0 = no time exit. */
  holdSec: number;
  /** Size multiplier vs the standard position. */
  size: number;
  /** One line, for the ledger and the Trade Matrix. */
  note: string;
}

// Thresholds. Speed grades the moon on an INVERTED U — faster is not better.
const VIOLENT_RATE = 4.0; // 400%/min — snaps back from a 58% median dip, rugs 58.2%
const FAST_RATE = 1.5; // 150%/min — the strong moon: rugs 11.6%, p90 6.90×
const STEADY_RATE = 0.5; // 50%/min
const DEEP_POOL = 30_000; // ≥ this at discovery rugs 32.6% and NEVER reaches 5×
const THIN_POOL = 5_000; // < this is the real moon tell (14.0% reach 5×)
const CLIMBER_GROWTH = 1.5; // +50% pool by the tick: 0.8% rug vs a 20% baseline

export const SIGNATURE_PROFILES: Record<Signature, SignatureProfile> = {
  // ── confirmed on both sides of the split ──
  RISER: {
    trade: true, minSnap: 0.15, floor: 0.4, trail: 0.45,
    tp1: [1.55, 0.25], tp2: [2.3, 0.2], holdSec: 0, size: 1.0,
    note: "steady accumulation, high buy pressure — the microwin engine (86% win)",
  },
  BASE: {
    trade: true, minSnap: 0.2, floor: 0.7, trail: 0.45,
    tp1: [1.55, 0.25], tp2: [2.3, 0.2], holdSec: 0, size: 1.0,
    note: "unclassified mover with pool support (57% win)",
  },
  // ── sample-limited: traded small to accumulate evidence ──
  CLIMBER: {
    trade: true, minSnap: 0.2, floor: 0.4, trail: 0.25,
    tp1: [1.55, 0.25], tp2: [2.3, 0.3], holdSec: 150, size: 0.6,
    note: "accumulation into a deep book — 1.6% rug, best risk-adjusted class",
  },
  MOON_FAST: {
    trade: true, minSnap: 0.35, floor: 0.4, trail: 0.45,
    tp1: [1.55, 0.25], tp2: [2.3, 0.2], holdSec: 240, size: 0.8,
    note: "thin pool, 150-400%/min recovery — rugs 11.6%, p90 6.90×",
  },
  MOON_STEADY: {
    trade: true, minSnap: 0.35, floor: 0.7, trail: 0.35,
    tp1: [1.55, 0.25], tp2: [2.3, 0.2], holdSec: 240, size: 0.6,
    note: "50-150%/min recovery — 13.3% reach 5×",
  },
  MOON_SLOW: {
    trade: true, minSnap: 0.35, floor: 0.4, trail: 0.45,
    tp1: [1.55, 0.25], tp2: [2.3, 0.2], holdSec: 240, size: 0.4,
    note: "<50%/min recovery — weakest moon grade (2.1% reach 5×)",
  },
  MOON_VIOLENT: {
    // Banks early and hard: a 58% rug rate has to be paid for by the first
    // tranche, but 4.5% of these still reach 5×, so a runner stays alive.
    trade: true, minSnap: 0.35, floor: 0.52, trail: 0.4,
    tp1: [1.4, 0.4], tp2: [2.3, 0.2], holdSec: 120, size: 0.3,
    note: "400%+/min snap off a deep dip — 58% rug, kept small for the 4.5% tail",
  },
  // ── refused ──
  RUG_RISK: {
    trade: false, minSnap: 0, floor: 0, trail: 0,
    tp1: [0, 0], tp2: [0, 0], holdSec: 0, size: 0,
    note: "draining pool or ≥$30k at discovery — 36.1% rug, 0.0% reach 5×",
  },
};

/**
 * Route a candidate to its signature. Priority-ordered, first match wins.
 *
 * CLIMBER requires growth AND depth: pool growth alone conflates accumulation
 * into a real book with ignition in a thin one, because on a $1.7k pool a few
 * thousand dollars of inflow is +50% trivially — an unqualified growth test
 * swallows exactly the thin-pool fast igniters that are the strongest moons.
 */
export function routeSignature(i: SignatureInputs): Signature {
  const growth = i.liq0 > 0 ? i.liqNow / i.liq0 : 1;
  if (growth < 1.0 || i.liq0 >= DEEP_POOL) return "RUG_RISK";
  if (growth >= CLIMBER_GROWTH && i.liq0 >= THIN_POOL) return "CLIMBER";
  if (i.liq0 < THIN_POOL || i.buyShare < 0.5 || i.dipDepth >= 0.25) {
    if (i.snapRate >= VIOLENT_RATE) return "MOON_VIOLENT";
    if (i.snapRate >= FAST_RATE) return "MOON_FAST";
    if (i.snapRate >= STEADY_RATE) return "MOON_STEADY";
    return "MOON_SLOW";
  }
  if (i.buyShare >= 0.8) return "RISER";
  return "BASE";
}

export const profileOf = (s: Signature): SignatureProfile => SIGNATURE_PROFILES[s];
export const isMoon = (s: Signature): boolean => s.startsWith("MOON");

/**
 * The exit knobs a signature overrides, shaped so a caller can spread them over
 * the loaded config: `{...cfg, ...signatureExitOverrides(sig)}`. Everything the
 * signature does NOT specify keeps the global value, so this is additive.
 */
/**
 * A profile promoted by the learning loop, as stored in the `signature_profiles`
 * config row. Shape matches the loop's sweep grid; `hold` is in MINUTES.
 */
export interface LearnedProfile {
  r1: number; f1: number; r2: number; f2: number; trail: number; floor: number; hold: number;
}

/** Fold a learned profile over the compiled default. Unknown keys are ignored. */
export function withLearned(s: Signature, learned: LearnedProfile | null | undefined): SignatureProfile {
  const base = SIGNATURE_PROFILES[s];
  if (!learned || typeof learned.trail !== "number") return base;
  return {
    ...base,
    tp1: [learned.r1, learned.f1],
    tp2: [learned.r2, learned.f2],
    trail: learned.trail,
    floor: learned.floor,
    // The loop's grid has no "never" option — a horizon is always named — so a
    // hold at or beyond the observable ceiling means "no early time exit".
    holdSec: learned.hold >= 999 ? 0 : Math.round(learned.hold * 60),
  };
}

export function signatureExitOverrides(s: Signature, learned?: LearnedProfile | null): {
  TP0_MULT: number; TP0_CUM_SELL: number;
  TP1_MULT: number; TP1_CUM_SELL: number;
  TP2_MULT: number; TP2_CUM_SELL: number;
  TRAIL_TIGHT_PCT: number; TRAIL_MID_PCT: number; TRAIL_WIDE_PCT: number;
  HARD_STOP_PCT: number; RUNNER_MAX_HOLD_SEC: number;
  TIME_FLOOR_AT_SEC: number; FAST_FLOOR_ENABLED: boolean;
  PROFIT_LOCK_ARM_MULT: number; PROFIT_FLOOR_USD: number;
  POST_BANK_TRAIL_PCT: number;
} {
  const p = withLearned(s, learned);
  const cum1 = p.tp1[1];
  const cum2 = cum1 + p.tp2[1];
  const trailPct = Math.round(p.trail * 100);
  return {
    // The ladder collapses to two real rungs; TP0 is folded onto TP1 so the
    // measured "bank late" shape survives (the optimizer chose 1.55×, not 1.15×,
    // in every confirmed configuration — selling under the median outcome was
    // costing more than it protected).
    TP0_MULT: p.tp1[0], TP0_CUM_SELL: cum1,
    TP1_MULT: p.tp1[0], TP1_CUM_SELL: cum1,
    TP2_MULT: p.tp2[0], TP2_CUM_SELL: cum2,
    // One width: the measured give-back a winner takes BEFORE its real high is
    // what the trail must survive, and it does not vary by how far the trade has
    // already run — it varies by CLASS.
    TRAIL_TIGHT_PCT: trailPct, TRAIL_MID_PCT: trailPct, TRAIL_WIDE_PCT: trailPct,
    HARD_STOP_PCT: Math.round((1 - p.floor) * 100),
    RUNNER_MAX_HOLD_SEC: p.holdSec,
    // ── THE GENOME IS THE SOLE AUTHORITY ──────────────────────────────────────
    // Every global floor is disabled for a routed position. These were built for
    // a world where one profile served every trade; now each class carries its
    // own cover, and a second, tighter rule layered on top does not add safety —
    // it overrides the class's identity with a decision it never asked for.
    //
    // Measured live 2026-07-21, London: three consecutive closes were decided by
    // TIME_FLOOR before the signature's cover was ever consulted. RISER, whose
    // learned cover is 0.40× (built to hold a −60% dip), was cut at −24%; BASE,
    // cover 0.70×, was cut at −25%. The genome never got to make the call.
    //
    // It also keeps the LEARNING LOOP honest, which matters more. The loop's
    // simulator models exactly four mechanisms — cover, trail, ladder, horizon.
    // Anything else firing in production means we optimise one policy and run a
    // different one, and every future generation inherits that distortion.
    // A position with no signature keeps all of these; only routed trades are
    // governed purely by their own fingerprint.
    TIME_FLOOR_AT_SEC: 0, // breakeven-at-90s cut — the cover owns the downside
    FAST_FLOOR_ENABLED: false, // sub-tick floor sweep — not in the fitted model
    PROFIT_LOCK_ARM_MULT: Number.POSITIVE_INFINITY, // never-close-red ratchet: the trail owns give-back
    PROFIT_FLOOR_USD: Number.POSITIVE_INFINITY, // dollar-profit arm for the same ratchet
    POST_BANK_TRAIL_PCT: trailPct, // post-bank snug would re-tighten the class's own trail
  };
}
