import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);
console.log("── open positions named DIP-ish ──");
const pos = await sql`
  SELECT p.id, p.lane, t.symbol, p.mint, p.status, p.size_usd::float AS s,
         extract(epoch from (now() - p.opened_at))/60 AS mins
  FROM positions p JOIN tokens t ON t.mint = p.mint
  WHERE t.symbol ILIKE '%dip%' AND p.opened_at > now() - interval '2 hours'
  ORDER BY p.opened_at DESC`;
for (const p of pos) console.log(`#${p.id} ${p.lane} ${p.symbol} ${p.status} $${p.s.toFixed(2)} open ${Number(p.mins).toFixed(1)}m ${p.mint.slice(0, 8)}`);
console.log("\n── live_close_request config row ──");
const [req] = await sql`SELECT value, updated_at FROM config WHERE key = 'live_close_request'`;
console.log(req ? `${JSON.stringify(req.value)} · updated ${new Date(req.updated_at).toISOString()}` : "none");
console.log("\n── recent close/sell audits (15m) ──");
const aud = await sql`
  SELECT created_at, actor, action, left(coalesce(details->>'reason', details::text), 100) AS d
  FROM audit_log WHERE created_at > now() - interval '15 minutes'
    AND (action LIKE '%close%' OR action LIKE 'live_sell%' OR action = 'user_cut' OR actor = 'user')
  ORDER BY created_at DESC LIMIT 10`;
for (const a of aud) console.log(`${new Date(a.created_at).toISOString().slice(11, 19)}Z ${a.actor}/${a.action}: ${a.d}`);
if (!aud.length) console.log("no close-related audits in 15m");
await sql.end();
