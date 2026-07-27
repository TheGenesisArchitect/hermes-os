import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);
const rows = await sql`
  SELECT created_at, action, details->>'reason' r
  FROM audit_log
  WHERE details->>'mint' IN ('Eai1j4MSYMHnjzZmzHTeXDd8YSGauALRbBRnkdKedqSam3')
     OR details->>'mint' LIKE 'Eai1%' OR details->>'mint' LIKE 'Hxw8%' OR details->>'mint' LIKE 'EDVg%'
  ORDER BY created_at ASC LIMIT 30`;
for (const r of rows) console.log(new Date(r.created_at).toISOString().slice(11,19), r.action, (r.r ?? '').slice(0,110));
await sql.end();
