/** RISER moon-tail autopsy (operator 2026-07-25: Ferret 5.26× → +$0.34).
 * RISERs with peak ≥2.5× over 7d: what the no-ratchet exclusion costs. */
import fs from "node:fs"; import postgres from "postgres";
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync("C:/Users/mrbee/Projects/hermes-os/.env","utf8"))![1]!.trim();
const q = postgres(url);
const MS = [2.5, 3, 5, 8, 13, 21, 34, 55];
const rows = await q.unsafe(`
  SELECT tk.symbol, p.size_usd::float sz, p.realized_pnl_usd::float pnl, p.exit_reason,
    CASE WHEN p.entry_price_usd::float > 0 THEN p.peak_price_usd::float/p.entry_price_usd::float ELSE 1 END peakx,
    CASE WHEN p.entry_price_usd::float > 0 AND p.exit_price_usd IS NOT NULL THEN p.exit_price_usd::float/p.entry_price_usd::float END exitx,
    (SELECT coalesce(sum(f.qty_tokens::float * f.price_usd::float),0) / nullif(p.size_usd::float,0) FROM fills f WHERE f.position_id=p.id AND f.side='sell' AND f.reason LIKE 'take_profit%') sold_rungs
  FROM positions p LEFT JOIN tokens tk ON tk.mint=p.mint
  WHERE p.lane='paper' AND p.status='closed' AND p.closed_at > now() - interval '7 days'
    AND p.signature='RISER'
    AND p.entry_price_usd::float > 0 AND p.peak_price_usd::float/p.entry_price_usd::float >= 2.5
  ORDER BY peakx DESC`);
let act = 0, cf = 0, n = 0;
for (const r of rows as any[]) {
  n++;
  const top = MS.filter((m) => r.peakx >= m).pop() ?? 0;
  const remainder = Math.max(0, 1 - Number(r.sold_rungs || 0));
  const exitx = r.exitx ?? 0;
  const ratchetExit = top ? 0.7 * top : exitx;
  const delta = remainder * r.sz * Math.max(0, ratchetExit - exitx);
  act += r.pnl; cf += r.pnl + delta;
  console.log(`${String(r.symbol??"?").slice(0,10).padEnd(10)} $${r.sz.toFixed(2)} peak ${r.peakx.toFixed(2)}× exit ${exitx.toFixed(2)}× rem ${(remainder*100).toFixed(0)}% ${r.exit_reason} · actual $${r.pnl.toFixed(2)} → w/ratchet ≈$${(r.pnl+delta).toFixed(2)}`);
}
console.log(`\nRISER peak≥2.5× · 7d: n=${n} · actual $${act.toFixed(2)} · with milestone ratchet ≈$${cf.toFixed(2)} · left on table $${(cf-act).toFixed(2)}`);
await q.end();
