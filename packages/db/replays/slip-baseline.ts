/** P2 TRUE-SLIPPAGE BASELINE — SOL price derived from our own matched BUYS
 * (recorded USD ÷ chain SOL spent = implied SOL price at that instant), then
 * each matched SELL scored: chain proceeds (SOL × nearest implied price) vs
 * recorded proceeds. Self-contained — no external price API. */
import fs from "node:fs"; import postgres from "postgres";
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync("C:/Users/mrbee/Projects/hermes-os/.env","utf8"))![1]!.trim();
const q = postgres(url);
const buys = await q.unsafe(`
  SELECT extract(epoch from c.block_time) t, (f.qty_tokens::float * f.price_usd::float) usd, abs(c.sol_delta::float) sol
  FROM chain_txs c JOIN fills f ON f.id = c.matched_fill_id
  WHERE c.class='buy' AND c.sol_delta < -0.001 AND f.qty_tokens::float * f.price_usd::float > 0.5
  ORDER BY c.block_time`) as any[];
const px = buys.map((b: any) => ({ t: Number(b.t), p: b.usd / b.sol })).filter((x: any) => x.p > 50 && x.p < 500);
console.log(`implied SOL price points from buys: ${px.length} · median $${px.map((x:any)=>x.p).sort((a:number,b:number)=>a-b)[Math.floor(px.length/2)]?.toFixed(2)}`);
const priceAt = (t: number) => px.reduce((best: any, x: any) => Math.abs(x.t - t) < Math.abs(best.t - t) ? x : best, px[0]).p;
const sells = await q.unsafe(`
  SELECT tk.symbol, extract(epoch from c.block_time) t, c.sol_delta::float sol,
    (f.qty_tokens::float * f.price_usd::float) usd, f.reason
  FROM chain_txs c JOIN fills f ON f.id = c.matched_fill_id
  LEFT JOIN tokens tk ON tk.mint = c.token_mint
  WHERE c.class='sell' AND f.qty_tokens::float * f.price_usd::float > 0.5`) as any[];
const slips: number[] = [];
const worst: any[] = [];
for (const s of sells) {
  const chainUsd = s.sol * priceAt(Number(s.t));
  const slip = chainUsd / s.usd - 1;
  if (slip > -0.95 && slip < 0.5) { slips.push(slip); worst.push({ sym: s.symbol, slip, usd: s.usd, reason: s.reason }); }
}
slips.sort((a, b) => a - b);
const pct = (p: number) => (slips[Math.floor(p * slips.length)] * 100).toFixed(1);
console.log(`TRUE SLIPPAGE (n=${slips.length} sells): median ${pct(0.5)}% · p10 ${pct(0.1)}% · p90 ${pct(0.9)}% · avg ${(slips.reduce((a,b)=>a+b,0)/slips.length*100).toFixed(1)}%`);
worst.sort((a, b) => a.slip - b.slip);
for (const w of worst.slice(0, 5)) console.log(`  worst: ${String(w.sym??"?").slice(0,10)} $${w.usd.toFixed(2)} recorded → ${(w.slip*100).toFixed(1)}% (${w.reason ?? "?"})`);
await q.end();
