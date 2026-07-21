/**
 * Providers — DIRECT METEORA. The venues that produce the edge and that NOTHING
 * else can execute: on 2026-07-21 paper's entire session profit (+$97, 63% win)
 * came from meteora-damm-v2, while every live buy attempt on a Meteora venue
 * died with `pumpportal build 400` — 48 failures, 0 fills. The failure chain is
 * structural: PumpSwap throws (no pumpswap pool), Jupiter has not indexed a
 * minutes-old Meteora pool, Fluxbeam has no route, and PumpPortal only knows
 * pump.fun-family pools. So live was systematically locked out of the winning
 * venue and confined to the losing ones.
 *
 * Two providers, one per protocol, so the router's breaker isolates them:
 *  · MeteoraDbcProvider   — dynamic bonding curve (venue "meteora-dbc" /
 *    "meteoradbc"), the pre-graduation layer. Pool resolved ON-CHAIN by base
 *    mint (getPoolByBaseMint) — no external indexer in the path at all, which
 *    is the whole point: these pools are tradeable seconds after creation.
 *  · MeteoraDammV2Provider — cp-amm (venue "meteora-damm-v2"), where DBC pools
 *    graduate to. Pool resolved on-chain by token mint, WSOL side verified.
 *
 * Both follow the PumpSwap template: build-only (canValue:false — the guard
 * must not value off a quote we didn't price), quoteOnly returns instantly,
 * slippage enforced on-chain via the SDK's minimumAmountOut, compute-budget
 * prepended so the tx lands under congestion, and the tx re-wrapped as a
 * VersionedTransaction for executeSwap.
 */
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { CpAmm, getTokenProgram } from "@meteora-ag/cp-amm-sdk";
import { DynamicBondingCurveClient, getCurrentPoint } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { resilientFetch, type HermesConfig } from "@hermes/core";
import { NoRouteError, type QuoteOpts, type SwapProvider, type SwapQuote } from "./provider.js";
import { WSOL_MINT } from "./jupiterHosted.js";
import { rpcConnection, rpcPool } from "../rpc/pool.js";

/** Meteora pool candidates for a mint, deepest first — DexScreener's pairAddress
 *  IS the on-chain pool account, same trick the PumpSwap provider rides. The
 *  SDKs' own by-mint lookups are getProgramAccounts scans that public RPCs
 *  reject or time out (measured: every probe died in the scan), while a pair
 *  lookup plus ONE account read works everywhere. The scout discovered these
 *  tokens via DexScreener in the first place, so the pair is indexed by the
 *  time a buy fires. dexId is deliberately loose ("meteoradbc" live vs
 *  "meteora-dbc" GeckoTerminal — the dex-string leak lesson); each provider
 *  validates the account by DECODING it as its own protocol's pool, so a
 *  wrong-protocol candidate throws and the next is tried. */
async function meteoraPairs(mint: string): Promise<string[]> {
  const res = await resilientFetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeoutMs: 6_000 });
  if (!res.ok) return [];
  const body = (await res.json()) as { pairs?: { dexId: string; pairAddress: string; liquidity?: { usd?: number } }[] };
  const pools = (body.pairs ?? []).filter((p) => p.dexId?.toLowerCase().includes("meteora") && p.pairAddress);
  pools.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  return pools.map((p) => p.pairAddress);
}

interface MeteoraDbcRaw {
  isBuy: boolean;
  mint: string;
  amountRaw: string;
  pool: string;
  minimumAmountOut: string;
}

interface MeteoraDammRaw {
  isBuy: boolean;
  mint: string;
  amountRaw: string;
  pool: string;
  minSwapOutAmount: string;
}

/** Compute-budget prefix + v0 wrap — identical intent to the PumpSwap tail. */
async function finalizeTx(
  cfg: HermesConfig,
  ixs: TransactionInstruction[],
  user: PublicKey,
): Promise<string> {
  const cuLimit = 400_000; // Meteora swaps run heavier than PumpSwap's 300k
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

const buildOnlyQuote = (name: string, inputMint: string, outputMint: string, amountRaw: bigint): SwapQuote => ({
  inputMint,
  outputMint,
  inAmount: String(amountRaw),
  outAmount: "0",
  priceImpactPct: "0",
  provider: name,
  raw: null,
  canValue: false,
});

/** DYNAMIC BONDING CURVE — the pre-graduation pool, found on-chain by base mint. */
export class MeteoraDbcProvider implements SwapProvider {
  readonly name = "meteora-dbc";

  async quote(
    cfg: HermesConfig,
    inputMint: string,
    outputMint: string,
    amountRaw: bigint,
    slippageBps: number,
    opts?: QuoteOpts,
  ): Promise<SwapQuote> {
    if (opts?.quoteOnly) return buildOnlyQuote(this.name, inputMint, outputMint, amountRaw);
    const isBuy = inputMint === WSOL_MINT;
    const mint = isBuy ? outputMint : inputMint;
    // POOL RESOLUTION MUST LIVE IN quote(). The router's failover walks
    // providers at quote time only — buildSwapTx routes back to whichever
    // provider quoted. The first live attempt (WIFBOOST) proved the failure:
    // the DBC quote succeeded blind, the build found the curve had graduated,
    // and the DAMM provider — which had the pool — never got its turn. Same
    // rule as PumpSwap: resolve here, throw here, fail over here.
    const conn = rpcConnection(cfg);
    const client = DynamicBondingCurveClient.create(conn, "confirmed");
    let poolKey: PublicKey | null = null;
    let virtualPool: Awaited<ReturnType<typeof client.state.getPool>> = null;
    for (const addr of await meteoraPairs(mint)) {
      try {
        const vp = await client.state.getPool(addr);
        if (vp) {
          poolKey = new PublicKey(addr);
          virtualPool = vp;
          break;
        }
      } catch {
        /* not a DBC pool — try the next candidate */
      }
    }
    if (!poolKey || !virtualPool) throw new NoRouteError("no meteora-dbc pool");
    // The SDK's VirtualPool nests its fields under `.poolState`; swapQuote
    // takes the whole wrapper. The quote mint lives on the CONFIG, not the pool.
    const config = await client.state.getPoolConfig(virtualPool.poolState.config);
    if (!config) throw new Error("meteora-dbc pool config missing");
    // Quote side must be WSOL — a USDC-quoted curve would make `amountRaw`
    // (lamports of SOL) nonsense. Refuse rather than mis-trade.
    if (config.quoteMint.toBase58() !== WSOL_MINT) {
      throw new Error(`meteora-dbc pool quotes in ${config.quoteMint.toBase58()}, not WSOL`);
    }
    const currentPoint = await getCurrentPoint(conn, config.activationType);
    // Buy = spend quote (SOL) for base; sell = give base for quote. A completed
    // curve throws HERE ("Virtual pool is completed") — which is exactly the
    // failover signal that hands the graduated token to the DAMM provider.
    const swapBaseForQuote = !isBuy;
    // CURVE-ENTRY SLIPPAGE FLOOR. A seconds-old bonding curve moves faster than
    // an AMM: the first two real DBC buys built correctly and died on-chain
    // with ExceededSlippage (Custom 6002) at the caller's AMM-calibrated 10%,
    // one of them AFTER paying the tx fee. Entries take a 25% floor — position
    // sizes here are $2-ish and minimumAmountOut still bounds the fill — while
    // sells keep the caller's tolerance untouched (exit calls already choose
    // their own width for dying curves).
    const effBps = isBuy ? Math.max(slippageBps, 2_500) : slippageBps;
    let q;
    try {
      q = client.pool.swapQuote({
        virtualPool,
        config,
        swapBaseForQuote,
        amountIn: new BN(amountRaw),
        slippageBps: effBps,
        hasReferral: false,
        eligibleForFirstSwapWithMinFee: false,
        currentPoint,
      });
    } catch (err) {
      // "Virtual pool is completed" = graduated. That is FAILOVER to the DAMM
      // provider, not a provider failure — surface it as a clean refusal so it
      // never counts against this provider's breaker.
      throw new NoRouteError(err instanceof Error ? err.message : String(err));
    }
    const raw: MeteoraDbcRaw = {
      isBuy,
      mint,
      amountRaw: amountRaw.toString(),
      pool: poolKey.toBase58(),
      minimumAmountOut: q.minimumAmountOut.toString(),
    };
    return { ...buildOnlyQuote(this.name, inputMint, outputMint, amountRaw), raw };
  }

  async buildSwapTx(cfg: HermesConfig, quote: SwapQuote, userPublicKey: string): Promise<string> {
    const { isBuy, amountRaw, pool, minimumAmountOut } = quote.raw as MeteoraDbcRaw;
    const conn = rpcConnection(cfg);
    const client = DynamicBondingCurveClient.create(conn, "confirmed");
    const tx = await client.pool.swap({
      owner: new PublicKey(userPublicKey),
      pool: new PublicKey(pool),
      amountIn: new BN(amountRaw),
      minimumAmountOut: new BN(minimumAmountOut),
      swapBaseForQuote: !isBuy,
      referralTokenAccount: null,
    });
    return finalizeTx(cfg, tx.instructions, new PublicKey(userPublicKey));
  }
}

/** DAMM v2 (cp-amm) — the graduated pool, found on-chain by token mint. */
export class MeteoraDammV2Provider implements SwapProvider {
  readonly name = "meteora-damm";

  async quote(
    cfg: HermesConfig,
    inputMint: string,
    outputMint: string,
    amountRaw: bigint,
    slippageBps: number,
    opts?: QuoteOpts,
  ): Promise<SwapQuote> {
    if (opts?.quoteOnly) return buildOnlyQuote(this.name, inputMint, outputMint, amountRaw);
    const isBuy = inputMint === WSOL_MINT;
    const mint = isBuy ? outputMint : inputMint;
    const conn = rpcConnection(cfg);
    const cpAmm = new CpAmm(conn);
    // Pool resolution in quote() — the router only fails over at quote time
    // (the WIFBOOST lesson, see the DBC provider). Candidates from DexScreener
    // pairAddress (deepest first), decoded as a cp-amm pool and verified
    // token↔WSOL against the chain itself. A DBC/DLMM candidate fails the
    // decode or the mint check and the next is tried.
    let poolKey: PublicKey | null = null;
    let st: Awaited<ReturnType<typeof cpAmm.fetchPoolState>> | null = null;
    for (const addr of await meteoraPairs(mint)) {
      try {
        const cand = await cpAmm.fetchPoolState(new PublicKey(addr));
        const a = cand.tokenAMint.toBase58();
        const b = cand.tokenBMint.toBase58();
        if ((a === mint && b === WSOL_MINT) || (b === mint && a === WSOL_MINT)) {
          poolKey = new PublicKey(addr);
          st = cand;
          break;
        }
      } catch {
        /* not a cp-amm pool — try the next candidate */
      }
    }
    if (!poolKey || !st) throw new NoRouteError("no meteora-damm-v2 pool");

    const tokenIsA = st.tokenAMint.toBase58() === mint;
    const inputTokenMint = new PublicKey(isBuy ? WSOL_MINT : mint);
    // Decimals: WSOL is 9; the token's from its mint account (one cached read).
    const tokenDecimals = await mintDecimalsOf(cfg, mint);
    const [tokenADecimal, tokenBDecimal] = tokenIsA ? [tokenDecimals, 9] : [9, tokenDecimals];
    const currentSlot = await rpcPool(cfg).read((c) => c.getSlot("confirmed"));
    // Throws on a drained pool ("liquidity must be greater than 0") — another
    // correct failover/refusal signal that must fire before the router commits.
    const q = cpAmm.getQuote({
      inAmount: new BN(amountRaw),
      inputTokenMint,
      // ENTRY SLIPPAGE FLOOR, same lesson as the DBC curve: a minutes-old
      // graduated pool moves faster than an AMM-calibrated 10% — real buys
      // died in simulation with cp-amm ExceededSlippage (6002). Entries floor
      // at 25% (sizes ~$2, minSwapOutAmount still bounds the fill); sells keep
      // the caller's tolerance.
      slippage: (isBuy ? Math.max(slippageBps, 2_500) : slippageBps) / 100, // SDK slippage is a percent
      poolState: st,
      currentTime: Math.floor(Date.now() / 1000),
      currentSlot,
      tokenADecimal,
      tokenBDecimal,
    });
    const raw: MeteoraDammRaw = {
      isBuy,
      mint,
      amountRaw: amountRaw.toString(),
      pool: poolKey.toBase58(),
      minSwapOutAmount: q.minSwapOutAmount.toString(),
    };
    return { ...buildOnlyQuote(this.name, inputMint, outputMint, amountRaw), raw };
  }

  async buildSwapTx(cfg: HermesConfig, quote: SwapQuote, userPublicKey: string): Promise<string> {
    const { isBuy, mint, amountRaw, pool, minSwapOutAmount } = quote.raw as MeteoraDammRaw;
    const conn = rpcConnection(cfg);
    const cpAmm = new CpAmm(conn);
    const poolKey = new PublicKey(pool);
    // Re-fetch the (tiny) pool state for the vault/program accounts — the
    // resolved pool address is trusted from quote(), the state read is fresh.
    const st = await cpAmm.fetchPoolState(poolKey);
    const user = new PublicKey(userPublicKey);
    const inputTokenMint = new PublicKey(isBuy ? WSOL_MINT : mint);
    const outputTokenMint = new PublicKey(isBuy ? mint : WSOL_MINT);
    const tx = await cpAmm.swap({
      payer: user,
      pool: poolKey,
      inputTokenMint,
      outputTokenMint,
      amountIn: new BN(amountRaw),
      minimumAmountOut: new BN(minSwapOutAmount),
      tokenAMint: st.tokenAMint,
      tokenBMint: st.tokenBMint,
      tokenAVault: st.tokenAVault,
      tokenBVault: st.tokenBVault,
      tokenAProgram: getTokenProgram(st.tokenAFlag),
      tokenBProgram: getTokenProgram(st.tokenBFlag),
      referralTokenAccount: null,
      poolState: st,
    });
    return finalizeTx(cfg, tx.instructions, user);
  }
}

// Token decimals, cached for the process — a mint's decimals never change.
const decimalsCache = new Map<string, number>();
async function mintDecimalsOf(cfg: HermesConfig, mint: string): Promise<number> {
  const hit = decimalsCache.get(mint);
  if (hit != null) return hit;
  const info = await rpcPool(cfg).read((c) => c.getParsedAccountInfo(new PublicKey(mint)));
  const d =
    (info.value?.data as { parsed?: { info?: { decimals?: number } } } | null)?.parsed?.info?.decimals ?? 6;
  decimalsCache.set(mint, d);
  return d;
}
