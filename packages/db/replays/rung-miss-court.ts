/**
 * RUNG-MISS COURT (operator, 2026-08-05): 112 of 181 positions reached the
 * 1.15x first rung; only 42 banked one (37% fire rate), and floor_45 then
 * took -$264. Question this harness answers with numbers, before any code
 * changes: HOW MUCH of the gap is poll-granularity — i.e. rungs the manage
 * loop never saw because the touch happened between its polls?
 *
 * Method per position (real data only):
 *   RECORDER PEAK   = max mark on candidate_ticks (~2-3s cadence, the truth)
 *   MANAGER PEAK    = max mark on position_ticks (what the loop actually saw)
 *   MISSED-BY-POLL  = recorder peak >= rung AND manager peak < rung
 *   RECOVERABLE $   = for missed rungs, value of banking 40% at the rung
 *                     price vs what the position actually realized on that
 *                     slice (honest: 2-tick delay + depth slippage applied).
 * Run: npx tsx packages/db/replays/rung-miss-court.ts [hours=24]
 */
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(env)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const HOURS = Number(process.argv[2] ?? 24);
const RUNG1 = 1.15, FRAC = 0.4, FEE = 0.0025, FIX = 0.02;
const slip = (u: number, l: number) => Math.min(u / (l / 2 + u), 0.99);

(async () => {
  const q = postgres(url, { idle_timeout: 5 });
  const rows = (await q`
    SELECT p.id, p.mint, p.size_usd::float sz, p.entry_price_usd::float e, p.opened_at o,
      p.realized_pnl_usd::float actual, p.exit_reason,
      (SELECT max(mark_multiple::float) FROM position_ticks WHERE position_id=p.id) mgr_peak,
      (SELECT count(*) FROM fills f WHERE f.position_id=p.id AND f.side='sell' AND f.reason LIKE 'take_profit%') tp_fills,
      (SELECT count(*) FROM position_ticks WHERE position_id=p.id) mgr_ticks
    FROM positions p WHERE p.lane='paper' AND p.status='closed'
      AND p.closed_at > now() - make_interval(hours => ${HOURS}) AND p.entry_price_usd::float>0`) as unknown as
    { id: number; mint: string; sz: number; e: number; o: Date; actual: number; exit_reason: string;
      mgr_peak: number | null; tp_fills: number; mgr_ticks: number }[];

  let reached = 0, banked = 0, missedByPoll = 0, missedSeen = 0, recoverable = 0, noMgrTicks = 0;
  const specimens: string[] = [];
  for (const p of rows) {
    const ticks = (await q`SELECT extract(epoch from snapped_at)*1000 t, price_usd::float px, liquidity_usd::float liq
      FROM candidate_ticks WHERE mint=${p.mint} AND snapped_at BETWEEN ${p.o} AND ${p.o}::timestamptz + interval '4 hours'
      ORDER BY snapped_at`) as unknown as { t: number; px: number; liq: number }[];
    if (ticks.length < 3) continue;
    const recPeak = Math.max(...ticks.map((x) => x.px)) / p.e;
    if (recPeak < RUNG1) continue;
    reached++;
    if (p.tp_fills > 0) { banked++; continue; }
    if (!p.mgr_ticks) { noMgrTicks++; }
    const mgrPeak = Number(p.mgr_peak ?? 0);
    const seenButNotBanked = mgrPeak >= RUNG1;
    if (seenButNotBanked) missedSeen++; else missedByPoll++;
    // recoverable: bank FRAC at the first tick crossing the rung (2-tick delay)
    const idx = ticks.findIndex((x) => x.px / p.e >= RUNG1);
    const fill = ticks[Math.min(idx + 2, ticks.length - 1)]!;
    if (fill.liq >= 1200) {
      const nt = p.sz * FRAC * (fill.px / p.e);
      const proceeds = nt * (1 - slip(nt, fill.liq)) * (1 - FEE) - FIX;
      const actualOnSlice = p.actual * FRAC; // that slice's share of what really happened
      recoverable += (proceeds - p.sz * FRAC) - actualOnSlice;
    }
    if (specimens.length < 6)
      specimens.push(`#${p.id} recPeak ${recPeak.toFixed(2)}x · mgrPeak ${mgrPeak.toFixed(2)}x · mgrTicks ${p.mgr_ticks} · exit ${p.exit_reason} · actual $${p.actual.toFixed(2)}`);
  }
  const pct = (a: number, b: number) => (b > 0 ? Math.round((100 * a) / b) + "%" : "—");
  console.log(`RUNG-MISS COURT — ${HOURS}h, ${rows.length} closed positions\n`);
  console.log(`reached rung1 (recorder truth)   ${reached}`);
  console.log(`  banked a TP fill               ${banked}  (${pct(banked, reached)})`);
  console.log(`  MISSED — loop never saw ≥1.15x ${missedByPoll}  (${pct(missedByPoll, reached)})  ← poll granularity`);
  console.log(`  MISSED — loop SAW it, no bank  ${missedSeen}  (${pct(missedSeen, reached)})  ← decision/exec defect`);
  console.log(`  positions with ZERO mgr ticks  ${noMgrTicks}`);
  console.log(`\nRECOVERABLE (bank 40% at first rung touch, honest fill): $${recoverable.toFixed(2)}`);
  console.log("\nspecimens:"); for (const s of specimens) console.log("  " + s);
  await q.end();
})();
