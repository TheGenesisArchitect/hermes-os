// STALL-SWEEP REPLAY (capture mechanic #3, operator 2026-07-29: "if we are
// not capturing 30-40% of each window, it's our system"). Question: does
// sweeping a RIPE green — peak ≥1.35×, peak now ≥3min old, mark faded to
// ≤0.90×peak — beat the booked trail, WITHOUT capping the moons?
// Cohort: 14d closed positions that peaked ≥1.35× (the give-back pool,
// $2,409/14d oracle prize). Price stream: candidate ticks past the real
// close, 60min horizon. Sim fills at 0.95 (healthy pools, not drains).
// Run: npx tsx packages/db/replays/stall-sweep-replay.ts [days=14]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const sql = postgres(url);
const DAYS = Number(process.argv[2] ?? 14);
const FILL = 0.95;
const STALL_SEC = 180;
const FADE = 0.9;

const cohort = await sql`
  SELECT p.id, p.mint, p.size_usd::float sz, p.realized_pnl_usd::float booked,
    p.entry_price_usd::float entry, p.opened_at,
    coalesce(co.peak_multiple,1)::float cand_peak
  FROM positions p LEFT JOIN candidate_outcomes co USING (mint)
  WHERE p.status='closed' AND p.closed_at > now() - interval '1 day' * ${DAYS}
    AND p.entry_price_usd::float > 0 AND p.lane='paper'
    AND p.peak_price_usd::float / p.entry_price_usd::float >= 1.35
  ORDER BY p.opened_at DESC LIMIT 400`;

function simulate(ticks: { m: number; t: number }[], sz: number): number {
  let peak = 1, peakAt = 0;
  for (const k of ticks) {
    if (k.m > peak) { peak = k.m; peakAt = k.t; }
    if (peak >= 1.35 && k.t - peakAt >= STALL_SEC && k.m <= peak * FADE)
      return sz * (k.m * FILL - 1); // ripe + stalled + fading → sweep
  }
  const last = ticks[ticks.length - 1]?.m ?? 1;
  return sz * (last * FILL - 1);
}

let n = 0, nMoon = 0;
const tot = { booked: 0, sweep: 0 };
const moon = { booked: 0, sweep: 0 };
for (const p of cohort) {
  const ticks = await sql`
    SELECT price_usd::float px, extract(epoch from (snapped_at - ${p.opened_at}::timestamptz))::float t
    FROM candidate_ticks WHERE mint = ${p.mint}
      AND snapped_at BETWEEN ${p.opened_at}::timestamptz AND ${p.opened_at}::timestamptz + interval '60 minutes'
    ORDER BY snapped_at`;
  const marks = ticks.map((k) => ({ m: Number(k.px) / Number(p.entry), t: Number(k.t) })).filter((k) => Number.isFinite(k.m) && k.m > 0);
  if (marks.length < 5) continue;
  n++;
  const isMoon = Number(p.cand_peak) >= 5;
  if (isMoon) nMoon++;
  const s = simulate(marks, Number(p.sz));
  tot.booked += Number(p.booked); tot.sweep += s;
  if (isMoon) { moon.booked += Number(p.booked); moon.sweep += s; }
}
console.log(`STALL-SWEEP REPLAY — ${n} ripe greens (peak ≥1.35×, ${DAYS}d), ${nMoon} moons (cand ≥5×)`);
console.log(`  booked (actual):            full $${tot.booked.toFixed(2)}  ·  moons $${moon.booked.toFixed(2)}`);
console.log(`  stall-sweep (3min/0.90):    full $${tot.sweep.toFixed(2)}  ·  moons $${moon.sweep.toFixed(2)}`);
await sql.end();
