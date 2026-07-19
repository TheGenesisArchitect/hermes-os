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
  ctx: { watchMinutes: number; observationCount: number; action?: Action | null },
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
  if (last.buyShareM5 >= cfg.deadBuyShareLo && last.buyShareM5 < cfg.deadBuyShareHi)
    return no(
      `neutral churn (${(last.buyShareM5 * 100).toFixed(0)}% buys in dead zone [${(cfg.deadBuyShareLo * 100).toFixed(0)},${(cfg.deadBuyShareHi * 100).toFixed(0)})% — wash flow, not demand)`,
    );
  // Volume must be ACCELERATING — the last 5m carrying a real slice of the hour's
  // flow (vol_m5/vol_h1). The one clean positive edge vs rugs. Skip the check when
  // vol_h1 is unusable (young token, degenerate ratio) so a real igniter isn't cut.
  const volAccel = last.volH1 > 0 ? last.volM5 / last.volH1 : null;
  if (volAccel !== null && volAccel < cfg.minVolAccel) return no(`volume not accelerating (${volAccel.toFixed(2)} < ${cfg.minVolAccel} of the hour in last 5m)`);

  return {
    triggered: true,
    reason: `confirmed: ${last.markMultiple.toFixed(2)}x green, ${last.drawdownFromPeakPct.toFixed(0)}% off peak, ${(last.buyShareM5 * 100).toFixed(0)}% buys, vol-accel ${volAccel === null ? "n/a" : volAccel.toFixed(2)} at ${ctx.watchMinutes.toFixed(1)}m`,
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
  };
}
