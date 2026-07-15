import { getMintInfo } from "../rpc.js";
import type { SafetyCheckResult } from "../types.js";
import type { RugcheckReport } from "./rugcheckReport.js";

/**
 * Check 1: mint authority must be revoked (nobody can print more supply) and
 * freeze authority must be null (nobody can freeze holder accounts).
 *
 * Sourced from RugCheck's report (keyless HTTP) so the pipeline doesn't depend
 * on a Solana RPC — the public RPCs are network-blocked and Helius credits are
 * exhausted. Falls back to a direct RPC read only when RugCheck hasn't indexed
 * the token yet; if that RPC is also down the check fails retryably and the
 * token is re-evaluated on a later poll (fail-closed, never enters unverified).
 */
export async function checkMintAuthority(
  report: RugcheckReport | null,
  rpcUrl: string,
  mint: string,
): Promise<SafetyCheckResult> {
  if (report && ("mintAuthority" in report || "freezeAuthority" in report)) {
    const mintRevoked = report.mintAuthority == null; // null/undefined = revoked
    const freezeNull = report.freezeAuthority == null;
    return {
      checkName: "mint_authority",
      passed: mintRevoked && freezeNull,
      evidence: {
        source: "rugcheck",
        mintAuthority: report.mintAuthority ?? null,
        freezeAuthority: report.freezeAuthority ?? null,
      },
    };
  }

  // RPC fallback — token too new for RugCheck (or no report). Dead RPC ⇒
  // retryable fail, so the token is retried, never passed unverified.
  const info = await getMintInfo(rpcUrl, mint);
  if (!info) {
    return {
      checkName: "mint_authority",
      passed: false,
      evidence: { error: "no rugcheck report and mint account not found/parseable", retryable: true },
    };
  }
  const mintRevoked = info.mintAuthority === null;
  const freezeNull = info.freezeAuthority === null;
  return {
    checkName: "mint_authority",
    passed: mintRevoked && freezeNull,
    evidence: {
      source: "rpc",
      mintAuthority: info.mintAuthority,
      freezeAuthority: info.freezeAuthority,
      supply: info.supply,
      decimals: info.decimals,
    },
  };
}
