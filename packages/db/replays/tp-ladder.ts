// THE TP LADDER HARNESS (operator 2026-07-31: "Why aren't we talking about the
// TP Targets? ... How we capture the Upside effectively reduces the cost of
// every Rug/Dud in the stack.")
//
// THE SUSPECT: 80% of every position is banked by 1.58x. TP2 was LOWERED from
// 1.70 to 1.58 on 2026-07-20 on the reasoning "movers peak at 1.62x on average"
// — but that average was computed from OUR OWN recorded peaks, which our own
// early exits censor. Measured against the uncensored candidate tape, the same
// flow runs 6.1x (RISER), 7.2x (BASE), 30.2x (MOON_SLOW), 37.6x (MOON_STEADY).
// The ladder may have been calibrated on a distribution we truncated ourselves.
//
// TP0 IS HELD FIXED at 1.15x/40% in every variant. It is ratified rug
// insurance and the gap anatomy just re-proved it: of 193 floor breaches, the
// 69 that had banked first lost -35% of size with 20% still finishing GREEN,
// against -71% and 0% green for the 124 that had not. TP0 is not the question.
// The question is everything ABOVE it.
//
// The runner left after the top rung is governed by the shipped rails: -45%
// floor, 1.02 profit lock once armed, and the 0.70 pool band. Same accounting
// as every other harness in this directory so the numbers compare.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))?.[1]?.trim()
  ?? "postgres://hermes:hermes@localhost:5433/hermes";
const sql = postgres(url);

const FILL = 0.95, FLOOR = 0.55, LOCK = 1.02, ARM = 1.2, BAND = 0.70, HORIZON = 120;
const TP0 = { mult: 1.15, cum: 0.40 };   // RATIFIED rug insurance — fixed in every variant
const MILESTONES = [3, 5, 8, 13, 21, 34, 55], RATCHET = 0.7;

type Row = { m: number; l: number };
interface Ladder { name: string; rungs: { mult: number; cum: number }[] }

/** Walk the tape once, banking each rung as it is crossed, then let the runner
 *  ride the shipped rails. Returns realised multiple of the ORIGINAL size. */
function walk(rows: Row[], ladder: Ladder): { mult: number; runnerMult: number; rungsHit: number } {
  let sold = 0, proceeds = 0, poolPk = 0, peak = 0, armed = false, rungsHit = 0;
  for (const r of rows) {
    peak = Math.max(peak, r.m);
    poolPk = Math.max(poolPk, r.l);
    if (r.m >= ARM) armed = true;
    // rungs first: we sell INTO strength on the way up
    for (const rung of ladder.rungs) {
      if (r.m >= rung.mult && sold < rung.cum) {
        proceeds += (rung.cum - sold) * r.m * FILL;
        sold = rung.cum;
        rungsHit++;
      }
    }
    if (sold >= 0.999) return { mult: proceeds, runnerMult: 0, rungsHit };
    // the runner's rails
    let ms = 0;
    for (const k of MILESTONES) if (peak >= k) ms = k * RATCHET;
    const hitFloor = r.m <= FLOOR;
    const hitLock = armed && r.m <= LOCK;
    const hitRatchet = ms > 0 && r.m <= ms;
    const hitPool = poolPk > 0 && r.l <= poolPk * BAND;
    if (hitFloor || hitLock || hitRatchet || hitPool) {
      proceeds += (1 - sold) * r.m * FILL;
      return { mult: proceeds, runnerMult: r.m, rungsHit };
    }
  }
  const last = rows[rows.length - 1]!;
  proceeds += (1 - sold) * last.m * FILL;
  return { mult: proceeds, runnerMult: last.m, rungsHit };
}

const LADDERS: Ladder[] = [
  { name: "A SHIPPED 1.15/1.30/1.58 -> 80% banked", rungs: [TP0, { mult: 1.30, cum: 0.50 }, { mult: 1.58, cum: 0.80 }] },
  { name: "B top rung 2.0x, still 80% banked", rungs: [TP0, { mult: 1.30, cum: 0.50 }, { mult: 2.00, cum: 0.80 }] },
  { name: "C top rung 2.5x, still 80% banked", rungs: [TP0, { mult: 1.30, cum: 0.50 }, { mult: 2.50, cum: 0.80 }] },
  { name: "D 1.58x but bank only 65%", rungs: [TP0, { mult: 1.30, cum: 0.50 }, { mult: 1.58, cum: 0.65 }] },
  { name: "E 1.58x but bank only 55%", rungs: [TP0, { mult: 1.30, cum: 0.50 }, { mult: 1.58, cum: 0.55 }] },
  { name: "F drop TP1, TP0 + 2.0x -> 70%", rungs: [TP0, { mult: 2.00, cum: 0.70 }] },
  { name: "G drop TP1, TP0 + 3.0x -> 70%", rungs: [TP0, { mult: 3.00, cum: 0.70 }] },
  { name: "H TP0 only, 60% rides uncapped", rungs: [TP0] },
  { name: "I 4 rungs 1.15/1.5/2.5/5 -> 80%", rungs: [TP0, { mult: 1.50, cum: 0.55 }, { mult: 2.50, cum: 0.70 }, { mult: 5.00, cum: 0.80 }] },
];

const cohort = await sql`
  SELECT p.id, p.mint, p.size_usd::float sz, p.realized_pnl_usd::float booked,
         p.entry_price_usd::float entry, p.opened_at, p.signature
  FROM positions p
  WHERE p.lane='paper' AND p.status='closed'
    AND p.closed_at > now() - interval '10 days'
    AND p.entry_price_usd::float > 0 AND p.signature IS NOT NULL
  ORDER BY p.closed_at DESC`;

const acc = new Map<string, { pnl: number; caps: number[]; green: number; rugPnl: number; moonPnl: number }>();
let n = 0, booked = 0, rugs = 0, moons = 0, bookedGreen = 0;

for (const p of cohort) {
  const ticks = await sql`
    SELECT price_usd::float px, liquidity_usd::float liq
    FROM candidate_ticks
    WHERE mint=${p.mint} AND snapped_at BETWEEN ${p.opened_at}::timestamptz
      AND ${p.opened_at}::timestamptz + ${`${HORIZON} minutes`}::interval
    ORDER BY snapped_at`;
  const rows: Row[] = ticks
    .map((k) => ({ m: Number(k.px) / Number(p.entry), l: Number(k.liq) }))
    .filter((k) => Number.isFinite(k.m) && k.m > 0 && Number.isFinite(k.l) && k.l > 0);
  if (rows.length < 5) continue;
  n++;
  booked += Number(p.booked);
  if (Number(p.booked) > 0) bookedGreen++;
  const availPeak = Math.max(...rows.map((r) => r.m));
  const isRug = Math.min(...rows.map((r) => r.m)) <= FLOOR;   // it went through the floor at some point
  const isMoon = availPeak >= 10;
  if (isRug) rugs++;
  if (isMoon) moons++;

  for (const L of LADDERS) {
    const r = walk(rows, L);
    const pnl = Number(p.sz) * (r.mult - 1);
    const a = acc.get(L.name) ?? { pnl: 0, caps: [], green: 0, rugPnl: 0, moonPnl: 0 };
    a.pnl += pnl;
    if (availPeak > 1) a.caps.push(Math.min(1, r.mult / availPeak));
    if (pnl > 0) a.green++;
    if (isRug) a.rugPnl += pnl;
    if (isMoon) a.moonPnl += pnl;
    acc.set(L.name, a);
  }
}

const med = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
console.log(`TP LADDER — ${n} paper positions, 10d, all genomes`);
console.log(`${rugs} went through the -45% floor at some point · ${moons} had a >=10x peak available`);
console.log(`TP0 1.15x/40% FIXED in every variant (ratified rug insurance)\n`);
console.log(`  ${"ladder".padEnd(40)} ${"win%".padStart(6)} ${"medCap".padStart(7)} ${"rugP&L".padStart(9)} ${"moonP&L".padStart(9)} ${"TOTAL".padStart(10)}`);
console.log(`  ${"booked (actual)".padEnd(40)} ${(100 * bookedGreen / n).toFixed(1).padStart(5)}% ${"—".padStart(7)} ${"—".padStart(9)} ${"—".padStart(9)} ${booked.toFixed(2).padStart(10)}`);
for (const [k, a] of [...acc.entries()].sort((x, y) => y[1].pnl - x[1].pnl)) {
  console.log(`  ${k.padEnd(40)} ${(100 * a.green / n).toFixed(1).padStart(5)}% ${(100 * med(a.caps)).toFixed(1).padStart(6)}% ${a.rugPnl.toFixed(2).padStart(9)} ${a.moonPnl.toFixed(2).padStart(9)} ${a.pnl.toFixed(2).padStart(10)}`);
}
await sql.end();
