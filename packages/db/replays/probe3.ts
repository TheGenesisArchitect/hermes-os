import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))?.[1]?.trim();
(async () => {
    const q = postgres(url!, { idle_timeout: 8 });

    // Live vs paper exit-reason distribution and realized outcomes.
    const byLane = await q`
    SELECT p.lane, p.exit_reason, count(*)::int n,
      round(avg(p.realized_pnl_usd::float)::numeric, 2) avg_pnl,
      round(sum(p.realized_pnl_usd::float)::numeric, 2) total_pnl,
      round(avg(CASE WHEN p.entry_price_usd::float>0 THEN p.exit_price_usd::float/p.entry_price_usd::float END)::numeric, 3) avg_exit_mult,
      round(avg(CASE WHEN p.entry_price_usd::float>0 THEN p.peak_price_usd::float/p.entry_price_usd::float END)::numeric, 3) avg_peak_mult
    FROM positions p WHERE p.status='closed'
    GROUP BY p.lane, p.exit_reason ORDER BY p.lane, n DESC`;

    // Fill-level: paper (tx null) vs live (tx set) — slippage + count per side.
    const fills = await q`
    SELECT CASE WHEN f.tx_signature IS NULL THEN 'paper' ELSE 'live' END lane,
      f.side, count(*)::int n,
      round(avg(f.slippage_pct::float)::numeric, 3) avg_slip,
      round(max(f.slippage_pct::float)::numeric, 2) max_slip
    FROM fills f GROUP BY 1, f.side ORDER BY 1, f.side`;

    // Live exits with near-zero proceeds (the unsellable signature): exit_mult ~ 0 despite a real peak.
    const unsellable = await q`
    SELECT p.lane, count(*)::int n,
      round(avg(CASE WHEN p.entry_price_usd::float>0 THEN p.peak_price_usd::float/p.entry_price_usd::float END)::numeric,2) avg_peak,
      round(avg(CASE WHEN p.entry_price_usd::float>0 THEN p.exit_price_usd::float/p.entry_price_usd::float END)::numeric,3) avg_exit
    FROM positions p
    WHERE p.status='closed' AND p.entry_price_usd::float>0
      AND p.peak_price_usd::float/p.entry_price_usd::float >= 1.3
      AND p.exit_price_usd::float/p.entry_price_usd::float <= 0.5
    GROUP BY p.lane`;

    console.log("=== exit-reason by lane ===");
    for (const r of byLane) console.log(JSON.stringify(r));
    console.log("\n=== fills (slippage) ===");
    for (const r of fills) console.log(JSON.stringify(r));
    console.log("\n=== peaked >=1.3x but exited <=0.5x (giveaway/unsellable) ===");
    for (const r of unsellable) console.log(JSON.stringify(r));
    await q.end();
})();
