/**
 * THE QUALIFYING FORMULA HARNESS (operator, 2026-07-23 late).
 *
 * Canonical formula under test — the core features of a winning trade:
 *   C1  INFLOW    good+strong bands: 1.20 <= liq_growth <= 2.05
 *   C2  CROWD     1W/0R: >=1 verified winner aboard, zero rug history
 *   C3  LIQ-STABLE robust pre-entry stability (150s, median-of-3 worst
 *                 deviation >= 0.85) and not falling (half-median rise >= 0.95)
 *   C4  SEAT      rising peak 1.20-1.65x at the 2-2.5min mark
 *                 (trigger in band, watch 1.8-2.7m poll-tolerant, <=5% off peak)
 * Blindspots offered for operator review:
 *   B1  TEXTURE   the chart breathed: >0% off peak at trigger OR a prior dip
 *                 >=5% (the flawless-chart cohort carried 5/6 full-size deaths)
 *   C2' CROWD-NET winners outnumber rug history (wh>=1 & wh>rh) — looser C2
 *
 * Run: npx tsx packages/db/replays/formula-harness.ts [sinceIso=2026-07-22]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(env)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const SINCE = process.argv[2] ?? "2026-07-22T04:00:00Z"; // Wednesday 00:00 local (UTC-4)
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]!; };

(async () => {
  const q = postgres(url);
  const rows = await q`
    SELECT p.id, p.mint, p.lane, tk.symbol, p.signature, p.size_usd::float size, p.realized_pnl_usd::float pnl,
      p.opened_at as o, CASE WHEN p.entry_price_usd::float > 0 THEN p.peak_price_usd::float/p.entry_price_usd::float ELSE 1 END peakx,
      co.trigger_multiple::float trig, co.liq_growth::float inflow,
      co.wallet_winner_hits wh, co.wallet_rug_hits rh, co.dip_depth::float dip, co.trigger_reason r,
      extract(epoch from (co.triggered_at - co.first_seen_at))/60.0 atm
    FROM positions p JOIN candidate_outcomes co ON co.mint=p.mint LEFT JOIN tokens tk ON tk.mint=p.mint
    WHERE p.status='closed' AND p.opened_at >= ${SINCE}::timestamptz AND p.signature IS NOT NULL`;
  const trades: any[] = [];
  for (const t of rows) {
    const ticks = await q`SELECT liquidity_usd::float l FROM candidate_ticks
      WHERE mint=${t.mint} AND snapped_at BETWEEN ${t.o}::timestamptz - interval '150 seconds' AND ${t.o}::timestamptz ORDER BY snapped_at`;
    const ls = ticks.map((x) => Number(x.l)).filter((x) => x > 0);
    let stab: number | null = null, rise: number | null = null;
    if (ls.length >= 4) {
      const h = Math.floor(ls.length / 2);
      rise = med(ls.slice(h)) / med(ls.slice(0, h));
      let worst = 1;
      for (let i = 1; i < ls.length - 1; i++) {
        const m = med([ls[i - 1]!, ls[i]!, ls[i + 1]!]);
        worst = Math.min(worst, Math.min(ls[i]!, m) / Math.max(ls[i]!, m));
      }
      stab = worst;
    }
    const offp = Number(/(\d+)% off peak/.exec(String(t.r ?? ""))?.[1] ?? NaN);
    trades.push({
      ...t, pnl: Number(t.pnl), size: Number(t.size), atm: t.atm == null ? null : Number(t.atm),
      stab, rise, offp: Number.isNaN(offp) ? null : offp,
      C1: t.inflow != null && Number(t.inflow) >= 1.2 && Number(t.inflow) <= 2.05,
      C2: t.wh != null && t.wh >= 1 && (t.rh ?? 0) === 0,
      C2n: t.wh != null && t.wh >= 1 && t.wh > (t.rh ?? 0),
      C3: stab != null && stab >= 0.85 && rise != null && rise >= 0.95,
      C4: t.trig != null && Number(t.trig) >= 1.2 && Number(t.trig) <= 1.65 && t.atm != null && Number(t.atm) >= 1.8 && Number(t.atm) <= 2.7 && (Number.isNaN(offp) || offp <= 5),
      B1: (!Number.isNaN(offp) && offp > 0) || (t.dip != null && Number(t.dip) >= 0.05),
    });
  }
  const dead = (t: any) => t.pnl <= -0.85 * t.size;
  const line = (name: string, g: any[]) => {
    if (!g.length) { console.log(`${name.padEnd(46)} n=0`); return; }
    const w = g.filter((t) => t.pnl > 0).length, d = g.filter(dead).length;
    const pnl = g.reduce((s, t) => s + t.pnl, 0);
    const off = g.reduce((s, t) => s + Math.max(0, t.size * (Number(t.peakx) - 1)), 0);
    console.log(`${name.padEnd(46)} n=${String(g.length).padStart(4)} win ${String(Math.round((100 * w) / g.length)).padStart(3)}% dead ${String(Math.round((100 * d) / g.length)).padStart(3)}% pnl $${pnl.toFixed(2).padStart(8)} capture ${off > 0 ? Math.round((100 * pnl) / off) + "%" : "—"}`);
  };
  const paper = trades.filter((t) => t.lane === "paper");
  const live = trades.filter((t) => t.lane === "live");
  console.log(`HARNESS — every closed trade since Wed (${SINCE}): paper ${paper.length}, live ${live.length}\n`);
  console.log("── FULL FORMULA (C1+C2+C3+C4) ──");
  line("PASS  (paper)", paper.filter((t) => t.C1 && t.C2 && t.C3 && t.C4));
  line("FAIL  (paper)", paper.filter((t) => !(t.C1 && t.C2 && t.C3 && t.C4)));
  line("PASS  (live)", live.filter((t) => t.C1 && t.C2 && t.C3 && t.C4));
  line("FAIL  (live)", live.filter((t) => !(t.C1 && t.C2 && t.C3 && t.C4)));
  console.log("\n── WITH C2' (winners outnumber, looser crowd) ──");
  line("PASS  (paper, C2')", paper.filter((t) => t.C1 && t.C2n && t.C3 && t.C4));
  console.log("\n── EACH COMPONENT ALONE (paper) ──");
  line("C1 inflow 1.20-2.05", paper.filter((t) => t.C1));
  line("C2 crowd 1W/0R clean", paper.filter((t) => t.C2));
  line("C2' crowd winners>rugs", paper.filter((t) => t.C2n));
  line("C3 liq stable+not-falling", paper.filter((t) => t.C3));
  line("C4 seat 1.20-1.65 @2-2.5m rising", paper.filter((t) => t.C4));
  line("B1 texture (chart breathed)", paper.filter((t) => t.B1));
  console.log("\n── LEAVE-ONE-OUT (paper: formula minus one component) ──");
  line("minus C1 (no inflow req)", paper.filter((t) => t.C2 && t.C3 && t.C4));
  line("minus C2 (no crowd req)", paper.filter((t) => t.C1 && t.C3 && t.C4));
  line("minus C3 (no stability req)", paper.filter((t) => t.C1 && t.C2 && t.C4));
  line("minus C4 (no seat req)", paper.filter((t) => t.C1 && t.C2 && t.C3));
  console.log("\n── FORMULA + BLINDSPOT B1 (paper) ──");
  line("C1+C2'+C3+C4+B1 (formula + texture)", paper.filter((t) => t.C1 && t.C2n && t.C3 && t.C4 && t.B1));
  line("formula pass but NO texture (flawless)", paper.filter((t) => t.C1 && t.C2n && t.C3 && t.C4 && !t.B1));
  console.log("\n── COMPONENT PASS RATES (why volume changes) ──");
  for (const [k, label] of [["C1","inflow"],["C2","crowd 1W/0R"],["C2n","crowd net"],["C3","liq stable"],["C4","seat"],["B1","texture"]] as const)
    console.log(`  ${label.padEnd(14)} passes ${Math.round(100 * paper.filter((t: any) => t[k]).length / paper.length)}% of trades`);
  await q.end();
})();
