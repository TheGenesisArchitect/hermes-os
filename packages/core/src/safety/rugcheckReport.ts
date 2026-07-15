/** Shared fetch of RugCheck's full token report — one call feeds both the
 * rugcheck risk check and the holder-concentration check. */

export interface RugcheckHolder {
  address: string;
  owner: string;
  pct: number;
  insider: boolean;
}

export interface RugcheckReport {
  mint: string;
  // SPL mint authorities as RugCheck parses them: null = revoked/none (safe),
  // a base58 address = still active (unsafe). Present on any indexed token.
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  rugged?: boolean;
  score?: number;
  score_normalised?: number;
  risks?: Array<{ name: string; level: string; description?: string }>;
  topHolders?: RugcheckHolder[];
  knownAccounts?: Record<string, { name: string; type: string }>;
  totalHolders?: number;
  totalMarketLiquidity?: number;
  graphInsidersDetected?: number;
  markets?: Array<{ lp?: { lpLockedPct?: number; lpLockedUSD?: number } }>;
}

/** Returns null when RugCheck hasn't indexed the token yet (brand-new mints). */
export async function fetchRugcheckReport(mint: string): Promise<RugcheckReport | null> {
  const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5000), // never let a filtered host hang the safety pipeline
  });
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error(`rugcheck HTTP ${res.status}`);
  return (await res.json()) as RugcheckReport;
}
