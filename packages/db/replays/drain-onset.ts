/**
 * DRAIN ONSET — was the pool already draining when live entered?
 * For every live entry (24h): pre-entry depth slope (entry-tick liq vs the
 * liq 30-60s earlier) → outcome (insta-cut <60s vs survived to manage).
 * If the slope separates, a pre-entry depth-momentum guard closes the gap.
 * Run: npx tsx packages/db/replays/drain-onset.ts [hours=24]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);
const H = Number(process.argv[2] ?? 24);

const entries = await sql`
  SELECT p.id, t.symbol, p.mint, p.opened_at, p.size_usd::float AS s, p.realized_pnl_usd::float AS pnl,
         p.exit_reason, extract(epoch from (p.closed_at - p.opened_at)) AS hold
  FROM positions p JOIN tokens t ON t.mint = p.mint
  WHERE p.lane = 'live' AND p.opened_at > now() - interval '1 hour' * ${H} AND p.status = 'closed'
  ORDER BY p.opened_at`;
let n = 0;
const cells = { drainCut: 0, drainOk: 0, stableCut: 0, stableOk: 0 };
for (const e of entries) {
  const ticks = await sql`
    SELECT liquidity_usd::float AS liq, extract(epoch from (${e.opened_at}::timestamptz - snapped_at)) AS ago
    FROM candidate_ticks WHERE mint = ${e.mint}
      AND snapped_at BETWEEN ${e.opened_at}::timestamptz - interval '90 seconds' AND ${e.opened_at}
    ORDER BY snapped_at`;
  if (ticks.length < 2) continue;
  n++;
  const atEntry = ticks[ticks.length - 1]?.liq ?? 0;
  const earlier = ticks[0]?.liq ?? 0;
  const slope = earlier > 0 ? atEntry / earlier : 1;
  const draining = slope < 0.93; // depth already down >7% in the pre-entry window
  const instaCut = e.exit_reason === "depth_collapse_cut" && Number(e.hold) <= 90;
  if (draining && instaCut) cells.drainCut++;
  else if (draining && !instaCut) cells.drainOk++;
  else if (!draining && instaCut) cells.stableCut++;
  else cells.stableOk++;
  console.log(
    `${(e.symbol ?? "?").padEnd(11)} slope ${(slope * 100).toFixed(0)}% ($${Math.round(earlier / 1000)}k→$${Math.round(atEntry / 1000)}k) · held ${Number(e.hold).toFixed(0)}s · ${e.exit_reason} $${e.pnl.toFixed(2)}${draining ? " · DRAINING AT ENTRY" : ""}`,
  );
}
console.log(`\nn=${n} live entries with pre-entry tick coverage`);
console.log(`draining-at-entry → insta-cut: ${cells.drainCut} · draining → survived: ${cells.drainOk}`);
console.log(`stable-at-entry  → insta-cut: ${cells.stableCut} · stable → survived: ${cells.stableOk}`);
const sens = cells.drainCut + cells.stableCut > 0 ? Math.round((100 * cells.drainCut) / (cells.drainCut + cells.stableCut)) : 0;
const fp = cells.drainCut + cells.drainOk > 0 ? Math.round((100 * cells.drainOk) / (cells.drainCut + cells.drainOk)) : 0;
console.log(`guard would catch ${sens}% of insta-cuts · false-positive rate among flagged: ${fp}%`);
await sql.end();
