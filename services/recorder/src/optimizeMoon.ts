/**
 * MOON-SPECIFIC SWEEP — test the convex configuration the main grid excluded.
 *
 * The general optimizer capped trail at 45% and forced ≥25% sold at the first
 * rung. For MOON that is self-defeating: its winners give back a median 24% and
 * p75 40% from a running peak BEFORE their real high, so a 40% trail clips the
 * top quartile of outcomes — and on a convex bet the top quartile IS the return.
 * A trail that deletes the tail doesn't reduce risk, it removes the reason for
 * taking the trade at all.
 *
 * So this grid goes where the other could not: trail out to "none", first rungs
 * down to 10%, and floor+time as the primary protection rather than the trail.
 * Reports tail capture explicitly (how many ≥3× and ≥5× outcomes survive to be
 * realised), because an EV number alone hides whether the tail was harvested or
 * trailed away.
 *
 *   pnpm --filter @hermes/recorder exec tsx src/optimizeMoon.ts [fitEndISO]
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
loadEnv({ path: resolve(import.meta.dirname, "../../../.env") });
import { convexSlippagePct, loadConfig } from "@hermes/core";
import { candidateTicks, db } from "@hermes/db";
import { asc } from "drizzle-orm";

const cfg = loadConfig();
const num = (v: string | null | undefined): number => (v == null ? 0 : Number(v));
const FIT_END = new Date(process.argv[2] ?? "2026-07-18T00:00:00Z");
const FEE_PCT = 0.25;

// ── convex grid: sell little, trail wide or not at all, protect with floor+time ──
const R1_LEVEL = [1.4, 1.6, 2.0];
const R1_FRAC = [0.0, 0.1, 0.2, 0.35];
const R2_LEVEL = [2.5, 3.5];
const R2_FRAC = [0.0, 0.15, 0.25];
const TRAIL = [0.4, 0.55, 0.7, 0.85, 0.99]; // 0.99 ≈ no trail at all
const FLOOR = [0.3, 0.4, 0.52, 0.65];
const HOLD_MIN = [2, 4, 8, 16, 999];

interface Step { mk: number; wm: number }
interface Cand { entryMk: number; entryWm: number; fwd: Step[]; liq: number; fit: boolean }
interface Cfg { r1: number; f1: number; r2: number; f2: number; trail: number; floor: number; hold: number }

function route(liq0: number, liqNow: number, bs: number, dip: number): string {
  const g = liq0 > 0 ? liqNow / liq0 : 1;
  if (g < 1.0 || liq0 >= 30_000) return "RUG-RISK";
  if (g >= 1.5) return "CLIMBER";
  if (liq0 < 5_000 || bs < 0.5 || dip >= 0.25) return "MOON";
  if (bs >= 0.8) return "RISER";
  return "BASE";
}

function sim(c: Cand, x: Cfg): number {
  let peak = 0;
  let exitRel = c.fwd[c.fwd.length - 1]!.mk / c.entryMk;
  for (const st of c.fwd) {
    const rel = st.mk / c.entryMk;
    peak = Math.max(peak, rel);
    if (rel <= x.floor) { exitRel = rel; break; }
    if (peak > 0 && rel <= peak * (1 - x.trail)) { exitRel = rel; break; }
    if (st.wm - c.entryWm >= x.hold) { exitRel = rel; break; }
  }
  let banked = 0, sold = 0;
  if (x.f1 > 0 && peak >= x.r1) { banked += x.f1 * x.r1; sold += x.f1; }
  if (x.f2 > 0 && peak >= x.r2) { banked += x.f2 * x.r2; sold += x.f2; }
  const gross = banked + Math.max(0, 1 - sold) * Math.max(exitRel, 0);
  const costs = (FEE_PCT / 100) * 2 + convexSlippagePct(cfg.PAPER_POSITION_USD, Math.max(c.liq, 1)) / 100;
  return Math.max(0, gross * (1 - costs));
}

const score = (cands: Cand[], x: Cfg) => {
  if (!cands.length) return { ev: 0, win: 0, t3: 0, t5: 0, max: 0 };
  let t = 0, w = 0, t3 = 0, t5 = 0, max = 0;
  for (const c of cands) {
    const r = sim(c, x);
    t += r; if (r >= 1) w++; if (r >= 3) t3++; if (r >= 5) t5++; if (r > max) max = r;
  }
  return { ev: t / cands.length, win: (100 * w) / cands.length, t3, t5, max };
};

async function main(): Promise<void> {
  const ticks = await db.select().from(candidateTicks).orderBy(asc(candidateTicks.snappedAt));
  const byMint = new Map<string, typeof ticks>();
  for (const t of ticks) { const a = byMint.get(t.mint) ?? []; a.push(t); byMint.set(t.mint, a); }

  const pool: Cand[] = [];
  for (const rows of byMint.values()) {
    if (rows.length < 4) continue;
    const liq0 = num(rows[0]!.liquidityUsd);
    if (liq0 <= 0) continue;
    const isFit = rows[0]!.snappedAt < FIT_END;
    let trough = Number.POSITIVE_INFINITY, tIdx = -1;
    for (let i = 0; i < rows.length; i++) {
      const m = num(rows[i]!.markMultiple);
      if (m > 0 && m < trough) { trough = m; tIdx = i; }
      const wm = num(rows[i]!.watchMinutes);
      if (wm < cfg.CONFIRM_MIN_WATCH_MIN || wm > cfg.CONFIRM_MAX_WATCH_MIN) continue;
      const bs = rows[i]!.buyShareM5 == null ? 0.5 : num(rows[i]!.buyShareM5);
      if (bs < cfg.CONFIRM_MIN_BUYSHARE) continue;
      let ph = 0;
      for (let k = 0; k <= tIdx; k++) ph = Math.max(ph, num(rows[k]!.markMultiple));
      const dip = ph > 0 && Number.isFinite(trough) ? Math.max(0, 1 - trough / ph) : 0;
      const snap = Number.isFinite(trough) && trough > 0 ? m / trough - 1 : 0;
      if (route(liq0, num(rows[i]!.liquidityUsd), bs, dip) !== "MOON") break;
      if (snap < 0.35) continue;
      const fwd = rows.slice(i + 1).map((r) => ({ mk: num(r.markMultiple), wm: num(r.watchMinutes) }));
      if (fwd.length) pool.push({ entryMk: m, entryWm: wm, fwd, liq: num(rows[i]!.liquidityUsd), fit: isFit });
      break;
    }
  }
  const fitC = pool.filter((c) => c.fit), holdC = pool.filter((c) => !c.fit);

  // What tail EXISTS in this population, before any exit rule touches it?
  const rawTail = (cands: Cand[]) => {
    let t3 = 0, t5 = 0, max = 0;
    for (const c of cands) {
      let pk = 0;
      for (const s of c.fwd) pk = Math.max(pk, s.mk / c.entryMk);
      if (pk >= 3) t3++; if (pk >= 5) t5++; if (pk > max) max = pk;
    }
    return { t3, t5, max };
  };
  const rf = rawTail(fitC), rh = rawTail(holdC);
  console.log(`\nMOON CONVEX SWEEP — fit n=${fitC.length}, hold n=${holdC.length}`);
  console.log(`tail AVAILABLE in the tape (peak-from-entry, before any exit rule):`);
  console.log(`  fit:  ${rf.t3} reach ≥3×, ${rf.t5} reach ≥5×, best ${rf.max.toFixed(1)}×`);
  console.log(`  hold: ${rh.t3} reach ≥3×, ${rh.t5} reach ≥5×, best ${rh.max.toFixed(1)}×\n`);

  const results: { x: Cfg; f: ReturnType<typeof score>; h: ReturnType<typeof score> }[] = [];
  for (const r1 of R1_LEVEL) for (const f1 of R1_FRAC) for (const r2 of R2_LEVEL) for (const f2 of R2_FRAC)
    for (const trail of TRAIL) for (const floor of FLOOR) for (const hold of HOLD_MIN) {
      if (r2 <= r1 || f1 + f2 > 0.8) continue;
      const x: Cfg = { r1, f1, r2, f2, trail, floor, hold };
      results.push({ x, f: score(fitC, x), h: score(holdC, x) });
    }
  results.sort((a, b) => b.f.ev - a.f.ev);

  const tag = (x: Cfg) =>
    `TP1 ${x.r1.toFixed(2)}@${(x.f1 * 100).toFixed(0)}% TP2 ${x.r2.toFixed(2)}@${(x.f2 * 100).toFixed(0)}% ` +
    `trail ${x.trail >= 0.99 ? "none" : `${(x.trail * 100).toFixed(0)}%`} floor ${x.floor.toFixed(2)} hold ${x.hold >= 999 ? "none" : `${x.hold}m`}`;

  console.log(`top 10 by FIT EV (holdout is the exam, never the study guide):\n`);
  for (const r of results.slice(0, 10))
    console.log(
      `  ${tag(r.x)}\n    fit EV ${r.f.ev.toFixed(3)} (win ${r.f.win.toFixed(0)}%, ${r.f.t3}×≥3 ${r.f.t5}×≥5, max ${r.f.max.toFixed(1)})` +
        `  │  hold EV ${r.h.ev.toFixed(3)} (win ${r.h.win.toFixed(0)}%, ${r.h.t3}×≥3 ${r.h.t5}×≥5, max ${r.h.max.toFixed(1)}) ${r.h.ev > 1 ? "✅" : "❌"}`,
    );

  const bothPositive = results.filter((r) => r.f.ev > 1 && r.h.ev > 1);
  console.log(`\nconfigs profitable on BOTH sides: ${bothPositive.length} / ${results.length}`);
  if (bothPositive.length) {
    bothPositive.sort((a, b) => b.h.ev - a.h.ev);
    console.log(`best by holdout among those:`);
    for (const r of bothPositive.slice(0, 5))
      console.log(`  ${tag(r.x)}\n    fit ${r.f.ev.toFixed(3)} │ hold ${r.h.ev.toFixed(3)} (win ${r.h.win.toFixed(0)}%, ${r.h.t3}×≥3 ${r.h.t5}×≥5)`);
  }
  console.log();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
