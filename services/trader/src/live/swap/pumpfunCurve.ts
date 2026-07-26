/**
 * Provider — DIRECT PUMP.FUN BONDING CURVE, SELL-ONLY.
 *
 * The last write-off class (2026-07-26): bonding-curve pump.fun tokens where
 * every route declines (no AMM pool yet — PumpSwap/Jupiter/Fluxbeam/Meteora
 * all NoRoute) and PumpPortal, the only builder left, 400s the sell — the
 * position books `live_unsellable` while the paper twin banks the same wave
 * (#memecoin: live −$2.50 vs twin +$9.24). This provider builds the curve
 * sell instruction locally via the official @pump-fun/pump-sdk — the exact
 * pattern of PumpSwapProvider one protocol earlier in the lifecycle.
 *
 * SELL-ONLY by design: buys on curve tokens land fine through PumpPortal
 * today, and the smallest money-path surface is the safest. A buy or a
 * non-curve token throws NoRouteError and the router walks on unchanged.
 */
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import BN from "bn.js";
import { OnlinePumpSdk, PumpSdk, getSellSolAmountFromTokenAmount } from "@pump-fun/pump-sdk";
import type { HermesConfig } from "@hermes/core";
import { NoRouteError, type QuoteOpts, type SwapProvider, type SwapQuote } from "./provider.js";
import { WSOL_MINT } from "./jupiterHosted.js";
import { rpcConnection, rpcPool } from "../rpc/pool.js";

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

interface CurveRaw {
  mint: string;
  amountRaw: string;
  slippageBps: number;
}

export class PumpFunCurveProvider implements SwapProvider {
  readonly name = "pumpfun-curve";

  async quote(
    _cfg: HermesConfig,
    inputMint: string,
    outputMint: string,
    amountRaw: bigint,
    slippageBps: number,
    opts?: QuoteOpts,
  ): Promise<SwapQuote> {
    if (opts?.quoteOnly) {
      return { inputMint, outputMint, inAmount: String(amountRaw), outAmount: "0", priceImpactPct: "0", provider: this.name, raw: null, canValue: false };
    }
    // Sells only: input is the token, output is SOL.
    if (inputMint === WSOL_MINT || outputMint !== WSOL_MINT) {
      throw new NoRouteError("pumpfun-curve is sell-only");
    }
    // Cheap protocol check happens in buildSwapTx (fetchSellState throws for
    // non-curve mints); here we only refuse the obviously-wrong direction so a
    // dead pool doesn't cost the router an RPC read at quote time. Build-only:
    // on-chain slippage protects the fill, no quoted valuation.
    const raw: CurveRaw = { mint: inputMint, amountRaw: amountRaw.toString(), slippageBps };
    return {
      inputMint,
      outputMint,
      inAmount: String(amountRaw),
      outAmount: "0",
      priceImpactPct: "0",
      provider: this.name,
      raw,
      canValue: false,
    };
  }

  async buildSwapTx(cfg: HermesConfig, quote: SwapQuote, userPublicKey: string): Promise<string> {
    const { mint, amountRaw, slippageBps } = quote.raw as CurveRaw;
    const conn = rpcConnection(cfg);
    const online = new OnlinePumpSdk(conn);
    const offline = new PumpSdk();
    const user = new PublicKey(userPublicKey);
    const mintKey = new PublicKey(mint);

    // fetchSellState throws when the mint has no bonding curve — the router
    // treats that as failover (graduated/AMM tokens belong to earlier
    // providers; this one owns only the live curve).
    let state;
    try {
      state = await online.fetchSellState(mintKey, user, TOKEN_PROGRAM);
    } catch (e) {
      throw new NoRouteError(`no live bonding curve (${e instanceof Error ? e.message.slice(0, 60) : "fetch failed"})`);
    }
    if ((state.bondingCurve as { complete?: boolean }).complete) {
      throw new NoRouteError("curve complete — graduated, AMM providers own it");
    }

    const amount = new BN(amountRaw);
    const global = await online.fetchGlobal();
    // Expected SOL out from the curve math — the slippage floor hangs off this.
    // feeConfig/mintSupply feed the fee-exact path; fall back to a zero-floor
    // fire-sale ONLY if the estimate itself fails (an exit that lands beats a
    // perfect price on a draining curve).
    let solAmount = new BN(0);
    try {
      const feeConfig = await online.fetchFeeConfig().catch(() => null);
      const supply = await rpcPool(cfg).read((c) => c.getTokenSupply(mintKey));
      solAmount = getSellSolAmountFromTokenAmount({
        global,
        feeConfig,
        mintSupply: new BN(supply.value.amount),
        bondingCurve: state.bondingCurve,
        amount,
      });
    } catch {
      /* zero floor — fire-sale semantics for a curve mid-drain */
    }

    const ixs = await offline.sellInstructions({
      global,
      bondingCurveAccountInfo: state.bondingCurveAccountInfo,
      bondingCurve: state.bondingCurve,
      mint: mintKey,
      user,
      amount,
      solAmount,
      slippage: slippageBps / 100, // SDK slippage is a percent
      tokenProgram: TOKEN_PROGRAM,
      mayhemMode: false,
    });

    // Same priority-fee treatment as PumpSwapProvider — SDK ixs carry none.
    const cuLimit = 300_000;
    const priorityLamports = Math.round(cfg.PUMPPORTAL_PRIORITY_FEE * 1e9);
    const microLamports = Math.max(1, Math.floor((priorityLamports * 1e6) / cuLimit));
    const all = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
      ...ixs,
    ];
    const { blockhash } = await rpcPool(cfg).read((c) => c.getLatestBlockhash("confirmed"));
    const msg = new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: all }).compileToV0Message();
    return Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64");
  }
}
