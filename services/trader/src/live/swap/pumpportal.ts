/**
 * Provider — PUMPPORTAL trade-local. An INDEPENDENT (non-Jupiter) route for
 * pump.fun / pumpswap tokens (the dominant flow Jupiter's outage strands).
 * Keyless, non-custodial: POST /trade-local returns a ready-to-sign transaction
 * (we sign + simulate + send it ourselves). Verified: returns a v0 tx with our
 * wallet as fee payer.
 *
 * It is a BUILD-ONLY API — no quote/valuation. So:
 *  • quoteOnly (the guard valuing a position) → returns canValue=false WITHOUT
 *    hitting the API; the guard skips value-based cuts for these positions.
 *  • execution → builds the trade tx up front in quote() (so a non-pump token
 *    fails here and the router fails over), and buildSwapTx() returns it.
 * Sells need the token amount in UI units, so we resolve mint decimals via the
 * RPC pool (cached).
 */
import { PublicKey } from "@solana/web3.js";
import { resilientFetch, type HermesConfig } from "@hermes/core";
import { NoRouteError, type QuoteOpts, type SwapProvider, type SwapQuote } from "./provider.js";
import { WSOL_MINT } from "./jupiterHosted.js";
import { rpcPool } from "../rpc/pool.js";
import { swapFetch } from "./fetchRetry.js";

// ── ROUTABILITY PRE-CHECK (operator "we know our trades will close", 2026-07-31)
// `pumpportal build 400` was the #1 sell failure over 7 days — 24 of them, 2.7×
// the next cause, and the mechanism behind FLAPDOGE's full −$2.50 write-off on a
// meteora-damm-v2 token. The asymmetry: EVERY other direct provider resolves its
// pool inside quote() and throws NoRouteError so the router fails over, but
// PumpPortal accepted any mint and only discovered it could not build at
// buildSwapTx time — and since buildSwapTx routes back to whichever provider
// quoted, there was no failover left. A non-pump token therefore reached the
// last-resort provider and DIED there, while Meteora sat ready to build it.
//
// PumpPortal serves pump.fun-family pools only, so DexScreener's dexId is a
// sufficient and cheap test. Refuse with NoRouteError (never trips the breaker)
// when we have positive evidence the token is not pump-family; fail OPEN when we
// have no data at all, so a DexScreener outage cannot delete our last-resort
// route for tokens it genuinely can sell.
const routable = new Map<string, { ok: boolean; at: number }>();
const ROUTABLE_TTL_MS = 10 * 60_000;
async function pumpRoutable(mint: string): Promise<boolean> {
  const hit = routable.get(mint);
  if (hit && Date.now() - hit.at < ROUTABLE_TTL_MS) return hit.ok;
  try {
    const res = await resilientFetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeoutMs: 5_000 });
    if (!res.ok) return true; // no data → fail open
    const body = (await res.json()) as { pairs?: { dexId?: string }[] };
    const pairs = body.pairs ?? [];
    if (pairs.length === 0) return true; // unindexed (brand-new curve) → fail open
    const ok = pairs.some((p) => (p.dexId ?? "").toLowerCase().includes("pump"));
    routable.set(mint, { ok, at: Date.now() });
    return ok;
  } catch {
    return true; // network failure → fail open, never delete the last resort
  }
}

const decimalsCache = new Map<string, number>();
async function mintDecimals(cfg: HermesConfig, mint: string): Promise<number> {
  const cached = decimalsCache.get(mint);
  if (cached !== undefined) return cached;
  const info = await rpcPool(cfg).read((c) => c.getParsedAccountInfo(new PublicKey(mint)));
  const data = info.value?.data as { parsed?: { info?: { decimals?: number } } } | undefined;
  const dec = data?.parsed?.info?.decimals ?? 6;
  decimalsCache.set(mint, dec);
  return dec;
}

export class PumpPortalProvider implements SwapProvider {
  readonly name = "pumpportal";

  available(cfg: HermesConfig): boolean {
    return cfg.PUMPPORTAL_ENABLED;
  }

  async quote(
    cfg: HermesConfig,
    inputMint: string,
    outputMint: string,
    amountRaw: bigint,
    slippageBps: number,
    opts?: QuoteOpts,
  ): Promise<SwapQuote> {
    // Build-only: for a valuation-only call there is nothing to quote — return a
    // non-valuing marker so the guard skips it (no API/build wasted).
    if (opts?.quoteOnly) {
      return { inputMint, outputMint, inAmount: String(amountRaw), outAmount: "0", priceImpactPct: "0", provider: this.name, raw: null, canValue: false };
    }

    // PumpPortal is the last-resort provider (tried only after Jupiter + Fluxbeam),
    // and trade-local needs the real wallet — which we only get in buildSwapTx. So
    // quote() packages the request (fetching decimals for a sell) and the single
    // real API call happens in buildSwapTx. If the token isn't pump-routable, that
    // call throws there; there's no provider after PumpPortal to fail over to.
    const isBuy = inputMint === WSOL_MINT;
    const mint = isBuy ? outputMint : inputMint;
    // Resolve routability HERE so the router can still fail over — the whole
    // point of the seam. Throwing at build time strands the position instead.
    if (!(await pumpRoutable(mint))) {
      throw new NoRouteError(`not a pump-family pool: ${mint.slice(0, 8)}…`);
    }
    const amount = isBuy ? Number(amountRaw) / 1e9 : Number(amountRaw) / 10 ** (await mintDecimals(cfg, mint));
    return {
      inputMint,
      outputMint,
      inAmount: String(amountRaw),
      outAmount: "0",
      priceImpactPct: "0",
      provider: this.name,
      raw: { action: isBuy ? "buy" : "sell", mint, amount, denominatedInSol: isBuy ? "true" : "false", slippageBps },
      canValue: false,
    };
  }

  async buildSwapTx(cfg: HermesConfig, quote: SwapQuote, userPublicKey: string): Promise<string> {
    const r = quote.raw as { action: string; mint: string; amount: number; denominatedInSol: string; slippageBps: number };
    const res = await swapFetch(`${cfg.PUMPPORTAL_URL.replace(/\/$/, "")}/trade-local`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(8_000),
      body: JSON.stringify({
        publicKey: userPublicKey,
        action: r.action,
        mint: r.mint,
        amount: r.amount,
        denominatedInSol: r.denominatedInSol,
        slippage: Math.max(1, Math.round(r.slippageBps / 100)),
        priorityFee: cfg.PUMPPORTAL_PRIORITY_FEE,
        pool: cfg.PUMPPORTAL_POOL,
      }),
    });
    if (!res.ok) throw new Error(`pumpportal build ${res.status}`);
    if ((res.headers.get("content-type") ?? "").includes("application/json")) {
      const err = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(`pumpportal build: ${err?.error ?? "no tx"}`);
    }
    return Buffer.from(await res.arrayBuffer()).toString("base64");
  }
}
