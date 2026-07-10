import type { TokenMarket } from "../market/dexscreener.js";
import type { NarrativeScore } from "./narrative.js";

export interface ScoreBreakdown {
  score: number; // 0-100 composite
  components: {
    momentum: number; // 0-40 — volume acceleration
    buyPressure: number; // 0-25 — buys vs sells
    liquidity: number; // 0-15 — depth
    narrative: number; // 0-20 — LLM hook score (neutral 10 when unavailable)
  };
  inputs: Record<string, unknown>;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Composite 0-100 signal score. Weights: momentum 40, buy pressure 25,
 * liquidity 15, narrative 20. Tuned for minutes-to-hours-old launches.
 */
export function computeScore(
  market: TokenMarket,
  narrative: NarrativeScore | null,
): ScoreBreakdown {
  // Momentum: how much faster is money moving now vs the trailing average.
  // For young pairs the h24 window is mostly empty, so compare m5 (annualized
  // to an hour) against h1, and h1 against the age-adjusted average.
  const ageMin = market.pairAgeMinutes ?? 60;
  // baseline = average hourly volume over the h24 window, which only covers
  // min(age, 24h) of actual trading — never divide by more than 24
  const coveredHours = clamp(ageMin / 60, 1, 24);
  const h1Baseline = market.volUsd.h24 / coveredHours || 1;
  const h1Ratio = market.volUsd.h1 / Math.max(h1Baseline, 1);
  const m5Ratio = (market.volUsd.m5 * 12) / Math.max(market.volUsd.h1, 1);
  // log-scale: ratio 1 → ~0, ratio 8+ → full marks; recent burst (m5) weighted in
  const momentum = clamp(
    (Math.log2(Math.max(h1Ratio, 0.01)) / 3) * 28 + clamp(m5Ratio, 0, 2) * 6,
    0,
    40,
  );

  // Buy pressure: share of buys in the last hour, 50% → 0, 80%+ → full marks.
  const { buys, sells } = market.txns.h1;
  const total = buys + sells;
  const buyShare = total > 0 ? buys / total : 0.5;
  const buyPressure = clamp(((buyShare - 0.5) / 0.3) * 25, 0, 25);

  // Liquidity depth: log scale $5k → 0, $200k+ → full marks.
  const liquidity = clamp(
    (Math.log10(Math.max(market.liquidityUsd, 1) / 5_000) / Math.log10(40)) * 15,
    0,
    15,
  );

  // Narrative: LLM hook score scaled to 20; neutral midpoint when unscored.
  const narrativeComponent = narrative ? clamp(narrative.score / 5, 0, 20) : 10;

  const score = momentum + buyPressure + liquidity + narrativeComponent;
  return {
    score: Number(score.toFixed(1)),
    components: {
      momentum: Number(momentum.toFixed(1)),
      buyPressure: Number(buyPressure.toFixed(1)),
      liquidity: Number(liquidity.toFixed(1)),
      narrative: Number(narrativeComponent.toFixed(1)),
    },
    inputs: {
      volM5: market.volUsd.m5,
      volH1: market.volUsd.h1,
      volH24: market.volUsd.h24,
      buysH1: buys,
      sellsH1: sells,
      buySharePct: Number((buyShare * 100).toFixed(1)),
      liquidityUsd: market.liquidityUsd,
      pairAgeMinutes: market.pairAgeMinutes,
      narrative: narrative ?? "unavailable (no ANTHROPIC_API_KEY)",
    },
  };
}
