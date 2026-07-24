/**
 * MOON SHOT SCORECARD — every entry_moonshot_tier / live_moonshot_tier audit
 * since the tier shipped, joined to its position outcome. The counterfactual:
 * what the same trades would have booked at the old $1.50 probe.
 * Run: npx tsx packages/db/replays/moonshot-scorecard.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const envf = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(envf)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const sql = postgres(url);
const shots = await sql`
  SELECT DISTINCT ON (a.details->>'mint') a.details->>'mint' AS mint, a.action, a.created_at
  FROM audit_log a
  WHERE a.action IN ('entry_moonshot_tier', 'live_moonshot_tier')
  ORDER BY a.details->>'mint', a.created_at`;
console.log(`moon-shot audits since ship: ${shots.length} distinct mints\n`);
let closedPnl = 0, probePnl = 0, openN = 0, closedN = 0;
for (const s of shots) {
  const pos = await sql`
    SELECT p.lane, t.symbol, p.size_usd::float AS size, p.status, p.realized_pnl_usd::float AS pnl,
           CASE WHEN p.entry_price_usd::float > 0 THEN p.peak_price_usd::float / p.entry_price_usd::float END AS peakx
    FROM positions p JOIN tokens t ON t.mint = p.mint
    WHERE p.mint = ${s.mint} AND p.opened_at >= ${s.created_at} - interval '2 minutes'
    ORDER BY p.opened_at`;
  for (const p of pos) {
    if (p.status === "open") {
      openN++;
      console.log(`${p.lane === "live" ? "◆LIVE" : "  SIM"} ${(p.symbol ?? "?").padEnd(11)} $${p.size.toFixed(2).padStart(6)} — RIDING (peak so far ${p.peakx?.toFixed(2) ?? "?"}×)`);
    } else {
      closedN++;
      closedPnl += p.pnl ?? 0;
      probePnl += ((p.pnl ?? 0) / p.size) * 1.5;
      console.log(`${p.lane === "live" ? "◆LIVE" : "  SIM"} ${(p.symbol ?? "?").padEnd(11)} $${p.size.toFixed(2).padStart(6)} → $${(p.pnl ?? 0).toFixed(2).padStart(6)} (peak ${p.peakx?.toFixed(2) ?? "?"}×)`);
    }
  }
}
console.log(`\nclosed: ${closedN} → $${closedPnl.toFixed(2)} at slot size (same trades at old $1.50 probes: $${probePnl.toFixed(2)}) · ${openN} riding`);
await sql.end();
