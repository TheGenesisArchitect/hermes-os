/**
 * WEALTH-CURVE v2 — EVENT-TIME PROMOTION-COURT MATRIX (approved 2026-08-03).
 * Positions OCCUPY capital while open; seats and equity constrain admission;
 * clone-waves collapse to one exposure (same symbol within 60min). Finds the
 * frontier: at what capital × seats does BREADTH overtake CONCENTRATION?
 * Policies: v3 (concentrated incumbent) vs BREADTH (structural refusals only:
 * needs a signature; tier-4 analog). Survival metrics per cell.
 * Run: npx tsx packages/db/replays/wealth-curve2.ts
 */
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(env)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const DEAD = 1200, DELAY = 2, FEE = 0.0025, FIX = 0.02, TICKET = 3, WAVE_MS = 3_600_000;
const slip = (u: number, l: number) => Math.min(u / (l / 2 + u), 0.99);
type Tick = { t: number; px: number; liq: number };
type C = { mint: string; o: Date; sym: string | null; sig: string | null; wh: number | null; rh: number | null;
  bs: number | null; lg: number | null; dex: string | null; pnl: number; holdMs: number };

function sim(ticks: Tick[], e: number): { pnl: number; holdMs: number } {
  let held = 1, pnl = -TICKET * FEE - FIX, pk = e, stall = 0, rung = 0, end = ticks[ticks.length - 1]!.t;
  const rungs: [number, number][] = [[1.15, 0.4], [1.3, 0.55], [1.58, 0.7]];
  const sell = (i: number, f: number): void => {
    const j = Math.min(i + DELAY, ticks.length - 1); const { px, liq } = ticks[j]!;
    if (liq < DEAD || f <= 0) return;
    const nt = TICKET * f * (px / e);
    pnl += nt * (1 - slip(nt, liq)) * (1 - FEE) - FIX - TICKET * f; held -= f;
  };
  for (let i = 0; i < ticks.length && held > 1e-6; i++) {
    const { t, px, liq } = ticks[i]!; const x = px / e;
    if (px > pk) { pk = px; stall = t; }
    if (liq < DEAD) { end = t; break; }
    if (x <= 0.75) { sell(i, held); end = t; break; }
    while (rung < rungs.length && x >= rungs[rung]![0]!) { sell(i, Math.max(0, held - (1 - rungs[rung]![1]!))); rung++; }
    if (pk / e >= 1.3 && t - stall >= 180_000 && x > 1.02) { sell(i, held); end = t; break; }
  }
  if (held > 1e-6 && ticks[ticks.length - 1]!.liq >= DEAD) sell(ticks.length - 1, held);
  return { pnl, holdMs: Math.max(60_000, end - ticks[0]!.t) };
}

const P5 = new Set(["BASE", "MOON_SLOW", "MOON_FAST", "RISER", "MOON_VIOLENT"]);
const V3V = new Set(["pumpswap", "fluxbeam", "meteora-damm-v2"]);
const crowd = (c: C) => (c.wh ?? 0) >= 1 && (c.wh ?? 0) > (c.rh ?? 0);
const POLS: [string, (c: C) => boolean][] = [
  ["v3-CONC", (c) =>
    (c.sig != null && P5.has(c.sig) && c.dex != null && V3V.has(c.dex) && crowd(c) && (c.lg == null || c.lg >= 1.2) && (c.bs == null || c.bs >= 0.55)) ||
    (c.sig === "RUG_RISK" && crowd(c) && c.lg != null && c.lg >= 1.2 && c.lg <= 2.05)],
  ["BREADTH", (c) => c.sig != null],
];

(async () => {
  const q = postgres(url, { idle_timeout: 5 });
  const raw = (await q`
    SELECT DISTINCT ON (p.mint, date_trunc('hour', p.opened_at))
      p.mint, p.opened_at o, t.symbol sym, p.entry_price_usd::float e,
      co.signature sig, co.wallet_winner_hits wh, co.wallet_rug_hits rh,
      co.trigger_buy_share::float bs, co.liq_growth::float lg, t.dex
    FROM positions p LEFT JOIN candidate_outcomes co ON co.mint=p.mint LEFT JOIN tokens t ON t.mint=p.mint
    WHERE p.lane='paper' AND p.status='closed' AND p.entry_price_usd::float>0
    ORDER BY p.mint, date_trunc('hour', p.opened_at), p.opened_at`) as unknown as (C & { e: number })[];
  const cands: C[] = [];
  for (const c of raw) {
    const ticks = (await q`SELECT extract(epoch from snapped_at)*1000 t, price_usd::float px, liquidity_usd::float liq
      FROM candidate_ticks WHERE mint=${c.mint} AND snapped_at BETWEEN ${c.o} AND ${c.o}::timestamptz + interval '4 hours'
      ORDER BY snapped_at`) as unknown as Tick[];
    if (ticks.length < 5) continue;
    const r = sim(ticks, c.e);
    cands.push({ ...c, pnl: r.pnl, holdMs: r.holdMs });
  }
  cands.sort((a, b) => a.o.getTime() - b.o.getTime());
  console.log(`WEALTH-CURVE v2 — event-time, ${cands.length} candidates, clone-waves collapsed\n`);
  console.log("policy   × capital × seats →  ending    maxDD   kill@-32/day  taken");
  for (const [pname, pred] of POLS) {
    for (const cap0 of [150, 500, 2500]) {
      for (const seats of [4, 16, 64]) {
        let equity = cap0, peak = cap0, maxDD = 0, kills = 0, taken = 0;
        let open: { end: number }[] = [];
        const lastWave = new Map<string, number>();
        let dayKey = "", dayPnl = 0;
        for (const c of cands) {
          const now = c.o.getTime();
          open = open.filter((x) => x.end > now);
          if (!pred(c)) continue;
          const w = lastWave.get(c.sym ?? c.mint);
          if (w != null && now - w < WAVE_MS) continue; // one exposure per wave
          if (open.length >= seats) continue;
          if (equity - open.length * TICKET < TICKET) continue; // capital occupied
          lastWave.set(c.sym ?? c.mint, now);
          open.push({ end: now + c.holdMs });
          equity += c.pnl; taken++;
          const dk = c.o.toISOString().slice(0, 10);
          if (dk !== dayKey) { dayKey = dk; dayPnl = 0; }
          dayPnl += c.pnl; if (dayPnl <= -32 && c.pnl < 0) { kills++; dayPnl = 0; }
          if (equity > peak) peak = equity;
          maxDD = Math.max(maxDD, peak - equity);
          if (equity < TICKET) break; // busted
        }
        console.log(`${pname.padEnd(8)} $${String(cap0).padEnd(5)} ${String(seats).padStart(3)} → $${equity.toFixed(0).padStart(6)}  -$${maxDD.toFixed(0).padStart(4)}  ${String(kills).padStart(2)}x  ${taken}`);
      }
    }
  }
  console.log("\nNotes: $3 fixed tickets · capital locked while seats open · same-symbol waves = one exposure/60min · kill counter = days realized ≤ -$32 (would halt live; shown, not enforced). In-sample labels: v3 calibrated-on-tape; BREADTH structural-only.");
  await q.end();
})();
