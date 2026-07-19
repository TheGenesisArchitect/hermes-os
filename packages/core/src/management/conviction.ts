/**
 * CONVICTION MODEL — the fused high-performance score, wallet-dominant.
 *
 * Every armed candidate has already cleared the binary gates (microstructure,
 * premium venue, honeypot), so within the armed pool those add little marginal
 * separation. What's LEFT that separates is the wallet-graph edge (the only
 * factor with a strong, leak-free, out-of-sample lift — 2.2×), plus rug-safety
 * and how STRONGLY the microstructure gate passed. This fuses them into one
 * score ∈ [0,1] that drives entry PRIORITY (creme rises to the scarce slots) and
 * live conviction-scaled sizing. Weights are FROZEN — no live fitting.
 */

export interface ConvictionInput {
  walletEdge: number | null; // [0,1], 0.5 neutral; null → neutral
  rugProb: number | null; // [0,1]; null → neutral
  triggerMultiple: number | null; // gate strength — how far above 1× it confirmed
  buyShare: number | null; // gate strength — demand at the freshest armed read
}

export interface ConvictionWeights {
  wallet: number;
  rugSafe: number;
  gate: number;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Fused conviction ∈ [0,1]. All inputs point-in-time (known at arm). */
export function scoreConviction(i: ConvictionInput, w: ConvictionWeights): number {
  const wallet = clamp01(i.walletEdge ?? 0.5);
  const rugSafe = 1 - clamp01(i.rugProb ?? 0.5);
  // trigger mult 1×→0, 2×+→1 (normalized gate strength)
  const nm = i.triggerMultiple != null ? clamp01((i.triggerMultiple - 1) / 1) : 0.3;
  const bs = clamp01(i.buyShare ?? 0.6);
  const gate = 0.5 * nm + 0.5 * bs;
  const total = w.wallet + w.rugSafe + w.gate || 1;
  return clamp01((w.wallet * wallet + w.rugSafe * rugSafe + w.gate * gate) / total);
}

/** Map conviction ∈ [0,1] to a size multiplier on the base position. */
export function convictionBand(score: number, min: number, max: number): number {
  return min + clamp01(score) * (max - min);
}
