/**
 * RUNG-TIMING COURT (operator, 2026-08-05): capture is NEGATIVE (−6.6%) with
 * floor_45 taking 84% of losses on a tape where 25/64 positions offered ≥1.3×.
 * Hypothesis: the first rung (1.15× confirmed) is too slow for this regime —
 * price touches and reverses before anything banks. Replays the SAME cohort's
 * real tick tape under alternative first-rung policies, honest fills.
 * Bar (per doctrine, 3 prior replays said don't tune exits): a variant must
 * beat the incumbent on TOTAL P&L in BOTH halves of the window.
 * Run: npx tsx packages/db/replays/rung-timing-court.ts [hours=24]
 */
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(env)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const HOURS = Number(process.argv[2] ?? 24);
const DEAD = 1200, PHANTOM = 5000000, DELAY = 2, FEE = 0.0025, FIX = 0.02;
const slip = (u: number, l: number) => Math.min(u / (l / 2 + u), 0.99);
type Tick = { t: number; px: number; liq: number };

/** rung0: [multiple, cumulative-sell-fraction]; floorArm: stop multiple. */
function sim(ticks: Tick[], e: number, size: number, rungs: [number, number][], floorArm: number): number {
  let held = 1, pnl = -size * FEE - FIX, pk = e, stall = 0, rung = 0;
  const sell = (i: number, f: number): void => {
    const j = Math.min(i + DELAY, ticks.length - 1); const { px, liq } = ticks[j]!;
    if (liq < DEAD || liq > PHANTOM || f <= 0) return;
    const nt = size * f * (px / e);
    pnl += nt * (1 - slip(nt, liq)) * (1 - FEE) - FIX - size * f; held -= f;
  };
  for (let i = 0; i < ticks.length && held > 1e-6; i++) {
    const { t, px, liq } = ticks[i]!; const x = px / e;
    if (px > pk) { pk = px; stall = t; }
    if (liq < DEAD || liq > PHANTOM) break;
    if (x <= floorArm) { sell(i, held); break; }
    while (rung < rungs.length && x >= rungs[rung]![0]!) { sell(i, Math.max(0, held - (1 - rungs[rung]![1]!))); rung++; }
    if (pk / e >= 1.3 && t - stall >= 180_000 && x > 1.02) { sell(i, held); break; }
  }
  if (held > 1e-6 && ticks[ticks.length - 1]!.liq >= DEAD) sell(ticks.length - 1, held);
  return pnl;
}

const POLICIES: [string, [number, number][], number][] = [
  ["INCUMBENT 1.15/1.30/1.58", [[1.15, 0.4], [1.3, 0.55], [1.58, 0.7]], 0.75],
  ["FAST-8  1.08/1.20/1.45", [[1.08, 0.4], [1.2, 0.55], [1.45, 0.7]], 0.75],
  ["FAST-12 1.12/1.25/1.50", [[1.12, 0.4], [1.25, 0.55], [1.5, 0.7]], 0.75],
  ["FAST-8 HEAVY (0.6 first)", [[1.08, 0.6], [1.2, 0.7], [1.45, 0.8]], 0.75],
  ["INCUMBENT + tight floor .85", [[1.15, 0.4], [1.3, 0.55], [1.58, 0.7]], 0.85],
];

(async () => {
  const q = postgres(url, { idle_timeout: 5 });
  const rows = (await q`
    SELECT p.id, p.mint, p.size_usd::float sz, p.entry_price_usd::float e, p.opened_at o,
      p.realized_pnl_usd::float actual
    FROM positions p WHERE p.lane='paper' AND p.status='closed'
      AND p.closed_at > now() - make_interval(hours => ${HOURS})
      AND p.entry_price_usd::float > 0`) as unknown as
    { id: number; mint: string; sz: number; e: number; o: Date; actual: number }[];
  const half = Date.now() - (HOURS / 2) * 3600_000;
  const acc: Record<string, { early: number; late: number }> = {};
  let actualEarly = 0, actualLate = 0, n = 0;
  for (const p of rows) {
    const ticks = (await q`SELECT extract(epoch from snapped_at)*1000 t, price_usd::float px, liquidity_usd::float liq
      FROM candidate_ticks WHERE mint=${p.mint} AND snapped_at BETWEEN ${p.o} AND ${p.o}::timestamptz + interval '4 hours'
      ORDER BY snapped_at`) as unknown as Tick[];
    if (ticks.length < 5) continue;
    n++;
    const isLate = p.o.getTime() >= half;
    if (isLate) actualLate += p.actual; else actualEarly += p.actual;
    for (const [name, rungs, floorArm] of POLICIES) {
      const r = sim(ticks, p.e, p.sz, rungs, floorArm);
      const a = (acc[name] ??= { early: 0, late: 0 });
      if (isLate) a.late += r; else a.early += r;
    }
  }
  console.log(`RUNG-TIMING COURT — ${n} positions, last ${HOURS}h, split into two halves\n`);
  console.log(`${"policy".padEnd(30)} ${"1st half".padStart(10)} ${"2nd half".padStart(10)} ${"total".padStart(10)}  both-green?`);
  console.log(`${"ACTUAL (booked)".padEnd(30)} ${actualEarly.toFixed(2).padStart(10)} ${actualLate.toFixed(2).padStart(10)} ${(actualEarly + actualLate).toFixed(2).padStart(10)}`);
  const inc = acc["INCUMBENT 1.15/1.30/1.58"]!;
  for (const [name] of POLICIES) {
    const a = acc[name]!;
    const beatsBoth = a.early > inc.early && a.late > inc.late;
    console.log(`${name.padEnd(30)} ${a.early.toFixed(2).padStart(10)} ${a.late.toFixed(2).padStart(10)} ${(a.early + a.late).toFixed(2).padStart(10)}  ${name.startsWith("INCUMBENT 1.15") ? "(incumbent)" : beatsBoth ? "✅ BEATS BOTH" : "—"}`);
  }
  console.log("\nBar: a variant ships only if it beats the incumbent in BOTH halves (no single-window winners).");
  await q.end();
})();
