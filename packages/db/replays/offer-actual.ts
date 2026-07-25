/**
 * OFFER vs ACTUAL — the 15-minute performance clock (operator, 2026-07-23:
 * "now we monitor performance and see how our optimizations actually translate
 * to what we expect. Offer vs Actual, Paper vs Live, on a 15min clock").
 *
 * Per lane, per window: what the closed trades OFFERED at traded size
 * (size × (peak-from-entry − 1), the business stat behind the moon debriefs)
 * versus what we actually banked — capture, the term the whole day's
 * optimization stack was built to move. Open positions show as offer-forming.
 *
 * Run: npx tsx packages/db/replays/offer-actual.ts [windowMin=15]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(env)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const MIN = Number(process.argv[2] ?? 15);

(async () => {
  const q = postgres(url);
  for (const lane of ["paper", "live"]) {
    const [w] = (await q.unsafe(`
      SELECT count(*)::int n,
        coalesce(sum(GREATEST(size_usd::float * (peak_price_usd::float / nullif(entry_price_usd::float, 0) - 1), 0)), 0)::float offered,
        coalesce(sum(realized_pnl_usd::float), 0)::float actual,
        count(*) filter (where realized_pnl_usd > 0)::int wins
      FROM positions
      WHERE lane = '${lane}' AND status = 'closed' AND closed_at > now() - make_interval(mins => ${MIN})
        AND entry_price_usd > 0`)) as unknown as { n: number; offered: number; actual: number; wins: number }[];
    // Capture is only meaningful against a REAL offer — dividing a loss by a
    // near-zero offer manufactures absurdities (−305% on a $0.15 "offer",
    // operator-flagged 2026-07-25). Below $1 of window offer the stat is
    // undefined; the actual-P&L column already tells the entry-outcome story.
    const cap = w!.offered >= 1 ? (100 * w!.actual) / w!.offered : null;
    const [open] = (await q.unsafe(`
      SELECT count(*)::int n, coalesce(sum(size_usd::float), 0)::float deployed
      FROM positions WHERE lane = '${lane}' AND status = 'open'`)) as unknown as { n: number; deployed: number }[];
    process.stdout.write(
      `${lane === "live" ? "◆ LIVE " : "SIM    "}${String(w!.n).padStart(3)} closed · offered $${w!.offered.toFixed(2)} · actual ${w!.actual >= 0 ? "+" : "−"}$${Math.abs(w!.actual).toFixed(2)}` +
        `${cap != null ? ` · capture ${cap.toFixed(0)}%` : " · capture —"} · wins ${w!.wins}/${w!.n} · riding ${open!.n} ($${open!.deployed.toFixed(2)})\n`,
    );
  }
  // Names worth naming — the ±$3 doctrine, plus every live close.
  const notable = (await q.unsafe(`
    SELECT p.lane, tk.symbol, p.signature, p.size_usd::float size, p.realized_pnl_usd::float pnl,
      CASE WHEN p.entry_price_usd::float > 0 THEN p.peak_price_usd::float / p.entry_price_usd::float ELSE 1 END peakx,
      p.exit_reason
    FROM positions p LEFT JOIN tokens tk ON tk.mint = p.mint
    WHERE p.status = 'closed' AND p.closed_at > now() - make_interval(mins => ${MIN})
      AND (abs(p.realized_pnl_usd::float) >= 3 OR p.lane = 'live')
    ORDER BY p.realized_pnl_usd`)) as unknown as
    { lane: string; symbol: string | null; signature: string | null; size: number; pnl: number; peakx: number; exit_reason: string | null }[];
  for (const t of notable)
    process.stdout.write(
      `  ${t.lane === "live" ? "◆" : "·"} ${String(t.symbol ?? "?").slice(0, 10).padEnd(10)} ${String(t.signature ?? "?").padEnd(11)} $${t.size.toFixed(2)} → ${t.pnl >= 0 ? "+" : "−"}$${Math.abs(t.pnl).toFixed(2)} (peak ${t.peakx.toFixed(2)}×, ${t.exit_reason ?? "?"})\n`,
    );
  await q.end();
})();
