/**
 * WALLET-REPUTATION SCORING — the pure math over the wallet graph.
 *
 * VALIDATED leak-free (time-ordered, held-out): a winner-rep wallet in a token's
 * holder set = 2.2× winner lift (27% vs 12.4% base) and −36% rug; an all-fresh
 * holder set = the highest rug rate (44.5% vs 34.8%). These helpers turn a
 * candidate's holder reputations into a transparent walletEdge ∈ [0,1] the radar
 * ranks by. Heuristic, honestly labeled — the weights encode the validated
 * PRESENCE signals (a winner-rep wallet present, a rug-rep wallet present, nobody
 * recognized), not a fitted model. Refit is a deliberate future step.
 */

export const WALLET_MIN_SAMPLE = 2; // a wallet needs ≥2 labeled tokens to count

export interface WalletRep {
  tokens: number;
  wins: number;
  rugs: number;
}

export interface WalletEdge {
  edge: number; // [0,1]; 0.5 = neutral
  winnerHits: number; // net-positive wallets among holders (wins > rugs — RECOVERED tier included)
  strictHits: number; // clean-winner wallets among holders (never rugged — PRECISION tier)
  rugHits: number; // serial-rug wallets among holders
  known: number; // holders with a qualifying reputation record
}

/** clean winner: held a winner, never rugged, enough sample */
export const isWinnerRep = (r: WalletRep) => r.tokens >= WALLET_MIN_SAMPLE && r.wins >= 1 && r.rugs === 0;
/**
 * net-positive: more wins than rugs, enough sample. RECOVERED tier (ratified
 * 2026-07-24): the rugs===0 zero-tolerance rule expelled good wallets in a hot
 * market — leak-free verified, net-positive-crowd candidates run 58% winners /
 * 28% rugs (~333/day recovered). Counts toward crowd presence at reduced size.
 */
export const isNetPositiveRep = (r: WalletRep) => r.tokens >= WALLET_MIN_SAMPLE && r.wins >= 1 && r.wins > r.rugs;
/** serial rug: rugged repeatedly, never a winner */
export const isRugRep = (r: WalletRep) => r.tokens >= WALLET_MIN_SAMPLE && r.rugs >= 2 && r.wins === 0;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * Aggregate a candidate's holder reputations into a walletEdge. `reps` are the
 * reputation rows we found for recognized holders; `holdersSampled` is how many
 * holders we looked at. An all-fresh holder set (holders present, none known) is
 * itself the danger signal and pulls the edge below neutral. Presence-weighted
 * with diminishing returns past the first couple of hits.
 */
export function walletEdgeFrom(reps: WalletRep[], holdersSampled: number): WalletEdge {
  const known = reps.filter((r) => r.tokens >= WALLET_MIN_SAMPLE);
  const strictHits = known.filter(isWinnerRep).length;
  const winnerHits = known.filter(isNetPositiveRep).length; // superset of strict
  const rugHits = known.filter(isRugRep).length;
  const allFresh = holdersSampled > 0 && known.length === 0;
  // Strict (never-rugged) winners carry the full validated weight; recovered
  // (net-positive) winners carry half — 58% win cohort vs the 2.2× strict lift.
  const winTerm = 0.2 * Math.min(strictHits, 3) + 0.1 * Math.min(winnerHits - strictHits, 3);
  const rugTerm = 0.14 * Math.min(rugHits, 3);
  const freshPenalty = allFresh ? 0.12 : 0;
  const edge = clamp01(0.5 + winTerm - rugTerm - freshPenalty);
  return { edge, winnerHits, strictHits, rugHits, known: known.length };
}
