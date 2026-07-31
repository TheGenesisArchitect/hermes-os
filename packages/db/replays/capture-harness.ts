// THE CAPTURE HARNESS (operator 2026-07-31: "build the capture harness").
//
// WHY THIS EXISTS: the ownership harness optimised SUMMED P&L and that metric
// lied. It scored "pool rule owns everything" at $7,856 — a policy that let Coco
// print 2.35× and exit at 0.84×, BELOW ENTRY — because aggregate P&L is
// dominated by a handful of monsters whose upside swamps every round-trip in the
// body. Summed dollars cannot see a giveaway. The mission is to capture peaks,
// so the harness has to measure capture.
//
// PRIMARY METRIC: per-trade capture = realised multiple / peak multiple that was
// AVAILABLE while we held. Reported as the median (the body of the book, which
// is what a giveaway shows up in) alongside the mean and the P&L, so a policy
// cannot hide a round-trip behind one 600× outlier.
//
// GIVEAWAY is the second metric and the one that names the failure directly:
// positions that printed >= GIVEAWAY_PEAK and still exited below entry.
//
// Same cohort/accounting as moon-sweep and ownership-harness so results compare:
// 10d paper, all genomes, deaths in, 0.95 fill, −45% floor binding.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))?.[1]?.trim()
  ?? "postgres://hermes:hermes@localhost:5433/hermes";
const sql = postgres(url);

const FILL = 0.95;
const FLOOR = 0.55;          // −45% standard
const LOCK = 1.02;           // profit-lock floor, the thing that was wrongly suppressed
const ARM = 1.2;             // a position is "green" once it prints this
const HORIZON = 120;
const GIVEAWAY_PEAK = 1.5;   // printed this and still exited below entry = giveaway
const BANDS = [0.60, 0.70, 0.80];

type Row = { m: number; l: number; t: number };
type Res = { mult: number; peak: number; pnl: number };

/** Pool band only — what shipped first, and what gave Coco back. */
function poolOnly(rows: Row[], band: number): Res {
  let pk = 0, peak = 0;
  for (const r of rows) {
    peak = Math.max(peak, r.m);
    pk = Math.max(pk, r.l);
    if (r.m <= FLOOR) return { mult: r.m * FILL, peak, pnl: r.m * FILL - 1 };
    if (pk > 0 && r.l <= pk * band) return { mult: r.m * FILL, peak, pnl: r.m * FILL - 1 };
  }
  const last = rows[rows.length - 1]!;
  return { mult: last.m * FILL, peak, pnl: last.m * FILL - 1 };
}

/** Pool band + the profit-lock floor restored: once armed, never round-trip. */
function poolPlusLock(rows: Row[], band: number): Res {
  let pk = 0, peak = 0, armed = false;
  for (const r of rows) {
    peak = Math.max(peak, r.m);
    pk = Math.max(pk, r.l);
    if (r.m >= ARM) armed = true;
    if (r.m <= FLOOR) return { mult: r.m * FILL, peak, pnl: r.m * FILL - 1 };
    if (armed && r.m <= LOCK) return { mult: r.m * FILL, peak, pnl: r.m * FILL - 1 };
    if (pk > 0 && r.l <= pk * band) return { mult: r.m * FILL, peak, pnl: r.m * FILL - 1 };
  }
  const last = rows[rows.length - 1]!;
  return { mult: last.m * FILL, peak, pnl: last.m * FILL - 1 };
}

/** Pool + lock + a PEAK ratchet: give back at most (1-keep) of the proven run. */
function poolLockRatchet(rows: Row[], band: number, keep: number): Res {
  let pk = 0, peak = 0, armed = false;
  for (const r of rows) {
    peak = Math.max(peak, r.m);
    pk = Math.max(pk, r.l);
    if (r.m >= ARM) armed = true;
    if (r.m <= FLOOR) return { mult: r.m * FILL, peak, pnl: r.m * FILL - 1 };
    if (armed && r.m <= LOCK) return { mult: r.m * FILL, peak, pnl: r.m * FILL - 1 };
    // ratchet floor rides the proven peak, never moves down
    if (peak > ARM && r.m <= 1 + (peak - 1) * keep) return { mult: r.m * FILL, peak, pnl: r.m * FILL - 1 };
    if (pk > 0 && r.l <= pk * band) return { mult: r.m * FILL, peak, pnl: r.m * FILL - 1 };
  }
  const last = rows[rows.length - 1]!;
  return { mult: last.m * FILL, peak, pnl: last.m * FILL - 1 };
}

const cohort = await sql`
  SELECT p.id, p.mint, p.size_usd::float sz, p.realized_pnl_usd::float booked,
         p.entry_price_usd::float entry, p.opened_at,
         p.peak_price_usd::float bpeak, p.exit_price_usd::float bexit
  FROM positions p
  WHERE p.lane='paper' AND p.status='closed'
    AND p.closed_at > now() - interval '10 days'
    AND p.entry_price_usd::float > 0 AND p.signature IS NOT NULL
  ORDER BY p.closed_at DESC`;

const POLICIES: { name: string; fn: (r: Row[]) => Res }[] = [];
for (const b of BANDS) {
  POLICIES.push({ name: `pool ${b} only (what shipped)`, fn: (r) => poolOnly(r, b) });
  POLICIES.push({ name: `pool ${b} + profit lock`, fn: (r) => poolPlusLock(r, b) });
  for (const keep of [0.5, 0.65, 0.8]) {
    POLICIES.push({ name: `pool ${b} + lock + ratchet keep ${keep}`, fn: (r) => poolLockRatchet(r, b, keep) });
  }
}

const acc = new Map<string, { caps: number[]; pnl: number; giveaways: number; giveEligible: number }>();
const bookedCaps: number[] = [];
let bookedPnl = 0, bookedGive = 0, bookedElig = 0, n = 0;

for (const p of cohort) {
  const ticks = await sql`
    SELECT price_usd::float px, liquidity_usd::float liq,
           extract(epoch from (snapped_at - ${p.opened_at}::timestamptz))/60 AS t
    FROM candidate_ticks
    WHERE mint=${p.mint} AND snapped_at BETWEEN ${p.opened_at}::timestamptz
      AND ${p.opened_at}::timestamptz + ${`${HORIZON} minutes`}::interval
    ORDER BY snapped_at`;
  const rows: Row[] = ticks
    .map((k) => ({ m: Number(k.px) / Number(p.entry), l: Number(k.liq), t: Number(k.t) }))
    .filter((k) => Number.isFinite(k.m) && k.m > 0 && Number.isFinite(k.l) && k.l > 0 && k.t >= 0);
  if (rows.length < 5) continue;
  n++;

  // booked baseline, measured the SAME way (realised ÷ peak we actually saw)
  const bPeak = Number(p.bpeak) / Number(p.entry);
  const bExit = Number(p.bexit) > 0 ? Number(p.bexit) / Number(p.entry) : 0;
  if (bPeak > 1) bookedCaps.push(Math.min(1, bExit / bPeak));
  bookedPnl += Number(p.booked);
  if (bPeak >= GIVEAWAY_PEAK) { bookedElig++; if (bExit < 1) bookedGive++; }

  for (const pol of POLICIES) {
    const r = pol.fn(rows);
    const a = acc.get(pol.name) ?? { caps: [], pnl: 0, giveaways: 0, giveEligible: 0 };
    if (r.peak > 1) a.caps.push(Math.min(1, r.mult / r.peak));
    a.pnl += Number(p.sz) * r.pnl;
    if (r.peak >= GIVEAWAY_PEAK) { a.giveEligible++; if (r.mult < 1) a.giveaways++; }
    acc.set(pol.name, a);
  }
}

const med = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

console.log(`CAPTURE HARNESS — ${n} paper positions, 10d, all genomes`);
console.log(`PRIMARY metric = median per-trade capture (realised ÷ peak available while held)`);
console.log(`GIVEAWAY = printed >=${GIVEAWAY_PEAK}x and still exited below entry\n`);
console.log(`  ${"policy".padEnd(38)} ${"medCap".padStart(7)} ${"meanCap".padStart(8)} ${"giveaway".padStart(9)} ${"P&L".padStart(10)}`);
const line = (name: string, caps: number[], give: number, elig: number, pnl: number) =>
  console.log(`  ${name.padEnd(38)} ${(100 * med(caps)).toFixed(1).padStart(6)}% ${(100 * mean(caps)).toFixed(1).padStart(7)}% ${`${give}/${elig}`.padStart(9)} ${pnl.toFixed(2).padStart(10)}`);

line("A booked (actual stack)", bookedCaps, bookedGive, bookedElig, bookedPnl);
const ranked = [...acc.entries()].sort((a, b) => med(b[1].caps) - med(a[1].caps));
for (const [name, a] of ranked) line(name, a.caps, a.giveaways, a.giveEligible, a.pnl);

console.log(`\nNOTE: booked capture uses OUR OWN recorded peak, which is censored by our`);
console.log(`exit — it flatters the baseline. The policies are scored against the peak`);
console.log(`available across the full ${HORIZON}m window, which is the honest denominator.`);
await sql.end();
