import { resilientFetch, type TokenCandidate } from "@hermes/core";

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
export async function fetchNewPools(minLiquidityUsd: number, pages = 3): Promise<TokenCandidate[]> {
  // geckoterminal.com is SNI-filtered for undici (ECONNRESET); resilientFetch
  // retries via curl (through GoodbyeDPI). 5s cap so a silent drop fails fast and
  // the DexScreener fallback can fire instead of hanging the poll.
  //
  // MULTI-PAGE, newest-first. Page 1 alone is 20 pools, and at launch-hour flow
  // the meteora/pump firehose pushes a Raydium LaunchLab or CPMM creation off
  // that page inside one 45s poll — the 7-day census showed ~20 Raydium-family
  // discoveries a WEEK against one of the largest launch flows on Solana. Three
  // pages = the 60 newest pools per poll, which holds the whole window at peak
  // flow. Budget: 3 calls / 45s ≈ 4/min, far under GT's free-tier limit. A
  // failed deeper page returns what we have — page 1 failing still throws so
  // the DexScreener fallback can fire.
  const raw: GtPool[] = [];
  for (let p = 1; p <= pages; p++) {
    try {
      const res = await resilientFetch(`${NEW_POOLS_URL}?page=${p}`, {
        headers: { accept: "application/json" },
        timeoutMs: 5000,
      });
      if (!res.ok) throw new Error(`geckoterminal HTTP ${res.status}`);
      const body = (await res.json()) as { data?: GtPool[] };
      raw.push(...(body.data ?? []));
    } catch (err) {
      if (p === 1) throw err; // primary page down = source down → let the fallback fire
      break; // deeper page hiccup (rate limit, blip) — keep what we have
    }
  }
  // Dedupe by pool address — pages can shift between requests.
  const seen = new Set<string>();
  const poolsRaw = raw.filter((pool) => {
    const a = pool.attributes.address;
    if (seen.has(a)) return false;
    seen.add(a);
    return true;
  });

  const candidates: TokenCandidate[] = [];
  for (const pool of poolsRaw) {
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
