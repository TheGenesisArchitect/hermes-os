// SCOPED RIPE-SWEEP — pick the real-time-knowable scope that captures the
// moon-cohort win (+$258/14d) without the ordinary-green butchery (−$166).
// Scopes are conditions decideExit KNOWS in flight.
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url"; import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const sql = postgres(url);
const FILL = 0.95, STALL = 180, FADE = 0.9;
const cohort = await sql`
  SELECT p.id, p.mint, p.size_usd::float sz, p.realized_pnl_usd::float booked,
    p.entry_price_usd::float entry, p.opened_at, coalesce(p.signature,'') sig,
    EXTRACT(HOUR FROM p.opened_at)::int hr
  FROM positions p WHERE p.status='closed' AND p.closed_at > now() - interval '14 days'
    AND p.entry_price_usd::float > 0 AND p.lane='paper'
    AND p.peak_price_usd::float/p.entry_price_usd::float >= 1.35
  ORDER BY p.opened_at DESC LIMIT 400`;
type Scope = { name: string; test: (p: any, peakSoFar: number) => boolean };
const SCOPES: Scope[] = [
  { name: "A: pos peak ≥2.0× (any class)  ", test: (_p, pk) => pk >= 2.0 },
  { name: "B: MOON% signature only        ", test: (p) => String(p.sig).startsWith("MOON") },
  { name: "C: monster hours 16-24 UTC only", test: (p) => p.hr >= 16 },
  { name: "D: A OR B (peak2 or moon-class)", test: (p, pk) => pk >= 2.0 || String(p.sig).startsWith("MOON") },
];
const totals: Record<string, number> = { booked: 0 };
for (const s of SCOPES) totals[s.name] = 0;
let n = 0;
for (const p of cohort) {
  const ticks = await sql`
    SELECT price_usd::float px, extract(epoch from (snapped_at - ${p.opened_at}::timestamptz))::float t
    FROM candidate_ticks WHERE mint=${p.mint}
      AND snapped_at BETWEEN ${p.opened_at}::timestamptz AND ${p.opened_at}::timestamptz + interval '60 minutes'
    ORDER BY snapped_at`;
  const marks = ticks.map((k) => ({ m: Number(k.px)/Number(p.entry), t: Number(k.t) })).filter((k) => Number.isFinite(k.m) && k.m > 0);
  if (marks.length < 5) continue;
  n++; totals.booked += Number(p.booked);
  for (const s of SCOPES) {
    let peak = 1, peakAt = 0, out: number | null = null;
    for (const k of marks) {
      if (k.m > peak) { peak = k.m; peakAt = k.t; }
      if (out === null && s.test(p, peak) && peak >= 1.35 && k.t - peakAt >= STALL && k.m <= peak * FADE) out = Number(p.sz) * (k.m * FILL - 1);
    }
    totals[s.name] += out ?? Number(p.booked); // out of scope / never fired → booked stands
  }
}
console.log(`SCOPED RIPE-SWEEP — ${n} ripe greens, 14d (sweep replaces booked only when it fires in-scope)`);
for (const k of Object.keys(totals)) console.log(`  ${k.padEnd(34)} $${totals[k]!.toFixed(2)}`);
await sql.end();
