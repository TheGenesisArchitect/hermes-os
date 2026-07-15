import type { HermesConfig } from "../config.js";
import type { RiskTier, SafetyCheckResult, SafetyVerdict, TokenCandidate } from "../types.js";
import { checkHolderConcentration } from "./holders.js";
import { checkHoneypot } from "./honeypot.js";
import { checkMintAuthority } from "./mintAuthority.js";
import { checkRugcheck } from "./rugcheck.js";
import { fetchRugcheckReport, type RugcheckReport } from "./rugcheckReport.js";

const LP_LOCKED_MIN_PCT = 50; // below this, LP is "unlocked" — a soft flag, not a veto
const LOW_HOLDERS = 30; // fewer holders than this is thin — a soft flag

function tierFor(cfg: HermesConfig, flags: string[]): { tier: RiskTier; size: number } {
  if (flags.length === 0) return { tier: "clean", size: 1 };
  if (flags.length === 1) return { tier: "caution", size: cfg.RISK_SIZE_CAUTION };
  return { tier: "speculative", size: cfg.RISK_SIZE_SPECULATIVE };
}

/**
 * Run the safety chain and return a RISK-TIERED verdict.
 *
 * The design principle (the core mission is the opportunity, not the barrier):
 * only outright TRAPS hard-block, because they have zero upside —
 *   • honeypot (you can't sell),
 *   • live mint authority (infinite dilution),
 *   • live freeze authority (your bag can be frozen),
 *   • a CONFIRMED rug (LP already pulled).
 * Everything else — unlocked LP, holder concentration, few holders — is a SOFT
 * flag. It doesn't veto the trade; it shrinks the position (risk-tier sizing) so
 * the convex upside stays reachable with capped downside. 1c's data justified
 * this: 11 of 16 movers would have been hard-rejected on unlocked LP alone.
 */
export async function runSafetyPipeline(
  cfg: HermesConfig,
  candidate: TokenCandidate,
): Promise<SafetyVerdict> {
  const checks: SafetyCheckResult[] = [];
  const traps: string[] = [];
  const riskFlags = new Set<string>();

  const run = async (fn: () => Promise<SafetyCheckResult>, name: string): Promise<boolean> => {
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

  const notTradeable = (): SafetyVerdict => ({
    mint: candidate.mint,
    passed: false,
    tradeable: false,
    traps,
    riskFlags: [...riskFlags],
    riskTier: "speculative",
    sizeMultiplier: 0,
    checks,
  });

  // One keyless RugCheck report feeds mint authority, rug status, and holders —
  // so the pipeline needs no Solana RPC (blocked / credit-exhausted on this host).
  let report: RugcheckReport | null = null;
  try {
    report = await fetchRugcheckReport(candidate.mint);
  } catch {
    report = null; // transient — checks below fall back / mark retryable
  }

  // TRAP: mint or freeze authority still live (infinite dilution / freeze).
  const mintOk = await run(() => checkMintAuthority(report, cfg.rpcUrl, candidate.mint), "mint_authority");
  if (!mintOk) {
    traps.push("mint_or_freeze_active");
    return notTradeable();
  }

  // TRAP: confirmed rug (LP already pulled). Danger risks are soft, handled below.
  const rugOk = await run(async () => checkRugcheck(report), "rugcheck");
  if (!rugOk) {
    traps.push("rugged");
    return notTradeable();
  }

  // SOFT: holder concentration — flag, don't veto.
  const holdersOk = await run(
    () =>
      checkHolderConcentration(
        cfg.rpcUrl,
        candidate.mint,
        {
          top10MaxPct: cfg.SAFETY_TOP10_MAX_PCT,
          singleMaxPct: cfg.SAFETY_SINGLE_HOLDER_MAX_PCT,
          poolAddress: candidate.poolAddress,
        },
        report,
      ),
    "holder_concentration",
  );
  if (!holdersOk) riskFlags.add("holder_concentration");

  // TRAP: honeypot — a CONFIRMED buy-ok/sell-bad token has no upside. But if the
  // probe is INCONCLUSIVE (Jupiter unreachable, or the fresh pool isn't routable on
  // Jupiter yet) we must NOT hard-reject — that fails closed and a Jupiter outage
  // silently halts the entire pipeline (the "no activity" stall). Inconclusive →
  // soft-flag + size down; only a definitive honeypot traps.
  let honeypot: SafetyCheckResult;
  try {
    honeypot = await checkHoneypot(cfg.JUPITER_BASE_URL, candidate.mint, {
      maxPriceImpactPct: cfg.SAFETY_MAX_PRICE_IMPACT_PCT,
      minRoundtripRatio: cfg.SAFETY_MIN_ROUNDTRIP_RATIO,
    });
  } catch (err) {
    honeypot = {
      checkName: "honeypot_probe",
      passed: false,
      evidence: { inconclusive: true, error: err instanceof Error ? err.message : String(err) },
    };
  }
  checks.push(honeypot);
  if (!honeypot.passed) {
    if ((honeypot.evidence as { inconclusive?: boolean } | undefined)?.inconclusive) {
      riskFlags.add("honeypot_unverified"); // couldn't prove sellability — size down, don't halt
    } else {
      traps.push("honeypot");
      return notTradeable();
    }
  }

  // Remaining soft flags from the RugCheck report.
  const lpLockedPct = report?.markets?.[0]?.lp?.lpLockedPct;
  if (lpLockedPct != null && lpLockedPct < LP_LOCKED_MIN_PCT) riskFlags.add("lp_unlocked");
  if (report?.totalHolders != null && report.totalHolders < LOW_HOLDERS) riskFlags.add("low_holders");

  const flags = [...riskFlags];
  const { tier, size } = tierFor(cfg, flags);
  return {
    mint: candidate.mint,
    passed: true,
    tradeable: true,
    traps: [],
    riskFlags: flags,
    riskTier: tier,
    sizeMultiplier: size,
    checks,
  };
}
