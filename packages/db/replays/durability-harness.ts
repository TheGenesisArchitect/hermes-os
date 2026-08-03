/**
 * C3 DURABILITY HARNESS (approved plan step 2). The 150s pre-entry depth
 * signature (formula-harness C3 math) scored on rug-adjusted EV, MARGINAL to
 * the crowd term (W>R) it will sit beside in manifest v3.
 * Run: npx tsx packages/db/replays/durability-harness.ts
 */
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(env)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]!; };
(async () => {
  const q = postgres(url, { idle_timeout: 5 });
  const rows = (await q`
    WITH sells AS (
      SELECT f.position_id, sum(f.qty_tokens::float*f.price_usd::float)
        FILTER (WHERE lt.liq IS NOT NULL AND lt.liq < 1200) ph
      FROM fills f JOIN positions p ON p.id=f.position_id AND p.lane='paper' AND p.status='closed'
        AND p.opened_at >= now() - interval '14 days'
      LEFT JOIN LATERAL (SELECT ct.liquidity_usd::float liq FROM candidate_ticks ct
        WHERE ct.mint=p.mint AND ct.snapped_at<=f.filled_at AND ct.snapped_at>=f.filled_at-interval '600 seconds'
        ORDER BY ct.snapped_at DESC LIMIT 1) lt ON true
      WHERE f.side='sell' GROUP BY 1)
    SELECT p.id, p.mint, p.size_usd::float sz, p.opened_at o,
      p.realized_pnl_usd::float - coalesce(s.ph,0) adj,
      co.wallet_winner_hits wh, co.wallet_rug_hits rh
    FROM positions p LEFT JOIN candidate_outcomes co ON co.mint=p.mint
    LEFT JOIN sells s ON s.position_id=p.id
    WHERE p.lane='paper' AND p.status='closed' AND p.opened_at >= now() - interval '14 days'`) as unknown as
    { id: number; mint: string; sz: number; o: Date; adj: number; wh: number | null; rh: number | null }[];
  type R = { adj: number; sz: number; crowd: boolean; c3: boolean | null };
  const out: R[] = [];
  for (const p of rows) {
    const ticks = (await q`SELECT liquidity_usd::float l FROM candidate_ticks
      WHERE mint=${p.mint} AND snapped_at BETWEEN ${p.o}::timestamptz - interval '150 seconds' AND ${p.o}
      ORDER BY snapped_at`) as unknown as { l: number }[];
    const ls = ticks.map((x) => Number(x.l)).filter((x) => x > 0);
    let c3: boolean | null = null;
    if (ls.length >= 4) {
      const h = Math.floor(ls.length / 2);
      const rise = med(ls.slice(h)) / med(ls.slice(0, h));
      let worst = 1;
      for (let i = 1; i < ls.length - 1; i++) {
        const m = med([ls[i - 1]!, ls[i]!, ls[i + 1]!]);
        worst = Math.min(worst, Math.min(ls[i]!, m) / Math.max(ls[i]!, m));
      }
      c3 = worst >= 0.85 && rise >= 0.95;
    }
    out.push({ adj: p.adj, sz: p.sz, crowd: (p.wh ?? 0) >= 1 && (p.wh ?? 0) > (p.rh ?? 0), c3 });
  }
  const line = (n2: string, g: R[]) => {
    const t = g.reduce((s, x) => s + x.adj, 0);
    const dead = g.filter((x) => x.adj <= -0.85 * x.sz).length;
    console.log(`${n2.padEnd(34)} n=${String(g.length).padStart(4)}  dead ${g.length ? Math.round((100 * dead) / g.length) : 0}%  adjEV $${t.toFixed(2).padStart(9)}  /t $${(g.length ? t / g.length : 0).toFixed(2)}`);
  };
  console.log(`C3 DURABILITY × CROWD (paper, 14d rug-adjusted, n=${out.length})`);
  line("C3 PASS (all)", out.filter((x) => x.c3 === true));
  line("C3 FAIL (all)", out.filter((x) => x.c3 === false));
  line("C3 unmeasured", out.filter((x) => x.c3 === null));
  line("crowd W>R alone", out.filter((x) => x.crowd));
  line("crowd + C3 PASS  ← the v3 elite", out.filter((x) => x.crowd && x.c3 === true));
  line("crowd + C3 FAIL  ← what v3 cuts", out.filter((x) => x.crowd && x.c3 === false));
  await q.end();
})();
