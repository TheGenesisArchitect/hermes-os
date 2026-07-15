import type { TokenMarket } from "./dexscreener.js";

/**
 * Resolve a live market read to the SAME canonical venue string the venue
 * lists and DB `tokens.dex` are written in, so entry-side (tokens.dex) and
 * exit-side (live DexScreener feed) agree. The DexScreener feed reports
 * damm-v2 as dexId "meteora" + label "DYN2" while GeckoTerminal-ingested
 * `tokens.dex` says "meteora-damm-v2" — the mismatch once silently disabled
 * the farm ladder in production (−$372/overnight). The LABEL is the only
 * discriminator between the atomic-cliff farm (DYN2) and DAMM-v1 launches
 * like bags-fm (DYN) — match dexId+label, never bare dexId. Non-mutating.
 */
export function canonicalVenue(market: Pick<TokenMarket, "dexId" | "labels">): string {
  const dex = (market.dexId ?? "").toLowerCase();
  const labels = (market.labels ?? []).map((l) => l.toLowerCase());
  if (dex === "meteora" && labels.includes("dyn2")) return "meteora-damm-v2";
  return dex;
}
