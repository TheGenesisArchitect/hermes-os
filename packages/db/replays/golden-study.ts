/**
 * GOLDEN STUDY — the first 3-day launch (Jul 16-18, pre-wallet) vs the
 * current 3 days (Jul 22-25): what were we doing then, where did we drift.
 * Operator: "the markets are producing the same opportunities every session
 * and our execution must improve."
 * Run: npx tsx packages/db/replays/golden-study.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);

const WINDOWS: [string, string, string][] = [
  ["GOLDEN Jul16-18", "2026-07-16", "2026-07-19"],
  ["NOW    Jul22-25", "2026-07-22", "2026-07-25 12:00"],
];
for (const [name, a, b] of WINDOWS) {
  const [m] = await sql`
    SELECT count(*)::int AS n,
           round(sum(realized_pnl_usd::float)::numeric, 2) AS pnl,
           round(avg(size_usd::float)::numeric, 2) AS clip,
           round((100.0 * count(*) FILTER (WHERE realized_pnl_usd::float > 0) / count(*))::numeric, 0) AS winpct,
           round(avg(extract(epoch from (closed_at - opened_at)) / 60)::numeric, 1) AS hold_min,
           round(sum(realized_pnl_usd::float) FILTER (WHERE realized_pnl_usd::float > 0)::numeric, 2) AS gw,
           round(sum(realized_pnl_usd::float) FILTER (WHERE realized_pnl_usd::float < 0)::numeric, 2) AS gl,
           round((sum(realized_pnl_usd::float) / nullif(sum(size_usd::float), 0))::numeric, 3) AS per_dollar,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM fills f WHERE f.position_id = p.id AND f.side='sell' AND f.reason LIKE 'take_profit%'))::int AS banked
    FROM positions p
    WHERE lane = 'paper' AND status = 'closed' AND closed_at >= ${a} AND closed_at < ${b}`;
  const [arr] = await sql`
    SELECT count(*)::int AS arrivals FROM candidate_outcomes
    WHERE first_seen_at >= ${a} AND first_seen_at < ${b} AND label <> 'open'`;
  const days = name.startsWith("GOLDEN") ? 3 : 3.5;
  console.log(`\n══ ${name} ══`);
  console.log(`trades ${m.n} (${Math.round(m.n / days)}/day) · arrivals ${arr.arrivals} · board rate ${Math.round((100 * m.n) / Math.max(1, arr.arrivals))}%`);
  console.log(`pnl $${m.pnl} ($${(Number(m.pnl) / days).toFixed(0)}/day) · win ${m.winpct}% · clip $${m.clip} · hold ${m.hold_min}m`);
  console.log(`gross +$${m.gw} / $${m.gl} (ratio ${m.gl && Number(m.gl) !== 0 ? Math.abs(Number(m.gw) / Number(m.gl)).toFixed(2) : "—"}) · per-$ ${m.per_dollar} · rung-banked ${Math.round((100 * m.banked) / Math.max(1, m.n))}%`);
  const exits = await sql`
    SELECT exit_reason, count(*)::int AS n, round(sum(realized_pnl_usd::float)::numeric, 2) AS pnl
    FROM positions WHERE lane = 'paper' AND status = 'closed' AND closed_at >= ${a} AND closed_at < ${b}
    GROUP BY exit_reason ORDER BY n DESC LIMIT 6`;
  console.log(`exits: ${exits.map((e) => `${e.exit_reason} ${e.n} ($${e.pnl})`).join(" · ")}`);
  const hours = await sql`
    SELECT count(DISTINCT date_trunc('hour', closed_at))::int AS active FROM positions
    WHERE lane = 'paper' AND status = 'closed' AND closed_at >= ${a} AND closed_at < ${b}`;
  console.log(`active trading hours: ${hours[0].active}`);
}
await sql.end();
