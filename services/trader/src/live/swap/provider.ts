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
}
