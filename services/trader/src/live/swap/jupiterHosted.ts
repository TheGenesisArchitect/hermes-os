/**
 * Provider #1 — Jupiter HOSTED API (lite-api.jup.ag / api.jup.ag). Best liquidity
 * and fastest, but bound to Jupiter's uptime — the outage this whole layer exists
 * to survive. Wraps the existing jupiter.ts client so nothing about its behavior
 * changes; it just becomes one interchangeable provider behind the router.
 */
import type { HermesConfig } from "@hermes/core";
import type { SwapProvider, SwapQuote } from "./provider.js";
import { jupQuote, jupSwapTx, WSOL_MINT, type JupQuote } from "../jupiter.js";

export { WSOL_MINT };

export class JupiterHostedProvider implements SwapProvider {
  readonly name = "jupiter-hosted";

  async quote(
    cfg: HermesConfig,
    inputMint: string,
    outputMint: string,
    amountRaw: bigint,
    slippageBps: number,
  ): Promise<SwapQuote> {
    const q = await jupQuote(cfg, inputMint, outputMint, amountRaw, slippageBps);
    return {
      inputMint,
      outputMint,
      inAmount: q.inAmount,
      outAmount: q.outAmount,
      priceImpactPct: String(q.priceImpactPct ?? 0),
      provider: this.name,
      raw: q,
    };
  }

  async buildSwapTx(cfg: HermesConfig, quote: SwapQuote, userPublicKey: string): Promise<string> {
    return jupSwapTx(cfg, quote.raw as JupQuote, userPublicKey);
  }
}
