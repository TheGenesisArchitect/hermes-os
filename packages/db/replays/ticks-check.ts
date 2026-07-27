import fs from "node:fs"; import postgres from "postgres";
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync("C:/Users/mrbee/Projects/hermes-os/.env","utf8"))![1]!.trim();
const q = postgres(url);
const [c] = await q`SELECT count(*)::int n, count(DISTINCT mint)::int mints, max(at) latest FROM chain_ticks`;
console.log(`chain_ticks: ${c.n} rows · ${c.mints} pools · latest ${c.latest ? new Date(c.latest).toISOString().slice(11,19) : "—"}Z`);
const [o] = await q`SELECT count(*)::int n FROM positions WHERE status='open'`;
console.log(`open positions: ${o.n}`);
await q.end();
