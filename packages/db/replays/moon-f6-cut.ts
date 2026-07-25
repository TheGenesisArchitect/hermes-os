/**
 * MOON × F6 — sharpen the 🌙 alert bar with launch order.
 * Population: every 2★ MOON-class candidate since Jul 15 (the alert
 * fingerprint). Launch order computed retroactively (same 24h-window rule the
 * recorder stamps live). Outcome buckets post-trigger: FLEW (≥1.5× from
 * trigger), FIZZLED (<1.5×), RUG label.
 * Run: npx tsx packages/db/replays/moon-f6-cut.ts [since=2026-07-15]
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
  SELECT c.mint, c.peak_multiple::float AS peak, c.trigger_multiple::float AS trig, c.label,
         c.wallet_winner_hits AS wh, coalesce(c.wallet_rug_hits, 0) AS rh,
         lo.ord AS launch_order
  FROM candidate_outcomes c
  JOIN tokens t ON t.mint = c.mint
  CROSS JOIN LATERAL (
    SELECT count(DISTINCT c2.mint)::int + 1 AS ord
    FROM candidate_outcomes c2 JOIN tokens t2 ON t2.mint = c2.mint
    WHERE t2.symbol = t.symbol AND c2.mint <> c.mint
      AND c2.first_seen_at BETWEEN c.triggered_at - interval '24 hours' AND c.triggered_at
  ) lo
  WHERE c.stars = 2 AND c.signature LIKE 'MOON%' AND c.triggered_at IS NOT NULL
    AND c.first_seen_at >= ${SINCE} AND c.label <> 'open' AND c.trigger_multiple IS NOT NULL`;

type B = { n: number; flew: number; fizzled: number; rug: number; big: number };
const buckets = new Map<string, B>();
const keyOf = (o: number) => (o === 1 ? "L1" : o === 2 ? "L2" : o <= 4 ? "L3-4" : "L5+");
for (const r of rows) {
  const k = keyOf(Number(r.launch_order));
  const b = buckets.get(k) ?? { n: 0, flew: 0, fizzled: 0, rug: 0, big: 0 };
  b.n++;
  const postTrig = r.trig ? r.peak / r.trig : 1;
  if (r.label === "rug") b.rug++;
  if (postTrig >= 1.5) b.flew++; else b.fizzled++;
  if (postTrig >= 3) b.big++;
  buckets.set(k, b);
}
console.log(`2★ MOON alert population since ${SINCE}: n=${rows.length}\n`);
console.log(`launch    n    FLEW≥1.5×  fizzled   rug%   ≥3× moons`);
for (const k of ["L1", "L2", "L3-4", "L5+"]) {
  const b = buckets.get(k);
  if (!b) continue;
  console.log(`${k.padEnd(7)} ${String(b.n).padStart(4)}   ${String(Math.round((100 * b.flew) / b.n)).padStart(5)}%    ${Math.round((100 * b.fizzled) / b.n)}%     ${Math.round((100 * b.rug) / b.n)}%     ${b.big} (${Math.round((100 * b.big) / b.n)}%)`);
}
// Crowd overlay: deep clean crowd within each launch bucket.
console.log(`\nwith deep clean crowd (wh≥5, 0 rug-rep):`);
for (const k of ["L1", "L2", "L3-4", "L5+"]) {
  const sub = rows.filter((r) => keyOf(Number(r.launch_order)) === k && Number(r.wh ?? 0) >= 5 && Number(r.rh) === 0);
  if (!sub.length) { console.log(`${k.padEnd(7)}    0`); continue; }
  const flew = sub.filter((r) => (r.trig ? r.peak / r.trig : 1) >= 1.5).length;
  const rug = sub.filter((r) => r.label === "rug").length;
  console.log(`${k.padEnd(7)} ${String(sub.length).padStart(4)}   flew ${Math.round((100 * flew) / sub.length)}% · rug ${Math.round((100 * rug) / sub.length)}%`);
}
await sql.end();
