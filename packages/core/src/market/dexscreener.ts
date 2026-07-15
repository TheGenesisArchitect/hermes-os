/** DexScreener token market data — keyless, used for scoring and paper-trade price marks. */

interface DsTxnWindow {
  buys: number;
  sells: number;
}

interface DsPair {
  chainId: string;
  dexId: string;
  labels?: string[];
  pairAddress: string;
  baseToken?: { address: string; name?: string; symbol?: string };
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
  // DexScreener labels distinguish sub-venues that SHARE a dexId. Meteora reports
  // every pool as dexId "meteora"; only the label separates DAMM v2 ("DYN2" — the
  // atomic-cliff farm) from DAMM v1 ("DYN" — bags-fm launches, a real source).
  // Without this the exit-side farm ladder can't tell the killer apart from a
  // legit venue and mis-classifies every one of them. (See canonicalVenue.)
  labels: string[];
  // Identity from the pool's base token — the only place stream-sourced (PumpPortal
  // graduation) tokens can recover their symbol/name, since the migration event
  // carries neither. Without this they show as "?" everywhere downstream.
  symbol: string | null;
  name: string | null;
  pairAgeMinutes: number | null;
  volUsd: { m5: number; h1: number; h24: number };
  txns: { m5: DsTxnWindow; h1: DsTxnWindow; h24: DsTxnWindow };
  priceChangePct: { m5: number; h1: number; h24: number };
}

/** Map a (best) pair onto the TokenMarket shape. */
function pairToMarket(best: DsPair): TokenMarket {
  const zero = { buys: 0, sells: 0 };
  return {
    priceUsd: Number(best.priceUsd),
    liquidityUsd: best.liquidity?.usd ?? 0,
    fdvUsd: best.fdv ?? 0,
    pairAddress: best.pairAddress,
    dexId: best.dexId,
    labels: best.labels ?? [],
    symbol: best.baseToken?.symbol?.trim() || null,
    name: best.baseToken?.name?.trim() || null,
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

function bestPairPerMint(pairs: DsPair[]): Map<string, DsPair> {
  const best = new Map<string, DsPair>();
  for (const p of pairs) {
    if (p.chainId !== "solana" || !p.priceUsd) continue;
    const mint = p.baseToken?.address;
    if (!mint) continue;
    const cur = best.get(mint);
    if (!cur || (p.liquidity?.usd ?? 0) > (cur.liquidity?.usd ?? 0)) best.set(mint, p);
  }
  return best;
}

/**
 * Fetch current market state for a mint, using its most liquid Solana pair.
 * Returns null when DexScreener has no pair (brand-new or delisted token).
 */
export async function fetchTokenMarket(mint: string): Promise<TokenMarket | null> {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5000), // a silently-dropped host must fail fast, never hang the manage/observe loop
  });
  if (!res.ok) throw new Error(`dexscreener HTTP ${res.status}`);
  const body = (await res.json()) as { pairs?: DsPair[] | null };
  const best = bestPairPerMint(body.pairs ?? []).get(mint);
  return best ? pairToMarket(best) : null;
}

/**
 * BATCHED market fetch — up to 30 mints per request via the comma-joined tokens
 * endpoint. This is the rate-limit fix: per-mint polling at book scale (24
 * positions × 5s manage + 60 recorder candidates × 30s) blew past DexScreener's
 * ~300 req/min ceiling and the throttled fetches read as book-wide "no pair"
 * outages — the recurring HOLD-ALL storms were SELF-INFLICTED. One request per
 * 30 mints keeps the whole platform at ~20 req/min. A failed chunk yields null
 * for its mints (same semantics as the old per-mint catch → the feed-outage
 * breadth guard holds the book rather than acting on missing reads).
 */
export async function fetchTokenMarkets(mints: string[]): Promise<Map<string, TokenMarket | null>> {
  const out = new Map<string, TokenMarket | null>();
  const unique = [...new Set(mints)];
  for (let i = 0; i < unique.length; i += 30) {
    const chunk = unique.slice(i, i + 30);
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(",")}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`dexscreener HTTP ${res.status}`);
      const body = (await res.json()) as { pairs?: DsPair[] | null };
      const best = bestPairPerMint(body.pairs ?? []);
      for (const m of chunk) {
        const b = best.get(m);
        out.set(m, b ? pairToMarket(b) : null);
      }
    } catch {
      for (const m of chunk) out.set(m, null);
    }
  }
  return out;
}
