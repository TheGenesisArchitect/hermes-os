// LIVE TODAY — every live position touched today (UTC), named, plus arm
// state and door activity. The operator's "what's the status" one-shot.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);
const rows = await sql`
  SELECT t.symbol, p.size_usd::float s, p.realized_pnl_usd::float pnl, p.status,
         p.exit_reason, p.opened_at, p.closed_at,
         round((p.peak_price_usd/nullif(p.entry_price_usd,0))::numeric, 2)::float peak
  FROM positions p JOIN tokens t ON t.mint = p.mint
  WHERE p.lane = 'live' AND (p.opened_at > date_trunc('day', now()) OR p.closed_at > date_trunc('day', now()))
  ORDER BY p.opened_at DESC`;
console.log(`LIVE positions today (UTC): ${rows.length}`);
for (const r of rows) {
  const res = r.status === "open" ? "OPEN" : `${Number(r.pnl) >= 0 ? "+" : ""}${Number(r.pnl).toFixed(2)}`;
  console.log(
    `  ${(r.symbol ?? "?").padEnd(11)} $${Number(r.s).toFixed(2).padStart(6)} -> ${res.padStart(7)}  peak ${r.peak ?? "?"}x  ${r.exit_reason ?? ""}  ${new Date(r.opened_at).toISOString().slice(5, 16)}`,
  );
}
const [kill] = await sql`SELECT value FROM config WHERE key = 'live_kill'`;
const [golden] = await sql`SELECT count(*)::int n FROM audit_log WHERE action = 'live_golden_window' AND created_at > now() - interval '24 hours'`;
const [mand] = await sql`SELECT count(*)::int n FROM audit_log WHERE action = 'live_mandate_ticket' AND created_at > now() - interval '24 hours'`;
console.log(`kill: ${JSON.stringify(kill?.value ?? null)} | golden fires 24h: ${golden.n} | mandate tickets 24h: ${mand.n}`);
await sql.end();
