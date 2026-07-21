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
  /**
   * HOLDER DISPERSION at discovery — the cleanest class separator measured, and
   * available before a single tick of trajectory exists. Median largest-holder
   * share by outcome class over 17,872 labeled candidates:
   *     MOON 5.26%   RISER 4.63%   RUG 35.3%   DUD 51.2%   CLIMBER 78.0%
   * A 10-15× separation on one number. Dispersed ownership is what MOON and
   * RISER — the two classes that actually pay — have in common, and it is the
   * thing that distinguishes CLIMBER (a concentrated-whale accumulation) from
   * MOON despite both showing pool growth. Null when the check is missing;
   * routing then falls back to trajectory alone.
   */
  largestHolderPct?: number | null;
  /** Top-10 concentration: MOON 16.9% / RISER 14.8% vs DUD 81.1% / CLIMBER 81.0%. */
  top10Pct?: number | null;
  /** Holder count: MOON 91 / RISER 60 vs DUD 9 / CLIMBER 14 / RUG 16. */
  holders?: number | null;
  /**
   * WALLET-GRAPH EDGE at arm time. Holder wallets persist across one-shot
   * tokens, so a book already held by wallets that backed previous winners is a
   * genuinely independent signal from anything in the price or the pool —
   * measured at a 2.2× winner lift and validated leak-free.
   */
  walletEdge?: number | null;
  /** Count of sampled holders with winner reputation. */
  walletWinnerHits?: number | null;
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
  /**
   * THREE PROGRESSIVE RUNGS, placed on the class's OWN run distribution at
   * roughly p50 → p75 → p90. A trade does not simply rise and hold: it wanders,
   * spikes and gives back, so profit is swept along the path rather than staked
   * on one late rung. The prior two-rung shape banked 10% at 2.10× and left 90%
   * riding, which only pays when a position goes straight up.
   */
  tp0: [number, number];
  tp1: [number, number];
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
// Ownership thresholds, set between the measured class medians rather than at a
// round number: MOON 5.26% / RISER 4.63% largest holder against RUG 35.3%,
// DUD 51.2%, CLIMBER 78.0%. The gap is wide enough that the exact cut matters
// little — anything from ~10% to ~25% separates the same way.
const DISPERSED_LARGEST_PCT = 12; // ≤ this = crowd-held (moon/riser territory)
const DISPERSED_TOP10_PCT = 35; // MOON 16.9 / RISER 14.8 vs DUD 81.1 / CLIMBER 81.0
const CONCENTRATED_LARGEST_PCT = 30; // ≥ this = whale-held (climber/dud/rug)

/** Grade a moon by the velocity of its recovery — an inverted U, not "faster is better". */
function moonGrade(snapRate: number): Signature {
  if (snapRate >= VIOLENT_RATE) return "MOON_VIOLENT";
  if (snapRate >= FAST_RATE) return "MOON_FAST";
  if (snapRate >= STEADY_RATE) return "MOON_STEADY";
  return "MOON_SLOW";
}

// THE CLOCK, set at P75 of the labeled time-to-peak. Measured over 17,872
// candidates, time-to-peak p75 is ~15.2m from discovery for every winner class;
// entry lands in the 2-3m window, so the hold is ~12.7m ≈ 760s — inside the
// Trade Matrix's existing 1000s moonshot horizon, so the clock and the Matrix
// finally agree instead of contradicting each other.
//
// It is deliberately NOT the median. Fitting a clock to the middle of a class
// whose value lives in the tail truncates exactly the outcomes we want, which is
// the same error as the 5% trail in the time dimension. Note also that 56% of
// RISERs and 47% of CLIMBERs are still rising when the 15m watch window closes,
// so their true peaks are right-censored — p75 is a floor on the right answer,
// not a precise one, and it should be revisited if the window is ever widened.
// 762s = the measured P75 hold (p75 time-to-peak 15.2m from discovery, less a
// ~2.5m entry). Previously 1000s to match the Trade Matrix's horizon — but that
// was rounding UP past the data, and worse, 1000s sits beyond the 15-minute
// watch window so the learning loop cannot validate it at all. A clock the loop
// can never test is a clock we can never improve.
const CLOCK_SEC = 762;
// Rugs are the one class our window fully captures (0.8% censored): they peak at
// 4.6m and are done by 12.2m at p90. A class that snaps violently off a deep dip
// lives on that timeline, not the winners'.
const FAST_CLOCK_SEC = 420;

export const SIGNATURE_PROFILES: Record<Signature, SignatureProfile> = {
  // ── confirmed on both sides of the split ──
  // Rungs sit on each class's OWN measured run distribution — p50 / p75 / p90 —
  // so profit is swept along the path and a 30% runner still carries the tail.
  RISER: {
    trade: true, minSnap: 0.15, floor: 0.4, trail: 0.45,
    // SWEEP RUNG 1.50 → 1.22 (2026-07-21). The rung must sit INSIDE the
    // population's median outcome or the common trade banks nothing. For
    // dispersed tokens the median run is 1.25× and only 23.8% ever reach 1.5×,
    // so a rung at 1.50 refused to take a cent on three quarters of the class.
    // Live cost tonight: Apple 1.35×, Amazon 1.43×, ACT:S 1.43× and Tim 1.17×
    // all moved, banked nothing and round-tripped to full losses at −$5.85 each;
    // Rigby stopped two cents short at 1.48×. A rung at 1.22 also fires far more
    // reliably — price lingers near 1.22 but passes through a 1.66 spike between
    // 10s polls, which is how BUNK peaked 1.66× and still lost 70%.
    tp0: [1.22, 0.2], tp1: [2.2, 0.25], tp2: [3.2, 0.25], holdSec: CLOCK_SEC, size: 1.0,
    note: "dispersed ownership, steady accumulation — the microwin engine (86% win)",
  },
  BASE: {
    trade: true, minSnap: 0.2, floor: 0.7, trail: 0.45,
    // Same recut as RISER: BASE is mostly dispersed tape, and Rigby peaked 1.48×
    // — two cents short of the old rung — for a −$1.29 loss on a 48% move.
    tp0: [1.22, 0.2], tp1: [2.1, 0.25], tp2: [2.85, 0.25], holdSec: CLOCK_SEC, size: 1.0,
    note: "unclassified mover with pool support (57% win)",
  },
  // ── sample-limited: traded small to accumulate evidence ──
  CLIMBER: {
    trade: true, minSnap: 0.2, floor: 0.4, trail: 0.25,
    // SHRUNK 0.6 → 0.2 (2026-07-21). CLIMBER is the worst-evidenced tradeable
    // class on every axis we have: 0-for-3 live at ~−$12 with all three dead on
    // arrival (peak ≈1.00×), failed holdout across 2,160 configurations (0.892
    // EV, 0/8 plateau), and below the 60-per-side floor so the learning loop
    // refuses to tune it. Shrunk rather than paused deliberately — pausing means
    // it never crosses the sample floor and stays permanently unresolved, so a
    // small live allocation keeps the evidence accruing at a third of the bleed.
    // SWEEP RUNG 1.55 → 1.40. Whale-held tokens reach 1.5× at 46% — double the
    // dispersed rate — with a 1.46× median run, so the old 1.55 rung sat just
    // ABOVE the band this population actually delivers. Its 35.2% rug rate has
    // to be paid for by an early tranche, and 1.40 sits inside the move.
    tp0: [1.4, 0.2], tp1: [2.35, 0.25], tp2: [3.0, 0.25], holdSec: CLOCK_SEC, size: 0.2,
    note: "whale accumulation into a deep book — 1.6% rug measured, but 0-for-3 live",
  },
  MOON_FAST: {
    trade: true, minSnap: 0.35, floor: 0.4, trail: 0.45,
    tp0: [1.45, 0.2], tp1: [2.35, 0.2], tp2: [4.25, 0.2], holdSec: CLOCK_SEC, size: 0.8,
    note: "thin pool, dispersed, 150-400%/min recovery — rugs 11.6%, p90 6.90×",
  },
  MOON_STEADY: {
    trade: true, minSnap: 0.35, floor: 0.7, trail: 0.35,
    tp0: [1.45, 0.2], tp1: [2.35, 0.25], tp2: [4.25, 0.2], holdSec: CLOCK_SEC, size: 0.6,
    note: "50-150%/min recovery — 13.3% reach 5×",
  },
  MOON_SLOW: {
    trade: true, minSnap: 0.35, floor: 0.4, trail: 0.45,
    tp0: [1.45, 0.25], tp1: [2.35, 0.25], tp2: [4.25, 0.2], holdSec: CLOCK_SEC, size: 0.4,
    note: "<50%/min recovery — weakest moon grade (2.1% reach 5×)",
  },
  MOON_VIOLENT: {
    // Banks early and hard: a 58% rug rate has to be paid for by the first
    // tranche, but 4.5% still reach 5×, so a runner stays alive. Runs on the RUG
    // timeline, not the winners' — this cohort is done inside ~7 minutes.
    trade: true, minSnap: 0.35, floor: 0.52, trail: 0.4,
    tp0: [1.4, 0.35], tp1: [2.3, 0.2], tp2: [4.25, 0.15], holdSec: FAST_CLOCK_SEC, size: 0.3,
    note: "400%+/min snap off a deep dip — 58% rug, kept small for the 4.5% tail",
  },
  // ── refused ──
  RUG_RISK: {
    trade: false, minSnap: 0, floor: 0, trail: 0,
    tp0: [0, 0], tp1: [0, 0], tp2: [0, 0], holdSec: 0, size: 0,
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

  // ── HOLDER DISPERSION FIRST ────────────────────────────────────────────────
  // Ownership structure is known at discovery and separates the classes an order
  // of magnitude better than anything in the trajectory. Dispersed ownership is
  // the shared fingerprint of the two classes that pay (MOON 5.26% largest
  // holder, RISER 4.63%); concentrated ownership marks the ones that do not
  // (DUD 51.2%, CLIMBER 78.0%, RUG 35.3%).
  //
  // This runs BEFORE the pool-growth test because growth alone cannot tell a
  // whale accumulating a book (CLIMBER) from a crowd igniting one (MOON) — both
  // show it. Ownership can. Skipped entirely when the check is missing, so a
  // candidate without holder data still routes on trajectory exactly as before.
  const dispersed =
    i.largestHolderPct != null && i.largestHolderPct <= DISPERSED_LARGEST_PCT &&
    (i.top10Pct == null || i.top10Pct <= DISPERSED_TOP10_PCT);
  const concentrated = i.largestHolderPct != null && i.largestHolderPct >= CONCENTRATED_LARGEST_PCT;

  if (dispersed) {
    // A dispersed book that also shows the moon microstructure is the strongest
    // combination in the data; otherwise it is the reliable microwin class.
    if (i.liq0 < THIN_POOL || i.buyShare < 0.5 || i.dipDepth >= 0.25) return moonGrade(i.snapRate);
    return "RISER";
  }
  if (concentrated && growth >= CLIMBER_GROWTH) return "CLIMBER";

  if (growth >= CLIMBER_GROWTH && i.liq0 >= THIN_POOL) return "CLIMBER";
  if (i.liq0 < THIN_POOL || i.buyShare < 0.5 || i.dipDepth >= 0.25) return moonGrade(i.snapRate);
  if (i.buyShare >= 0.8) return "RISER";
  return "BASE";
}

/**
 * CONVICTION — how strongly the evidence backs THIS setup, 0 to 2 stars.
 *
 * The signature says what a candidate is; conviction says how well this specific
 * instance matches the fingerprint of the ones that paid. It exists so the
 * strongest setups are recognisable the moment they appear — the whole mission
 * is picking winners early, and a two-star MOON_FAST should never be sized like
 * a residual BASE.
 *
 * Star criteria are the measured markers, not judgement calls:
 *   · MOON_FAST rugs 11.6% — LOWER than RISER — with a 6.90× p90. The strongest
 *     cohort in the dataset.
 *   · Holder count 100-250 reaches 5× at 4.4% against a 1.3% baseline.
 *   · Top-10 under 5% reaches 5× at 4.4% against 1.4%.
 * Two independent markers on an evidenced class is the bar for a second star.
 */
export interface Conviction {
  stars: 0 | 1 | 2;
  sizeMult: number;
  why: string;
}

export function convictionOf(s: Signature, i: Partial<SignatureInputs>): Conviction {
  const p = SIGNATURE_PROFILES[s];
  if (!p.trade) return { stars: 0, sizeMult: 0, why: "refused" };

  const marks: string[] = [];
  if (i.holders != null && i.holders >= 100 && i.holders <= 250) marks.push("holders 100-250 (4.4% reach 5×)");
  if (i.top10Pct != null && i.top10Pct < 5) marks.push("top-10 <5% (4.4% reach 5×)");
  if (i.largestHolderPct != null && i.largestHolderPct <= 6) marks.push("crowd-held");
  // WALLET GRAPH — an independent axis. Ownership dispersion says HOW MANY hold
  // it; the graph says WHO. A book already held by wallets that backed previous
  // winners carries a measured 2.2× winner lift, and because holder wallets
  // persist across one-shot tokens it is not derivable from price, pool or
  // concentration. Winner reputation with no rug reputation is the clean case.
  if ((i.walletWinnerHits ?? 0) > 0 && (i.walletEdge ?? 0) > 0) {
    marks.push(`${i.walletWinnerHits} winner-rep holder${(i.walletWinnerHits ?? 0) > 1 ? "s" : ""} (2.2× lift)`);
  }

  // The evidenced classes: RISER confirmed on both sides of the split, MOON_FAST
  // the lowest-rug cohort measured. BASE is the residual bucket by construction —
  // it can never star, because "unidentified" is not conviction.
  const evidenced = s === "RISER" || s === "MOON_FAST";
  const strong = s === "RISER" || s === "MOON_FAST" || s === "MOON_STEADY" || s === "CLIMBER";

  if (evidenced && marks.length >= 2) {
    return { stars: 2, sizeMult: 1.5, why: `${s} + ${marks.join(" + ")}` };
  }
  if (evidenced && marks.length === 1) {
    return { stars: 1, sizeMult: 1.25, why: `${s} + ${marks[0]}` };
  }
  if (strong) return { stars: 1, sizeMult: 1.0, why: `${s} — evidenced class, no extra markers` };
  return { stars: 0, sizeMult: 0.75, why: `${s} — unidentified residual, sized down` };
}

/**
 * POSITION SIZE AS A FRACTION OF CAPITAL — one formula, both lanes.
 *
 *   size = capital × frac,  frac = min + (max − min) × quality
 *
 * The POLICY owns the range: regime hostility sets how much capital may be at
 * risk per trade at all. The QUALITY SCORE picks the point inside it: a two-star
 * setup deploys the top of the range, a residual gets the floor. Nothing else
 * multiplies in — the 200× spread that sized RISER at twenty-one cents came from
 * eight independent factors compounding, and a bounded range cannot do that.
 *
 * Expressing it as a fraction rather than a dollar amount is what lets paper and
 * live share it: paper's capital is the bankroll, live's is the wallet balance,
 * and both scale automatically as the account grows or shrinks. A fixed dollar
 * size silently becomes a different risk as the balance moves.
 */
export function sizeFraction(stars: number, fracMin: number, fracMax: number): number {
  const lo = Math.max(0, Math.min(fracMin, fracMax));
  const hi = Math.max(fracMin, fracMax);
  const quality = Math.max(0, Math.min(1, stars / 2)); // 0★ → floor, 1★ → mid, 2★ → ceiling
  return lo + (hi - lo) * quality;
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
    // The loop's grid fits two rungs; its r1/r2 map onto the middle and upper
    // rungs, and the compiled p50 sweep rung is preserved underneath so a
    // promotion can never remove the early bank.
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
  HARD_STOP_PCT: number; HARD_STOP_PCT_THIN: number; RUNNER_MAX_HOLD_SEC: number;
  TIME_FLOOR_AT_SEC: number; FAST_FLOOR_ENABLED: boolean;
  PROFIT_LOCK_ARM_MULT: number; PROFIT_FLOOR_USD: number;
  POST_BANK_TRAIL_PCT: number; TIMEBOX_FLAT_MULT: number;
} {
  const p = withLearned(s, learned);
  // Cumulative, because the trader's ladder is expressed as "total fraction sold
  // by the time this rung is reached", not as per-rung slices.
  const cum0 = p.tp0[1];
  const cum1 = cum0 + p.tp1[1];
  const cum2 = cum1 + p.tp2[1];
  const trailPct = Math.round(p.trail * 100);
  return {
    // Three progressive rungs on the class's own run distribution (p50/p75/p90),
    // sweeping profit along the path. A trade rarely rises and holds — it wanders,
    // spikes and gives back — so staking the position on one late rung only pays
    // when it goes straight up. The remainder rides to the trail or the clock.
    TP0_MULT: p.tp0[0], TP0_CUM_SELL: cum0,
    TP1_MULT: p.tp1[0], TP1_CUM_SELL: cum1,
    TP2_MULT: p.tp2[0], TP2_CUM_SELL: cum2,
    // One width: the measured give-back a winner takes BEFORE its real high is
    // what the trail must survive, and it does not vary by how far the trade has
    // already run — it varies by CLASS.
    TRAIL_TIGHT_PCT: trailPct, TRAIL_MID_PCT: trailPct, TRAIL_WIDE_PCT: trailPct,
    HARD_STOP_PCT: Math.round((1 - p.floor) * 100),
    // The stop is VENUE-SPLIT — thin bonding-curve tape reads a different knob
    // entirely, and most of our tape is meteora-dbc. Overriding only
    // HARD_STOP_PCT left the majority of routed positions taking a 45% stop
    // instead of their own cover, which is the whole point of the genome.
    HARD_STOP_PCT_THIN: Math.round((1 - p.floor) * 100),
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
    // STOP_FLAT — recycles any position whose peak hasn't cleared 1.1× after 3
    // minutes. Measured live 2026-07-21: it cut three BASE positions for −$1.08,
    // −$1.54 and −$2.42 in minutes, swinging that class from +$4.05 to −$3.63 and
    // inverting the measured ranking between classes. It cannot coexist with
    // genomes whose median run is 1.43-1.56× and whose clocks are their own (MOON
    // 10.9m to peak, RISER 14.8m) — three minutes is inside every class's normal
    // development. 0 disables: `peakMult < 0` is never true.
    TIMEBOX_FLAT_MULT: 0,
  };
}
