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

export interface SafetyVerdict {
  mint: string;
  passed: boolean;
  checks: SafetyCheckResult[];
}
