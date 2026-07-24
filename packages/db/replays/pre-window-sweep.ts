/**
 * PRE-WINDOW SWEEP — three questions before the hot window:
 * (1) what is trimming trades (exit-reason × capture, last 3h)
 * (2) why is live quiet (paper opens vs live opens vs skip reasons, 45min)
 * (3) were today's live unsellables sellable while we held them (tick
 *     liquidity path between open and close vs sell attempts)
 * Run: npx tsx packages/db/replays/pre-window-sweep.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);

console.log("── 1. WHAT IS TRIMMING (paper closes, last 3h) ──────────────────");
const trims = await sql`
  SELECT exit_reason, count(*)::int AS n,
         round(avg(CASE WHEN entry_price_usd::float > 0 THEN peak_price_usd::float / entry_price_usd::float END)::numeric, 2) AS avg_peak,
         round(sum(realized_pnl_usd::float)::numeric, 2) AS pnl,
         count(*) FILTER (WHERE realized_pnl_usd::float > 0)::int AS wins
  FROM positions WHERE lane = 'paper' AND closed_at > now() - interval '3 hours'
  GROUP BY exit_reason ORDER BY n DESC`;
for (const r of trims) console.log(`${String(r.exit_reason).padEnd(18)} n=${String(r.n).padStart(3)} avg peak ${r.avg_peak}× · ${r.wins}/${r.n} wins · $${r.pnl}`);

console.log("\n── 2. WHY LIVE IS QUIET (last 45min) ────────────────────────────");
const [opens] = await sql`
  SELECT count(*) FILTER (WHERE lane = 'paper')::int AS paper, count(*) FILTER (WHERE lane = 'live')::int AS live
  FROM positions WHERE opened_at > now() - interval '45 minutes'`;
console.log(`opens: paper ${opens.paper} · live ${opens.live}`);
const skips = await sql`
  SELECT left(coalesce(details->>'reason', action), 80) AS why, count(*)::int AS n
  FROM audit_log WHERE action IN ('live_buy_skipped','entry_crowd_unknown_refused') AND created_at > now() - interval '45 minutes'
  GROUP BY 1 ORDER BY n DESC LIMIT 8`;
for (const r of skips) console.log(`${String(r.n).padStart(3)}× ${r.why}`);
const [bal] = await sql`
  SELECT value FROM config WHERE key = 'live_balance_snapshot'`.catch(() => [{ value: null }] as any);
if (bal?.value) console.log(`live balance snapshot: ${JSON.stringify(bal.value).slice(0, 120)}`);

console.log("\n── 3. THE UNSELLABLES — was there a sell window? ────────────────");
const uns = await sql`
  SELECT p.id, p.mint, t.symbol, p.opened_at, p.closed_at, p.entry_price_usd::float AS e
  FROM positions p JOIN tokens t ON t.mint = p.mint
  WHERE p.lane = 'live' AND p.exit_reason = 'live_unsellable' AND p.closed_at > now() - interval '24 hours'`;
for (const u of uns) {
  const ticks = await sql`
    SELECT price_usd::float AS px, liquidity_usd::float AS liq, snapped_at
    FROM candidate_ticks WHERE mint = ${u.mint} AND snapped_at BETWEEN ${u.opened_at} AND ${u.closed_at}
    ORDER BY snapped_at`;
  const sellable = ticks.filter((tk) => (tk.liq ?? 0) >= 1000);
  const lastSellable = sellable.length ? sellable[sellable.length - 1] : null;
  const holdMin = (new Date(u.closed_at).getTime() - new Date(u.opened_at).getTime()) / 60000;
  console.log(
    `${(u.symbol ?? "?").padEnd(11)} held ${holdMin.toFixed(1)}m · ${ticks.length} ticks · ${sellable.length} ticks with pool ≥$1k` +
    (lastSellable
      ? ` · last sellable tick ${((new Date(u.closed_at).getTime() - new Date(lastSellable.snapped_at).getTime()) / 60000).toFixed(1)}m before close at ${(lastSellable.px / u.e).toFixed(2)}× entry ($${Math.round(lastSellable.liq)} pool)`
      : " · pool never ≥$1k while held"),
  );
  const attempts = await sql`
    SELECT action, left(coalesce(details->>'reason',''), 60) AS reason, created_at
    FROM audit_log WHERE details->>'mint' = ${u.mint} AND created_at BETWEEN ${u.opened_at} AND ${u.closed_at}
      AND (action LIKE 'live_sell%' OR action LIKE '%guard%' OR action LIKE '%exit%')
    ORDER BY created_at LIMIT 5`;
  for (const a of attempts) console.log(`     ${new Date(a.created_at).toISOString().slice(11, 19)}Z ${a.action}: ${a.reason}`);
}
await sql.end();
