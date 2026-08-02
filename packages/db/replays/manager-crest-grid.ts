/**
 * CREST PARAMETER GRID (operator, 2026-08-02). Grids the V1 ladder+crest
 * manager's crest thresholds over the same honest replay as
 * manager-forecast.ts, with OVERFIT GUARDS: every cell is scored on two
 * disjoint 7d windows — a cell only counts if it is green in BOTH — and the
 * grid is small (12 cells) with first-principles bounds, not a sweep.
 * Grid: liq-fade {0.80,0.85,0.90} × fall-run {2,3} × min-profit {1.02,1.05}.
 * Run: npx tsx packages/db/replays/manager-crest-grid.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(env)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const DEAD = 1200, DELAY = 2, FEE_PCT = 0.0025, FIXED_FEE = 0.02;
const slip = (usd: number, liq: number) => Math.min(usd / (liq / 2 + usd), 0.99);
type Tick = { t: number; px: number; liq: number };

function sim(ticks: Tick[], e: number, size: number, fade: number, runN: number, minX: number): number {
  let held = 1, pnl = -size * FEE_PCT - FIXED_FEE, pk = e, liqPk = 0, stall = 0, fall = 0, rung = 0;
  const rungs: [number, number][] = [[1.15, 0.4], [1.3, 0.55], [1.58, 0.7]];
  const sell = (i: number, f: number): void => {
    const j = Math.min(i + DELAY, ticks.length - 1);
    const { px, liq } = ticks[j]!;
    if (liq < DEAD || f <= 0) return;
    const nt = size * f * (px / e);
    pnl += nt * (1 - slip(nt, liq)) * (1 - FEE_PCT) - FIXED_FEE - size * f;
    held -= f;
  };
  for (let i = 0; i < ticks.length && held > 1e-6; i++) {
    const { t, px, liq } = ticks[i]!;
    const x = px / e;
    if (px > pk) { pk = px; stall = t; }
    if (liq > liqPk) liqPk = liq;
    fall = i > 0 && liq < ticks[i - 1]!.liq ? fall + 1 : 0;
    if (liq < DEAD) break;
    if (x <= 0.75) { sell(i, held); break; }
    while (rung < rungs.length && x >= rungs[rung]![0]!) { sell(i, Math.max(0, held - (1 - rungs[rung]![1]!))); rung++; }
    if ((liqPk > 0 && liq <= fade * liqPk && fall >= runN && x > minX) ||
        (pk / e >= 1.3 && t - stall >= 180_000 && x > minX)) { sell(i, held); break; }
  }
  if (held > 1e-6 && ticks[ticks.length - 1]!.liq >= DEAD) sell(ticks.length - 1, held);
  return pnl;
}

(async () => {
  const q = postgres(url, { idle_timeout: 5 });
  const rows = (await q`
    SELECT p.lane, p.mint, p.size_usd::float sz, p.entry_price_usd::float e, p.opened_at o,
      CASE WHEN p.opened_at >= now() - interval '7 days' THEN 'w2' ELSE 'w1' END win
    FROM positions p WHERE p.status='closed' AND p.opened_at >= now() - interval '14 days'
      AND p.entry_price_usd::float > 0 AND p.size_usd::float > 0`) as unknown as
    { lane: string; mint: string; sz: number; e: number; o: Date; win: string }[];
  const cells: { fade: number; runN: number; minX: number; s: Record<string, number> }[] = [];
  for (const fade of [0.8, 0.85, 0.9]) for (const runN of [2, 3]) for (const minX of [1.02, 1.05])
    cells.push({ fade, runN, minX, s: {} });
  for (const p of rows) {
    const ticks = (await q`
      SELECT extract(epoch from snapped_at)*1000 t, price_usd::float px, liquidity_usd::float liq
      FROM candidate_ticks WHERE mint=${p.mint} AND snapped_at BETWEEN ${p.o} AND ${p.o}::timestamptz + interval '6 hours'
      ORDER BY snapped_at`) as unknown as Tick[];
    if (ticks.length < 5) continue;
    for (const c of cells) {
      const k = `${p.lane}:${p.win}`;
      c.s[k] = (c.s[k] ?? 0) + sim(ticks, p.e, p.sz, c.fade, c.runN, c.minX);
    }
  }
  console.log("cell (fade/run/minX)      LIVE w1     LIVE w2     PAPER w1    PAPER w2   both-green?");
  for (const c of [...cells].sort((a, b) =>
    ((b.s["live:w1"] ?? 0) + (b.s["live:w2"] ?? 0)) - ((a.s["live:w1"] ?? 0) + (a.s["live:w2"] ?? 0)))) {
    const f = (k: string) => (c.s[k] ?? 0).toFixed(2).padStart(9);
    const both = (c.s["live:w1"] ?? 0) > 0 && (c.s["live:w2"] ?? 0) > 0;
    console.log(`${c.fade}/${c.runN}/${c.minX}`.padEnd(24) + `${f("live:w1")}  ${f("live:w2")}  ${f("paper:w1")}  ${f("paper:w2")}   ${both ? "✅" : "—"}`);
  }
  await q.end();
})();
