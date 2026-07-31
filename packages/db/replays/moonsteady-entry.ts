// MOON_STEADY ENTRY HARNESS (operator 2026-07-31: "Harness MOON_STEADY entry
// selection").
//
// WHY: the 3-hour dissection cleared the management system — capture 71.4%,
// giveaways 13%, every mechanic engaging — and left exactly one loser.
// MOON_STEADY ran 6 trades / 3 dust rugs / −$16.71 while every other genome was
// positive (RISER core went 6-for-6). It was admitted to live on TAIL MASS
// (6,185 = 41% of the board, 53 tokens past 10x in 10d), which is real; the
// question this answers is whether its ENTRIES can be sorted before we let real
// capital take that tail. Consistent with the standing Study-3 result: this
// class's exits replay at their ceiling, its bleed is entry selection.
//
// DISCIPLINE — every feature here must be knowable AT ENTRY.
// EXCLUDED ON PURPOSE: peak_liquidity_usd, minutes_to_peak, final_multiple,
// max_drawdown_from_peak_pct. Those are measured POST-HOC, and a post-hoc
// feature that looks predictive is the look-ahead bias that already burned this
// project once (a "2% death / 90% run" cut that evaporated when re-measured at
// the trigger tick). Pool depth is taken from the tick nearest the TRIGGER, not
// from tokens.liquidity_usd, which is current.
//
// Reported per bin: n, rug%, reach-2x%, reach-5x%, and EV per $1 using the
// shipped economics (TP0 banks 40% at 1.15x, so a rug costs ~0.54 not 1.00, and
// a winner is credited the measured 71% capture of its run).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))?.[1]?.trim()
  ?? "postgres://hermes:hermes@localhost:5433/hermes";
const sql = postgres(url);

const RUG_COST = 0.54;   // 1 − (0.40 banked at 1.15x) → what a rug actually costs
const CAPTURE = 0.71;    // measured median capture, 3h dissection
const MIN_BIN = 20;      // never draw a conclusion from a thinner bin than this

interface Row {
  mint: string; rug: boolean; peak: number;
  liqGrowth: number | null; trigMult: number | null; buyShare: number | null;
  rugProb: number | null; conviction: number | null; stars: number | null;
  wh: number | null; wr: number | null; wk: number | null;
  dip: number | null; snap: number | null; snapRate: number | null;
  launch: number | null; top10: number | null; holders: number | null;
  largest: number | null; creatorHeld: number | null; entryLiq: number | null;
}

const rows = (await sql`
  SELECT c.mint,
         (c.label='rug') AS rug,
         c.peak_multiple::float AS peak,
         c.liq_growth::float AS "liqGrowth", c.trigger_multiple::float AS "trigMult",
         c.trigger_buy_share::float AS "buyShare", c.rug_prob::float AS "rugProb",
         c.conviction_score::float AS conviction, c.stars,
         c.wallet_winner_hits AS wh, c.wallet_rug_hits AS wr, c.wallet_known AS wk,
         c.dip_depth::float AS dip, c.snap_pct::float AS snap, c.snap_rate::float AS "snapRate",
         c.launch_order AS launch,
         (s.evidence->>'top10Pct')::float AS top10,
         (s.evidence->>'totalHolders')::int AS holders,
         (SELECT max((h->>'pct')::float) FROM jsonb_array_elements(s.evidence->'holdersSampled') h) AS largest,
         (SELECT max((h->>'pct')::float) FROM jsonb_array_elements(s.evidence->'holdersSampled') h
           WHERE h->>'label' = 'Creator') AS "creatorHeld",
         (SELECT t.liquidity_usd::float FROM candidate_ticks t
           WHERE t.mint = c.mint AND c.triggered_at IS NOT NULL
             AND t.snapped_at <= c.triggered_at
           ORDER BY t.snapped_at DESC LIMIT 1) AS "entryLiq"
  FROM candidate_outcomes c
  LEFT JOIN LATERAL (
    SELECT evidence FROM safety_checks sc
    WHERE sc.mint = c.mint AND sc.check_name = 'holder_concentration'
    ORDER BY sc.checked_at LIMIT 1) s ON true
  WHERE c.signature = 'MOON_STEADY'
    AND c.first_seen_at > now() - interval '10 days'
    AND c.label <> 'open'`) as unknown as Row[];

const ev = (rs: Row[]) => {
  if (!rs.length) return 0;
  let t = 0;
  for (const r of rs) {
    if (r.rug) t -= RUG_COST;
    else t += Math.max(0, (Math.min(r.peak, 50) - 1) * CAPTURE); // cap the tail so one 694x cannot carry a bin
  }
  return t / rs.length;
};
const pct = (rs: Row[], f: (r: Row) => boolean) => (rs.length ? (100 * rs.filter(f).length) / rs.length : 0);

function report(name: string, get: (r: Row) => number | null, edges: number[]) {
  const have = rows.filter((r) => get(r) != null && Number.isFinite(get(r) as number));
  if (have.length < MIN_BIN) { console.log(`\n${name}: only ${have.length} rows have this feature — SKIPPED`); return; }
  console.log(`\n${name}  (n=${have.length} of ${rows.length})`);
  console.log(`  ${"bin".padEnd(16)} ${"n".padStart(4)} ${"rug%".padStart(6)} ${"2x%".padStart(6)} ${"5x%".padStart(6)} ${"EV/$1".padStart(8)}`);
  const labels: string[] = [];
  for (let i = 0; i <= edges.length; i++) {
    const lo = i === 0 ? -Infinity : edges[i - 1]!;
    const hi = i === edges.length ? Infinity : edges[i]!;
    labels.push(i === 0 ? `< ${hi}` : i === edges.length ? `>= ${lo}` : `${lo} – ${hi}`);
    const bin = have.filter((r) => { const v = get(r) as number; return v >= lo && v < hi; });
    if (!bin.length) continue;
    const thin = bin.length < MIN_BIN ? " (thin)" : "";
    console.log(
      `  ${labels[i]!.padEnd(16)} ${String(bin.length).padStart(4)} ${pct(bin, (r) => r.rug).toFixed(0).padStart(5)}%` +
      ` ${pct(bin, (r) => r.peak >= 2).toFixed(0).padStart(5)}% ${pct(bin, (r) => r.peak >= 5).toFixed(0).padStart(5)}%` +
      ` ${ev(bin).toFixed(2).padStart(8)}${thin}`,
    );
  }
}

console.log(`MOON_STEADY ENTRY HARNESS — ${rows.length} labelled candidates, 10d`);
console.log(`baseline: rug ${pct(rows, (r) => r.rug).toFixed(0)}% · 2x ${pct(rows, (r) => r.peak >= 2).toFixed(0)}% · 5x ${pct(rows, (r) => r.peak >= 5).toFixed(0)}% · EV ${ev(rows).toFixed(2)}/$1`);
console.log(`ENTRY-KNOWABLE FEATURES ONLY — peak_liquidity/minutes_to_peak deliberately excluded`);

report("HOLDER CONCENTRATION — largest holder %", (r) => r.largest, [10, 20, 30, 50]);
report("CREATOR HOLDING %", (r) => r.creatorHeld, [5, 15, 30]);
report("TOP-10 HOLDER %", (r) => r.top10, [40, 60, 80, 95]);
report("TOTAL HOLDERS", (r) => r.holders, [50, 100, 200]);
report("INFLOW (liq growth at trigger)", (r) => r.liqGrowth, [1.2, 1.3, 1.6, 2.05]);
report("ENTRY POOL DEPTH $", (r) => r.entryLiq, [8000, 13000, 20000, 40000]);
report("TRIGGER MULTIPLE", (r) => r.trigMult, [1.3, 1.5, 1.7, 2.05]);
report("BUY SHARE AT TRIGGER", (r) => r.buyShare, [0.5, 0.55, 0.6, 0.7]);
report("RUG PROB (model)", (r) => r.rugProb, [0.15, 0.25, 0.35]);
report("STARS", (r) => r.stars, [1, 2]);
report("WALLET WINNER HITS", (r) => r.wh, [1, 2, 4]);
report("WALLET RUG HITS", (r) => r.wr, [1, 2]);
report("SNAP %", (r) => r.snap, [0.3, 0.6, 0.9]);
report("LAUNCH ORDER", (r) => r.launch, [2, 3, 6]);
await sql.end();
