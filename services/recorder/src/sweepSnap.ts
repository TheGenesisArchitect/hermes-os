/**
 * SNAP SWEEP — find the snap threshold, honestly.
 *
 * Walks every recorded candidate trajectory through the SAME pure
 * evaluateEntryTrigger the recorder runs live, once per snap threshold, and
 * reports realized return per $1 with the real ladder and real costs.
 *
 * The three guardrails that make a parameter search trustworthy, all enforced here:
 *
 *  1. FIT / HOLDOUT. Candidates are split by first-seen date. The threshold is
 *     chosen on the fit slice and PROVEN on the holdout. A parameter that only
 *     works in-sample is noise — this is how we find that out for free instead of
 *     at $2.50 a position (the ×2.0 band boost passed in-sample review on
 *     2026-07-20 and went 0-for-4 live).
 *
 *  2. PRE-DECLARED GRID. SNAP_GRID below is fixed before the run. Adding
 *     parameters until something pops multiplies the false-positive rate; one
 *     declared grid is one honest experiment.
 *
 *  3. PLATEAU, NOT PEAK. The report prints the whole curve, because the SHAPE
 *     decides whether the number is real. Neighbouring thresholds performing
 *     similarly = a broad basin = a robust optimum. A lone spike between two
 *     mediocre neighbours is an artifact no matter how good it looks.
 *
 * Costs are modelled (fee + convex slippage on exit), so these numbers are
 * directly comparable to live rather than to an idealised fill.
 *
 *   pnpm --filter @hermes/recorder exec tsx src/sweepSnap.ts [fitEndISO]
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
loadEnv({ path: resolve(import.meta.dirname, "../../../.env") });
import { convexSlippagePct, entryTriggerConfigFrom, evaluateEntryTrigger, loadConfig, type Action, type Tick } from "@hermes/core";
import { candidateTicks, db } from "@hermes/db";
import { asc } from "drizzle-orm";

const cfg = loadConfig();
const baseTriggerCfg = entryTriggerConfigFrom(cfg);
const num = (v: string | null | undefined): number => (v == null ? 0 : Number(v));

// ── pre-declared grid ────────────────────────────────────────────────────────
const SNAP_GRID = [0, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6] as const;
// Split: everything first seen BEFORE this instant fits; everything after proves.
const FIT_END = new Date(process.argv[2] ?? "2026-07-18T00:00:00Z");

// ── cost model (matches trail-replay) ────────────────────────────────────────
const FEE_PCT = 0.25;
const TRAIL_PCT = 0.45; // the runner's trail, fraction off the running peak

/** Realized return per $1 for one trajectory, entering at `entryMk`. */
function simulate(forward: number[], entryMk: number, liqUsd: number, sizeUsd: number): number {
  if (entryMk <= 0 || forward.length === 0) return 1;
  const rungs: [number, number][] = [
    [1.15, 0.4],
    [1.3, 0.1],
    [1.58, 0.3],
  ];
  let peak = 0;
  let exitRel = forward[forward.length - 1]! / entryMk; // ride to the end if the trail never breaks
  for (const mk of forward) {
    const rel = mk / entryMk;
    peak = Math.max(peak, rel);
    if (peak > 0 && rel <= peak * (1 - TRAIL_PCT)) {
      exitRel = rel;
      break;
    }
  }
  let banked = 0;
  let sold = 0;
  for (const [level, frac] of rungs) {
    if (peak >= level) {
      banked += frac * level;
      sold += frac;
    }
  }
  const remainder = Math.max(0, 1 - sold);
  const gross = banked + remainder * Math.max(exitRel, 0);
  // Costs: fee on the way in and out, plus convex slippage on the exit size.
  const slipPct = convexSlippagePct(sizeUsd, Math.max(liqUsd, 1));
  const costs = (FEE_PCT / 100) * 2 + slipPct / 100;
  return Math.max(0, gross * (1 - costs));
}

interface Bucket {
  n: number;
  ret: number[];
}
const emptyBucket = (): Bucket => ({ n: 0, ret: [] });

async function main(): Promise<void> {
  const ticks = await db.select().from(candidateTicks).orderBy(asc(candidateTicks.snappedAt));
  const byMint = new Map<string, typeof ticks>();
  for (const t of ticks) {
    const arr = byMint.get(t.mint) ?? [];
    arr.push(t);
    byMint.set(t.mint, arr);
  }

  console.log(`\nSNAP SWEEP — ${byMint.size} candidates, fit < ${FIT_END.toISOString()} ≤ holdout`);
  console.log(`grid (pre-declared): ${SNAP_GRID.join(", ")}`);
  console.log(`costs: ${FEE_PCT}% fee each way + convex slippage on exit\n`);
  console.log(
    `${"snap".padEnd(6)}${"FIT n".padStart(7)}${"EV/$".padStart(9)}${"med".padStart(8)}${"win%".padStart(7)}` +
      `${"  │  "}${"HOLD n".padStart(7)}${"EV/$".padStart(9)}${"med".padStart(8)}${"win%".padStart(7)}`,
  );
  console.log("─".repeat(78));

  for (const snap of SNAP_GRID) {
    const triggerCfg = { ...baseTriggerCfg, minSnap: snap, minMult: snap > 0 ? 1.0 : baseTriggerCfg.minMult };
    const fit = emptyBucket();
    const hold = emptyBucket();

    for (const rows of byMint.values()) {
      if (rows.length < 4) continue;
      const series: Tick[] = [];
      let entryIdx = -1;
      let entryMk = 0;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]!;
        series.push({
          markMultiple: num(r.markMultiple),
          drawdownFromPeakPct: num(r.drawdownFromPeakPct),
          buyShareM5: r.buyShareM5 == null ? 0.5 : num(r.buyShareM5),
          volM5: num(r.volM5),
          volH1: num(r.volH1),
          priceChangeM5Pct: num(r.priceChangeM5Pct),
          ageMinutes: num(r.ageMinutes),
        });
        const trig = evaluateEntryTrigger(
          series,
          {
            watchMinutes: num(r.watchMinutes),
            observationCount: i + 1,
            action: (r.action as Action) ?? null,
            liqGrowth: null,
            continuationLookback: Math.max(1, Math.round(30_000 / cfg.RECORDER_POLL_MS)),
          },
          triggerCfg,
        );
        if (trig.triggered) {
          entryIdx = i;
          entryMk = trig.markMultiple;
          break;
        }
      }
      if (entryIdx < 0 || entryMk <= 0) continue;

      const forward = rows.slice(entryIdx + 1).map((r) => num(r.markMultiple));
      if (forward.length === 0) continue;
      const liq = num(rows[entryIdx]!.liquidityUsd);
      const ret = simulate(forward, entryMk, liq, cfg.PAPER_POSITION_USD);
      // Slice by WHEN the candidate was first seen, not when it triggered.
      const seenAt = rows[0]!.snappedAt;
      const b = seenAt < FIT_END ? fit : hold;
      b.n += 1;
      b.ret.push(ret);
    }

    const stat = (b: Bucket) => {
      if (b.n === 0) return { ev: 0, med: 0, win: 0 };
      const sorted = [...b.ret].sort((x, y) => x - y);
      return {
        ev: b.ret.reduce((s, x) => s + x, 0) / b.n,
        med: sorted[Math.floor(b.n / 2)] ?? 0,
        win: (100 * b.ret.filter((x) => x >= 1).length) / b.n,
      };
    };
    const f = stat(fit);
    const h = stat(hold);
    const tag = snap === 0 ? "off" : snap.toFixed(2);
    console.log(
      `${tag.padEnd(6)}${String(fit.n).padStart(7)}${f.ev.toFixed(3).padStart(9)}${f.med.toFixed(3).padStart(8)}${f.win.toFixed(0).padStart(7)}` +
        `${"  │  "}${String(hold.n).padStart(7)}${h.ev.toFixed(3).padStart(9)}${h.med.toFixed(3).padStart(8)}${h.win.toFixed(0).padStart(7)}`,
    );
  }

  console.log(
    `\nRead the CURVE, not the max. Neighbouring thresholds performing alike = a real basin.\n` +
      `A lone spike between weak neighbours is an artifact. Accept a threshold only if it\n` +
      `holds on BOTH sides of the split.\n`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
