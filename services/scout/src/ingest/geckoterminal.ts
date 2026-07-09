import type { TokenCandidate } from "@hermes/core";

const NEW_POOLS_URL = "https://api.geckoterminal.com/api/v2/networks/solana/new_pools";
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const STABLES = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

interface GtPool {
  id: string;
  attributes: {
    address: string;
    name: string;
    pool_created_at: string;
    reserve_in_usd: string;
    fdv_usd: string | null;
  };
  relationships: {
    base_token: { data: { id: string } };
    quote_token: { data: { id: string } };
    dex: { data: { id: string } };
  };
}

/** GeckoTerminal token ids look like "solana_<mint>". */
function mintFromId(id: string): string {
  return id.replace(/^solana_/, "");
}

/**
 * Poll GeckoTerminal's keyless new-pools feed for Solana. Returns candidates
 * where the NEW token is paired against SOL or a stable (i.e. the tradeable leg).
 */
export async function fetchNewPools(minLiquidityUsd: number): Promise<TokenCandidate[]> {
  const res = await fetch(NEW_POOLS_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`geckoterminal HTTP ${res.status}`);
  const body = (await res.json()) as { data?: GtPool[] };

  const candidates: TokenCandidate[] = [];
  for (const pool of body.data ?? []) {
    const attrs = pool.attributes;
    const base = mintFromId(pool.relationships.base_token.data.id);
    const quote = mintFromId(pool.relationships.quote_token.data.id);

    // The "new" token is whichever leg is not SOL/stable.
    const isQuoteAnchor = quote === WSOL_MINT || STABLES.has(quote);
    const isBaseAnchor = base === WSOL_MINT || STABLES.has(base);
    if (isQuoteAnchor === isBaseAnchor) continue; // both anchors or neither — skip
    const mint = isQuoteAnchor ? base : quote;
    const anchor = isQuoteAnchor ? quote : base;

    const liquidityUsd = Number(attrs.reserve_in_usd ?? 0);
    if (liquidityUsd < minLiquidityUsd) continue;

    const [symbol] = (attrs.name ?? "").split(" / ");
    candidates.push({
      mint,
      chain: "solana",
      symbol: symbol?.trim() || undefined,
      name: attrs.name,
      poolAddress: attrs.address,
      dex: pool.relationships.dex.data.id,
      baseTokenMint: anchor,
      liquidityUsd,
      fdvUsd: attrs.fdv_usd ? Number(attrs.fdv_usd) : undefined,
      poolCreatedAt: attrs.pool_created_at ? new Date(attrs.pool_created_at) : undefined,
      raw: pool,
    });
  }
  return candidates;
}
