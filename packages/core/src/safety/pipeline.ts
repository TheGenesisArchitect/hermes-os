import type { HermesConfig } from "../config.js";
import type { SafetyCheckResult, SafetyVerdict, TokenCandidate } from "../types.js";
import { checkHolderConcentration } from "./holders.js";
import { checkHoneypot } from "./honeypot.js";
import { checkMintAuthority } from "./mintAuthority.js";
import { checkRugcheck } from "./rugcheck.js";

/**
 * Run the full safety chain. Checks run sequentially cheapest-first so an
 * obvious fail (mintable supply) doesn't burn RPC/API calls on the rest —
 * but every check that ran is returned with its evidence.
 */
export async function runSafetyPipeline(
  cfg: HermesConfig,
  candidate: TokenCandidate,
): Promise<SafetyVerdict> {
  const checks: SafetyCheckResult[] = [];

  const run = async (fn: () => Promise<SafetyCheckResult>, name: string) => {
    try {
      const result = await fn();
      checks.push(result);
      return result.passed;
    } catch (err) {
      checks.push({
        checkName: name,
        passed: false,
        evidence: { error: err instanceof Error ? err.message : String(err), retryable: true },
      });
      return false;
    }
  };

  const mintOk = await run(
    () => checkMintAuthority(cfg.rpcUrl, candidate.mint),
    "mint_authority",
  );
  if (!mintOk) return { mint: candidate.mint, passed: false, checks };

  const holdersOk = await run(
    () =>
      checkHolderConcentration(cfg.rpcUrl, candidate.mint, {
        top10MaxPct: cfg.SAFETY_TOP10_MAX_PCT,
        singleMaxPct: cfg.SAFETY_SINGLE_HOLDER_MAX_PCT,
        poolAddress: candidate.poolAddress,
      }),
    "holder_concentration",
  );
  if (!holdersOk) return { mint: candidate.mint, passed: false, checks };

  const rugOk = await run(() => checkRugcheck(candidate.mint), "rugcheck");
  if (!rugOk) return { mint: candidate.mint, passed: false, checks };

  const honeypotOk = await run(
    () =>
      checkHoneypot(cfg.JUPITER_BASE_URL, candidate.mint, {
        maxPriceImpactPct: cfg.SAFETY_MAX_PRICE_IMPACT_PCT,
        minRoundtripRatio: cfg.SAFETY_MIN_ROUNDTRIP_RATIO,
      }),
    "honeypot_probe",
  );

  return { mint: candidate.mint, passed: honeypotOk, checks };
}
