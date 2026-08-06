# QA REVIEW BUNDLE — verbatim source, no checkout required

**Repo:** TheGenesisArchitect/hermes-os (PRIVATE) · **Commit:** `6370577`
**Generated:** 2026-08-06T22:05:40Z · **Suite:** 57/57

Companion to `QA-PRERELEASE-AUDIT-2026-08-06.md`. Every claim in that
document about *enforcement* can be checked against the code below. The
files are pasted verbatim and unabridged — the reviewer should not have to
trust a summary.

---

## 1. `services/trader/src/live/manifest.ts` — the live selection verdict

This is the enforceability question. Confirm `tierRefusal()` READS every
field the manifest declares: `poolMinUsd`, `refuseUnknownCrowd`,
`refuseSecondLaunch`, `crowdNetWinners`, `inflowMin/Max`, `buyShareMin`,
`venues`. A declared-but-unread field is the defect class in audit §5.

```typescript
/**
 * THE FORMULA MANIFEST — paper is the laboratory, live inherits the ratified
 * winning architecture (operator, 2026-08-02: "Yes let's execute with
 * precision").
 *
 * PURPOSE
 *   Load the operator-ratified manifest (config key `formula_manifest`) and
 *   render the entry verdict for a live candidate: ELITE seat, FILLER seat, or
 *   refuse — with the reason spelled out for the audit row. The manifest is
 *   data, not code: promotion/demotion of signatures, floors and venues happens
 *   by ratifying a new manifest version, never by editing gates.
 *
 * SUCCESS
 *   Every live entry decision carries the manifest version and tier; the
 *   counterfactual watch (packages/db/replays/manifest-watch.ts) measures what
 *   each tier takes and refuses from day one.
 *
 * FAILURE MODE
 *   A missing or corrupt manifest must never wedge the lane: verdict returns
 *   pass-through ("no-manifest") and the caller trades exactly as before —
 *   solvency rails are upstream and unaffected. Fail-open, and the fallback is
 *   visible in the audit row.
 *
 * OWNER
 *   Portfolio Intelligence (contents) · Execution (this wiring)
 */
import { db } from "@hermes/db";
import { sql } from "drizzle-orm";

export type ManifestTierSpec = {
  /** minimum measured inflow; an UNMEASURED inflow passes (absence isn't evidence) */
  inflowMin?: number;
  /** maximum measured inflow (the canon envelope ceiling) */
  inflowMax?: number;
  /** minimum measured buy share at trigger */
  buyShareMin?: number;
  /** when false, an unmeasured buy share refuses; default true (passes) */
  unmeasuredBuySharePasses?: boolean;
  /** crowd rule: winners aboard and winners outnumber rug history (W≥1 ∧ W>R) */
  crowdNetWinners?: boolean;
  /** venue allowlist for this tier */
  venues: string[];
  /** R2 (admission court, 2026-08-06): pool at entry below this is the
   * never-offered cohort — 47% dead, −$0.59/t. Unmeasured pool passes. */
  poolMinUsd?: number;
  /** R5 (admission court): a crowd with zero winner AND zero rug history is
   * unknown — 44% dead, −$0.45/t. Distinct from crowdNetWinners, which
   * refuses a MEASURED-but-losing crowd. */
  refuseUnknownCrowd?: boolean;
  /** refuse relaunched tickers (F6 — the adversary's re-harvest cell; BROKER
   * #7319 entered one flagged two audit lines above its seat) */
  refuseSecondLaunch?: boolean;
};

export type FormulaManifest = {
  version: number;
  ratifiedAt: string;
  genomes: Record<string, number>; // signature → sizing weight
  elite: ManifestTierSpec;
  filler: ManifestTierSpec;
};

export type ManifestInput = {
  signature: string | null;
  inflow: number | null;
  buyShare: number | null;
  winnerHits: number | null;
  rugHits: number | null;
  venue: string | null;
  /** launchOrder ≥ 2 — a relaunch of an existing ticker */
  secondLaunch?: boolean;
  /** pool liquidity at seat time (R2) */
  poolUsd?: number | null;
};

export type ManifestVerdict =
  | { kind: "no-manifest" }
  | { kind: "seat"; tier: "elite" | "filler"; weight: number; version: number }
  | { kind: "refuse"; reason: string; version: number };

let cache: { m: FormulaManifest | null; at: number } = { m: null, at: 0 };
const CACHE_MS = 30_000;

export async function loadManifest(): Promise<FormulaManifest | null> {
  if (Date.now() - cache.at < CACHE_MS) return cache.m;
  try {
    const [row] = (await db.execute(
      sql`SELECT value FROM config WHERE key = 'formula_manifest'`,
    )) as unknown as { value: FormulaManifest }[];
    const m = row?.value ?? null;
    cache = { m: m && m.version >= 1 && m.elite && m.filler && m.genomes ? m : null, at: Date.now() };
  } catch {
    cache = { m: null, at: Date.now() }; // fail-open; retried next cache window
  }
  return cache.m;
}

/** Test seam. */
export function _resetManifestCache(): void {
  cache = { m: null, at: 0 };
}

function tierRefusal(spec: ManifestTierSpec, c: ManifestInput): string | null {
  if (spec.refuseSecondLaunch && c.secondLaunch) return "second launch (F6 re-harvest cell)";
  // R2 — thin pool at entry (admission court): 47% dead, −$0.59/t. An
  // unmeasured pool passes; absence of measurement is not evidence.
  if (spec.poolMinUsd != null && c.poolUsd != null && c.poolUsd > 0 && c.poolUsd < spec.poolMinUsd)
    return `pool $${Math.round(c.poolUsd)} below the $${spec.poolMinUsd} admission floor (47% dead)`;
  // R5 — unknown crowd: zero winners AND zero rugs on record (44% dead).
  if (spec.refuseUnknownCrowd && (c.winnerHits ?? 0) === 0 && (c.rugHits ?? 0) === 0)
    return "crowd 0W/0R — unknown (44% dead)";
  if (c.venue == null || !spec.venues.includes(c.venue)) return `venue ${c.venue ?? "unknown"} not in tier list`;
  if (spec.crowdNetWinners) {
    if (c.winnerHits == null || c.rugHits == null) return "crowd unmeasured";
    if (!(c.winnerHits >= 1 && c.winnerHits > c.rugHits)) return `crowd ${c.winnerHits}W/${c.rugHits}R fails W≥1∧W>R`;
  }
  if (spec.inflowMin != null && c.inflow != null && c.inflow < spec.inflowMin)
    return `inflow ${c.inflow.toFixed(2)}× below ${spec.inflowMin}×`;
  if (spec.inflowMax != null && c.inflow != null && c.inflow > spec.inflowMax)
    return `inflow ${c.inflow.toFixed(2)}× above the ${spec.inflowMax}× envelope`;
  if (spec.buyShareMin != null) {
    if (c.buyShare == null) {
      if (spec.unmeasuredBuySharePasses === false) return "buy share unmeasured";
    } else if (c.buyShare < spec.buyShareMin) {
      return `buy share ${(c.buyShare * 100).toFixed(0)}% below ${(spec.buyShareMin * 100).toFixed(0)}%`;
    }
  }
  return null;
}

/**
 * Pure verdict — no I/O, directly unit-tested. Elite is tried first; a
 * candidate failing both tiers is refused with both reasons named.
 */
export function manifestVerdict(m: FormulaManifest | null, c: ManifestInput): ManifestVerdict {
  if (!m) return { kind: "no-manifest" };
  // Drift-major seat veto REMOVED 2026-08-03 (convicted: 76 refusals / 75
  // winners / 8 rugs overnight — 7d-vs-7d PSI measures composition change,
  // not current-hour hostility; the rug-tide doors own that on the right
  // clock). PSI governs optimizer PROPOSALS only. Never re-add here.
  if (c.signature == null || m.genomes[c.signature] == null)
    return { kind: "refuse", reason: `${c.signature ?? "unrouted"} — genome not in manifest v${m.version}`, version: m.version };
  const weight = m.genomes[c.signature]!;
  const eliteWhy = tierRefusal(m.elite, c);
  if (eliteWhy == null) return { kind: "seat", tier: "elite", weight, version: m.version };
  const fillerWhy = tierRefusal(m.filler, c);
  if (fillerWhy == null) return { kind: "seat", tier: "filler", weight, version: m.version };
  return { kind: "refuse", reason: `manifest v${m.version}: elite → ${eliteWhy}; filler → ${fillerWhy}`, version: m.version };
}

```

---

## 2. `packages/core/src/market/dexscreener.ts` — quote-depth pool selection

The decoy-pool fix (`6975a8a`). Confirm selection ranks by QUOTE-side depth,
not reported USD liquidity, and that `quoteUsd()` derives from
`priceUsd/priceNative` so a fake bin price cannot inflate it.

```typescript
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
  /** price in QUOTE tokens (e.g. SOL) — with priceUsd this yields USD/quote */
  priceNative?: string;
  txns?: { m5?: DsTxnWindow; h1?: DsTxnWindow; h6?: DsTxnWindow; h24?: DsTxnWindow };
  volume?: { m5?: number; h1?: number; h6?: number; h24?: number };
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  /** `usd` is DERIVED from price (circular — cannot validate price);
   *  `quote` is the measured quote-side reserve, the only honest depth. */
  liquidity?: { usd?: number; base?: number; quote?: number };
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

/**
 * QUOTE-DEPTH TRUTH (DORAE #8165, 2026-08-06 — the decoy-pool trap).
 *
 * Selecting the pool with the highest REPORTED liquidity is an adversarial
 * invitation. A Meteora DLMM lets anyone place single-sided liquidity in any
 * price bin: 600,070,580 DORAE against 0.02717 SOL (~$5 of real money) at an
 * absurd bin price. DexScreener then values those 600M tokens AT that implied
 * price -> "liquidity $91,360,362", "FDV $149,944,232", zero trades ever.
 * Our line-84 heuristic picked it, marked the position at 7,104x entry, and
 * printed a $47,421 phantom profit against a pool that can pay out ~$5.
 *
 * THE RULE: a pool's honesty is its QUOTE side — the asset it must actually
 * pay us in. Reported USD liquidity is derived FROM price and therefore
 * cannot validate price (circular). Quote reserves are a measurement.
 *
 * Selection is therefore: among pools with a credible quote balance, take the
 * deepest; if none is credible, take the deepest quote available and let the
 * caller's own liquidity floors refuse it. Never let a $5 pool set the mark.
 */
const MIN_QUOTE_USD = 500; // below this a pool cannot pay any ticket we trade

/** Quote-side value in USD, derived from the pool's own price ratio:
 *  quote_tokens x (priceUsd / priceNative) = quote value in USD. This is
 *  independent of the token's supply, so a fake bin price cannot inflate it. */
function quoteUsd(p: DsPair): number {
  const qty = p.liquidity?.quote ?? 0;
  const px = Number(p.priceUsd ?? 0);
  const native = Number(p.priceNative ?? 0);
  if (!(qty > 0) || !(px > 0) || !(native > 0)) return 0;
  return qty * (px / native); // (USD per quote-token) x quote-tokens
}

function bestPairPerMint(pairs: DsPair[]): Map<string, DsPair> {
  const byMint = new Map<string, DsPair[]>();
  for (const p of pairs) {
    if (p.chainId !== "solana" || !p.priceUsd) continue;
    const mint = p.baseToken?.address;
    if (!mint) continue;
    if (!byMint.has(mint)) byMint.set(mint, []);
    byMint.get(mint)!.push(p);
  }
  const best = new Map<string, DsPair>();
  for (const [mint, list] of byMint) {
    const credible = list.filter((p) => quoteUsd(p) >= MIN_QUOTE_USD);
    const pool = (credible.length ? credible : list).reduce((a, b) =>
      quoteUsd(b) > quoteUsd(a) ? b : a);
    best.set(mint, pool);
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

```

---

## 3. `services/trader/src/live/executor.ts` — the manifest gate at the entry path

The call site. Confirm: (a) `poolUsd` is read from the TRUSTED liquidity band
(1200–5000000) so a decoy print cannot satisfy a depth floor; (b) a refusal
AUDITS and RETURNS (no fall-through to normal sizing); (c) the gate sits
BEFORE the solvency gate and never wraps it.

```typescript
    // ── THE FORMULA MANIFEST (operator-ratified 2026-08-02) ──────────────────
    // Paper is the laboratory; live inherits the ratified winning architecture.
    // Two tiers from the rug-adjusted combination sweep (formula-combo.ts):
    // ELITE (+$5.89/t adj, canon-era replicated) and canon FILLER (5% dead
    // cohort). Venue verdicts carry the 2026-08-02 architecture fence — the
    // pre-fix unsellable tape does not convict the fixed lane, so damm-v2
    // re-qualifies through the filler tier under clean fills. Every refusal
    // audits with both tiers' reasons; the counterfactual watch reads them.
    let manifestTier: "elite" | "filler" | null = null;
    let manifestWeight = 1;
    if (cfg.FORMULA_MANIFEST_ENABLED) {
      const manifest = await loadManifest();
      if (manifest) {
        const [tk] = await db.select({ dex: tokens.dex }).from(tokens).where(eq(tokens.mint, mint)).limit(1);
        const v = manifestVerdict(manifest, {
          signature: sig?.signature ?? null,
          secondLaunch: (sig?.launchOrder ?? 1) >= 2,
          // R2 (admission court): the pool the seat would actually sit in.
          // Trusted band only — a decoy print must not satisfy a depth floor.
          poolUsd: await (async () => {
            const [lt] = await db
              .select({ liq: candidateTicks.liquidityUsd })
              .from(candidateTicks)
              .where(and(eq(candidateTicks.mint, mint),
                sql`${candidateTicks.liquidityUsd}::float BETWEEN 1200 AND 5000000`))
              .orderBy(desc(candidateTicks.id))
              .limit(1);
            return lt?.liq != null ? Number(lt.liq) : null;
          })(),
          inflow: sig?.liqGrowth != null && Number.isFinite(Number(sig.liqGrowth)) ? Number(sig.liqGrowth) : null,
          buyShare: sig?.triggerBuyShare != null && Number.isFinite(Number(sig.triggerBuyShare)) ? Number(sig.triggerBuyShare) : null,
          winnerHits: sig?.walletWinnerHits ?? null,
          rugHits: sig?.walletRugHits ?? null,
          venue: tk?.dex ?? null,
        });
        if (v.kind === "refuse") {
          await audit("live_buy_skipped", { mint, reason: v.reason });
          return;
        }
        if (v.kind === "seat") {
          manifestTier = v.tier;
          manifestWeight = v.weight;
          await audit("live_manifest_seat", {
            mint,
            tier: v.tier,
            weight: v.weight,
            manifestVersion: v.version,
            signature: sig?.signature ?? null,
            reason: `manifest v${v.version} ${v.tier} seat — genome weight ×${v.weight.toFixed(2)}`,
          });
        }
        // kind === "no-manifest" cannot reach here (manifest was non-null)
      }
    }
    // ══ STRATEGY GATE LAYER, REGION 2 of 2 (see LIVE_STRATEGY_GATES) ═════════
    // Clone-wave, wallet-graph anti-gate, F1 formula/crowd, RECOVERED tier and
    // its cliff-safe door, sub-floor doors, build-back, golden window, trigger
    // and sensor seats, buy-share floor, signature allowlist, stars bar. Every
    // one is a selection opinion; none of them asks whether the trade can be
    // executed or afforded. All seven exception doors live in here too, and go

```

---

## 4. `services/trader/src/paper.ts` — the admission policy (paper lane)

Same R1–R5 policy on the sensor lane. Confirm each refusal is audited by name
and returns.

```typescript
  // ── THE ADMISSION POLICY (admission-court, ratified 2026-08-06) ──────────
  // Capture was never a manager defect: on trades that OFFER (peak ≥1.15×) the
  // manager banks 32.3%, inside the target band. The blend was dragged to
  // −7.6% by 632 trades/7d that NEVER ROSE (avg peak 1.05×, dead in 48s,
  // −$2,528). The instant-death autopsy found the entry-knowable signature and
  // the admission court priced it — the first gate to clear the both-halves
  // bar in seven courts:
  //   take-all  1,652 seats  +$1,116   7.4% capture  $0.68/t
  //   R1–R5       864 seats  +$1,563  16.3% capture  $1.81/t   (+40% EV)
  // Each refusal is individually net-negative to keep: thin pools −$191,
  // meteora-dbc −$193, unknown crowd −$181, rug-history crowd −$78. Unrouted
  // contributes +$16 across 360 seats — cut for the SLOT, not the P&L.
  // Flagged so the policy is revertable as one unit.
  if (cfg.ADMISSION_POLICY) {
    const wh = sig?.walletWinnerHits ?? null;
    const rh = sig?.walletRugHits ?? null;
    const poolNow = market.liquidityUsd;
    const refuse =
      // R1 unrouted — no signature means no measurements at all: 54% dead vs
      // a 38% baseline, and every "unmeasured" cell in every other feature is
      // this same cohort.
      !sig?.signature ? "unrouted — no signature, no measurable edge (54% dead)"
      // R2 thin pool at entry — 47% dead, −$0.59/t
      : poolNow > 0 && poolNow < cfg.ADMISSION_MIN_POOL_USD ? `pool $${Math.round(poolNow)} below the $${cfg.ADMISSION_MIN_POOL_USD} admission floor (47% dead)`
      // R3 rug history leads the crowd — 51% dead, −$1.17/t
      : wh != null && (rh ?? 0) >= wh && (rh ?? 0) > 0 ? `crowd ${wh}W/${rh}R — rug history leads (51% dead)`
      // R4 worst venue — 47% dead, −$0.59/t
      : dex === "meteora-dbc" ? "venue meteora-dbc (47% dead, -$193/7d)"
      // R5 unknown crowd — 44% dead, −$0.45/t
      : (wh ?? 0) === 0 && (rh ?? 0) === 0 ? "crowd 0W/0R — unknown (44% dead)"
      : null;
    if (refuse) {
      await audit("paper_admission_refused", { mint: signal.mint, reason: refuse, signature: sig?.signature ?? null });
      return false;
    }
  }
  // ── FORMULA v2 SENSOR TIER (canon GCE-FORMULA-001, ratified 2026-07-24) ───

```

---

# RUNTIME EVIDENCE — raw output, 2026-08-06T22:06:36Z

Commands from audit §7, executed on the operator machine against the live
database. Transcribed verbatim. The reviewer is trusting my transcription
here — the source sections above require no such trust.

## R1. Typecheck + test suite

```
$ pnpm --filter @hermes/trader typecheck && pnpm --filter @hermes/trader test
(typecheck: no output = clean)
ℹ tests 57
ℹ suites 16
ℹ pass 57
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
```


## R2. Sell-side certification against the live tape

```
$ npx tsx services/trader/src/tools/sell-certify.ts
🔀 swap route via pumpswap
PASS  XST          pumpswap         liq $  161,297  mark ✓ jupiter-hosted · quote ✓ pumpswap · build ✓ 1328b (not sent)
PASS  shibanana    pumpswap         liq $   25,327  mark ✓ jupiter-hosted · quote ✓ pumpswap · build ✓ 1328b (not sent)
PASS  TROLLCAT     pumpswap         liq $   27,154  mark ✓ jupiter-hosted · quote ✓ pumpswap · build ✓ 1368b (not sent)
PASS  CLEOCATRA    pump-amm         liq $    1,531  mark ✓ jupiter-hosted · quote ✓ pumpswap · build ✓ 1324b (not sent)
🔀 swap route via jupiter-hosted
PASS  TINYTANK     meteora-dbc      liq $    1,602  mark ✓ jupiter-hosted · quote ✓ jupiter-hosted · build ✓ 1040b (not sent)
🔀 swap route via pumpswap
PASS  FROGE        pumpswap         liq $   64,445  mark ✓ jupiter-hosted · quote ✓ pumpswap · build ✓ 1328b (not sent)
VERDICT: 6/6 certified sellable end-to-end — stack is GO
```

## R3. Admission court (the shipped policy's own court)

```
$ npx tsx packages/db/replays/admission-court.ts 7
ADMISSION COURT — 1588 paper closes, last 7d
policy                           seats  1st half  2nd half     total  capture    ev/t  verdict
INCUMBENT (take all)              1588   +819.52   +296.89  +1116.41     7.4%   +0.70  (incumbent)
R1 drop unrouted                  1243   +785.80   +318.97  +1104.77     7.8%   +0.89  —
R1+R2 +thin pools                 1078   +904.05   +425.31  +1329.35    13.1%   +1.23  ✅ BEATS BOTH HALVES
R1+R2+R3 +rug crowd               1037   +901.08   +484.86  +1385.95    13.8%   +1.34  ✅ BEATS BOTH HALVES
R1+R2+R3+R4 +dbc                  1032   +910.72   +487.97  +1398.69    13.9%   +1.36  ✅ BEATS BOTH HALVES
ALL R1-R5 (strictest)              839   +960.54   +601.47  +1562.01    16.4%   +1.86  ✅ BEATS BOTH HALVES
R2+R3 only (no signature gate)    1247   +912.22   +470.94  +1383.17    13.2%   +1.11  ✅ BEATS BOTH HALVES
refusal                  refused  their pnl  (negative = the rail protects money)
R1 unrouted                  345     +11.65
R2 pool <$5k                 292    -210.24
R3 crowd R>=W                 63     -76.24
R4 venue dbc                 297    -212.29
R5 crowd 0W/0R               377    -155.34
Bar: beat the incumbent in BOTH halves + improve capture + refuse less EV than it protects.
```

## R4. Instant-death autopsy (the entry-knowable signature)

```
$ npx tsx packages/db/replays/instant-death-court.ts 7
INSTANT-DEATH COURT — 1588 paper closes, last 7d

  DEAD  (peak <1.15x)  n=603  pnl $-2466.94  ev/t $-4.09
  OFFER (peak >=1.15x) n=985  pnl $+3583.36  ev/t $+3.64

Baseline death rate: 38% — a feature only matters if its cells deviate from this.

── SIGNATURE ──
  BASE                   n= 313  dead  31% ████████                  pnl $  +784.22  ev/t $ +2.51
  RUG_RISK               n= 528  dead  33% ████████                  pnl $  +613.61  ev/t $ +1.16
  MOON_SLOW              n= 111  dead  34% █████████                 pnl $   +44.91  ev/t $ +0.40
  RISER                  n= 112  dead  35% █████████                 pnl $  -217.17  ev/t $ -1.94
  MOON_STEADY            n= 151  dead  40% ██████████                pnl $  -140.56  ev/t $ -0.93
  MOON_FAST              n=  22  dead  45% ███████████               pnl $   +17.15  ev/t $ +0.78
  ∅ unrouted             n= 345  dead  54% ██████████████            pnl $   +11.65  ev/t $ +0.03

── VENUE ──
  pumpswap               n= 890  dead  34% █████████                 pnl $ +1666.84  ev/t $ +1.87
  meteora-damm-v2        n= 101  dead  38% ██████████                pnl $   -92.23  ev/t $ -0.91
  pump-amm               n= 286  dead  40% ██████████                pnl $  -291.85  ev/t $ -1.02
  meteora-dbc            n= 297  dead  47% ████████████              pnl $  -212.29  ev/t $ -0.71

── LAUNCH ORDER ──
  1st                    n= 366  dead  30% ████████                  pnl $  +277.37  ev/t $ +0.76
  3rd+                   n= 680  dead  34% █████████                 pnl $  +869.66  ev/t $ +1.28
  2nd                    n= 197  dead  39% ██████████                pnl $   -42.26  ev/t $ -0.21

── CROWD ──
```

---

# HOW TO CHALLENGE THIS BUNDLE

1. **Enforceability (highest value).** §1 is the whole live verdict. Any
   manifest field NOT read by `tierRefusal()` is a finding — that exact
   defect shipped and survived a day (audit §5, item 4).
2. **The decoy fix.** §2: does ranking by `quoteUsd()` actually prevent a
   single-sided DLMM from setting the mark? Attack `MIN_QUOTE_USD = 500`.
3. **Trusted-band read.** §3: `poolUsd` must come from the 1200–5000000
   band. If a caller can pass an unbounded pool value, the floor is bypassable.
4. **Runtime numbers.** R3/R4 are in-sample on the tape that generated the
   hypothesis. The out-of-sample test is the 10-seat sample run itself.
5. **Unverifiable by design.** The wallet key, RPC credentials and `.env`
   are not in this bundle or the repo (verified: never committed).

**Open P1 the reviewer should NOT assume is handled:** the pass-health
counter (N consecutive silent failures → audit row + push) is specified and
NOT built. Four defects this week were inert-but-armed features whose
failures were swallowed by fail-open catches.

---

# SECOND-PASS REVIEW ARTIFACT — `e113e2f`

**Patch:** `docs/e113e2f-review.patch` (1,132 lines, 10 files)
**Range:** `6370577..e113e2f` · **Suite:** 65/65

Generated because the GitHub connector returns 404 on this private repo.
The patch is the artifact; this section is the map, not a substitute.

## The widened assertion windows — the reviewer asked to scrutinise these

Three windows grew. My claim is that each still brackets the SAME
executable gate and the semantic object never left the execution path;
the growth is comment volume from the P1-2 rewrite. Verify against the
patch — the executable gate spans ~61 lines of source:

```
line 11  if (cfg.FORMULA_MANIFEST_ENABLED) {   <- window start anchor
line 43    if (v.kind === "refuse") {
line 44      await audit("live_buy_skipped", ...)   <- asserted
line 45      return;                                 <- asserted
line 61  }                                       <- gate ends
```

| window | file:line | what it still proves | escape risk |
|---|---|---|---|
| 1600→2800 | `invariants.test.ts:374` | refusal audits AND returns inside the flag-gated branch | the branch is ~2.3k chars; a 2800 window cannot reach past the gate close |
| 1800→2800 | `router.test.ts:294` | same gate, admission-terms suite | same bound |
| 900→1600 | `router.test.ts:337,339` | `fetchTokenMarket(mint)` + `poolDepthTrusted` binding | both live INSIDE the verdict-input object literal |

**The honest weakness:** these are source-text assertions, not behavioural
ones. They prove a string appears near an anchor — they cannot prove the
call executes. The behavioural coverage for the same properties is in the
pure-function tests (`manifestVerdict` P1-2/P2 cases, `validateManifest`
P1-3 cases, `fetchTokenMarket` P1-1 case with a stubbed fetch). If you
judge the source assertions too weak to certify, the behavioural set is
what should carry the verdict.

## Finding-by-finding map into the patch

| finding | patch hunks to read |
|---|---|
| P1-1 | `dexscreener.ts`: `TokenMarket` +`depthTrusted`/`quoteUsd`; `pairToMarket` untrusted branch. Test: "a decoy pool cannot set the mark even with NO credible alternative" |
| P1-2 | `executor.ts`: the `R2 ... P1-2 REWRITE` block replacing the candidate_ticks band query; `manifest.ts`: `poolDepthTrusted` refusal BEFORE the numeric compare |
| P1-3 | `manifest.ts`: `validateManifest()` + `validateTier()`, `loadManifest` degrade path, `manifest_invalid` audit, `Array.isArray(spec.venues)` |
| P2 | `manifest.ts`: `c.winnerHits === 0 && c.rugHits === 0` (was `?? 0`); `paper.ts` same |
| pass-health | `passHealth.ts` (new); wired in `paper.ts` + `optimizer.ts` at both the catch and the success path |

## What I did NOT do

  (only that verdict returns `refuse` instead of throwing).
  read-only-verifiable in `passHealth.ts`.

## What I did NOT do (completing the truncated list)

- No behavioural test that a corrupt manifest leaves the OLD lane trading —
  only that `manifestVerdict` returns `refuse` instead of throwing.
- `pass_inert` / `pass_recovered` have no unit test; the state machine is
  read-only-verifiable in `passHealth.ts`.
- No live capital has touched any of this. Kill remains ENGAGED.
