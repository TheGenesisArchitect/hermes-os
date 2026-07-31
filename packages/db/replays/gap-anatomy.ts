// GAP ANATOMY (operator 2026-07-31: "how do we close that gap?").
//
// Chiikawa armed its floor at 0.75x and FILLED at 0.36x. The rule fired
// correctly and the price went through it. Before proposing a fix we have to
// know which kind of gap this is, because the two have opposite remedies:
//
//   SURVIVABLE — price walked down across several ticks and our poll cadence /
//     build+land latency lost the race. Remedy is SPEED: event-driven triggers
//     off the ws pool watcher and the pre-signed durable-nonce exit, which
//     collapses detect->fill to one sendRawTransaction.
//
//   ATOMIC — price went from above the floor to dust between two ADJACENT
//     observations, i.e. one transaction removed the liquidity. No execution
//     speed we can buy beats this; there is no price to sell into. Remedy is
//     SELECTION and PRE-POSITIONING, never latency.
//
// Method: for every position whose floor was breached, find the last tick at or
// above the arm level and the first tick at or below the standard, and measure
// the seconds and the drop between them. Also report the observation cadence, so
// "1 tick apart" can be read against how often we actually see the tape.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))?.[1]?.trim()
  ?? "postgres://hermes:hermes@localhost:5433/hermes";
const sql = postgres(url);

const ARM = 0.75;      // STANDARD_FLOOR_ARM_MULT — where the floor decides
const STANDARD = 0.55; // the -45% standard — where we intend to be out
const HORIZON = 120;

const cohort = await sql`
  SELECT p.id, p.mint, p.signature, p.entry_price_usd::float entry, p.opened_at,
         p.exit_price_usd::float bexit, p.exit_reason, p.realized_pnl_usd::float booked
  FROM positions p
  WHERE p.lane='paper' AND p.status='closed'
    AND p.closed_at > now() - interval '10 days'
    AND p.entry_price_usd::float > 0
    AND p.exit_price_usd::float > 0
    AND p.exit_price_usd::float / p.entry_price_usd::float < ${STANDARD}
  ORDER BY p.closed_at DESC`;

console.log(`GAP ANATOMY — ${cohort.length} positions that exited BELOW the -45% standard (10d paper)\n`);

let atomic = 0, survivable = 0, noData = 0;
const dropSecs: number[] = [];
const cadences: number[] = [];
let worstDrop = { id: 0, from: 0, to: 0, secs: 0, sig: "" };

for (const p of cohort) {
  const ticks = await sql`
    SELECT price_usd::float px, extract(epoch from (snapped_at - ${p.opened_at}::timestamptz)) AS t
    FROM candidate_ticks
    WHERE mint=${p.mint} AND snapped_at BETWEEN ${p.opened_at}::timestamptz
      AND ${p.opened_at}::timestamptz + ${`${HORIZON} minutes`}::interval
    ORDER BY snapped_at`;
  const rows = ticks
    .map((k) => ({ m: Number(k.px) / Number(p.entry), t: Number(k.t) }))
    .filter((k) => Number.isFinite(k.m) && k.m > 0);
  if (rows.length < 3) { noData++; continue; }
  for (let i = 1; i < rows.length; i++) cadences.push(rows[i]!.t - rows[i - 1]!.t);

  // first crossing of the standard, and the last observation at/above the arm
  let breachIdx = -1;
  for (let i = 0; i < rows.length; i++) if (rows[i]!.m <= STANDARD) { breachIdx = i; break; }
  if (breachIdx <= 0) { noData++; continue; }
  let lastAboveArm = -1;
  for (let i = breachIdx - 1; i >= 0; i--) if (rows[i]!.m >= ARM) { lastAboveArm = i; break; }
  if (lastAboveArm < 0) { noData++; continue; }

  const secs = rows[breachIdx]!.t - rows[lastAboveArm]!.t;
  const hops = breachIdx - lastAboveArm;
  dropSecs.push(secs);
  // ATOMIC = one hop from above-arm straight through the standard: we never had
  // an observation in between to act on, at any latency.
  if (hops === 1) {
    atomic++;
    const drop = rows[lastAboveArm]!.m - rows[breachIdx]!.m;
    if (drop > worstDrop.from - worstDrop.to) {
      worstDrop = { id: p.id, from: rows[lastAboveArm]!.m, to: rows[breachIdx]!.m, secs, sig: p.signature ?? "(none)" };
    }
  } else survivable++;
}

const pct = (x: number, d: number) => d ? `${(100 * x / d).toFixed(1)}%` : "—";
const med = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
const classified = atomic + survivable;

console.log(`  observation cadence      median ${med(cadences).toFixed(1)}s`);
console.log(`  classified               ${classified}   (no usable tick window: ${noData})\n`);
console.log(`  ATOMIC      ${String(atomic).padStart(4)}  ${pct(atomic, classified).padStart(6)}   one hop from >=${ARM}x through <=${STANDARD}x`);
console.log(`      -> no execution speed beats this. Remedy is SELECTION + PRE-POSITIONING.`);
console.log(`  SURVIVABLE  ${String(survivable).padStart(4)}  ${pct(survivable, classified).padStart(6)}   walked down over >1 observation`);
console.log(`      -> remedy is SPEED: ws-event trigger + pre-signed durable-nonce exit.`);
console.log(`\n  median seconds from last >=${ARM}x observation to the breach: ${med(dropSecs).toFixed(1)}s`);
if (worstDrop.id) console.log(`  worst single-hop: pos ${worstDrop.id} (${worstDrop.sig}) ${worstDrop.from.toFixed(2)}x -> ${worstDrop.to.toFixed(2)}x in ${worstDrop.secs.toFixed(0)}s`);
await sql.end();
