import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);
const SYM = process.argv[2] ?? "NODFATHER";
const [p] = await sql`
  SELECT p.mint, p.opened_at, p.closed_at, p.realized_pnl_usd::float AS pnl
  FROM positions p JOIN tokens t ON t.mint = p.mint
  WHERE t.symbol = ${SYM} AND p.lane = 'live' ORDER BY p.closed_at DESC LIMIT 1`;
if (!p) { console.log("no live position"); process.exit(0); }
const ticks = await sql`
  SELECT extract(epoch from (snapped_at - ${p.opened_at}::timestamptz)) AS t,
         liquidity_usd::float AS liq, price_usd::float AS px
  FROM candidate_ticks WHERE mint = ${p.mint}
    AND snapped_at BETWEEN ${p.opened_at}::timestamptz - interval '30 seconds' AND ${p.closed_at}::timestamptz + interval '3 minutes'
  ORDER BY snapped_at`;
for (const tk of ticks) console.log(`t=${Number(tk.t).toFixed(0).padStart(4)}s  pool $${Math.round(tk.liq ?? 0).toString().padStart(7)}  px ${tk.px}`);
console.log(`\nlive pnl $${p.pnl.toFixed(2)} · held ${((new Date(p.closed_at).getTime() - new Date(p.opened_at).getTime()) / 1000).toFixed(0)}s`);
await sql.end();
