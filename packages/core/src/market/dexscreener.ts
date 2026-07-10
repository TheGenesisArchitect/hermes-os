/** DexScreener token market data — keyless, used for scoring and paper-trade price marks. */

interface DsTxnWindow {
  buys: number;
  sells: number;
}

interface DsPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  priceUsd?: string;
  txns?: { m5?: DsTxnWindow; h1?: DsTxnWindow; h6?: DsTxnWindow; h24?: DsTxnWindow };
  volume?: { m5?: number; h1?: number; h6?: number; h24?: number };
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  liquidity?: { usd?: number };
  fdv?: number;
  pairCreatedAt?: number;
}

export interface TokenMarket {
  priceUsd: number;
  liquidityUsd: number;
  fdvUsd: number;
  pairAddress: string;
  dexId: string;
  pairAgeMinutes: number | null;
  volUsd: { m5: number; h1: number; h24: number };
  txns: { m5: DsTxnWindow; h1: DsTxnWindow; h24: DsTxnWindow };
  priceChangePct: { m5: number; h1: number; h24: number };
}

/**
 * Fetch current market state for a mint, using its most liquid Solana pair.
 * Returns null when DexScreener has no pair (brand-new or delisted token).
 */
export async function fetchTokenMarket(mint: string): Promise<TokenMarket | null> {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`dexscreener HTTP ${res.status}`);
  const body = (await res.json()) as { pairs?: DsPair[] | null };
  const pairs = (body.pairs ?? []).filter((p) => p.chainId === "solana" && p.priceUsd);
  if (pairs.length === 0) return null;

  const best = pairs.reduce((a, b) =>
    (b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a,
  );
  const zero = { buys: 0, sells: 0 };
  return {
    priceUsd: Number(best.priceUsd),
    liquidityUsd: best.liquidity?.usd ?? 0,
    fdvUsd: best.fdv ?? 0,
    pairAddress: best.pairAddress,
    dexId: best.dexId,
    pairAgeMinutes: best.pairCreatedAt ? (Date.now() - best.pairCreatedAt) / 60_000 : null,
    volUsd: {
      m5: best.volume?.m5 ?? 0,
      h1: best.volume?.h1 ?? 0,
      h24: best.volume?.h24 ?? 0,
    },
    txns: {
      m5: best.txns?.m5 ?? zero,
      h1: best.txns?.h1 ?? zero,
      h24: best.txns?.h24 ?? zero,
    },
    priceChangePct: {
      m5: best.priceChange?.m5 ?? 0,
      h1: best.priceChange?.h1 ?? 0,
      h24: best.priceChange?.h24 ?? 0,
    },
  };
}
