/**
 * Provider — DIRECT PUMPSWAP AMM. The route that actually reaches the money:
 * Paper's morning edge is ~all graduated PumpSwap AMM tokens (BRIBE 111×/+$750
 * and every top winner), and NONE of the other non-Jupiter routes can touch them
 * — Fluxbeam has "no pool", and PumpPortal 400s because they're OTHER-origin
 * (Meteora-DBC/bags graduations, not pump.fun). So we build swaps against the
 * PumpSwap AMM program directly, via the official @pump-fun/pump-swap-sdk.
 *
 * Flow (per advisor's acceptance criteria, all exercised by _pstest before live):
 *  1. Pool from DexScreener pairAddress (dexId=pumpswap) — works for non-canonical
 *     pools that canonicalPumpPoolPda() can't derive.
 *  2. SDK Connection uses the curl-fallback transport (rpcConnection) or every
 *     account read gets DPI-reset on this host.
 *  3. fetchPool asserts base===token && quote===WSOL before trusting the direction
 *     (a USDC-quote or flipped pool would build a nonsense trade — throw instead).
 *  4. buyQuoteInput(SOL in) / sellBaseInput(token in); slippage is a PERCENT.
 *  5. Prepend a compute-budget (priority fee) — the SDK ixs are app-agnostic and
 *     would otherwise not land in moonshot-hour congestion.
 * Build-only (no valuation): quoteOnly returns canValue=false without any work.
 */
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import BN from "bn.js";
import { OnlinePumpAmmSdk, PumpAmmSdk } from "@pump-fun/pump-swap-sdk";
import { resilientFetch, type HermesConfig } from "@hermes/core";
import { NoRouteError, type QuoteOpts, type SwapProvider, type SwapQuote } from "./provider.js";
import { WSOL_MINT } from "./jupiterHosted.js";
import { rpcConnection, rpcPool } from "../rpc/pool.js";

interface PumpSwapRaw {
  isBuy: boolean;
  mint: string;
  pool: string;
  amountRaw: string;
  slippageBps: number;
}

/** Resolve the PumpSwap pool account for a mint. DexScreener's pairAddress for a
 *  dexId=pumpswap pair IS the AMM pool state account swapSolanaState() expects. */
async function pumpswapPool(mint: string): Promise<string | null> {
  const res = await resilientFetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeoutMs: 6_000 });
  if (!res.ok) return null;
  const body = (await res.json()) as { pairs?: { dexId: string; pairAddress: string; liquidity?: { usd?: number } }[] };
  const pools = (body.pairs ?? []).filter((p) => p.dexId === "pumpswap" && p.pairAddress);
  if (pools.length === 0) return null;
  pools.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  return pools[0]!.pairAddress;
}

export class PumpSwapProvider implements SwapProvider {
  readonly name = "pumpswap";

  available(cfg: HermesConfig): boolean {
    return cfg.PUMPSWAP_ENABLED;
  }

  async quote(
    cfg: HermesConfig,
    inputMint: string,
    outputMint: string,
    amountRaw: bigint,
    slippageBps: number,
    opts?: QuoteOpts,
  ): Promise<SwapQuote> {
    if (opts?.quoteOnly) {
      return { inputMint, outputMint, inAmount: String(amountRaw), outAmount: "0", priceImpactPct: "0", provider: this.name, raw: null, canValue: false };
    }
    const isBuy = inputMint === WSOL_MINT;
    const mint = isBuy ? outputMint : inputMint;
    // Resolve the pool here so a non-pumpswap token (e.g. a bonding-curve %pump)
    // throws and the router fails over to PumpPortal — clean venue separation
    // without a hardcoded venue check.
    let pool = await pumpswapPool(mint);
    if (!pool) {
      // MIGRATION-WINDOW FALLBACK (2026-07-27, specimen CATE Dg5P −$1.88):
      // a token that graduates MID-TRADE has a live PumpSwap pool minutes
      // before DexScreener indexes it — the curve provider correctly declines
      // ("complete"), pumpportal 400s (migrated), and this provider blinded
      // itself by asking only DexScreener. Derive the canonical pool PDA
      // locally and verify it EXISTS on-chain (quote-time verification — a
      // phantom pool must NoRoute here, never strand the build).
      try {
        const { canonicalPumpPoolPda } = await import("@pump-fun/pump-sdk");
        const derived = canonicalPumpPoolPda(new PublicKey(mint));
        const info = await rpcPool(cfg).read((c) => c.getAccountInfo(derived, "confirmed"));
        if (info) pool = derived.toBase58();
      } catch {
        /* derivation/read failed — fall through to NoRoute */
      }
    }
    if (!pool) throw new NoRouteError("no pumpswap pool");
    const raw: PumpSwapRaw = { isBuy, mint, pool, amountRaw: amountRaw.toString(), slippageBps };
    return {
      inputMint,
      outputMint,
      inAmount: String(amountRaw),
      outAmount: "0",
      // On-chain slippage (from slippageBps) protects the fill; there is no quoted
      // impact, so the caller's impact check is a no-op here — same as PumpPortal.
      priceImpactPct: "0",
      provider: this.name,
      raw,
      canValue: false,
    };
  }

  async buildSwapTx(cfg: HermesConfig, quote: SwapQuote, userPublicKey: string): Promise<string> {
    const { isBuy, mint, pool, amountRaw, slippageBps } = quote.raw as PumpSwapRaw;
    const conn = rpcConnection(cfg);
    const online = new OnlinePumpAmmSdk(conn);
    const offline = new PumpAmmSdk();
    const user = new PublicKey(userPublicKey);
    const poolKey = new PublicKey(pool);

    // (advisor #3) Trust the DexScreener pool only after confirming it is a
    // token↔WSOL pool. But do NOT assume which side is base: PumpSwap pools come in
    // BOTH orientations (this token graduated with base=WSOL, quote=token). A
    // USDC-quote or unrelated pool has neither of our two mints → fail over.
    const p = await online.fetchPool(poolKey);
    const baseMint = p.baseMint.toBase58();
    const quoteMint = p.quoteMint.toBase58();
    const mints = new Set([baseMint, quoteMint]);
    if (!mints.has(WSOL_MINT) || !mints.has(mint)) {
      throw new Error(`pumpswap pool not token↔WSOL (base=${baseMint} quote=${quoteMint}, want ${mint}↔WSOL)`);
    }

    const state = await online.swapSolanaState(poolKey, user);
    const slipPct = slippageBps / 100; // SDK slippage is a percent (0–100)
    const amt = new BN(amountRaw);
    // Orientation-agnostic: I always know my INPUT (WSOL on a buy, token on a sell)
    // and its amount. Giving the pool's BASE → sellBaseInput; giving its QUOTE →
    // buyQuoteInput. Both are "input" fns (specify what I put in), so `amt` is the
    // input amount either way and the min-out is protected by slippage.
    const inputMint = isBuy ? WSOL_MINT : mint;
    const inputIsBase = inputMint === baseMint;
    const swapIxs = inputIsBase
      ? await offline.sellBaseInput(state, amt, slipPct) // give base (input), receive quote
      : await offline.buyQuoteInput(state, amt, slipPct); // spend quote (input), receive base

    // (advisor #2) The SDK ixs carry no priority fee — prepend a compute budget so
    // the tx lands under congestion. PUMPPORTAL_PRIORITY_FEE is a total SOL budget;
    // convert to a per-CU price over the unit limit.
    const cuLimit = 300_000;
    const priorityLamports = Math.round(cfg.PUMPPORTAL_PRIORITY_FEE * 1e9);
    const microLamports = Math.max(1, Math.floor((priorityLamports * 1e6) / cuLimit));
    const ixs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
      ...swapIxs,
    ];

    const { blockhash } = await rpcPool(cfg).read((c) => c.getLatestBlockhash("confirmed"));
    const msg = new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
    return Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64");
  }
}
