import type { TokenCandidate } from "@hermes/core";

/**
 * DexScreener fallback ingest — used when GeckoTerminal's new-pools feed is
 * unreachable (e.g. SNI-level network filtering of geckoterminal.com, which
 * killed the primary mid-run 1d). DexScreener has no clean "new pools" firehose,
 * so we take its keyless "latest token profiles" + "latest boosts" feeds (fresh
 * listings, heavy on pump.fun launches) and enrich each via the batch tokens
 * endpoint to recover pool/liquidity/venue. Narrower and slightly promotion-
 * biased vs GeckoTerminal, but keyless, reachable, and enough to keep 1d fed.
 */

const PROFILES_URL = "https://api.dexscreener.com/token-profiles/latest/v1";
const BOOSTS_URL = "https://api.dexscreener.com/token-boosts/latest/v1";
const TOKENS_URL = "https://api.dexscreener.com/latest/dex/tokens";
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const STABLES = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

interface FeedItem {
  chainId: string;
  tokenAddress: string;
}

interface DsPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name?: string; symbol?: string };
  quoteToken: { address: string; symbol?: string };
  liquidity?: { usd?: number };
  fdv?: number;
  pairCreatedAt?: number;
}

async function feedAddresses(url: string): Promise<string[]> {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`dexscreener feed HTTP ${res.status}`);
  const body = (await res.json()) as FeedItem[];
  return (body ?? []).filter((x) => x.chainId === "solana").map((x) => x.tokenAddress);
}

/**
 * Keyless fresh-token ingest via DexScreener. Returns candidates where the new
 * token is paired against SOL or a stable and clears the liquidity gate.
 */
export async function fetchNewPoolsDexscreener(minLiquidityUsd: number): Promise<TokenCandidate[]> {
  // gather fresh mints from both feeds (dedup)
  const lists = await Promise.allSettled([feedAddresses(PROFILES_URL), feedAddresses(BOOSTS_URL)]);
  const mints = [
    ...new Set(lists.flatMap((r) => (r.status === "fulfilled" ? r.value : []))),
  ].slice(0, 30); // tokens endpoint takes up to 30 comma-separated addresses
  if (mints.length === 0) return [];

  const res = await fetch(`${TOKENS_URL}/${mints.join(",")}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`dexscreener tokens HTTP ${res.status}`);
  const body = (await res.json()) as { pairs?: DsPair[] | null };

  // keep the most-liquid Solana SOL/stable-paired pool per new token
  const byMint = new Map<string, TokenCandidate>();
  for (const p of body.pairs ?? []) {
    if (p.chainId !== "solana") continue;
    const mint = p.baseToken.address;
    const anchor = p.quoteToken.address;
    if (!(anchor === WSOL_MINT || STABLES.has(anchor))) continue; // need a tradeable anchor
    const liquidityUsd = p.liquidity?.usd ?? 0;
    if (liquidityUsd < minLiquidityUsd) continue;

    const existing = byMint.get(mint);
    if (existing && (existing.liquidityUsd ?? 0) >= liquidityUsd) continue;
    byMint.set(mint, {
      mint,
      chain: "solana",
      symbol: p.baseToken.symbol?.trim() || undefined,
      name: p.baseToken.name,
      poolAddress: p.pairAddress,
      dex: p.dexId,
      baseTokenMint: anchor,
      liquidityUsd,
      fdvUsd: p.fdv,
      poolCreatedAt: p.pairCreatedAt ? new Date(p.pairCreatedAt) : undefined,
      raw: p,
    });
  }
  return [...byMint.values()];
}
