/**
 * SIGNATURE CONSOLE — every genome class: its dials vs its current-market tape.
 *
 * Born 2026-07-24 (operator: "take a look at the Signature console and
 * determine if we have sidelined anything"). For each signature over the
 * window: how much flow arrived, how much we boarded, what the boarded book
 * paid, and what the SIDELINED remainder (refused / snap-waited / probe-shrunk)
 * went on to offer. Sidelining levers surfaced: genome size mult, minSnap bar,
 * live class blocklist.
 *
 * Run: npx tsx packages/db/replays/signature-console.ts [windowHours=48]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const envf = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(envf)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const sql = postgres(url);
const HOURS = Number(process.argv[2] ?? 48);

// Flow + outcomes per signature (armed candidates, freshest routed signature).
const flow = await sql`
  SELECT signature,
         count(*)::int AS triggered,
         count(*) FILTER (WHERE entered)::int AS entered,
         count(*) FILTER (WHERE label = 'winner')::int AS winners,
         count(*) FILTER (WHERE label = 'rug')::int AS rugs,
         round(avg(peak_multiple::float / NULLIF(trigger_multiple::float,0))::numeric, 2) AS avg_offer,
         count(*) FILTER (WHERE NOT entered AND peak_multiple::float / NULLIF(trigger_multiple::float,0) >= 1.15)::int AS sidelined_viable
  FROM candidate_outcomes
  WHERE triggered_at > now() - interval '1 hour' * ${HOURS}
    AND signature IS NOT NULL AND trigger_multiple IS NOT NULL
  GROUP BY signature ORDER BY triggered DESC`;

// Booked P&L per signature × lane.
const pnl = await sql`
  SELECT c.signature, p.lane,
         count(*)::int AS n,
         round(sum(p.realized_pnl_usd::float)::numeric, 2) AS pnl,
         count(*) FILTER (WHERE p.realized_pnl_usd::float > 0)::int AS wins
  FROM positions p JOIN candidate_outcomes c ON c.mint = p.mint
  WHERE p.opened_at > now() - interval '1 hour' * ${HOURS} AND p.closed_at IS NOT NULL
    AND c.signature IS NOT NULL
  GROUP BY c.signature, p.lane ORDER BY c.signature, p.lane`;

// Snap-bar WAIT refusals per class (the per-class confirmation bar sideline).
const snaps = await sql`
  SELECT split_part(details->>'reason', ' ', 1) AS signature, count(DISTINCT details->>'mint')::int AS mints
  FROM audit_log
  WHERE action = 'entry_filtered' AND details->>'reason' LIKE '%snap%< required%'
    AND created_at > now() - interval '1 hour' * ${HOURS}
  GROUP BY 1 ORDER BY mints DESC`;

console.log(`── SIGNATURE FLOW & OUTCOMES (last ${HOURS}h) ──────────────────────────────`);
console.log(`class         trig  entered  win%  rug%  avgOffer  sidelined-viable`);
for (const r of flow) {
  const labeled = r.winners + r.rugs > 0 ? r.triggered : 0;
  console.log(
    `${String(r.signature).padEnd(12)} ${String(r.triggered).padStart(5)} ${String(r.entered).padStart(8)}  ${labeled ? String(Math.round((100 * r.winners) / r.triggered)).padStart(3) : "  —"}%  ${labeled ? String(Math.round((100 * r.rugs) / r.triggered)).padStart(3) : "  —"}%  ${String(r.avg_offer ?? "—").padStart(7)}×  ${String(r.sidelined_viable).padStart(6)}`,
  );
}
console.log(`\n── BOOKED P&L (closed, by class × lane) ───────────────────────────────────`);
for (const r of pnl) console.log(`${String(r.signature).padEnd(12)} ${r.lane === "live" ? "◆LIVE" : "  SIM"}  n=${String(r.n).padStart(3)}  ${r.wins}/${r.n} wins  $${r.pnl}`);
console.log(`\n── SNAP-BAR WAITS (per-class confirmation sideline) ───────────────────────`);
for (const r of snaps) console.log(`${String(r.signature).padEnd(12)} ${r.mints} mints held at the bar`);
await sql.end();
