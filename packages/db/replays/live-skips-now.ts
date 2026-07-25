import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);
const rows = await sql`
  SELECT left(coalesce(details->>'reason', action), 72) AS why, count(*)::int AS n
  FROM audit_log
  WHERE created_at > now() - interval '90 minutes'
    AND action IN ('live_buy_skipped', 'entry_crowd_unknown_refused')
  GROUP BY 1 ORDER BY n DESC LIMIT 10`;
for (const r of rows) console.log(`${String(r.n).padStart(3)}× ${r.why}`);
const [bal] = await sql`
  SELECT equity_usd::float AS eq, snapped_at FROM pnl_snapshots WHERE lane = 'live' ORDER BY snapped_at DESC LIMIT 1`;
console.log(`\nlive equity: $${bal?.eq?.toFixed(2)} (${bal ? Math.round((Date.now() - new Date(bal.snapped_at).getTime()) / 60000) : "?"}m ago)`);
await sql.end();
