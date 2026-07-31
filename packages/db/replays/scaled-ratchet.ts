// THE SCALED RATCHET HARNESS (operator 2026-07-31: "Harness the scaled ratchet").
//
// A FLAT ratchet forces a false choice: keep 0.8 wins capture (82.7% median) but
// costs $6,097 of tail against pool-only, i.e. it pays for body-safety with moon
// upside — which the standing rule forbids. The hypothesis is that the choice is
// an artefact of flatness: a floor that is TIGHT through the 1.5–3× body (where
// the giveaways live) and LOOSE above 3× (where the monsters breathe) should get
// both.
//
// This is deliberately scoped so it does NOT blind-reverse the 2026-07-28
// late-arm ratification. That study set the FIRST MILESTONE at 3x because floors
// at 1.5x/2x ejected positions on the pre-leg breath (FRANK: out +$2.49 at
// minute 1 of a 68x). So:
//   · above 3x  — the ratified milestone ladder is untouched in every variant
//   · below 3x  — the swept region, currently NO floor at all for banked runners
//   · "none"    — the control IS current ratified behaviour, so if the
//                 ratification still holds the control should win the tail.
//
// THE DECIDING METRIC IS NOT ONE NUMBER. Reported together:
//   medCap      median per-trade capture (the body — where giveaways show)
//   monsterPnL  P&L from positions whose AVAILABLE peak was >=10x (the tail —
//               where a too-tight floor does its damage). This is the column
//               the late-arm ratification was protecting.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))?.[1]?.trim()
  ?? "postgres://hermes:hermes@localhost:5433/hermes";
const sql = postgres(url);

const FILL = 0.95, FLOOR = 0.55, LOCK = 1.02, ARM = 1.2, BAND = 0.70, HORIZON = 120;
const MILESTONES = [3, 5, 8, 13, 21, 34, 55];   // RATIFIED — never swept
const RATCHET = 0.7;                            // RATIFIED leash above the first milestone
const KEEP_LOW = [null, 0.5, 0.6, 0.7, 0.8, 0.9]; // null = control (no floor below 3x)
const MONSTER = 10;

type Row = { m: number; l: number; t: number };

function run(rows: Row[], keepLow: number | null) {
  let poolPk = 0, peak = 0, armed = false;
  for (const r of rows) {
    peak = Math.max(peak, r.m);
    poolPk = Math.max(poolPk, r.l);
    if (r.m >= ARM) armed = true;
    if (r.m <= FLOOR) return { mult: r.m * FILL, peak };
    if (armed && r.m <= LOCK) return { mult: r.m * FILL, peak };
    // RATIFIED ladder above 3x — identical in every variant
    let ms = 0;
    for (const k of MILESTONES) if (peak >= k) ms = k * RATCHET;
    if (ms > 0 && r.m <= ms) return { mult: r.m * FILL, peak };
    // the SWEPT region: only below the first milestone
    if (keepLow != null && ms === 0 && peak > ARM && r.m <= 1 + (peak - 1) * keepLow) {
      return { mult: r.m * FILL, peak };
    }
    if (poolPk > 0 && r.l <= poolPk * BAND) return { mult: r.m * FILL, peak };
  }
  const last = rows[rows.length - 1]!;
  return { mult: last.m * FILL, peak };
}

const cohort = await sql`
  SELECT p.id, p.mint, p.size_usd::float sz, p.entry_price_usd::float entry, p.opened_at, p.signature
  FROM positions p
  WHERE p.lane='paper' AND p.status='closed'
    AND p.closed_at > now() - interval '10 days'
    AND p.entry_price_usd::float > 0 AND p.signature IS NOT NULL
  ORDER BY p.closed_at DESC`;

const acc = new Map<string, { caps: number[]; pnl: number; monster: number; give: number; elig: number; kept: number }>();
let n = 0, monsters = 0;

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
  const availPeak = Math.max(...rows.map((r) => r.m));   // the honest denominator
  if (availPeak >= MONSTER) monsters++;

  for (const keepLow of KEEP_LOW) {
    const key = keepLow == null ? "control: no floor below 3x (RATIFIED)" : `keep ${keepLow.toFixed(1)} below 3x`;
    const r = run(rows, keepLow);
    const a = acc.get(key) ?? { caps: [], pnl: 0, monster: 0, give: 0, elig: 0, kept: 0 };
    if (availPeak > 1) a.caps.push(Math.min(1, r.mult / availPeak));
    const pnl = Number(p.sz) * (r.mult - 1);
    a.pnl += pnl;
    if (availPeak >= MONSTER) { a.monster += pnl; if (r.mult >= 3) a.kept++; }
    if (availPeak >= 1.5) { a.elig++; if (r.mult < 1) a.give++; }
    acc.set(key, a);
  }
}

const med = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
console.log(`SCALED RATCHET — ${n} paper positions, 10d, all genomes (${monsters} had a >=${MONSTER}x peak available)`);
console.log(`ladder above 3x is the RATIFIED one and identical in every row; only the sub-3x floor is swept\n`);
console.log(`  ${"variant".padEnd(36)} ${"medCap".padStart(7)} ${"giveaway".padStart(9)} ${"monsterPnL".padStart(11)} ${"kept>=3x".padStart(9)} ${"totalPnL".padStart(10)}`);
for (const [k, a] of [...acc.entries()].sort((x, y) => y[1].pnl - x[1].pnl)) {
  console.log(`  ${k.padEnd(36)} ${(100 * med(a.caps)).toFixed(1).padStart(6)}% ${`${a.give}/${a.elig}`.padStart(9)} ${a.monster.toFixed(2).padStart(11)} ${`${a.kept}/${monsters}`.padStart(9)} ${a.pnl.toFixed(2).padStart(10)}`);
}
await sql.end();
