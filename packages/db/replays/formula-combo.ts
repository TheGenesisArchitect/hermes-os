/**
 * FORMULA COMBINATION SWEEP (operator, 2026-08-02: "which combination will
 * yield the highest performance").
 *
 * PURPOSE
 *   Evaluate every combination of the QUALIFY terms on the rug-adjusted paper
 *   tape (same adjustment as formula-manifest.ts) and rank by TOTAL
 *   live-executable EV — with a cross-era stability check so a winner's-curse
 *   cell cannot be crowned. 1,296 combos are tested; the guard against
 *   overfitting is MIN_N, the canon-era replication column, and reporting the
 *   canon stack alongside so the winner is judged against the ratified formula.
 *
 * SUCCESS       A ranked table the operator can ratify a combination from.
 * FAILURE MODE  Small-n cells look heroic; anything under MIN_N is suppressed
 *               and the era-split column exposes one-window flukes.
 * OWNER         Data Science
 *
 * Run: npx tsx packages/db/replays/formula-combo.ts [sinceIso=2026-07-22]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(env)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const SINCE = process.argv.find((a) => /^\d{4}-/.test(a)) ?? "2026-07-22T04:00:00Z";
const ERA2 = "2026-07-29T00:00:00Z";
const DEAD_POOL_LIQ = 1200;
const TICK_MAX_AGE_S = 600;
const MIN_N = 80; // a combination rail needs more power than a single gate

type Row = {
  size: number; pnl: number; adj: number; opened: Date; sig: string | null;
  inflow: number | null; bs: number | null; poolTrig: number | null;
  wh: number | null; rh: number | null; venue: string | null;
};
const fmt = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(2);

(async () => {
  const q = postgres(url, { idle_timeout: 5 });
  const rows = (await q`
    WITH sells AS (
      SELECT f.position_id,
        sum(f.qty_tokens::float * f.price_usd::float) FILTER (WHERE lt.liq IS NOT NULL AND lt.liq < ${DEAD_POOL_LIQ}) phantom
      FROM fills f
      JOIN positions p ON p.id = f.position_id AND p.lane = 'paper' AND p.status = 'closed' AND p.opened_at >= ${SINCE}::timestamptz
      LEFT JOIN LATERAL (
        SELECT ct.liquidity_usd::float liq FROM candidate_ticks ct
        WHERE ct.mint = p.mint AND ct.snapped_at <= f.filled_at
          AND ct.snapped_at >= f.filled_at - make_interval(secs => ${TICK_MAX_AGE_S})
        ORDER BY ct.snapped_at DESC LIMIT 1) lt ON true
      WHERE f.side = 'sell' GROUP BY f.position_id)
    SELECT p.size_usd::float size, p.realized_pnl_usd::float pnl, p.opened_at opened,
      co.signature sig, co.liq_growth::float inflow, co.trigger_buy_share::float bs,
      co.wallet_winner_hits wh, co.wallet_rug_hits rh, tk.dex venue, pt.liq pool_trig,
      coalesce(s.phantom, 0) phantom
    FROM positions p
    LEFT JOIN candidate_outcomes co ON co.mint = p.mint
    LEFT JOIN tokens tk ON tk.mint = p.mint
    LEFT JOIN sells s ON s.position_id = p.id
    LEFT JOIN LATERAL (
      SELECT ct.liquidity_usd::float liq FROM candidate_ticks ct
      WHERE ct.mint = p.mint AND ct.snapped_at <= coalesce(co.triggered_at, p.opened_at)
        AND ct.snapped_at >= coalesce(co.triggered_at, p.opened_at) - interval '15 minutes'
      ORDER BY ct.snapped_at DESC LIMIT 1) pt ON true
    WHERE p.lane = 'paper' AND p.status = 'closed' AND p.opened_at >= ${SINCE}::timestamptz`).map((r: any): Row => ({
    size: Number(r.size), pnl: Number(r.pnl ?? 0), adj: Number(r.pnl ?? 0) - Number(r.phantom),
    opened: new Date(r.opened), sig: r.sig, inflow: r.inflow == null ? null : Number(r.inflow),
    bs: r.bs == null ? null : Number(r.bs), poolTrig: r.pool_trig == null ? null : Number(r.pool_trig),
    wh: r.wh, rh: r.rh, venue: r.venue,
  }));

  const P5 = new Set(["BASE", "MOON_SLOW", "MOON_FAST", "RISER", "MOON_VIOLENT"]);
  const C4 = new Set(["BASE", "RISER", "MOON_FAST", "MOON_VIOLENT"]);
  const P6 = new Set([...P5, "RUG_RISK"]);
  const V2 = new Set(["pumpswap", "fluxbeam"]);
  const V3 = new Set(["pumpswap", "fluxbeam", "meteora-damm-v2"]);

  const SIG: [string, (t: Row) => boolean][] = [
    ["sig:any", () => true],
    ["sig:core4", (t) => t.sig != null && C4.has(t.sig)],
    ["sig:prom5", (t) => t.sig != null && P5.has(t.sig)],
    ["sig:prom5+RR", (t) => t.sig != null && P6.has(t.sig)],
  ];
  const INF: [string, (t: Row) => boolean][] = [
    ["inf:any", () => true],
    ["inf:≥1.2", (t) => t.inflow == null || t.inflow >= 1.2],
    ["inf:1.2–2.05", (t) => t.inflow == null || (t.inflow >= 1.2 && t.inflow <= 2.05)],
  ];
  const BS: [string, (t: Row) => boolean][] = [
    ["bs:any", () => true],
    ["bs:≥.55∅ok", (t) => t.bs == null || t.bs >= 0.55],
    ["bs:≥.55strict", (t) => t.bs != null && t.bs >= 0.55],
    ["bs:≥.70∅ok", (t) => t.bs == null || t.bs >= 0.7],
  ];
  const POOL: [string, (t: Row) => boolean][] = [
    ["pool:any", () => true],
    ["pool:≥8k", (t) => t.poolTrig == null || t.poolTrig >= 8000],
    ["pool:≥13k", (t) => t.poolTrig == null || t.poolTrig >= 13000],
  ];
  const CROWD: [string, (t: Row) => boolean][] = [
    ["crowd:any", () => true],
    ["crowd:strict", (t) => (t.wh ?? 0) >= 1 && (t.rh ?? 0) === 0],
    ["crowd:net", (t) => (t.wh ?? 0) >= 1 && (t.wh ?? 0) > (t.rh ?? 0)],
  ];
  const VEN: [string, (t: Row) => boolean][] = [
    ["ven:any", () => true],
    ["ven:ps+fb", (t) => t.venue != null && V2.has(t.venue)],
    ["ven:ps+fb+damm", (t) => t.venue != null && V3.has(t.venue)],
  ];

  const era2 = new Date(ERA2);
  const days = (Date.now() - new Date(SINCE).getTime()) / 86_400_000;
  type Cell = { name: string; n: number; adj: number; evt: number; green: number; dead: number; n2: number; adj2: number; perDay: number };
  const cells: Cell[] = [];
  for (const [sn, sf] of SIG) for (const [inn, inf] of INF) for (const [bn, bf] of BS)
    for (const [pn, pf] of POOL) for (const [cn, cf] of CROWD) for (const [vn, vf] of VEN) {
      const g = rows.filter((t) => sf(t) && inf(t) && bf(t) && pf(t) && cf(t) && vf(t));
      if (g.length < MIN_N) continue;
      const adj = g.reduce((s, t) => s + t.adj, 0);
      const g2 = g.filter((t) => t.opened >= era2);
      cells.push({
        name: [sn, inn, bn, pn, cn, vn].join(" "),
        n: g.length, adj, evt: adj / g.length,
        green: g.filter((t) => t.adj > 0).length / g.length,
        dead: g.filter((t) => t.adj <= -0.85 * t.size).length / g.length,
        n2: g2.length, adj2: g2.reduce((s, t) => s + t.adj, 0),
        perDay: g.length / days,
      });
    }

  const show = (c: Cell) =>
    `${c.name.padEnd(74)} n=${String(c.n).padStart(4)} (${c.perDay.toFixed(0)}/d)  green ${Math.round(100 * c.green)}%  dead ${Math.round(100 * c.dead)}%  ADJ $${fmt(c.adj).padStart(9)}  /t $${fmt(c.evt).padStart(6)}  canon-era $${fmt(c.adj2).padStart(8)} (n=${c.n2})`;

  console.log(`COMBINATION SWEEP — ${rows.length} adjusted paper closes since ${SINCE.slice(0, 10)}; ${cells.length} combos ≥ n=${MIN_N}\n`);
  console.log("── TOP 14 BY TOTAL LIVE-EXECUTABLE EV (the wallet compounds dollars) ──");
  for (const c of [...cells].sort((a, b) => b.adj - a.adj).slice(0, 14)) console.log(show(c));
  console.log("\n── TOP 10 BY EV/TRADE (for slot-constrained at-bats) ──");
  for (const c of [...cells].sort((a, b) => b.evt - a.evt).slice(0, 10)) console.log(show(c));
  console.log("\n── REFERENCE STACKS ──");
  const ref = (label: string, names: string[]) => {
    const c = cells.find((x) => x.name === names.join(" "));
    console.log(c ? show(c).replace(c.name.padEnd(74), label.padEnd(74)) : `${label.padEnd(74)} (below n=${MIN_N})`);
  };
  ref("CANON QUALIFY (core4 · 1.2–2.05 · bs.55strict · 13k · strict crowd · any)", ["sig:core4", "inf:1.2–2.05", "bs:≥.55strict", "pool:≥13k", "crowd:strict", "ven:any"]);
  ref("WIDE-OPEN (everything)", ["sig:any", "inf:any", "bs:any", "pool:any", "crowd:any", "ven:any"]);
  await q.end();
})();
