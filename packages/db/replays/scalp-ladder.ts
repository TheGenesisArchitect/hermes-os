// SCALP LADDER (operator 2026-07-29: "if we can consistently bank .65-.85 on
// most trades while the Wallet is small this becomes the insurance money").
// On the QUALIFIED cohort (the shipped formula: buys>=55%, pool>=13k,
// inflow>=1.20, allowlisted genome), simulate exit-all at a target mark with
// the -45% standard as the floor. Reports hit rate, EV/trade at a $2.50
// ticket, and trades-to-+$33 (the run back to $100).
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url"; import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const sql = postgres(url);
const TICKET = 2.5, FILL = 0.97, FLOOR = 0.55; // fill haircut; -45% standard
const TARGETS = [1.20, 1.25, 1.30, 1.35, 1.45, 1.60];

const cands = await sql`
  SELECT co.mint, co.triggered_at, co.ref_price_usd::float ref
  FROM candidate_outcomes co
  WHERE co.triggered_at > now() - interval '10 days' AND co.label IN ('winner','dud','rug')
    AND co.liq_growth >= 1.20 AND co.trigger_buy_share >= 0.55
    AND co.signature IN ('BASE','RISER','MOON_FAST','MOON_VIOLENT')
    AND (SELECT ct.liquidity_usd::float FROM candidate_ticks ct WHERE ct.mint=co.mint
         AND ct.snapped_at <= co.triggered_at ORDER BY ct.snapped_at DESC LIMIT 1) >= 13000
  ORDER BY co.triggered_at DESC LIMIT 500`;

const res = new Map<number, { n: number; hits: number; floors: number; pnl: number }>();
for (const t of TARGETS) res.set(t, { n: 0, hits: 0, floors: 0, pnl: 0 });
let used = 0;
for (const c of cands) {
  const ticks = await sql`
    SELECT price_usd::float px FROM candidate_ticks WHERE mint=${c.mint}
      AND snapped_at >= ${c.triggered_at}::timestamptz
      AND snapped_at <= ${c.triggered_at}::timestamptz + interval '30 minutes'
    ORDER BY snapped_at`;
  if (ticks.length < 4) continue;
  const entry = Number(ticks[0]!.px);
  if (!(entry > 0)) continue;
  used++;
  const marks = ticks.map((k) => Number(k.px) / entry).filter((m) => Number.isFinite(m) && m > 0);
  for (const t of TARGETS) {
    const r = res.get(t)!;
    r.n++;
    let out: number | null = null;
    for (const m of marks) {
      if (m >= t) { out = TICKET * (t * FILL - 1); r.hits++; break; }        // scalp hit
      if (m <= FLOOR) { out = TICKET * (m * FILL - 1); r.floors++; break; }  // floor
    }
    r.pnl += out ?? TICKET * ((marks[marks.length - 1] ?? 1) * FILL - 1);    // timed out at last mark
  }
}
console.log(`SCALP LADDER — ${used} qualified candidates (10d, shipped formula), $${TICKET} ticket\n`);
console.log("target |  hit% | floor% |  EV/trade | trades to +$33");
for (const t of TARGETS) {
  const r = res.get(t)!;
  const ev = r.pnl / r.n;
  console.log(`  ${t.toFixed(2)}× | ${((100*r.hits)/r.n).toFixed(0).padStart(4)}% | ${((100*r.floors)/r.n).toFixed(0).padStart(5)}% | $${ev.toFixed(3).padStart(7)} | ${ev > 0 ? Math.ceil(33/ev) : "—"}`);
}
await sql.end();
