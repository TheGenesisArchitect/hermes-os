import fs from "node:fs"; import postgres from "postgres";
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync("C:/Users/mrbee/Projects/hermes-os/.env","utf8"))![1]!.trim();
const q = postgres(url);
// THE FIX-VERIFICATION LOOP: post-64cf842 (~00:20Z), armed trades (peak>=1.2x)
// must not close red — peak-triggered rung banks at 1.22x and the gain-lock
// floor holds 1.02x. Any armed-red close = mechanism failure to dissect.
const rows = await q.unsafe(`
  SELECT tk.symbol, p.signature, p.size_usd::float sz, p.realized_pnl_usd::float pnl, p.exit_reason,
    CASE WHEN p.entry_price_usd::float>0 THEN p.peak_price_usd::float/p.entry_price_usd::float ELSE 1 END peakx,
    (SELECT count(*)::int FROM fills f WHERE f.position_id=p.id AND f.side='sell' AND f.reason LIKE 'take_profit%') rungs
  FROM positions p LEFT JOIN tokens tk ON tk.mint=p.mint
  WHERE p.lane='paper' AND p.status='closed' AND p.closed_at > '2026-07-26T00:25Z'
    AND p.entry_price_usd::float>0 AND p.peak_price_usd::float/p.entry_price_usd::float >= 1.2
  ORDER BY p.pnl ASC`);
let red=0, green=0, redSum=0;
for (const r of rows as any[]) {
  if (r.pnl < 0) { red++; redSum+=r.pnl;
    console.log(`ARMED-RED: ${String(r.symbol??"?").slice(0,10)} ${r.signature} $${r.sz.toFixed(2)} peak ${r.peakx.toFixed(2)}× rungs ${r.rungs} → $${r.pnl.toFixed(2)} (${r.exit_reason})`);
  } else green++;
}
console.log(`POST-FIX armed cohort: ${green+red} trades · ${green} green · ${red} red ($${redSum.toFixed(2)})`);
await q.end();
