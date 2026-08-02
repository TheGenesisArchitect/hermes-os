/**
 * TRADE-MANAGER REPLAY FORECAST (operator, 2026-08-02: "build a replay harness
 * for this strategy to get a forecast of what we can expect").
 *
 * Simulates the liquidity-lifecycle manager over the REAL tick tape (price AND
 * depth) for every closed position in the window, with honest live-side fills:
 *  · signals fill 2 ticks later (~4-6s latency, the measured live lag)
 *  · fills pay convex slippage against the fill-tick's DEPTH + 0.25% + $0.02
 *  · a pool under $1,200 pays NOTHING (the dead-pool line) — no phantom exits
 * Variants:
 *  V1 LADDER+CREST  bank cum 40%@1.15× / 55%@1.30× / 70%@1.58×, then sell the
 *                   rest at the LIQUIDITY CREST (depth ≤0.85× of its running
 *                   peak, falling 2 ticks, in profit) or 180s price-stall;
 *                   floor_45 below 0.75× entry.
 *  V2 BASIS+CREST   bank 50%@1.10× (basis first), rest at crest/stall/floor.
 *  V3 TRAIL 15%     sell all at 15% fade from running price peak (proxy for a
 *                   pure price-trail manager). Same floor.
 * Baseline = the ACTUAL realized P&L booked on the same cohort.
 * Capture = realized ÷ (size × (tickPeak − 1)), qualified = tickPeak ≥ 1.3×.
 *
 * CAVEATS (stated, not hidden): tick cadence ~2-3s recorder feed; slippage is
 * the convex model, not an orderbook; peaks are feed peaks on live-depth ticks
 * (liq ≥ $1.2k). A forecast, not a promise.
 *
 * Run: npx tsx packages/db/replays/manager-forecast.ts [days=14]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(env)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const DAYS = Number(process.argv[2] ?? 14);
const DEAD = 1200, DELAY = 2, FEE_PCT = 0.0025, FIXED_FEE = 0.02;
const slip = (usd: number, liq: number) => Math.min(usd / (liq / 2 + usd), 0.99);

type Tick = { t: number; px: number; liq: number };
type Sim = { pnl: number; sold: number };

function simulate(ticks: Tick[], entryPx: number, size: number, variant: "V1" | "V2" | "V3"): Sim {
  let held = 1, pnl = -size * FEE_PCT - FIXED_FEE, pricePeak = entryPx, liqPeak = 0, stallStart = 0, fallRun = 0;
  const rungs = variant === "V1" ? [[1.15, 0.4], [1.3, 0.55], [1.58, 0.7]] : variant === "V2" ? [[1.1, 0.5]] : [];
  let rung = 0;
  const sellAt = (i: number, frac: number): void => {
    const j = Math.min(i + DELAY, ticks.length - 1);
    const { px, liq } = ticks[j]!;
    if (liq < DEAD || frac <= 0) return; // dead pool pays nothing
    const notional = size * frac * (px / entryPx);
    const proceeds = notional * (1 - slip(notional, liq)) * (1 - FEE_PCT) - FIXED_FEE;
    pnl += proceeds - size * frac;
    held -= frac;
  };
  for (let i = 0; i < ticks.length && held > 1e-6; i++) {
    const { t, px, liq } = ticks[i]!;
    const x = px / entryPx;
    if (px > pricePeak) { pricePeak = px; stallStart = t; }
    if (liq > liqPeak) liqPeak = liq;
    fallRun = i > 0 && liq < ticks[i - 1]!.liq ? fallRun + 1 : 0;
    if (liq < DEAD) break; // pool died — remainder is a write-off
    if (x <= 0.75) { sellAt(i, held); break; } // floor_45
    if (variant !== "V3") {
      while (rung < rungs.length && x >= rungs[rung]![0]!) {
        const target = 1 - rungs[rung]![1]!;
        sellAt(i, Math.max(0, held - target)); rung++;
      }
      const crest = liqPeak > 0 && liq <= 0.85 * liqPeak && fallRun >= 2 && x > 1.02;
      const stall = pricePeak / entryPx >= 1.3 && t - stallStart >= 180_000 && x > 1.02;
      if (crest || stall) { sellAt(i, held); break; }
    } else if (pricePeak > entryPx * 1.02 && px <= 0.85 * pricePeak) { sellAt(i, held); break; }
  }
  if (held > 1e-6) {
    const last = ticks[ticks.length - 1]!;
    if (last.liq >= DEAD) sellAt(ticks.length - 1, held); // window end — mark out
    else held = 0; // died holding — full loss on remainder (already unbanked)
  }
  return { pnl, sold: 1 - held };
}

(async () => {
  const q = postgres(url, { idle_timeout: 5 });
  const rows = (await q`
    SELECT p.id, p.lane, p.mint, p.size_usd::float sz, p.entry_price_usd::float e,
      p.realized_pnl_usd::float pnl, p.opened_at o
    FROM positions p WHERE p.status='closed' AND p.opened_at >= now() - make_interval(days => ${DAYS})
      AND p.entry_price_usd::float > 0 AND p.size_usd::float > 0`) as unknown as
    { id: number; lane: string; mint: string; sz: number; e: number; pnl: number; o: Date }[];
  const agg: Record<string, { n: number; actual: number; v: Record<string, number>; offer: number; qn: number;
    vq: Record<string, number>; actualQ: number; offerQ: number }> = {};
  for (const p of rows) {
    const ticks = (await q`
      SELECT extract(epoch from snapped_at)*1000 t, price_usd::float px, liquidity_usd::float liq
      FROM candidate_ticks WHERE mint=${p.mint} AND snapped_at BETWEEN ${p.o} AND ${p.o}::timestamptz + interval '6 hours'
      ORDER BY snapped_at`) as unknown as Tick[];
    if (ticks.length < 5) continue;
    const live = ticks.filter((tk) => tk.liq >= DEAD);
    const peakX = live.length ? Math.max(...live.map((tk) => tk.px)) / p.e : 1;
    const offer = p.sz * Math.max(0, peakX - 1);
    const a = (agg[p.lane] ??= { n: 0, actual: 0, v: { V1: 0, V2: 0, V3: 0 }, offer: 0, qn: 0,
      vq: { V1: 0, V2: 0, V3: 0 }, actualQ: 0, offerQ: 0 });
    a.n++; a.actual += p.pnl; a.offer += offer;
    const qualified = peakX >= 1.3;
    if (qualified) { a.qn++; a.actualQ += p.pnl; a.offerQ += offer; }
    for (const vv of ["V1", "V2", "V3"] as const) {
      const s = simulate(ticks, p.e, p.sz, vv);
      a.v[vv] = (a.v[vv] ?? 0) + s.pnl;
      if (qualified) a.vq[vv] = (a.vq[vv] ?? 0) + s.pnl;
    }
  }
  const pct = (x: number, y: number) => (y > 0 ? ((100 * x) / y).toFixed(1) + "%" : "—");
  for (const [lane, a] of Object.entries(agg)) {
    console.log(`\n══ ${lane.toUpperCase()} — n=${a.n} closed, ${a.qn} qualified (tick-peak ≥1.3×), ${DAYS}d ══`);
    console.log(`offer (all / qualified):       $${a.offer.toFixed(2)} / $${a.offerQ.toFixed(2)}`);
    console.log(`ACTUAL booked:                 $${a.actual.toFixed(2)}  capture(q): ${pct(a.actualQ, a.offerQ)}`);
    console.log(`V1 ladder+crest (sim):         $${a.v.V1!.toFixed(2)}  capture(q): ${pct(a.vq.V1!, a.offerQ)}`);
    console.log(`V2 basis+crest (sim):          $${a.v.V2!.toFixed(2)}  capture(q): ${pct(a.vq.V2!, a.offerQ)}`);
    console.log(`V3 trail-15% (sim):            $${a.v.V3!.toFixed(2)}  capture(q): ${pct(a.vq.V3!, a.offerQ)}`);
  }
  await q.end();
})();
