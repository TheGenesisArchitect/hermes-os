/**
 * PRE-ARM QUANT — the "No Rung Hit, No Bank" problem, measured.
 *
 * Operator (2026-07-25): "No Rung Hit, No Bank and Depth Collapse is the
 * Quant Problem to solve." Positions that bank a rung are insured; positions
 * that die rungless die at full basis. This harness measures the pre-arm
 * window: how fast winners reach the first rung vs what rungless deaths look
 * like in their first 120s — the separation is the trigger.
 *
 * Run: npx tsx packages/db/replays/prearm-quant.ts [since=2026-07-15]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);
const SINCE = process.argv[2] ?? "2026-07-15";

// A: banked positions — time from open to FIRST take-profit fill.
const banked = await sql`
  SELECT extract(epoch from (min(f.filled_at) - p.opened_at)) AS sec
  FROM positions p JOIN fills f ON f.position_id = p.id AND f.side = 'sell' AND f.reason LIKE 'take_profit%'
  WHERE p.lane = 'paper' AND p.status = 'closed' AND p.opened_at >= ${SINCE}
  GROUP BY p.id, p.opened_at`;
const secs = banked.map((r) => Number(r.sec)).filter((s) => Number.isFinite(s) && s >= 0).sort((a, b) => a - b);
const q = (p: number) => secs[Math.floor(p * secs.length)] ?? NaN;
console.log(`A. BANKED positions (≥1 rung), n=${secs.length} — time to FIRST rung:`);
console.log(`   p25 ${q(0.25).toFixed(0)}s · median ${q(0.5).toFixed(0)}s · p75 ${q(0.75).toFixed(0)}s · p90 ${q(0.9).toFixed(0)}s\n`);

// B: rungless deaths — first-120s anatomy from candidate ticks.
const deaths = await sql`
  SELECT p.id, p.mint, p.opened_at, p.entry_price_usd::float AS e, p.size_usd::float AS s,
         p.realized_pnl_usd::float AS pnl
  FROM positions p
  WHERE p.lane = 'paper' AND p.status = 'closed' AND p.opened_at >= ${SINCE}
    AND p.realized_pnl_usd::float < -0.3 * p.size_usd::float
    AND NOT EXISTS (SELECT 1 FROM fills f WHERE f.position_id = p.id AND f.side = 'sell' AND f.reason LIKE 'take_profit%')`;
let checked = 0, neverLifted60 = 0, neverLifted90 = 0, depthDown90 = 0, both90 = 0;
let totalLoss = 0, saveableAt90 = 0;
for (const d of deaths) {
  const ticks = await sql`
    SELECT price_usd::float AS px, liquidity_usd::float AS liq,
           extract(epoch from (snapped_at - ${d.opened_at}::timestamptz)) AS t
    FROM candidate_ticks WHERE mint = ${d.mint}
      AND snapped_at BETWEEN ${d.opened_at} AND ${d.opened_at}::timestamptz + interval '4 minutes'
    ORDER BY snapped_at`;
  if (ticks.length < 3) continue;
  checked++;
  totalLoss += d.pnl;
  const entryLiq = ticks[0]?.liq ?? null;
  const upTo = (tMax: number) => ticks.filter((tk) => Number(tk.t) <= tMax);
  const peak60 = Math.max(...upTo(60).map((tk) => tk.px / d.e), 0);
  const w90 = upTo(90);
  const peak90 = Math.max(...w90.map((tk) => tk.px / d.e), 0);
  const last90 = w90[w90.length - 1];
  const depth90 = entryLiq && last90?.liq != null ? last90.liq / entryLiq : null;
  if (peak60 < 1.1 && peak60 > 0) neverLifted60++;
  if (peak90 < 1.1 && peak90 > 0) neverLifted90++;
  if (depth90 != null && depth90 < 0.9) depthDown90++;
  const flagged = peak90 > 0 && peak90 < 1.1 && depth90 != null && depth90 < 0.9;
  if (flagged) {
    both90++;
    // scratch value at the 90s tick: sell full at that price into that pool
    if (last90 && last90.liq >= 500) {
      const impact = Math.min(0.5, (d.s * (last90.px / d.e)) / (0.5 * last90.liq));
      const scratch = d.s * ((last90.px / d.e) * (1 - impact) * 0.98 - 1);
      saveableAt90 += scratch - d.pnl; // improvement vs what actually happened
    }
  }
}
console.log(`B. RUNGLESS DEATHS (lost >30% of basis, zero rungs), n=${checked} · total $${totalLoss.toFixed(2)}:`);
console.log(`   never lifted ≥1.10× by 60s: ${neverLifted60}/${checked} (${Math.round((100 * neverLifted60) / Math.max(1, checked))}%)`);
console.log(`   never lifted ≥1.10× by 90s: ${neverLifted90}/${checked} (${Math.round((100 * neverLifted90) / Math.max(1, checked))}%)`);
console.log(`   pool depth <90% of entry by 90s: ${depthDown90}/${checked}`);
console.log(`   BOTH (flat AND draining at 90s): ${both90}/${checked}`);
console.log(`   simulated scratch-at-90s on the BOTH cohort: +$${saveableAt90.toFixed(2)} vs booked\n`);

// C: the false-positive cost — banked winners that were ALSO flat at 90s.
const winners = await sql`
  SELECT p.id, p.mint, p.opened_at, p.entry_price_usd::float AS e, p.realized_pnl_usd::float AS pnl
  FROM positions p
  WHERE p.lane = 'paper' AND p.status = 'closed' AND p.opened_at >= ${SINCE}
    AND p.realized_pnl_usd::float > 0.5
    AND EXISTS (SELECT 1 FROM fills f WHERE f.position_id = p.id AND f.side = 'sell' AND f.reason LIKE 'take_profit%')
  ORDER BY p.realized_pnl_usd::float DESC LIMIT 200`;
let wChecked = 0, wFlagged = 0, wFlaggedPnl = 0;
for (const w of winners) {
  const ticks = await sql`
    SELECT price_usd::float AS px, liquidity_usd::float AS liq,
           extract(epoch from (snapped_at - ${w.opened_at}::timestamptz)) AS t
    FROM candidate_ticks WHERE mint = ${w.mint}
      AND snapped_at BETWEEN ${w.opened_at} AND ${w.opened_at}::timestamptz + interval '100 seconds'
    ORDER BY snapped_at`;
  if (ticks.length < 3) continue;
  wChecked++;
  const entryLiq = ticks[0]?.liq ?? null;
  const peak90 = Math.max(...ticks.filter((tk) => Number(tk.t) <= 90).map((tk) => tk.px / w.e), 0);
  const l = ticks.filter((tk) => Number(tk.t) <= 90).pop();
  const depth90 = entryLiq && l?.liq != null ? l.liq / entryLiq : null;
  if (peak90 > 0 && peak90 < 1.1 && depth90 != null && depth90 < 0.9) { wFlagged++; wFlaggedPnl += w.pnl; }
}
console.log(`C. FALSE-POSITIVE COST — winners (top 200) flat AND draining at 90s: ${wFlagged}/${wChecked} · their booked profit $${wFlaggedPnl.toFixed(2)} would have been scratched`);
await sql.end();
