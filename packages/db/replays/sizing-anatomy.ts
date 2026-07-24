import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);
const rows = await sql`
  SELECT p.id, t.symbol, p.lane, p.size_usd::float AS s, p.opened_at, p.realized_pnl_usd::float AS pnl, p.status,
         c.signature, c.wallet_winner_hits AS wh, c.wallet_strict_hits AS sh, c.wallet_rug_hits AS rh, c.stars
  FROM positions p JOIN tokens t ON t.mint = p.mint LEFT JOIN candidate_outcomes c ON c.mint = p.mint
  WHERE p.lane = 'paper' AND p.opened_at > now() - interval '4 hours'
  ORDER BY p.opened_at DESC LIMIT 20`;
for (const r of rows) {
  const audits = await sql`
    SELECT action FROM audit_log
    WHERE details->>'mint' = (SELECT mint FROM positions WHERE id = ${r.id})
      AND created_at BETWEEN ${r.opened_at}::timestamptz - interval '2 minutes' AND ${r.opened_at}::timestamptz + interval '2 minutes'
      AND action IN ('entry_sensor_tier','entry_recovered_tier','entry_moonshot_tier','entry_mandate_size','entry_rugrisk_formula')`;
  const tags = audits.map((a) => a.action.replace("entry_", "")).join(",") || "none";
  const hr = new Date(r.opened_at).getUTCHours();
  console.log(
    `${new Date(r.opened_at).toISOString().slice(11, 16)}Z ${(r.symbol ?? "?").padEnd(10)} $${r.s.toFixed(2).padStart(6)} ` +
    `${(r.signature ?? "?").padEnd(11)} ${r.stars ?? "?"}★ crowd ${r.wh ?? "?"}W(${r.sh ?? "–"}s)/${r.rh ?? "?"}R · ${tags} · utcHr ${hr}`,
  );
}
const [cfgRow] = await sql`SELECT count(*) FILTER (WHERE action = 'entry_mandate_size')::int AS mandates FROM audit_log WHERE created_at > now() - interval '4 hours'`;
console.log(`\nmandate clamps fired in 4h: ${cfgRow.mandates}`);
await sql.end();
