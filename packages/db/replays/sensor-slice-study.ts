// SENSOR-SLICE STUDY — the cells live STILL declines after the 2026-07-27
// strong-seat extension (1.66-1.95 @ lg>=1.30 now admitted):
//   A: trigger 1.66-2.05 @ in-envelope sub-strong inflow (1.20 <= lg < 1.30)
//   B: trigger 1.95-2.05 @ strong inflow (lg >= 1.30)
// vs the ratified seat baseline, cut by crowd (net winners aboard vs not),
// on 7d and 14d windows. Question: does the stale "-$1.01/t" still hold?
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const sql = postgres(url);

for (const days of [7, 14]) {
  const rows = await sql`
    SELECT CASE
        WHEN co.trigger_multiple BETWEEN 1.20 AND 1.65 AND co.liq_growth >= 1.30 THEN 'seat @ strong (shipped)'
        WHEN co.trigger_multiple BETWEEN 1.20 AND 1.65 AND co.liq_growth >= 1.20 THEN 'seat @ sub-strong (shipped)'
        WHEN co.trigger_multiple > 1.65 AND co.trigger_multiple <= 1.95 AND co.liq_growth >= 1.30 THEN 'ext 1.66-1.95 @ strong (shipped 07-27)'
        WHEN co.trigger_multiple > 1.65 AND co.trigger_multiple <= 2.05 AND co.liq_growth >= 1.20 AND co.liq_growth < 1.30 THEN 'CELL A: 1.66-2.05 @ sub-strong (declined)'
        WHEN co.trigger_multiple > 1.95 AND co.trigger_multiple <= 2.05 AND co.liq_growth >= 1.30 THEN 'CELL B: 1.96-2.05 @ strong (declined)'
        ELSE NULL END AS cell,
      (co.wallet_winner_hits >= 1 AND co.wallet_winner_hits > coalesce(co.wallet_rug_hits,0)) AS crowd_net,
      count(*)::int n,
      round((100.0*count(*) FILTER (WHERE co.label='winner')/count(*))::numeric,0)::float win_pct,
      round((100.0*count(*) FILTER (WHERE co.label='rug')/count(*))::numeric,0)::float rug_pct,
      round(avg(co.peak_multiple)::numeric,2)::float avg_peak,
      round(coalesce(sum(pp.pnl),0)::numeric,2)::float paper_pnl,
      round(coalesce(sum(pp.dep),0)::numeric,0)::float paper_dep
    FROM candidate_outcomes co
    LEFT JOIN LATERAL (
      SELECT sum(p.realized_pnl_usd)::float pnl, sum(p.size_usd)::float dep
      FROM positions p WHERE p.mint = co.mint AND p.lane='paper' AND p.status='closed') pp ON true
    WHERE co.label IN ('winner','dud','rug')
      AND co.triggered_at > now() - (${days} || ' days')::interval
    GROUP BY 1, 2 HAVING CASE
        WHEN co.trigger_multiple BETWEEN 1.20 AND 1.65 AND co.liq_growth >= 1.30 THEN 'seat @ strong (shipped)'
        WHEN co.trigger_multiple BETWEEN 1.20 AND 1.65 AND co.liq_growth >= 1.20 THEN 'seat @ sub-strong (shipped)'
        WHEN co.trigger_multiple > 1.65 AND co.trigger_multiple <= 1.95 AND co.liq_growth >= 1.30 THEN 'ext 1.66-1.95 @ strong (shipped 07-27)'
        WHEN co.trigger_multiple > 1.65 AND co.trigger_multiple <= 2.05 AND co.liq_growth >= 1.20 AND co.liq_growth < 1.30 THEN 'CELL A: 1.66-2.05 @ sub-strong (declined)'
        WHEN co.trigger_multiple > 1.95 AND co.trigger_multiple <= 2.05 AND co.liq_growth >= 1.30 THEN 'CELL B: 1.96-2.05 @ strong (declined)'
        ELSE NULL END IS NOT NULL
    ORDER BY 1, 2`;
  console.log(`\n===== ${days}d window =====`);
  for (const r of rows)
    console.log(
      `${String(r.cell).padEnd(44)} crowd-net=${r.crowd_net ? "Y" : "n"} n=${String(r.n).padStart(4)} · win ${String(r.win_pct).padStart(3)}% · rug ${String(r.rug_pct).padStart(3)}% · peak ${r.avg_peak}x · paper $${String(r.paper_pnl).padStart(8)} on $${r.paper_dep} (${r.paper_dep > 0 ? (100 * r.paper_pnl / r.paper_dep).toFixed(1) : "—"}c/$)`,
    );
}
await sql.end();
