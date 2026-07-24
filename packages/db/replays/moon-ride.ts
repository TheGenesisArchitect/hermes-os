/**
 * MOON RIDE HARNESS — pricing the runner-tranche leash on the qualified book.
 *
 * Born 2026-07-24 (operator: "Run the Moon Ride harness... lets dial in the
 * formula"). The moon-math replay showed every winner in the wave exited at
 * 1.3-1.8× while the move ran 1.4-43× past the exit — the tight class trail
 * amputates the tail that the exponential math depends on.
 *
 * VARIANT PRICED (vs the actual booked genome):
 *   tranches: 20% banked at 1.22× · 25% at 2.1× · 25% at 3.0× ·
 *   30% RUNNER on a MULTIPLE-RATCHET leash — when the peak crosses a
 *   milestone m ∈ {1.5, 2, 3, 5, 8, 13, 21, 34, 55}, the floor ratchets to
 *   0.7×m; the runner sells on a floor cross (filled AT the floor,
 *   conservatively) or at the final tick. Pre-tp0 (<1.22× peak): the actual
 *   booked P&L is used unchanged — the variant only alters the ride AFTER
 *   the first rung banks, so rug defense below tp0 is identical by
 *   construction. All variant sells take a 2% haircut (fees+slip).
 *
 * Universe: closed PAPER positions since Jul 15 whose candidate passed F1
 * (wh≥1 AND wh>rh) with ≥3 post-entry ticks. Split by label cohort so the
 * rug give-back is priced on the same book as the tails.
 *
 * Run: npx tsx packages/db/replays/moon-ride.ts [sinceDate=2026-07-15]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const envf = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(envf)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const sql = postgres(url);
const SINCE = process.argv[2] ?? "2026-07-15";
const HAIRCUT = 0.98;
const MILESTONES = [1.5, 2, 3, 5, 8, 13, 21, 34, 55];
const RATCHET = 0.7;

const positions = await sql`
  SELECT p.id, p.mint, t.symbol, p.size_usd::float AS size, p.realized_pnl_usd::float AS pnl,
         p.entry_price_usd::float AS e, p.opened_at, p.closed_at, p.exit_reason,
         c.label, c.wallet_winner_hits AS wh, c.wallet_rug_hits AS rh
  FROM positions p
  JOIN candidate_outcomes c ON c.mint = p.mint
  JOIN tokens t ON t.mint = p.mint
  WHERE p.lane = 'paper' AND p.closed_at IS NOT NULL AND p.entry_price_usd IS NOT NULL
    AND p.opened_at >= ${SINCE}
    AND c.wallet_winner_hits >= 1
    AND c.wallet_winner_hits - coalesce(c.wallet_rug_hits, 0) >= 1`;

type Cohort = { n: number; base: number; variant: number; tail: { sym: string; base: number; variant: number; peak: number }[] };
const cohorts = new Map<string, Cohort>();
let skippedThin = 0;
let tickCounts: number[] = [];

for (const p of positions) {
  const ticks = await sql`
    SELECT price_usd::float AS px, liquidity_usd::float AS liq FROM candidate_ticks
    WHERE mint = ${p.mint} AND snapped_at >= ${p.opened_at}
    ORDER BY snapped_at`;
  tickCounts.push(ticks.length);
  if (ticks.length < 3) { skippedThin++; continue; }
  const path2 = ticks
    .map((t) => ({ m: t.px / p.e, liq: t.liq ?? 0 }))
    .filter((t) => Number.isFinite(t.m) && t.m > 0);
  const mults = path2.map((t) => t.m);
  const maxMult = Math.max(...mults);
  // LIQUIDITY-AWARE FILL: a simulated sell credits only what the pool at that
  // tick could pay — AMM impact ≈ trade/(0.5·liq), capped; a pool under $500
  // pays nothing (the Alux/CATALYSTS trap: 100× marks on a drained pool).
  const fill = (mult: number, fracOfLot: number, liq: number): number => {
    if (!liq || liq < 500) return 0;
    const trancheUsd = fracOfLot * p.size * mult;
    const impact = Math.min(0.5, trancheUsd / (0.5 * liq));
    return fracOfLot * mult * (1 - impact) * HAIRCUT;
  };

  let variantPnl: number;
  if (maxMult < 1.22) {
    variantPnl = p.pnl; // pre-tp0 book unchanged — rug defense identical below the first rung
  } else {
    let cash = 0;
    let held = 1.0;
    const rungs: [number, number][] = [[1.22, 0.2], [2.1, 0.25], [3.0, 0.25]];
    let ri = 0;
    let peak = 0;
    let floor = 0;
    let exited = false;
    for (const t of path2) {
      peak = Math.max(peak, t.m);
      while (ri < rungs.length && peak >= rungs[ri][0]) {
        // rung fills at the rung multiple, paid by THIS tick's pool
        cash += fill(rungs[ri][0], rungs[ri][1], t.liq);
        held -= rungs[ri][1];
        ri++;
      }
      for (const ms of MILESTONES) if (peak >= ms) floor = Math.max(floor, ms * RATCHET);
      if (floor > 0 && t.m <= floor) {
        cash += fill(floor, held, t.liq);
        held = 0;
        exited = true;
        break;
      }
    }
    if (!exited && held > 0) {
      const last = path2[path2.length - 1];
      cash += fill(last.m, held, last.liq);
    }
    variantPnl = (cash - 1) * p.size;
  }

  const key = p.label ?? "?";
  const c = cohorts.get(key) ?? { n: 0, base: 0, variant: 0, tail: [] };
  c.n++;
  c.base += p.pnl ?? 0;
  c.variant += variantPnl;
  if (maxMult >= 3) c.tail.push({ sym: p.symbol, base: p.pnl ?? 0, variant: variantPnl, peak: maxMult });
  cohorts.set(key, c);
}

const medTicks = tickCounts.sort((a, b) => a - b)[Math.floor(tickCounts.length / 2)] ?? 0;
console.log(`MOON RIDE — F1-qualified closed paper book since ${SINCE}`);
console.log(`universe ${positions.length} positions · ${skippedThin} skipped (<3 ticks) · median ${medTicks} post-entry ticks\n`);
console.log(`cohort     n     BOOKED    RATCHET-RUNNER    Δ`);
let tb = 0, tv = 0, tn = 0;
for (const [k, c] of [...cohorts.entries()].sort()) {
  tb += c.base; tv += c.variant; tn += c.n;
  console.log(`${k.padEnd(8)} ${String(c.n).padStart(3)}  $${c.base.toFixed(2).padStart(8)}  $${c.variant.toFixed(2).padStart(8)}   ${c.variant - c.base >= 0 ? "+" : ""}$${(c.variant - c.base).toFixed(2)}`);
}
console.log(`${"TOTAL".padEnd(8)} ${String(tn).padStart(3)}  $${tb.toFixed(2).padStart(8)}  $${tv.toFixed(2).padStart(8)}   ${tv - tb >= 0 ? "+" : ""}$${(tv - tb).toFixed(2)}`);
console.log(`\n≥3× TAILS (the moon cohort — where the variant earns or dies):`);
for (const [k, c] of cohorts) for (const tl of c.tail.sort((a, b) => b.peak - a.peak).slice(0, 12))
  console.log(`  ${tl.sym.padEnd(10)} peak ${tl.peak.toFixed(2)}× [${k}] booked $${tl.base.toFixed(2)} → ratchet $${tl.variant.toFixed(2)}`);
await sql.end();
