import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);
const rows = await sql`
  SELECT t.symbol, t.mint, t.dex, t.pair_address
  FROM tokens t WHERE t.mint IN ('Eai1MSYMHnjzZmzHTeXDd8YSGauALRbBRnkdKedqSam3','4YB5X7Hu','EDVgPlaceholder')
     OR (lower(t.symbol) = 'nongwan' AND t.first_seen_at > now() - interval '6 hours')
  ORDER BY t.first_seen_at DESC LIMIT 12`;
for (const r of rows) console.log(`${r.symbol} ${r.mint.slice(0,8)}… dex=${r.dex} pair=${(r.pair_address ?? '').slice(0,8)}`);
const buys = await sql`
  SELECT created_at, action, details FROM audit_log
  WHERE action IN ('live_open','live_mandate_ticket') AND created_at > now() - interval '90 minutes'
  ORDER BY created_at DESC LIMIT 6`;
for (const b of buys) console.log(new Date(b.created_at).toISOString().slice(11,19), b.action, JSON.stringify(b.details).slice(0,220));
await sql.end();
