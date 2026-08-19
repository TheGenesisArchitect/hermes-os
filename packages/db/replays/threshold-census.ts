/**
 * THRESHOLD CENSUS (operator 2026-08-14: "gather threshold data from the memecoin
 * universe that already exists — don't guess, build on the environment we trade in").
 *
 * GOAL: derive the value-tier thresholds (DUST_LINE, VALUE_WIN_MIN, COPY_MIN_ENTRY)
 * from the MEASURED distribution of holder economics across our recorded universe,
 * not from round numbers.
 *
 * WHAT WE CAN MEASURE TODAY (no new infra): the holder-concentration evidence gives
 * each sampled holder's pct-of-supply, and we know the token's liquidity + price at
 * sample time. So holder notional ≈ (pct/100) × tokenMarketCap (fdv) or pool liq —
 * a VALUE-AT-ENTRY proxy good enough to separate dust from whales.
 *
 * Run: npx tsx packages/db/replays/threshold-census.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(env)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";

const pct = (x: number, d = 1) => (100 * x).toFixed(d) + "%";
const money = (x: number | null) => (x == null ? "—" : "$" + (x >= 1000 ? (x / 1000).toFixed(1) + "k" : x.toFixed(2)));

/** percentile helper over a sorted numeric array */
function percentiles(xs: number[], ps: number[]): Record<string, number> {
    const s = [...xs].sort((a, b) => a - b);
    const out: Record<string, number> = {};
    for (const p of ps) {
        const i = Math.min(s.length - 1, Math.max(0, Math.floor((p / 100) * s.length)));
        out[`p${p}`] = s.length ? s[i]! : 0;
    }
    return out;
}

(async () => {
    const q = postgres(url, { idle_timeout: 10 });

    // ── 1. Per-holder NOTIONAL proxy across the universe ─────────────────────
    // value = (pct/100) × the token's liquidity at the time we observed it.
    // (fdv would be the truer "market cap" basis; liq is the conservative floor and
    //  is what we reliably have on the safety_check / candidate tick.)
    console.log("Computing holder-notional distribution across the recorded universe…\n");
    const holders = await q`
    SELECT h.value->>'owner' AS owner,
      (h.value->>'pct')::float AS pct,
      nullif(t.liquidity_usd::float,0) AS liq,
      nullif(t.fdv_usd::float,0) AS fdv
    FROM safety_checks sc
    CROSS JOIN LATERAL jsonb_array_elements(sc.evidence->'holdersSampled') h
    JOIN tokens t ON t.mint = sc.mint
    WHERE sc.check_name='holder_concentration' AND sc.evidence ? 'holdersSampled'
      AND (h.value->>'pct')::float > 0`;
    // notional proxy: pct × liquidity (the conservative pool basis). fdv kept for reference.
    for (const r of holders) (r as any).notional = (Number(r.pct) / 100) * (Number(r.liq) || 0);

    const notionals = holders.map((r) => Number(r.notional)).filter((x) => Number.isFinite(x) && x > 0);
    console.log(`holders measured: ${holders.length}   with notional: ${notionals.length}`);
    const np = percentiles(notionals, [10, 25, 50, 75, 90, 95, 99]);
    console.log("\n=== HOLDER NOTIONAL (value-at-entry proxy) distribution ===");
    console.log(`  p10 ${money(np.p10)}  p25 ${money(np.p25)}  p50 ${money(np.p50)}  p75 ${money(np.p75)}  p90 ${money(np.p90)}  p95 ${money(np.p95)}  p99 ${money(np.p99)}`);

    // ── 2. Where's the dust/whale line? Bucket by notional ──────────────────
    const bands = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000];
    console.log("\n=== holders by notional band (count + share) ===");
    let prev = 0;
    for (const b of bands) {
        const n = notionals.filter((x) => x >= prev && x < b).length;
        console.log(`  ${money(prev).padStart(8)}–${money(b).padStart(8)}  n=${String(n).padStart(6)}  ${pct(n / notionals.length)}`);
        prev = b;
    }
    const over = notionals.filter((x) => x >= prev).length;
    console.log(`  ${money(prev).padStart(8)}+         n=${String(over).padStart(6)}  ${pct(over / notionals.length)}`);

    // ── 3. Do BIG holders correlate with better outcomes? (the thesis test) ──
    console.log("\n=== outcome by largest-holder notional (does size predict the token's fate?) ===");
    const byOutcome = await q`
    WITH per_mint AS (
      SELECT sc.mint,
        max((h.value->>'pct')::float) AS top_pct,
        max(nullif(t.liquidity_usd::float,0)) AS liq
      FROM safety_checks sc
      CROSS JOIN LATERAL jsonb_array_elements(sc.evidence->'holdersSampled') h
      JOIN tokens t ON t.mint = sc.mint
      WHERE sc.check_name='holder_concentration' AND sc.evidence ? 'holdersSampled'
      GROUP BY sc.mint
    )
    SELECT
      CASE
        WHEN (top_pct/100.0)*liq >= 5000 THEN '5 whale >=$5k'
        WHEN (top_pct/100.0)*liq >= 1000 THEN '4 $1k-5k'
        WHEN (top_pct/100.0)*liq >= 250  THEN '3 $250-1k'
        WHEN (top_pct/100.0)*liq >= 50   THEN '2 $50-250'
        ELSE '1 dust <$50'
      END AS band,
      count(*)::int n,
      count(*) FILTER (WHERE co.label='winner')::int winners,
      count(*) FILTER (WHERE co.label='rug')::int rugs,
      round(avg(co.peak_multiple::float)::numeric,2) avg_peak
    FROM per_mint pm JOIN candidate_outcomes co ON co.mint=pm.mint
    WHERE co.label IN ('winner','rug','dud')
    GROUP BY 1 ORDER BY 1`;
    for (const r of byOutcome) {
        const labeled = Number(r.winners) + Number(r.rugs);
        console.log(
            `  ${r.band.padEnd(14)} n=${String(r.n).padStart(5)}  win% ${pct(Number(r.winners) / (labeled || 1)).padStart(6)}  rug% ${pct(Number(r.rugs) / (labeled || 1)).padStart(6)}  avgPeak ${r.avg_peak}x`,
        );
    }

    // ── 4. Suggested thresholds from the measured distribution ───────────────
    console.log("\n=== MEASURED THRESHOLD SUGGESTIONS ===");
    console.log(`  DUST_LINE (median entry floor):   p50 = ${money(np.p50)}  → a holder below this is the median, not a conviction bet`);
    console.log(`  HIGH-VALUE holder entry:          p90 = ${money(np.p90)}  p95 = ${money(np.p95)}  → top-decile conviction`);
    console.log(`  WHALE copy-trigger entry:         p99 = ${money(np.p99)}  → the Orangie/Brez-class entry size`);

    await q.end();
})();
