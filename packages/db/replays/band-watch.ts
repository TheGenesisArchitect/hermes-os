/**
 * BAND WATCH — the inflow-band × wallet-crowd quality matrix.
 *
 * Born 2026-07-23 ("carving out the wallet signature to determine the real
 * from the fakes"): the 1.05–1.30 inflow bands looked mediocre (50% win / 36%
 * rug) until the crowd split showed two populations wearing one number —
 * winner-rep crowds at 70/12, rug-history crowds at 29/58. The anti-gate now
 * refuses the fakes in both lanes; this watch proves (or falsifies) the
 * cleanup daily: per band, the tradeable cohort's settled quality and the
 * refused cohort's counterfactual.
 *
 * Run: npx tsx packages/db/replays/band-watch.ts [windowHours=6]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(env)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const HOURS = Number(process.argv[2] ?? 6);

(async () => {
  const q = postgres(url);
  const bands: [string, number, number][] = [
    ["strong ≥1.30", 1.30, 99],
    ["good 1.20-1.30", 1.20, 1.30],
    ["mild 1.05-1.20", 1.05, 1.20],
  ];
  // COHORTS UPDATED per Formula v2 (ratified 2026-07-24): tradeable = F1
  // crowd-pass (wh ≥ 1 AND wh > rh — the live-admissible cohort); refused =
  // everything else (fresh 0W/0R, no-read, winner-deficient) — the SENSOR
  // tier, probed on paper, refused on live, measured here as counterfactual.
  process.stdout.write(`BAND WATCH — last ${HOURS}h (settled candidates; tradeable = F1 crowd-pass wh≥1 & wh>rh)\n`);
  process.stdout.write(`band              cohort      n   win  rug | traded  realized\n`);
  for (const [name, lo, hi] of bands) {
    for (const [cohort, cond] of [
      ["tradeable", "AND co.wallet_winner_hits >= 1 AND co.wallet_winner_hits - co.wallet_rug_hits >= 1"],
      ["refused", "AND (co.wallet_winner_hits IS NULL OR co.wallet_winner_hits = 0 OR co.wallet_winner_hits - co.wallet_rug_hits < 1)"],
    ] as [string, string][]) {
      const rows = (await q.unsafe(`
        SELECT count(*)::int n,
          count(*) filter (where co.label='winner')::int w,
          count(*) filter (where co.label='rug')::int r
        FROM candidate_outcomes co
        WHERE co.first_seen_at > now() - interval '${HOURS} hours' AND co.label IN ('winner','dud','rug')
          AND co.liq_growth::float >= ${lo} AND co.liq_growth::float < ${hi} ${cond}`)) as unknown as { n: number; w: number; r: number }[];
      const s = rows[0]!;
      const trades = (await q.unsafe(`
        SELECT count(*)::int n, round(coalesce(sum(p.realized_pnl_usd),0)::numeric,2) pnl
        FROM positions p JOIN candidate_outcomes co ON co.mint = p.mint
        WHERE p.status='closed' AND p.closed_at > now() - interval '${HOURS} hours'
          AND co.liq_growth::float >= ${lo} AND co.liq_growth::float < ${hi} ${cond}`)) as unknown as { n: number; pnl: string }[];
      const t = trades[0]!;
      process.stdout.write(
        `${name.padEnd(16)} ${cohort.padEnd(9)} ${String(s.n).padStart(4)}  ${s.n ? String(Math.round((100 * s.w) / s.n)).padStart(3) : "  —"}% ${s.n ? String(Math.round((100 * s.r) / s.n)).padStart(3) : "  —"}% | ${String(t.n).padStart(5)}  $${t.pnl}\n`,
      );
    }
  }
  process.stdout.write(`rule of the study: tradeable rug% should trend ≤25 in good/mild; refused cohort is the counterfactual — if IT starts winning, the gate is wrong and we say so.\n`);
  await q.end();
})();
