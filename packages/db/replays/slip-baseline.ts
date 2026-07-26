/** P2 entry requirement: TRUE slippage — chain proceeds vs recorded, matched sells. */
import fs from "node:fs"; import postgres from "postgres";
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync("C:/Users/mrbee/Projects/hermes-os/.env","utf8"))![1]!.trim();
const q = postgres(url);
const [r] = await q.unsafe(`
  SELECT count(*)::int n,
    round(avg( (c.sol_delta::float * 190) / nullif(f.qty_tokens::float * f.price_usd::float, 0) - 1 )::numeric * 100, 2) AS avg_slip_pct,
    round(percentile_cont(0.9) WITHIN GROUP (ORDER BY (c.sol_delta::float * 190) / nullif(f.qty_tokens::float * f.price_usd::float, 0) - 1)::numeric * 100, 2) AS p90
  FROM chain_txs c JOIN fills f ON f.id = c.matched_fill_id
  WHERE c.class = 'sell' AND f.qty_tokens::float * f.price_usd::float > 0.5`) as any[];
console.log(`P2 baseline — matched live sells: n=${r.n} · avg chain-vs-recorded ${r.avg_slip_pct}% · p90 ${r.p90}% (SOL at ~$190 est)`);
await q.end();
