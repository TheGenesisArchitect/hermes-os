/**
 * LIVE FULL AUDIT — "Find the money." (operator-ordered, live_kill engaged
 * 2026-07-25 12:47Z). Every dollar of the live wallet accounted: equity vs
 * implied deposits, all-time P&L decomposed by exit class, fees, rent,
 * today's ledger, and the ranked loss drivers.
 * Run: npx tsx packages/db/replays/live-audit.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);

console.log("══ 1. WALLET STATE ══");
const [eq] = await sql`SELECT equity_usd::float AS eq, snapped_at FROM pnl_snapshots WHERE lane = 'live' ORDER BY snapped_at DESC LIMIT 1`;
console.log(`on-chain equity: $${eq?.eq?.toFixed(2)} (${eq ? Math.round((Date.now() - new Date(eq.snapped_at).getTime()) / 60000) : "?"}m ago)`);
const eqSeries = await sql`
  SELECT date_trunc('day', snapped_at) AS d, min(equity_usd::float) AS lo, max(equity_usd::float) AS hi
  FROM pnl_snapshots WHERE lane = 'live' GROUP BY 1 ORDER BY 1`;
for (const r of eqSeries) console.log(`  ${new Date(r.d).toISOString().slice(5, 10)}: $${r.lo.toFixed(2)} – $${r.hi.toFixed(2)}`);

console.log("\n══ 2. ALL-TIME LIVE P&L, DECOMPOSED ══");
const cls = await sql`
  SELECT CASE
      WHEN exit_reason IN ('dust_rug','delisted','live_unsellable') THEN 'unsellable/write-off'
      WHEN exit_reason = 'depth_collapse_cut' THEN 'depth-rail cut'
      WHEN exit_reason LIKE 'take_profit%' OR exit_reason IN ('profit_trail','stale_take','moon_ratchet','basket_harvest','manual_harvest','stale_lock') THEN 'managed exit'
      WHEN exit_reason IN ('hard_stop','never_armed_stop','runner_timeout','fast_scratch','stop_flat','slot_displaced','classifier_stall','mirror_cut','user_cut') THEN 'stops/cuts'
      ELSE coalesce(exit_reason, 'other') END AS bucket,
    count(*)::int AS n, round(sum(realized_pnl_usd::float)::numeric, 2) AS pnl
  FROM positions WHERE lane = 'live' AND status = 'closed'
  GROUP BY 1 ORDER BY pnl`;
let allTime = 0;
for (const r of cls) { allTime += Number(r.pnl); console.log(`  ${r.bucket.padEnd(22)} n=${String(r.n).padStart(4)}  $${r.pnl}`); }
console.log(`  ALL-TIME REALIZED: $${allTime.toFixed(2)}`);
const [fees] = await sql`
  SELECT round(sum(coalesce(f.fee_usd::float, 0))::numeric, 2) AS fees
  FROM fills f JOIN positions p ON p.id = f.position_id WHERE p.lane = 'live'`;
console.log(`  total fees inside that P&L: $${fees.fees}`);
const [rent] = await sql`
  SELECT round(coalesce(sum(ll.amount_usd::float), 0)::numeric, 2) AS rent
  FROM ledger_legs ll JOIN ledger_events le ON le.id = ll.event_id
  WHERE le.book = 'live' AND le.event_type = 'rent.recovered' AND ll.account LIKE 'cash%'`.catch(() => [{ rent: "n/a" }] as any);
console.log(`  ATA rent recovered to wallet: $${rent.rent}`);

console.log("\n══ 3. TODAY (UTC) ══");
const today = await sql`
  SELECT exit_reason, count(*)::int AS n, round(sum(realized_pnl_usd::float)::numeric, 2) AS pnl
  FROM positions WHERE lane = 'live' AND status = 'closed' AND closed_at >= date_trunc('day', now())
  GROUP BY 1 ORDER BY pnl`;
let todayTot = 0;
for (const r of today) { todayTot += Number(r.pnl); console.log(`  ${String(r.exit_reason).padEnd(20)} n=${String(r.n).padStart(3)}  $${r.pnl}`); }
console.log(`  TODAY TOTAL: $${todayTot.toFixed(2)}`);

console.log("\n══ 4. DEPOSIT RECONCILIATION ══");
const [sends] = await sql`
  SELECT count(*)::int AS n, round(coalesce(sum((details->>'usd')::float), 0)::numeric, 2) AS out
  FROM audit_log WHERE action LIKE 'wallet_send%'`.catch(() => [{ n: 0, out: 0 }] as any);
console.log(`  outbound wallet sends audited: ${sends.n} ($${sends.out})`);
console.log(`  implied deposits ≈ equity − all-time P&L − rent + sends = $${(Number(eq?.eq ?? 0) - allTime - (Number(rent.rent) || 0) + Number(sends.out || 0)).toFixed(2)}`);

console.log("\n══ 5. TOP ALL-TIME LIVE LOSSES (find-the-money list) ══");
const worst = await sql`
  SELECT t.symbol, p.size_usd::float AS s, p.realized_pnl_usd::float AS pnl, p.exit_reason, p.closed_at::date AS d
  FROM positions p JOIN tokens t ON t.mint = p.mint
  WHERE p.lane = 'live' AND p.status = 'closed'
  ORDER BY p.realized_pnl_usd ASC LIMIT 12`;
for (const w of worst) console.log(`  ${(w.symbol ?? "?").padEnd(11)} $${w.s.toFixed(2).padStart(6)} → $${w.pnl.toFixed(2).padStart(7)}  ${w.exit_reason}  ${w.d.toISOString().slice(5, 10)}`);
await sql.end();
