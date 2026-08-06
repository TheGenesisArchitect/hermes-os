/**
 * INSTANT-DEATH COURT (operator, 2026-08-06). The capture decomposition:
 * on trades that OFFER (peak >= 1.15x) the manager captures 32.3% — inside
 * the target band. The blended -7.6% comes from 102 trades/day that never
 * offered anything: avg peak 1.05x, dead in 48 seconds, -$890.
 *
 * QUESTION: what is knowable AT ENTRY that separates the instant-death
 * cohort from the cohort that offers? Entry-knowable features only —
 * anything the scout/recorder had before the seat was taken. No peak, no
 * final multiple, no minutes-to-peak (those are outcomes, not signals).
 *
 * Run: npx tsx packages/db/replays/instant-death-court.ts [days=7]
 */
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(env)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const DAYS = Number(process.argv[2] ?? 7);

type Row = {
  dead: boolean; pnl: number; sz: number; peakx: number;
  sig: string | null; dex: string | null; bs: number | null; lg: number | null;
  wh: number | null; rh: number | null; launch: number | null; stars: number | null;
  conv: number | null; rug: number | null; pool: number | null; dip: number | null;
  snap: number | null; trig: number | null; age: number | null;
};

const fmt = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(2);

/** Print a feature's split: how the DEAD cohort differs from the OFFER cohort. */
function split(name: string, rows: Row[], bucket: (r: Row) => string | null): void {
  const agg = new Map<string, { n: number; dead: number; pnl: number }>();
  for (const r of rows) {
    const b = bucket(r);
    if (b == null) continue;
    const a = agg.get(b) ?? { n: 0, dead: 0, pnl: 0 };
    a.n++; if (r.dead) a.dead++; a.pnl += r.pnl;
    agg.set(b, a);
  }
  if (agg.size < 2) return;
  console.log(`\n── ${name} ──`);
  const sorted = [...agg.entries()].sort((a, b) => (a[1].dead / a[1].n) - (b[1].dead / b[1].n));
  for (const [b, a] of sorted) {
    if (a.n < 15) continue; // no under-powered cells
    const deadPct = Math.round((100 * a.dead) / a.n);
    const bar = "█".repeat(Math.round(deadPct / 4));
    console.log(`  ${b.padEnd(22)} n=${String(a.n).padStart(4)}  dead ${String(deadPct).padStart(3)}% ${bar.padEnd(25)} pnl $${fmt(a.pnl).padStart(9)}  ev/t $${fmt(a.pnl / a.n).padStart(6)}`);
  }
}

(async () => {
  const q = postgres(url, { idle_timeout: 5 });
  const raw = (await q`
    SELECT p.size_usd::float sz, p.realized_pnl_usd::float pnl, p.entry_price_usd::float e,
      co.signature sig, t.dex, co.trigger_buy_share::float bs, co.liq_growth::float lg,
      co.wallet_winner_hits wh, co.wallet_rug_hits rh, co.launch_order launch, co.stars,
      co.conviction_score::float conv, co.rug_prob::float rug, co.dip_depth::float dip,
      co.snap_pct::float snap, co.trigger_multiple::float trig,
      extract(epoch from (p.opened_at - co.first_seen_at))/60.0 age,
      (SELECT max(ct.price_usd::float) FROM candidate_ticks ct WHERE ct.mint=p.mint
        AND ct.snapped_at BETWEEN p.opened_at AND p.closed_at
        AND ct.liquidity_usd::float BETWEEN 1200 AND 5000000) hi,
      (SELECT ct2.liquidity_usd::float FROM candidate_ticks ct2 WHERE ct2.mint=p.mint
        AND ct2.snapped_at <= p.opened_at AND ct2.liquidity_usd::float BETWEEN 1200 AND 5000000
        ORDER BY ct2.snapped_at DESC LIMIT 1) pool
    FROM positions p LEFT JOIN candidate_outcomes co ON co.mint=p.mint LEFT JOIN tokens t ON t.mint=p.mint
    WHERE p.lane='paper' AND p.status='closed' AND p.closed_at > now() - make_interval(days => ${DAYS})
      AND p.entry_price_usd::float > 0`) as unknown as (Row & { e: number; hi: number | null })[];

  const rows: Row[] = raw.filter((r) => r.hi != null && r.e > 0).map((r) => ({
    ...r, peakx: r.hi! / r.e, dead: r.hi! / r.e < 1.15,
  }));
  const dead = rows.filter((r) => r.dead), offer = rows.filter((r) => !r.dead);
  const sum = (a: Row[]) => a.reduce((s, r) => s + r.pnl, 0);
  console.log(`INSTANT-DEATH COURT — ${rows.length} paper closes, last ${DAYS}d\n`);
  console.log(`  DEAD  (peak <1.15x)  n=${dead.length}  pnl $${fmt(sum(dead))}  ev/t $${fmt(sum(dead) / Math.max(dead.length, 1))}`);
  console.log(`  OFFER (peak >=1.15x) n=${offer.length}  pnl $${fmt(sum(offer))}  ev/t $${fmt(sum(offer) / Math.max(offer.length, 1))}`);
  console.log(`\nBaseline death rate: ${Math.round((100 * dead.length) / rows.length)}% — a feature only matters if its cells deviate from this.`);

  split("SIGNATURE", rows, (r) => r.sig ?? "∅ unrouted");
  split("VENUE", rows, (r) => r.dex ?? "∅");
  split("LAUNCH ORDER", rows, (r) => (r.launch == null ? null : r.launch >= 3 ? "3rd+" : r.launch === 2 ? "2nd" : "1st"));
  split("CROWD", rows, (r) => r.wh == null ? "unmeasured"
    : (r.wh >= 1 && r.wh > (r.rh ?? 0)) ? "W>R (winners lead)"
    : (r.rh ?? 0) > 0 ? "R>=W (rug history)" : "0W/0R (unknown)");
  split("BUY SHARE @ trigger", rows, (r) => r.bs == null ? "unmeasured"
    : r.bs < 0.5 ? "<50%" : r.bs < 0.6 ? "50-60%" : r.bs < 0.7 ? "60-70%" : ">=70%");
  split("INFLOW (liq growth)", rows, (r) => r.lg == null ? "unmeasured"
    : r.lg < 1.1 ? "<1.10x" : r.lg < 1.2 ? "1.10-1.20x" : r.lg < 1.5 ? "1.20-1.50x" : ">=1.50x");
  split("POOL AT ENTRY", rows, (r) => r.pool == null ? "unmeasured"
    : r.pool < 5000 ? "<$5k" : r.pool < 10000 ? "$5-10k" : r.pool < 20000 ? "$10-20k" : ">=$20k");
  split("TRIGGER MULTIPLE", rows, (r) => r.trig == null ? "unmeasured"
    : r.trig < 1.2 ? "<1.20x" : r.trig < 1.4 ? "1.20-1.40x" : r.trig < 1.8 ? "1.40-1.80x" : ">=1.80x");
  split("AGE AT ENTRY", rows, (r) => r.age == null ? "unmeasured"
    : r.age < 3 ? "<3 min" : r.age < 10 ? "3-10 min" : r.age < 30 ? "10-30 min" : ">=30 min");
  split("RUG PROB (model)", rows, (r) => r.rug == null ? "unmeasured"
    : r.rug < 0.2 ? "<0.20" : r.rug < 0.4 ? "0.20-0.40" : "&gt;=0.40");
  split("STARS", rows, (r) => r.stars == null ? "unmeasured" : `${r.stars}★`);
  console.log("\nRead: a cell whose death rate sits well BELOW baseline with positive ev/t is an admission signal;");
  console.log("well ABOVE baseline with negative ev/t is a refusal candidate. n<15 cells are suppressed.");
  await q.end();
})();
