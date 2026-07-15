/**
 * Jupiter real-time price feed (keyless) — fresher and truer than DexScreener's
 * aggregated price. Used as the MANAGEMENT mark: exits and the trail decide on
 * the price we could actually sell at, right now.
 *
 * Sourced from `datapi.jup.ag/v1/pools?assetIds=…`, which returns each asset's
 * live `baseAsset.usdPrice`. We use datapi rather than lite-api's price/v3
 * because the upstream SNI-DPI filter on this host resets lite-api.jup.ag /
 * api.jup.ag / price.jup.ag even through GoodbyeDPI, while datapi.jup.ag gets
 * through. One call prices every open position (dedup by asset).
 */

import { resilientFetch } from "../net.js";

interface DatapiPool {
  liquidity?: number;
  baseAsset?: { id?: string; usdPrice?: number };
}

/** Batch real-time USD prices for many mints. Missing/illiquid mints are omitted. */
export async function fetchJupiterPrices(
  priceUrl: string,
  mints: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const batch = [...new Set(mints)].slice(0, 50); // keep the id list bounded
  if (batch.length === 0) return out;
  // datapi.jup.ag is SNI-filtered for undici; resilientFetch retries via curl
  // (through GoodbyeDPI). On total failure the caller falls back to DexScreener marks.
  const res = await resilientFetch(`${priceUrl}?assetIds=${batch.join(",")}`, {
    headers: { accept: "application/json" },
    timeoutMs: 5000,
  });
  if (!res.ok) throw new Error(`jupiter price HTTP ${res.status}`);
  const body = (await res.json()) as { pools?: DatapiPool[] };
  // One asset surfaces in several pools (incl. near-zero-liquidity bonding-curve /
  // dead pools whose implied price is garbage). Take the price from the MOST LIQUID
  // pool per asset, not just the first — the first can be a $0-liq pool that reads
  // ~100x off and fabricates phantom P&L when used as an entry/exit mark.
  const bestLiq = new Map<string, number>();
  for (const pool of body.pools ?? []) {
    const a = pool.baseAsset;
    if (!a?.id || typeof a.usdPrice !== "number" || a.usdPrice <= 0) continue;
    const liq = pool.liquidity ?? 0;
    if (!out.has(a.id) || liq > (bestLiq.get(a.id) ?? -1)) {
      out.set(a.id, a.usdPrice);
      bestLiq.set(a.id, liq);
    }
  }
  return out;
}

/** Real-time USD price for a single mint, or null if Jupiter has no route. */
export async function fetchJupiterPrice(priceUrl: string, mint: string): Promise<number | null> {
  const prices = await fetchJupiterPrices(priceUrl, [mint]);
  return prices.get(mint) ?? null;
}
