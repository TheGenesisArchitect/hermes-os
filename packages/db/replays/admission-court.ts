/**
 * ADMISSION COURT (operator, 2026-08-06). The instant-death autopsy named an
 * entry-knowable refusal set; this court prices it on TOTAL EV before any of
 * it reaches the manifest. Same bar every gate here has faced:
 *   1. beat the incumbent in BOTH halves of the window, AND
 *   2. improve capture % of what the tape actually offered, AND
 *   3. never refuse more EV than it protects (total, not per-trade).
 *
 * Refusal candidates, all knowable at seat time:
 *   R1 unrouted        no signature -> no measurements (54% dead, ev/t +$0.05)
 *   R2 pool <$5k       47% dead, ev/t -$0.59
 *   R3 crowd R>=W      rug history leads (51% dead, ev/t -$1.17)
 *   R4 venue dbc       47% dead, ev/t -$0.59
 *   R5 crowd 0W/0R     unknown crowd (44% dead, ev/t -$0.45)
 * Run: npx tsx packages/db/replays/admission-court.ts [days=7]
 */
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(env)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const DAYS = Number(process.argv[2] ?? 7);

type R = {
  pnl: number; sz: number; peakx: number; half: boolean;
  sig: string | null; dex: string | null; wh: number | null; rh: number | null; pool: number | null;
};
const f = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(2);

(async () => {
  const q = postgres(url, { idle_timeout: 5 });
  const raw = (await q`
    SELECT p.size_usd::float sz, p.realized_pnl_usd::float pnl, p.entry_price_usd::float e, p.opened_at o,
      co.signature sig, t.dex, co.wallet_winner_hits wh, co.wallet_rug_hits rh,
      (SELECT max(ct.price_usd::float) FROM candidate_ticks ct WHERE ct.mint=p.mint
        AND ct.snapped_at BETWEEN p.opened_at AND p.closed_at
        AND ct.liquidity_usd::float BETWEEN 1200 AND 5000000) hi,
      (SELECT ct2.liquidity_usd::float FROM candidate_ticks ct2 WHERE ct2.mint=p.mint
        AND ct2.snapped_at <= p.opened_at AND ct2.liquidity_usd::float BETWEEN 1200 AND 5000000
        ORDER BY ct2.snapped_at DESC LIMIT 1) pool
    FROM positions p LEFT JOIN candidate_outcomes co ON co.mint=p.mint LEFT JOIN tokens t ON t.mint=p.mint
    WHERE p.lane='paper' AND p.status='closed' AND p.closed_at > now() - make_interval(days => ${DAYS})
      AND p.entry_price_usd::float > 0`) as unknown as
    (R & { e: number; hi: number | null; o: Date })[];
  const mid = Date.now() - (DAYS / 2) * 86_400_000;
  const rows: R[] = raw.filter((r) => r.hi != null && r.e > 0).map((r) => ({
    ...r, peakx: r.hi! / r.e, half: r.o.getTime() >= mid,
  }));

  const R1 = (r: R) => r.sig == null;                                   // unrouted
  const R2 = (r: R) => r.pool != null && r.pool < 5000;                 // thin pool
  const R3 = (r: R) => r.wh != null && (r.rh ?? 0) >= r.wh && (r.rh ?? 0) > 0; // rug history leads
  const R4 = (r: R) => r.dex === "meteora-dbc";                         // worst venue
  const R5 = (r: R) => (r.wh ?? 0) === 0 && (r.rh ?? 0) === 0;          // unknown crowd

  const POLICIES: [string, (r: R) => boolean][] = [
    ["INCUMBENT (take all)", () => true],
    ["R1 drop unrouted", (r) => !R1(r)],
    ["R1+R2 +thin pools", (r) => !R1(r) && !R2(r)],
    ["R1+R2+R3 +rug crowd", (r) => !R1(r) && !R2(r) && !R3(r)],
    ["R1+R2+R3+R4 +dbc", (r) => !R1(r) && !R2(r) && !R3(r) && !R4(r)],
    ["ALL R1-R5 (strictest)", (r) => !R1(r) && !R2(r) && !R3(r) && !R4(r) && !R5(r)],
    ["R2+R3 only (no signature gate)", (r) => !R2(r) && !R3(r)],
  ];

  const offeredOf = (a: R[]) => a.reduce((s, r) => s + (r.peakx > 1 ? r.sz * (r.peakx - 1) : 0), 0);
  const pnlOf = (a: R[]) => a.reduce((s, r) => s + r.pnl, 0);
  const inc = rows;
  const incE = pnlOf(inc.filter((r) => !r.half)), incL = pnlOf(inc.filter((r) => r.half));

  console.log(`ADMISSION COURT — ${rows.length} paper closes, last ${DAYS}d\n`);
  console.log(`${"policy".padEnd(32)} ${"seats".padStart(5)} ${"1st half".padStart(9)} ${"2nd half".padStart(9)} ${"total".padStart(9)} ${"capture".padStart(8)} ${"ev/t".padStart(7)}  verdict`);
  for (const [name, keep] of POLICIES) {
    const sel = rows.filter(keep);
    const early = pnlOf(sel.filter((r) => !r.half)), late = pnlOf(sel.filter((r) => r.half));
    const tot = early + late, off = offeredOf(sel);
    const cap = off > 0 ? ((100 * tot) / off).toFixed(1) + "%" : "—";
    const beats = early > incE && late > incL;
    const v = name.startsWith("INCUMBENT") ? "(incumbent)" : beats ? "✅ BEATS BOTH HALVES" : "—";
    console.log(`${name.padEnd(32)} ${String(sel.length).padStart(5)} ${f(early).padStart(9)} ${f(late).padStart(9)} ${f(tot).padStart(9)} ${cap.padStart(8)} ${f(tot / Math.max(sel.length, 1)).padStart(7)}  ${v}`);
  }
  // what each refusal costs and protects, standalone
  console.log(`\n${"refusal".padEnd(24)} ${"refused".padStart(7)} ${"their pnl".padStart(10)}  (negative = the rail protects money)`);
  for (const [n2, pred] of [["R1 unrouted", R1], ["R2 pool <$5k", R2], ["R3 crowd R>=W", R3], ["R4 venue dbc", R4], ["R5 crowd 0W/0R", R5]] as [string, (r: R) => boolean][]) {
    const cut = rows.filter(pred);
    console.log(`${n2.padEnd(24)} ${String(cut.length).padStart(7)} ${f(pnlOf(cut)).padStart(10)}`);
  }
  console.log("\nBar: beat the incumbent in BOTH halves + improve capture + refuse less EV than it protects.");
  await q.end();
})();
