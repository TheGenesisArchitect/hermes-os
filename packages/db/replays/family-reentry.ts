// FAMILY RE-ENTRY STUDY — does the Nth paper entry into the same ticker
// family (7d) still pay? NONGWAN/DAVE specimens suggest late re-entries are
// the adversary's re-harvest. Buckets by entry index within family.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);
const rows = await sql`
  WITH fam AS (
    SELECT p.id, lower(regexp_replace(t.symbol,'[^a-zA-Z0-9]','','g')) f,
           p.realized_pnl_usd::float pnl, p.size_usd::float s, p.exit_reason,
           row_number() OVER (PARTITION BY lower(regexp_replace(t.symbol,'[^a-zA-Z0-9]','','g')) ORDER BY p.opened_at) idx
    FROM positions p JOIN tokens t ON t.mint = p.mint
    WHERE p.lane='paper' AND p.status='closed' AND p.closed_at > now() - interval '7 days'
      AND t.symbol IS NOT NULL AND length(t.symbol) > 1)
  SELECT CASE WHEN idx=1 THEN '1st' WHEN idx<=3 THEN '2nd-3rd' WHEN idx<=6 THEN '4th-6th' ELSE '7th+' END bucket,
         count(*)::int n, round(sum(pnl)::numeric,2)::float pnl,
         round(avg(pnl)::numeric,3)::float avg,
         round((100.0*count(*) FILTER (WHERE pnl>0.005)/count(*))::numeric,0)::float win,
         round((100.0*count(*) FILTER (WHERE exit_reason IN ('dust_rug','hard_stop') AND pnl < -0.5*s)/count(*))::numeric,0)::float rugpct
  FROM fam GROUP BY 1 ORDER BY min(idx)`;
for (const r of rows) console.log(`${r.bucket.padEnd(8)} n=${String(r.n).padStart(4)} · pnl $${r.pnl} · avg $${r.avg} · win ${r.win}% · deep-loss ${r.rugpct}%`);
await sql.end();
