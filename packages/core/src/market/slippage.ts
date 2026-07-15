/**
 * Convex constant-product (x*y=k) price impact — the single source of truth for
 * slippage across the trader and the dashboard. Half the pool TVL is the quote
 * reserve Q; a trade of `tradeUsd` moves the effective price by
 * tradeUsd / (Q + tradeUsd), heading toward ~50%+ as the order approaches pool
 * depth. Uncapped (the old `min(size/liq, 10%)` cap is what inflated the
 * McGwegor 327× fill). Used for BOTH entry fills and for marking open positions
 * to a *realizable* (post-exit-slippage) value — never show gross mark P&L on a
 * thin pool, that's the overstatement this model exists to kill.
 */
export function convexSlippagePct(tradeUsd: number, liquidityUsd: number): number {
  if (liquidityUsd <= 0) return 99; // no pool = assume near-total loss
  const quoteReserve = liquidityUsd / 2;
  return Math.min((tradeUsd / (quoteReserve + tradeUsd)) * 100, 99);
}
