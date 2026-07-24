import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const envf = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(envf)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const sql = postgres(url);
const HOURS = Number(process.argv[2] ?? 48);
// EVERY candidate the RUG_RISK signature refused in the window — full label
// distribution and what they went on to offer. Fair denominator, no viability filter.
const rows = await sql`
  WITH refused AS (
    SELECT DISTINCT a.details->>'mint' AS mint
    FROM audit_log a
    WHERE a.action = 'entry_filtered' AND a.details->>'reason' LIKE '%RUG_RISK%'
      AND a.created_at > now() - interval '1 hour' * ${HOURS})
  SELECT c.label, count(*)::int AS n,
         round(avg(c.peak_multiple::float / NULLIF(c.trigger_multiple::float,0))::numeric, 2) AS avg_offer,
         count(*) FILTER (WHERE c.peak_multiple::float / NULLIF(c.trigger_multiple::float,0) >= 1.15)::int AS offered15,
         count(*) FILTER (WHERE c.peak_multiple::float / NULLIF(c.trigger_multiple::float,0) >= 1.40)::int AS offered40
  FROM refused r JOIN candidate_outcomes c ON c.mint = r.mint
  WHERE c.trigger_multiple IS NOT NULL
  GROUP BY c.label ORDER BY n DESC`;
let tot = 0, rug = 0;
for (const r of rows) { tot += r.n; if (r.label === "rug") rug = r.n; console.log(`${r.label.padEnd(8)} ${String(r.n).padStart(4)}  avg offer ${r.avg_offer}× · ≥15%: ${r.offered15} · ≥40%: ${r.offered40}`); }
console.log(`\nTOTAL ${tot} refused · rug rate ${tot ? Math.round((100 * rug) / tot) : 0}%`);
await sql.end();
