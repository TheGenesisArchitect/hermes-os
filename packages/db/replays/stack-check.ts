/**
 * STACK CHECK — are the shipped mechanisms actually firing and paying?
 * Micros, F6, floors/collapses, and the managed-trade KPI, one screen.
 * Run: npx tsx packages/db/replays/stack-check.ts [hours=4]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);
const H = Number(process.argv[2] ?? 4);

console.log(`── 1. MICRO-TP — firing? (since ship ~03:20Z) ──`);
const micro = await sql`
  SELECT count(*)::int AS n, round(sum(f.qty_tokens::float * f.price_usd::float)::numeric, 2) AS proceeds
  FROM fills f WHERE f.reason = 'take_profit_micro'`;
console.log(`micro fills: ${micro[0].n} · proceeds $${micro[0].proceeds ?? 0}`);
const microEligible = await sql`
  SELECT count(*)::int AS n FROM positions p
  WHERE p.opened_at > now() - interval '1 hour' * ${H} AND p.status='closed'
    AND p.entry_price_usd::float > 0 AND p.peak_price_usd::float / p.entry_price_usd::float >= 2.5
    AND p.signature <> 'RISER'`;
console.log(`closed non-RISER positions that crossed 2.5× in window: ${microEligible[0].n} (each should carry micro fills)`);

console.log(`\n── 2. F6 — stamping and firing? (since recorder restart) ──`);
const [f6] = await sql`
  SELECT count(*) FILTER (WHERE launch_order IS NOT NULL)::int AS stamped,
         count(*)::int AS triggered
  FROM candidate_outcomes WHERE triggered_at > now() - interval '4 hours'`;
console.log(`candidates stamped: ${f6.stamped}/${f6.triggered} of last-4h triggers`);
const [sl] = await sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'entry_second_launch'`;
console.log(`entry_second_launch demotions fired: ${sl.n}`);
const lcoh = await sql`
  SELECT CASE WHEN c.launch_order = 2 THEN 'L2' WHEN c.launch_order BETWEEN 3 AND 4 THEN 'L3-4' WHEN c.launch_order = 1 THEN 'L1' ELSE 'L5+' END AS b,
         count(*)::int AS n, round(sum(p.realized_pnl_usd::float)::numeric, 2) AS pnl
  FROM positions p JOIN candidate_outcomes c ON c.mint = p.mint
  WHERE p.status = 'closed' AND p.closed_at > now() - interval '4 hours' AND c.launch_order IS NOT NULL AND p.lane = 'paper'
  GROUP BY 1 ORDER BY 1`;
for (const r of lcoh) console.log(`  ${r.b.padEnd(5)} n=${r.n} $${r.pnl}`);

console.log(`\n── 3. FLOORS/COLLAPSES — rate check ──`);
const coll = await sql`
  SELECT date_trunc('hour', closed_at) AS h,
         count(*) FILTER (WHERE exit_reason = 'depth_collapse_cut')::int AS cuts,
         count(*) FILTER (WHERE exit_reason IN ('dust_rug','delisted','live_unsellable'))::int AS deaths,
         round(sum(realized_pnl_usd::float) FILTER (WHERE exit_reason IN ('dust_rug','delisted','live_unsellable'))::numeric, 2) AS death_pnl
  FROM positions WHERE closed_at > now() - interval '1 hour' * ${H} AND status = 'closed'
  GROUP BY 1 ORDER BY 1`;
for (const r of coll) console.log(`  ${new Date(r.h).toISOString().slice(11, 13)}h: cuts ${r.cuts} · full deaths ${r.deaths} ($${r.death_pnl ?? 0})`);

console.log(`\n── 4. MANAGED-TRADE KPI (24h, paper, banked ≥1 rung) ──`);
const [mg] = await sql`
  SELECT count(*)::int AS n,
         round((sum(p.realized_pnl_usd::float) / nullif(sum(p.size_usd::float), 0) * 100)::numeric, 1) AS ret,
         count(*) FILTER (WHERE p.realized_pnl_usd::float > 0)::int AS wins
  FROM positions p WHERE p.lane = 'paper' AND p.status = 'closed' AND p.closed_at > now() - interval '24 hours'
    AND EXISTS (SELECT 1 FROM fills f WHERE f.position_id = p.id AND f.side='sell' AND f.reason LIKE 'take_profit%')`;
console.log(`banked trades: ${mg.n} · ${mg.wins}/${mg.n} wins · return on deployed ${mg.ret}%`);
await sql.end();
