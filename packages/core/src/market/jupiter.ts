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

// FAIL-FAST BREAKER (2026-08-04 fill-drag autopsy): during the Jupiter outage
// every per-position price call burned its FULL 5s timeout, serially — a
// 20-seat manage cycle stretched to ~100s, marks aged mid-burst, and exits
// booked up to −28pp below the last mark. After 3 consecutive failures this
// module answers instantly-empty for 60s (callers already fall back to
// DexScreener marks); any success closes it. An outage now costs the mark
// stream milliseconds, not minutes.
let jupFails = 0;
let jupOpenUntil = 0;

/** Batch real-time USD prices for many mints. Missing/illiquid mints are omitted. */
export async function fetchJupiterPrices(
  priceUrl: string,
  mints: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const batch = [...new Set(mints)].slice(0, 50); // keep the id list bounded
  if (batch.length === 0) return out;
  if (Date.now() < jupOpenUntil) return out; // breaker open — fail fast, callers fall back
  // datapi.jup.ag is SNI-filtered for undici; resilientFetch retries via curl
  // (through GoodbyeDPI). On total failure the caller falls back to DexScreener marks.
  let res;
  try {
    res = await resilientFetch(`${priceUrl}?assetIds=${batch.join(",")}`, {
      headers: { accept: "application/json" },
      timeoutMs: 5000,
    });
  } catch (err) {
    if (++jupFails >= 3) { jupOpenUntil = Date.now() + 60_000; jupFails = 0; }
    throw err;
  }
  if (!res.ok) {
    if (++jupFails >= 3) { jupOpenUntil = Date.now() + 60_000; jupFails = 0; }
    throw new Error(`jupiter price HTTP ${res.status}`);
  }
  jupFails = 0; // healthy response closes the breaker
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
