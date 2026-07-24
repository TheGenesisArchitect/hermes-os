import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);
const rows = await sql`
  SELECT t.symbol, c.mint, c.signature, c.stars, c.armed, c.entered,
         c.wallet_winner_hits AS wh, c.wallet_strict_hits AS sh, c.wallet_rug_hits AS rh,
         c.liq_growth::float AS lg, c.trigger_multiple::float AS tm,
         c.peak_multiple::float AS peak,
         extract(epoch from (now() - c.triggered_at))/60 AS trig_min
  FROM candidate_outcomes c JOIN tokens t ON t.mint = c.mint
  WHERE c.triggered_at > now() - interval '25 minutes'
    AND (c.stars = 2 OR (c.wallet_winner_hits >= 1 AND c.wallet_winner_hits - coalesce(c.wallet_rug_hits,0) >= 1))
  ORDER BY c.triggered_at DESC LIMIT 12`;
for (const r of rows) {
  const pos = await sql`SELECT lane, size_usd::float AS s, status, realized_pnl_usd::float AS pnl FROM positions WHERE mint = ${r.mint} AND opened_at > now() - interval '25 minutes'`;
  const aud = await sql`
    SELECT action, left(coalesce(details->>'reason',''), 60) AS why FROM audit_log
    WHERE details->>'mint' = ${r.mint} AND created_at > now() - interval '25 minutes'
      AND action IN ('live_buy_skipped','live_open','live_mandate_ticket','live_moonshot_tier','entry_mandate_size','entry_sensor_tier','entry_moonshot_tier','live_requeue')
    ORDER BY created_at DESC LIMIT 3`;
  const posStr = pos.length ? pos.map((p) => `${p.lane === "live" ? "◆" : "sim"}$${p.s.toFixed(2)}${p.status === "open" ? "(open)" : `→${p.pnl?.toFixed(2)}`}`).join(" ") : "no position";
  console.log(`${(r.symbol ?? "?").padEnd(11)} ${r.signature ?? "?"} ${r.stars ?? "-"}★ crowd ${r.wh}W(${r.sh ?? "–"}s)/${r.rh}R lg ${r.lg?.toFixed(2) ?? "—"} tm ${r.tm?.toFixed(2) ?? "—"} peak ${r.peak?.toFixed(2)}× · trig ${Number(r.trig_min).toFixed(1)}m ago · armed=${r.armed} entered=${r.entered}`);
  console.log(`   ${posStr}${aud.length ? " · " + aud.map((a) => `${a.action}${a.why ? `: ${a.why}` : ""}`).join(" · ") : ""}`);
}
await sql.end();
