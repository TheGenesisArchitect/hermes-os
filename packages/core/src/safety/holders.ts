import { getMintInfo, getTokenAccountOwners, getTokenLargestAccounts } from "../rpc.js";
import type { SafetyCheckResult } from "../types.js";

/**
 * Owners whose balances are pool liquidity, not a person's bag.
 * Excluded from concentration math so a healthy LP vault doesn't fail the check.
 */
const KNOWN_POOL_AUTHORITIES = new Set([
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", // Raydium AMM v4 authority
  "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL", // Raydium CPMM vault authority
  "5unTfT2kssBuNvHPY6LbJfJpLqEcdMxGYLWHwShaeTLi", // Meteora DLMM event authority
]);

/**
 * Check 3: holder concentration — after excluding known pool vaults,
 * top-10 holders must control < SAFETY_TOP10_MAX_PCT of supply and no
 * single wallet > SAFETY_SINGLE_HOLDER_MAX_PCT.
 */
export async function checkHolderConcentration(
  rpcUrl: string,
  mint: string,
  opts: { top10MaxPct: number; singleMaxPct: number; poolAddress?: string },
): Promise<SafetyCheckResult> {
  const [mintInfo, largest] = await Promise.all([
    getMintInfo(rpcUrl, mint),
    getTokenLargestAccounts(rpcUrl, mint),
  ]);
  if (!mintInfo || Number(mintInfo.supply) === 0) {
    return {
      checkName: "holder_concentration",
      passed: false,
      evidence: { error: "no mint info or zero supply" },
    };
  }

  const owners = await getTokenAccountOwners(
    rpcUrl,
    largest.map((a) => a.address),
  );

  const supply = Number(mintInfo.supply);
  const holders = largest
    .map((a) => ({
      tokenAccount: a.address,
      owner: owners.get(a.address) ?? "unknown",
      pct: (Number(a.amount) / supply) * 100,
    }))
    .filter(
      (h) =>
        !KNOWN_POOL_AUTHORITIES.has(h.owner) &&
        h.owner !== opts.poolAddress &&
        h.tokenAccount !== opts.poolAddress,
    );

  const top10Pct = holders.slice(0, 10).reduce((sum, h) => sum + h.pct, 0);
  const maxSingle = holders[0];
  const passed =
    top10Pct <= opts.top10MaxPct && (maxSingle === undefined || maxSingle.pct <= opts.singleMaxPct);

  return {
    checkName: "holder_concentration",
    passed,
    evidence: {
      top10Pct: Number(top10Pct.toFixed(2)),
      largestHolderPct: maxSingle ? Number(maxSingle.pct.toFixed(2)) : 0,
      largestHolderOwner: maxSingle?.owner ?? null,
      thresholds: { top10MaxPct: opts.top10MaxPct, singleMaxPct: opts.singleMaxPct },
      excludedPoolAccounts: largest.length - holders.length,
      holdersSampled: holders.slice(0, 10).map((h) => ({
        owner: h.owner,
        pct: Number(h.pct.toFixed(2)),
      })),
    },
  };
}
