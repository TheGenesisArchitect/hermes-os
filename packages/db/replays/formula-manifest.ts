/**
 * THE FORMULA MANIFEST HARNESS (operator, 2026-08-02: "Lets build the winning
 * formula for live wallet").
 *
 * PURPOSE
 *   Paper is the laboratory; live inherits the winning architecture. This
 *   harness computes the promotion tables from paper's FULL tape, scored on
 *   LIVE-EXECUTABLE terms, and emits a draft manifest for operator ratification.
 *
 * THE RUG ADJUSTMENT (Module 6 caveat made arithmetic)
 *   Paper's fill model books orderly exits into pools that live cannot exit at
 *   all. So every paper SELL fill is re-read against the liquidity tape at its
 *   own fill time: liquidity below DEAD_POOL_LIQ ($1,200 — the ratified
 *   depth-collapse line) → the fill is a PHANTOM and its proceeds are $0.
 *   adjusted_pnl = booked_pnl − phantom_proceeds. A TP banked while the pool
 *   was provably alive stays banked; a "fill" into a drained pool does not.
 *   An unmeasurable read (no tick within 10 min) keeps the booked value —
 *   absence of measurement is not evidence — but is counted and reported.
 *
 * ENTRY-KNOWABLE ONLY (GTPED §10.1): signature, inflow, trigger buy share,
 *   pool at trigger, crowd hits, venue. No peak/final/minutes-to-peak fields.
 *
 * SUCCESS       Manifest tables reproduce on rerun; recommendation names total
 *               EV retained per gate choice (never per-trade EV alone).
 * FAILURE MODE  DEAD_POOL_LIQ misclassifies thin-but-alive fills as phantom;
 *               the unmeasured count is printed so the operator can weigh it.
 * OWNER         Data Science
 *
 * Run: npx tsx packages/db/replays/formula-manifest.ts [sinceIso=2026-07-22] [--write-draft]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(env)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const SINCE = process.argv.find((a) => /^\d{4}-/.test(a)) ?? "2026-07-22T04:00:00Z";
const ERA2 = "2026-07-29T00:00:00Z"; // the canon-formula fence (QUALIFY ratified)
const WRITE_DRAFT = process.argv.includes("--write-draft");
const DEAD_POOL_LIQ = 1200; // DEPTH_COLLAPSE_USD — the ratified "no exit at size" line
const TICK_MAX_AGE_S = 600;
const MIN_N = 30; // no under-powered sample defends a rail

type Row = {
  id: number; mint: string; symbol: string | null; venue: string | null;
  size: number; pnl: number; opened: Date; sig: string | null;
  inflow: number | null; bs: number | null; poolTrig: number | null;
  wh: number | null; rh: number | null; strict: number | null;
  phantom: number; unmeasured: number; adj: number;
};

const fmt = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(2);
const pct = (a: number, b: number) => (b > 0 ? Math.round((100 * a) / b) + "%" : "—");

function line(name: string, g: Row[]): string {
  if (!g.length) return `${name.padEnd(34)} n=0`;
  const green = g.filter((t) => t.adj > 0).length;
  const dead = g.filter((t) => t.adj <= -0.85 * t.size).length;
  const booked = g.reduce((s, t) => s + t.pnl, 0);
  const adj = g.reduce((s, t) => s + t.adj, 0);
  return `${name.padEnd(34)} n=${String(g.length).padStart(4)}  green ${pct(green, g.length).padStart(4)}  dead ${pct(dead, g.length).padStart(4)}  booked $${fmt(booked).padStart(9)}  ADJ $${fmt(adj).padStart(9)}  adjEV/t $${fmt(adj / g.length).padStart(6)}`;
}

(async () => {
  const q = postgres(url, { idle_timeout: 5 });
  console.log(`FORMULA MANIFEST — paper tape since ${SINCE}, rug-adjusted at $${DEAD_POOL_LIQ} dead-pool line\n`);

  // One pass: per-position phantom proceeds via a lateral tick read per sell fill.
  const rows = (await q`
    WITH sells AS (
      SELECT f.position_id,
        sum(f.qty_tokens::float * f.price_usd::float) FILTER (WHERE lt.liq IS NOT NULL AND lt.liq < ${DEAD_POOL_LIQ}) phantom,
        count(*) FILTER (WHERE lt.liq IS NULL) unmeasured
      FROM fills f
      JOIN positions p ON p.id = f.position_id AND p.lane = 'paper' AND p.status = 'closed' AND p.opened_at >= ${SINCE}::timestamptz
      LEFT JOIN LATERAL (
        SELECT ct.liquidity_usd::float liq FROM candidate_ticks ct
        WHERE ct.mint = p.mint AND ct.snapped_at <= f.filled_at
          AND ct.snapped_at >= f.filled_at - make_interval(secs => ${TICK_MAX_AGE_S})
        ORDER BY ct.snapped_at DESC LIMIT 1) lt ON true
      WHERE f.side = 'sell'
      GROUP BY f.position_id)
    SELECT p.id, p.mint, tk.symbol, tk.dex venue, p.size_usd::float size, p.realized_pnl_usd::float pnl,
      p.opened_at opened, co.signature sig, co.liq_growth::float inflow, co.trigger_buy_share::float bs,
      co.wallet_winner_hits wh, co.wallet_rug_hits rh, co.wallet_strict_hits strict,
      pt.liq pool_trig, coalesce(s.phantom, 0) phantom, coalesce(s.unmeasured, 0) unmeasured
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
    id: r.id, mint: r.mint, symbol: r.symbol, venue: r.venue,
    size: Number(r.size), pnl: Number(r.pnl ?? 0), opened: new Date(r.opened), sig: r.sig,
    inflow: r.inflow == null ? null : Number(r.inflow), bs: r.bs == null ? null : Number(r.bs),
    poolTrig: r.pool_trig == null ? null : Number(r.pool_trig),
    wh: r.wh, rh: r.rh, strict: r.strict,
    phantom: Number(r.phantom), unmeasured: Number(r.unmeasured),
    adj: Number(r.pnl ?? 0) - Number(r.phantom),
  }));

  const unmeasuredFills = rows.reduce((s, t) => s + t.unmeasured, 0);
  const phantomTotal = rows.reduce((s, t) => s + t.phantom, 0);
  console.log(line("BOOK (all paper closes)", rows));
  console.log(`  phantom proceeds zeroed: $${phantomTotal.toFixed(2)} across ${rows.filter((t) => t.phantom > 0).length} positions; unmeasurable sell fills kept at booked value: ${unmeasuredFills}\n`);

  const eras: [string, Row[]][] = [
    [`FULL ERA (since ${SINCE.slice(0, 10)})`, rows],
    [`CANON ERA (since ${ERA2.slice(0, 10)} — QUALIFY fence)`, rows.filter((t) => t.opened >= new Date(ERA2))],
  ];

  for (const [eraName, era] of eras) {
    console.log(`══ ${eraName} ══`);
    console.log("── SIGNATURE (the plug-in decision) ──");
    const sigs = [...new Set(era.map((t) => t.sig ?? "∅ unrouted"))].sort();
    for (const s of sigs) console.log(line(s, era.filter((t) => (t.sig ?? "∅ unrouted") === s)));
    console.log("── INFLOW BAND ──");
    const IB: [string, (t: Row) => boolean][] = [
      ["unmeasured", (t) => t.inflow == null],
      ["< 1.05", (t) => t.inflow != null && t.inflow < 1.05],
      ["1.05–1.20", (t) => t.inflow != null && t.inflow >= 1.05 && t.inflow < 1.2],
      ["1.20–1.30", (t) => t.inflow != null && t.inflow >= 1.2 && t.inflow < 1.3],
      ["1.30–2.05", (t) => t.inflow != null && t.inflow >= 1.3 && t.inflow <= 2.05],
      ["> 2.05", (t) => t.inflow != null && t.inflow > 2.05],
    ];
    for (const [n2, f] of IB) console.log(line(n2, era.filter(f)));
    console.log("── BUY SHARE AT TRIGGER ──");
    const BB: [string, (t: Row) => boolean][] = [
      ["unmeasured", (t) => t.bs == null],
      ["< 0.55", (t) => t.bs != null && t.bs < 0.55],
      ["0.55–0.70", (t) => t.bs != null && t.bs >= 0.55 && t.bs < 0.7],
      ["≥ 0.70", (t) => t.bs != null && t.bs >= 0.7],
    ];
    for (const [n2, f] of BB) console.log(line(n2, era.filter(f)));
    console.log("── POOL AT TRIGGER ──");
    const PB: [string, (t: Row) => boolean][] = [
      ["unmeasured", (t) => t.poolTrig == null],
      ["< $8k", (t) => t.poolTrig != null && t.poolTrig < 8000],
      ["$8k–13k", (t) => t.poolTrig != null && t.poolTrig >= 8000 && t.poolTrig < 13000],
      ["$13k–25k", (t) => t.poolTrig != null && t.poolTrig >= 13000 && t.poolTrig < 25000],
      ["≥ $25k", (t) => t.poolTrig != null && t.poolTrig >= 25000],
    ];
    for (const [n2, f] of PB) console.log(line(n2, era.filter(f)));
    console.log("── CROWD ──");
    const CB: [string, (t: Row) => boolean][] = [
      ["strict (≥1W, 0R)", (t) => (t.wh ?? 0) >= 1 && (t.rh ?? 0) === 0],
      ["net (W>R, R>0)", (t) => (t.wh ?? 0) >= 1 && (t.rh ?? 0) > 0 && (t.wh ?? 0) > (t.rh ?? 0)],
      ["anti (R≥W)", (t) => t.wh != null && (t.rh ?? 0) >= (t.wh ?? 0) && (t.rh ?? 0) > 0],
      ["unknown", (t) => t.wh == null],
    ];
    for (const [n2, f] of CB) console.log(line(n2, era.filter(f)));
    console.log("── VENUE ──");
    for (const v of [...new Set(era.map((t) => t.venue ?? "∅"))].sort())
      console.log(line(v, era.filter((t) => (t.venue ?? "∅") === v)));
    console.log("");
  }

  // FLOOR CHOICE — total EV retained per candidate floor (never per-trade EV).
  console.log("══ FLOOR CHOICE (full era) — what each candidate floor keeps and refuses ══");
  const total = rows.reduce((s, t) => s + t.adj, 0);
  const floorTable = (name: string, cands: [string, (t: Row) => boolean][]) => {
    console.log(`── ${name} ──`);
    for (const [label, keep] of cands) {
      const kept = rows.filter(keep);
      const refused = rows.filter((t) => !keep(t));
      const keptEv = kept.reduce((s, t) => s + t.adj, 0);
      const refGreens = refused.filter((t) => t.adj > 0).length;
      const refDead = refused.filter((t) => t.adj <= -0.85 * t.size).length;
      console.log(`${label.padEnd(30)} keeps n=${String(kept.length).padStart(4)} $${fmt(keptEv).padStart(9)} (${pct(Math.max(0, keptEv), Math.max(1e-9, Math.max(0, total)))} of book adj-EV)  refuses ${String(refused.length).padStart(4)}: ${refGreens} greens / ${refDead} dead`);
    }
  };
  floorTable("INFLOW FLOOR (unmeasured passes — absence isn't evidence)", [
    ["none", () => true],
    ["≥1.05", (t) => t.inflow == null || t.inflow >= 1.05],
    ["≥1.15", (t) => t.inflow == null || t.inflow >= 1.15],
    ["≥1.20 (canon)", (t) => t.inflow == null || t.inflow >= 1.2],
    ["≥1.30 (build-back)", (t) => t.inflow == null || t.inflow >= 1.3],
  ]);
  floorTable("BUY-SHARE FLOOR (canon refuses unmeasured)", [
    ["none", () => true],
    ["≥0.50, unmeasured passes", (t) => t.bs == null || t.bs >= 0.5],
    ["≥0.55, unmeasured passes", (t) => t.bs == null || t.bs >= 0.55],
    ["≥0.55, unmeasured REFUSED", (t) => t.bs != null && t.bs >= 0.55],
  ]);
  floorTable("POOL-AT-TRIGGER FLOOR", [
    ["none", () => true],
    ["≥$8k (live depth floor)", (t) => t.poolTrig == null || t.poolTrig >= 8000],
    ["≥$13k (canon cliff)", (t) => t.poolTrig == null || t.poolTrig >= 13000],
  ]);

  // SIGNATURE RECOMMENDATION — allowlist + weights from adjusted EV, canon era
  // preferred when powered, full era as fallback (a conviction expires with its
  // cause, but an n=8 era cannot convict either way).
  const canon = rows.filter((t) => t.opened >= new Date(ERA2));
  const rec: Record<string, { n: number; adjEv: number; evPerTrade: number; verdict: string; weight: number }> = {};
  for (const s of [...new Set(rows.map((t) => t.sig).filter(Boolean))] as string[]) {
    const eraRows = canon.filter((t) => t.sig === s).length >= MIN_N ? canon : rows;
    const g = eraRows.filter((t) => t.sig === s);
    const adjEv = g.reduce((x, t) => x + t.adj, 0);
    const evPerTrade = g.length ? adjEv / g.length : 0;
    const powered = g.length >= MIN_N;
    const verdict = !powered ? "insufficient-n" : adjEv > 0 ? "PROMOTE" : "paper-only";
    // Weight: adjusted EV/trade scaled against the promoted book's mean, clamped
    // to the Adaptive Policy range so sizing stays inside the ratified structure.
    rec[s] = { n: g.length, adjEv: Number(adjEv.toFixed(2)), evPerTrade: Number(evPerTrade.toFixed(3)), verdict, weight: 1 };
  }
  const promoted = Object.entries(rec).filter(([, v]) => v.verdict === "PROMOTE");
  const meanEv = promoted.length ? promoted.reduce((s, [, v]) => s + v.evPerTrade, 0) / promoted.length : 1;
  for (const [, v] of promoted) v.weight = Math.round(Math.min(1.5, Math.max(0.6, meanEv > 0 ? v.evPerTrade / meanEv : 1)) * 20) / 20;
  console.log("\n══ SIGNATURE RECOMMENDATION (draft — operator ratifies) ══");
  for (const [s, v] of Object.entries(rec).sort((a, b) => b[1].adjEv - a[1].adjEv))
    console.log(`${s.padEnd(16)} n=${String(v.n).padStart(4)}  adjEV $${fmt(v.adjEv).padStart(9)}  /trade $${fmt(v.evPerTrade).padStart(7)}  → ${v.verdict}${v.verdict === "PROMOTE" ? ` ×${v.weight.toFixed(2)}` : ""}`);

  if (WRITE_DRAFT) {
    const draft = {
      version: 1,
      computedAt: new Date().toISOString(),
      since: SINCE, canonEra: ERA2, deadPoolLiq: DEAD_POOL_LIQ, minN: MIN_N,
      book: { n: rows.length, bookedUsd: Number(rows.reduce((s, t) => s + t.pnl, 0).toFixed(2)), adjustedUsd: Number(total.toFixed(2)), phantomUsd: Number(phantomTotal.toFixed(2)) },
      signatures: rec,
      status: "DRAFT — not read by live; operator ratification required",
    };
    await q`INSERT INTO config (key, value) VALUES ('formula_manifest_draft', ${JSON.stringify(draft)}::jsonb)
            ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`;
    console.log("\n📝 draft manifest written to config key 'formula_manifest_draft' (live does NOT read it)");
  }
  await q.end();
})();
