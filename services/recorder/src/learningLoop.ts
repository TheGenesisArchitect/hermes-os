/**
 * RECURSIVE LEARNING LOOP — each signature re-optimises itself as tape accumulates.
 *
 * Every generation: re-split the data, re-sweep the exit grid inside each
 * signature, and promote a new profile ONLY if it beats the incumbent on data it
 * has never seen. Profiles are written to the `signature_profiles` config row and
 * the trader picks them up live, so the system tunes itself without a deploy.
 *
 * ── the objective, and why it is not "win rate" ──────────────────────────────
 * The goal is a ≥75% win rate, but win rate ALONE is a trap: sell 80% of every
 * position at 1.15× and you will win most trades and cap every winner. That is
 * precisely the configuration measured to be costing us (every class's median run
 * is 1.43-1.56×, so the old 1.15/1.30 ladder banked under the typical outcome).
 * A loop that maximised win% would walk straight back into it.
 *
 * So the loop maximises EV SUBJECT TO win% ≥ target — a constrained optimisation.
 * If nothing reaches the target without wrecking EV, it says so and reports the
 * frontier rather than quietly trading the edge away.
 *
 * ── the anti-overfitting rules, which are the whole point ────────────────────
 * A loop that searches until something looks good WILL find noise: with enough
 * generations, some configuration always sparkles by chance. Four rules bind it:
 *   1. ROLLING HOLDOUT   — the most recent slice is never used for selection.
 *   2. SELECT ON FIT     — the winner is chosen on fit; holdout is the exam only.
 *   3. PLATEAU REQUIRED  — a lone spike between weak neighbours is rejected.
 *   4. MIN SAMPLE        — a class below the floor is left alone, not tuned.
 * A promotion must beat the INCUMBENT on holdout too, so a generation that merely
 * finds a different-but-equal config changes nothing.
 *
 *   pnpm --filter @hermes/recorder exec tsx src/learningLoop.ts [--apply]
 * Without --apply it reports what it WOULD promote and writes nothing.
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
loadEnv({ path: resolve(import.meta.dirname, "../../../.env") });
import {
  convexSlippagePct,
  loadConfig,
  routeSignature,
  SIGNATURE_PROFILES,
  type Signature,
} from "@hermes/core";
import { auditLog, candidateTicks, config as configTable, db } from "@hermes/db";
import { asc, eq } from "drizzle-orm";

const cfg = loadConfig();
const APPLY = process.argv.includes("--apply");
const num = (v: string | null | undefined): number => (v == null ? 0 : Number(v));
const FEE_PCT = 0.25;

// ── objective ────────────────────────────────────────────────────────────────
const TARGET_WIN = Number(process.env.LEARN_TARGET_WIN ?? 75); // percent
const MIN_SAMPLE_PER_SIDE = Number(process.env.LEARN_MIN_SAMPLE ?? 60);
const MIN_PLATEAU = Number(process.env.LEARN_MIN_PLATEAU ?? 5); // of the top 8 on fit
const HOLDOUT_FRAC = 0.3; // most recent 30% is the exam

// ── pre-declared grid ────────────────────────────────────────────────────────
// Widened 2026-07-21 after generation 1 put every promotion against the wall:
// TP1 1.70, TP2 2.80 and trail 55% were all the top values in the box, meaning
// the box was clipping the optimum. The direction is consistent across classes —
// bank LATER, sell LESS, trail WIDER — so the grid is extended in that direction
// until the winners sit in the interior rather than on the edge.
const R1_LEVEL = [1.4, 1.55, 1.7, 1.9, 2.1];
const R1_FRAC = [0.1, 0.15, 0.25, 0.4];
const R2_LEVEL = [2.3, 2.8, 3.5, 4.5];
const R2_FRAC = [0.15, 0.2, 0.3];
const TRAIL = [0.35, 0.45, 0.55, 0.65, 0.75];
const FLOOR = [0.3, 0.4, 0.55, 0.7];
// No "999 = never" option any more. Generation 2 showed the optimizer exploiting
// it: the winning RISER config triggered no exit on 98% of trades and was scored
// at whatever price the recorder last saw, so "widen the trail" was really
// "avoid exiting until observation ends". A horizon is a POLICY the live system
// already applies (RUNNER_MAX_HOLD_SEC), so every config must name one, and
// MAX_HORIZON_MIN is capped at what the tape can actually resolve.
const HOLD_MIN = [2, 4, 8, 12];
const MAX_HORIZON_MIN = 12;

interface Step { mk: number; wm: number }
interface Cand { sig: Signature; entryMk: number; entryWm: number; fwd: Step[]; liq: number; at: Date }
interface Cfg { r1: number; f1: number; r2: number; f2: number; trail: number; floor: number; hold: number }
interface Scored { ev: number; win: number; n: number }

// Counts positions whose exit never triggered and were booked at the last observed
// tick. TRUNCATION IS A REAL BIAS: the recorder stops watching at ~15m, so a config
// that never exits gets credited with wherever the token happened to be when
// observation ended rather than where it actually went. That systematically
// flatters wide trails and deep floors — exactly the direction the sweep drifts.
let truncatedExits = 0;
let totalSims = 0;

function sim(c: Cand, x: Cfg): number {
  let peak = 0;
  let exitRel = c.fwd[c.fwd.length - 1]!.mk / c.entryMk;
  let triggered = false;
  totalSims++;
  for (const st of c.fwd) {
    const rel = st.mk / c.entryMk;
    peak = Math.max(peak, rel);
    if (rel <= x.floor) { exitRel = rel; triggered = true; break; }
    if (peak > 0 && rel <= peak * (1 - x.trail)) { exitRel = rel; triggered = true; break; }
    if (st.wm - c.entryWm >= x.hold) { exitRel = rel; triggered = true; break; }
  }
  if (!triggered) truncatedExits++;
  let banked = 0, sold = 0;
  if (peak >= x.r1) { banked += x.f1 * x.r1; sold += x.f1; }
  if (peak >= x.r2) { banked += x.f2 * x.r2; sold += x.f2; }
  const gross = banked + Math.max(0, 1 - sold) * Math.max(exitRel, 0);
  const costs = (FEE_PCT / 100) * 2 + convexSlippagePct(cfg.PAPER_POSITION_USD, Math.max(c.liq, 1)) / 100;
  return Math.max(0, gross * (1 - costs));
}

function scoreSet(cands: Cand[], x: Cfg): Scored {
  if (!cands.length) return { ev: 0, win: 0, n: 0 };
  let t = 0, w = 0;
  for (const c of cands) { const r = sim(c, x); t += r; if (r >= 1) w++; }
  return { ev: t / cands.length, win: (100 * w) / cands.length, n: cands.length };
}

const profileToCfg = (s: Signature): Cfg => {
  const p = SIGNATURE_PROFILES[s];
  return { r1: p.tp1[0], f1: p.tp1[1], r2: p.tp2[0], f2: p.tp2[1], trail: p.trail, floor: p.floor, hold: p.holdSec > 0 ? p.holdSec / 60 : 999 };
};

async function main(): Promise<void> {
  const ticks = await db.select().from(candidateTicks).orderBy(asc(candidateTicks.snappedAt));
  const byMint = new Map<string, typeof ticks>();
  for (const t of ticks) { const a = byMint.get(t.mint) ?? []; a.push(t); byMint.set(t.mint, a); }

  // ── route every candidate once ──
  const pool: Cand[] = [];
  for (const rows of byMint.values()) {
    if (rows.length < 4) continue;
    const liq0 = num(rows[0]!.liquidityUsd);
    if (liq0 <= 0) continue;
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
      const troughWm = tIdx >= 0 ? num(rows[tIdx]!.watchMinutes) : 0;
      const sig = routeSignature({
        liq0, liqNow: num(rows[i]!.liquidityUsd), buyShare: bs, dipDepth: dip,
        snapRate: snap / Math.max(wm - troughWm, 0.05),
      });
      if (!SIGNATURE_PROFILES[sig].trade) break;
      if (snap < SIGNATURE_PROFILES[sig].minSnap) continue;
      const fwd = rows.slice(i + 1).map((r) => ({ mk: num(r.markMultiple), wm: num(r.watchMinutes) }));
      // Only score a candidate whose tape actually reaches the horizon. Without
      // this, short-observed candidates are booked at their truncation point and
      // the sweep is rewarded for never exiting.
      const span = fwd.length ? (fwd[fwd.length - 1]!.wm - wm) : 0;
      if (span >= MAX_HORIZON_MIN) pool.push({ sig, entryMk: m, entryWm: wm, fwd, liq: num(rows[i]!.liquidityUsd), at: rows[0]!.snappedAt });
      break;
    }
  }

  // ── rolling split: the most recent HOLDOUT_FRAC is the exam, always ──
  pool.sort((a, b) => a.at.getTime() - b.at.getTime());
  const cut = pool[Math.floor(pool.length * (1 - HOLDOUT_FRAC))]?.at ?? new Date();

  console.log(`\nLEARNING LOOP — ${pool.length} routed candidates · holdout from ${cut.toISOString()}`);
  console.log(`objective: maximise EV SUBJECT TO win ≥ ${TARGET_WIN}% (win rate alone is a trap — see header)`);
  console.log(`promote only if: fit-selected, holdout EV > 1, beats incumbent on holdout, plateau ≥ ${MIN_PLATEAU}/8, n ≥ ${MIN_SAMPLE_PER_SIDE}/side\n`);

  const promotions: Record<string, Cfg> = {};
  for (const sig of Object.keys(SIGNATURE_PROFILES) as Signature[]) {
    if (!SIGNATURE_PROFILES[sig].trade) continue;
    const all = pool.filter((c) => c.sig === sig);
    const fitC = all.filter((c) => c.at < cut);
    const holdC = all.filter((c) => c.at >= cut);
    const incumbent = profileToCfg(sig);
    const incHold = scoreSet(holdC, incumbent);

    if (fitC.length < MIN_SAMPLE_PER_SIDE || holdC.length < MIN_SAMPLE_PER_SIDE) {
      console.log(`${sig.padEnd(13)} n=${fitC.length}/${holdC.length} — below the ${MIN_SAMPLE_PER_SIDE}/side floor, LEFT ALONE (tuning noise is worse than waiting)`);
      continue;
    }

    // Sweep. Selection happens on FIT only; holdout is never consulted to choose.
    const results: { x: Cfg; f: Scored; h: Scored }[] = [];
    for (const r1 of R1_LEVEL) for (const f1 of R1_FRAC) for (const r2 of R2_LEVEL) for (const f2 of R2_FRAC)
      for (const trail of TRAIL) for (const floor of FLOOR) for (const hold of HOLD_MIN) {
        if (r2 <= r1 || f1 + f2 > 0.85) continue;
        const x: Cfg = { r1, f1, r2, f2, trail, floor, hold };
        results.push({ x, f: scoreSet(fitC, x), h: scoreSet(holdC, x) });
      }

    // Constrained objective: among configs meeting the win target on FIT, take
    // the highest FIT EV. If none meet it, fall back to best FIT EV and say so.
    const meeting = results.filter((r) => r.f.win >= TARGET_WIN);
    const usedFallback = meeting.length === 0;
    const ranked = (usedFallback ? results : meeting).sort((a, b) => b.f.ev - a.f.ev);
    const best = ranked[0]!;
    const plateau = ranked.slice(0, 8).filter((r) => r.h.ev > 1).length;

    // How much of this config's holdout result is booked at the observation
    // boundary rather than at a real exit?
    truncatedExits = 0; totalSims = 0;
    scoreSet(holdC, best.x);
    const truncPct = totalSims > 0 ? (100 * truncatedExits) / totalSims : 0;
    truncatedExits = 0; totalSims = 0;
    scoreSet(holdC, incumbent);
    const incTruncPct = totalSims > 0 ? (100 * truncatedExits) / totalSims : 0;

    const beatsIncumbent = best.h.ev > incHold.ev;
    const passes = best.h.ev > 1 && beatsIncumbent && plateau >= MIN_PLATEAU;

    console.log(`${sig.padEnd(13)} n=${fitC.length}/${holdC.length}`);
    console.log(`  incumbent  → holdout EV ${incHold.ev.toFixed(3)} win ${incHold.win.toFixed(0)}%`);
    console.log(`  candidate  → TP1 ${best.x.r1.toFixed(2)}@${(best.x.f1 * 100).toFixed(0)}% TP2 ${best.x.r2.toFixed(2)}@${(best.x.f2 * 100).toFixed(0)}% trail ${(best.x.trail * 100).toFixed(0)}% floor ${best.x.floor.toFixed(2)} hold ${best.x.hold >= 999 ? "none" : `${best.x.hold}m`}`);
    console.log(`               fit EV ${best.f.ev.toFixed(3)} win ${best.f.win.toFixed(0)}%  │  holdout EV ${best.h.ev.toFixed(3)} win ${best.h.win.toFixed(0)}%  plateau ${plateau}/8`);
    console.log(`  booked at the observation boundary: candidate ${truncPct.toFixed(0)}% vs incumbent ${incTruncPct.toFixed(0)}%${truncPct > 40 ? "  ⚠ result leans on truncation, not on real exits" : ""}`);
    if (usedFallback) console.log(`  ⚠ NO config reached ${TARGET_WIN}% win on fit — best available win was ${Math.max(...results.map((r) => r.f.win)).toFixed(0)}%. Reporting the frontier rather than trading EV away to chase the target.`);
    console.log(`  → ${passes ? "PROMOTE" : "HOLD"}${passes ? "" : `  (${best.h.ev <= 1 ? "holdout not profitable" : !beatsIncumbent ? "does not beat incumbent" : `plateau ${plateau}<${MIN_PLATEAU} — a spike, not a basin`})`}\n`);

    if (passes) promotions[sig] = best.x;
  }

  if (!APPLY) {
    console.log(`DRY RUN — ${Object.keys(promotions).length} promotion(s) available. Re-run with --apply to write them.\n`);
    process.exit(0);
  }
  if (Object.keys(promotions).length === 0) {
    console.log(`nothing to promote this generation — profiles unchanged.\n`);
    process.exit(0);
  }

  // Merge over whatever is already stored, so untouched signatures persist.
  const [row] = await db.select().from(configTable).where(eq(configTable.key, "signature_profiles"));
  const stored = (row?.value as Record<string, unknown> | undefined) ?? {};
  const merged = { ...stored, ...promotions, updatedAt: new Date().toISOString() };
  await db
    .insert(configTable)
    .values({ key: "signature_profiles", value: merged })
    .onConflictDoUpdate({ target: configTable.key, set: { value: merged, updatedAt: new Date() } });
  await db.insert(auditLog).values({
    action: "learning_loop_promotion",
    actor: "learning_loop",
    details: { promoted: Object.keys(promotions), profiles: promotions, holdoutFrom: cut.toISOString(), targetWin: TARGET_WIN },
  });
  console.log(`APPLIED — promoted ${Object.keys(promotions).join(", ")}. The trader picks these up on its next config read.\n`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
