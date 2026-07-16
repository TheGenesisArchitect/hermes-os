/**
 * Jupiter swap API client for the live lane (lite-api.jup.ag/swap/v1 —
 * verified reachable 2026-07-15 through GoodbyeDPI; every call carries an
 * AbortSignal timeout per the fetch-hang lesson).
 *
 * Flow: quote → swap-build (returns a base64 VersionedTransaction with our
 * pubkey as fee payer) → caller signs + sends. This module does NO signing
 * and holds NO keys.
 */
import type { HermesConfig } from "@hermes/core";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export interface JupQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  routePlan: unknown[];
  [k: string]: unknown;
}

function swapBase(cfg: HermesConfig): string {
  // JUPITER_BASE_URL is already the swap API base (…/swap/v1) — used as-is.
  return cfg.JUPITER_BASE_URL.replace(/\/$/, "");
}

/** Fetch a swap quote. Throws on unreachable/no-route — callers treat as skip. */
export async function jupQuote(
  cfg: HermesConfig,
  inputMint: string,
  outputMint: string,
  amountRaw: bigint,
  slippageBps: number,
): Promise<JupQuote> {
  const url =
    `${swapBase(cfg)}/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
    `&amount=${amountRaw.toString()}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`jup quote ${res.status}`);
  const body = (await res.json()) as JupQuote & { error?: string };
  if (body.error || !body.outAmount) throw new Error(`jup quote: ${body.error ?? "no route"}`);
  return body;
}

/** Build the swap transaction for a quote. Returns base64 VersionedTransaction. */
export async function jupSwapTx(cfg: HermesConfig, quote: JupQuote, userPublicKey: string): Promise<string> {
  const res = await fetch(`${swapBase(cfg)}/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(8_000),
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { priorityLevel: "high", maxLamports: 2_000_000 } },
    }),
  });
  if (!res.ok) throw new Error(`jup swap-build ${res.status}`);
  const body = (await res.json()) as { swapTransaction?: string; error?: string };
  if (!body.swapTransaction) throw new Error(`jup swap-build: ${body.error ?? "no transaction"}`);
  return body.swapTransaction;
}
