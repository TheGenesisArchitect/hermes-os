/**
 * COUNTERFACTUAL WEALTH CURVE (Phase II master plan, approved 2026-08-03).
 * "What would today's equity be under each historical architecture?" —
 * every policy replayed over the SAME full tape (paper's candidate universe,
 * the sensor that saw everything), fills simulated honestly (2-tick latency,
 * depth-priced slippage, dead pools pay nothing), $3 fixed ticket, one seat
 * per candidate. THE PROMOTION STANDARD: no policy reaches live without
 * beating the incumbent here.
 * Policies:
 *   MIRROR       take everything (the 07-20 era)
 *   GATE STACK   core4 genome · bs≥.55 · inflow≥1.2 · crowd W>R (the 07-27 era, approximated)
 *   MANIFEST v3  prom5 tiers + qualified RUG_RISK cell (today's policy)
 *   WINNER QUEUE CAEV-ranked top-30/day (Phase II; whole-tape CAEV — labeled
 *                IN-SAMPLE upper bound until the shadow record replaces it)
 * Run: npx tsx packages/db/replays/wealth-curve.ts
 */
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(env)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const DEAD = 1200, PHANTOM = 5000000, DELAY = 2, FEE = 0.0025, FIX = 0.02, TICKET = 3, K = 50, TOPN_DAY = 30;
const slip = (u: number, l: number) => Math.min(u / (l / 2 + u), 0.99);
type Tick = { t: number; px: number; liq: number };
type Cand = { mint: string; o: Date; dy: string; sig: string | null; wh: number | null; rh: number | null;
  bs: number | null; lg: number | null; dex: string | null; pnl: number };

function sim(ticks: Tick[], e: number): number {
  let held = 1, pnl = -TICKET * FEE - FIX, pk = e, stall = 0, rung = 0;
  const rungs: [number, number][] = [[1.15, 0.4], [1.3, 0.55], [1.58, 0.7]];
  const sell = (i: number, f: number): void => {
    const j = Math.min(i + DELAY, ticks.length - 1); const { px, liq } = ticks[j]!;
    if (liq < DEAD || liq > PHANTOM || f <= 0) return;
    const nt = TICKET * f * (px / e);
    pnl += nt * (1 - slip(nt, liq)) * (1 - FEE) - FIX - TICKET * f; held -= f;
  };
  for (let i = 0; i < ticks.length && held > 1e-6; i++) {
    const { t, px, liq } = ticks[i]!; const x = px / e;
    if (px > pk) { pk = px; stall = t; }
    if (liq < DEAD || liq > PHANTOM) break;
    if (x <= 0.75) { sell(i, held); break; }
    while (rung < rungs.length && x >= rungs[rung]![0]!) { sell(i, Math.max(0, held - (1 - rungs[rung]![1]!))); rung++; }
    if (pk / e >= 1.3 && t - stall >= 180_000 && x > 1.02) { sell(i, held); break; }
  }
  if (held > 1e-6 && ticks[ticks.length - 1]!.liq >= DEAD) sell(ticks.length - 1, held);
  return pnl;
}

const CORE4 = new Set(["BASE", "RISER", "MOON_FAST", "MOON_VIOLENT"]);
const P5 = new Set(["BASE", "MOON_SLOW", "MOON_FAST", "RISER", "MOON_VIOLENT"]);
const V3V = new Set(["pumpswap", "fluxbeam", "meteora-damm-v2"]);
const crowd = (c: Cand) => (c.wh ?? 0) >= 1 && (c.wh ?? 0) > (c.rh ?? 0);
const POLICIES: [string, (c: Cand) => boolean][] = [
  ["MIRROR (07-20 era)", () => true],
  ["GATE STACK (07-27 era)", (c) => c.sig != null && CORE4.has(c.sig) && (c.bs ?? 1) >= 0.55 && (c.lg == null || c.lg >= 1.2) && crowd(c)],
  ["MANIFEST v3 (today)", (c) =>
    (c.sig != null && P5.has(c.sig) && c.dex != null && V3V.has(c.dex) && crowd(c) && (c.lg == null || c.lg >= 1.2) && (c.bs == null || c.bs >= 0.55)) ||
    (c.sig === "RUG_RISK" && crowd(c) && c.lg != null && c.lg >= 1.2 && c.lg <= 2.05)],
];

(async () => {
  const q = postgres(url, { idle_timeout: 5 });
  const cands = (await q`
    SELECT DISTINCT ON (p.mint, date_trunc('hour', p.opened_at))
      p.mint, p.opened_at o, to_char(p.opened_at,'MM-DD') AS dy, p.entry_price_usd::float e,
      co.signature sig, co.wallet_winner_hits wh, co.wallet_rug_hits rh,
      co.trigger_buy_share::float bs, co.liq_growth::float lg, t.dex, p.realized_pnl_usd::float pnl
    FROM positions p LEFT JOIN candidate_outcomes co ON co.mint=p.mint LEFT JOIN tokens t ON t.mint=p.mint
    WHERE p.lane='paper' AND p.status='closed' AND p.entry_price_usd::float>0
    ORDER BY p.mint, date_trunc('hour', p.opened_at), p.opened_at`) as unknown as (Cand & { e: number })[];
  console.log(`WEALTH CURVE — ${cands.length} unique candidate-seats on the full tape\n`);
  // simulate each candidate ONCE, reuse across policies
  const simmed = new Map<string, number>();
  for (const c of cands) {
    const key = c.mint + c.o.toISOString();
    const ticks = (await q`SELECT extract(epoch from snapped_at)*1000 t, price_usd::float px, liquidity_usd::float liq
      FROM candidate_ticks WHERE mint=${c.mint} AND snapped_at BETWEEN ${c.o} AND ${c.o}::timestamptz + interval '4 hours'
      ORDER BY snapped_at`) as unknown as Tick[];
    simmed.set(key, ticks.length >= 5 ? sim(ticks, c.e) : 0);
  }
  const take = (sel: Cand[]) => sel.reduce((s, c) => s + (simmed.get(c.mint + c.o.toISOString()) ?? 0), 0);
  for (const [name, pred] of POLICIES) {
    const sel = cands.filter(pred);
    console.log(`${name.padEnd(26)} seats ${String(sel.length).padStart(5)}  simulated P&L $${take(sel).toFixed(2).padStart(9)}  (start $150 → $${(150 + take(sel)).toFixed(2)})`);
  }
  // WINNER QUEUE: whole-tape CAEV per signature (in-sample), top-N per day
  const bySig: Record<string, { n: number; ev: number }> = {};
  for (const c of cands) { const s = (bySig[c.sig ?? "∅"] ??= { n: 0, ev: 0 }); s.n++; s.ev += simmed.get(c.mint + c.o.toISOString()) ?? 0; }
  const caev = (s: string | null) => { const x = bySig[s ?? "∅"]; return x ? (x.ev / x.n) * (x.n / (x.n + K)) : 0; };
  const byDay = new Map<string, Cand[]>();
  for (const c of cands) { if (!byDay.has(c.dy)) byDay.set(c.dy, []); byDay.get(c.dy)!.push(c); }
  let queueSel: Cand[] = [];
  for (const [, dayC] of byDay) queueSel = queueSel.concat([...dayC].sort((a, b) => caev(b.sig) - caev(a.sig)).slice(0, TOPN_DAY).filter((c) => caev(c.sig) > 0));
  console.log(`${"WINNER QUEUE (in-sample)".padEnd(26)} seats ${String(queueSel.length).padStart(5)}  simulated P&L $${take(queueSel).toFixed(2).padStart(9)}  (start $150 → $${(150 + take(queueSel)).toFixed(2)})`);
  console.log("\nCaveats: fixed $3 ticket · one seat/candidate/hour · honest sim (latency, depth slippage, dead pools pay 0) · WINNER QUEUE uses whole-tape CAEV = in-sample UPPER BOUND — the shadow record replaces it out-of-sample.");
  await q.end();
})();
