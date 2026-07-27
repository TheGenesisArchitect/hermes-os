import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);
// Strong-band ARRIVALS: settled candidates whose measured liq growth hit >=1.30
const arr = await sql`
  SELECT count(*)::int n,
         count(*) FILTER (WHERE label='winner')::int w,
         count(*) FILTER (WHERE label='rug')::int r
  FROM candidate_outcomes
  WHERE triggered_at > now() - interval '2 hours' AND liq_growth >= 1.30 AND label IN ('winner','dud','rug')`;
// Strong arrivals still unsettled (no label yet)
const pend = await sql`
  SELECT count(*)::int n FROM candidate_outcomes
  WHERE triggered_at > now() - interval '2 hours' AND liq_growth >= 1.30 AND (label IS NULL OR label NOT IN ('winner','dud','rug'))`;
// Paper positions opened in 2h whose candidate measured strong
const paper = await sql`
  SELECT t.symbol, p.size_usd::float s, p.status, p.realized_pnl_usd::float pnl, co.liq_growth::float lg, p.opened_at
  FROM positions p JOIN tokens t ON t.mint=p.mint
  JOIN candidate_outcomes co ON co.mint = p.mint
  WHERE p.lane='paper' AND p.opened_at > now() - interval '2 hours' AND co.liq_growth >= 1.30
  ORDER BY p.opened_at DESC`;
// Live decision-time view: how many arrivals reached the live executor with measured strong?
const skipsub = await sql`
  SELECT count(*)::int n FROM audit_log
  WHERE action='live_buy_skipped' AND created_at > now() - interval '2 hours'
    AND details->>'reason' LIKE 'build-back%'`;
const liveOpen = await sql`
  SELECT count(*)::int n FROM audit_log
  WHERE action='live_open' AND created_at > now() - interval '2 hours'`;
console.log(`strong arrivals settled 2h: ${arr[0].n} (winners ${arr[0].w}, rugs ${arr[0].r}) · unsettled ${pend[0].n}`);
console.log(`paper opens on strong-measured mints 2h: ${paper.length}`);
for (const r of paper) console.log(`  ${(r.symbol ?? "?").padEnd(11)} $${Number(r.s).toFixed(2)} lg ${Number(r.lg).toFixed(2)}x ${r.status === "open" ? "OPEN" : (Number(r.pnl) >= 0 ? "+" : "") + Number(r.pnl).toFixed(2)}`);
console.log(`live: opens 2h ${liveOpen[0].n} · sub-floor refusals 2h ${skipsub[0].n}`);
await sql.end();
