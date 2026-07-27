// Watch pg_stat_activity while the dashboard renders — catches the slow query in the act.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);
fetch("http://localhost:3777/").catch(() => {});
const seen = new Map<string, number>();
for (let i = 0; i < 40; i++) {
  const rows = await sql`
    SELECT left(query, 110) q, extract(epoch from now() - query_start)::float dur
    FROM pg_stat_activity
    WHERE state = 'active' AND query NOT LIKE '%pg_stat_activity%' AND query_start IS NOT NULL`;
  for (const r of rows) {
    const k = String(r.q).replace(/\s+/g, " ");
    seen.set(k, Math.max(seen.get(k) ?? 0, Number(r.dur)));
  }
  await new Promise((res) => setTimeout(res, 250));
}
const top = [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
for (const [q, d] of top) console.log(`${d.toFixed(1)}s  ${q}`);
await sql.end();
