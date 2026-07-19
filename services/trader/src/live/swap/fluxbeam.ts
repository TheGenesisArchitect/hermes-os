/**
 * Provider — FLUXBEAM swap API. An INDEPENDENT (non-Jupiter) route for
 * Fluxbeam-routable tokens (our 'fluxbeam' premium venue), so a Jupiter outage
 * can't strand a Fluxbeam position. Keyless HTTP API, verified live:
 *   GET  /v1/quote?inputMint&outputMint&amount&slippageBps → { quote: {...} }
 *   POST /v1/swap  { quote, userPublicKey }                → { transaction }
 * Only quotes tokens with Fluxbeam liquidity — for anything else the quote
 * throws and the router fails over to the next provider.
 */
import type { HermesConfig } from "@hermes/core";
import type { SwapProvider, SwapQuote } from "./provider.js";
import { swapFetch } from "./fetchRetry.js";

interface FluxQuote {
  program: string;
  pool: string;
  inputMint: string;
  outputMint: string;
  amountIn: number;
  outAmount: number;
  minimumOut: number; // slippage-protected floor — enforced on-chain by the swap
}

export class FluxbeamProvider implements SwapProvider {
  readonly name = "fluxbeam";

  available(cfg: HermesConfig): boolean {
    return cfg.FLUXBEAM_ENABLED;
  }

  private base(cfg: HermesConfig): string {
    return cfg.FLUXBEAM_API_URL.replace(/\/$/, "");
  }

  async quote(
    cfg: HermesConfig,
    inputMint: string,
    outputMint: string,
    amountRaw: bigint,
    slippageBps: number,
  ): Promise<SwapQuote> {
    const url =
      `${this.base(cfg)}/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
      `&amount=${amountRaw.toString()}&slippageBps=${slippageBps}`;
    const res = await swapFetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`fluxbeam quote ${res.status}`);
    const body = (await res.json()) as { quote?: FluxQuote; error?: string };
    if (body.error || !body.quote?.outAmount) throw new Error(`fluxbeam quote: ${body.error ?? "no route"}`);
    const q = body.quote;
    return {
      inputMint,
      outputMint,
      inAmount: String(q.amountIn),
      outAmount: String(q.outAmount),
      // Fluxbeam doesn't return price impact; the on-chain minimumOut (from
      // slippageBps) protects the actual fill, and the guard's catastrophe-
      // drawdown check backstops the sell side.
      priceImpactPct: "0",
      provider: this.name,
      raw: q,
    };
  }

  async buildSwapTx(cfg: HermesConfig, quote: SwapQuote, userPublicKey: string): Promise<string> {
    const res = await swapFetch(`${this.base(cfg)}/swap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(8_000),
      body: JSON.stringify({ quote: quote.raw, userPublicKey }),
    });
    if (!res.ok) throw new Error(`fluxbeam swap-build ${res.status}`);
    const body = (await res.json()) as { transaction?: string; error?: string };
    if (!body.transaction) throw new Error(`fluxbeam swap-build: ${body.error ?? "no transaction"}`);
    return body.transaction;
  }
}
