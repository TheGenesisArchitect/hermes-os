/**
 * MICRO-RUNG HARNESS — price a 15% bank at 1.10× ahead of tp0 (1.22×).
 * The rungless-death class (−$1,998/10d) dies at full basis; ~24% of it
 * touched 1.10× first. Winners cross 1.10 in <1min — the micro-rung
 * front-loads their basis recovery at a small cost to their upper rungs.
 * Liquidity-aware fills; variant = 15% sold at the first ≥1.10× tick (paid
 * by that tick's pool), remaining 85% scales the actual booked outcome.
 * Run: npx tsx packages/db/replays/micro-rung-harness.ts [since=2026-07-15]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);
const SINCE = process.argv[2] ?? "2026-07-15";
const RUNG = 1.10, FRAC = 0.15, HAIRCUT = 0.98;

const positions = await sql`
  SELECT p.id, p.mint, p.opened_at, p.entry_price_usd::float AS e, p.size_usd::float AS s,
         p.realized_pnl_usd::float AS pnl,
         EXISTS (SELECT 1 FROM fills f WHERE f.position_id = p.id AND f.side = 'sell' AND f.reason LIKE 'take_profit%') AS banked
  FROM positions p
  WHERE p.lane = 'paper' AND p.status = 'closed' AND p.opened_at >= ${SINCE} AND p.entry_price_usd::float > 0`;

const coh = { death: { n: 0, base: 0, var: 0 }, winner: { n: 0, base: 0, var: 0 }, other: { n: 0, base: 0, var: 0 } };
let touched = 0, skipped = 0;
for (const p of positions) {
  const ticks = await sql`
    SELECT price_usd::float AS px, liquidity_usd::float AS liq
    FROM candidate_ticks WHERE mint = ${p.mint}
      AND snapped_at BETWEEN ${p.opened_at} AND ${p.opened_at}::timestamptz + interval '30 minutes'
    ORDER BY snapped_at`;
  if (ticks.length < 3) { skipped++; continue; }
  const hit = ticks.find((t) => t.px / p.e >= RUNG && (t.liq ?? 0) >= 500);
  let variant: number;
  if (!hit) variant = p.pnl;
  else {
    touched++;
    const trancheUsd = FRAC * p.s * RUNG;
    const impact = Math.min(0.5, trancheUsd / (0.5 * hit.liq));
    const microBank = FRAC * p.s * (RUNG * (1 - impact) * HAIRCUT - 1);
    variant = microBank + (1 - FRAC) * p.pnl;
  }
  const isDeath = !p.banked && p.pnl < -0.3 * p.s;
  const key = isDeath ? "death" : p.pnl > 0 ? "winner" : "other";
  coh[key].n++; coh[key].base += p.pnl; coh[key].var += variant;
}
console.log(`universe ${positions.length} closed paper positions since ${SINCE} · ${skipped} skipped thin-ticks · ${touched} touched ${RUNG}×\n`);
console.log(`cohort     n      BOOKED     +MICRO-RUNG     Δ`);
let tb = 0, tv = 0;
for (const [k, c] of Object.entries(coh)) {
  tb += c.base; tv += c.var;
  console.log(`${k.padEnd(8)} ${String(c.n).padStart(4)}  $${c.base.toFixed(2).padStart(9)}  $${c.var.toFixed(2).padStart(9)}   ${c.var - c.base >= 0 ? "+" : ""}$${(c.var - c.base).toFixed(2)}`);
}
console.log(`${"TOTAL".padEnd(8)} ${String(coh.death.n + coh.winner.n + coh.other.n).padStart(4)}  $${tb.toFixed(2).padStart(9)}  $${tv.toFixed(2).padStart(9)}   ${tv - tb >= 0 ? "+" : ""}$${(tv - tb).toFixed(2)}`);
await sql.end();
