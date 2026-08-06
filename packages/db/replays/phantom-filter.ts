/**
 * PHANTOM FILTER — the shared decontamination predicate for every court.
 *
 * DORAE #8165 (2026-08-06) proved decoy pools are IN OUR TAPE: 96,494 ticks
 * across 474 mints carry liquidity a pump-origin token cannot hold, because
 * DexScreener values a Meteora DLMM's tokens at a fake single-sided bin price
 * (600M DORAE vs 0.02717 SOL -> "$91M liquidity", zero trades ever).
 *
 * Every replay that consumed `candidate_ticks` inherited those marks. This
 * module is the single place the exclusion rule lives, so no court can
 * silently disagree with another about what counts as real.
 *
 * THE RULE (SQL fragment, mirrors packages/core quote-depth selection):
 *   a tick is TRUSTED when its liquidity is inside the plausible band for
 *   the venue class we trade. Above PHANTOM_LIQ_USD the print is a decoy
 *   mark, not a market we could transact against at any ticket we deploy.
 */
export const PHANTOM_LIQ_USD = 5_000_000;

/** Predicate for a `candidate_ticks ct` alias. */
export const TRUSTED_TICK = `ct.liquidity_usd::float BETWEEN 1200 AND ${PHANTOM_LIQ_USD}`;

/** A closed position whose exit multiple exceeds this was marked on a decoy. */
export const PHANTOM_EXIT_X = 50;
