/**
 * CONTINUATION REPLAY — how much of the post-exit run is actually harvestable?
 *
 * The 2026-07-22 capture dissection found $5,076 of post-exit continuation
 * against $378 of in-hold peak offered on 100 trades: tokens we exit correctly
 * keep running. Exit tuning cannot touch this (replay-proven ±1-3pp); the only
 * honest instrument is RE-ENTRY at a fresh confirm. This replay measures:
 *
 *   1. Of clean exits (profit_trail / stale_take / runner_timeout, peak ≥1.2),
 *      how many RE-CONFIRMED within 45 minutes — a post-exit trough followed by
 *      a ≥15% snap with buy-share ≥0.5 on the tick (the router's confirm shape).
 *   2. What a standard-size re-entry at the re-confirm tick would have paid
 *      under the standard trail (arm 1.2×, 65% gain-lock) on the real tape.
 *   3. How much the EXISTING re-arm machinery already harvested (actual
 *      re-entries on the same mint after the exit) — the replay's control.
 *
 * Run: npx tsx packages/db/replays/continuation-replay.ts [windowHours=24]
 * Read-only; prints a report and never writes state.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(env)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";

const WINDOW_H = Number(process.argv[2] ?? 24);
const RECONFIRM_SNAP = 0.15; // ≥15% off the post-exit trough
const RECONFIRM_MAX_MIN = 45;
const SIZE = 10; // standard paper size for the hypothetical
const ARM = 1.2;
const LOCK = 0.65;

interface Tick { m: number; bs: number | null; at: Date }

function simTrail(marks: number[]): number {
  let peak = 1, armed = false;
  for (const m of marks) {
    peak = Math.max(peak, m);
    if (!armed && peak >= ARM) armed = true;
    if (armed) {
      const floor = Math.max(1.02, 1 + (peak - 1) * LOCK);
      if (m <= floor) return m;
    }
  }
  return marks.length ? (marks[marks.length - 1] as number) : 1;
}

(async () => {
  const q = postgres(url);
  const trades = await q`
    SELECT p.id, p.mint, tk.symbol, p.signature, p.exit_reason,
      p.entry_price_usd::float entry, p.exit_price_usd::float exitp,
      p.peak_price_usd::float / nullif(p.entry_price_usd::float,0) peak,
      p.realized_pnl_usd::float pnl, p.closed_at as "closedAt"
    FROM positions p LEFT JOIN tokens tk ON tk.mint = p.mint
    WHERE p.lane='paper' AND p.status='closed' AND p.signature IS NOT NULL
      AND p.closed_at > now() - make_interval(hours => ${WINDOW_H})
      AND p.exit_reason IN ('profit_trail','stale_take','runner_timeout')
      AND p.peak_price_usd::float / nullif(p.entry_price_usd::float,0) >= 1.2
    ORDER BY p.closed_at`;

  let reconfirmed = 0, harvestPnl = 0, harvestWins = 0, blockedNoTape = 0;
  let alreadyHarvested = 0, alreadyPnl = 0;
  const bySig = new Map<string, { n: number; rc: number; pnl: number }>();
  const examples: string[] = [];

  for (const t of trades) {
    const sig = String(t.signature);
    const agg = bySig.get(sig) ?? { n: 0, rc: 0, pnl: 0 };
    agg.n++;
    // The control: did the existing re-arm machinery already re-enter?
    const [re] = await q`SELECT count(*)::int n, coalesce(sum(realized_pnl_usd),0)::float8 pnl FROM positions
      WHERE mint=${t.mint} AND lane='paper' AND opened_at > ${t.closedAt}
        AND opened_at < ${t.closedAt}::timestamptz + interval '45 minutes'`;
    if (re && re.n > 0) { alreadyHarvested++; alreadyPnl += re.pnl; }

    const ticksRaw = await q`SELECT price_usd::float p, buy_share_m5::float bs, snapped_at at FROM candidate_ticks
      WHERE mint=${t.mint} AND snapped_at > ${t.closedAt}
        AND snapped_at < ${t.closedAt}::timestamptz + make_interval(mins => ${RECONFIRM_MAX_MIN + 60})
      ORDER BY snapped_at`;
    if (ticksRaw.length < 3) { blockedNoTape++; bySig.set(sig, agg); continue; }
    const exitP = Number(t.exitp) > 0 ? Number(t.exitp) : Number(t.entry);
    const ticks: Tick[] = ticksRaw.map((r) => ({ m: Number(r.p) / exitP, bs: r.bs == null ? null : Number(r.bs), at: r.at }));

    // Re-confirm scan: trough after exit, then ≥15% snap with healthy buy share,
    // inside the window.
    let trough = ticks[0]!.m, entryIdx = -1;
    for (let i = 1; i < ticks.length; i++) {
      const tk = ticks[i]!;
      const minutes = (tk.at.getTime() - new Date(t.closedAt).getTime()) / 60_000;
      if (minutes > RECONFIRM_MAX_MIN) break;
      trough = Math.min(trough, tk.m);
      if (trough > 0 && tk.m / trough - 1 >= RECONFIRM_SNAP && (tk.bs == null || tk.bs >= 0.5)) { entryIdx = i; break; }
    }
    if (entryIdx < 0) { bySig.set(sig, agg); continue; }

    reconfirmed++;
    agg.rc++;
    const reEntry = ticks[entryIdx]!.m;
    const later = ticks.slice(entryIdx + 1).map((x) => x.m / reEntry);
    const exitMult = simTrail(later);
    const pnl = SIZE * (exitMult - 1);
    harvestPnl += pnl;
    agg.pnl += pnl;
    if (pnl > 0) harvestWins++;
    if (examples.length < 8)
      examples.push(
        `${String(t.symbol).slice(0, 10).padEnd(10)} ${sig.padEnd(11)} exited ${Number(t.peak).toFixed(2)}x → reconfirm +${((ticks[entryIdx]!.m / trough - 1) * 100).toFixed(0)}% → sim ${exitMult.toFixed(2)}x → ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
      );
    bySig.set(sig, agg);
  }

  const lines = [
    `CONTINUATION REPLAY — ${WINDOW_H}h window, ${trades.length} clean exits (peak ≥1.2)`,
    `re-confirmed within ${RECONFIRM_MAX_MIN}m: ${reconfirmed} (${trades.length ? ((100 * reconfirmed) / trades.length).toFixed(0) : 0}%) · no post-exit tape: ${blockedNoTape}`,
    `hypothetical harvest @$${SIZE}/re-entry, standard trail: ${harvestPnl >= 0 ? "+" : ""}$${harvestPnl.toFixed(2)} (${harvestWins}/${reconfirmed} wins)`,
    `already harvested by existing re-arm: ${alreadyHarvested} re-entries, ${alreadyPnl >= 0 ? "+" : ""}$${alreadyPnl.toFixed(2)} — the replay's control`,
    `by signature:`,
    ...[...bySig.entries()]
      .sort((a, b) => b[1].pnl - a[1].pnl)
      .map(([s, a]) => `  ${s.padEnd(12)} exits ${String(a.n).padStart(3)} · reconfirms ${String(a.rc).padStart(3)} · sim ${a.pnl >= 0 ? "+" : ""}$${a.pnl.toFixed(2)}`),
    `examples:`,
    ...examples.map((e) => `  ${e}`),
    ``,
    `VERDICT RULE: ship a re-entry change only if sim harvest is positive, wins ≥55%,`,
    `and the existing re-arm control is NOT already capturing the same pool.`,
  ];
  process.stdout.write(lines.join("\n") + "\n");
  await q.end();
})();
