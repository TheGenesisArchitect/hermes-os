/**
 * COPY GAP — for every PAPER open in the window: what did live do with the
 * same mint, door by door. The connection rate's denominator, itemized.
 * Run: npx tsx packages/db/replays/copy-gap.ts [hours=3]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);
const HOURS = Number(process.argv[2] ?? 3);
const opens = await sql`
  SELECT p.mint, t.symbol, p.size_usd::float AS s, p.opened_at, p.realized_pnl_usd::float AS pnl, p.status,
         c.signature, c.wallet_winner_hits AS wh, c.wallet_rug_hits AS rh, c.liq_growth::float AS lg,
         c.trigger_multiple::float AS tm, c.launch_order AS lo
  FROM positions p JOIN tokens t ON t.mint = p.mint LEFT JOIN candidate_outcomes c ON c.mint = p.mint
  WHERE p.lane = 'paper' AND p.opened_at > now() - interval '1 hour' * ${HOURS}
  ORDER BY p.opened_at DESC`;
let filled = 0, skipped = 0, silent = 0;
const doors = new Map<string, number>();
for (const o of opens) {
  const [live] = await sql`SELECT id, size_usd::float AS s FROM positions WHERE lane='live' AND mint=${o.mint} AND opened_at > ${o.opened_at}::timestamptz - interval '2 minutes' LIMIT 1`;
  const skips = await sql`
    SELECT left(coalesce(details->>'reason', action), 68) AS why FROM audit_log
    WHERE details->>'mint' = ${o.mint} AND action IN ('live_buy_skipped','entry_crowd_unknown_refused')
      AND created_at BETWEEN ${o.opened_at}::timestamptz - interval '2 minutes' AND ${o.opened_at}::timestamptz + interval '5 minutes'
    ORDER BY created_at DESC LIMIT 1`;
  const status = live ? `◆ FILLED $${live.s.toFixed(2)}` : skips.length ? `SKIP: ${skips[0].why}` : "SILENT (no live attempt logged)";
  if (live) filled++; else if (skips.length) { skipped++; doors.set(skips[0].why, (doors.get(skips[0].why) ?? 0) + 1); } else silent++;
  console.log(`${(o.symbol ?? "?").padEnd(11)} $${o.s.toFixed(2).padStart(6)} ${(o.signature ?? "?").padEnd(11)} crowd ${o.wh ?? "?"}W/${o.rh ?? "?"}R lg ${o.lg?.toFixed(2) ?? "—"} tm ${o.tm?.toFixed(2) ?? "—"} L${o.lo ?? "?"} → ${status}`);
}
console.log(`\npaper opens ${opens.length} · live filled ${filled} · skipped ${skipped} · silent ${silent}`);
console.log(`\nDOORS (ranked):`);
for (const [d, n] of [...doors.entries()].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(3)}× ${d}`);
await sql.end();
