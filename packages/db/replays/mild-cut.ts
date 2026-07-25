/**
 * MILD-CUT HARNESS — should the sizer stop funding the mild band entirely?
 *
 * Operator directive 2026-07-25: "Stop throwing money at the Mild Loser All
 * together and play the statistics." Before cutting, decompose the mild band
 * (entry inflow 1.05–1.20) over the full window: per-class P&L, capital
 * deployed, moon tails (would the cut cost us boardings?), and the
 * counterfactual portfolio without it. Bands per band-watch: liq_growth.
 *
 * Run: npx tsx packages/db/replays/mild-cut.ts [windowHours=72]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1]!.trim();
const HOURS = Number(process.argv[2] ?? 72);
const q = postgres(url);

const bandCase = `CASE WHEN co.liq_growth::float >= 1.30 THEN 'strong'
  WHEN co.liq_growth::float >= 1.20 THEN 'good'
  WHEN co.liq_growth::float >= 1.05 THEN 'mild'
  ELSE 'sub' END`;

console.log(`MILD-CUT HARNESS — last ${HOURS}h, settled positions joined to candidate inflow band`);

// 1) Per band: trades, capital in, P&L, wins — both lanes.
const bands = await q.unsafe(`
  SELECT ${bandCase} AS band, p.lane, count(*)::int n,
    round(sum(p.size_usd)::numeric,2) AS deployed,
    round(sum(p.realized_pnl_usd)::numeric,2) AS pnl,
    count(*) filter (where p.realized_pnl_usd > 0)::int AS wins,
    round(avg(p.size_usd)::numeric,2) AS avg_size
  FROM positions p JOIN candidate_outcomes co ON co.mint = p.mint
  WHERE p.status='closed' AND p.closed_at > now() - interval '${HOURS} hours'
  GROUP BY 1, 2 ORDER BY 2, 1`);
console.log(`\nband    lane    n   deployed      pnl   win%  avg$`);
for (const b of bands as any[])
  console.log(`${String(b.band).padEnd(7)} ${String(b.lane).padEnd(5)} ${String(b.n).padStart(4)}  $${String(b.deployed).padStart(8)}  $${String(b.pnl).padStart(7)}  ${String(Math.round((100 * b.wins) / b.n)).padStart(4)}%  $${b.avg_size}`);

// 2) Inside mild: per signature class — where exactly does it bleed?
const cls = await q.unsafe(`
  SELECT p.signature, count(*)::int n, round(sum(p.realized_pnl_usd)::numeric,2) AS pnl,
    round(sum(p.size_usd)::numeric,2) AS deployed,
    count(*) filter (where p.realized_pnl_usd > 0)::int AS wins,
    round(max(CASE WHEN p.entry_price_usd::float > 0 THEN p.peak_price_usd::float / p.entry_price_usd::float ELSE 1 END)::numeric,2) AS best_peak
  FROM positions p JOIN candidate_outcomes co ON co.mint = p.mint
  WHERE p.status='closed' AND p.closed_at > now() - interval '${HOURS} hours'
    AND co.liq_growth::float >= 1.05 AND co.liq_growth::float < 1.20
  GROUP BY 1 ORDER BY pnl ASC`);
console.log(`\nMILD by class:`);
for (const c of cls as any[])
  console.log(`  ${String(c.signature).padEnd(11)} n=${String(c.n).padStart(3)} pnl $${String(c.pnl).padStart(7)} deployed $${String(c.deployed).padStart(7)} win ${Math.round((100 * c.wins) / c.n)}% best peak ${c.best_peak}×`);

// 3) Moon-tail check: mild trades that peaked ≥2.5× or banked ≥ +$3 — the
//    upside the cut would forfeit. Named per doctrine.
const tails = await q.unsafe(`
  SELECT tk.symbol, p.signature, p.lane, round(p.realized_pnl_usd::numeric,2) AS pnl,
    round((CASE WHEN p.entry_price_usd::float > 0 THEN p.peak_price_usd::float / p.entry_price_usd::float ELSE 1 END)::numeric,2) AS peak,
    round(p.size_usd::numeric,2) AS sz
  FROM positions p JOIN candidate_outcomes co ON co.mint = p.mint
    LEFT JOIN tokens tk ON tk.mint = p.mint
  WHERE p.status='closed' AND p.closed_at > now() - interval '${HOURS} hours'
    AND co.liq_growth::float >= 1.05 AND co.liq_growth::float < 1.20
    AND ((p.entry_price_usd::float > 0 AND p.peak_price_usd::float / p.entry_price_usd::float >= 2.5) OR p.realized_pnl_usd >= 3)
  ORDER BY 5 DESC LIMIT 12`);
console.log(`\nMILD moon tails (peak ≥2.5× or pnl ≥ $3): ${(tails as any[]).length}`);
for (const t of tails as any[])
  console.log(`  ${String(t.symbol).padEnd(12)} ${String(t.signature).padEnd(11)} ${t.lane} $${t.sz} → $${t.pnl} peak ${t.peak}×`);

// 4) Counterfactual: window P&L with and without mild, and mild's crowd split
//    (does the F1 crowd-pass slice of mild still lose?).
const [cf] = (await q.unsafe(`
  SELECT round(sum(p.realized_pnl_usd)::numeric,2) AS total,
    round(sum(p.realized_pnl_usd) filter (where co.liq_growth::float >= 1.05 AND co.liq_growth::float < 1.20)::numeric,2) AS mild
  FROM positions p JOIN candidate_outcomes co ON co.mint = p.mint
  WHERE p.status='closed' AND p.closed_at > now() - interval '${HOURS} hours'`)) as any[];
const crowd = await q.unsafe(`
  SELECT CASE WHEN co.wallet_winner_hits >= 1 AND co.wallet_winner_hits - co.wallet_rug_hits >= 1
    THEN 'crowd-pass' ELSE 'crowd-fail' END AS cohort,
    count(*)::int n, round(sum(p.realized_pnl_usd)::numeric,2) AS pnl,
    count(*) filter (where p.realized_pnl_usd > 0)::int AS wins
  FROM positions p JOIN candidate_outcomes co ON co.mint = p.mint
  WHERE p.status='closed' AND p.closed_at > now() - interval '${HOURS} hours'
    AND co.liq_growth::float >= 1.05 AND co.liq_growth::float < 1.20
  GROUP BY 1`);
console.log(`\nCOUNTERFACTUAL: window total $${cf.total} · mild contributed $${cf.mild} · without mild $${(Number(cf.total) - Number(cf.mild)).toFixed(2)}`);
for (const c of crowd as any[])
  console.log(`  mild ${c.cohort}: n=${c.n} pnl $${c.pnl} win ${Math.round((100 * c.wins) / c.n)}%`);
await q.end();
