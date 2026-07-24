import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const envf = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(envf)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const sql = postgres(url);
const [st] = await sql`SELECT value FROM config WHERE key = 'sentinel_state'`;
const seen: string[] = (st?.value as any)?.moonshotSeen ?? [];
console.log(`🌙-alerted mints in state: ${seen.length} (checking last 20)\n`);
for (const mint of seen.slice(-20)) {
  const [c] = await sql`
    SELECT t.symbol, c.signature, c.stars, c.entered, c.label, c.peak_multiple::float AS peak,
           c.wallet_winner_hits AS wh, c.wallet_rug_hits AS rh, c.liq_growth::float AS lg,
           c.trigger_multiple::float AS tm, c.snap_pct::float AS snap
    FROM candidate_outcomes c JOIN tokens t ON t.mint = c.mint WHERE c.mint = ${mint}`;
  if (!c) continue;
  const pos = await sql`SELECT lane, size_usd::float AS s, realized_pnl_usd::float AS pnl, status FROM positions WHERE mint = ${mint}`;
  const aud = await sql`
    SELECT action, details->>'reason' AS reason FROM audit_log
    WHERE details->>'mint' = ${mint}
      AND action IN ('entry_filtered','entry_sensor_tier','live_buy_skipped','entry_crowd_unknown_refused')
    ORDER BY created_at DESC LIMIT 2`;
  const posStr = pos.length ? pos.map((p) => `${p.lane}$${p.s.toFixed(2)}${p.status === "open" ? "(open)" : `→$${p.pnl?.toFixed(2)}`}`).join(" ") : "NO POSITION";
  console.log(`${(c.symbol ?? "?").padEnd(11)} ${c.signature} ${c.stars}★ peak ${c.peak?.toFixed(2)}× [${c.label}] crowd ${c.wh}W/${c.rh}R inflow ${c.lg?.toFixed(2) ?? "—"} trig ${c.tm?.toFixed(2) ?? "—"} snap ${c.snap != null ? (c.snap * 100).toFixed(0) + "%" : "—"}`);
  console.log(`    ${posStr}${aud.length ? ` · ${aud.map((a) => `${a.action}: ${String(a.reason ?? "").slice(0, 70)}`).join(" · ")}` : ""}`);
}
await sql.end();
