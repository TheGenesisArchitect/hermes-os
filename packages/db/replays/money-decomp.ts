/**
 * WHERE IS THE MONEY — the profit-decomposition loop.
 *
 * Born 2026-07-23 (operator: "We need constant Loop to understand why our
 * profits have dropped off so much since last week"). Profit = volume × size ×
 * edge. The 07-16/17 golden days ($780–975/day) came from ~1,000 trades/day in
 * a market HALF as rich as this week's; successive gates fixed edge (win% and
 * capture both up) while throughput fell ~10×. This loop attributes every
 * window's P&L delta to the factor that moved — so a quality problem is never
 * treated with volume, and a volume problem is never treated with more gates.
 *
 * Run: npx tsx packages/db/replays/money-decomp.ts [windowHours=24]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(env)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const HOURS = Number(process.argv[2] ?? 24);

interface Slice { n: number; sz: number; pnl: number; win: number; cap: number | null }

(async () => {
  const q = postgres(url);
  const slice = async (lane: string, fromH: number, toH: number): Promise<Slice> => {
    const [r] = (await q.unsafe(`
      SELECT count(*)::int n, coalesce(avg(size_usd),0)::float sz, coalesce(sum(realized_pnl_usd),0)::float pnl,
        coalesce(100.0*count(*) filter (where realized_pnl_usd>0)/nullif(count(*),0),0)::float win,
        (sum(realized_pnl_usd)/nullif(sum(size_usd*(greatest(peak_price_usd/nullif(entry_price_usd,0),1)-1)),0)*100)::float cap
      FROM positions WHERE status='closed' AND lane='${lane}' AND entry_price_usd > 0
        AND closed_at BETWEEN now() - interval '${fromH} hours' AND now() - interval '${toH} hours'`)) as unknown as Slice[];
    return r!;
  };
  const fmt = (s: Slice) =>
    `n=${String(s.n).padStart(4)} · avg $${s.sz.toFixed(2)} · pnl $${s.pnl.toFixed(2)} · win ${s.win.toFixed(0)}% · capture ${s.cap != null ? s.cap.toFixed(0) + "%" : "—"}`;

  for (const lane of ["paper", "live"]) {
    const now = await slice(lane, HOURS, 0);
    const base = await slice(lane, HOURS + 7 * 24, 7 * 24); // same window, one week earlier
    process.stdout.write(`${lane.toUpperCase()} — trailing ${HOURS}h vs same window last week\n`);
    process.stdout.write(`  now   ${fmt(now)}\n`);
    process.stdout.write(`  base  ${fmt(base)}\n`);
    // Attribution: ΔP&L ≈ Δvolume-at-base-econ + Δeconomics-at-current-volume
    const perTradeNow = now.n ? now.pnl / now.n : 0;
    const perTradeBase = base.n ? base.pnl / base.n : 0;
    const volEffect = (now.n - base.n) * perTradeBase;
    const edgeEffect = now.n * (perTradeNow - perTradeBase);
    process.stdout.write(
      `  Δpnl $${(now.pnl - base.pnl).toFixed(2)} = volume effect $${volEffect.toFixed(2)} (${now.n - base.n >= 0 ? "+" : ""}${now.n - base.n} trades) + edge effect $${edgeEffect.toFixed(2)} ($${perTradeBase.toFixed(2)}→$${perTradeNow.toFixed(2)}/trade)\n`,
    );
  }

  // The three cohorts capital should chase — deployment vs earnings.
  process.stdout.write(`\nCOHORTS (paper, trailing ${HOURS}h) — where capital is vs where money is:\n`);
  const rows = (await q.unsafe(`
    SELECT CASE WHEN co.liq_growth::float >= 1.30 THEN 'strong-band'
                WHEN co.wallet_winner_hits - co.wallet_rug_hits >= 1 THEN 'winner-rep sub-strong'
                ELSE 'other sub-strong' END cohort,
      count(*)::int n, coalesce(avg(p.size_usd),0)::float sz, coalesce(sum(p.realized_pnl_usd),0)::float pnl,
      coalesce(100.0*count(*) filter (where p.realized_pnl_usd>0)/nullif(count(*),0),0)::float win
    FROM positions p JOIN candidate_outcomes co ON co.mint = p.mint
    WHERE p.status='closed' AND p.lane='paper' AND p.closed_at > now() - interval '${HOURS} hours'
    GROUP BY 1 ORDER BY 4 DESC`)) as unknown as { cohort: string; n: number; sz: number; pnl: number; win: number }[];
  for (const r of rows)
    process.stdout.write(
      `  ${r.cohort.padEnd(22)} n=${String(r.n).padStart(4)} · avg $${r.sz.toFixed(2)} · pnl $${r.pnl.toFixed(2)} · win ${r.win.toFixed(0)}%\n`,
    );
  process.stdout.write(
    `rule of the loop: name the factor that moved (volume vs edge) before proposing any change — a quality problem is never treated with volume, a volume problem never with more gates.\n`,
  );

  // COVERAGE GROWTH (operator, 2026-07-24) — the wallet graph's verified share
  // of arrivals IS live's volume forecast: every point of coverage converts
  // sensor flow into live-fireable flow. Tracked daily so the compounding
  // asset is a first-class number, not a vibe.
  process.stdout.write(`\nWALLET-GRAPH COVERAGE — F1 crowd-pass share of settled arrivals, by day:\n`);
  const cov = (await q.unsafe(`
    SELECT date_trunc('day', first_seen_at - interval '4 hours') d,
      count(*)::int n,
      count(*) filter (where wallet_winner_hits >= 1 AND wallet_winner_hits - wallet_rug_hits >= 1)::int pass,
      count(*) filter (where wallet_winner_hits IS NOT NULL)::int read
    FROM candidate_outcomes
    WHERE first_seen_at > now() - interval '7 days' AND label IN ('winner','dud','rug')
    GROUP BY 1 ORDER BY 1`)) as unknown as { d: Date; n: number; pass: number; read: number }[];
  for (const c of cov)
    process.stdout.write(
      `  ${new Date(c.d).toISOString().slice(5, 10)}  arrivals ${String(c.n).padStart(5)} · graph-read ${String(Math.round((100 * c.read) / Math.max(c.n, 1))).padStart(3)}% · F1 crowd-pass ${String(Math.round((100 * c.pass) / Math.max(c.n, 1))).padStart(3)}%  (${c.pass} live-fireable)\n`,
    );
  process.stdout.write(`coverage rule: crowd-pass % rising = live's pipe widening; flat coverage with rising arrivals = the graph needs help (rep-scoring cadence, holder-snapshot depth).\n`);
  await q.end();
})();
