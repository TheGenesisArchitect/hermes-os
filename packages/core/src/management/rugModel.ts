/**
 * Rug-prediction logistic model — FITTED from the recorder's labeled dataset,
 * not guessed. This is the flywheel paying out: every safety-passed candidate
 * the recorder watched became a training row.
 *
 * Provenance: fitted 2026-07-19T14:57Z by services/recorder/src/fitRugModel.ts
 * on n=5988 triggered candidates (train 4191 / test 1797, TIME-ORDERED split),
 * the first fit on liquidity-collapse-corrected labels (see recorder
 * closeOutcome — 1,709 frozen-mark rugs had been graded "dud"). Held-out
 * validation (most recent 30%, unseen regime): AUC 0.710, quintile rug rates
 * 9.5% / 13.9% / 21.1% / 29.5% / 46.4% against a 24.1% base.
 *
 * POINT-IN-TIME HONEST: every feature is knowable at arm time (the last
 * recorder tick at/before the trigger). Nothing from the future leaks in.
 *
 * What the weights say (standardized magnitudes, clean labels):
 *   fdvLiq     +0.54   — high FDV piled on thin liquidity = exit-door mismatch
 *   fdvMissing +0.47   — no readable FDV at confirm remains a strong rug tell
 *   log10VolM5 −0.44   — real absolute flow reduces rug odds
 *   triggerMult −0.44  — a higher confirmed multiple is earned, not staged
 *   watchMin   −0.29   — later confirms are realer than 2-minute pops
 *   log10Liq   −0.23   — deep pools are yanked less often
 *   venuePump  +0.18   — pump venues lean rug once frozen-mark rugs are counted
 *   triggerDd  −0.04   — the old −0.55 "survived a dip = real" signal was
 *                        mostly a labeling artifact; nearly flat on clean labels
 *
 * AUC 0.70 earns SIZING power, not veto power — deployed as a size multiplier
 * per the shrink-don't-veto doctrine. Refit as the dataset grows:
 *   pnpm --filter @hermes/recorder exec tsx src/fitRugModel.ts
 */

export interface RugModelInput {
  /** Canonical venue string (tokens.dex / canonicalVenue(market)). */
  venue: string | null | undefined;
  liquidityUsd: number | null | undefined;
  fdvUsd: number | null | undefined;
  volM5: number | null | undefined;
  volH1: number | null | undefined;
  /** Mark multiple vs recorder reference at the confirm tick. */
  markMultiple: number | null | undefined;
  /** Drawdown-from-peak % at the confirm tick. */
  drawdownPct: number | null | undefined;
  /** Minutes watched before the confirm. */
  watchMinutes: number | null | undefined;
}

export const RUG_FEATURE_NAMES = [
  "accelDead",
  "accelFresh",
  "log10Liq",
  "fdvMissing",
  "fdvLiq",
  "venueDammV2",
  "venueDbc",
  "venuePump",
  "triggerMult",
  "triggerDd",
  "watchMin",
  "log10VolM5",
] as const;

const num = (v: number | null | undefined): number =>
  v === null || v === undefined || !Number.isFinite(Number(v)) ? NaN : Number(v);

/** Feature vector in RUG_FEATURE_NAMES order — the fit script uses this too. */
export function rugFeatureVector(r: RugModelInput): number[] {
  const liq = Math.max(1, num(r.liquidityUsd) || 1);
  const volM5 = Math.max(0, num(r.volM5) || 0);
  const volH1 = Math.max(0, num(r.volH1) || 0);
  const accelRaw = volH1 > 0 ? volM5 / volH1 : 1; // degenerate young ratio → neutral
  const accelDead = Math.max(0, 0.5 - Math.min(accelRaw, 2)) / 0.5;
  const accelFresh = Math.max(0, Math.min(accelRaw, 2) - 1);
  const fdv = num(r.fdvUsd);
  const fdvMissing = !Number.isFinite(fdv) || fdv <= 0 ? 1 : 0;
  const fdvLiq = fdvMissing ? 0 : Math.min(fdv / liq, 50);
  const dex = (r.venue ?? "").toLowerCase();
  return [
    accelDead,
    accelFresh,
    Math.log10(liq),
    fdvMissing,
    fdvLiq,
    dex === "meteora-damm-v2" ? 1 : 0,
    dex === "meteora-dbc" || dex === "meteoradbc" ? 1 : 0,
    dex === "pumpswap" || dex === "pump-amm" ? 1 : 0,
    Math.min(num(r.markMultiple) || 1, 5),
    Math.min(num(r.drawdownPct) || 0, 50) / 50,
    Math.min(num(r.watchMinutes) || 0, 15) / 15,
    Math.log10(Math.max(1, volM5)),
  ];
}

/**
 * Raw-space fitted weights. REFIT 2026-07-19T14:57Z on n=5988 triggered
 * candidates (train 4191 / test 1797, time-split) — the FIRST fit on the
 * liquidity-collapse-corrected labels (1,709 frozen-mark rugs had been hiding
 * in the dud class, so every prior fit learned from a diluted rug signal).
 * Held-out AUC 0.710; test quintile rug rates 9.5% / 13.9% / 21.1% / 29.5% /
 * 46.4% vs 24.1% base. Notable on clean labels: triggerDd's dominance
 * (−10.66 raw) collapsed to −1.54 — "survived a dip = real" was mostly a
 * labeling artifact; venuePump flipped to rug-leaning; liquidity and absolute
 * flow became genuinely protective.
 */
export const RUG_WEIGHTS: Record<(typeof RUG_FEATURE_NAMES)[number], number> = {
  accelDead: -0.076883,
  accelFresh: 0.0,
  log10Liq: -0.402103,
  fdvMissing: 1.06074,
  fdvLiq: 0.023169,
  venueDammV2: 0.076403,
  venueDbc: -0.228614,
  venuePump: 0.472117,
  triggerMult: -1.40479,
  triggerDd: -1.540626,
  watchMin: -1.972227,
  log10VolM5: -0.733458,
};
export const RUG_BIAS = 6.098133;

/** P(rug within the 15-min recorder window | confirmed at these conditions). */
export function scoreRugProb(input: RugModelInput): number {
  const x = rugFeatureVector(input);
  let z = RUG_BIAS;
  RUG_FEATURE_NAMES.forEach((name, j) => {
    z += RUG_WEIGHTS[name] * (x[j] ?? 0);
  });
  return 1 / (1 + Math.exp(-z));
}
