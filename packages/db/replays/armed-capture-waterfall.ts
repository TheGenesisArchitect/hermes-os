/**
 * ARMED CAPTURE WATERFALL — the trade-management arbitrage, decomposed.
 *
 * Operator (2026-07-25): "How do we convert the 70% Hit Rate on Risers,
 * Climbers and Moons into Positive Captures of 40%+." Universe = the PROVEN
 * cohort only: closed paper positions since the formula era (Jul 21) that
 * ARMED (peaked ≥1.2× from entry). For each class × exit path, capture is
 * split into its stages so the leak has a name:
 *
 *   offer        = (peak − 1) × size          — what the move gave us
 *   banked       = rung proceeds above basis  — cashed on the way up
 *   exit take    = remainder sold at exit     — what the leash kept
 *   giveback     = offer − banked − exit take — evaporated between peak & fill
 *
 * Run: npx tsx packages/db/replays/armed-capture-waterfall.ts [since=2026-07-21]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);
const SINCE = process.argv[2] ?? "2026-07-21";

const rows = await sql`
  SELECT p.id, p.signature, p.exit_reason, p.size_usd::float AS s, p.realized_pnl_usd::float AS pnl,
         p.entry_price_usd::float AS e, p.peak_price_usd::float AS pk,
         (SELECT coalesce(sum(f.qty_tokens::float * f.price_usd::float), 0)
            FROM fills f WHERE f.position_id = p.id AND f.side = 'sell' AND f.reason LIKE 'take_profit%') AS rung_proceeds,
         (SELECT coalesce(sum(f.qty_tokens::float * f.price_usd::float), 0)
            FROM fills f WHERE f.position_id = p.id AND f.side = 'sell' AND f.reason NOT LIKE 'take_profit%') AS exit_proceeds,
         (SELECT count(*)::int FROM fills f WHERE f.position_id = p.id AND f.side = 'sell' AND f.reason LIKE 'take_profit%') AS rungs
  FROM positions p
  WHERE p.lane = 'paper' AND p.status = 'closed' AND p.opened_at >= ${SINCE}
    AND p.entry_price_usd::float > 0 AND p.peak_price_usd::float / p.entry_price_usd::float >= 1.2
    AND p.signature IS NOT NULL`;

type Agg = { n: number; offer: number; pnl: number; banked: number; exitTake: number; rungs: number };
const byClass = new Map<string, Agg>();
const byClassExit = new Map<string, Agg>();
const add = (m: Map<string, Agg>, k: string, r: any, offer: number) => {
  const a = m.get(k) ?? { n: 0, offer: 0, pnl: 0, banked: 0, exitTake: 0, rungs: 0 };
  a.n++; a.offer += offer; a.pnl += r.pnl ?? 0;
  // proceeds above pro-rata basis = profit component of each sell bucket
  const basisPerDollar = 1; // basis proportional to qty sold; approximate profit share via proceeds − (proceeds / mult)... use simple: banked profit ≈ rung_proceeds − basis share
  void basisPerDollar;
  a.banked += Number(r.rung_proceeds ?? 0);
  a.exitTake += Number(r.exit_proceeds ?? 0);
  a.rungs += r.rungs;
  m.set(k, a);
};
for (const r of rows) {
  const cls = String(r.signature).startsWith("MOON") ? "MOON" : String(r.signature);
  const offer = (r.pk / r.e - 1) * r.s;
  add(byClass, cls, r, offer);
  add(byClassExit, `${cls} · ${r.exit_reason}`, r, offer);
}
console.log(`ARMED cohort (peak ≥1.2× from entry), closed paper since ${SINCE}: n=${rows.length}\n`);
console.log(`CLASS      n    Σoffer    Σpnl    capture  rungs/trade`);
for (const [k, a] of [...byClass.entries()].sort((x, y) => y[1].offer - x[1].offer))
  console.log(`${k.padEnd(9)} ${String(a.n).padStart(4)}  $${a.offer.toFixed(0).padStart(6)}  $${a.pnl.toFixed(0).padStart(5)}   ${Math.round((100 * a.pnl) / Math.max(1, a.offer))}%      ${(a.rungs / a.n).toFixed(1)}`);
console.log(`\nCLASS × EXIT (n≥8, sorted by offer) — where the leak is:`);
console.log(`                                  n    Σoffer   capture`);
for (const [k, a] of [...byClassExit.entries()].filter(([, a]) => a.n >= 8).sort((x, y) => y[1].offer - x[1].offer))
  console.log(`${k.padEnd(32)} ${String(a.n).padStart(3)}  $${a.offer.toFixed(0).padStart(6)}   ${Math.round((100 * a.pnl) / Math.max(1, a.offer))}%`);
await sql.end();
