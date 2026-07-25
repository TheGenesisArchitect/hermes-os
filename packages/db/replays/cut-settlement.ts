/**
 * CUT SETTLEMENT — did the depth-cut "saves" actually return SOL to the
 * wallet? Every recent live depth_collapse_cut: its sell fill, the on-chain
 * tx signature, remaining qty, and the wallet equity trajectory.
 * Run: npx tsx packages/db/replays/cut-settlement.ts [hours=12]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);
const H = Number(process.argv[2] ?? 12);

const cuts = await sql`
  SELECT p.id, t.symbol, p.size_usd::float AS s, p.realized_pnl_usd::float AS pnl,
         p.qty_tokens::float AS qty, p.qty_remaining::float AS rem, p.closed_at
  FROM positions p JOIN tokens t ON t.mint = p.mint
  WHERE p.lane = 'live' AND p.exit_reason = 'depth_collapse_cut' AND p.closed_at > now() - interval '1 hour' * ${H}
  ORDER BY p.closed_at DESC`;
for (const c of cuts) {
  const sells = await sql`
    SELECT f.qty_tokens::float AS q, f.price_usd::float AS px, f.tx_signature, f.reason
    FROM fills f WHERE f.position_id = ${c.id} AND f.side = 'sell' ORDER BY f.filled_at`;
  const soldQty = sells.reduce((s2, f) => s2 + Number(f.q), 0);
  const soldUsd = sells.reduce((s2, f) => s2 + Number(f.q) * Number(f.px), 0);
  const signed = sells.filter((f) => f.tx_signature != null).length;
  console.log(
    `${(c.symbol ?? "?").padEnd(11)} $${c.s.toFixed(2)} → $${c.pnl.toFixed(2)} · sells ${sells.length} (${signed} on-chain-signed) · ` +
    `sold ${c.qty ? Math.round((100 * soldQty) / c.qty) : "?"}% of qty ($${soldUsd.toFixed(2)} proceeds) · remaining qty ${c.rem ?? 0}`,
  );
}
const eq = await sql`
  SELECT equity_usd::float AS eq, snapped_at FROM pnl_snapshots
  WHERE lane = 'live' ORDER BY snapped_at DESC LIMIT 6`;
console.log(`\nlive wallet equity (real on-chain valuation, newest first):`);
for (const e of eq) console.log(`  ${new Date(e.snapped_at).toISOString().slice(11, 16)}Z  $${e.eq.toFixed(2)}`);
await sql.end();
