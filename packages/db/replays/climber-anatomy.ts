/**
 * CLIMBER ANATOMY — why does a 100%-win/0%-rug class book a negative P&L?
 *
 * Born 2026-07-24 (signature console): CLIMBER candidates label ~100% winners
 * with a 3.33× avg offer, yet the book ran 12/28 at −$9.11. The label wins on
 * PEAK-vs-ref; our positions win on exit-vs-entry. This harness measures the
 * geometry between the two: where in the climb we enter, what the position
 * sees AFTER entry, and which exits actually fire against tp0=1.40 /
 * trail 0.25 / floor 0.4.
 *
 * Run: npx tsx packages/db/replays/climber-anatomy.ts [windowHours=216]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const envf = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(envf)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const sql = postgres(url);
const HOURS = Number(process.argv[2] ?? 216);

const rows = await sql`
  SELECT p.id, p.opened_at, p.closed_at, p.exit_reason,
         p.size_usd::float AS size_usd, p.realized_pnl_usd::float AS pnl,
         p.entry_price_usd::float AS entry_px, p.peak_price_usd::float AS peak_px,
         p.trigger_mult::float AS trig_mult,
         c.peak_multiple::float AS cand_peak, c.trigger_multiple::float AS cand_trig,
         c.minutes_to_peak::float AS min_to_peak, c.first_seen_at,
         (SELECT count(*) FROM fills f WHERE f.position_id = p.id AND f.side = 'sell' AND f.reason LIKE 'take_profit%')::int AS rungs
  FROM positions p JOIN candidate_outcomes c ON c.mint = p.mint
  WHERE p.signature = 'CLIMBER' AND p.lane = 'paper' AND p.closed_at IS NOT NULL
    AND p.opened_at > now() - interval '1 hour' * ${HOURS}
  ORDER BY p.opened_at`;

const n = rows.length;
if (!n) { console.log("no closed CLIMBER positions in window"); await sql.end(); process.exit(0); }
const posPeak = (r: any) => (r.peak_px && r.entry_px ? r.peak_px / r.entry_px : null);
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

// 1. Where in the climb do we sit? Candidate peak still ahead of entry or behind?
const entryVsPeak = rows.map((r) => {
  const entryMin = (new Date(r.opened_at).getTime() - new Date(r.first_seen_at).getTime()) / 60000;
  return { late: r.min_to_peak != null && entryMin > r.min_to_peak, entryMin };
});
const lateN = entryVsPeak.filter((x) => x.late).length;

// 2. What the position saw after entry.
const peaks = rows.map(posPeak).filter((x): x is number => x != null && Number.isFinite(x));
const reachedTp0 = peaks.filter((x) => x >= 1.4).length;
const reached122 = peaks.filter((x) => x >= 1.22).length;
const neverMoved = peaks.filter((x) => x < 1.1).length;

// 3. Exit reasons × P&L.
const byExit = new Map<string, { n: number; pnl: number }>();
for (const r of rows) {
  const k = r.exit_reason ?? "?";
  const e = byExit.get(k) ?? { n: 0, pnl: 0 };
  e.n++; e.pnl += r.pnl ?? 0;
  byExit.set(k, e);
}

console.log(`CLIMBER closed paper positions, last ${Math.round(HOURS / 24)}d: n=${n}, total $${rows.reduce((s, r) => s + (r.pnl ?? 0), 0).toFixed(2)}`);
console.log(`\n1. ENTRY TIMING vs the candidate's peak:`);
console.log(`   entered AFTER the candidate had already peaked: ${lateN}/${n} (${Math.round((100 * lateN) / n)}%)`);
console.log(`   median entry at ${med(entryVsPeak.map((x) => x.entryMin)).toFixed(1)}min from first-seen; median candidate time-to-peak ${med(rows.map((r) => r.min_to_peak).filter((x: any) => x != null)).toFixed(1)}min`);
console.log(`\n2. POSITION-RELATIVE RUN (peak from OUR entry):`);
console.log(`   median position peak ${med(peaks).toFixed(2)}×  ·  reached tp0 1.40×: ${reachedTp0}/${n}  ·  would reach a 1.22 rung: ${reached122}/${n}  ·  never moved (<1.10×): ${neverMoved}/${n}`);
console.log(`\n3. EXITS:`);
for (const [k, v] of [...byExit.entries()].sort((a, b) => a[1].pnl - b[1].pnl))
  console.log(`   ${k.padEnd(18)} n=${String(v.n).padStart(3)}  $${v.pnl.toFixed(2)}`);
console.log(`\n4. RUNGS BANKED: ${rows.filter((r) => r.rungs > 0).length}/${n} positions banked ≥1 rung (genome tp0 sits at 1.40×)`);
await sql.end();
