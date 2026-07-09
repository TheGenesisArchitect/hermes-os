import { getMintInfo } from "../rpc.js";
import type { SafetyCheckResult } from "../types.js";

/**
 * Check 1: mint authority must be revoked (nobody can print more supply)
 * and freeze authority must be null (nobody can freeze holder accounts).
 */
export async function checkMintAuthority(
  rpcUrl: string,
  mint: string,
): Promise<SafetyCheckResult> {
  const info = await getMintInfo(rpcUrl, mint);
  if (!info) {
    return {
      checkName: "mint_authority",
      passed: false,
      evidence: { error: "mint account not found or not parseable" },
    };
  }
  const mintRevoked = info.mintAuthority === null;
  const freezeNull = info.freezeAuthority === null;
  return {
    checkName: "mint_authority",
    passed: mintRevoked && freezeNull,
    evidence: {
      mintAuthority: info.mintAuthority,
      freezeAuthority: info.freezeAuthority,
      supply: info.supply,
      decimals: info.decimals,
    },
  };
}
