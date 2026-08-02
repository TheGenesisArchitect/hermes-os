/**
 * LIVE-LANE INVARIANTS — the pure decision predicates behind the live sell path.
 *
 * WHY THIS FILE EXISTS
 * An external audit (QTEA, 2026-08-01) found four correctness defects in
 * executor.ts, all of them in logic that was structurally untestable because it
 * sat inline inside a ~250-line function that needs a wallet, an RPC pool, a
 * router and a database to reach. Every defect was the kind a single assertion
 * would have caught:
 *
 *   QTEA-001  a missing pair of braces persisted terminal exit intent on every
 *             sell, including partial take-profit rungs
 *   QTEA-002  the sniper sells 99.5% of the balance and the ledger booked 100%
 *   QTEA-004  Jupiter's priceImpactPct is a FRACTION and one caller read it as
 *             percentage points, overstating inferred pool depth ~100x
 *   QTEA-011  a position closed on pre-send INTENT rather than settled chain truth
 *
 * The fix is not just to correct them — it is to move the decisions somewhere an
 * assertion can reach. These functions are pure: no I/O, no clock, no config
 * object. executor.ts calls them; invariants.test.ts pins them.
 *
 * OWNER  Execution Team
 */

/** Terminal exits that must complete once commanded. Opportunistic exits
 *  (profit_trail, liquid_window, take_profit) are deliberately absent — if one
 *  fails and price recovers, continuing to ride is the correct outcome. */
export const LATCHING_EXIT =
  /stop|catastrophe|rug|sweep|mirror_cut|unsellable|depth_collapse|drain_guard|floor_45|user_cut|runner_timeout/i;

/**
 * QTEA-001 — may this sell create persistent terminal exit intent?
 *
 * INVARIANT: partial exits and non-latching exits must never create or
 * overwrite persistent latch state.
 */
export function shouldPersistLatch(args: {
  fraction: number;
  reason: string;
  alreadyLatched: boolean;
}): boolean {
  const { fraction, reason, alreadyLatched } = args;
  if (alreadyLatched) return false; // never reset `since` on a retry
  if (!(fraction >= 0.999)) return false; // a partial rung is not a position in trouble
  return LATCHING_EXIT.test(reason);
}

/**
 * QTEA-004 — Jupiter's `priceImpactPct` is a FRACTION, not percentage points.
 *
 * INVARIANT: `0.01` from Jupiter means 1% impact, not 0.01 percentage points.
 *
 * The proof this is a fraction lives in the entry path, which multiplies by 100
 * before comparing against ENTRY_MAX_SLIPPAGE_PCT (a percent). Were the field
 * already percentage points, that comparison would reject every entry ever
 * offered — and entries demonstrably fill.
 *
 * Returns null for absent, malformed, non-finite, negative, or >=100% values so
 * callers can distinguish "no depth measurement" from "zero impact".
 *
 * NEGATIVE IS NULL, NOT abs() — the harness forced this call. Jupiter reports a
 * negative impact when the route pays MORE than quoted (favourable slippage).
 * Taking the magnitude would read a favourable −50% as "50% impact", infer a
 * shallow pool from a good fill, and fire a false depth cut. A favourable quote
 * carries no ADVERSE depth signal, so the honest answer is "no measurement" and
 * the caller falls back to the feed. (The entry gate at executor.ts:~1720 keeps
 * its own abs() — there the magnitude is what bounds the trade.)
 */
export function impactFraction(raw: string | number | null | undefined): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n <= 0 || n >= 1) return null; // ≤0 carries no adverse signal; ≥1 is a total-impact quote
  return n;
}

/** The same measurement expressed in percentage points, for callers that compare
 *  against percent-denominated config (ENTRY_MAX_SLIPPAGE_PCT and friends). */
export function impactPct(raw: string | number | null | undefined): number | null {
  const f = impactFraction(raw);
  return f == null ? null : f * 100;
}

/**
 * QTEA-004 — invert our own convex-slippage model to recover implied liquidity.
 *
 *     impact = trade / (liq/2 + trade)      [as a FRACTION]
 *  ⇒  liq    = 2 · trade · (1/impact − 1)
 *
 * A pulled pool prices as enormous impact (or refuses to quote), so a drain
 * shows up the instant it happens rather than whenever the aggregator notices.
 */
export function impliedLiquidityUsd(tradeValueUsd: number, frac: number | null): number | null {
  if (frac == null || !(tradeValueUsd > 0) || !Number.isFinite(tradeValueUsd)) return null;
  return Math.max(0, 2 * tradeValueUsd * (1 / frac - 1));
}

/**
 * QTEA-002 + QTEA-011 — close from CHAIN TRUTH, never from pre-send intent.
 *
 * `rawSell === raw` tested what we ASKED to sell. The sniper deliberately signs
 * for 99.5% of the balance (a dust margin that avoids oversized-swap failures),
 * so on every chambered fire that predicate closed a position while ~0.5% of the
 * tokens were still on-chain — untracked capital, plus an ATA close attempt on a
 * non-empty account.
 *
 * INVARIANT: a closed live position implies a verified chain balance at or below
 * the dust threshold.
 */
export type CloseVerdict =
  | { kind: "closed"; remainingUi: 0 }
  | { kind: "dust_close"; remainingUi: number; dustUsd: number }
  | { kind: "open"; remainingUi: number }
  | { kind: "mismatch"; expectedRaw: bigint; actualRaw: bigint; remainingUi: number };

export function closeVerdict(args: {
  /** balance read from chain immediately BEFORE the sell */
  preRaw: bigint;
  /** quantity actually embedded in the settled transaction (fired.qtyRaw for a
   *  chambered round; the requested amount on the fallback path) */
  executedRaw: bigint;
  /** balance re-read from chain AFTER settlement; null when the read failed */
  postRaw: bigint | null;
  decimals: number;
  /** realised proceeds per token, for pricing the remainder */
  priceUsd: number;
  dustUsd: number;
}): CloseVerdict {
  const { preRaw, executedRaw, postRaw, decimals, priceUsd, dustUsd } = args;
  const expected = preRaw > executedRaw ? preRaw - executedRaw : 0n;
  // Chain truth wins whenever we have it; the expectation is only a fallback for
  // a failed post-read (never a substitute for one).
  const actual = postRaw ?? expected;
  const ui = (r: bigint) => Number(r) / 10 ** decimals;

  // A material divergence between what settlement implies and what the chain
  // holds is unexplained: fee-on-transfer, a partial fill, program rounding, or
  // a concurrent external move. Flag it and REFUSE to close — a wrong close is
  // unrecoverable bookkeeping, a delayed close costs one cycle.
  if (postRaw != null) {
    const tol = preRaw / 100n; // 1% of the pre-sell balance
    const diff = actual > expected ? actual - expected : expected - actual;
    if (diff > tol) {
      return { kind: "mismatch", expectedRaw: expected, actualRaw: actual, remainingUi: ui(actual) };
    }
  }

  if (actual <= 0n) return { kind: "closed", remainingUi: 0 };
  const remainingUi = ui(actual);
  const value = remainingUi * (priceUsd > 0 ? priceUsd : 0);
  if (value < dustUsd) return { kind: "dust_close", remainingUi, dustUsd: value };
  return { kind: "open", remainingUi };
}
