// STRONG-SEAT STUDY (7d) — within measured-strong (lg>=1.30), does the
// 1.65-1.95 trigger slice hold up, or was 24h a fluke? Compares the ratified
// seat (1.20-1.65) against the late slice inside the same strong band.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);
const rows = await sql`
  SELECT CASE
      WHEN co.trigger_multiple BETWEEN 1.20 AND 1.65 THEN 'seat 1.20-1.65'
      WHEN co.trigger_multiple > 1.65 AND co.trigger_multiple <= 1.95 THEN 'late 1.66-1.95'
      WHEN co.trigger_multiple > 1.95 THEN 'hot >1.95'
      ELSE 'early <1.20' END AS slice,
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
  WHERE co.liq_growth >= 1.30 AND co.label IN ('winner','dud','rug')
    AND co.triggered_at > now() - interval '7 days'
  GROUP BY 1 ORDER BY 1`;
for (const r of rows)
  console.log(`${r.slice.padEnd(15)} n=${String(r.n).padStart(4)} · win ${r.win_pct}% · rug ${r.rug_pct}% · avg peak ${r.avg_peak}x · paper $${r.paper_pnl} on $${r.paper_dep} (${r.paper_dep > 0 ? (100*r.paper_pnl/r.paper_dep).toFixed(1) : '—'}c/$)`);
await sql.end();
