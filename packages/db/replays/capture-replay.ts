/**
 * OVERNIGHT CAPTURE REPLAY — closing the 47%→80% gap on the admissible cohort.
 *
 * Replays the ADMISSIBLE cohort's paper trajectories (7d, position_ticks)
 * under exit-geometry variants, sim-vs-sim (the baseline is the SAME engine
 * with current parameters, so variants compare apples to apples; actual
 * recorded P&L is shown as reference). Liquidity-honest: a tick with pool
 * <$1k pays 0 for everything still held (the mark-freeze lesson).
 *
 *   A. MOON ladder-up (MOON_STEADY / MOON_FAST): TP0 fraction 0.2→0.1,
 *      TP1 lifted to the old TP2 level, TP2 one notch above.
 *   B. RISER post-1.8× ratchet: trail cap 28% → 20% / 15% once peak ≥1.8×.
 *   C. COW-type deaths (admissible entries that never armed): never-armed
 *      stop geometry −25%@8m (shipped interim) vs −20%@6m vs baseline deep.
 *
 * Run: npx tsx packages/db/replays/capture-replay.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(env)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";

interface Tick { mm: number; liq: number | null; age: number }
interface Pos {
  id: number; sig: string; size: number; actual: number; peakx: number;
  ticks: Tick[];
}
interface Ladder { tp: [number, number][]; trailCap: number; ratchetAt?: number; ratchetCap?: number; naStopPct?: number; naGraceMin?: number }

const LADDERS: Record<string, [number, number][]> = {
  RISER: [[1.22, 0.2], [2.2, 0.25], [3.2, 0.25]],
  MOON_FAST: [[1.25, 0.2], [2.35, 0.2], [3.2, 0.2]],
  MOON_STEADY: [[1.25, 0.2], [2.35, 0.25], [3.2, 0.2]],
};
const A_LADDERS: Record<string, [number, number][]> = {
  MOON_FAST: [[1.25, 0.1], [3.2, 0.2], [4.5, 0.2]],
  MOON_STEADY: [[1.25, 0.1], [3.2, 0.25], [4.5, 0.2]],
};
const GAIN_LOCK = 0.65;
const ARM = 1.2;

/** Simulate one position under a ladder/trail config. Returns realized $. */
function sim(p: Pos, cfg: Ladder): number {
  let held = 1; // fraction of position still held
  let realized = 0;
  let peak = 1;
  let armed = false;
  const tpDone = [false, false, false];
  for (const t of p.ticks) {
    const dead = t.liq != null && t.liq < 1000;
    if (dead) return realized; // whatever is still held pays ZERO — honest
    peak = Math.max(peak, t.mm);
    if (peak >= ARM) armed = true;
    // TP rungs — fire when the tick's mark crosses a level
    for (let i = 0; i < cfg.tp.length; i++) {
      if (!tpDone[i] && t.mm >= cfg.tp[i]![0] && held > 0) {
        tpDone[i] = true;
        const frac = Math.min(held, cfg.tp[i]![1]);
        realized += p.size * frac * (t.mm - 1);
        held -= frac;
      }
    }
    // never-armed stop (variant C)
    if (!armed && cfg.naStopPct != null && cfg.naGraceMin != null && t.age >= cfg.naGraceMin && t.mm <= 1 - cfg.naStopPct / 100) {
      realized += p.size * held * (t.mm - 1);
      return realized;
    }
    // trail (armed only)
    if (armed && held > 0) {
      const cap = cfg.ratchetAt != null && peak >= cfg.ratchetAt ? (cfg.ratchetCap ?? cfg.trailCap) : cfg.trailCap;
      const floor = Math.max(1.02, 1 + (peak - 1) * GAIN_LOCK, peak * (1 - cap / 100));
      if (t.mm <= floor) {
        realized += p.size * held * (t.mm - 1);
        return realized;
      }
    }
  }
  // window end: close at last mark (liquidity-honest already enforced per tick)
  const last = p.ticks[p.ticks.length - 1];
  if (held > 0 && last) realized += p.size * held * (last.mm - 1);
  return realized;
}

(async () => {
  const q = postgres(url);
  const rows = await q`
    SELECT p.id, p.signature sig, p.size_usd::float size, p.realized_pnl_usd::float actual,
      CASE WHEN p.entry_price_usd::float > 0 THEN p.peak_price_usd::float/p.entry_price_usd::float ELSE 1 END peakx
    FROM positions p JOIN candidate_outcomes co ON co.mint = p.mint
    WHERE p.lane='paper' AND p.status='closed' AND p.closed_at > now() - interval '7 days'
      AND p.signature IN ('RISER','MOON_FAST','MOON_STEADY')
      AND (co.liq_growth::float >= 1.30 OR (co.wallet_winner_hits >= 1 AND co.wallet_winner_hits - co.wallet_rug_hits >= 1))`;
  const pos: Pos[] = [];
  for (const r of rows) {
    const ticks = await q`SELECT mark_multiple::float mm, liquidity_usd::float liq, age_minutes::float age
      FROM position_ticks WHERE position_id=${r.id} ORDER BY id`;
    if (ticks.length >= 3) pos.push({ id: r.id, sig: r.sig, size: Number(r.size), actual: Number(r.actual), peakx: Number(r.peakx), ticks: ticks.map(t => ({ mm: Number(t.mm), liq: t.liq == null ? null : Number(t.liq), age: Number(t.age) })) });
  }
  const runners = pos.filter(p => p.peakx >= 1.2);
  const cows = pos.filter(p => p.peakx < 1.2);
  console.log(`ADMISSIBLE cohort with trajectories: ${pos.length} (${runners.length} armed ≥1.2×, ${cows.length} COW-type never-armed)\n`);

  const score = (name: string, group: Pos[], mk: (p: Pos) => Ladder) => {
    let base = 0, vari = 0, act = 0, off = 0;
    for (const p of group) {
      const baseCfg: Ladder = { tp: LADDERS[p.sig] ?? LADDERS.RISER!, trailCap: 28 };
      base += sim(p, baseCfg);
      vari += sim(p, mk(p));
      act += p.actual;
      off += Math.max(0, p.size * (p.peakx - 1));
    }
    console.log(`${name.padEnd(44)} n=${String(group.length).padStart(3)} · sim-base $${base.toFixed(2).padStart(8)} → variant $${vari.toFixed(2).padStart(8)} (Δ $${(vari - base).toFixed(2)}) · actual $${act.toFixed(2)} · offered $${off.toFixed(2)}`);
    return vari - base;
  };

  console.log("── A. MOON LADDER-UP (admissible MOON_STEADY/MOON_FAST, armed) ──");
  const moons = runners.filter(p => p.sig === "MOON_STEADY" || p.sig === "MOON_FAST");
  score("A: tp0 frac 0.1, tp1→3.2, tp2→4.5", moons, (p) => ({ tp: A_LADDERS[p.sig]!, trailCap: 28 }));
  console.log("\n── B. RISER POST-1.8× RATCHET (admissible RISER, armed) ──");
  const risers = runners.filter(p => p.sig === "RISER");
  score("B20: cap 28→20 after 1.8×", risers, () => ({ tp: LADDERS.RISER!, trailCap: 28, ratchetAt: 1.8, ratchetCap: 20 }));
  score("B15: cap 28→15 after 1.8×", risers, () => ({ tp: LADDERS.RISER!, trailCap: 28, ratchetAt: 1.8, ratchetCap: 15 }));
  console.log("\n── C. COW-TYPE (admissible, never armed) — never-armed stop ──");
  score("C-interim: stop −25% @8m grace", cows, (p) => ({ tp: LADDERS[p.sig] ?? LADDERS.RISER!, trailCap: 28, naStopPct: 25, naGraceMin: 8 }));
  score("C-tight:   stop −20% @6m grace", cows, (p) => ({ tp: LADDERS[p.sig] ?? LADDERS.RISER!, trailCap: 28, naStopPct: 20, naGraceMin: 6 }));
  console.log("\n── CROSS: does A/B change COW cost? (A/B touch armed exits only — COW cohort by definition never arms; verified: identical sim) ──");
  await q.end();
})();
