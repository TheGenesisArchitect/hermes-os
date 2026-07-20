/**
 * Recorder-as-scout: the confirmation entry trigger.
 *
 * The thesis, proven twice now: at t=0 a winner and a dud are the same token —
 * young, ~100% buys, high continuation score. Run-1c had one winner in the
 * sample so it was a guess; run-1d gave us 24 winners / 60 duds across 2,484
 * recorded ticks, and the early continuation score STILL doesn't separate them
 * (winners avg 99.3, duds 99.1 — saturated). So entry selection on the score is
 * a coin flip. What DOES separate, and cleanly, is what the trajectory does over
 * the next few minutes: winners go green and hold near their highs; duds spike a
 * little then fall BELOW their reference and roll over.
 *
 *   feature (winner vs dud):   t=3min      t=5min      t=8min
 *   markMultiple                1.23/0.98   1.34/0.94   1.42/0.91
 *   drawdown from peak %         7 / 12     12 / 21     16 / 29
 *
 * So the gate is pure microstructure — green, near-highs, buy-side still winning
 * — evaluated on the candidate's real path, NOT the saturated classifier score.
 * This is a confirmation TIMING mechanism, not a reject-filter: it doesn't shrink
 * the universe of what we'll trade, it waits for each token to prove the green
 * move before we commit capital, and it will happily enter a token that looked
 * weak at t=0 but ignites at t=4min (which a blind fixed-age entry would miss).
 *
 * The thresholds are calibration PRIORS on a modest sample (n=24 winners, 0 rugs
 * seen). They are config knobs; the recorder keeps labeling, so run-1e+ can fit
 * real weights against the same persisted trajectories without touching this
 * interface.
 */

import type { Action, Tick } from "./classifier.js";

export interface EntryTriggerConfig {
  enabled: boolean;
  minWatchMin: number;
  maxWatchMin: number;
  minTicks: number;
  minMult: number;
  maxDrawdownPct: number;
  minBuyShare: number;
  minVolAccel: number;
  /** Neutral-churn dead zone [lo, hi): symmetric bot ping-pong flow, not demand. */
  deadBuyShareLo: number;
  deadBuyShareHi: number;
  /**
   * Liquidity growth (current ÷ first trusted read) that EXEMPTS a candidate
   * from the dead-zone veto and marks it a real-inflow confirm. Leak-free
   * measurement over 1,826 triggers (48h): candidates whose pool grew ≥1.3×
   * by trigger ran 2.79× after entry vs 1.78×, hit ≥1.5× post-entry 51% vs
   * 25%, and rugged 6.0% vs 26.2%.
   */
  liqGrowthExempt: number;
  /**
   * CONTINUATION CONFIRMATION — the token must clear the bar, then keep going.
   * Nothing observable AT entry separates duds from movers (eleven features
   * tested: instantaneous rise, sustained rise, time-above-level, watch
   * duration, pool growth, buy share, rug prob, conviction, wallet reputation,
   * fill lag — all statistically identical). What separates is what the price
   * does NEXT. Measured over 474 closed trades, by continuation from the tick
   * that first qualified to the tick ~30s later:
   *     FADED   n=203  −$28.98  (−0.143/trade)
   *     0-2%    n=45   −$5.78   (−0.128)
   *     +2-5%   n=58   +$2.74   (+0.047)
   *     +5-10%  n=58   +$5.74   (+0.099)
   *     ≥+10%   n=110  +$20.96  (+0.191)
   * Monotonic in P&L. Requiring ≥2% turns −$5.32 into +$29.44 and refuses 248
   * losing trades outright — no capital donated to learn what the tape will
   * tell us for free. NOTE the opposite is NOT true: momentum measured INTO the
   * gate is inverted (a token rising ≥10% at the trigger tick is the worst
   * cohort, −$29.00 over 282 trades — that is buying the top of a spike).
   */
  /**
   * CEILING on how far price may have risen between the prior qualifying tick
   * and the confirming one. A vertical is the top of a parabola, not a
   * confirmation: the ≥100% band lost −0.983/trade, six times worse than any
   * other, and is where the 41.64×-then-zero class lives. 0 disables.
   */
  maxRiseIntoGate: number;
}

export interface EntryTrigger {
  triggered: boolean;
  reason: string;
  markMultiple: number;
  drawdownPct: number;
  buyShare: number;
}

/**
 * Decide whether a watched candidate has CONFIRMED demand acceleration and
 * should be handed to the trader for entry. Pure: the recorder supplies the
 * candidate's trajectory (`series`, most-recent-last), how long we've watched
 * it, how many observations we have, and the current classifier call (used only
 * as a cheap CUT guard — the score itself is saturated and is not the gate).
 *
 * Fires on the FIRST tick that clears every condition; the recorder makes the
 * trigger one-shot per mint.
 */
export function evaluateEntryTrigger(
  series: Tick[],
  ctx: {
    watchMinutes: number;
    observationCount: number;
    action?: Action | null;
    liqGrowth?: number | null;
    /**
     * How many ticks back ≈ the continuation measurement window (~30s). Passed
     * by the caller from its poll interval so the gate is SAMPLING-RATE
     * INDEPENDENT: "+2% of continuation" must always mean +2% over ~30 seconds,
     * never "+2% per tick". Without this, tightening the recorder's poll would
     * silently triple the strictness of the gate and collapse entry volume for
     * reasons that have nothing to do with the signal. Defaults to 1.
     */
    continuationLookback?: number;
  },
  cfg: EntryTriggerConfig,
): EntryTrigger {
  const last = series[series.length - 1];
  const base = {
    markMultiple: last?.markMultiple ?? 0,
    drawdownPct: last?.drawdownFromPeakPct ?? 0,
    buyShare: last?.buyShareM5 ?? 0,
  };
  const no = (reason: string): EntryTrigger => ({ triggered: false, reason, ...base });

  if (!cfg.enabled) return no("confirmation entry disabled");
  if (!last) return no("no observations yet");
  if (ctx.watchMinutes < cfg.minWatchMin) return no(`too early (${ctx.watchMinutes.toFixed(1)}m < ${cfg.minWatchMin}m — t=0 noise)`);
  if (ctx.watchMinutes > cfg.maxWatchMin) return no(`past entry window (${ctx.watchMinutes.toFixed(1)}m > ${cfg.maxWatchMin}m)`);
  if (ctx.observationCount < cfg.minTicks) return no(`insufficient trajectory (${ctx.observationCount} < ${cfg.minTicks} ticks)`);
  if (ctx.action === "CUT") return no("classifier says CUT — do not enter");
  if (last.markMultiple < cfg.minMult) return no(`not green enough (${last.markMultiple.toFixed(2)}x < ${cfg.minMult}x)`);
  if (last.drawdownFromPeakPct > cfg.maxDrawdownPct) return no(`rolled off peak (${last.drawdownFromPeakPct.toFixed(0)}% > ${cfg.maxDrawdownPct}%)`);
  if (last.buyShareM5 < cfg.minBuyShare) return no(`buy flow faded (${(last.buyShareM5 * 100).toFixed(0)}% < ${(cfg.minBuyShare * 100).toFixed(0)}%)`);
  // Neutral-churn dead zone (calibrated 2026-07-19 on liquidity-collapse-clean
  // labels, n=5988 triggers): buy share in [0.50, 0.55) at the confirm tick =
  // symmetric wash flow (avg ~800 txns/5m of bot ping-pong), 7.9% winners vs
  // 31-43% in every band on either side — the ragoon bait signature (price
  // pinned green on 51/49 flow, then the LP yank). NOT a floor: 0.45-0.50
  // (sell-pressure-absorbed) wins 33%, so only the dead zone is excluded.
  //
  // LIQUIDITY-INFLOW EXEMPTION (2026-07-20): the veto was also delaying the
  // best movers. A 14.59× winner sat at 50-52% buys for its first five minutes
  // with liquidity climbing $9k → $35k; the dead zone held us out until 3.72×
  // when it was enterable at ~2.15×. Buy-SHARE is a ratio and cannot tell wash
  // churn from a deep bid — pool GROWTH can. Wash churn ping-pongs the same
  // capital (flat pool); a real move pulls new capital in. So a growing pool
  // overrides the ratio veto, and only flat-pool churn is refused.
  const grew = (ctx.liqGrowth ?? 0) >= cfg.liqGrowthExempt;
  if (last.buyShareM5 >= cfg.deadBuyShareLo && last.buyShareM5 < cfg.deadBuyShareHi && !grew)
    return no(
      `neutral churn (${(last.buyShareM5 * 100).toFixed(0)}% buys in dead zone [${(cfg.deadBuyShareLo * 100).toFixed(0)},${(cfg.deadBuyShareHi * 100).toFixed(0)})%, pool ${ctx.liqGrowth ? `${ctx.liqGrowth.toFixed(2)}×` : "flat"} — wash flow, not demand)`,
    );
  // Volume must be ACCELERATING — the last 5m carrying a real slice of the hour's
  // flow (vol_m5/vol_h1). The one clean positive edge vs rugs. Skip the check when
  // vol_h1 is unusable (young token, degenerate ratio) so a real igniter isn't cut.
  const volAccel = last.volH1 > 0 ? last.volM5 / last.volH1 : null;
  if (volAccel !== null && volAccel < cfg.minVolAccel) return no(`volume not accelerating (${volAccel.toFixed(2)} < ${cfg.minVolAccel} of the hour in last 5m)`);

  // CONTINUATION CONFIRMATION — qualify, then prove it. The previous trusted
  // observation must ALSO have cleared the multiple bar, and price must have
  // advanced by minContinuation since. A token that clears the bar and stalls
  // (or fades) is refused before a dollar is committed; the tape does the
  // probing that our capital used to pay for.
  // RISE INTO THE GATE — a CEILING, not a floor. Measured on 540 closed trades
  // by how far price rose between the prior qualifying tick and the confirming
  // one:
  //     <+2%       n=55   +$9.16   (+0.167/trade)  ← the best band
  //     +2-10%     n=170  −$6.80   (−0.040)
  //     +10-25%    n=179  −$28.37  (−0.158)
  //     +25-50%    n=80   −$14.81  (−0.185)
  //     +50-100%   n=43   +$12.56  (+0.292)
  //     ≥+100%     n=13   −$12.79  (−0.983)  ← 6× worse than any other band
  // The original MINIMUM was exactly backwards: it excluded the only reliably
  // positive band and admitted the verticals unbounded. A token that went 4.03×
  // → 14.42× in one tick armed at 14.42×, peaked 41.64× and was worth ZERO
  // ninety seconds later — a parabola we chased to the top. Verticals are only
  // 23% dead-on-arrival; they move, then they rug. So: no floor on the rise, and
  // a hard ceiling on it. (Continuation measured AFTER qualification is a
  // different and genuinely positive signal — it would require delaying entry,
  // and is not what this check does.)
  const lookback = Math.max(1, Math.round(ctx.continuationLookback ?? 1));
  const prior = series[series.length - 1 - lookback];
  if (prior && prior.markMultiple > 0) {
    const rise = last.markMultiple / prior.markMultiple - 1;
    if (cfg.maxRiseIntoGate > 0 && rise >= cfg.maxRiseIntoGate)
      return no(
        `vertical spike (+${(rise * 100).toFixed(0)}% in one window) — refusing to buy the top of a parabola`,
      );
  }

  return {
    triggered: true,
    reason: `confirmed: ${last.markMultiple.toFixed(2)}x green, ${last.drawdownFromPeakPct.toFixed(0)}% off peak, ${(last.buyShareM5 * 100).toFixed(0)}% buys, pool ${ctx.liqGrowth ? `${ctx.liqGrowth.toFixed(2)}×` : "n/a"}${grew ? " 💧INFLOW" : ""}, vol-accel ${volAccel === null ? "n/a" : volAccel.toFixed(2)} at ${ctx.watchMinutes.toFixed(1)}m`,
    ...base,
  };
}

/** Build an EntryTriggerConfig from the loaded HermesConfig knobs. */
export function entryTriggerConfigFrom(cfg: {
  CONFIRM_ENTRY_ENABLED: boolean;
  CONFIRM_MIN_WATCH_MIN: number;
  CONFIRM_MAX_WATCH_MIN: number;
  CONFIRM_MIN_TICKS: number;
  CONFIRM_MIN_MULT: number;
  CONFIRM_MAX_DD_PCT: number;
  CONFIRM_MIN_BUYSHARE: number;
  CONFIRM_MIN_VOLACCEL: number;
  CONFIRM_DEAD_BUYSHARE_LO: number;
  CONFIRM_DEAD_BUYSHARE_HI: number;
  CONFIRM_LIQ_GROWTH_EXEMPT: number;
  CONFIRM_MAX_RISE_INTO_GATE: number;
}): EntryTriggerConfig {
  return {
    enabled: cfg.CONFIRM_ENTRY_ENABLED,
    minWatchMin: cfg.CONFIRM_MIN_WATCH_MIN,
    maxWatchMin: cfg.CONFIRM_MAX_WATCH_MIN,
    minTicks: cfg.CONFIRM_MIN_TICKS,
    minMult: cfg.CONFIRM_MIN_MULT,
    maxDrawdownPct: cfg.CONFIRM_MAX_DD_PCT,
    minBuyShare: cfg.CONFIRM_MIN_BUYSHARE,
    minVolAccel: cfg.CONFIRM_MIN_VOLACCEL,
    deadBuyShareLo: cfg.CONFIRM_DEAD_BUYSHARE_LO,
    deadBuyShareHi: cfg.CONFIRM_DEAD_BUYSHARE_HI,
    liqGrowthExempt: cfg.CONFIRM_LIQ_GROWTH_EXEMPT,
    maxRiseIntoGate: cfg.CONFIRM_MAX_RISE_INTO_GATE,
  };
}
