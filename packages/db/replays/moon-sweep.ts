// THE MOON SWEEP (operator 2026-07-31: "Admit the genomes and run the full
// sweep"). The liquid-window replay stopped its grid at a 70% pool turn and
// was STILL improving there ($510 @85% → $3,004 @80% → $4,710 @70%) — I shipped
// the middle and called it conservative. This sweep goes past the edge and
// tests the two other ceilings the capture table exposed:
//
//   MOON_STEADY: held 1.8 min, exited 1.40×, the token ran 37.6× — 16% capture.
//
// Three ceilings, swept together:
//   1. BAND    — the pool retracement that releases (0.85 … 0.30)
//   2. GRAD    — a proof multiple above which the position graduates to a WIDER
//                band. Room widens as it proves itself, never tightens; a fixed
//                band is proportionally brutal on the biggest winners.
//   3. HORIZON — RUNNER_MAX_HOLD_SEC is 1000s (16.7min), sitting right on the
//                median winner's time-to-peak. Swept to 120 min.
//
// Honest accounting: 0.95 fill haircut, the −45% floor binds first, deaths stay
// in the cohort so holding costs are paid, and ALL genomes are included.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))?.[1]?.trim()
  ?? "postgres://hermes:hermes@localhost:5433/hermes";
const sql = postgres(url);

const FILL = 0.95;
const FLOOR = 0.55;                                    // the −45% standard still binds
const BANDS = [0.85, 0.80, 0.70, 0.60, 0.50, 0.40, 0.30];
const GRADS = [null, 1.5, 2.0, 3.0] as (number | null)[]; // null = flat band, no graduation
const WIDE = [0.50, 0.40, 0.30];                       // post-graduation band
const HORIZONS = [30, 60, 120];                        // minutes
const MAX_HORIZON = Math.max(...HORIZONS);

const cohort = await sql`
  SELECT p.id, p.mint, p.signature, p.size_usd::float sz, p.realized_pnl_usd::float booked,
         p.entry_price_usd::float entry, p.opened_at, p.exit_reason
  FROM positions p
  WHERE p.lane='paper' AND p.status='closed'
    AND p.closed_at > now() - interval '10 days'
    AND p.entry_price_usd::float > 0 AND p.signature IS NOT NULL
  ORDER BY p.closed_at DESC`;

console.log(`MOON SWEEP — ${cohort.length} paper positions, 10d, all genomes`);
console.log(`bands ${BANDS.length} × grads ${GRADS.length} × wide ${WIDE.length} × horizons ${HORIZONS.length}\n`);

/** Walk one position's ticks under a policy; returns realized P&L. */
function run(
  rows: { m: number; l: number; t: number }[],
  sz: number,
  band: number,
  grad: number | null,
  wide: number,
  horizonMin: number,
): number {
  let poolPeak = 0;
  let graduated = false;
  for (const r of rows) {
    if (r.t > horizonMin) break;
    poolPeak = Math.max(poolPeak, r.l);
    if (r.m <= FLOOR) return sz * (r.m * FILL - 1);          // −45% floor binds first, always
    if (grad != null && r.m >= grad) graduated = true;        // proved itself — widen the room
    const active = graduated ? wide : band;
    if (poolPeak > 0 && r.l <= poolPeak * active) return sz * (r.m * FILL - 1);
  }
  const inHorizon = rows.filter((r) => r.t <= horizonMin);
  const last = inHorizon[inHorizon.length - 1];
  return last ? sz * (last.m * FILL - 1) : 0;                 // still open at the horizon
}

const totals = new Map<string, number>();
const capture = new Map<string, { got: number; avail: number }>();
let booked = 0, n = 0, deaths = 0;
const byGenome = new Map<string, { booked: number; best: number; bestKey: string }>();

for (const p of cohort) {
  const ticks = await sql`
    SELECT price_usd::float px, liquidity_usd::float liq,
           extract(epoch from (snapped_at - ${p.opened_at}::timestamptz))/60 AS t
    FROM candidate_ticks
    WHERE mint=${p.mint} AND snapped_at BETWEEN ${p.opened_at}::timestamptz
      AND ${p.opened_at}::timestamptz + ${`${MAX_HORIZON} minutes`}::interval
    ORDER BY snapped_at`;
  const rows = ticks
    .map((k) => ({ m: Number(k.px) / Number(p.entry), l: Number(k.liq), t: Number(k.t) }))
    .filter((k) => Number.isFinite(k.m) && k.m > 0 && Number.isFinite(k.l) && k.l > 0 && k.t >= 0);
  if (rows.length < 5) continue;
  n++;
  booked += Number(p.booked);
  if (p.exit_reason === "dust_rug") deaths++;
  const peakAvail = Math.max(...rows.map((r) => r.m));
  const g = byGenome.get(p.signature) ?? { booked: 0, best: -Infinity, bestKey: "" };
  g.booked += Number(p.booked);
  byGenome.set(p.signature, g);

  for (const horizon of HORIZONS) {
    for (const band of BANDS) {
      for (const grad of GRADS) {
        for (const w of WIDE) {
          if (grad == null && w !== WIDE[0]) continue;       // flat band: WIDE is irrelevant
          const key = grad == null
            ? `flat band ${band.toFixed(2)}                 @${horizon}m`
            : `band ${band.toFixed(2)} → ${w.toFixed(2)} above ${grad.toFixed(1)}x @${horizon}m`;
          const pnl = run(rows, Number(p.sz), band, grad, w, horizon);
          totals.set(key, (totals.get(key) ?? 0) + pnl);
          const c = capture.get(key) ?? { got: 0, avail: 0 };
          c.got += pnl / Number(p.sz) + 1;                    // realized multiple
          c.avail += peakAvail;
          capture.set(key, c);
        }
      }
    }
  }
}

const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
console.log(`${n} positions with usable tick coverage (${deaths} dust deaths included)`);
console.log(`A: booked (actual, price trail)                              $${booked.toFixed(2)}\n`);
console.log(`TOP 15 POLICIES`);
for (const [k, v] of ranked.slice(0, 15)) {
  const c = capture.get(k)!;
  console.log(`  ${k.padEnd(48)} $${v.toFixed(2).padStart(10)}   capture ${(100 * c.got / c.avail).toFixed(1)}%`);
}
console.log(`\nWORST 3 (sanity — the grid should have a losing end)`);
for (const [k, v] of ranked.slice(-3)) console.log(`  ${k.padEnd(48)} $${v.toFixed(2).padStart(10)}`);

// Does the band monotonically improve, or does it turn? The whole point.
console.log(`\nFLAT-BAND CURVE @120m (is there a turn?)`);
for (const band of BANDS) {
  const k = `flat band ${band.toFixed(2)}                 @120m`;
  console.log(`  pool <= ${(band * 100).toFixed(0)}% of peak        $${(totals.get(k) ?? 0).toFixed(2).padStart(10)}`);
}
console.log(`\nHORIZON CURVE (best flat band per horizon)`);
for (const horizon of HORIZONS) {
  let best = -Infinity, bk = "";
  for (const band of BANDS) {
    const k = `flat band ${band.toFixed(2)}                 @${horizon}m`;
    const v = totals.get(k) ?? -Infinity;
    if (v > best) { best = v; bk = `${(band * 100).toFixed(0)}%`; }
  }
  console.log(`  ${String(horizon).padStart(3)} min   best band ${bk.padStart(4)}   $${best.toFixed(2).padStart(10)}`);
}
await sql.end();
