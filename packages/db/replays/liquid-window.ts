// THE LIQUID WINDOW REPLAY (operator 2026-07-30: "Every trade is liquid until
// it isn't and that's where the Opportunities Live"). The trail releases on
// PRICE retracement; 79% of its exits ran higher afterwards, averaging 5.20x
// our exit, $18,303 left on the table in 10d across MOON_STEADY/SLOW/RISER.
// Question: does releasing on POOL TURN instead of price retracement capture
// more — priced honestly, with the deaths included.
//   A = booked (actual trail)
//   B = liquid-window: hold while pool >= X% of its running peak; exit on turn
// Fills haircut 0.95; 30-min horizon; deaths in cohort so holding costs count.
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url"; import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const sql = postgres(url);
const FILL = 0.95;
const POOL_TURNS = [0.70, 0.80, 0.85];   // exit when pool falls to this × its running peak
const FLOOR = 0.55;                       // the -45% standard still binds

const cohort = await sql`
  SELECT p.id, p.mint, p.size_usd::float sz, p.realized_pnl_usd::float booked,
    p.entry_price_usd::float entry, p.opened_at, p.exit_reason
  FROM positions p WHERE p.lane='paper' AND p.status='closed'
    AND p.closed_at > now() - interval '10 days'
    AND p.signature IN ('MOON_STEADY','MOON_SLOW','RISER')
    AND p.entry_price_usd::float > 0
  ORDER BY p.closed_at DESC LIMIT 900`;

const totals: Record<string, number> = { "A: booked (price trail)": 0 };
for (const t of POOL_TURNS) totals[`B: liquid window, pool<=${(t*100).toFixed(0)}% of peak`] = 0;
let n = 0, deaths = 0, rides = 0;

for (const p of cohort) {
  const ticks = await sql`
    SELECT price_usd::float px, liquidity_usd::float liq FROM candidate_ticks
    WHERE mint=${p.mint} AND snapped_at BETWEEN ${p.opened_at}::timestamptz
      AND ${p.opened_at}::timestamptz + interval '30 minutes'
    ORDER BY snapped_at`;
  const rows = ticks.map((k) => ({ m: Number(k.px) / Number(p.entry), l: Number(k.liq) }))
    .filter((k) => Number.isFinite(k.m) && k.m > 0 && Number.isFinite(k.l) && k.l > 0);
  if (rows.length < 5) continue;
  n++;
  totals["A: booked (price trail)"] += Number(p.booked);
  if (p.exit_reason === "dust_rug") deaths++;
  for (const turn of POOL_TURNS) {
    let poolPeak = 0, out: number | null = null;
    for (const r of rows) {
      poolPeak = Math.max(poolPeak, r.l);
      if (r.m <= FLOOR) { out = Number(p.sz) * (r.m * FILL - 1); break; }        // -45% standard
      if (poolPeak > 0 && r.l <= poolPeak * turn) { out = Number(p.sz) * (r.m * FILL - 1); break; } // pool turned
    }
    const last = rows[rows.length - 1]!.m;
    totals[`B: liquid window, pool<=${(turn*100).toFixed(0)}% of peak`] += out ?? Number(p.sz) * (last * FILL - 1);
    if (turn === 0.80 && out === null) rides++;
  }
}
console.log(`LIQUID WINDOW REPLAY — ${n} positions (MOON_STEADY/SLOW/RISER, 10d), ${deaths} dust deaths included\n`);
for (const k of Object.keys(totals)) console.log(`  ${k.padEnd(44)} $${totals[k]!.toFixed(2)}`);
console.log(`\n  (at 80% turn: ${rides} positions never triggered — rode the full 30-min horizon)`);
await sql.end();
