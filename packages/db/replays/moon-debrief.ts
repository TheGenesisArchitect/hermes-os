/**
 * MOON DEBRIEF — for a set of symbols: what the move offered, what we took,
 * and the audited WHY for anything we sat out. Offer/capture at traded size.
 * Run: npx tsx packages/db/replays/moon-debrief.ts SYMBOL[,SYMBOL...] [hours=12]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const envf = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(envf)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const sql = postgres(url);
const syms = (process.argv[2] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const HOURS = Number(process.argv[3] ?? 12);

for (const symbol of syms) {
  const cands = await sql`
    SELECT c.mint, t.symbol, c.signature, c.label, c.peak_multiple::float AS peak,
           c.trigger_multiple::float AS trig, c.minutes_to_peak::float AS m2p,
           c.wallet_winner_hits AS wh, c.wallet_strict_hits AS sh, c.wallet_rug_hits AS rh,
           c.liq_growth::float AS lg, c.entered, c.triggered_at
    FROM candidate_outcomes c JOIN tokens t ON t.mint = c.mint
    WHERE t.symbol = ${symbol} AND c.first_seen_at > now() - interval '1 hour' * ${HOURS}
    ORDER BY c.peak_multiple::float DESC`;
  for (const c of cands) {
    const short = c.mint.slice(0, 4) + "…" + c.mint.slice(-4);
    console.log(`\n══ ${c.symbol} ${short} — peak ${c.peak?.toFixed(2)}× @${c.m2p?.toFixed(0) ?? "?"}m · ${c.signature ?? "unrouted"} · label ${c.label} · crowd ${c.wh ?? "?"}W(${c.sh ?? "–"}strict)/${c.rh ?? "?"}R · inflow ${c.lg?.toFixed(2) ?? "—"}× · trig ${c.trig?.toFixed(2) ?? "—"}×`);
    const pos = await sql`
      SELECT p.lane, p.size_usd::float AS size, p.realized_pnl_usd::float AS pnl, p.exit_reason,
             p.entry_price_usd::float AS e, p.peak_price_usd::float AS pk, p.status
      FROM positions p WHERE p.mint = ${c.mint} AND p.opened_at > now() - interval '1 hour' * ${HOURS}
      ORDER BY p.opened_at`;
    if (!pos.length) console.log(`   NO POSITIONS`);
    for (const p of pos)
      console.log(`   ${p.lane === "live" ? "◆LIVE" : "  SIM"} $${p.size?.toFixed(2)} → ${p.status === "open" ? "OPEN" : `$${p.pnl?.toFixed(2)} (${p.exit_reason})`} · ran ${p.e && p.pk ? (p.pk / p.e).toFixed(2) : "?"}× from entry`);
    const audits = await sql`
      SELECT action, details->>'reason' AS reason FROM audit_log
      WHERE details->>'mint' = ${c.mint} AND created_at > now() - interval '1 hour' * ${HOURS}
        AND action IN ('entry_filtered','entry_sensor_tier','entry_recovered_tier','entry_rugrisk_formula','entry_mandate_size',
                       'live_buy_skipped','live_mandate_ticket','live_rugrisk_formula','entry_crowd_unknown_refused','entry_wallet_antigate')
      ORDER BY created_at`;
    const seen = new Set<string>();
    for (const a of audits) {
      const k = `${a.action}|${a.reason}`;
      if (seen.has(k)) continue;
      seen.add(k);
      console.log(`   · ${a.action}: ${String(a.reason ?? "").slice(0, 110)}`);
    }
  }
}
await sql.end();
