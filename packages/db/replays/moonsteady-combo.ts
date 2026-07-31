// MOON_STEADY ENTRY — COMBINATION TEST.
//
// The single-feature harness found THREE entry-knowable features that improve
// rug rate AND EV together (everything else trades one for the other):
//     inflow >= 1.30   rug 11% (vs 27% base) · EV 5.31
//     trigger >= 1.70  rug 12%              · EV 5.51
//     snap >= 0.90     rug 18%              · EV 5.18
// The question a single-feature table cannot answer is whether those are three
// signals or one signal counted three times. This runs every combination and
// reports TOTAL EV RETAINED (n x EV) beside per-trade EV, because a filter that
// doubles quality while keeping nine candidates is worse than one that lifts it
// slightly across two hundred — and per-trade EV alone hides that completely.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))?.[1]?.trim()
  ?? "postgres://hermes:hermes@localhost:5433/hermes";
const sql = postgres(url);

const RUG_COST = 0.54, CAPTURE = 0.71, CAP_TAIL = 50;

interface R { rug: boolean; peak: number; lg: number | null; tm: number | null; sn: number | null }
const rows = (await sql`
  SELECT (label='rug') AS rug, peak_multiple::float AS peak,
         liq_growth::float AS lg, trigger_multiple::float AS tm, snap_pct::float AS sn
  FROM candidate_outcomes
  WHERE signature='MOON_STEADY' AND first_seen_at > now() - interval '10 days' AND label <> 'open'`) as unknown as R[];

const ev = (rs: R[]) => rs.length
  ? rs.reduce((t, r) => t + (r.rug ? -RUG_COST : Math.max(0, (Math.min(r.peak, CAP_TAIL) - 1) * CAPTURE)), 0) / rs.length
  : 0;
const p = (rs: R[], f: (r: R) => boolean) => (rs.length ? (100 * rs.filter(f).length) / rs.length : 0);

const F = {
  "inflow>=1.30": (r: R) => r.lg != null && r.lg >= 1.30,
  "trigger>=1.70": (r: R) => r.tm != null && r.tm >= 1.70,
  "snap>=0.90": (r: R) => r.sn != null && r.sn >= 0.90,
};
type Key = keyof typeof F;
const keys = Object.keys(F) as Key[];
const combos: Key[][] = [[], ...keys.map((k) => [k]),
  [keys[0]!, keys[1]!], [keys[0]!, keys[2]!], [keys[1]!, keys[2]!], [keys[0]!, keys[1]!, keys[2]!]];

const baseTotal = ev(rows) * rows.length;
console.log(`MOON_STEADY COMBINATION TEST — ${rows.length} labelled candidates, 10d`);
console.log(`total EV in the whole cohort: ${baseTotal.toFixed(0)} — a filter must RETAIN this, not just raise the average\n`);
console.log(`  ${"filter".padEnd(42)} ${"kept".padStart(5)} ${"keep%".padStart(6)} ${"rug%".padStart(6)} ${"2x%".padStart(5)} ${"5x%".padStart(5)} ${"EV/$1".padStart(7)} ${"TOTAL EV".padStart(9)}`);
for (const combo of combos) {
  const kept = rows.filter((r) => combo.every((k) => F[k](r)));
  const label = combo.length ? combo.join(" AND ") : "(no filter — baseline)";
  const total = ev(kept) * kept.length;
  console.log(
    `  ${label.padEnd(42)} ${String(kept.length).padStart(5)} ${p(rows, (r) => combo.every((k) => F[k](r))).toFixed(0).padStart(5)}%` +
    ` ${p(kept, (r) => r.rug).toFixed(0).padStart(5)}% ${p(kept, (r) => r.peak >= 2).toFixed(0).padStart(4)}%` +
    ` ${p(kept, (r) => r.peak >= 5).toFixed(0).padStart(4)}% ${ev(kept).toFixed(2).padStart(7)} ${total.toFixed(0).padStart(9)}`,
  );
}

// Overlap — are these three signals, or one counted three times?
console.log(`\nOVERLAP (are they independent?)`);
for (let i = 0; i < keys.length; i++) {
  for (let j = i + 1; j < keys.length; j++) {
    const a = rows.filter(F[keys[i]!]), both = a.filter(F[keys[j]!]);
    console.log(`  ${keys[i]!} -> ${keys[j]!}: ${(100 * both.length / Math.max(a.length, 1)).toFixed(0)}% of the first also pass the second (base rate ${p(rows, F[keys[j]!]).toFixed(0)}%)`);
  }
}

// What the REFUSED set costs — the number that decides whether to gate at all.
console.log(`\nWHAT EACH FILTER THROWS AWAY`);
for (const k of keys) {
  const out = rows.filter((r) => !F[k](r));
  console.log(`  refusing ${k.padEnd(16)} drops ${String(out.length).padStart(3)} candidates · ${out.filter((r) => r.peak >= 5).length} of them reached 5x · EV left on the table ${(ev(out) * out.length).toFixed(0)}`);
}
await sql.end();
