// FIRST-MINUTE DRAIN GUARD SWEEP (operator thesis 2026-07-27: "no management
// to stop the big bleeds"). For every closed position (both lanes, 48h),
// simulate: "if pool liq falls >=X% below entry-level within the first W
// seconds -> fire-sale now". Score per cohort:
//   FULL-LOSS (ret <= -50%)  -> coverage: % where the guard fires, and the
//                               mark at trigger (what a fire-sale would salvage)
//   MID-LOSS  (-50% < ret<0) -> fires are mostly fine (cheap early out)
//   WINNER    (ret > 0)      -> fires are FALSE POSITIVES (cut a winner)
//   MOON      (peak >= 3x)   -> fires here are the cardinal sin (moon rail)
// Run: npx tsx packages/db/replays/first-minute-guard.ts [hours=48]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const sql = postgres(url);
const H = Number(process.argv[2] ?? 48);

const posns = await sql`
  SELECT p.id, p.mint, p.lane, p.opened_at, p.size_usd::float sz, p.realized_pnl_usd::float pnl,
    CASE WHEN p.entry_price_usd::float > 0 THEN p.peak_price_usd::float/p.entry_price_usd::float ELSE 1 END peakx
  FROM positions p
  WHERE p.status='closed' AND p.opened_at > now() - interval '1 hour' * ${H} AND p.size_usd::float > 0`;

const WINDOWS = [60, 120];
const THRESH = [0.15, 0.20, 0.25, 0.30, 0.40];
type Cell = { n: number; fires: number; markSum: number; markN: number };
const grid = new Map<string, Cell>();
const cohortOf = (p: any) =>
  p.peakx >= 3 ? "MOON(peak>=3x)" : p.pnl > 0 ? "winner" : p.pnl / p.sz <= -0.5 ? "FULL-LOSS(<=-50%)" : "mid-loss";
const key = (w: number, x: number, c: string) => `${w}|${x}|${c}`;

let usable = 0;
for (const p of posns) {
  const ticks = await sql`
    SELECT liquidity_usd::float liq, extract(epoch from (snapped_at - ${p.opened_at}::timestamptz))::float t
    FROM candidate_ticks WHERE mint = ${p.mint}
      AND snapped_at BETWEEN ${p.opened_at}::timestamptz - interval '10 seconds'
                         AND ${p.opened_at}::timestamptz + interval '130 seconds'
    ORDER BY snapped_at`;
  const entryTick = ticks.filter((k) => k.t <= 5 && k.liq > 0).pop();
  if (!entryTick || ticks.length < 3) continue;
  const marks = await sql`
    SELECT mark_multiple::float mark, extract(epoch from (snapped_at - ${p.opened_at}::timestamptz))::float t
    FROM position_ticks WHERE position_id = ${p.id} ORDER BY snapped_at`;
  usable++;
  const cohort = cohortOf(p);
  for (const w of WINDOWS) {
    for (const x of THRESH) {
      const cell = grid.get(key(w, x, cohort)) ?? { n: 0, fires: 0, markSum: 0, markN: 0 };
      cell.n++;
      const trig = ticks.find((k) => k.t > 5 && k.t <= w && k.liq > 0 && k.liq < entryTick.liq * (1 - x));
      if (trig) {
        cell.fires++;
        const m = marks.filter((mk) => mk.t <= trig.t + 6).pop();
        if (m) { cell.markSum += Number(m.mark); cell.markN++; }
      }
      grid.set(key(w, x, cohort), cell);
    }
  }
}

console.log(`positions with usable tick coverage: ${usable}/${posns.length} (${H}h, both lanes)\n`);
for (const w of WINDOWS) {
  console.log(`===== window: first ${w}s =====`);
  console.log("thresh | cohort              |    n | fires |  rate | avg mark@trigger");
  for (const x of THRESH) {
    for (const c of ["FULL-LOSS(<=-50%)", "mid-loss", "winner", "MOON(peak>=3x)"]) {
      const cell = grid.get(key(w, x, c));
      if (!cell) continue;
      const rate = cell.n ? (100 * cell.fires) / cell.n : 0;
      const avgMark = cell.markN ? (cell.markSum / cell.markN).toFixed(2) : "—";
      console.log(
        `  -${String(Math.round(x * 100)).padStart(2)}%  | ${c.padEnd(19)} | ${String(cell.n).padStart(4)} | ${String(cell.fires).padStart(5)} | ${rate.toFixed(0).padStart(4)}% | ${avgMark}`,
      );
    }
    console.log("");
  }
}
await sql.end();
