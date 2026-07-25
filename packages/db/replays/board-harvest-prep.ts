/**
 * BOARD + HARVEST PREP — (A) where triggered qualified flow fails to board,
 * named; (B) auto-harvest simulation: how often did ≥4 concurrent green
 * positions exist, and what would sweeping them have banked vs their actuals.
 * Run: npx tsx packages/db/replays/board-harvest-prep.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);

console.log("── A. TRIGGERED QUALIFIED FLOW, 6h — board or named refusal ──");
const [a] = await sql`
  SELECT count(*)::int AS trig, count(*) FILTER (WHERE entered)::int AS boarded
  FROM candidate_outcomes
  WHERE triggered_at > now() - interval '6 hours'
    AND wallet_winner_hits >= 1 AND wallet_winner_hits - coalesce(wallet_rug_hits, 0) >= 1`;
console.log(`qualified triggers ${a.trig} · boarded ${a.boarded} (${Math.round((100 * a.boarded) / Math.max(1, a.trig))}%)`);
const reasons = await sql`
  SELECT left(coalesce(al.details->>'reason', al.action), 60) AS why, count(DISTINCT al.details->>'mint')::int AS n
  FROM audit_log al
  WHERE al.created_at > now() - interval '6 hours'
    AND al.action IN ('entry_filtered')
    AND al.details->>'mint' IN (
      SELECT mint FROM candidate_outcomes
      WHERE triggered_at > now() - interval '6 hours' AND NOT entered
        AND wallet_winner_hits >= 1 AND wallet_winner_hits - coalesce(wallet_rug_hits, 0) >= 1)
  GROUP BY 1 ORDER BY n DESC LIMIT 8`;
for (const r of reasons) console.log(`  ${String(r.n).padStart(3)}× ${r.why}`);

console.log("\n── B. AUTO-HARVEST SIM, 48h (sample every 10 min) ──");
const samples = await sql`
  SELECT gs AS t FROM generate_series(now() - interval '48 hours', now(), interval '10 minutes') gs`;
let events = 0, sweptPnL = 0, actualPnL = 0, sweptN = 0;
let lastEvent = 0;
for (const smp of samples) {
  const t = new Date(smp.t).getTime();
  if (t - lastEvent < 15 * 60_000) continue; // cooldown between harvests
  const greens = await sql`
    SELECT p.id, p.size_usd::float AS s, p.realized_pnl_usd::float AS actual_pnl,
           pt.mark_multiple::float AS mm
    FROM positions p
    CROSS JOIN LATERAL (
      SELECT mark_multiple FROM position_ticks WHERE position_id = p.id AND snapped_at <= ${smp.t}
      ORDER BY snapped_at DESC LIMIT 1) pt
    WHERE p.lane = 'paper' AND p.opened_at <= ${smp.t}
      AND (p.closed_at IS NULL OR p.closed_at > ${smp.t})
      AND pt.mark_multiple::float >= 1.08`;
  if (greens.length >= 4) {
    events++;
    lastEvent = t;
    for (const g of greens) {
      sweptN++;
      // conservative sweep value: sell remaining at current mark × 0.97 (slip+fees),
      // approximating full position (partial rungs already realized are in actual too —
      // compare apples: hypothetical = (mm×0.97 −1)×size vs the position's final realized.
      sweptPnL += (Number(g.mm) * 0.97 - 1) * Number(g.s);
      actualPnL += Number(g.actual_pnl ?? 0);
    }
  }
}
console.log(`harvest events (≥4 green ≥1.08×, 15m cooldown): ${events} over 48h · positions swept ${sweptN}`);
console.log(`swept-at-mark value: $${sweptPnL.toFixed(2)} vs those positions' ACTUAL realized: $${actualPnL.toFixed(2)} → Δ ${(sweptPnL - actualPnL) >= 0 ? "+" : ""}$${(sweptPnL - actualPnL).toFixed(2)}`);
await sql.end();
