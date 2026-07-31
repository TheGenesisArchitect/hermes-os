/**
 * DECISION-TIMING DECOMPOSITION — where in the tape's trajectory does the exit
 * actually fire, and what multiple do we realise?
 *
 * PURPOSE
 *   The live-receipt replay put the leak at decision timing (A→B −$6,588) not
 *   execution (B→C −$38). This locates the decision in the trajectory:
 *   did we cut BEFORE the tape peaked, or ride DOWN after it?
 *
 *   It also tests the operator's observation directly: "we are filling every
 *   trade in a dud zone before it ever qualifies as a good or strong band" —
 *   i.e. realised exit multiples cluster below the 1.25× we require to ENTER.
 *
 * GROUND TRUTH
 *   Live receipts only. Real fills, real tape. No paper marks.
 *
 * OWNER  Execution + Portfolio Intelligence (shared genome)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))?.[1]?.trim()
  ?? "postgres://hermes:hermes@localhost:5433/hermes";
const sql = postgres(url);
const DAYS = Number(process.argv[2] ?? 10);
const LANE = process.argv[3] ?? "live";

interface Pos {
  id: number; mint: string; symbol: string | null; exit_reason: string | null;
  size: number; entry: number; opened_at: Date; closed_at: Date; pnl: number;
}
const positions = (await sql`
  SELECT p.id, p.mint, t.symbol, p.exit_reason, p.size_usd::float AS size,
         p.entry_price_usd::float AS entry, p.opened_at, p.closed_at,
         p.realized_pnl_usd::float AS pnl
  FROM positions p LEFT JOIN tokens t ON t.mint=p.mint
  WHERE p.lane=${LANE} AND p.status='closed'
    AND p.closed_at > now() - ${`${DAYS} days`}::interval
    AND p.entry_price_usd::float > 0
  ORDER BY p.closed_at DESC`) as unknown as Pos[];

interface Row {
  id: number; reason: string; offered: number; filled: number;
  exitFrac: number;      // where in the hold the exit fired, 0..1
  peakFrac: number;      // where in the hold the tape peaked, 0..1
  cutEarly: boolean;     // exit fired BEFORE the tape's peak
  afterPeak: number;     // tape's best AFTER we exited, as a multiple
  size: number; pnl: number;
}
const rows: Row[] = [];

for (const p of positions) {
  const ticks = (await sql`
    SELECT price_usd::float AS px, extract(epoch from (snapped_at - ${p.opened_at}::timestamptz)) AS t
    FROM candidate_ticks WHERE mint=${p.mint}
      AND snapped_at BETWEEN ${p.opened_at}::timestamptz
        AND ${p.closed_at}::timestamptz + interval '10 minutes'
    ORDER BY snapped_at`) as unknown as { px: number; t: number }[];
  if (ticks.length < 4) continue;

  const holdS = (new Date(p.closed_at).getTime() - new Date(p.opened_at).getTime()) / 1000;
  if (holdS <= 0) continue;
  const during = ticks.filter((k) => Number(k.t) <= holdS);
  const after = ticks.filter((k) => Number(k.t) > holdS);
  if (during.length < 2) continue;

  const fills = (await sql`
    SELECT qty_tokens::float AS q, price_usd::float AS px FROM fills
    WHERE position_id=${p.id} AND side='sell'`) as unknown as { q: number; px: number }[];
  if (!fills.length) continue;
  const qty = fills.reduce((s, f) => s + Number(f.q), 0);
  const filled = qty > 0 ? fills.reduce((s, f) => s + Number(f.q) * Number(f.px), 0) / qty / p.entry : 0;

  let bestPx = -Infinity, bestT = 0;
  for (const k of during) if (Number(k.px) > bestPx) { bestPx = Number(k.px); bestT = Number(k.t); }
  const offered = bestPx / p.entry;
  const afterBest = after.length ? Math.max(...after.map((k) => Number(k.px))) / p.entry : 0;

  rows.push({
    id: p.id, reason: p.exit_reason ?? "?", offered, filled,
    exitFrac: 1, peakFrac: Math.min(1, bestT / holdS),
    cutEarly: bestT >= holdS * 0.92,   // tape still climbing as we closed
    afterPeak: afterBest, size: p.size, pnl: p.pnl,
  });
}

const med = (xs: number[]) => { if (!xs.length) return NaN; const s=[...xs].sort((a,b)=>a-b); return s[Math.floor(s.length/2)]!; };
const pct = (a: number, b: number) => (b ? (100*a/b).toFixed(0) : "—");

console.log(`\n${"=".repeat(94)}`);
console.log(`DECISION-TIMING DECOMPOSITION — ${LANE} · ${DAYS}d · ${rows.length} positions with tape + receipts`);
console.log(`${"=".repeat(94)}`);

// ── THE OPERATOR'S POINT: what multiple do we actually realise? ──────────────
const BANDS: [string, number, number][] = [
  ["a  < 0.55  (through the floor)", -Infinity, 0.55],
  ["b  0.55 – 1.00 (loss)", 0.55, 1.0],
  ["c  1.00 – 1.25 (DUD ZONE)", 1.0, 1.25],
  ["d  1.25 – 1.60 (good band)", 1.25, 1.6],
  ["e  1.60 – 2.00 (strong)", 1.6, 2.0],
  ["f  >= 2.00", 2.0, Infinity],
];
console.log(`\nREALISED EXIT MULTIPLE — where our fills actually land`);
console.log(`  ${"band".padEnd(32)} ${"n".padStart(4)} ${"share".padStart(6)} ${"med offered".padStart(12)} ${"P&L".padStart(9)}`);
for (const [label, lo, hi] of BANDS) {
  const b = rows.filter((r) => r.filled >= lo && r.filled < hi);
  if (!b.length) continue;
  console.log(
    `  ${label.padEnd(32)} ${String(b.length).padStart(4)} ${(pct(b.length, rows.length)+"%").padStart(6)}` +
    ` ${med(b.map((r)=>r.offered)).toFixed(2).padStart(12)} ${b.reduce((s,r)=>s+r.pnl,0).toFixed(2).padStart(9)}`,
  );
}
const belowGood = rows.filter((r) => r.filled < 1.25).length;
console.log(`\n  >>> ${belowGood} of ${rows.length} (${pct(belowGood, rows.length)}%) fill BELOW 1.25 — the bar we require to ENTER.`);

// ── WHERE IN THE TRAJECTORY DID THE EXIT FIRE? ──────────────────────────────
console.log(`\nEXIT POSITION IN THE TRAJECTORY`);
const cutEarly = rows.filter((r) => r.cutEarly);
const rodeDown = rows.filter((r) => !r.cutEarly);
console.log(`  tape STILL CLIMBING when we closed   ${String(cutEarly.length).padStart(4)}  (${pct(cutEarly.length, rows.length)}%)  med offered ${med(cutEarly.map(r=>r.offered)).toFixed(2)}  med filled ${med(cutEarly.map(r=>r.filled)).toFixed(2)}`);
console.log(`  tape ALREADY PEAKED, we rode down    ${String(rodeDown.length).padStart(4)}  (${pct(rodeDown.length, rows.length)}%)  med offered ${med(rodeDown.map(r=>r.offered)).toFixed(2)}  med filled ${med(rodeDown.map(r=>r.filled)).toFixed(2)}`);
console.log(`  median peak position in hold: ${(med(rows.map(r=>r.peakFrac))*100).toFixed(0)}% of the way through`);

const ranAfter = rows.filter((r) => r.afterPeak > r.filled * 1.25);
console.log(`\n  positions where the tape ran >=25% HIGHER within 10min of our exit: ${ranAfter.length} of ${rows.length} (${pct(ranAfter.length, rows.length)}%)`);
console.log(`  median post-exit best on those: ${med(ranAfter.map(r=>r.afterPeak)).toFixed(2)}x vs our fill ${med(ranAfter.map(r=>r.filled)).toFixed(2)}x`);

// ── BY RULE: which one is cutting in the dud zone? ──────────────────────────
console.log(`\nBY EXIT RULE`);
console.log(`  ${"rule".padEnd(20)} ${"n".padStart(4)} ${"med offered".padStart(11)} ${"med filled".padStart(10)} ${"capture".padStart(8)} ${"%<1.25".padStart(7)} ${"P&L".padStart(9)}`);
const byRule = new Map<string, Row[]>();
for (const r of rows) byRule.set(r.reason, [...(byRule.get(r.reason) ?? []), r]);
for (const [rule, rs] of [...byRule.entries()].sort((a,b)=>b[1].length-a[1].length)) {
  if (rs.length < 3) continue;
  const mo = med(rs.map(r=>r.offered)), mf = med(rs.map(r=>r.filled));
  console.log(
    `  ${rule.slice(0,20).padEnd(20)} ${String(rs.length).padStart(4)} ${mo.toFixed(2).padStart(11)} ${mf.toFixed(2).padStart(10)}` +
    ` ${((mo>1?(mf-1)/(mo-1)*100:0)).toFixed(0).padStart(7)}% ${(pct(rs.filter(r=>r.filled<1.25).length, rs.length)+"%").padStart(7)}` +
    ` ${rs.reduce((s,r)=>s+r.pnl,0).toFixed(2).padStart(9)}`,
  );
}
await sql.end();
