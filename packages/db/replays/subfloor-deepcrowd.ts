/**
 * SUB-FLOOR × DEEP-CROWD — is the 1.05-1.20 inflow band with a DEEP winner
 * crowd (wh≥5, 0 rug-rep) a different animal from the generic mild band the
 * F3 floor was ratified on? Tonight's live moon queue: SmiskJim 260×, SPCX
 * 8.17× (10W), MEMENOTE 6.77× (10W), 805K 3.67× (9W) — all sub-floor probes.
 * Run: npx tsx packages/db/replays/subfloor-deepcrowd.ts [since=2026-07-15]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);
const SINCE = process.argv[2] ?? "2026-07-15";

const CUTS: [string, string][] = [
  ["deep crowd wh≥5, 0 rug-rep", `c.wallet_winner_hits >= 5 AND coalesce(c.wallet_rug_hits,0) = 0`],
  ["mid crowd wh 2-4, 0 rug-rep", `c.wallet_winner_hits BETWEEN 2 AND 4 AND coalesce(c.wallet_rug_hits,0) = 0`],
  ["thin crowd wh=1", `c.wallet_winner_hits = 1 AND c.wallet_winner_hits - coalesce(c.wallet_rug_hits,0) >= 1`],
];
console.log(`SUB-FLOOR band (inflow 1.05-1.20), settled candidates since ${SINCE}:\n`);
for (const [name, cond] of CUTS) {
  const [c] = (await sql.unsafe(`
    SELECT count(*)::int AS n,
           count(*) FILTER (WHERE label = 'winner')::int AS w,
           count(*) FILTER (WHERE label = 'rug')::int AS r,
           round(avg(peak_multiple::float / NULLIF(trigger_multiple::float,0))::numeric, 2) AS offer,
           count(*) FILTER (WHERE peak_multiple::float / NULLIF(trigger_multiple::float,0) >= 3)::int AS moons3x
    FROM candidate_outcomes c
    WHERE c.first_seen_at >= '${SINCE}' AND c.label <> 'open' AND c.trigger_multiple IS NOT NULL
      AND c.liq_growth::float >= 1.05 AND c.liq_growth::float < 1.20 AND ${cond}`)) as unknown as any[];
  const [p] = (await sql.unsafe(`
    SELECT count(*)::int AS n, round(sum(p.size_usd::float)::numeric,2) AS dep,
           round(sum(p.realized_pnl_usd::float)::numeric,2) AS pnl
    FROM positions p JOIN candidate_outcomes c ON c.mint = p.mint
    WHERE p.lane='paper' AND p.status='closed' AND p.opened_at >= '${SINCE}'
      AND c.liq_growth::float >= 1.05 AND c.liq_growth::float < 1.20 AND ${cond}`)) as unknown as any[];
  const perD = p.dep && Number(p.dep) > 0 ? (Number(p.pnl) / Number(p.dep)).toFixed(3) : "—";
  console.log(`${name.padEnd(28)} cand n=${String(c.n).padStart(3)} · ${Math.round((100*c.w)/Math.max(1,c.n))}% win / ${Math.round((100*c.r)/Math.max(1,c.n))}% rug · offer ${c.offer}× · ≥3× moons: ${c.moons3x}`);
  console.log(`${"".padEnd(28)} book n=${String(p.n).padStart(3)} · $${p.pnl ?? 0} on $${p.dep ?? 0} = ${perD}/$`);
}
await sql.end();
