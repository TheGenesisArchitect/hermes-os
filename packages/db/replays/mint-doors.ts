import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);
const pfx = process.argv[2] ?? "";
const rows = await sql`
  SELECT created_at, action, left(coalesce(details->>'reason', details::text), 130) r
  FROM audit_log
  WHERE details->>'mint' LIKE ${pfx + "%"} AND created_at > now() - interval '2 hours'
  ORDER BY created_at ASC LIMIT 15`;
for (const r of rows) console.log(new Date(r.created_at).toISOString().slice(11,19), r.action, r.r);
const [co] = await sql`SELECT liq_growth::float lg, trigger_multiple::float tm, signature FROM candidate_outcomes co LEFT JOIN signals s ON s.mint = co.mint WHERE co.mint LIKE ${pfx + "%"} ORDER BY co.triggered_at DESC LIMIT 1`;
if (co) console.log(`inflow ${co.lg} · trigger ${co.tm} · sig ${co.signature ?? "?"}`);
await sql.end();
