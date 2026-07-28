// MOON LEASH REPLAY (operator 2026-07-28: "run the capture replay now").
// Question: do early milestone floors eject eventual monsters during their
// first-minutes breath (FRANK: ratcheted out +$2.49 at minute 1 of a 68×)?
// Cohort: last 7d closed positions that CROSSED the first milestone (pos peak
// ≥1.5×) — winners AND the rugs the tight leash saved, so give-back is priced
// honestly. Price stream: candidate_ticks (continues past the real close),
// marked to each position's entry price, 60min horizon.
// Variants: A=booked (actual) · B=current ratchet (0.7×milestone) resim ·
// C=wide leash (0.5×milestone) · D=late-arm (first milestone 3×, 0.7).
// Fire-sale realism: simulated exits fill at 0.9× the trigger mark.
// Run: npx tsx packages/db/replays/moon-leash-replay.ts [days=7]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const sql = postgres(url);
const DAYS = Number(process.argv[2] ?? 7);
const FILL = 0.9; // fire-sale haircut on simulated exits

const cohort = await sql`
  SELECT p.id, p.mint, p.size_usd::float sz, p.realized_pnl_usd::float booked,
    p.entry_price_usd::float entry, p.opened_at,
    coalesce(co.peak_multiple, 1)::float cand_peak, coalesce(co.label,'?') label
  FROM positions p LEFT JOIN candidate_outcomes co USING (mint)
  WHERE p.status='closed' AND p.closed_at > now() - interval '1 day' * ${DAYS}
    AND p.entry_price_usd::float > 0
    AND p.peak_price_usd::float / p.entry_price_usd::float >= 1.5
  ORDER BY p.opened_at DESC LIMIT 450`;

interface Variant { name: string; milestones: number[]; leash: number }
const VARIANTS: Variant[] = [
  { name: "B: current (ms from 1.5, leash 0.7)", milestones: [1.5, 2, 3, 5, 8, 13, 21, 34, 55], leash: 0.7 },
  { name: "C: wide     (ms from 1.5, leash 0.5)", milestones: [1.5, 2, 3, 5, 8, 13, 21, 34, 55], leash: 0.5 },
  { name: "D: late-arm (ms from 3.0, leash 0.7)", milestones: [3, 5, 8, 13, 21, 34, 55], leash: 0.7 },
];

function simulate(marks: number[], v: Variant, sz: number): number {
  let floor = 0;
  for (const m of marks) {
    if (floor > 0 && m <= floor) return sz * (m * FILL - 1); // leash fired, fire-sale fill
    let ms = 0;
    for (const s of v.milestones) if (m >= s) ms = s;
    floor = Math.max(floor, ms * v.leash);
  }
  const last = marks[marks.length - 1] ?? 1;
  return sz * (last * FILL - 1); // horizon end — mark to last read
}

const totals: Record<string, number> = { "A: booked (actual)": 0 };
for (const v of VARIANTS) totals[v.name] = 0;
const monsters: Record<string, number> = { "A: booked (actual)": 0 };
for (const v of VARIANTS) monsters[v.name] = 0;
let n = 0, nMonster = 0;

for (const p of cohort) {
  const ticks = await sql`
    SELECT price_usd::float px FROM candidate_ticks
    WHERE mint = ${p.mint} AND snapped_at BETWEEN ${p.opened_at}::timestamptz
      AND ${p.opened_at}::timestamptz + interval '60 minutes'
    ORDER BY snapped_at`;
  const marks = ticks.map((t) => Number(t.px) / Number(p.entry)).filter((m) => Number.isFinite(m) && m > 0);
  if (marks.length < 5) continue;
  n++;
  const isMonster = Number(p.cand_peak) >= 20;
  if (isMonster) nMonster++;
  totals["A: booked (actual)"] += Number(p.booked);
  if (isMonster) monsters["A: booked (actual)"] += Number(p.booked);
  for (const v of VARIANTS) {
    const pnl = simulate(marks, v, Number(p.sz));
    totals[v.name] += pnl;
    if (isMonster) monsters[v.name] += pnl;
  }
}

console.log(`MOON LEASH REPLAY — ${n} positions (pos-peak ≥1.5×, ${DAYS}d), of which ${nMonster} monsters (cand-peak ≥20×)\n`);
console.log("variant                                  |  FULL cohort  | MONSTERS only");
for (const k of Object.keys(totals))
  console.log(`${k.padEnd(40)} | $${totals[k]!.toFixed(2).padStart(11)} | $${monsters[k]!.toFixed(2).padStart(11)}`);
await sql.end();
