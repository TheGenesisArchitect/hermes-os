// PAPER FIDELITY AUDIT — is the sensor lane executing the ratified system?
// Checks sizing ladder vs mandate, exit-mechanism scorecard vs the 64cf842
// benchmark, and the trail-widen scoreboard (28% -> 40% capture target).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);

console.log("── SIZING LADDER (last 100 closes) ──");
const sizes = await sql`
  SELECT round(size_usd::numeric, 0) s, count(*)::int n,
    string_agg(DISTINCT coalesce(signature,'?'), ',') sigs
  FROM (SELECT size_usd, signature FROM positions WHERE lane='paper' AND status='closed' ORDER BY closed_at DESC LIMIT 100) x
  GROUP BY 1 ORDER BY 1 DESC LIMIT 10`;
for (const r of sizes) console.log(`  $${String(r.s).padStart(3)} × ${String(r.n).padStart(3)} · ${r.sigs}`);

console.log("── EXIT MECHANISM SCORECARD (24h, wins with peak>=1.22) ──");
const mech = await sql`
  SELECT coalesce(exit_reason,'?') reason, count(*)::int n,
    round(sum(realized_pnl_usd)::numeric,2)::float pnl,
    round((100*sum(realized_pnl_usd)/nullif(sum(size_usd*(peak_price_usd/nullif(entry_price_usd,0)-1)),0))::numeric,0)::float capture
  FROM positions
  WHERE lane='paper' AND status='closed' AND closed_at > now() - interval '24 hours'
    AND peak_price_usd/nullif(entry_price_usd,0) >= 1.22
  GROUP BY 1 ORDER BY pnl DESC`;
for (const r of mech) console.log(`  ${r.reason.padEnd(16)} n=${String(r.n).padStart(3)} · $${r.pnl} · capture ${r.capture}%`);

console.log("── TRAIL-WIDEN SCOREBOARD (last 50 armed closes, profit_trail) ──");
const [tw] = await sql`
  SELECT count(*)::int n,
    round((100*sum(realized_pnl_usd)/nullif(sum(size_usd*(peak_price_usd/nullif(entry_price_usd,0)-1)),0))::numeric,0)::float capture,
    round(sum(realized_pnl_usd)::numeric,2)::float pnl
  FROM (SELECT * FROM positions WHERE lane='paper' AND status='closed' AND exit_reason='profit_trail'
        AND peak_price_usd/nullif(entry_price_usd,0) >= 1.22 ORDER BY closed_at DESC LIMIT 50) x`;
console.log(`  profit_trail last ${tw.n}: capture ${tw.capture}% (bar: 40%, pre-widen: 28%) · $${tw.pnl}`);

console.log("── RUNG FIRING (24h: winners peak>=2.5 with 0 rungs = choke check) ──");
const [rung] = await sql`
  SELECT count(*)::int total,
    count(*) FILTER (WHERE coalesce((SELECT count(*) FROM fills f WHERE f.position_id = p.id AND f.side='sell' AND f.reason LIKE 'take_profit%'),0) = 0)::int rungless
  FROM positions p
  WHERE p.lane='paper' AND p.status='closed' AND p.closed_at > now() - interval '24 hours'
    AND p.peak_price_usd/nullif(p.entry_price_usd,0) >= 2.5`;
console.log(`  peaks >=2.5x: ${rung.total} · rungless: ${rung.rungless} (benchmark: 0 rungless deaths)`);
await sql.end();
