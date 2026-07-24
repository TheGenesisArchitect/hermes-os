/**
 * LEDGER RECONCILIATION — do the books agree that today's green is real?
 * Compares, per lane: positions realized P&L vs fills cash-flow vs the
 * double-entry ledger vs the equity curve vs the compounding bankroll input.
 * Run: npx tsx packages/db/replays/ledger-recon.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const envf = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(envf)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const sql = postgres(url);

for (const lane of ["paper", "live"]) {
  console.log(`\n════ ${lane.toUpperCase()} ════`);
  // 1. Positions book — today (UTC) and all-time.
  const [pos] = await sql`
    SELECT round(coalesce(sum(realized_pnl_usd::float) FILTER (WHERE closed_at >= date_trunc('day', now())), 0)::numeric, 2) AS today,
           round(coalesce(sum(realized_pnl_usd::float), 0)::numeric, 2) AS alltime,
           count(*) FILTER (WHERE closed_at >= date_trunc('day', now()))::int AS n_today,
           count(*) FILTER (WHERE status = 'open')::int AS n_open
    FROM positions WHERE lane = ${lane}`;
  console.log(`positions book: today $${pos.today} (${pos.n_today} closed) · all-time $${pos.alltime} · ${pos.n_open} open`);
  // 2. Fills cash-flow — sells minus buys on closed positions today.
  const [fl] = await sql`
    SELECT round(coalesce(sum(CASE WHEN f.side = 'sell' THEN f.qty_tokens::float * f.price_usd::float - coalesce(f.fee_usd::float, 0)
                                   ELSE -(f.qty_tokens::float * f.price_usd::float) - coalesce(f.fee_usd::float, 0) END), 0)::numeric, 2) AS cash
    FROM fills f JOIN positions p ON p.id = f.position_id
    WHERE p.lane = ${lane} AND p.status = 'closed' AND p.closed_at >= date_trunc('day', now())`;
  console.log(`fills cash-flow (today's closed): $${fl.cash}`);
  // 3. Double-entry ledger.
  const [led] = await sql`
    SELECT round(coalesce(sum(ll.amount_usd::float), 0)::numeric, 2) AS bal,
           round(coalesce(sum(ll.amount_usd::float) FILTER (WHERE le.occurred_at >= date_trunc('day', now())), 0)::numeric, 2) AS today
    FROM ledger_legs ll JOIN ledger_events le ON le.id = ll.event_id
    WHERE le.book = ${lane} AND ll.account = 'cash'`.catch(() => [{ bal: "n/a", today: "n/a" }] as any);
  console.log(`ledger cash account: today $${led.today} · balance $${led.bal}`);
  // 4. Equity curve — first vs latest snapshot today.
  const snaps = await sql`
    (SELECT equity_usd::float AS eq, snapped_at FROM pnl_snapshots WHERE lane = ${lane} AND snapped_at >= date_trunc('day', now()) ORDER BY snapped_at ASC LIMIT 1)
    UNION ALL
    (SELECT equity_usd::float, snapped_at FROM pnl_snapshots WHERE lane = ${lane} ORDER BY snapped_at DESC LIMIT 1)`;
  if (snaps.length === 2) {
    console.log(`equity curve: day-open $${snaps[0].eq.toFixed(2)} → latest $${snaps[1].eq.toFixed(2)} (${new Date(snaps[1].snapped_at).toISOString().slice(11, 19)}Z) · Δ $${(snaps[1].eq - snaps[0].eq).toFixed(2)}`);
  } else console.log(`equity curve: snapshots ${snaps.length}`);
}
// 5. Paper bankroll inputs (compounding source).
const [cfgRow] = await sql`SELECT value FROM config WHERE key = 'trader_health'`;
console.log(`\ntrader heartbeat: ${JSON.stringify(cfgRow?.value)}`);
const [openVal] = await sql`
  SELECT round(coalesce(sum(size_usd::float), 0)::numeric, 2) AS deployed, count(*)::int AS n
  FROM positions WHERE lane = 'paper' AND status = 'open'`;
console.log(`paper open exposure: $${openVal.deployed} across ${openVal.n} slots`);
await sql.end();
