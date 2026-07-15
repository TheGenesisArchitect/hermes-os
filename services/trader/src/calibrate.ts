/**
 * Trail-width calibration replay. For every recorded candidate, reconstruct the
 * confirmation entry on its REAL tick path, then simulate the exit trail under
 * several width settings and measure winner-capture vs dud-giveback. Answers:
 * how much wider can the leash go before dud give-back eats the extra runner
 * capture? Uses candidate_ticks (recorder's 30s price paths) — coarser than the
 * trader's 5s manage loop, so intra-30s wicks are missed; this OVERstates capture
 * slightly and equally across settings, so relative ranking holds.
 * Run: pnpm --filter @hermes/trader exec tsx src/calibrate.ts
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
loadEnv({ path: resolve(import.meta.dirname, "../../../.env") });
import { db } from "@hermes/db";
import { sql } from "drizzle-orm";

// Entry gate (matches CONFIRM_* config defaults)
const G = { minMult: 1.25, maxDd: 10, minBuyShare: 0.6, minWatch: 2, maxWatch: 12, minTicks: 2 };
// Exit floor / arm (matches config)
const ARM_MULT = 1.15, FLOOR_MULT = 1.05, HARD_STOP_MULT = 0.6, PROFIT_FLOOR_USD = 1, SIZE = 17.5;
const PARABOLIC = 6;
const FEE_ROUNDTRIP = 0.006; // ~0.25%/side + priority fee, as a multiple haircut

interface Tick { mark: number; dd: number; buyShare: number; watch: number }
interface Setting { name: string; tight: number; mid: number; wide: number; snug: number; runner: number }

const SETTINGS: Setting[] = [
  { name: "S0 current    ", tight: 12, mid: 22, wide: 35, snug: 8, runner: 2.5 },
  { name: "S1 +room      ", tight: 18, mid: 28, wide: 40, snug: 12, runner: 2.0 },
  { name: "S2 wide       ", tight: 25, mid: 35, wide: 45, snug: 15, runner: 1.8 },
  { name: "S3 rider      ", tight: 30, mid: 40, wide: 55, snug: 20, runner: 1.5 },
  { name: "S4 max-leash  ", tight: 35, mid: 45, wide: 60, snug: 99, runner: 1.5 },
];

function trailWidth(s: Setting, peakMult: number, dd: number): number {
  let w = peakMult >= PARABOLIC ? s.wide : peakMult >= s.runner ? s.mid : s.tight;
  if (dd >= s.snug) w = Math.min(w, s.tight); // rolling over → snug up
  return w;
}

type ExitReason = "trail" | "floor" | "hard_stop" | "window_end";
interface SimResult { banked: number; reason: ExitReason }

/** Banked multiple + exit reason, or null if the gate never fired. */
function simulate(ticks: Tick[], s: Setting): SimResult | null {
  let entryIdx = -1;
  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i]!;
    if (i + 1 >= G.minTicks && t.mark >= G.minMult && t.dd <= G.maxDd &&
        t.buyShare >= G.minBuyShare && t.watch >= G.minWatch && t.watch <= G.maxWatch) {
      entryIdx = i; break;
    }
  }
  if (entryIdx < 0) return null;
  const entryMark = ticks[entryIdx]!.mark;
  const armFloor = 1 + PROFIT_FLOOR_USD / SIZE; // ~1.057
  let peak = 1;
  for (let i = entryIdx; i < ticks.length; i++) {
    const our = ticks[i]!.mark / entryMark;
    peak = Math.max(peak, our);
    const dd = peak > 0 ? Math.max(0, ((peak - our) / peak) * 100) : 0;
    const armed = peak >= ARM_MULT || peak >= armFloor;
    if (armed) {
      const floor = FLOOR_MULT;
      const trailStop = peak * (1 - trailWidth(s, peak, dd) / 100);
      const stop = Math.max(floor, trailStop);
      if (our <= stop) return { banked: our, reason: trailStop >= floor ? "trail" : "floor" };
    } else if (our <= HARD_STOP_MULT) {
      return { banked: our, reason: "hard_stop" };
    }
  }
  return { banked: ticks[ticks.length - 1]!.mark / entryMark, reason: "window_end" };
}

// --- load data ---
const tickRows = (await db.execute(sql`
  SELECT mint, mark_multiple::float8 AS mark, drawdown_from_peak_pct::float8 AS dd,
         coalesce(buy_share_m5,0.5)::float8 AS buyshare, watch_minutes::float8 AS watch
  FROM candidate_ticks ORDER BY mint, snapped_at
`)) as unknown as Array<{ mint: string; mark: number; dd: number; buyshare: number; watch: number }>;
const outRows = (await db.execute(sql`
  SELECT mint, label FROM candidate_outcomes
`)) as unknown as Array<{ mint: string; label: string }>;

const label = new Map<string, string>(outRows.map((r) => [r.mint, r.label]));
const byMint = new Map<string, Tick[]>();
for (const r of tickRows) {
  if (!byMint.has(r.mint)) byMint.set(r.mint, []);
  byMint.get(r.mint)!.push({ mark: r.mark, dd: r.dd, buyShare: r.buyshare, watch: r.watch });
}

// --- run each setting ---
const money = (x: number) => (x >= 0 ? "+$" : "-$") + Math.abs(x).toFixed(2);
console.log(`\n${byMint.size} candidates, ${tickRows.length} ticks. Entry = confirmation gate on the real path.`);
console.log(`Banked multiple is net of a ${(FEE_ROUNDTRIP * 100).toFixed(1)}% round-trip haircut. Window-end = held to last recorded tick.\n`);
console.log("setting          | entered | WINNERS mean→   $/tr  | DUDS mean→   $/tr  | RUGS $/tr | ALL $/tr  win%");
console.log("-----------------|---------|----------------------|--------------------|-----------|-----------------");

for (const s of SETTINGS) {
  const bucket = { winner: [] as number[], dud: [] as number[], rug: [] as number[], all: [] as number[] };
  for (const [mint, ticks] of byMint) {
    const r = simulate(ticks, s);
    if (r === null) continue; // never entered
    const net = r.banked * (1 - FEE_ROUNDTRIP);
    const pnl = (net - 1) * SIZE;
    const lab = (label.get(mint) ?? "open") as keyof typeof bucket;
    if (lab === "winner" || lab === "dud" || lab === "rug") bucket[lab].push(net);
    bucket.all.push(pnl);
  }
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const meanPnl = (a: number[]) => (a.length ? mean(a.map((m) => (m - 1) * SIZE)) : 0);
  const wMean = mean(bucket.winner), dMean = mean(bucket.dud), rMean = mean(bucket.rug);
  const allPnl = mean(bucket.all);
  const winRate = bucket.all.length ? (100 * bucket.all.filter((p) => p > 0).length) / bucket.all.length : 0;
  console.log(
    `${s.name} | ${String(bucket.all.length).padStart(7)} | ` +
    `${wMean.toFixed(2)}x (${bucket.winner.length}) ${money(meanPnl(bucket.winner)).padStart(6)} | ` +
    `${dMean.toFixed(2)}x (${bucket.dud.length}) ${money(meanPnl(bucket.dud)).padStart(5)} | ` +
    `${money(meanPnl(bucket.rug)).padStart(7)} | ${money(allPnl).padStart(7)}  ${winRate.toFixed(0)}%`,
  );
}
console.log("\n(WINNERS mean→ = avg banked multiple on tokens the recorder labeled winners; $/tr = avg $ per entered trade in that class.)");

// --- granularity diagnostics ---
const gaps = (await db.execute(sql`
  SELECT extract(epoch FROM (snapped_at - lag(snapped_at) OVER (PARTITION BY mint ORDER BY snapped_at)))::float8 AS gap
  FROM candidate_ticks
`)) as unknown as Array<{ gap: number | null }>;
const gapVals = gaps.map((g) => g.gap).filter((g): g is number => g !== null && g > 0).sort((a, b) => a - b);
const medGap = gapVals[Math.floor(gapVals.length / 2)] ?? 0;
console.log(`\n--- granularity check ---`);
console.log(`median seconds between recorder ticks: ${medGap.toFixed(0)}s (trader manages every 5s → replay is ${(medGap / 5).toFixed(0)}x coarser)`);

// Under S0, where do DUD exits land? If the 1.05 floor worked, duds cluster ~1.0.
const s0 = SETTINGS[0]!;
const dudBanked: number[] = [];
for (const [mint, ticks] of byMint) {
  if (label.get(mint) !== "dud") continue;
  const b = simulate(ticks, s0);
  if (b !== null) dudBanked.push(b.banked * (1 - FEE_ROUNDTRIP));
}
const bins = { "<0.7 (blew floor)": 0, "0.7-0.95": 0, "0.95-1.10 (floor held)": 0, ">1.10": 0 };
for (const b of dudBanked) {
  if (b < 0.7) bins["<0.7 (blew floor)"]++;
  else if (b < 0.95) bins["0.7-0.95"]++;
  else if (b <= 1.1) bins["0.95-1.10 (floor held)"]++;
  else bins[">1.10"]++;
}
console.log(`dud exit distribution under S0 (${dudBanked.length} duds):`);
for (const [k, v] of Object.entries(bins)) console.log(`  ${k.padEnd(24)} ${v}  (${((100 * v) / dudBanked.length).toFixed(0)}%)`);
console.log(`If most duds are <0.7 the 1.05 floor is being blown through by coarse ticks — live 5s data shows duds banking ~0.98-1.04x, so the replay OVERSTATES dud loss.`);

// --- WINNER exit-type: World A (trail blind) vs World B (trail is a dead end) ---
// If winners mostly exit via window_end, the trail rarely binds → widening MIGHT help at 5s (A).
// If winners mostly exit via trail even at 30s, the trail already binds → wider just gives back
//   more on the cliff-rollover, so it's a dead end at any granularity (B).
console.log(`\n--- winner exit-type (decides whether trail is even the lever) ---`);
for (const s of [SETTINGS[0]!, SETTINGS[3]!]) {
  const reasons = { trail: [] as number[], floor: [] as number[], hard_stop: [] as number[], window_end: [] as number[] };
  for (const [mint, ticks] of byMint) {
    if (label.get(mint) !== "winner") continue;
    const r = simulate(ticks, s);
    if (r === null) continue;
    reasons[r.reason].push(r.banked);
  }
  const total = Object.values(reasons).reduce((n, a) => n + a.length, 0);
  console.log(`\n${s.name.trim()} (${total} winners entered):`);
  for (const [k, arr] of Object.entries(reasons)) {
    if (!arr.length) { console.log(`  ${k.padEnd(12)} 0`); continue; }
    const m = arr.reduce((x, y) => x + y, 0) / arr.length;
    console.log(`  ${k.padEnd(12)} ${String(arr.length).padStart(3)} (${((100 * arr.length) / total).toFixed(0)}%)  mean banked ${m.toFixed(2)}x`);
  }
}
console.log(`\nIf winners exit mostly via 'trail' → the trail binds even at 30s → widening it just gives back more on rollover = DEAD END (World B).`);
console.log(`If winners exit mostly via 'window_end' → the trail rarely binds at 30s → the effect lives in 5s wicks, collect clean data (World A).`);
process.exit(0);
