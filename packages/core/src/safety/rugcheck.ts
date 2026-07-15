import type { SafetyCheckResult } from "../types.js";
import type { RugcheckReport } from "./rugcheckReport.js";

/**
 * Check: RugCheck risk report. A CONFIRMED rug is a trap (hard block) — nobody
 * should buy a token whose LP was already pulled. Danger-level risks like
 * "LP unlocked" are NOT vetoes: plenty of real movers carry them early (11 of
 * 1c's 16 movers would have been rejected on unlocked LP). They surface as soft
 * flags (see the pipeline) that shrink the position, so the convex upside stays
 * on the table with capped downside. Only `rugged` fails this check.
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
  const passed = report.rugged !== true; // trap = confirmed rug only
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
      dangers: dangers.map((r) => r.name),
      risks: risks.map((r) => ({ name: r.name, level: r.level, description: r.description })),
    },
  };
}
