import type { SafetyCheckResult } from "../types.js";
import type { RugcheckReport } from "./rugcheckReport.js";

/**
 * Check: RugCheck risk report — fail if the token is marked rugged or has any
 * "danger"-level risk (unlocked LP, mutable metadata combos, known scam
 * patterns). LP lock percentage is recorded as evidence.
 */
export function checkRugcheck(report: RugcheckReport | null): SafetyCheckResult {
  if (!report) {
    return {
      checkName: "rugcheck",
      passed: false,
      evidence: { error: "rugcheck has no report yet (token too new)", retryable: true },
    };
  }
  const risks = report.risks ?? [];
  const dangers = risks.filter((r) => r.level?.toLowerCase() === "danger");
  const lpLockedPct = report.markets?.[0]?.lp?.lpLockedPct ?? null;
  const passed = dangers.length === 0 && report.rugged !== true;
  return {
    checkName: "rugcheck",
    passed,
    evidence: {
      rugged: report.rugged ?? false,
      score: report.score ?? null,
      scoreNormalised: report.score_normalised ?? null,
      lpLockedPct,
      totalHolders: report.totalHolders ?? null,
      graphInsidersDetected: report.graphInsidersDetected ?? null,
      dangerCount: dangers.length,
      risks: risks.map((r) => ({ name: r.name, level: r.level, description: r.description })),
    },
  };
}
