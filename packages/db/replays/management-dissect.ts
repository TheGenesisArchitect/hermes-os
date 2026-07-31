// MANAGEMENT DISSECTION (operator 2026-07-31: "dissect the mechanics on every
// trade Paper takes and determine if the system we optimized for is functioning
// as expected... Are we seeing the improvements that get us closer to 18K in
// 10 days").
//
// Every trade, every mechanic, against what each ship was SUPPOSED to do.
// Usage: npx tsx packages/db/replays/management-dissect.ts [sinceISO]
//
// THE SIX SHIPS BEING GRADED (all of 2026-07-31):
//   ae3c428 liquid window   pool release replaces the price trail
//   3d2e41d pool ownership  pool decides the ride; capture exits suppressed
//   53c1b98 profit lock     gains protected under ownership (regression fix)
//   e93e906 ladder E        runner 20% -> 45% (TP2_CUM_SELL 0.80 -> 0.55)
//   7933b1e basket harvest  bar scaled to the book (was 344% of it)
//   a9bcdd8 admission 1.25  live band + seat line lowered
//
// PASS/FAIL is stated per mechanic so "it deployed" is never mistaken for
// "it works". Capture is the primary metric; summed P&L is reported but is
// explicitly NOT the grade — that metric already misled us once tonight.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))?.[1]?.trim()
  ?? "postgres://hermes:hermes@localhost:5433/hermes";
const sql = postgres(url);

const SINCE = process.argv[2] ?? "2026-07-31 08:45:00+00";   // last ship
const BASE_START = "2026-07-21 00:00:00+00";                 // 10d pre-ship baseline
const BASE_END = "2026-07-31 03:30:00+00";                   // first ship

// TARGETS the harnesses projected, so "on track" is a number and not a vibe.
const T_CAPTURE_MED = 63;    // pool 0.70 + profit lock, capture harness
const T_CAPTURE_STRETCH = 82; // + ratchet keep 0.8 (not shipped; the ceiling)
const T_GIVEAWAY_PCT = 24;   // booked baseline; anything worse is a regression

const rows = await sql`
  SELECT p.id, t.symbol, p.signature, p.book, p.size_usd::float sz,
         p.realized_pnl_usd::float pnl, p.entry_price_usd::float entry,
         p.exit_price_usd::float exitpx, p.peak_price_usd::float peakpx,
         p.exit_reason, p.opened_at, p.closed_at,
         extract(epoch from (p.closed_at - p.opened_at)) held,
         (SELECT count(*) FROM fills f WHERE f.position_id=p.id AND f.side='sell' AND f.reason LIKE 'take_profit%') rungs,
         (SELECT count(*) FROM fills f WHERE f.position_id=p.id AND f.side='sell') sells
  FROM positions p LEFT JOIN tokens t ON t.mint=p.mint
  WHERE p.lane='paper' AND p.status='closed' AND p.closed_at >= ${SINCE}::timestamptz
  ORDER BY p.closed_at`;

const [base] = await sql`
  SELECT count(*)::int n,
         sum(p.realized_pnl_usd::float) pnl,
         avg(p.realized_pnl_usd::float) avg_pnl,
         avg(extract(epoch from (p.closed_at - p.opened_at))) held,
         avg(CASE WHEN p.peak_price_usd::float > p.entry_price_usd::float
              THEN least(1, (p.exit_price_usd::float/nullif(p.entry_price_usd::float,0))
                          / nullif(p.peak_price_usd::float/nullif(p.entry_price_usd::float,0),0)) END) cap,
         count(*) FILTER (WHERE p.peak_price_usd::float/nullif(p.entry_price_usd::float,0) >= 1.5
                            AND p.exit_price_usd::float < p.entry_price_usd::float)::int giveaways,
         count(*) FILTER (WHERE p.peak_price_usd::float/nullif(p.entry_price_usd::float,0) >= 1.5)::int give_elig
  FROM positions p
  WHERE p.lane='paper' AND p.status='closed'
    AND p.closed_at BETWEEN ${BASE_START}::timestamptz AND ${BASE_END}::timestamptz
    AND p.entry_price_usd::float > 0`;

const med = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
const pct = (a: number, b: number) => (b ? (100 * a / b) : 0);

console.log(`\n${"=".repeat(104)}`);
console.log(`MANAGEMENT DISSECTION — paper closes since ${SINCE}`);
console.log(`${"=".repeat(104)}\n`);

if (!rows.length) {
  console.log(`No paper positions have closed since the last ship yet. Nothing to grade.`);
  await sql.end();
  process.exit(0);
}

console.log(`PER-TRADE MECHANICS`);
console.log(`  ${"id".padStart(5)} ${"symbol".padEnd(11)} ${"genome".padEnd(12)} ${"bk".padEnd(5)} ${"held".padStart(6)} ${"rung".padStart(4)} ${"peak".padStart(6)} ${"exit".padStart(6)} ${"cap".padStart(5)} ${"exit_reason".padEnd(16)} ${"pnl".padStart(7)}`);
const caps: number[] = [];
let give = 0, giveElig = 0, pnlSum = 0, rungAny = 0;
const byReason = new Map<string, { n: number; pnl: number; caps: number[] }>();

for (const r of rows) {
  const peakX = Number(r.entry) > 0 ? Number(r.peakpx) / Number(r.entry) : 0;
  const exitX = Number(r.entry) > 0 ? Number(r.exitpx) / Number(r.entry) : 0;
  const cap = peakX > 1 ? Math.min(1, exitX / peakX) : NaN;
  if (Number.isFinite(cap)) caps.push(cap);
  if (peakX >= 1.5) { giveElig++; if (exitX < 1) give++; }
  if (Number(r.rungs) > 0) rungAny++;
  pnlSum += Number(r.pnl);
  const e = byReason.get(r.exit_reason ?? "?") ?? { n: 0, pnl: 0, caps: [] };
  e.n++; e.pnl += Number(r.pnl); if (Number.isFinite(cap)) e.caps.push(cap);
  byReason.set(r.exit_reason ?? "?", e);
  console.log(
    `  ${String(r.id).padStart(5)} ${String(r.symbol ?? "?").slice(0, 11).padEnd(11)} ${String(r.signature ?? "-").padEnd(12)} ${String(r.book).padEnd(5)}` +
    ` ${`${Math.round(Number(r.held))}s`.padStart(6)} ${String(r.rungs).padStart(4)} ${peakX.toFixed(2).padStart(6)} ${exitX.toFixed(2).padStart(6)}` +
    ` ${(Number.isFinite(cap) ? `${(100 * cap).toFixed(0)}%` : "—").padStart(5)} ${String(r.exit_reason ?? "?").padEnd(16)} ${Number(r.pnl).toFixed(2).padStart(7)}`,
  );
}

const capMed = 100 * med(caps);
const baseCap = 100 * Number(base!.cap ?? 0);
const giveRate = pct(give, giveElig);
const baseGive = pct(Number(base!.giveaways), Number(base!.give_elig));
const avgHeld = rows.reduce((s, r) => s + Number(r.held), 0) / rows.length;

console.log(`\nEXIT MIX`);
for (const [k, v] of [...byReason.entries()].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${k.padEnd(18)} ${String(v.n).padStart(3)}  cap ${(100 * med(v.caps)).toFixed(0).padStart(3)}%  pnl ${v.pnl.toFixed(2).padStart(8)}`);
}

const grade = (label: string, ok: boolean, detail: string) =>
  console.log(`  ${(ok ? "PASS" : "WATCH").padEnd(6)} ${label.padEnd(26)} ${detail}`);

console.log(`\nSCORECARD — is the optimised system doing what it was built to do?`);
grade("capture (median)", capMed >= T_CAPTURE_MED,
  `${capMed.toFixed(1)}% now vs ${baseCap.toFixed(1)}% baseline · target ${T_CAPTURE_MED}% · ceiling ${T_CAPTURE_STRETCH}%`);
grade("giveaway rate", giveRate <= T_GIVEAWAY_PCT,
  `${give}/${giveElig} = ${giveRate.toFixed(0)}% vs ${baseGive.toFixed(0)}% baseline (peaked >=1.5x, exited below entry)`);
grade("hold time", avgHeld >= Number(base!.held),
  `${avgHeld.toFixed(0)}s now vs ${Number(base!.held).toFixed(0)}s baseline (ownership should LENGTHEN holds)`);
grade("basket_harvest firing", (byReason.get("basket_harvest")?.n ?? 0) > 0,
  `${byReason.get("basket_harvest")?.n ?? 0} of ${rows.length} closes (was 1.6% of runners pre-fix)`);
grade("price trail retired", (byReason.get("profit_trail")?.n ?? 0) === 0,
  `${byReason.get("profit_trail")?.n ?? 0} profit_trail closes (ownership should suppress it when the pool is visible)`);
grade("rung participation", pct(rungAny, rows.length) > 0,
  `${rungAny}/${rows.length} = ${pct(rungAny, rows.length).toFixed(0)}% took at least one rung (TP0 is the rug insurance)`);

console.log(`\nRATE — tracking toward the 10d projection`);
// SINCE is a Postgres-style literal ("+00", not "+00:00"), which Date() rejects.
// Take the window from the rows themselves — they are the ground truth anyway.
const firstMs = new Date(rows[0]!.opened_at as unknown as string).getTime();
const days = Math.max((Date.now() - firstMs) / 86_400_000, 1e-6);
const baseRate = Number(base!.pnl) / 10;
console.log(`  window            ${days.toFixed(2)} days, ${rows.length} closes`);
console.log(`  P&L this window   $${pnlSum.toFixed(2)}   ($${(pnlSum / Math.max(days, 1e-6)).toFixed(2)}/day)`);
console.log(`  baseline rate     $${baseRate.toFixed(2)}/day  (10d pre-ship: $${Number(base!.pnl).toFixed(2)} over ${base!.n} closes)`);
console.log(`  harness projected $785/day  (pool 0.70 ownership, $7,855 over 10d) — the number to beat`);
console.log(`\n  NOTE: P&L over a short window is DOMINATED BY VARIANCE and is not the grade.`);
console.log(`  Capture, giveaway rate and exit mix are the mechanics; they converge far faster than P&L.`);
await sql.end();
