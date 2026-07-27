import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);
try {
  const rows = await sql`
    SELECT left(query, 90) q, calls, round(mean_exec_time::numeric,0) ms, round(total_exec_time::numeric/1000,0) total_s
    FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 12`;
  for (const r of rows) console.log(`${String(r.ms).padStart(6)}ms avg ×${String(r.calls).padStart(5)} (${r.total_s}s total) ${r.q.replace(/\s+/g,' ')}`);
} catch (e) {
  console.log('pg_stat_statements unavailable:', (e as Error).message.slice(0,80));
}
await sql.end();
