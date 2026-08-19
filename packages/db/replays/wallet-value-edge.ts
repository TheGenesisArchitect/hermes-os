/**
 * WALLET-VALUE-EDGE HARNESS (SPEC-WALLET-GRAPH-VALUE §1.3 — the ratification gate).
 *
 * QUESTION: does the VALUE tier (realized-dollar winners) separate outcomes better
 * than the old COUNT tier (win-count winners)? For every labeled candidate with
 * holder evidence, bucket by the BEST wallet class present in its holder set:
 *   value-winner  holder in wallet_value with realized_usd ≥ VALUE_WIN_MIN
 *                 AND median entry ≥ DUST_LINE (a proven, sized, net-positive trader)
 *   count-winner  holder in wallet_reputation as a strict winner but NOT value-qualified
 *   known-other   holder recognized in either table, qualifying for neither
 *   all-fresh     no recognized holder (the rug tell)
 * Then price each cohort on the candidate's outcome: win%, rug%, avgPeak, and EV
 * of peak capture (mean peak multiple as the upside proxy).
 *
 * CAVEAT (stated, not hidden): wallet_value is reconstructed from TODAY's chain
 * state, which includes trades AFTER a candidate's window — same look-ahead the
 * deployer harness carried. Treat separation as an upper bound; the live path
 * computes the tier as-of arm time from incremental walks. A value tier that wins
 * even-under-this-caveat earns the as-of-time live build; one that loses here is
 * dead regardless.
 *
 * Run: npx tsx packages/db/replays/wallet-value-edge.ts [valueWinMin=5000] [dustLine=150]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(env)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";

const nums = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n >= 0);
const VALUE_WIN_MIN = nums[0] ?? 5000;  // realized USD floor (census p90 ≈ $6k)
const DUST_LINE = nums[1] ?? 150;       // median-entry floor in USD (census p50 ≈ $149)
const MIN_N = 30;

const pct = (a: number, b: number) => (b > 0 ? ((100 * a) / b).toFixed(1) + "%" : "—");

(async () => {
    const q = postgres(url, { idle_timeout: 15 });

    const [vw] = await q`SELECT count(*)::int n, count(*) FILTER (WHERE realized_usd >= ${VALUE_WIN_MIN} AND median_entry_sol * sol_usd_at_walk >= ${DUST_LINE})::int qualifiers FROM wallet_value`;
    console.log(`VALUE-EDGE HARNESS — wallet_value walked: ${vw.n}, VALUE-WINNER qualifiers (realized ≥ $${VALUE_WIN_MIN}, median entry ≥ $${DUST_LINE}): ${vw.qualifiers}\n`);
    if (Number(vw.qualifiers) === 0) {
        console.log("No qualifiers yet — run wallet-value-walk.ts on more wallets first.");
        await q.end();
        return;
    }

    const rows = await q`
    WITH holder_sets AS (
      SELECT sc.mint, h.value->>'owner' AS owner
      FROM safety_checks sc
      CROSS JOIN LATERAL jsonb_array_elements(sc.evidence->'holdersSampled') h
      WHERE sc.check_name='holder_concentration' AND sc.evidence ? 'holdersSampled'
    ),
    classified AS (
      SELECT hs.mint,
        bool_or(wv.realized_usd >= ${VALUE_WIN_MIN} AND wv.median_entry_sol * wv.sol_usd_at_walk >= ${DUST_LINE}) AS has_value,
        bool_or(wr.wallet IS NOT NULL AND wr.tokens >= 2 AND wr.wins >= 1 AND wr.rugs = 0) AS has_count,
        bool_or(wv.wallet IS NOT NULL OR wr.wallet IS NOT NULL) AS has_known
      FROM holder_sets hs
      LEFT JOIN wallet_value wv ON wv.wallet = hs.owner
      LEFT JOIN wallet_reputation wr ON wr.wallet = hs.owner
      GROUP BY hs.mint
    )
    SELECT
      CASE
        WHEN c.has_value THEN '1 value-winner'
        WHEN c.has_count THEN '2 count-winner (no value)'
        WHEN c.has_known THEN '3 known-other'
        ELSE '4 all-fresh'
      END AS cohort,
      count(*)::int n,
      count(*) FILTER (WHERE co.label='winner')::int winners,
      count(*) FILTER (WHERE co.label='rug')::int rugs,
      count(*) FILTER (WHERE co.label='dud')::int duds,
      round(avg(co.peak_multiple::float)::numeric, 2) avg_peak,
      round(avg(co.peak_multiple::float) FILTER (WHERE co.label='winner')::numeric, 2) avg_winner_peak
    FROM classified c JOIN candidate_outcomes co ON co.mint = c.mint
    WHERE co.label IN ('winner','rug','dud')
    GROUP BY 1 ORDER BY 1`;

    console.log("cohort                    n      win%    rug%   avgPeak  avgWinnerPeak");
    for (const r of rows) {
        const labeled = Number(r.winners) + Number(r.rugs) + Number(r.duds);
        console.log(
            `  ${String(r.cohort).padEnd(26)} ${String(r.n).padStart(5)}  ${pct(Number(r.winners), labeled).padStart(6)}  ${pct(Number(r.rugs), labeled).padStart(6)}  ${String(r.avg_peak).padStart(6)}x  ${String(r.avg_winner_peak ?? "—").padStart(6)}x ${Number(r.n) < MIN_N ? " ⚠ under-powered" : ""}`,
        );
    }

    // Lift vs the all-fresh baseline
    const base = rows.find((r) => String(r.cohort).startsWith("4"));
    const val = rows.find((r) => String(r.cohort).startsWith("1"));
    const cnt = rows.find((r) => String(r.cohort).startsWith("2"));
    if (base && val) {
        const bl = Number(base.winners) + Number(base.rugs) + Number(base.duds);
        const vl = Number(val.winners) + Number(val.rugs) + Number(val.duds);
        const bw = Number(base.winners) / (bl || 1), vw = Number(val.winners) / (vl || 1);
        console.log(`\nLIFT: value-winner cohort win-rate ${(100 * vw).toFixed(1)}% vs all-fresh ${(100 * bw).toFixed(1)}% → ${((vw - bw) * 100).toFixed(1)}pp`);
        if (cnt) {
            const cl = Number(cnt.winners) + Number(cnt.rugs) + Number(cnt.duds);
            const cw = Number(cnt.winners) / (cl || 1);
            console.log(`      count-winner cohort win-rate ${(100 * cw).toFixed(1)}% (the old definition) → value tier ${vw > cw ? "BEATS" : "does NOT beat"} count tier by ${((vw - cw) * 100).toFixed(1)}pp`);
        }
    }
    await q.end();
})();
