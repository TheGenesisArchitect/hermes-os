import { getMintInfo, getTokenAccountOwners, getTokenLargestAccounts } from "../rpc.js";
import type { SafetyCheckResult } from "../types.js";
import type { RugcheckReport } from "./rugcheckReport.js";

/**
 * Owners whose balances are pool liquidity, not a person's bag — used only by
 * the RPC fallback path when RugCheck has no report yet.
 */
const KNOWN_POOL_AUTHORITIES = new Set([
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", // Raydium AMM v4 authority
  "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL", // Raydium CPMM vault authority
  "5unTfT2kssBuNvHPY6LbJfJpLqEcdMxGYLWHwShaeTLi", // Meteora DLMM event authority
]);

interface Thresholds {
  top10MaxPct: number;
  singleMaxPct: number;
  poolAddress?: string;
}

function verdictFrom(
  holders: Array<{ owner: string; pct: number; label?: string }>,
  opts: Thresholds,
  source: string,
  extra: Record<string, unknown>,
): SafetyCheckResult {
  const top10Pct = holders.slice(0, 10).reduce((sum, h) => sum + h.pct, 0);
  const largest = holders[0];
  const passed =
    top10Pct <= opts.top10MaxPct && (largest === undefined || largest.pct <= opts.singleMaxPct);
  return {
    checkName: "holder_concentration",
    passed,
    evidence: {
      source,
      top10Pct: Number(top10Pct.toFixed(2)),
      largestHolderPct: largest ? Number(largest.pct.toFixed(2)) : 0,
      largestHolderOwner: largest?.owner ?? null,
      thresholds: { top10MaxPct: opts.top10MaxPct, singleMaxPct: opts.singleMaxPct },
      holdersSampled: holders.slice(0, 10).map((h) => ({
        owner: h.owner,
        pct: Number(h.pct.toFixed(2)),
        ...(h.label ? { label: h.label } : {}),
      })),
      ...extra,
    },
  };
}

/**
 * Check: holder concentration — top-10 holders < top10MaxPct of supply, no
 * single wallet > singleMaxPct. Prefers RugCheck's topHolders (its
 * knownAccounts labels let us exclude AMM pool vaults reliably); falls back
 * to raw RPC largest-accounts when the token is too new for RugCheck.
 */
export async function checkHolderConcentration(
  rpcUrl: string,
  mint: string,
  opts: Thresholds,
  report?: RugcheckReport | null,
): Promise<SafetyCheckResult> {
  if (report?.topHolders && report.topHolders.length > 0) {
    const known = report.knownAccounts ?? {};
    const isPoolAccount = (h: { address: string; owner: string }) => {
      const label = known[h.address]?.type ?? known[h.owner]?.type;
      return label === "AMM" || label === "LOCKER" || h.owner === opts.poolAddress;
    };
    const holders = report.topHolders
      .filter((h) => !isPoolAccount(h))
      .map((h) => ({
        owner: h.owner,
        pct: h.pct,
        label: known[h.address]?.name ?? known[h.owner]?.name,
      }));
    const excluded = report.topHolders.length - holders.length;
    const insiders = report.topHolders.filter((h) => h.insider).length;
    return verdictFrom(holders, opts, "rugcheck", {
      excludedPoolAccounts: excluded,
      insiderFlagged: insiders,
      totalHolders: report.totalHolders ?? null,
    });
  }

  // RPC fallback — brand-new token, RugCheck hasn't indexed it yet
  const [mintInfo, largest] = await Promise.all([
    getMintInfo(rpcUrl, mint),
    getTokenLargestAccounts(rpcUrl, mint),
  ]);
  if (!mintInfo || Number(mintInfo.supply) === 0) {
    return {
      checkName: "holder_concentration",
      passed: false,
      evidence: { error: "no mint info or zero supply", retryable: true },
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
  return verdictFrom(holders, opts, "rpc", {
    excludedPoolAccounts: largest.length - holders.length,
  });
}
