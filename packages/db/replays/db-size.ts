import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);
const rows = await sql`
  SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) sz,
         n_live_tup::bigint rows
  FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 10`;
for (const r of rows) console.log(`${r.relname.padEnd(22)} ${String(r.sz).padStart(10)} · ~${r.rows} rows`);
await sql.end();
