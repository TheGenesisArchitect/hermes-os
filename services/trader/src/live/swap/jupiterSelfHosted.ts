/**
 * Provider #2 — SELF-HOSTED Jupiter Swap API. Same `/quote` + `/swap` shape as
 * the hosted API, pointed at OUR jupiter-swap-api container (JUPITER_SELFHOSTED_URL,
 * e.g. http://localhost:8080/swap/v1). This is the "own your execution" anchor:
 * when Jupiter's HOSTED tier is down, this keeps live execution alive on OUR
 * uptime + RPC. Dormant (skipped, breaker untouched) until the URL is configured
 * and the container is up — see docs/SWAP_ROUTE_RESILIENCE_SPEC.md.
 */
import type { HermesConfig } from "@hermes/core";
import type { SwapProvider, SwapQuote } from "./provider.js";
import type { JupQuote } from "../jupiter.js";

export class JupiterSelfHostedProvider implements SwapProvider {
  readonly name = "jupiter-selfhosted";

  available(cfg: HermesConfig): boolean {
    return !!cfg.JUPITER_SELFHOSTED_URL;
  }

  private base(cfg: HermesConfig): string {
    return cfg.JUPITER_SELFHOSTED_URL.replace(/\/$/, "");
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
      `&amount=${amountRaw.toString()}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`selfhosted quote ${res.status}`);
    const body = (await res.json()) as JupQuote & { error?: string };
    if (body.error || !body.outAmount) throw new Error(`selfhosted quote: ${body.error ?? "no route"}`);
    return {
      inputMint,
      outputMint,
      inAmount: body.inAmount,
      outAmount: body.outAmount,
      priceImpactPct: String(body.priceImpactPct ?? 0),
      provider: this.name,
      raw: body,
    };
  }

  async buildSwapTx(cfg: HermesConfig, quote: SwapQuote, userPublicKey: string): Promise<string> {
    const res = await fetch(`${this.base(cfg)}/swap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(8_000),
      body: JSON.stringify({
        quoteResponse: quote.raw,
        userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: { priorityLevelWithMaxLamports: { priorityLevel: "high", maxLamports: 2_000_000 } },
      }),
    });
    if (!res.ok) throw new Error(`selfhosted swap-build ${res.status}`);
    const body = (await res.json()) as { swapTransaction?: string; error?: string };
    if (!body.swapTransaction) throw new Error(`selfhosted swap-build: ${body.error ?? "no transaction"}`);
    return body.swapTransaction;
  }
}
