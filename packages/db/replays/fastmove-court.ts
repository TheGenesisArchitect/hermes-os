/**
 * FAST-MOVE COURT (operator, 2026-08-05). Finding under test: 47 moonshot-tier
 * positions whose moves completed in <5min lost -$333 in 24h because the
 * late-arm ladder (first rung 3x) never engaged — the standard ladder would
 * have banked on the way up. Question: does a VELOCITY DETECTOR (if the
 * position reaches >=1.15x within FAST_WINDOW_S of entry, run the STANDARD
 * ladder instead of late-arm) beat the incumbent — on BOTH halves, and
 * without gutting the moon tail that late-arm exists to catch?
 * Entry-knowable at decision time: velocity is measured from the position's
 * OWN elapsed ticks, never from future data.
 * Run: npx tsx packages/db/replays/fastmove-court.ts [hours=48]
 */
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(env)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const HOURS = Number(process.argv[2] ?? 48);
const DEAD = 1200, DELAY = 2, FEE = 0.0025, FIX = 0.02;
const slip = (u: number, l: number) => Math.min(u / (l / 2 + u), 0.99);
type Tick = { t: number; px: number; liq: number };
const STD: [number, number][] = [[1.15, 0.4], [1.3, 0.55], [1.58, 0.7]];
const LATE: [number, number][] = [[3, 0.4], [5, 0.6], [8, 0.75]]; // late-arm (moon) ladder

/** fastWindowS = 0 disables the detector (pure incumbent). */
function sim(ticks: Tick[], e: number, size: number, isMoon: boolean, fastWindowS: number): number {
  let held = 1, pnl = -size * FEE - FIX, pk = e, stall = 0, rung = 0;
  const t0 = ticks[0]!.t;
  let ladder = isMoon ? LATE : STD;
  let switched = false;
  const sell = (i: number, f: number): void => {
    const j = Math.min(i + DELAY, ticks.length - 1); const { px, liq } = ticks[j]!;
    if (liq < DEAD || f <= 0) return;
    const nt = size * f * (px / e);
    pnl += nt * (1 - slip(nt, liq)) * (1 - FEE) - FIX - size * f; held -= f;
  };
  for (let i = 0; i < ticks.length && held > 1e-6; i++) {
    const { t, px, liq } = ticks[i]!; const x = px / e;
    if (px > pk) { pk = px; stall = t; }
    if (liq < DEAD) break;
    // VELOCITY DETECTOR — entry-knowable: elapsed time + current mark only.
    if (isMoon && !switched && fastWindowS > 0 && x >= 1.15 && (t - t0) <= fastWindowS * 1000) {
      ladder = STD; switched = true; // fast mover → bank on the way up
    }
    if (x <= 0.75) { sell(i, held); break; }
    while (rung < ladder.length && x >= ladder[rung]![0]!) { sell(i, Math.max(0, held - (1 - ladder[rung]![1]!))); rung++; }
    if (pk / e >= 1.3 && t - stall >= 180_000 && x > 1.02) { sell(i, held); break; }
  }
  if (held > 1e-6 && ticks[ticks.length - 1]!.liq >= DEAD) sell(ticks.length - 1, held);
  return pnl;
}

(async () => {
  const q = postgres(url, { idle_timeout: 5 });
  const rows = (await q`
    SELECT p.id, p.mint, p.tier, p.size_usd::float sz, p.entry_price_usd::float e, p.opened_at o,
      p.realized_pnl_usd::float actual
    FROM positions p WHERE p.lane='paper' AND p.status='closed'
      AND p.closed_at > now() - make_interval(hours => ${HOURS}) AND p.entry_price_usd::float>0`) as unknown as
    { id: number; mint: string; tier: string; sz: number; e: number; o: Date; actual: number }[];
  const half = Date.now() - (HOURS / 2) * 3600_000;
  const VARIANTS: [string, number][] = [["INCUMBENT (late-arm as-is)", 0], ["FAST-60s → standard", 60], ["FAST-120s → standard", 120], ["FAST-300s → standard", 300]];
  const acc: Record<string, { early: number; late: number; moonTail: number }> = {};
  let n = 0, aE = 0, aL = 0;
  for (const p of rows) {
    const ticks = (await q`SELECT extract(epoch from snapped_at)*1000 t, price_usd::float px, liquidity_usd::float liq
      FROM candidate_ticks WHERE mint=${p.mint} AND snapped_at BETWEEN ${p.o} AND ${p.o}::timestamptz + interval '4 hours'
      ORDER BY snapped_at`) as unknown as Tick[];
    if (ticks.length < 5) continue;
    n++;
    const isLateHalf = p.o.getTime() >= half;
    if (isLateHalf) aL += p.actual; else aE += p.actual;
    const isMoon = p.tier === "moonshot";
    const peakX = Math.max(...ticks.map((x) => x.px)) / p.e;
    for (const [name, w] of VARIANTS) {
      const r = sim(ticks, p.e, p.sz, isMoon, w);
      const a = (acc[name] ??= { early: 0, late: 0, moonTail: 0 });
      if (isLateHalf) a.late += r; else a.early += r;
      if (isMoon && peakX >= 3) a.moonTail += r; // did we gut the tail late-arm exists for?
    }
  }
  console.log(`FAST-MOVE COURT — ${n} positions, last ${HOURS}h\n`);
  console.log(`${"variant".padEnd(28)} ${"1st half".padStart(10)} ${"2nd half".padStart(10)} ${"total".padStart(10)} ${"moon-tail≥3x".padStart(13)}  verdict`);
  console.log(`${"ACTUAL (booked)".padEnd(28)} ${aE.toFixed(2).padStart(10)} ${aL.toFixed(2).padStart(10)} ${(aE + aL).toFixed(2).padStart(10)}`);
  const inc = acc["INCUMBENT (late-arm as-is)"]!;
  for (const [name] of VARIANTS) {
    const a = acc[name]!;
    const beats = a.early > inc.early && a.late > inc.late;
    const tailOk = a.moonTail >= inc.moonTail * 0.9; // ≤10% tail sacrifice
    console.log(`${name.padEnd(28)} ${a.early.toFixed(2).padStart(10)} ${a.late.toFixed(2).padStart(10)} ${(a.early + a.late).toFixed(2).padStart(10)} ${a.moonTail.toFixed(2).padStart(13)}  ${name.startsWith("INCUMBENT") ? "(incumbent)" : beats && tailOk ? "✅ SHIPS" : beats ? "beats, but guts the tail" : "—"}`);
  }
  console.log("\nBar: beat the incumbent in BOTH halves AND retain ≥90% of the ≥3x moon-tail P&L.");
  await q.end();
})();
