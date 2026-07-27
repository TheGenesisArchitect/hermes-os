// STRONG FUNNEL — for every settled-strong candidate (lg>=1.30) in 24h that
// paper traded: what happened on live? Which door ate each one?
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);
const rows = await sql`
  WITH strong AS (
    SELECT co.mint, co.liq_growth::float lg, co.label
    FROM candidate_outcomes co
    WHERE co.liq_growth >= 1.30 AND co.triggered_at > now() - interval '24 hours'),
  paperpos AS (
    SELECT p.mint, sum(p.realized_pnl_usd)::float pnl, count(*)::int n
    FROM positions p WHERE p.lane='paper' AND p.opened_at > now() - interval '24 hours'
    GROUP BY p.mint),
  livetouch AS (
    SELECT DISTINCT ON (details->>'mint') details->>'mint' mint, action,
      left(details->>'reason', 60) reason
    FROM audit_log
    WHERE created_at > now() - interval '24 hours'
      AND action IN ('live_open','live_buy_skipped','live_buy_failed','live_buy_requeued')
    ORDER BY details->>'mint', created_at DESC)
  SELECT coalesce(lt.action, 'no live evaluation') door,
         coalesce(lt.reason, '-') reason,
         count(*)::int n,
         count(*) FILTER (WHERE s.label='winner')::int wins,
         round(coalesce(sum(pp.pnl),0)::numeric,2)::float paper_pnl
  FROM strong s
  JOIN paperpos pp ON pp.mint = s.mint
  LEFT JOIN livetouch lt ON lt.mint = s.mint
  GROUP BY 1, 2 ORDER BY n DESC LIMIT 12`;
for (const r of rows) console.log(`n=${String(r.n).padStart(3)} · ${r.door.padEnd(18)} ${r.reason.padEnd(60)} wins ${r.wins} · paper $${r.paper_pnl}`);
await sql.end();
