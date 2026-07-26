import fs from "node:fs"; import postgres from "postgres";
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync("C:/Users/mrbee/Projects/hermes-os/.env","utf8"))![1]!.trim();
const q = postgres(url);
const rows = await q.unsafe(`
  SELECT tk.symbol, p.signature sig, p.size_usd::float sz, p.realized_pnl_usd::float pnl, p.exit_reason,
    CASE WHEN p.entry_price_usd::float>0 THEN p.peak_price_usd::float/p.entry_price_usd::float ELSE 1 END peakx,
    (SELECT count(*)::int FROM fills f WHERE f.position_id=p.id AND f.side='sell' AND f.reason LIKE 'take_profit%') rungs
  FROM positions p LEFT JOIN tokens tk ON tk.mint=p.mint
  WHERE p.lane='paper' AND p.status='closed' AND p.signature LIKE 'MOON%'
  ORDER BY p.closed_at DESC LIMIT 50`);
let off=0, act=0, pass=0, partial=0, runglessFail=0, budgeted=0;
const mech: Record<string,{n:number,pnl:number}> = {};
for (const r of rows as any[]) {
  const offer = Math.max(0, r.sz*(r.peakx-1)); const capt = offer>=0.5 ? 100*r.pnl/offer : null;
  off+=offer; act+=r.pnl;
  if (r.peakx < 1.2) budgeted++;
  else if (r.rungs===0 && r.pnl<0) runglessFail++;
  else if (capt!=null && capt>=40) pass++; else partial++;
  const m=r.exit_reason??"?"; mech[m]=mech[m]??{n:0,pnl:0}; mech[m].n++; mech[m].pnl+=r.pnl;
}
console.log(`LAST 50 MOONS vs 64cf842: offered $${off.toFixed(2)} · banked $${act.toFixed(2)} · capture ${Math.round(100*act/off)}%`);
console.log(`VERDICTS: PASS(armed ≥40%) ${pass} · PARTIAL(armed <40%) ${partial} · RUNGLESS-FAIL ${runglessFail} · BUDGETED(pre-arm) ${budgeted}`);
for (const [m,v] of Object.entries(mech).sort((a,b)=>a[1].pnl-b[1].pnl)) console.log(`  ${m}: n=${v.n} Σ$${v.pnl.toFixed(2)}`);
// FIX LOOP: post-00:25Z armed cohort — green-then-cave should be dead
const post = await q.unsafe(`
  SELECT tk.symbol, p.signature sig, p.size_usd::float sz, p.realized_pnl_usd::float pnl, p.exit_reason,
    CASE WHEN p.entry_price_usd::float>0 THEN p.peak_price_usd::float/p.entry_price_usd::float ELSE 1 END peakx,
    (SELECT count(*)::int FROM fills f WHERE f.position_id=p.id AND f.side='sell' AND f.reason LIKE 'take_profit%') rungs
  FROM positions p LEFT JOIN tokens tk ON tk.mint=p.mint
  WHERE p.lane='paper' AND p.status='closed' AND p.closed_at > '2026-07-26T00:25Z'
    AND p.entry_price_usd::float>0 AND p.peak_price_usd::float/p.entry_price_usd::float >= 1.2
  ORDER BY p.realized_pnl_usd ASC`);
let red=0, green=0, redSum=0;
for (const r of post as any[]) {
  if (r.pnl < 0) { red++; redSum+=r.pnl;
    console.log(`ARMED-RED post-fix: ${String(r.symbol??"?").slice(0,10)} ${r.sig} $${r.sz.toFixed(2)} peak ${r.peakx.toFixed(2)}× rungs ${r.rungs} → $${r.pnl.toFixed(2)} (${r.exit_reason})`);
  } else green++;
}
console.log(`POST-FIX ARMED COHORT: ${green+red} trades · ${green} green · ${red} red ($${redSum.toFixed(2)})`);
await q.end();
