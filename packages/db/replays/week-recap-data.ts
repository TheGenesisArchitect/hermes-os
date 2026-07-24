import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);

console.log("── DAILY P&L BY LANE (UTC days, closed positions) ──");
const daily = await sql`
  SELECT closed_at::date AS d, lane, count(*)::int AS n,
         round(sum(realized_pnl_usd::float)::numeric, 2) AS pnl,
         round((100.0 * count(*) FILTER (WHERE realized_pnl_usd::float > 0) / count(*))::numeric, 0) AS winpct,
         round(avg(size_usd::float)::numeric, 2) AS avgclip
  FROM positions WHERE closed_at >= '2026-07-18' AND status = 'closed'
  GROUP BY 1, 2 ORDER BY 1, 2`;
for (const r of daily) console.log(`${r.d.toISOString().slice(0, 10)} ${r.lane.padEnd(5)} n=${String(r.n).padStart(4)} pnl $${String(r.pnl).padStart(8)} win ${r.winpct}% clip $${r.avgclip}`);

console.log("\n── EQUITY ──");
const eq = await sql`
  SELECT lane,
         (SELECT equity_usd::float FROM pnl_snapshots p2 WHERE p2.lane = p.lane AND snapped_at >= '2026-07-18' ORDER BY snapped_at ASC LIMIT 1) AS wk_open,
         (SELECT equity_usd::float FROM pnl_snapshots p2 WHERE p2.lane = p.lane ORDER BY snapped_at DESC LIMIT 1) AS now
  FROM pnl_snapshots p GROUP BY lane`;
for (const r of eq) console.log(`${r.lane}: week-open $${r.wk_open?.toFixed(2)} → now $${r.now?.toFixed(2)}`);

console.log("\n── WEEK TOTALS ──");
const [wk] = await sql`
  SELECT lane, count(*)::int AS n, round(sum(realized_pnl_usd::float)::numeric, 2) AS pnl,
         round((100.0 * count(*) FILTER (WHERE realized_pnl_usd::float > 0) / count(*))::numeric, 1) AS winpct
  FROM positions WHERE closed_at >= '2026-07-18' AND status = 'closed' AND lane = 'paper' GROUP BY lane`;
const [wl] = await sql`
  SELECT count(*)::int AS n, round(sum(realized_pnl_usd::float)::numeric, 2) AS pnl,
         round((100.0 * count(*) FILTER (WHERE realized_pnl_usd::float > 0) / nullif(count(*),0))::numeric, 1) AS winpct
  FROM positions WHERE closed_at >= '2026-07-18' AND status = 'closed' AND lane = 'live'`;
console.log(`SIM  week: n=${wk?.n} pnl $${wk?.pnl} win ${wk?.winpct}%`);
console.log(`LIVE week: n=${wl?.n} pnl $${wl?.pnl} win ${wl?.winpct}%`);

console.log("\n── TODAY (Jul 24 UTC) SPLIT ──");
const today = await sql`
  SELECT lane, count(*)::int AS n, round(sum(realized_pnl_usd::float)::numeric, 2) AS pnl,
         round((100.0 * count(*) FILTER (WHERE realized_pnl_usd::float > 0) / count(*))::numeric, 0) AS winpct
  FROM positions WHERE closed_at >= '2026-07-24' AND status = 'closed' GROUP BY lane`;
for (const r of today) console.log(`${r.lane}: n=${r.n} pnl $${r.pnl} win ${r.winpct}%`);

console.log("\n── ALL-TIME LANE LEDGERS ──");
const at = await sql`
  SELECT lane, round(sum(realized_pnl_usd::float)::numeric, 2) AS pnl, count(*)::int AS n
  FROM positions WHERE status = 'closed' GROUP BY lane`;
for (const r of at) console.log(`${r.lane}: $${r.pnl} over ${r.n} closed`);

console.log("\n── COVERAGE / FUNNEL WEEK ──");
const cov = await sql`
  SELECT first_seen_at::date AS d, count(*)::int AS arrivals,
         count(*) FILTER (WHERE wallet_winner_hits >= 1 AND wallet_winner_hits - coalesce(wallet_rug_hits,0) >= 1)::int AS crowdpass
  FROM candidate_outcomes WHERE first_seen_at >= '2026-07-18' AND label <> 'open'
  GROUP BY 1 ORDER BY 1`;
for (const r of cov) console.log(`${r.d.toISOString().slice(5, 10)}: arrivals ${r.arrivals} · crowd-pass ${r.crowdpass} (${Math.round((100 * r.crowdpass) / Math.max(1, r.arrivals))}%)`);
await sql.end();
