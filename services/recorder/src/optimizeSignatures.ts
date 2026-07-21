/**
 * SIGNATURE OPTIMIZER — solve for X, per signature.
 *
 * Every signature in the blueprint carries a real, distinct edge. What it does
 * NOT come with is its ladder: the first pass hand-picked rungs (MOON's first
 * rung at its own p50, banking 25%) and then read the loss as a verdict on the
 * signature. That was backwards — a class with a 21% rug rate and a 4.27× p90
 * needs to bank early enough to pay for the rugs and still leave a runner for
 * the tail, and no hand-picked ladder is going to land on that by luck.
 *
 * So: route each candidate ONCE, then sweep the full exit grid inside each
 * signature independently and let the tape pick the parameters.
 *
 * Discipline retained (this is what makes a search trustworthy, not a fishing trip):
 *   · FIT/HOLDOUT — chosen on fit, PROVEN on holdout. Configs that only work on
 *     one side are rejected however good the number looks.
 *   · PLATEAU, NOT PEAK — the report prints the winner's neighbours, because a
 *     broad basin is a real optimum and a lone spike is an artifact.
 *   · PRE-DECLARED GRID — fixed below before the run.
 *
 *   pnpm --filter @hermes/recorder exec tsx src/optimizeSignatures.ts [fitEndISO]
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

// ── pre-declared exit grid ───────────────────────────────────────────────────
const R1_LEVEL = [1.15, 1.25, 1.4, 1.55];
const R1_FRAC = [0.25, 0.4, 0.55];
const R2_LEVEL = [1.9, 2.3];
const R2_FRAC = [0.2, 0.3];
const TRAIL = [0.25, 0.35, 0.45];
const FLOOR = [0.4, 0.55, 0.7];
// TIME EXIT — minutes after entry to close the remainder unconditionally.
// The first sweep was entirely price-triggered, which cannot work for a class
// that peaks 1.6min after entry: a trail only fires once the collapse is already
// underway, so the give-back is locked in before the exit can act. MOON's whole
// signature is speed, so speed has to be an exit lever. 999 = no time exit.
const HOLD_MIN = [1.5, 2.5, 4, 8, 999];

type SigName = "MOON_VIOLENT" | "MOON_FAST" | "MOON_STEADY" | "MOON_SLOW" | "CLIMBER" | "RISER" | "BASE";
const SIGS: SigName[] = ["RISER", "CLIMBER", "MOON_VIOLENT", "MOON_FAST", "MOON_STEADY", "MOON_SLOW", "BASE"];
// Entry snap per class — the pullback tell differs by signature.
const MIN_SNAP: Record<SigName, number> = {
  MOON_VIOLENT: 0.35, MOON_FAST: 0.35, MOON_STEADY: 0.35, MOON_SLOW: 0.35, CLIMBER: 0.2, RISER: 0.15, BASE: 0.2,
};

interface Step { mk: number; wm: number }
interface Cand {
  sig: SigName;
  entryMk: number;
  entryWm: number;
  fwd: Step[];
  liq: number;
  fit: boolean;
}
interface Cfg {
  r1: number; f1: number; r2: number; f2: number; trail: number; floor: number; hold: number;
}

// PRIORITY ORDER — pool growth is tested FIRST. It is the strongest single
// signal in the dataset (+50% growth → 0.8% rug vs a 20% baseline), and having
// it fourth let MOON's broad OR-condition absorb climbers before they were ever
// tested: the blueprint measured 129 such candidates and the router surfaced 33.
// The cheapest, most reliable class must not be starved by a greedy one.
// SPEED grades the moon, and it is an INVERTED U — faster is not better.
// Measured over 425 moon-routed candidates by snap rate (percent recovered off
// the trough per minute):
//   slow    <50%/min   n=94   rug 26.6%  2× 18.1%  p90 2.66×
//   steady  50-150     n=128  rug 25.8%  2× 31.3%  p90 5.89×
//   fast    150-400    n=69   rug 11.6%  2× 40.6%  p90 6.90×   ← the strong moon
//   violent 400+       n=134  rug 58.2%  2× 11.2%  median 0.78×
// Averaging these together is what made MOON look mediocre — the fast cohort rugs
// LESS than RISER while carrying a 6.90× p90.
//
// Every grade stays TRADEABLE. The violent cohort has a losing median, but median
// is the wrong test for a convex bet: 4.5% of it still reached 5× and its best was
// 33.4×. Refusing it outright would forfeit those, so instead each grade is given
// to the optimizer as its own problem and the tape decides how to trade it — the
// point is to CATCH moons when they show up, not to pre-judge which ones may run.
const VIOLENT_RATE = 4.0; // 400%/min
const FAST_RATE = 1.5; // 150%/min
const STEADY_RATE = 0.5; // 50%/min

// CLIMBER requires growth AND DEPTH. Pool growth alone cannot separate the two
// things it conflates: on a $1.7k pool a few thousand dollars of inflow is +50%
// trivially, so an unqualified growth test absorbs exactly the thin-pool fast
// igniters that are the strongest moons (MOON_FAST's median discovery liquidity
// is $1,709). Requiring depth makes CLIMBER mean *accumulation into a real book*,
// and leaves ignition-in-a-thin-pool to the moon grades where it belongs.
const CLIMBER_MIN_LIQ = 5_000;

function route(liq0: number, liqNow: number, bs: number, dip: number, snapRate: number): SigName | "RUG-RISK" {
  const g = liq0 > 0 ? liqNow / liq0 : 1;
  if (g < 1.0 || liq0 >= 30_000) return "RUG-RISK";
  if (g >= 1.5 && liq0 >= CLIMBER_MIN_LIQ) return "CLIMBER";
  if (liq0 < 5_000 || bs < 0.5 || dip >= 0.25) {
    if (snapRate >= VIOLENT_RATE) return "MOON_VIOLENT";
    if (snapRate >= FAST_RATE) return "MOON_FAST";
    if (snapRate >= STEADY_RATE) return "MOON_STEADY";
    return "MOON_SLOW";
  }
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
    if (st.wm - c.entryWm >= x.hold) { exitRel = rel; break; } // time exit
  }
  let banked = 0;
  let sold = 0;
  if (peak >= x.r1) { banked += x.f1 * x.r1; sold += x.f1; }
  if (peak >= x.r2) { banked += x.f2 * x.r2; sold += x.f2; }
  const gross = banked + Math.max(0, 1 - sold) * Math.max(exitRel, 0);
  const costs = (FEE_PCT / 100) * 2 + convexSlippagePct(cfg.PAPER_POSITION_USD, Math.max(c.liq, 1)) / 100;
  return Math.max(0, gross * (1 - costs));
}

const evOf = (cands: Cand[], x: Cfg): { ev: number; win: number; n: number } => {
  if (!cands.length) return { ev: 0, win: 0, n: 0 };
  let t = 0, w = 0;
  for (const c of cands) { const r = sim(c, x); t += r; if (r >= 1) w++; }
  return { ev: t / cands.length, win: (100 * w) / cands.length, n: cands.length };
};

async function main(): Promise<void> {
  const ticks = await db.select().from(candidateTicks).orderBy(asc(candidateTicks.snappedAt));
  const byMint = new Map<string, typeof ticks>();
  for (const t of ticks) { const a = byMint.get(t.mint) ?? []; a.push(t); byMint.set(t.mint, a); }

  // ── pass 1: route once ─────────────────────────────────────────────────────
  const pool: Cand[] = [];
  let refused = 0;
  let refusedViolent = 0;
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
      // SPEED: percent recovered off the trough per minute. The whole profile is
      // resolved inside the 3-minute window — no extra observation time needed.
      const troughWm = tIdx >= 0 ? num(rows[tIdx]!.watchMinutes) : 0;
      const snapRate = snap / Math.max(wm - troughWm, 0.05);
      const sig = route(liq0, num(rows[i]!.liquidityUsd), bs, dip, snapRate);
      if (sig === "RUG-RISK") { refused++; break; }
      if (snap < MIN_SNAP[sig]) continue;
      const fwd = rows.slice(i + 1).map((r) => ({ mk: num(r.markMultiple), wm: num(r.watchMinutes) }));
      if (fwd.length) pool.push({ sig, entryMk: m, entryWm: wm, fwd, liq: num(rows[i]!.liquidityUsd), fit: isFit });
      break;
    }
  }

  void refusedViolent;
  console.log(`\nSIGNATURE OPTIMIZER — ${byMint.size} candidates · ${pool.length} routed · ${refused} refused as RUG-RISK`);
  console.log(`every moon grade is tradeable — the optimizer solves each one separately`);
  console.log(`fit < ${FIT_END.toISOString()} ≤ holdout · grid = ${R1_LEVEL.length * R1_FRAC.length * R2_LEVEL.length * R2_FRAC.length * TRAIL.length * FLOOR.length} configs per signature\n`);

  // ── pass 2: sweep the grid inside each signature ───────────────────────────
  for (const s of SIGS) {
    const fitC = pool.filter((c) => c.sig === s && c.fit);
    const holdC = pool.filter((c) => c.sig === s && !c.fit);
    if (fitC.length < 20 || holdC.length < 20) {
      console.log(`${s}: too thin to optimise (fit ${fitC.length}, hold ${holdC.length}) — skipped\n`);
      continue;
    }
    const results: { x: Cfg; f: number; h: number; hw: number }[] = [];
    for (const r1 of R1_LEVEL) for (const f1 of R1_FRAC) for (const r2 of R2_LEVEL) for (const f2 of R2_FRAC)
      for (const trail of TRAIL) for (const floor of FLOOR) for (const hold of HOLD_MIN) {
        if (r2 <= r1 || f1 + f2 > 0.9) continue;
        const x: Cfg = { r1, f1, r2, f2, trail, floor, hold };
        const f = evOf(fitC, x), h = evOf(holdC, x);
        results.push({ x, f: f.ev, h: h.ev, hw: h.win });
      }
    // Choose on FIT only. Holdout is the exam, never the study guide.
    results.sort((a, b) => b.f - a.f);
    const best = results[0]!;
    const top = results.slice(0, 8);
    const plateau = top.filter((r) => r.h > 1).length;

    console.log(`── ${s}  (fit n=${fitC.length}, hold n=${holdC.length}) ─────────────────────────`);
    const holdTag = (h: number) => (h >= 999 ? "none" : `${h}m`);
    console.log(`   best on FIT:  TP1 ${best.x.r1.toFixed(2)}×@${(best.x.f1 * 100).toFixed(0)}%  TP2 ${best.x.r2.toFixed(2)}×@${(best.x.f2 * 100).toFixed(0)}%  trail ${(best.x.trail * 100).toFixed(0)}%  floor ${best.x.floor.toFixed(2)}×  hold ${holdTag(best.x.hold)}`);
    console.log(`   FIT EV ${best.f.toFixed(3)}   →   HOLDOUT EV ${best.h.toFixed(3)}  (win ${best.hw.toFixed(0)}%)  ${best.h > 1 ? "✅ CONFIRMED" : "❌ FAILED HOLDOUT"}`);
    console.log(`   plateau: ${plateau}/8 of the top-fit configs also profit on holdout`);
    for (const r of top.slice(1, 4))
      console.log(`     · TP1 ${r.x.r1.toFixed(2)}@${(r.x.f1 * 100).toFixed(0)} TP2 ${r.x.r2.toFixed(2)}@${(r.x.f2 * 100).toFixed(0)} trail ${(r.x.trail * 100).toFixed(0)} floor ${r.x.floor.toFixed(2)} hold ${holdTag(r.x.hold)} → fit ${r.f.toFixed(3)} hold ${r.h.toFixed(3)}`);
    console.log();
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
