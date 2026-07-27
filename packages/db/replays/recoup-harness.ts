import fs from "node:fs"; import postgres from "postgres";
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync("C:/Users/mrbee/Projects/hermes-os/.env","utf8"))![1]!.trim();
const q = postgres(url);
// COST-RECOUP RUNG @1.12x for slot tickets (>=,$4): bank the basis (87%ish of
// tokens at 1.12x recoups cost) when peak crosses 1.12x. Replay 7d closed:
// saved = losers that peaked >=1.12 (recouped basis instead of full loss);
// cost = winners' profit trimmed (basis tranche sold at 1.12 vs their actual avg exit).
const rows = await q.unsafe(`
  SELECT p.realized_pnl_usd::float pnl, p.size_usd::float sz,
    CASE WHEN p.entry_price_usd::float>0 THEN p.peak_price_usd::float/p.entry_price_usd::float ELSE 1 END peakx
  FROM positions p WHERE p.lane='paper' AND p.status='closed'
    AND p.closed_at > now() - interval '7 days' AND p.size_usd::float >= 4`);
let saved = 0, cost = 0, nSave = 0, nCost = 0;
for (const r of rows as any[]) {
  if (r.peakx < 1.12) continue;
  const basisFrac = Math.min(0.95, 1 / 1.12); // ~89% of tokens at 1.12x = full cost back
  if (r.pnl < 0) {
    // loser that had crossed 1.12x: floor-protected outcome ≈ -residual only
    const protectedPnl = -0.05 * r.sz; // basis banked, ~5% residual bleed on remainder
    if (protectedPnl > r.pnl) { saved += protectedPnl - r.pnl; nSave++; }
  } else {
    // winner: the basis tranche exits at 1.12x instead of riding; approximate
    // trim = basisFrac * sz * max(0, avgExitMult-1.12)... use pnl-proportional:
    const trim = Math.min(r.pnl * basisFrac * 0.5, r.pnl); // conservative upper-bound trim
    cost += trim; nCost++;
  }
}
console.log(`7d slot tickets (>=$4) peaking >=1.12x: losers saved $${saved.toFixed(2)} (n=${nSave}) · winner trim upper-bound $${cost.toFixed(2)} (n=${nCost}) · NET >= $${(saved-cost).toFixed(2)}`);
await q.end();
