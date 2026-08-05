/**
 * MOON-INSURANCE COURT (operator, 2026-08-05: "capture what the markets are
 * offering consistently"). Finding: the moonshot tier holds 94% of everything
 * offered ($2,317 of $2,459 in 24h) and captures −5.6%. 68 moonshot positions
 * peaked at only ~1.15×, banked NOTHING (late-arm waits for 3×), and
 * round-tripped into floor_45 for −$506 against $254 offered.
 *
 * NOT the fast-move court (rejected): that REPLACED the moon ladder wholesale
 * and gutted the tail. This tests a small INSURANCE TRANCHE: bank a slice at
 * a low rung, let the remainder ride the late-arm ladder untouched.
 *
 * BAR (5 exit courts have already been rejected — the burden is high):
 *   1. beat the incumbent in BOTH halves of the window, AND
 *   2. retain ≥90% of the ≥3× moon-tail P&L (the reason late-arm exists), AND
 *   3. improve total capture % of what the tape actually offered.
 * Run: npx tsx packages/db/replays/moon-insurance-court.ts [hours=48]
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
const LATE: [number, number][] = [[3, 0.4], [5, 0.6], [8, 0.75]];

/** insure = [multiple, fraction] banked once, before the late-arm ladder. */
function sim(ticks: Tick[], e: number, size: number, isMoon: boolean, insure: [number, number] | null): number {
  let held = 1, pnl = -size * FEE - FIX, pk = e, stall = 0, rung = 0, insured = false;
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
    if (x <= 0.75) { sell(i, held); break; }
    // THE INSURANCE TRANCHE — moonshot tier only, fires once, low and early.
    if (isMoon && insure && !insured && x >= insure[0]) { sell(i, Math.min(held, insure[1])); insured = true; }
    const ladder = isMoon ? LATE : [[1.15, 0.4], [1.3, 0.55], [1.58, 0.7]] as [number, number][];
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
  const VARIANTS: [string, [number, number] | null][] = [
    ["INCUMBENT (no insurance)", null],
    ["insure 25% @1.15x", [1.15, 0.25]],
    ["insure 25% @1.30x", [1.30, 0.25]],
    ["insure 40% @1.15x", [1.15, 0.40]],
    ["insure 40% @1.30x", [1.30, 0.40]],
    ["insure 50% @1.20x", [1.20, 0.50]],
  ];
  const acc: Record<string, { early: number; late: number; tail: number }> = {};
  let n = 0, aE = 0, aL = 0, offered = 0;
  for (const p of rows) {
    const ticks = (await q`SELECT extract(epoch from snapped_at)*1000 t, price_usd::float px, liquidity_usd::float liq
      FROM candidate_ticks WHERE mint=${p.mint} AND snapped_at BETWEEN ${p.o} AND ${p.o}::timestamptz + interval '4 hours'
      ORDER BY snapped_at`) as unknown as Tick[];
    if (ticks.length < 5) continue;
    n++;
    const isLateHalf = p.o.getTime() >= half;
    if (isLateHalf) aL += p.actual; else aE += p.actual;
    const live = ticks.filter((x) => x.liq >= DEAD);
    const peakX = live.length ? Math.max(...live.map((x) => x.px)) / p.e : 1;
    if (peakX > 1) offered += p.sz * (peakX - 1);
    const isMoon = p.tier === "moonshot";
    for (const [name, ins] of VARIANTS) {
      const r = sim(ticks, p.e, p.sz, isMoon, ins);
      const a = (acc[name] ??= { early: 0, late: 0, tail: 0 });
      if (isLateHalf) a.late += r; else a.early += r;
      if (isMoon && peakX >= 3) a.tail += r;
    }
  }
  const cap = (v: number) => (offered > 0 ? ((100 * v) / offered).toFixed(1) + "%" : "—");
  console.log(`MOON-INSURANCE COURT — ${n} positions, ${HOURS}h · tape offered $${offered.toFixed(2)}\n`);
  console.log(`${"variant".padEnd(26)} ${"1st half".padStart(9)} ${"2nd half".padStart(9)} ${"total".padStart(10)} ${"capture".padStart(8)} ${"≥3x tail".padStart(9)}  verdict`);
  console.log(`${"ACTUAL (booked)".padEnd(26)} ${aE.toFixed(2).padStart(9)} ${aL.toFixed(2).padStart(9)} ${(aE + aL).toFixed(2).padStart(10)} ${cap(aE + aL).padStart(8)}`);
  const inc = acc["INCUMBENT (no insurance)"]!;
  for (const [name] of VARIANTS) {
    const a = acc[name]!; const tot = a.early + a.late;
    const beats = a.early > inc.early && a.late > inc.late;
    const tailOk = a.tail >= inc.tail * 0.9;
    console.log(`${name.padEnd(26)} ${a.early.toFixed(2).padStart(9)} ${a.late.toFixed(2).padStart(9)} ${tot.toFixed(2).padStart(10)} ${cap(tot).padStart(8)} ${a.tail.toFixed(2).padStart(9)}  ${name.startsWith("INCUMBENT") ? "(incumbent)" : beats && tailOk ? "✅ SHIPS" : beats ? "beats, TAIL GUTTED" : "—"}`);
  }
  console.log("\nBar: beat incumbent in BOTH halves + retain ≥90% of ≥3x tail + improve capture.");
  await q.end();
})();
