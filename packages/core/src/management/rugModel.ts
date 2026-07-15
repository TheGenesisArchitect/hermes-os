/**
 * Rug-prediction logistic model — FITTED from the recorder's labeled dataset,
 * not guessed. This is the flywheel paying out: every safety-passed candidate
 * the recorder watched became a training row.
 *
 * Provenance: fitted 2026-07-15T21:59Z by services/recorder/src/fitRugModel.ts
 * on n=2322 triggered candidates (train 1625 / test 697, TIME-ORDERED split).
 * Held-out validation (most recent 30%, unseen regime): AUC 0.698, quintile
 * rug rates 7.9% / 14.4% / 27.9% / 40.3% / 44.3% against a 27.0% base — the
 * cleanest quintile rugs 5.6x less often than the dirtiest.
 *
 * POINT-IN-TIME HONEST: every feature is knowable at arm time (the last
 * recorder tick at/before the trigger). Nothing from the future leaks in.
 *
 * What the weights say (standardized magnitudes):
 *   fdvMissing +0.89   — no readable FDV at confirm = the strongest rug tell
 *   triggerDd  −0.55   — a token that SURVIVED a dip before confirming is real;
 *                        rugs confirm at fresh highs (the pop IS the exit event)
 *   venueDammV2 −0.38  — controlling for everything else, damm-v2 rugs LESS
 *                        than the long-tail baseline (its bad rep was exit-bug
 *                        losses, not differential rug rate)
 *   watchMin   −0.29   — later confirms are realer than 2-minute pops
 *   triggerMult −0.28  — a higher confirmed multiple is earned, not staged
 *   log10VolM5 −0.23   — real absolute flow reduces rug odds
 *   accelDead  +0.17   — vol_m5/vol_h1 < 0.5 (flow already died) leans rug
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

/** Raw-space fitted weights (see provenance above). */
export const RUG_WEIGHTS: Record<(typeof RUG_FEATURE_NAMES)[number], number> = {
  accelDead: 0.470139,
  accelFresh: 0.0,
  log10Liq: 0.30609,
  fdvMissing: 1.817238,
  fdvLiq: 0.038623,
  venueDammV2: -1.118113,
  venueDbc: -0.982388,
  venuePump: -0.176092,
  triggerMult: -0.722449,
  triggerDd: -15.42612,
  watchMin: -2.216229,
  log10VolM5: -0.374684,
};
export const RUG_BIAS = 0.24238;

/** P(rug within the 15-min recorder window | confirmed at these conditions). */
export function scoreRugProb(input: RugModelInput): number {
  const x = rugFeatureVector(input);
  let z = RUG_BIAS;
  RUG_FEATURE_NAMES.forEach((name, j) => {
    z += RUG_WEIGHTS[name] * (x[j] ?? 0);
  });
  return 1 / (1 + Math.exp(-z));
}
