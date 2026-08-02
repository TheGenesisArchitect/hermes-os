/**
 * SWAP PROVIDER interface — the resilience seam. Every way of quoting + building
 * a Solana swap (Jupiter hosted, self-hosted Jupiter, direct-DEX per venue)
 * implements this. The SwapRouter fails over across them so no single provider
 * outage can halt execution. "Down is not an option."
 */
import type { HermesConfig } from "@hermes/core";

export interface SwapQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  provider: string; // which provider produced this quote
  raw: unknown; // provider-specific payload consumed by buildSwapTx
  // Whether outAmount is a real valuation. Build-only providers (PumpPortal)
  // return a ready tx but no quote — canValue=false tells the guard "don't
  // value/cut off this quote". Defaults to true (Jupiter/Fluxbeam).
  canValue?: boolean;
}

export interface QuoteOpts {
  // The guard calls quote() only to VALUE a position, never to execute — a
  // build-only provider must NOT build a tx in this case (wasteful + pointless).
  quoteOnly?: boolean;
  /** Providers to skip — entry failover re-quotes around a venue that just
   * rejected the build (58 of 81 buy failures in 48h were one venue's 400s
   * on migrated tokens, 69% of which went on to win). */
  exclude?: string[];
  /** A protective exit walks past OPEN breakers (QTEA-007): a breaker tripped
   * by buy-path failures must never suppress a provider during a flee. The
   * provider is still tried in order and still records new trips. */
  protective?: boolean;
}

export interface SwapProvider {
  readonly name: string;
  /** Whether this provider is configured/usable right now. The router SKIPS an
   *  unavailable provider without tripping its breaker (e.g. self-hosted with no
   *  URL set). Defaults to true when omitted. */
  available?(cfg: HermesConfig): boolean;
  /** Quote a swap. Throws on unreachable / no-route — the router treats as failover. */
  quote(
    cfg: HermesConfig,
    inputMint: string,
    outputMint: string,
    amountRaw: bigint,
    slippageBps: number,
    opts?: QuoteOpts,
  ): Promise<SwapQuote>;
  /** Build a signed-ready base64 VersionedTransaction for this quote + wallet. */
  buildSwapTx(cfg: HermesConfig, quote: SwapQuote, userPublicKey: string): Promise<string>;
  /** QTEA-003 — EXECUTABLE MARK. A direct provider that can price a sell from
   *  its own pool state implements this: read reserves, run the venue's swap
   *  math, return a real outAmount (lamports) + impact FRACTION — no tx built,
   *  no breaker touched. The router's valuation walk prefers cheap aggregator
   *  quotes and falls to these exactly in the fresh-pool window where the
   *  aggregator is blind — the minutes where these tokens live and die. */
  quoteSellValue?(cfg: HermesConfig, mint: string, amountRaw: bigint): Promise<SwapQuote>;
}

/**
 * A CLEAN REFUSAL — "this token is not my protocol" — as opposed to a provider
 * FAILURE. The router walks past a NoRouteError without tripping the breaker:
 * every non-Meteora token used to trip the Meteora providers one throw at a
 * time, opening their circuits exactly when a real Meteora candidate needed
 * them (measured: meteora-dbc circuit OPEN warnings every few minutes on
 * ordinary pumpswap flow).
 */
export class NoRouteError extends Error {}
