/**
 * PIPE CENSUS — the operator's throughput question, measured.
 *
 * Born 2026-07-24 (operator: "how many viable opportunities show up every hour
 * that have the potential to capture 15-40% of a move. We have 24 slots... We
 * allocate 1.5 to 2% of the account balance... It was designed for explosive
 * exponential growth that now has turned into a stalled trader").
 *
 * VIABLE = confirmed-demand candidate (triggeredAt set) whose post-trigger run
 * offered ≥15% (peak/trigger ≥ 1.15). Measured per hour: arrivals, viable,
 * taken, slot occupancy, clip size vs the 1.5-2% mandate, and WHAT refused the
 * viable ones we missed.
 *
 * Run: npx tsx packages/db/replays/pipe-census.ts [windowHours=48]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(env)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const sql = postgres(url);
const HOURS = Number(process.argv[2] ?? 48);

// ── 1. Hourly opportunity flow ──────────────────────────────────────────────
const flow = await sql`
  WITH trig AS (
    SELECT mint, triggered_at,
           peak_multiple::float / NULLIF(trigger_multiple::float, 0) AS offer_mult,
           entered, label
    FROM candidate_outcomes
    WHERE triggered_at > now() - interval '1 hour' * ${HOURS}
      AND trigger_multiple IS NOT NULL
  )
  SELECT
    count(*)::int                                                  AS arrivals,
    count(*) FILTER (WHERE offer_mult >= 1.15)::int                AS viable15,
    count(*) FILTER (WHERE offer_mult >= 1.40)::int                AS viable40,
    count(*) FILTER (WHERE offer_mult >= 1.15 AND entered)::int    AS viable_taken,
    count(*) FILTER (WHERE entered)::int                           AS taken,
    count(*) FILTER (WHERE offer_mult >= 1.15 AND label = 'rug')::int AS viable_rugs
  FROM trig`;
const f = flow[0];
const perHr = (x: number) => (x / HOURS).toFixed(1);
console.log(`── OPPORTUNITY FLOW (last ${HOURS}h) ─────────────────────────────`);
console.log(`arrivals (confirmed demand):     ${f.arrivals}  (${perHr(f.arrivals)}/hr)`);
console.log(`VIABLE ≥15% post-trigger offer:  ${f.viable15}  (${perHr(f.viable15)}/hr)  [${f.viable_rugs} later labeled rug]`);
console.log(`  of which ≥40% offer:           ${f.viable40}  (${perHr(f.viable40)}/hr)`);
console.log(`taken (any):                     ${f.taken}  (${perHr(f.taken)}/hr)`);
console.log(`viable AND taken:                ${f.viable_taken}  → we board ${f.viable15 ? Math.round((100 * f.viable_taken) / f.viable15) : 0}% of the viable flow`);

// ── 2. Slot occupancy: concurrent paper positions, sampled hourly ───────────
const occ = await sql`
  WITH hours AS (
    SELECT generate_series(date_trunc('hour', now()) - interval '1 hour' * (${HOURS} - 1),
                           date_trunc('hour', now()), interval '1 hour') AS h)
  SELECT round(avg(c.n), 1) AS avg_open, max(c.n)::int AS max_open
  FROM hours
  CROSS JOIN LATERAL (
    SELECT count(*)::int AS n FROM positions p
    WHERE p.lane = 'paper' AND p.opened_at <= hours.h
      AND (p.closed_at IS NULL OR p.closed_at > hours.h)) c`;
console.log(`\n── SLOT OCCUPANCY (24 available) ────────────────────────────────`);
console.log(`avg concurrent paper positions:  ${occ[0].avg_open}   peak: ${occ[0].max_open}   utilization: ${Math.round((100 * Number(occ[0].avg_open)) / 24)}%`);

// ── 3. Clip size vs the 1.5-2% mandate ──────────────────────────────────────
const clip = await sql`
  SELECT round(avg(size_usd::float)::numeric, 2) AS avg_clip,
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY size_usd::float)::numeric, 2) AS med_clip,
         round(max(size_usd::float)::numeric, 2) AS max_clip,
         count(*)::int AS n
  FROM positions WHERE lane = 'paper' AND opened_at > now() - interval '1 hour' * ${HOURS}`;
const bank = await sql`
  SELECT value FROM config WHERE key = 'paper_bankroll_now'`.catch(() => [] as { value: unknown }[]);
console.log(`\n── CLIP SIZE (mandate: 1.5-2% of balance) ───────────────────────`);
console.log(`paper opens ${clip[0].n}: avg $${clip[0].avg_clip} · median $${clip[0].med_clip} · max $${clip[0].max_clip}${bank[0] ? ` · bankroll ${JSON.stringify(bank[0].value)}` : ""}`);

// ── 4. What refused the viable-missed — audit reasons ranked ────────────────
const refusals = await sql`
  WITH missed AS (
    SELECT mint, triggered_at FROM candidate_outcomes
    WHERE triggered_at > now() - interval '1 hour' * ${HOURS}
      AND trigger_multiple IS NOT NULL AND NOT entered
      AND peak_multiple::float / NULLIF(trigger_multiple::float, 0) >= 1.15)
  SELECT a.action, count(DISTINCT a.details->>'mint')::int AS mints,
         min(a.details->>'reason') AS example
  FROM audit_log a JOIN missed m ON a.details->>'mint' = m.mint
    AND a.created_at BETWEEN m.triggered_at - interval '5 min' AND m.triggered_at + interval '30 min'
  WHERE a.action IN ('entry_filtered','entry_sensor_tier','entry_recovered_tier','entry_crowd_unknown_refused',
                     'live_buy_skipped','entry_wallet_antigate','never_arm')
  GROUP BY a.action ORDER BY mints DESC`;
console.log(`\n── WHAT REFUSED THE VIABLE-MISSED (distinct mints, ranked) ──────`);
for (const r of refusals) console.log(`${String(r.mints).padStart(4)}  ${r.action}  e.g. ${String(r.example ?? "").slice(0, 90)}`);

// ── 5. The forgone P&L: viable-missed at a 15-40% capture band ──────────────
const forgone = await sql`
  SELECT count(*)::int AS n,
         round(sum(least(peak_multiple::float / NULLIF(trigger_multiple::float,0), 1.40) - 1.0)::numeric, 1) AS sum_offer_mult
  FROM candidate_outcomes
  WHERE triggered_at > now() - interval '1 hour' * ${HOURS}
    AND trigger_multiple IS NOT NULL AND NOT entered
    AND peak_multiple::float / NULLIF(trigger_multiple::float, 0) >= 1.15
    AND label <> 'rug'`;
console.log(`\n── FORGONE (non-rug viable-missed, offer capped at 1.40×) ───────`);
console.log(`${forgone[0].n} trades · Σ capped offer ${forgone[0].sum_offer_mult}× — at a $40 clip and 30% capture ≈ $${Math.round(Number(forgone[0].sum_offer_mult) * 40 * 0.3)} left on the table`);

await sql.end();
