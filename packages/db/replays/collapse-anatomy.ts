/**
 * DEPTH-COLLAPSE ANATOMY — the adversary's move, dissected.
 * For every depth_collapse_cut + rungless dust_rug (the same attack, raced):
 * what did the board look like at entry, how fast came the drain, and what
 * did drained pools share that survivors didn't. The adjustment lives where
 * the separation is.
 * Run: npx tsx packages/db/replays/collapse-anatomy.ts [hours=24]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);
const HOURS = Number(process.argv[2] ?? 24);

const attacks = await sql`
  SELECT p.id, p.lane, t.symbol, p.mint, p.opened_at,
         extract(epoch from (p.closed_at - p.opened_at)) AS hold_sec,
         p.size_usd::float AS s, p.realized_pnl_usd::float AS pnl, p.exit_reason,
         c.signature, c.wallet_winner_hits AS wh, c.wallet_rug_hits AS rh,
         c.liq_growth::float AS lg, t.dex AS venue,
         (SELECT count(*)::int FROM positions p2 JOIN tokens t2 ON t2.mint = p2.mint
          WHERE t2.symbol = t.symbol AND p2.mint <> p.mint
            AND p2.opened_at BETWEEN p.opened_at - interval '90 minutes' AND p.opened_at) AS swarm_prior,
         (SELECT ct.liquidity_usd::float FROM candidate_ticks ct WHERE ct.mint = p.mint
            AND ct.snapped_at <= p.opened_at ORDER BY ct.snapped_at DESC LIMIT 1) AS entry_liq
  FROM positions p JOIN tokens t ON t.mint = p.mint LEFT JOIN candidate_outcomes c ON c.mint = p.mint
  WHERE p.closed_at > now() - interval '1 hour' * ${HOURS} AND p.status = 'closed'
    AND (p.exit_reason = 'depth_collapse_cut'
         OR (p.exit_reason IN ('dust_rug','delisted','live_unsellable')
             AND NOT EXISTS (SELECT 1 FROM fills f WHERE f.position_id = p.id AND f.side='sell' AND f.reason LIKE 'take_profit%')))
  ORDER BY p.opened_at`;
console.log(`ATTACKS (cuts + rungless drains), last ${HOURS}h: n=${attacks.length}\n`);
let swarmN = 0, fastN = 0;
const venues = new Map<string, number>();
const holds: number[] = [];
for (const a of attacks) {
  const swarm = Number(a.swarm_prior) > 0;
  if (swarm) swarmN++;
  const hold = Number(a.hold_sec);
  holds.push(hold);
  if (hold <= 180) fastN++;
  venues.set(String(a.venue ?? "?"), (venues.get(String(a.venue ?? "?")) ?? 0) + 1);
  console.log(
    `${a.lane === "live" ? "◆" : " "} ${(a.symbol ?? "?").padEnd(11)} $${a.s.toFixed(2).padStart(6)} → $${a.pnl.toFixed(2).padStart(7)} ` +
    `held ${hold.toFixed(0).padStart(4)}s · pool@entry $${a.entry_liq ? Math.round(a.entry_liq / 1000) + "k" : "?"} · lg ${a.lg?.toFixed(2) ?? "—"} · crowd ${a.wh ?? "?"}W/${a.rh ?? "?"}R · ` +
    `${a.venue ?? "?"}${swarm ? ` · SWARM(+${a.swarm_prior} same-ticker prior)` : ""}`,
  );
}
holds.sort((x, y) => x - y);
console.log(`\nSHARED ANATOMY:`);
console.log(`  same-ticker swarm membership: ${swarmN}/${attacks.length} (${Math.round((100 * swarmN) / Math.max(1, attacks.length))}%)`);
console.log(`  drained within 180s of entry: ${fastN}/${attacks.length} · median hold ${holds[Math.floor(holds.length / 2)]?.toFixed(0)}s`);
console.log(`  venues: ${[...venues.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v}:${n}`).join(" · ")}`);

// Control: qualified entries in the window that did NOT drain — swarm membership rate.
const [ctrl] = await sql`
  SELECT count(*)::int AS n,
         count(*) FILTER (WHERE (SELECT count(*) FROM positions p2 JOIN tokens t2 ON t2.mint = p2.mint
           WHERE t2.symbol = t.symbol AND p2.mint <> p.mint
             AND p2.opened_at BETWEEN p.opened_at - interval '90 minutes' AND p.opened_at) > 0)::int AS swarm
  FROM positions p JOIN tokens t ON t.mint = p.mint
  WHERE p.closed_at > now() - interval '1 hour' * ${HOURS} AND p.status = 'closed'
    AND p.exit_reason NOT IN ('depth_collapse_cut','dust_rug','delisted','live_unsellable')`;
console.log(`  CONTROL (non-drained closes): swarm membership ${ctrl.swarm}/${ctrl.n} (${Math.round((100 * ctrl.swarm) / Math.max(1, ctrl.n))}%)`);
// Swarm-position P&L split: first-in-swarm vs later entries.
const [swarmSplit] = await sql`
  SELECT round(sum(p.realized_pnl_usd::float) FILTER (WHERE sp.prior = 0)::numeric, 2) AS first_pnl,
         count(*) FILTER (WHERE sp.prior = 0)::int AS first_n,
         round(sum(p.realized_pnl_usd::float) FILTER (WHERE sp.prior >= 2)::numeric, 2) AS late_pnl,
         count(*) FILTER (WHERE sp.prior >= 2)::int AS late_n
  FROM positions p JOIN tokens t ON t.mint = p.mint
  CROSS JOIN LATERAL (SELECT (SELECT count(*)::int FROM positions p2 JOIN tokens t2 ON t2.mint = p2.mint
    WHERE t2.symbol = t.symbol AND p2.mint <> p.mint
      AND p2.opened_at BETWEEN p.opened_at - interval '90 minutes' AND p.opened_at) AS prior) sp
  WHERE p.closed_at > now() - interval '1 hour' * ${HOURS} AND p.status = 'closed' AND p.lane = 'paper'`;
console.log(`\nSWARM ORDER EFFECT (paper, ${HOURS}h): first-of-ticker n=${swarmSplit.first_n} $${swarmSplit.first_pnl} · 3rd-or-later n=${swarmSplit.late_n} $${swarmSplit.late_pnl}`);
await sql.end();
