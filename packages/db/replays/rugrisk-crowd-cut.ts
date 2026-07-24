import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const envf = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(envf)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const sql = postgres(url);
const HOURS = Number(process.argv[2] ?? 48);
// The ratification cut: RUG_RISK-refused candidates split by the F1 crowd spine
// (wh≥1 AND wh>rh) and by the F3 envelope. If crowd-pass RUG_RISK behaves like
// crowd-pass anything-else, the signature refusal is redundant with F1 and the
// cell can route to the formula gates instead of a hard veto.
const rows = await sql`
  WITH refused AS (
    SELECT DISTINCT a.details->>'mint' AS mint
    FROM audit_log a
    WHERE a.action = 'entry_filtered' AND a.details->>'reason' LIKE '%RUG_RISK%'
      AND a.created_at > now() - interval '1 hour' * ${HOURS})
  SELECT
    CASE WHEN c.wallet_winner_hits >= 1 AND c.wallet_winner_hits - coalesce(c.wallet_rug_hits,0) >= 1
         THEN 'crowd-PASS' ELSE 'crowd-fail' END AS crowd,
    CASE WHEN c.liq_growth::float BETWEEN 1.20 AND 2.05 THEN 'in-envelope'
         WHEN c.liq_growth IS NULL THEN 'unmeasured' ELSE 'out' END AS f3,
    count(*)::int AS n,
    count(*) FILTER (WHERE c.label = 'winner')::int AS winners,
    count(*) FILTER (WHERE c.label = 'rug')::int AS rugs,
    round(avg(c.peak_multiple::float / NULLIF(c.trigger_multiple::float,0))::numeric, 2) AS avg_offer,
    count(*) FILTER (WHERE c.peak_multiple::float / NULLIF(c.trigger_multiple::float,0) >= 1.40)::int AS offered40
  FROM refused r JOIN candidate_outcomes c ON c.mint = r.mint
  WHERE c.trigger_multiple IS NOT NULL AND c.label <> 'open'
  GROUP BY 1, 2 ORDER BY 1, 2`;
for (const r of rows)
  console.log(`${r.crowd} · ${r.f3.padEnd(11)} n=${String(r.n).padStart(3)}  win ${Math.round((100*r.winners)/r.n)}% · rug ${Math.round((100*r.rugs)/r.n)}% · avg offer ${r.avg_offer}× · ≥40%: ${r.offered40}`);
await sql.end();
