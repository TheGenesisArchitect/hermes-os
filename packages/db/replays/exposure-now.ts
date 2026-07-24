import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);
const rows = await sql`
  SELECT p.lane, t.symbol, p.size_usd::float AS s,
         extract(epoch from (now() - p.opened_at))/60 AS mins
  FROM positions p JOIN tokens t ON t.mint = p.mint
  WHERE p.status = 'open' ORDER BY p.lane, p.opened_at`;
for (const r of rows) console.log(`${r.lane === "live" ? "◆LIVE" : "  SIM"} ${(r.symbol ?? "?").padEnd(11)} $${r.s.toFixed(2)} open ${Number(r.mins).toFixed(1)}m`);
console.log(`total open: ${rows.length}`);
const errs = await sql`
  SELECT action, left(coalesce(details->>'reason', details->>'error', ''), 90) AS msg, count(*)::int AS n
  FROM audit_log WHERE created_at > now() - interval '20 minutes'
    AND (action LIKE '%fail%' OR action LIKE '%skip%' OR coalesce(details->>'reason','') ~* 'jupiter|quote|route|provider')
  GROUP BY 1, 2 ORDER BY n DESC LIMIT 8`;
console.log(`\nrecent error-class audits (20m):`);
for (const e of errs) console.log(`${String(e.n).padStart(3)}× ${e.action}: ${e.msg}`);
await sql.end();
