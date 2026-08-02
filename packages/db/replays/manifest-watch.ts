/**
 * MANIFEST COUNTERFACTUAL WATCH (ships with manifest v2, 2026-08-02).
 *
 * PURPOSE
 *   The desk law: counterfactual watch from day one. For every manifest
 *   decision — seat taken or candidate refused — report what actually
 *   happened: live outcomes by tier, and the paper twin's outcome for what
 *   the manifest refused. A refusal cohort that keeps printing paper green
 *   is the evidence that demotes a manifest term at the next ratification.
 *
 * SUCCESS       One table a day answers "did the manifest earn its refusals?"
 * FAILURE MODE  Paper counterfactuals are optimistic on the rug cohort
 *               (Module 6) — the dead% column carries that caveat, printed.
 * OWNER         Data Science
 *
 * Run: npx tsx packages/db/replays/manifest-watch.ts [hours=24]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(env)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const HOURS = Number(process.argv[2] ?? 24);
const fmt = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(2);

(async () => {
  const q = postgres(url, { idle_timeout: 5 });
  console.log(`MANIFEST WATCH — last ${HOURS}h\n`);

  // Seats taken, by tier, with live outcomes where closed.
  const seats = await q`
    SELECT al.details->>'tier' tier, count(*) seats,
      count(p.id) FILTER (WHERE p.status='closed') closed,
      round(sum(p.realized_pnl_usd) FILTER (WHERE p.status='closed')::numeric, 2) pnl,
      count(*) FILTER (WHERE p.status='closed' AND p.realized_pnl_usd > 0) greens,
      count(*) FILTER (WHERE p.exit_reason = 'live_unsellable') unsellable
    FROM audit_log al
    LEFT JOIN positions p ON p.lane='live' AND p.mint = al.details->>'mint'
      AND p.opened_at BETWEEN al.created_at - interval '2 minutes' AND al.created_at + interval '10 minutes'
    WHERE al.action = 'live_manifest_seat' AND al.created_at > now() - make_interval(hours => ${HOURS})
    GROUP BY 1 ORDER BY 1`;
  console.log("── SEATS TAKEN (live outcomes) ──");
  if (!seats.length) console.log("  none");
  for (const s of seats)
    console.log(`  ${String(s.tier).padEnd(7)} seats ${String(s.seats).padStart(3)}  closed ${String(s.closed).padStart(3)}  green ${s.closed > 0 ? Math.round((100 * Number(s.greens)) / Number(s.closed)) + "%" : "—"}  pnl $${s.pnl ?? "0.00"}  unsellable ${s.unsellable}`);

  // Manifest refusals, with the PAPER twin's outcome as counterfactual.
  const refused = await q`
    SELECT count(*) n,
      count(pp.id) FILTER (WHERE pp.status='closed') paper_closed,
      round(sum(100.0 * pp.realized_pnl_usd / nullif(pp.size_usd, 0)) FILTER (WHERE pp.status='closed')::numeric, 0) sum_ret_pct,
      count(*) FILTER (WHERE pp.status='closed' AND pp.realized_pnl_usd > 0) greens,
      count(*) FILTER (WHERE pp.status='closed' AND pp.realized_pnl_usd / nullif(pp.size_usd,0) <= -0.55) dead
    FROM audit_log al
    LEFT JOIN LATERAL (
      SELECT * FROM positions p2 WHERE p2.lane='paper' AND p2.mint = al.details->>'mint'
        AND p2.opened_at BETWEEN al.created_at - interval '30 minutes' AND al.created_at + interval '30 minutes'
      ORDER BY p2.opened_at LIMIT 1) pp ON true
    WHERE al.action = 'live_buy_skipped' AND al.details->>'reason' LIKE 'manifest v%'
      AND al.created_at > now() - make_interval(hours => ${HOURS})`;
  const r = refused[0];
  console.log("\n── MANIFEST REFUSALS (paper counterfactual — optimistic on the rug cohort, Module 6) ──");
  console.log(`  refused ${r.n}  paper-twin closed ${r.paper_closed}  greens ${r.greens}  dead ${r.dead}  Σ ret ${r.sum_ret_pct ?? 0}pp`);

  const reasons = await q`
    SELECT left(al.details->>'reason', 88) reason, count(*) n
    FROM audit_log al
    WHERE al.action = 'live_buy_skipped' AND al.details->>'reason' LIKE 'manifest v%'
      AND al.created_at > now() - make_interval(hours => ${HOURS})
    GROUP BY 1 ORDER BY n DESC LIMIT 12`;
  if (reasons.length) {
    console.log("\n── TOP REFUSAL REASONS ──");
    for (const x of reasons) console.log(`  ${String(x.n).padStart(4)}  ${x.reason}`);
  }
  await q.end();
})();
