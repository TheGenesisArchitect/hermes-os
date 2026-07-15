/**
 * Replay harness — reconfirm the entry trigger on real recorded ticks.
 *
 * Groups candidate_ticks by mint, rebuilds each labeled candidate's trajectory
 * chronologically, and walks it tick-by-tick through the SAME pure
 * evaluateEntryTrigger the recorder uses live — firing on the first tick that
 * confirms. Reports trigger rate on winners vs duds and the capture after entry,
 * so the TS gate is proven to reproduce the SQL calibration (88% win / 40% dud)
 * before the live flip. Run: pnpm --filter @hermes/recorder exec tsx src/replayTrigger.ts
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
loadEnv({ path: resolve(import.meta.dirname, "../../../.env") });
import { entryTriggerConfigFrom, evaluateEntryTrigger, loadConfig, type Action, type Tick } from "@hermes/core";
import { candidateOutcomes, candidateTicks, db } from "@hermes/db";
import { asc, inArray } from "drizzle-orm";

const cfg = loadConfig();
const triggerCfg = entryTriggerConfigFrom(cfg);
const num = (v: string | null | undefined): number => (v == null ? 0 : Number(v));

async function main(): Promise<void> {
  const outcomes = await db
    .select()
    .from(candidateOutcomes)
    .where(inArray(candidateOutcomes.label, ["winner", "dud"]));
  const ticks = await db.select().from(candidateTicks).orderBy(asc(candidateTicks.snappedAt));

  const byMint = new Map<string, typeof ticks>();
  for (const t of ticks) {
    const arr = byMint.get(t.mint) ?? [];
    arr.push(t);
    byMint.set(t.mint, arr);
  }

  const groups: Record<"winner" | "dud", { n: number; triggered: number; entryMult: number[]; peakAfter: number[]; finalAfter: number[] }> = {
    winner: { n: 0, triggered: 0, entryMult: [], peakAfter: [], finalAfter: [] },
    dud: { n: 0, triggered: 0, entryMult: [], peakAfter: [], finalAfter: [] },
  };

  for (const o of outcomes) {
    const label = o.label as "winner" | "dud";
    const g = groups[label];
    g.n += 1;
    const rows = byMint.get(o.mint);
    if (!rows || rows.length === 0) continue;

    const series: Tick[] = [];
    let fired = false;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r) continue;
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
        { watchMinutes: num(r.watchMinutes), observationCount: i + 1, action: (r.action as Action) ?? null },
        triggerCfg,
      );
      if (trig.triggered) {
        fired = true;
        g.triggered += 1;
        g.entryMult.push(trig.markMultiple);
        g.peakAfter.push(num(o.peakMultiple) / Math.max(trig.markMultiple, 1e-9));
        g.finalAfter.push(num(o.finalMultiple) / Math.max(trig.markMultiple, 1e-9));
        break;
      }
    }
    void fired;
  }

  const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  console.log(`\nEntry-trigger replay — gate: ≥${triggerCfg.minMult}x green, ≤${triggerCfg.maxDrawdownPct}% off peak, ≥${(triggerCfg.minBuyShare * 100).toFixed(0)}% buys, t∈[${triggerCfg.minWatchMin},${triggerCfg.maxWatchMin}]m\n`);
  for (const label of ["winner", "dud"] as const) {
    const g = groups[label];
    const pct = g.n ? Math.round((100 * g.triggered) / g.n) : 0;
    console.log(
      `${label.toUpperCase().padEnd(7)} ${g.triggered}/${g.n} triggered (${pct}%)  ` +
        `entry ${avg(g.entryMult).toFixed(3)}x → peak-after ${avg(g.peakAfter).toFixed(3)}x, final-after ${avg(g.finalAfter).toFixed(3)}x`,
    );
  }
  const wr = groups.winner.n ? (100 * groups.winner.triggered) / groups.winner.n : 0;
  const dr = groups.dud.n ? (100 * groups.dud.triggered) / groups.dud.n : 0;
  console.log(`\nseparation: ${(wr / Math.max(dr, 1e-9)).toFixed(2)}:1 (winner ${wr.toFixed(0)}% vs dud ${dr.toFixed(0)}%)`);
  const entered = groups.winner.triggered + groups.dud.triggered;
  const winRate = entered ? (100 * groups.winner.triggered) / entered : 0;
  console.log(`entered universe: ${entered} (${groups.winner.triggered} win + ${groups.dud.triggered} dud) — win-rate ${winRate.toFixed(0)}%\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
