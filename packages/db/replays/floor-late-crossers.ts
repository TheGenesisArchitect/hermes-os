// LATE-CROSSER HARNESS (operator 2026-07-27: "The strong band is producing
// 2.7 trades an hour and the Paper lane is eating"). Live's build-back floor
// reads inflow AT the trigger tick; inflow builds over minutes. This measures
// every floor refusal in 48h: did the mint's measured inflow later cross
// 1.30x, and what did the candidate do afterward? If the crossers are the
// band paper eats, the fix is a second look on the crossing, not a lower bar.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);
const rows = await sql`
  WITH refusals AS (
    SELECT DISTINCT ON (details->>'mint') details->>'mint' AS mint, created_at,
      (regexp_match(details->>'reason', 'inflow ([0-9.]+)'))[1]::float AS ref_lg
    FROM audit_log
    WHERE action = 'live_buy_skipped' AND details->>'reason' LIKE 'build-back%'
      AND created_at > now() - interval '48 hours'
    ORDER BY details->>'mint', created_at ASC)
  SELECT
    CASE WHEN co.liq_growth >= 1.30 THEN 'crossed 1.30 later' ELSE 'never crossed' END AS grp,
    count(*)::int n,
    count(*) FILTER (WHERE co.label = 'winner')::int wins,
    count(*) FILTER (WHERE co.label = 'rug')::int rugs,
    round(avg(co.peak_multiple)::numeric, 2)::float avg_peak,
    round(avg(nullif(co.final_multiple,0))::numeric, 2)::float avg_final,
    -- paper's realized P&L on these same mints = what live left on the table
    round(coalesce(sum(pp.pnl), 0)::numeric, 2)::float paper_pnl
  FROM refusals r
  JOIN candidate_outcomes co ON co.mint = r.mint
  LEFT JOIN LATERAL (
    SELECT sum(p.realized_pnl_usd)::float pnl FROM positions p
    WHERE p.mint = r.mint AND p.lane = 'paper' AND p.status = 'closed') pp ON true
  WHERE co.label IN ('winner','dud','rug')
  GROUP BY 1 ORDER BY 1`;
for (const r of rows)
  console.log(`${r.grp.padEnd(20)} n=${String(r.n).padStart(3)} · win ${r.wins}/${r.n} · rug ${r.rugs} · avg peak ${r.avg_peak}x · avg final ${r.avg_final}x · paper pnl on these mints $${r.paper_pnl}`);
await sql.end();
