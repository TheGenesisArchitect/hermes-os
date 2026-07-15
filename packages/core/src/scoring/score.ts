import type { TokenMarket } from "../market/dexscreener.js";
import type { NarrativeScore } from "./narrative.js";

export interface ScoreBreakdown {
  score: number; // 0-100 composite
  components: {
    momentum: number; // 0-30 — volume acceleration
    buyPressure: number; // 0-20 — buys vs sells
    convexity: number; // 0-15 — liquidity in the "thin enough to move" band
    narrative: number; // 0-20 — LLM hook score (neutral 10 when unavailable)
    source: number; // 0-15 — proven / graduation / bonding-curve venue edge
  };
  inputs: Record<string, unknown>;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Convexity fit (0-15): reward the liquidity band where a real move is
 * physically possible. The old score rewarded DEPTH — backwards for us: a $600k
 * pool can't run, McGwegor's 327x came from a $25k pool. Peaks in the ~$8k-80k
 * band, ramps up from dust below, and decays (never to zero) for deep pools that
 * can still base-hit. Thin is a feature, not a penalty.
 */
function convexityFit(liq: number): number {
  if (liq <= 0) return 0;
  const dust = 8_000;
  const sweetHi = 80_000;
  const deep = 600_000;
  if (liq < dust) return clamp((liq / dust) * 10, 0, 10); // ramp up out of dust
  if (liq <= sweetHi) return 15; // the convex sweet spot
  const t = clamp(
    (Math.log10(liq) - Math.log10(sweetHi)) / (Math.log10(deep) - Math.log10(sweetHi)),
    0,
    1,
  );
  return clamp(15 - t * 11, 4, 15); // decay toward a base-hit floor, never zero
}

/**
 * Source edge (0-15) — REFRESHED 2026-07-15 from the recorder pond map
 * (candidate_outcomes, every safety-passed candidate watched regardless of
 * whether we traded it; n in comments):
 *
 *   venue            watched  win%  rug%  avgPeak  3x+
 *   fluxbeam              15  100%    0%    3.95x   14   ← the prime pond
 *   meteora-damm-v2     4227   20%   44%    1.62x   94   ← the volume engine
 *   pumpswap             713   15%   29%    1.65x   43
 *   pump-amm             203   15%   39%    1.66x   11
 *   meteora-dbc          362   13%   50%    2.21x   16   ← convex but ruggy
 *   bags-fm               95    1%   79%    1.35x    0   ← blocked at entry
 *   orca/moonshot/clmm   276    0%    —     1.00x    0   ← dead ponds
 *
 * The 1c-era map ranked bags-fm at 11 ("11 of 16 movers") — that read was 16
 * correlated draws from one epoch; 95 labeled outcomes later it is the single
 * worst pond we have measured. Unknown venues keep a non-zero baseline so a
 * new source is explored, never auto-buried (that exploration is exactly how
 * fluxbeam surfaced).
 */
function sourceEdge(dex: string | undefined): number {
  const d = (dex ?? "").toLowerCase();
  if (d.includes("fluxbeam")) return 15; // 15/15 winners, 14 hit 3x+ — prime
  if (d === "pumpswap" || d.includes("pump")) return 11; // graduated pump.fun — proven demand
  if (d.includes("dbc") || d.includes("bonding")) return 10; // convex ceiling, but 50% rug — rug model prices it
  if (d.includes("meteora")) return 8; // damm-v2 volume engine — post-fix +$21/82% win traded
  if (d.includes("bags")) return 2; // 1% win / 79% rug — entry-blocked anyway
  if (d.includes("raydium") || d.includes("orca") || d.includes("moonshot")) return 4; // 0 winners in 276 watched
  return 5; // unknown venue — explore, don't bury
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
    (Math.log2(Math.max(h1Ratio, 0.01)) / 3) * 21 + clamp(m5Ratio, 0, 2) * 4.5,
    0,
    30,
  );

  // Buy pressure: share of buys in the last hour, 50% → 0, 80%+ → full marks.
  const { buys, sells } = market.txns.h1;
  const total = buys + sells;
  const buyShare = total > 0 ? buys / total : 0.5;
  const buyPressure = clamp(((buyShare - 0.5) / 0.3) * 20, 0, 20);

  // Convexity fit: reward the thin-enough-to-move band, not raw depth.
  const convexity = convexityFit(market.liquidityUsd);

  // Narrative: LLM hook score scaled to 20; neutral midpoint when unscored.
  const narrativeComponent = narrative ? clamp(narrative.score / 5, 0, 20) : 10;

  // Source edge: proven / graduation / bonding-curve venue.
  const source = sourceEdge(market.dexId);

  const score = momentum + buyPressure + convexity + narrativeComponent + source;
  return {
    score: Number(score.toFixed(1)),
    components: {
      momentum: Number(momentum.toFixed(1)),
      buyPressure: Number(buyPressure.toFixed(1)),
      convexity: Number(convexity.toFixed(1)),
      narrative: Number(narrativeComponent.toFixed(1)),
      source: Number(source.toFixed(1)),
    },
    inputs: {
      volM5: market.volUsd.m5,
      volH1: market.volUsd.h1,
      volH24: market.volUsd.h24,
      buysH1: buys,
      sellsH1: sells,
      buySharePct: Number((buyShare * 100).toFixed(1)),
      liquidityUsd: market.liquidityUsd,
      dexId: market.dexId,
      pairAgeMinutes: market.pairAgeMinutes,
      narrative: narrative ?? "unavailable (no ANTHROPIC_API_KEY)",
    },
  };
}
