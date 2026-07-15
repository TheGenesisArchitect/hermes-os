/** A newly discovered pool/token candidate, normalized from any ingest source. */
export interface TokenCandidate {
  mint: string;
  chain: "solana";
  name?: string;
  symbol?: string;
  poolAddress?: string;
  dex?: string;
  baseTokenMint?: string;
  liquidityUsd?: number;
  fdvUsd?: number;
  poolCreatedAt?: Date;
  raw?: unknown;
}

export interface SafetyCheckResult {
  checkName: string;
  passed: boolean;
  /** Machine-readable evidence, persisted to safety_checks.evidence. */
  evidence: Record<string, unknown>;
}

export type RiskTier = "clean" | "caution" | "speculative";

export interface SafetyVerdict {
  mint: string;
  /** Legacy alias for `tradeable` — kept so existing callers keep working. */
  passed: boolean;
  /** No trap present (honeypot / live mint or freeze authority / confirmed rug). */
  tradeable: boolean;
  /** Hard-block reasons; non-empty ⇒ not tradeable. */
  traps: string[];
  /** Soft risk flags that shrink the position instead of vetoing it. */
  riskFlags: string[];
  riskTier: RiskTier;
  /** Position-size multiplier implied by the tier (1.0 clean → smaller if risky). */
  sizeMultiplier: number;
  checks: SafetyCheckResult[];
}
