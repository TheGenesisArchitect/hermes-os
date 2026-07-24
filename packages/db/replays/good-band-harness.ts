/**
 * GOOD-BAND HARNESS — the 1.20-1.30 crowd-pass cell, priced on the full
 * dataset (operator, 2026-07-25: "Run the good-band harness and let's close
 * that leak"). The deployment-inversion flag localized here: winner-rep
 * sub-strong lost −$66/24h while strong-band won +$63 — is the cell's edge
 * real at any clip, and which rung of the ladder does it deserve?
 * Run: npx tsx packages/db/replays/good-band-harness.ts [sinceDate=2026-07-15]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);
const SINCE = process.argv[2] ?? "2026-07-15";

const CELLS: [string, number, number][] = [
  ["strong 1.30-2.05", 1.30, 2.05],
  ["good  1.20-1.30", 1.20, 1.30],
  ["mild  1.05-1.20", 1.05, 1.20],
];

console.log(`crowd-pass (wh≥1 & wh>rh) settled candidates + traded book since ${SINCE}\n`);
console.log(`cell                 CANDIDATES                     TRADED BOOK`);
console.log(`                     n    win%  rug%  avgOffer      n   deployed    pnl     $/$ dep   pre-arm deaths`);
for (const [name, lo, hi] of CELLS) {
  const [c] = await sql`
    SELECT count(*)::int AS n,
           count(*) FILTER (WHERE label = 'winner')::int AS w,
           count(*) FILTER (WHERE label = 'rug')::int AS r,
           round(avg(peak_multiple::float / NULLIF(trigger_multiple::float, 0))::numeric, 2) AS offer
    FROM candidate_outcomes
    WHERE first_seen_at >= ${SINCE} AND label <> 'open'
      AND wallet_winner_hits >= 1 AND wallet_winner_hits - coalesce(wallet_rug_hits, 0) >= 1
      AND liq_growth::float >= ${lo} AND liq_growth::float < ${hi}
      AND trigger_multiple IS NOT NULL`;
  const [p] = await sql`
    SELECT count(*)::int AS n,
           round(sum(p.size_usd::float)::numeric, 2) AS dep,
           round(sum(p.realized_pnl_usd::float)::numeric, 2) AS pnl,
           count(*) FILTER (WHERE p.realized_pnl_usd::float < -0.5 * p.size_usd::float
                            AND (p.entry_price_usd::float <= 0 OR p.peak_price_usd::float / p.entry_price_usd::float < 1.2))::int AS prearm
    FROM positions p JOIN candidate_outcomes c2 ON c2.mint = p.mint
    WHERE p.lane = 'paper' AND p.status = 'closed' AND p.opened_at >= ${SINCE}
      AND c2.wallet_winner_hits >= 1 AND c2.wallet_winner_hits - coalesce(c2.wallet_rug_hits, 0) >= 1
      AND c2.liq_growth::float >= ${lo} AND c2.liq_growth::float < ${hi}`;
  const perDollar = p.dep && Number(p.dep) > 0 ? (Number(p.pnl) / Number(p.dep)).toFixed(3) : "—";
  console.log(
    `${name.padEnd(18)} ${String(c.n).padStart(4)}  ${String(Math.round((100 * c.w) / Math.max(1, c.n))).padStart(3)}%  ${String(Math.round((100 * c.r) / Math.max(1, c.n))).padStart(3)}%  ${String(c.offer ?? "—").padStart(6)}×   ${String(p.n).padStart(4)}  $${String(p.dep ?? 0).padStart(8)}  $${String(p.pnl ?? 0).padStart(8)}  ${String(perDollar).padStart(7)}   ${p.prearm}`,
  );
}

// Clip-size split inside the good band: did size predict outcome?
console.log(`\nGOOD BAND by clip size (the "does size cause the loss" cut):`);
const clips = await sql`
  SELECT CASE WHEN p.size_usd::float <= 4 THEN 'probe ≤$4' WHEN p.size_usd::float <= 8 THEN 'slot $4-8' ELSE 'over-slot >$8' END AS clip,
         count(*)::int AS n,
         round(sum(p.realized_pnl_usd::float)::numeric, 2) AS pnl,
         round((sum(p.realized_pnl_usd::float) / NULLIF(sum(p.size_usd::float), 0))::numeric, 3) AS per_dollar,
         count(*) FILTER (WHERE p.realized_pnl_usd::float > 0)::int AS wins
  FROM positions p JOIN candidate_outcomes c2 ON c2.mint = p.mint
  WHERE p.lane = 'paper' AND p.status = 'closed' AND p.opened_at >= ${SINCE}
    AND c2.wallet_winner_hits >= 1 AND c2.wallet_winner_hits - coalesce(c2.wallet_rug_hits, 0) >= 1
    AND c2.liq_growth::float >= 1.20 AND c2.liq_growth::float < 1.30
  GROUP BY 1 ORDER BY min(p.size_usd::float)`;
for (const r of clips) console.log(`  ${r.clip.padEnd(14)} n=${String(r.n).padStart(3)} · ${r.wins}/${r.n} wins · $${r.pnl} · ${r.per_dollar}/$ deployed`);
await sql.end();
