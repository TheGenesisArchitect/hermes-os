/**
 * RELAUNCH HARNESS — first-of-ticker vs relaunch cohorts, full dataset.
 *
 * The 24h collapse anatomy showed the inversion: first-of-ticker −$58.73
 * (n=156) vs 3rd-or-later +$82.07 (n=36). Grandmaster read: the adversary's
 * opening launch harvests the first wave AND proves the demand; relaunches
 * carry real crowds after the drain already happened to someone else. This
 * prices the effect across the full book before any gate moves.
 *
 * Launch order = how many DISTINCT earlier mints shared this position's
 * ticker symbol among candidates first seen in the trailing 24h before entry.
 *
 * Run: npx tsx packages/db/replays/relaunch-harness.ts [since=2026-07-15]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);
const SINCE = process.argv[2] ?? "2026-07-15";

const rows = await sql`
  SELECT ord.n_prior, p.size_usd::float AS s, p.realized_pnl_usd::float AS pnl,
         c.label,
         EXISTS (SELECT 1 FROM fills f WHERE f.position_id = p.id AND f.side='sell' AND f.reason LIKE 'take_profit%') AS banked
  FROM positions p
  JOIN tokens t ON t.mint = p.mint
  LEFT JOIN candidate_outcomes c ON c.mint = p.mint
  CROSS JOIN LATERAL (
    SELECT count(DISTINCT c2.mint)::int AS n_prior
    FROM candidate_outcomes c2 JOIN tokens t2 ON t2.mint = c2.mint
    WHERE t2.symbol = t.symbol AND c2.mint <> p.mint
      AND c2.first_seen_at BETWEEN p.opened_at - interval '24 hours' AND p.opened_at
  ) ord
  WHERE p.lane = 'paper' AND p.status = 'closed' AND p.opened_at >= ${SINCE}`;

type A = { n: number; dep: number; pnl: number; wins: number; deaths: number };
const buckets = new Map<string, A>();
const bucketOf = (k: number) => (k === 0 ? "1st launch (0 prior)" : k === 1 ? "2nd launch (1 prior)" : k <= 3 ? "3rd-4th launch" : "5th+ launch");
for (const r of rows) {
  const k = bucketOf(Number(r.n_prior));
  const a = buckets.get(k) ?? { n: 0, dep: 0, pnl: 0, wins: 0, deaths: 0 };
  a.n++; a.dep += r.s; a.pnl += r.pnl ?? 0;
  if ((r.pnl ?? 0) > 0) a.wins++;
  if (!r.banked && (r.pnl ?? 0) < -0.3 * r.s) a.deaths++;
  buckets.set(k, a);
}
console.log(`paper closed positions since ${SINCE}, bucketed by same-ticker launches in prior 24h:\n`);
console.log(`bucket                 n     deployed     pnl      $/$     win%   rungless-death%`);
const ORDER = ["1st launch (0 prior)", "2nd launch (1 prior)", "3rd-4th launch", "5th+ launch"];
for (const k of ORDER) {
  const a = buckets.get(k);
  if (!a) continue;
  console.log(
    `${k.padEnd(21)} ${String(a.n).padStart(4)}  $${a.dep.toFixed(0).padStart(8)}  $${a.pnl.toFixed(2).padStart(8)}  ${(a.pnl / Math.max(1, a.dep)).toFixed(3).padStart(6)}  ${Math.round((100 * a.wins) / a.n).toString().padStart(4)}%   ${Math.round((100 * a.deaths) / a.n)}%`,
  );
}
await sql.end();
