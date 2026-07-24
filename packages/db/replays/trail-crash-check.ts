import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);
const rows = await sql`
  SELECT t.symbol, p.size_usd::float AS s, p.realized_pnl_usd::float AS pnl, p.exit_reason,
         CASE WHEN p.entry_price_usd::float > 0 THEN p.peak_price_usd::float / p.entry_price_usd::float END AS peakx,
         (SELECT count(*) FROM fills f WHERE f.position_id = p.id AND f.side='sell' AND f.reason LIKE 'take_profit%')::int AS rungs
  FROM positions p JOIN tokens t ON t.mint = p.mint
  WHERE p.lane = 'paper' AND p.closed_at > now() - interval '20 minutes' AND p.status = 'closed'
  ORDER BY p.closed_at DESC`;
let crashed = 0;
for (const r of rows) {
  const flag = r.rungs >= 1 && r.peakx != null && r.peakx >= 1.2 && (r.pnl ?? 0) < 0.15 * r.s * (r.peakx - 1);
  if (flag) crashed++;
  console.log(`${(r.symbol ?? "?").padEnd(11)} $${r.s.toFixed(2).padStart(6)} → $${(r.pnl ?? 0).toFixed(2).padStart(6)}  peak ${r.peakx?.toFixed(2) ?? "?"}× rungs ${r.rungs}  ${r.exit_reason}${flag ? "  ⚠ banked-then-gave-back" : ""}`);
}
console.log(`\n${crashed}/${rows.length} closed with a banked rung then near-total give-back`);
await sql.end();
