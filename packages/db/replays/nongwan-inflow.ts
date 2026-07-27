import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);
const rows = await sql`
  SELECT created_at, action, details->>'mint' mint, details->>'inflow' inflow,
         details->>'walletWinnerHits' wh, details->>'walletRugHits' rh
  FROM audit_log
  WHERE action IN ('live_rugrisk_formula','live_subfloor_ticket') AND created_at > now() - interval '5 hours'
  ORDER BY created_at ASC`;
for (const r of rows) console.log(new Date(r.created_at).toISOString().slice(11,19), r.action, (r.mint ?? '').slice(0,6), 'inflow', r.inflow, `crowd ${r.wh}W/${r.rh}R`);
await sql.end();
