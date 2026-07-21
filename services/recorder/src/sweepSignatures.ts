/**
 * SIGNATURE HARNESS — test the five signatures as designed, each with its OWN
 * entry rule and its OWN exit profile, against the real recorded tape.
 *
 * The snap sweep (sweepSnap.ts) tested one global threshold across every
 * candidate, which flattens the whole thesis: a moon's pullback is ~60% and a
 * riser's is ~10%, so a single number is wrong for four classes out of five.
 * Here each candidate is ROUTED on observables known at the tick, and then
 * judged by the rules belonging to its own class.
 *
 * Routing (priority-ordered, from the blueprint — all leak-free at entry):
 *   RUG-RISK  pool draining, or discovery liquidity ≥$30k   → refuse
 *   MOON      thin pool <$5k, or buy share <50%, or dip ≥25%
 *   CLIMBER   pool grown ≥+50% by the tick
 *   RISER     buy share ≥80%
 *   BASE      everything else
 *
 * Exits per signature are the MEASURED requirements, not guesses:
 *   winners' floor  = the 10th-pct dip below entry among runners
 *   trail           = the median give-back from a running peak BEFORE the real high
 *   ladder          = rungs placed against that class's own run distribution
 *
 * FIT/HOLDOUT is enforced: the split is by first-seen date, and any class whose
 * edge appears on only one side is noise, however good the number looks.
 *
 *   pnpm --filter @hermes/recorder exec tsx src/sweepSignatures.ts [fitEndISO]
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

type SigName = "RUG-RISK" | "MOON" | "CLIMBER" | "RISER" | "BASE";

interface SigProfile {
  trade: boolean;
  /** Rise off the trough required to confirm — the pullback tell, per class. */
  minSnap: number;
  /** Hard floor as a fraction of entry; below this we cut. */
  floor: number;
  /** Trail width as a fraction off the running peak. */
  trail: number;
  /** [multiple, fraction] rungs, entry-relative. */
  rungs: [number, number][];
  /** Size multiplier vs the standard position. */
  size: number;
}

// Measured profiles. floor/trail come straight from the per-signature trajectory
// measurement; rungs are placed against each class's own p50/p75 run.
const PROFILES: Record<SigName, SigProfile> = {
  "RUG-RISK": { trade: false, minSnap: 0, floor: 0, trail: 0, rungs: [], size: 0 },
  MOON: {
    trade: true,
    minSnap: 0.35, // deep pullback class — demands a real snap
    floor: 0.52, // winners dip to 0.52x before running
    trail: 0.4, // 24% median give-back, p75 40%
    rungs: [
      [1.43, 0.25],
      [2.35, 0.25],
    ], // p50 / p75 — leave 50% for the 4.27x p90 tail
    size: 0.4, // lottery class: experimental allocation, not conviction
  },
  CLIMBER: {
    trade: true,
    minSnap: 0.2,
    floor: 0.37, // widest floor of any class — winners dip to 0.37x
    trail: 0.52, // 34.6% median give-back, p75 51.5%
    rungs: [
      [1.56, 0.3],
      [2.37, 0.3],
    ],
    size: 1.0, // best risk-adjusted class (1.6% rug)
  },
  RISER: {
    trade: true,
    minSnap: 0.15, // shallow-pullback class — a small snap is all it gives
    floor: 0.73,
    trail: 0.34, // 15.5% median, p75 33.8%
    rungs: [
      [1.51, 0.35],
      [2.23, 0.35],
    ],
    size: 1.0,
  },
  BASE: {
    trade: true,
    minSnap: 0.2,
    floor: 0.69,
    trail: 0.34,
    rungs: [
      [1.51, 0.3],
      [2.09, 0.3],
    ],
    size: 1.0,
  },
};

function route(liq0: number, liqNow: number, buyShare: number, dipDepth: number): SigName {
  const growth = liq0 > 0 ? liqNow / liq0 : 1;
  if (growth < 1.0 || liq0 >= 30_000) return "RUG-RISK";
  if (liq0 < 5_000 || buyShare < 0.5 || dipDepth >= 0.25) return "MOON";
  if (growth >= 1.5) return "CLIMBER";
  if (buyShare >= 0.8) return "RISER";
  return "BASE";
}

/** Realized return per $1 under one signature's own floor / trail / ladder. */
function simulate(forward: number[], entryMk: number, p: SigProfile, liqUsd: number, sizeUsd: number): number {
  if (entryMk <= 0 || forward.length === 0) return 1;
  let peak = 0;
  let exitRel = forward[forward.length - 1]! / entryMk;
  for (const mk of forward) {
    const rel = mk / entryMk;
    peak = Math.max(peak, rel);
    if (rel <= p.floor) {
      exitRel = rel;
      break;
    } // protective floor
    if (peak > 0 && rel <= peak * (1 - p.trail)) {
      exitRel = rel;
      break;
    } // trail
  }
  let banked = 0;
  let sold = 0;
  for (const [level, frac] of p.rungs) {
    if (peak >= level) {
      banked += frac * level;
      sold += frac;
    }
  }
  const gross = banked + Math.max(0, 1 - sold) * Math.max(exitRel, 0);
  const costs = (FEE_PCT / 100) * 2 + convexSlippagePct(sizeUsd * p.size, Math.max(liqUsd, 1)) / 100;
  return Math.max(0, gross * (1 - costs));
}

interface B {
  n: number;
  ret: number[];
}
const mk = (): B => ({ n: 0, ret: [] });

async function main(): Promise<void> {
  const ticks = await db.select().from(candidateTicks).orderBy(asc(candidateTicks.snappedAt));
  const byMint = new Map<string, typeof ticks>();
  for (const t of ticks) {
    const a = byMint.get(t.mint) ?? [];
    a.push(t);
    byMint.set(t.mint, a);
  }

  const fit: Record<string, B> = {};
  const hold: Record<string, B> = {};
  for (const s of Object.keys(PROFILES)) {
    fit[s] = mk();
    hold[s] = mk();
  }
  fit["__CURRENT__"] = mk();
  hold["__CURRENT__"] = mk();
  fit["__CUR_ENTRY_SIG_EXIT__"] = mk();
  hold["__CUR_ENTRY_SIG_EXIT__"] = mk();
  fit["__SIG_ENTRY_CUR_EXIT__"] = mk();
  hold["__SIG_ENTRY_CUR_EXIT__"] = mk();

  for (const rows of byMint.values()) {
    if (rows.length < 4) continue;
    const liq0 = num(rows[0]!.liquidityUsd);
    if (liq0 <= 0) continue;
    const seenAt = rows[0]!.snappedAt;
    const bucket = seenAt < FIT_END ? fit : hold;

    let trough = Number.POSITIVE_INFINITY;
    let troughIdx = -1;
    let firedSig = false;
    let firedCurrent = false;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      const m = num(r.markMultiple);
      if (m > 0 && m < trough) {
        trough = m;
        troughIdx = i;
      }
      const wm = num(r.watchMinutes);
      if (wm < cfg.CONFIRM_MIN_WATCH_MIN || wm > cfg.CONFIRM_MAX_WATCH_MIN) continue;
      const dd = num(r.drawdownFromPeakPct);
      const bs = r.buyShareM5 == null ? 0.5 : num(r.buyShareM5);
      const liqNow = num(r.liquidityUsd);

      // ── DECOMPOSITION — three baselines on identical data, so we can tell
      // whether the gain comes from the ENTRY routing or from the EXIT profiles.
      // Changing both at once (as the first run did) cannot answer that.
      if (!firedCurrent && m >= cfg.CONFIRM_MIN_MULT && dd <= cfg.CONFIRM_MAX_DD_PCT && bs >= cfg.CONFIRM_MIN_BUYSHARE) {
        firedCurrent = true;
        const fwd = rows.slice(i + 1).map((x) => num(x.markMultiple));
        if (fwd.length) {
          const CUR_EXIT: SigProfile = {
            trade: true, minSnap: 0, floor: 1 - cfg.HARD_STOP_PCT / 100, trail: 0.45,
            rungs: [[1.15, 0.4], [1.3, 0.1], [1.58, 0.3]], size: 1,
          };
          // A: current entry + current exits — the system as it runs today.
          bucket["__CURRENT__"]!.n += 1;
          bucket["__CURRENT__"]!.ret.push(simulate(fwd, m, CUR_EXIT, liqNow, cfg.PAPER_POSITION_USD));
          // B: current entry + the SIGNATURE exits for whatever class it routes to.
          // Isolates the exit profiles alone.
          let ph = 0;
          for (let k = 0; k <= troughIdx; k++) ph = Math.max(ph, num(rows[k]!.markMultiple));
          const dDep = ph > 0 && Number.isFinite(trough) ? Math.max(0, 1 - trough / ph) : 0;
          const sg = route(liq0, liqNow, bs, dDep);
          const sp = PROFILES[sg];
          if (sp.trade) {
            bucket["__CUR_ENTRY_SIG_EXIT__"]!.n += 1;
            bucket["__CUR_ENTRY_SIG_EXIT__"]!.ret.push(simulate(fwd, m, sp, liqNow, cfg.PAPER_POSITION_USD));
          }
        }
      }

      // ── the SIGNATURE gate ──
      if (firedSig) continue;
      let preHigh = 0;
      for (let k = 0; k <= troughIdx; k++) preHigh = Math.max(preHigh, num(rows[k]!.markMultiple));
      const dipDepth = preHigh > 0 && Number.isFinite(trough) ? Math.max(0, 1 - trough / preHigh) : 0;
      const snapPct = Number.isFinite(trough) && trough > 0 ? m / trough - 1 : 0;

      const sig = route(liq0, liqNow, bs, dipDepth);
      const p = PROFILES[sig];
      if (snapPct < p.minSnap) continue;
      if (bs < cfg.CONFIRM_MIN_BUYSHARE) continue;
      if (!p.trade) {
        // Count the refusal — the router's most important job is refusing, and
        // leaving it uncounted made it look like it never fired at all.
        bucket[sig]!.n += 1;
        firedSig = true;
        continue;
      }

      firedSig = true;
      const fwd = rows.slice(i + 1).map((x) => num(x.markMultiple));
      if (!fwd.length) continue;
      const b = bucket[sig]!;
      b.n += 1;
      b.ret.push(simulate(fwd, m, p, liqNow, cfg.PAPER_POSITION_USD));
      // C: signature entry + CURRENT exits — isolates the routing alone.
      bucket["__SIG_ENTRY_CUR_EXIT__"]!.n += 1;
      bucket["__SIG_ENTRY_CUR_EXIT__"]!.ret.push(
        simulate(
          fwd, m,
          { trade: true, minSnap: 0, floor: 1 - cfg.HARD_STOP_PCT / 100, trail: 0.45,
            rungs: [[1.15, 0.4], [1.3, 0.1], [1.58, 0.3]], size: 1 },
          liqNow, cfg.PAPER_POSITION_USD,
        ),
      );
    }
  }

  const stat = (b: B) => {
    if (!b || b.n === 0) return { ev: 0, med: 0, win: 0, edge: 0 };
    const s = [...b.ret].sort((x, y) => x - y);
    const ev = b.ret.reduce((t, x) => t + x, 0) / b.n;
    return { ev, med: s[Math.floor(b.n / 2)] ?? 0, win: (100 * b.ret.filter((x) => x >= 1).length) / b.n, edge: b.n * (ev - 1) };
  };

  console.log(`\nSIGNATURE HARNESS — ${byMint.size} candidates · fit < ${FIT_END.toISOString()} ≤ holdout`);
  console.log(`each class judged by its OWN snap / floor / trail / ladder · costs modelled\n`);
  console.log(
    `${"signature".padEnd(11)}${"FIT n".padStart(7)}${"EV/$".padStart(8)}${"win%".padStart(6)}${"edge".padStart(9)}` +
      `  │  ${"HOLD n".padStart(7)}${"EV/$".padStart(8)}${"win%".padStart(6)}${"edge".padStart(9)}`,
  );
  console.log("─".repeat(84));
  const NAMES: Record<string, string> = {
    __CURRENT__: "A cur/cur",
    __CUR_ENTRY_SIG_EXIT__: "B cur→sigX",
    __SIG_ENTRY_CUR_EXIT__: "C sig→curX",
  };
  for (const s of ["__CURRENT__", "__CUR_ENTRY_SIG_EXIT__", "__SIG_ENTRY_CUR_EXIT__", "RISER", "CLIMBER", "MOON", "BASE", "RUG-RISK"]) {
    const f = stat(fit[s]!);
    const h = stat(hold[s]!);
    const name = NAMES[s] ?? s.toLowerCase();
    console.log(
      `${name.padEnd(11)}${String(fit[s]!.n).padStart(7)}${f.ev.toFixed(3).padStart(8)}${f.win.toFixed(0).padStart(6)}${f.edge.toFixed(0).padStart(9)}` +
        `  │  ${String(hold[s]!.n).padStart(7)}${h.ev.toFixed(3).padStart(8)}${h.win.toFixed(0).padStart(6)}${h.edge.toFixed(0).padStart(9)}`,
    );
  }
  const sigTot = (bk: Record<string, B>) =>
    ["RISER", "CLIMBER", "MOON", "BASE"].reduce((t, s) => t + stat(bk[s]!).edge, 0);
  const sigN = (bk: Record<string, B>) => ["RISER", "CLIMBER", "MOON", "BASE"].reduce((t, s) => t + bk[s]!.n, 0);
  console.log("─".repeat(84));
  console.log(
    `${"SIG TOTAL".padEnd(11)}${String(sigN(fit)).padStart(7)}${"".padStart(8)}${"".padStart(6)}${sigTot(fit).toFixed(0).padStart(9)}` +
      `  │  ${String(sigN(hold)).padStart(7)}${"".padStart(8)}${"".padStart(6)}${sigTot(hold).toFixed(0).padStart(9)}`,
  );
  console.log(`\nrefused as RUG-RISK: ${fit["RUG-RISK"]!.n + hold["RUG-RISK"]!.n} (never entered)`);
  console.log(`edge = n × (EV−1), i.e. total dollars of edge per $1 position. A class must earn on BOTH sides.\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
