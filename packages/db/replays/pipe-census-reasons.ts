import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const envf = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(envf)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const sql = postgres(url);
const HOURS = Number(process.argv[2] ?? 48);
const rows = await sql`
  WITH missed AS (
    SELECT mint, triggered_at,
           peak_multiple::float / NULLIF(trigger_multiple::float,0) AS offer,
           label
    FROM candidate_outcomes
    WHERE triggered_at > now() - interval '1 hour' * ${HOURS}
      AND trigger_multiple IS NOT NULL AND NOT entered
      AND peak_multiple::float / NULLIF(trigger_multiple::float,0) >= 1.15)
  SELECT
    CASE
      WHEN a.details->>'reason' LIKE '%snap%' THEN 'snap-% gate (MOON_* class bar)'
      WHEN a.details->>'reason' LIKE '%weak inflow%' THEN 'weak-inflow gate'
      WHEN a.details->>'reason' LIKE '%buy-share%' OR a.details->>'reason' LIKE '%buyshare%' THEN 'buy-share gate'
      WHEN a.details->>'reason' LIKE '%churn%' THEN 'churn dead-zone'
      WHEN a.details->>'reason' LIKE '%rugger%' THEN 'rugger rap sheet'
      WHEN a.details->>'reason' LIKE '%dispersion%' OR a.details->>'reason' LIKE '%holder%' THEN 'holder concentration'
      ELSE left(coalesce(a.details->>'reason','(none)'), 45)
    END AS gate,
    count(DISTINCT m.mint)::int AS mints,
    count(DISTINCT m.mint) FILTER (WHERE m.label = 'rug')::int AS rugs,
    round(avg(m.offer)::numeric, 2) AS avg_offer
  FROM audit_log a JOIN missed m ON a.details->>'mint' = m.mint
    AND a.created_at BETWEEN m.triggered_at - interval '5 min' AND m.triggered_at + interval '30 min'
  WHERE a.action = 'entry_filtered'
  GROUP BY 1 ORDER BY mints DESC LIMIT 12`;
for (const r of rows) console.log(`${String(r.mints).padStart(4)} mints (${r.rugs} rugs) avg offer ${r.avg_offer}×  ${r.gate}`);
await sql.end();
