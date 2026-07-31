// THE OWNERSHIP HARNESS (operator 2026-07-31: "Run the ownership harness").
//
// The moon sweep said a 0.70 pool band is worth $7,855 on the same cohort that
// actually BOOKED $795. That gap is not the band — it is OWNERSHIP. In
// production floor_45 / hard_stop / basis_first / dust_rug fire at ~1.8 min and
// close the position before any pool rule becomes the binding decision. Capture
// is set by whichever exit fires FIRST.
//
// This harness prices that directly. Rather than reimplement every rule (and
// inherit my own bugs), it uses each position's REAL exit — the actual time and
// the actual multiple it closed at — and asks what the pool rule would have done
// with the position from that moment on.
//
//   A  booked                    what the stack actually did
//   B  pool rule OWNS everything floor + 0.70 band only, from entry (the ceiling)
//   C(X) GRADUATED OWNERSHIP     the existing stack owns the position while it is
//        unproven; once it prints X×, the pool rule takes over exclusively and
//        nothing else may close it. "Manage the floor, catch the moons."
//
// The −45% floor ALWAYS owns, in every policy. It is never suppressed.
// Deaths stay in the cohort. 0.95 fill haircut. Same constants as moon-sweep.ts
// so the numbers are directly comparable.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))?.[1]?.trim()
  ?? "postgres://hermes:hermes@localhost:5433/hermes";
const sql = postgres(url);

const FILL = 0.95;
const FLOOR = 0.55;            // the −45% standard, never suppressed
const BAND = 0.70;             // the swept optimum
const HORIZON = 120;           // minutes
const PROOFS = [1.2, 1.5, 2.0, 3.0];

const cohort = await sql`
  SELECT p.id, p.mint, p.signature, p.size_usd::float sz, p.realized_pnl_usd::float booked,
         p.entry_price_usd::float entry, p.exit_price_usd::float exitpx, p.opened_at,
         p.exit_reason, extract(epoch from (p.closed_at - p.opened_at))/60 AS held_min
  FROM positions p
  WHERE p.lane='paper' AND p.status='closed'
    AND p.closed_at > now() - interval '10 days'
    AND p.entry_price_usd::float > 0 AND p.signature IS NOT NULL
  ORDER BY p.closed_at DESC`;

type Row = { m: number; l: number; t: number };

/** Pool rule owns from the first tick: floor, then the band. */
function ownedFromEntry(rows: Row[], sz: number): number {
  let poolPeak = 0;
  for (const r of rows) {
    poolPeak = Math.max(poolPeak, r.l);
    if (r.m <= FLOOR) return sz * (r.m * FILL - 1);
    if (poolPeak > 0 && r.l <= poolPeak * BAND) return sz * (r.m * FILL - 1);
  }
  const last = rows[rows.length - 1];
  return last ? sz * (last.m * FILL - 1) : 0;
}

/** The real stack owns the position until it prints `proof`; then the pool rule
 *  takes over and nothing else may close it. The floor owns throughout. */
// `booked` is the position's REAL realized P&L and already carries its real
// slippage. When the existing stack owns the exit we must return it verbatim —
// recomputing it from a mark with the FILL haircut would charge slippage twice
// on the ~55% of the cohort that never graduates, which is a systematic ~$2k
// drag that swamps the very comparison this policy exists to make.
function graduated(rows: Row[], sz: number, proof: number, heldMin: number, booked: number): number {
  let poolPeak = 0;
  let proven = false;
  for (const r of rows) {
    poolPeak = Math.max(poolPeak, r.l);
    if (r.m <= FLOOR) return sz * (r.m * FILL - 1);          // floor always owns
    if (r.m >= proof) proven = true;
    if (!proven && r.t >= heldMin) return booked;             // the real stack fired — take it as booked
    if (proven && poolPeak > 0 && r.l <= poolPeak * BAND) return sz * (r.m * FILL - 1);
  }
  const last = rows[rows.length - 1];
  if (!proven) return booked;
  return last ? sz * (last.m * FILL - 1) : 0;
}

const totals = new Map<string, number>();
const add = (k: string, v: number) => totals.set(k, (totals.get(k) ?? 0) + v);
// Per-exit-reason ledger: what did each competing rule COST vs full pool ownership?
const ledger = new Map<string, { n: number; booked: number; owned: number }>();
let n = 0, deaths = 0, graduatedCount = 0;

for (const p of cohort) {
  const ticks = await sql`
    SELECT price_usd::float px, liquidity_usd::float liq,
           extract(epoch from (snapped_at - ${p.opened_at}::timestamptz))/60 AS t
    FROM candidate_ticks
    WHERE mint=${p.mint} AND snapped_at BETWEEN ${p.opened_at}::timestamptz
      AND ${p.opened_at}::timestamptz + ${`${HORIZON} minutes`}::interval
    ORDER BY snapped_at`;
  const rows: Row[] = ticks
    .map((k) => ({ m: Number(k.px) / Number(p.entry), l: Number(k.liq), t: Number(k.t) }))
    .filter((k) => Number.isFinite(k.m) && k.m > 0 && Number.isFinite(k.l) && k.l > 0 && k.t >= 0);
  if (rows.length < 5) continue;
  n++;
  if (p.exit_reason === "dust_rug") deaths++;

  // realExitMark retained for reference only; the graduated policy uses booked directly.
  const heldMin = Number(p.held_min) || 0;
  const owned = ownedFromEntry(rows, Number(p.sz));

  add("A  booked (actual stack)", Number(p.booked));
  add(`B  pool rule owns from entry (band ${BAND})`, owned);
  for (const proof of PROOFS) {
    add(`C  graduated ownership above ${proof.toFixed(1)}x`, graduated(rows, Number(p.sz), proof, heldMin, Number(p.booked)));
  }
  if (Math.max(...rows.map((r) => r.m)) >= 2.0) graduatedCount++;

  const reason = p.exit_reason ?? "(none)";
  const e = ledger.get(reason) ?? { n: 0, booked: 0, owned: 0 };
  e.n++; e.booked += Number(p.booked); e.owned += owned;
  ledger.set(reason, e);
}

console.log(`OWNERSHIP HARNESS — ${n} paper positions, 10d, all genomes (${deaths} dust deaths included)`);
console.log(`floor ${FLOOR} always owns · band ${BAND} · ${HORIZON}m horizon · ${FILL} fill\n`);
for (const [k, v] of [...totals.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(46)} $${v.toFixed(2).padStart(10)}`);
}

console.log(`\nWHAT EACH COMPETING EXIT COSTS (booked vs pool-rule ownership)`);
console.log(`  ${"exit_reason".padEnd(22)} ${"n".padStart(5)} ${"booked".padStart(10)} ${"if owned".padStart(11)} ${"cost".padStart(10)}`);
const rank = [...ledger.entries()].sort((a, b) => (a[1].booked - a[1].owned) - (b[1].booked - b[1].owned));
for (const [reason, e] of rank) {
  const cost = e.booked - e.owned;
  console.log(`  ${reason.padEnd(22)} ${String(e.n).padStart(5)} ${e.booked.toFixed(2).padStart(10)} ${e.owned.toFixed(2).padStart(11)} ${cost.toFixed(2).padStart(10)}`);
}
console.log(`\n  (${graduatedCount} of ${n} positions ever printed 2x — the population graduation can reach)`);
await sql.end();
