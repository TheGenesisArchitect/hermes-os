/**
 * HOUR REVIEW — how did the full system manage the last N minutes of trading?
 * Funnel → boards by tier → exits → rails → both lanes' money, one screen.
 * Run: npx tsx packages/db/replays/hour-review.ts [minutes=60]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);
const MIN = Number(process.argv[2] ?? 60);
const iv = sql`now() - interval '1 minute' * ${MIN}`;

const [funnel] = await sql`
  SELECT (SELECT count(*)::int FROM candidate_outcomes WHERE first_seen_at > ${iv}) AS arrivals,
         (SELECT count(*)::int FROM candidate_outcomes WHERE triggered_at > ${iv}) AS triggered,
         (SELECT count(*)::int FROM positions WHERE lane = 'paper' AND opened_at > ${iv}) AS paper_opens,
         (SELECT count(*)::int FROM positions WHERE lane = 'live' AND opened_at > ${iv}) AS live_opens`;
console.log(`FUNNEL ${MIN}m: ${funnel.arrivals} arrivals → ${funnel.triggered} triggered → ${funnel.paper_opens} paper boards · ${funnel.live_opens} live boards`);

for (const lane of ["paper", "live"]) {
  const [m] = await sql`
    SELECT count(*)::int AS closed, round(sum(realized_pnl_usd::float)::numeric, 2) AS pnl,
           count(*) FILTER (WHERE realized_pnl_usd::float > 0)::int AS wins,
           round(sum(CASE WHEN entry_price_usd::float > 0 AND peak_price_usd::float/entry_price_usd::float > 1
                          THEN (peak_price_usd::float/entry_price_usd::float - 1) * size_usd::float ELSE 0 END)::numeric, 2) AS offered
    FROM positions WHERE lane = ${lane} AND closed_at > ${iv}`;
  console.log(`${lane.toUpperCase().padEnd(5)} closed ${m.closed} · ${m.wins}/${m.closed} wins · pnl $${m.pnl ?? 0} · offered $${m.offered ?? 0} · capture ${m.offered && Number(m.offered) > 0 ? Math.round((100 * Number(m.pnl ?? 0)) / Number(m.offered)) : "—"}%`);
}

console.log(`\nEXITS (both lanes, closed in window):`);
const exits = await sql`
  SELECT exit_reason, lane, count(*)::int AS n, round(sum(realized_pnl_usd::float)::numeric, 2) AS pnl
  FROM positions WHERE closed_at > ${iv} GROUP BY exit_reason, lane ORDER BY pnl`;
for (const e of exits) console.log(`  ${String(e.exit_reason).padEnd(20)} ${e.lane === "live" ? "◆" : " "} n=${String(e.n).padStart(2)}  $${e.pnl}`);

console.log(`\nTIER of boards (audits in window):`);
const tiers = await sql`
  SELECT action, count(*)::int AS n FROM audit_log
  WHERE created_at > ${iv} AND action IN ('entry_moonshot_tier','entry_rugrisk_formula','entry_recovered_tier',
    'entry_sensor_tier','entry_mandate_size','live_mandate_ticket','live_moonshot_tier','live_rugrisk_formula')
  GROUP BY action ORDER BY n DESC`;
for (const t of tiers) console.log(`  ${t.action.padEnd(24)} ${t.n}`);

console.log(`\nRAILS:`);
const [rails] = await sql`
  SELECT (SELECT count(*)::int FROM positions WHERE closed_at > ${iv} AND exit_reason = 'depth_collapse_cut') AS depth_cuts,
         (SELECT round(sum(realized_pnl_usd::float)::numeric, 2) FROM positions WHERE closed_at > ${iv} AND exit_reason = 'depth_collapse_cut') AS depth_pnl,
         (SELECT count(*)::int FROM positions WHERE closed_at > ${iv} AND exit_reason IN ('dust_rug','delisted','live_unsellable')) AS full_deaths,
         (SELECT round(sum(realized_pnl_usd::float)::numeric, 2) FROM positions WHERE closed_at > ${iv} AND exit_reason IN ('dust_rug','delisted','live_unsellable')) AS death_pnl,
         (SELECT count(*)::int FROM audit_log WHERE created_at > ${iv} AND action = 'live_buy_skipped') AS live_skips`;
console.log(`  depth cuts ${rails.depth_cuts} ($${rails.depth_pnl ?? 0}) · full deaths ${rails.full_deaths} ($${rails.death_pnl ?? 0}) · live skips ${rails.live_skips}`);

console.log(`\nTOP ±: `);
const tops = await sql`
  SELECT t.symbol, p.lane, p.size_usd::float AS s, p.realized_pnl_usd::float AS pnl, p.exit_reason
  FROM positions p JOIN tokens t ON t.mint = p.mint
  WHERE p.closed_at > ${iv} ORDER BY abs(p.realized_pnl_usd::float) DESC LIMIT 6`;
for (const r of tops) console.log(`  ${r.lane === "live" ? "◆" : " "} ${(r.symbol ?? "?").padEnd(11)} $${r.s.toFixed(2).padStart(6)} → $${r.pnl.toFixed(2).padStart(7)}  ${r.exit_reason}`);
await sql.end();
