import type { SafetyCheckResult } from "../types.js";

interface RugcheckRisk {
  name: string;
  level: string; // "danger" | "warn" | "info" (rugcheck.xyz vocabulary)
  description?: string;
  score?: number;
}

interface RugcheckSummary {
  score?: number;
  score_normalised?: number;
  risks?: RugcheckRisk[];
}

/**
 * Check 2: RugCheck report summary — fail on any "danger"-level risk
 * (unlocked LP, mutable metadata + authority combos, known scam patterns).
 * LP burn/lock status is part of what RugCheck evaluates.
 */
export async function checkRugcheck(mint: string): Promise<SafetyCheckResult> {
  const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`, {
    headers: { accept: "application/json" },
  });
  if (res.status === 404 || res.status === 400) {
    // Too new for RugCheck to have indexed — treat as not-yet-passed, retryable
    return {
      checkName: "rugcheck",
      passed: false,
      evidence: { error: `rugcheck has no report yet (HTTP ${res.status})`, retryable: true },
    };
  }
  if (!res.ok) throw new Error(`rugcheck HTTP ${res.status}`);
  const summary = (await res.json()) as RugcheckSummary;
  const risks = summary.risks ?? [];
  const dangers = risks.filter((r) => r.level?.toLowerCase() === "danger");
  return {
    checkName: "rugcheck",
    passed: dangers.length === 0,
    evidence: {
      score: summary.score ?? null,
      scoreNormalised: summary.score_normalised ?? null,
      dangerCount: dangers.length,
      risks: risks.map((r) => ({ name: r.name, level: r.level, description: r.description })),
    },
  };
}
