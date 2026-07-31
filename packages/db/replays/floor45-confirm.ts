// FLOOR-45 WICK-CONFIRMATION REPLAY (operator 2026-07-30). floor_45 arms at
// -25% mark with NO wick confirmation, while the hard stop it superseded
// required consecutive below-stop reads — because 63% of single-tick stop-outs
// historically recovered past TP0. Question: would requiring 2 consecutive
// below-arm reads have improved the floor's book, or just deepened the losses?
// Cohort: every floor_45 fire, 3d. Price stream: candidate_ticks past the real
// close, 30min horizon. Variants: A=booked · B=2-tick confirm · C=3-tick.
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url"; import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const sql = postgres(url);
const ARM = 0.75, FILL = 0.95;

const fires = await sql`
  SELECT p.id, p.mint, p.size_usd::float sz, p.realized_pnl_usd::float booked,
    p.entry_price_usd::float entry, p.opened_at
  FROM positions p WHERE p.exit_reason='floor_45' AND p.closed_at > now() - interval '3 days'
    AND p.entry_price_usd::float > 0 ORDER BY p.closed_at DESC LIMIT 300`;

function sim(marks: number[], confirmTicks: number, sz: number): number {
  let below = 0;
  for (const m of marks) {
    if (m <= ARM) { below++; if (below >= confirmTicks) return sz * (m * FILL - 1); }
    else below = 0;
  }
  const last = marks[marks.length - 1] ?? 1;
  return sz * (last * FILL - 1); // never confirmed → rode to horizon
}

let n = 0, booked = 0; const out: Record<string, number> = { "B: 2-tick confirm": 0, "C: 3-tick confirm": 0 };
let recovered = 0;
for (const f of fires) {
  const ticks = await sql`
    SELECT price_usd::float px FROM candidate_ticks WHERE mint=${f.mint}
      AND snapped_at BETWEEN ${f.opened_at}::timestamptz AND ${f.opened_at}::timestamptz + interval '30 minutes'
    ORDER BY snapped_at`;
  const marks = ticks.map((k) => Number(k.px) / Number(f.entry)).filter((m) => Number.isFinite(m) && m > 0);
  if (marks.length < 4) continue;
  n++; booked += Number(f.booked);
  out["B: 2-tick confirm"] += sim(marks, 2, Number(f.sz));
  out["C: 3-tick confirm"] += sim(marks, 3, Number(f.sz));
  // did it EVER recover above the arm after first breaching?
  let breached = false;
  for (const m of marks) { if (m <= ARM) breached = true; else if (breached && m >= 1.0) { recovered++; break; } }
}
console.log(`FLOOR-45 CONFIRM REPLAY — ${n} floor fires (3d), arm ${ARM}×, fill haircut ${FILL}`);
console.log(`  A: booked (actual, 1-tick)   $${booked.toFixed(2)}`);
for (const k of Object.keys(out)) console.log(`  ${k}         $${out[k]!.toFixed(2)}`);
console.log(`  positions that breached then recovered to breakeven: ${recovered}/${n} (${Math.round(100*recovered/n)}%)`);
await sql.end();
