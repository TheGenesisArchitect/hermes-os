import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);
const rows = await sql`
  SELECT created_at, details FROM audit_log
  WHERE action = 'live_golden_window' AND created_at > now() - interval '24 hours'
  ORDER BY created_at DESC`;
for (const r of rows) console.log(new Date(r.created_at).toISOString().slice(5, 16), JSON.stringify(r.details).slice(0, 180));
const skips = await sql`
  SELECT created_at, details->>'reason' reason FROM audit_log
  WHERE action = 'live_buy_skipped' AND created_at > now() - interval '14 hours'
  ORDER BY created_at DESC LIMIT 12`;
console.log("--- recent skips:");
for (const r of skips) console.log(new Date(r.created_at).toISOString().slice(5, 16), String(r.reason).slice(0, 110));
await sql.end();
