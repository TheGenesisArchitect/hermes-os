/**
 * ENTRY LOCK-IN REPLAY (operator-approved plan, 2026-08-02): bank a defensive
 * tranche at T+delay on every seat instead of waiting for +10% mark. Same
 * honest fill model as manager-forecast.ts (2-tick delay, depth-priced
 * slippage, dead pools pay nothing). Grid: delay {30,60}s × frac {.4,.5,.6},
 * vs ACTUAL booked. Specimens 7319/7348/7350 printed by name.
 * Run: npx tsx packages/db/replays/lockin-replay.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(env)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const DEAD = 1200, DELAY = 2, FEE = 0.0025, FIX = 0.02;
const slip = (u: number, l: number) => Math.min(u / (l / 2 + u), 0.99);
type Tick = { t: number; px: number; liq: number };

function sim(ticks: Tick[], e: number, size: number, dSec: number, frac: number): number {
  let held = 1, pnl = -size * FEE - FIX, pk = e, stall = 0, locked = false, rung = 0;
  const t0 = ticks[0]!.t;
  const rungs: [number, number][] = [[1.15, 0.4], [1.3, 0.55], [1.58, 0.7]];
  const sell = (i: number, f: number): void => {
    const j = Math.min(i + DELAY, ticks.length - 1); const { px, liq } = ticks[j]!;
    if (liq < DEAD || f <= 0) return;
    const nt = size * f * (px / e);
    pnl += nt * (1 - slip(nt, liq)) * (1 - FEE) - FIX - size * f; held -= f;
  };
  for (let i = 0; i < ticks.length && held > 1e-6; i++) {
    const { t, px, liq } = ticks[i]!; const x = px / e;
    if (px > pk) { pk = px; stall = t; }
    if (liq < DEAD) break;
    if (x <= 0.75) { sell(i, held); break; }
    if (!locked && dSec > 0 && t - t0 >= dSec * 1000 && x > 0.8) { sell(i, Math.min(held, frac)); locked = true; }
    while (rung < rungs.length && x >= rungs[rung]![0]!) { sell(i, Math.max(0, held - (1 - rungs[rung]![1]!))); rung++; }
    if (pk / e >= 1.3 && t - stall >= 180_000 && x > 1.02) { sell(i, held); break; }
  }
  if (held > 1e-6 && ticks[ticks.length - 1]!.liq >= DEAD) sell(ticks.length - 1, held);
  return pnl;
}

(async () => {
  const q = postgres(url, { idle_timeout: 5 });
  const rows = (await q`
    SELECT p.id, p.lane, p.mint, p.size_usd::float sz, p.entry_price_usd::float e,
      p.realized_pnl_usd::float pnl, p.opened_at o
    FROM positions p WHERE p.status='closed' AND p.opened_at >= now() - interval '14 days'
      AND p.entry_price_usd::float > 0 AND p.size_usd::float > 0`) as unknown as
    { id: number; lane: string; mint: string; sz: number; e: number; pnl: number; o: Date }[];
  const cells: [number, number][] = [[0, 0], [30, 0.4], [30, 0.5], [30, 0.6], [60, 0.4], [60, 0.5], [60, 0.6]];
  const agg: Record<string, { n: number; act: number; v: number[] }> = {};
  const spec: string[] = [];
  for (const p of rows) {
    const ticks = (await q`SELECT extract(epoch from snapped_at)*1000 t, price_usd::float px, liquidity_usd::float liq
      FROM candidate_ticks WHERE mint=${p.mint} AND snapped_at BETWEEN ${p.o} AND ${p.o}::timestamptz + interval '6 hours'
      ORDER BY snapped_at`) as unknown as Tick[];
    if (ticks.length < 5) continue;
    const a = (agg[p.lane] ??= { n: 0, act: 0, v: cells.map(() => 0) });
    a.n++; a.act += p.pnl;
    const sims = cells.map(([d, f]) => sim(ticks, p.e, p.sz, d, f));
    sims.forEach((s, i) => (a.v[i]! += s));
    if ([7319, 7348, 7350].includes(p.id))
      spec.push(`#${p.id} actual ${p.pnl.toFixed(2)} | no-lockin ${sims[0]!.toFixed(2)} | 30s/0.5 ${sims[2]!.toFixed(2)} | 60s/0.5 ${sims[5]!.toFixed(2)}`);
  }
  for (const [lane, a] of Object.entries(agg)) {
    console.log(`\n══ ${lane.toUpperCase()} n=${a.n} · ACTUAL $${a.act.toFixed(2)} ══`);
    cells.forEach(([d, f], i) =>
      console.log(`${d === 0 ? "ladder only (no lock-in)" : `lock-in T+${d}s × ${f}`}`.padEnd(28) + `$${a.v[i]!.toFixed(2)}`));
  }
  console.log("\n── TONIGHT'S SPECIMENS ──");
  for (const s of spec) console.log(s);
  await q.end();
})();
