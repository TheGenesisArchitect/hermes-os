/**
 * MOON MATH — uniform-lot replay of a named moon wave + the scaling arithmetic.
 *
 * Born 2026-07-24 (operator: "All lot sizes the same lets run a replay with all
 * 6 of these opportunities accepted at a 3.50-5.00 trade size... work out the
 * Math"). For each mint: the actual fill (entry, exits, rungs) re-based to a
 * uniform lot, plus what the move offered AFTER our exit — the ride-gap the
 * exponential math depends on.
 *
 * Run: npx tsx packages/db/replays/moon-math.ts mint1,mint2,... [lotUsd=4.25]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const envf = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(envf)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const sql = postgres(url);
const frags = (process.argv[2] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const LOT = Number(process.argv[3] ?? 4.25);

let totalPnl = 0;
let n = 0;
for (const frag of frags) {
  const [c] = await sql`
    SELECT c.mint, t.symbol, c.peak_multiple::float AS cand_peak, c.trigger_multiple::float AS trig,
           c.minutes_to_peak::float AS m2p, c.label
    FROM candidate_outcomes c JOIN tokens t ON t.mint = c.mint
    WHERE c.mint LIKE ${"%" + frag + "%"} ORDER BY c.first_seen_at DESC LIMIT 1`;
  if (!c) { console.log(`?? ${frag} not found`); continue; }
  const [p] = await sql`
    SELECT p.id, p.size_usd::float AS size, p.realized_pnl_usd::float AS pnl,
           p.entry_price_usd::float AS e, p.peak_price_usd::float AS pk, p.exit_reason, p.closed_at
    FROM positions p WHERE p.mint = ${c.mint} AND p.lane = 'paper'
    ORDER BY p.opened_at DESC LIMIT 1`;
  // What the candidate did AFTER the position closed: max tick multiple post-exit
  // relative to the position's entry price — the unridden remainder.
  let postExit: number | null = null;
  if (p?.closed_at && p.e) {
    const [mx] = await sql`
      SELECT max(price_usd::float) AS mx FROM candidate_ticks
      WHERE mint = ${c.mint} AND snapped_at > ${p.closed_at}`;
    postExit = mx?.mx ? mx.mx / p.e : null;
  }
  if (p) {
    const scaled = (p.pnl / p.size) * LOT;
    totalPnl += scaled; n++;
    console.log(
      `${String(c.symbol).padEnd(10)} ${c.mint.slice(0, 4)}… cand-peak ${String(c.cand_peak?.toFixed(2)).padStart(6)}× @${c.m2p?.toFixed(0)}m · filled $${p.size.toFixed(2)} → $${p.pnl.toFixed(2)} (${p.exit_reason}) · ran ${(p.pk && p.e ? p.pk / p.e : NaN).toFixed(2)}× from entry` +
      ` · AT $${LOT}: $${scaled.toFixed(2)}` +
      (postExit && postExit > 1.2 ? ` · POST-EXIT the token ran to ${postExit.toFixed(2)}× of our entry — unridden` : ""),
    );
  } else {
    console.log(`${String(c.symbol).padEnd(10)} ${c.mint.slice(0, 4)}… cand-peak ${c.cand_peak?.toFixed(2)}× — NO FILL (would need entry sim)`);
  }
}
console.log(`\nWAVE at uniform $${LOT} lots: ${n} filled → $${totalPnl.toFixed(2)} on $${(n * LOT).toFixed(2)} deployed (${((100 * totalPnl) / (n * LOT)).toFixed(1)}% per wave)`);
await sql.end();
