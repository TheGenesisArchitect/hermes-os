/**
 * THE EXECUTION-PATH REPLAY ENGINE (operator, 2026-08-12: "we need the
 * Execution Engine to tune our Capture and Exit Strategies to be Adaptive").
 *
 * WHY THIS EXISTS (QTEA Module 6 gap: "no execution-path replay engine yet")
 *   The platform has decision-path harnesses (formula-manifest, formula-combo,
 *   deployer-edge) that answer "would a different ENTRY rule pick better
 *   trades?" — and one-off capture scripts (capture-replay, capture-harness)
 *   that answer "would a different EXIT geometry capture more?" as hardcoded
 *   variants. This engine generalizes the capture scripts into a proper
 *   sweep: the exit geometry becomes a SEARCHABLE CONFIG, swept over the full
 *   paper tape, scored on capture honesty, cross-era validated, ranked for
 *   operator ratification.
 *
 * THE QUESTION IT ANSWERS
 *   "Given we entered this trade, would a different exit/capture geometry have
 *   kept more of the peak — at a price live could actually get?" Selection is
 *   held FIXED (we replay the positions we actually took); only the EXIT PATH
 *   varies. That isolates capture from selection, the way a controlled
 *   experiment isolates one variable.
 *
 * THE FILL MODEL (inherited, liquidity-honest — do NOT loosen)
 *   · Fill at 0.95× the mark        (convex slippage on entry-side exits)
 *   · Fire-sale exits at 0.9× mark  (moon-leash realism)
 *   · Dead pool pays ZERO: a tick with pool liq < DEAD_POOL_LIQ means whatever
 *     is still held is worth $0 (the mark-freeze lesson — paper booked orderly
 *     exits into pools live could not exit at all; formula-manifest §6)
 *   · −45% floor binding           (the ratified max-loss rail)
 *
 * THE METRIC (from capture-harness — the lesson that fixed the Coco giveaway)
 *   Summed P&L LIES: a handful of monster runners swamps the round-trips in
 *   the body, so aggregate dollars cannot see a giveaway. PRIMARY is therefore
 *   MEDIAN per-trade capture = realizedMultiple / peakAvailableMultiple.
 *   SECONDARY is GIVEAWAY rate = printed ≥ GIVEAWAY_PEAK yet exited below
 *   entry. P&L is reported third, never optimized.
 *
 * CROSS-ERA GUARD (the canon anti-overfit standard)
 *   The book is split at ERA2 (the 2026-07-29 canon fence). A config must beat
 *   the baseline on BOTH eras to be ratified — a one-era win is a
 *   winner's-curse fluke, exactly what formula-combo's replication column was
 *   built to expose.
 *
 * SUCCESS       A ranked config table whose top cell beats the shipped
 *               baseline on median capture AND giveaway rate in BOTH eras.
 * FAILURE MODE  overfitting the sweep to one era; the era columns and the
 *               BOTH-eras requirement are the guard. MIN_N per cell.
 * OWNER         Data Science
 *
 * Run: npx tsx packages/db/replays/execution-path-replay.ts [sinceIso] [--top N]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(env)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const SINCE = process.argv.find((a) => /^\d{4}-/.test(a)) ?? "2026-07-15T00:00:00Z";
const TOP_N = Number(/^\d+$/.exec(process.argv.find((a) => a.startsWith("--top"))?.split(" ")[1] ?? "") ?? 0) || 18;
const ERA2 = new Date("2026-07-29T00:00:00Z"); // canon fence — replication era
const MIN_N = 30; // no under-powered sample defends a rail

// ── Fill-model constants (ratified; see header) ────────────────────────────
const FILL = 0.95; // convex slippage on fills
const FIRE_SALE = 0.9; // forced/trim exits fill below the mark
const DEAD_POOL_LIQ = 1000; // a tick below this = whatever is held pays $0
const FLOOR = 0.55; // −45% max-loss rail, binding
const ARM = 1.2; // a position is "green" / armed once it prints this
const GAIN_LOCK = 0.65; // fraction of (peak−1) the trail floor protects
const GIVEAWAY_PEAK = 1.5; // printed this and exited below entry = giveaway
const LOCK = 1.02; // profit-lock floor — never trail below entry once green

// ── Types ──────────────────────────────────────────────────────────────────
interface Tick { mm: number; liq: number | null; age: number }
interface Pos {
    id: number; sig: string; size: number; actual: number; peakx: number;
    opened: Date; ticks: Tick[];
}

/** One exit-geometry config — the thing the sweep searches over. */
interface Geometry {
    name: string;
    /** Take-profit ladder: [multiple, fractionToSell] per rung, in order. */
    tp: [number, number][];
    /** Trailing cap (% off peak) once armed. */
    trailCap: number;
    /** Optional ratchet: tighten the trail once peak ≥ ratchetAt. */
    ratchetAt?: number;
    ratchetCap?: number;
    /** Never-armed stop: if never printed ARM, cut at −naStopPct after naGraceMin. */
    naStopPct?: number;
    naGraceMin?: number;
    /** MOONBAG: fraction of the position exempted from the trail — held for the
     *  tail and only closed at window end. This is the basket-harvest logic:
     *  bank a base hit on the early rungs, then let a fixed slice ride for 100×. */
    moonbagFrac?: number;
    /** Trail-floor overrides (the leash). Default GAIN_LOCK / LOCK. Loosening
     *  these is what lets a runner survive the 1.6× pullback on the way to 16×. */
    gainLock?: number;
    lock?: number;
}

/** Outcome of replaying one position under one geometry. */
interface SimResult {
    realized: number; // dollars
    realizedMult: number; // realized / size + 1
    peakAvailable: number; // best mark seen while held
}

// ── The simulator (one position, one geometry) — pure ─────────────────────
function sim(p: Pos, g: Geometry): SimResult {
    const gainLock = g.gainLock ?? GAIN_LOCK;
    const lock = g.lock ?? LOCK;
    // The moonbag slice is carved off up front: the trail only manages the
    // non-moonbag remainder; the moonbag rides to window end (or a dead pool).
    const moonbag = Math.max(0, Math.min(0.9, g.moonbagFrac ?? 0));
    let held = 1 - moonbag; // trailed portion
    let bag = moonbag; // untrailed tail slice
    let realized = 0;
    let peak = 1;
    let armed = false;
    const tpDone = new Array(g.tp.length).fill(false);

    for (const t of p.ticks) {
        const dead = t.liq != null && t.liq < DEAD_POOL_LIQ;
        if (dead) break; // whatever is still held (trail + bag) pays ZERO — honest
        peak = Math.max(peak, t.mm);
        if (peak >= ARM) armed = true;

        // Max-loss floor — binding rail, fires before everything (whole position).
        if (t.mm <= FLOOR && held + bag > 0) {
            realized += p.size * (held + bag) * (t.mm * FILL - 1);
            held = 0; bag = 0;
            break;
        }

        // Take-profit rungs (drawn from the trailed portion first).
        for (let i = 0; i < g.tp.length; i++) {
            if (!tpDone[i] && t.mm >= g.tp[i]![0] && held > 0) {
                tpDone[i] = true;
                const frac = Math.min(held, g.tp[i]![1]);
                realized += p.size * frac * (t.mm * FILL - 1);
                held -= frac;
            }
        }

        // Never-armed stop (COW-type deaths: entry never printed ARM). Whole position.
        if (!armed && g.naStopPct != null && g.naGraceMin != null && t.age >= g.naGraceMin && t.mm <= 1 - g.naStopPct / 100 && held + bag > 0) {
            realized += p.size * (held + bag) * (t.mm * FIRE_SALE - 1);
            held = 0; bag = 0;
            break;
        }

        // Trailing floor (armed only, TRAILED PORTION ONLY — the bag is exempt).
        if (armed && held > 0) {
            const cap = g.ratchetAt != null && peak >= g.ratchetAt ? (g.ratchetCap ?? g.trailCap) : g.trailCap;
            const floor = Math.max(lock, 1 + (peak - 1) * gainLock, peak * (1 - cap / 100));
            if (t.mm <= floor) {
                realized += p.size * held * (t.mm * FIRE_SALE - 1);
                held = 0;
                // bag keeps riding — that is the entire point of the moonbag.
            }
        }
    }

    // Window end — close whatever remains (trailed remnant + moonbag) at the last
    // mark (dead-pool already enforced per tick).
    const last = p.ticks[p.ticks.length - 1];
    if (held + bag > 0 && last && !(last.liq != null && last.liq < DEAD_POOL_LIQ)) {
        realized += p.size * (held + bag) * (last.mm * FILL - 1);
    }
    return { realized, realizedMult: realized / p.size + 1, peakAvailable: peak };
}

// ── Geometry library (the search space) ────────────────────────────────────
// Baseline ladders by signature, inherited from the shipped config.
const BASE_LADDER: Record<string, [number, number][]> = {
    RISER: [[1.22, 0.2], [2.2, 0.25], [3.2, 0.25]],
    MOON_FAST: [[1.25, 0.2], [2.35, 0.2], [3.2, 0.2]],
    MOON_STEADY: [[1.25, 0.2], [2.35, 0.25], [3.2, 0.2]],
    BASE: [[1.22, 0.25], [2.0, 0.25], [3.0, 0.25]],
};
const ladderFor = (sig: string): [number, number][] => BASE_LADDER[sig] ?? BASE_LADDER.RISER!;

function geometryLibrary(): Geometry[] {
    const out: Geometry[] = [];
    // Baseline = shipped geometry, per-signature ladder, standard leash.
    out.push({ name: "BASELINE (shipped)", tp: [], trailCap: 28 });

    // ── THE CONVEX SWEEP — hunt the tail, don't protect the body ──
    // The baseline trails off at 65%-of-peak-gain (GAIN_LOCK) floored at 1.02 (LOCK).
    // In a moonshot market that floor is a CEILING. Sweep the leash looser so a
    // runner survives the pullback on the way to the tail.
    for (const gl of [0.5, 0.4, 0.3, 0.2])
        out.push({ name: `loose leash gl=${gl}`, tp: [], trailCap: 28, gainLock: gl, lock: 1.0 });

    // MOONBAG: bank a base hit early (pays the tax), exempt a fixed slice from the
    // trail, let it ride for the 100×. The basket-harvest geometry.
    for (const bag of [0.25, 0.4, 0.5]) {
        out.push({ name: `moonbag ${Math.round(bag * 100)}% gl=0.3`, tp: [], trailCap: 28, moonbagFrac: bag, gainLock: 0.3, lock: 1.0 });
        out.push({ name: `moonbag ${Math.round(bag * 100)}% gl=0.5`, tp: [], trailCap: 28, moonbagFrac: bag, gainLock: 0.5, lock: 1.0 });
    }

    // Tail-hold ladder: smaller tp0 (bank less early), higher later rungs, plus a
    // moonbag — maximum convexity. Compares the ladder path to the trail path.
    out.push({ name: "tail-ladder +bag40", tp: [[1.3, 0.1], [2.5, 0.15], [5.0, 0.2]], trailCap: 28, moonbagFrac: 0.4, gainLock: 0.3, lock: 1.0 });
    out.push({ name: "moon ladder-up", tp: [[1.25, 0.1], [3.2, 0.25], [4.5, 0.25]], trailCap: 28 });

    // Reference risk-geometry cells (kept from v1 so the table stays comparable).
    out.push({ name: "ratchet @1.8→20", tp: [], trailCap: 28, ratchetAt: 1.8, ratchetCap: 20 });
    out.push({ name: "na-stop −25@8m", tp: [], trailCap: 28, naStopPct: 25, naGraceMin: 8 });
    return out;
}

// ── Metrics ────────────────────────────────────────────────────────────────
interface Cell {
    name: string; n: number;
    medCapture: number; meanCapture: number;
    giveawayRate: number; pnl: number;
    /** Convex-capture: over the RUNNERS (peaked ≥3×), how much of the available
     *  peak did we actually bank? This is the moonshot metric — median capture
     *  on the body is noise; tail capture is where the 2×–1000× lives. */
    runnerN: number; tailCapture: number;
    // era-2 replication
    n2: number; medCapture2: number; giveaway2: number; pnl2: number; tailCapture2: number;
}

const median = (xs: number[]) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

// ── Main ───────────────────────────────────────────────────────────────────
(async () => {
    const q = postgres(url, { idle_timeout: 10 });
    console.log(`EXECUTION-PATH REPLAY ENGINE — paper tape since ${SINCE.slice(0, 10)}, capture-honest, era-split at ${ERA2.toISOString().slice(0, 10)}\n`);

    // Pull closed paper positions with their tick trajectories.
    const rows = await q`
    SELECT p.id, coalesce(p.signature,'BASE') sig, p.size_usd::float size,
      p.realized_pnl_usd::float actual, p.opened_at opened,
      CASE WHEN p.entry_price_usd::float > 0 THEN p.peak_price_usd::float/p.entry_price_usd::float ELSE 1 END peakx
    FROM positions p
    WHERE p.lane='paper' AND p.status='closed' AND p.opened_at >= ${SINCE}::timestamptz
    ORDER BY p.id`;

    const pos: Pos[] = [];
    for (const r of rows) {
        const ticks = await q`SELECT mark_multiple::float mm, liquidity_usd::float liq, age_minutes::float age
      FROM position_ticks WHERE position_id=${r.id} ORDER BY id`;
        if (ticks.length >= 3)
            pos.push({
                id: r.id, sig: r.sig, size: Number(r.size), actual: Number(r.actual), peakx: Number(r.peakx),
                opened: new Date(r.opened),
                ticks: ticks.map((t) => ({ mm: Number(t.mm), liq: t.liq == null ? null : Number(t.liq), age: Number(t.age) })),
            });
    }
    console.log(`Replayable positions (≥3 ticks): ${pos.length}  ·  era2 (≥${ERA2.toISOString().slice(0, 10)}): ${pos.filter((p) => p.opened >= ERA2).length}\n`);

    // Sweep the geometry library. A config with empty tp uses the per-signature
    // baseline ladder, resolved per position at sim time. Scored on the CONVEX
    // objective: summed P&L (the compounding) + tail capture on the runners.
    const RUNNER = 3.0; // peaked ≥3× = a runner; tail capture is measured on these
    const geos = geometryLibrary();
    const cells: Cell[] = [];
    for (const g of geos) {
        const evalGroup = (grp: Pos[]) => {
            const caps: number[] = [];
            const tailCaps: number[] = [];
            let pnl = 0, giveaways = 0;
            for (const p of grp) {
                const geo: Geometry = g.tp.length ? g : { ...g, tp: ladderFor(p.sig) };
                const r = sim(p, geo);
                pnl += r.realized;
                if (r.peakAvailable > 1) caps.push(r.realizedMult / r.peakAvailable);
                if (r.peakAvailable >= RUNNER) tailCaps.push(r.realizedMult / r.peakAvailable);
                if (r.peakAvailable >= GIVEAWAY_PEAK && r.realizedMult < 1) giveaways++;
            }
            return { caps, tailCaps, pnl, giveaways, n: grp.length };
        };
        const a = evalGroup(pos);
        const b = evalGroup(pos.filter((p) => p.opened >= ERA2));
        cells.push({
            name: g.name, n: a.n,
            medCapture: median(a.caps), meanCapture: a.caps.reduce((s, c) => s + c, 0) / (a.caps.length || 1),
            giveawayRate: a.n ? a.giveaways / a.n : 0, pnl: a.pnl,
            runnerN: a.tailCaps.length, tailCapture: median(a.tailCaps),
            n2: b.n, medCapture2: median(b.caps), giveaway2: b.n ? b.giveaways / b.n : 0, pnl2: b.pnl,
            tailCapture2: median(b.tailCaps),
        });
    }

    // Rank by era-consistent SUMMED P&L (the compounding objective), with tail
    // capture shown so a config can't buy P&L by quietly abandoning the runners.
    const baseline = cells.find((c) => c.name === "BASELINE (shipped)")!;
    const pct = (x: number) => (100 * x).toFixed(1) + "%";
    const money = (x: number) => (x >= 0 ? "+" : "-") + "$" + Math.abs(x).toFixed(0);
    const show = (c: Cell) =>
        `${c.name.padEnd(24)} n=${String(c.n).padStart(4)}  pnl ${money(c.pnl).padStart(8)}  tailCap ${pct(c.tailCapture).padStart(6)} (r=${String(c.runnerN).padStart(3)})  give ${pct(c.giveawayRate).padStart(6)}  │ era2 pnl ${money(c.pnl2).padStart(8)} tailCap ${pct(c.tailCapture2).padStart(6)} n=${c.n2}`;

    console.log(`BASELINE pnl ${money(baseline.pnl)} · tailCap ${pct(baseline.tailCapture)} (runners=${baseline.runnerN}) · giveaway ${pct(baseline.giveawayRate)}  (era2 pnl ${money(baseline.pnl2)} · tailCap ${pct(baseline.tailCapture2)})`);
    console.log(`\nRanked by summed P&L — the compounding objective. A config is shippable only if it beats baseline P&L in BOTH eras (era2 n≥${MIN_N}). Tail capture shows whether the gain came from the tail or from choking runners.\n`);
    const ranked = [...cells].sort((a, b) => b.pnl - a.pnl);
    for (const c of ranked.slice(0, TOP_N)) {
        const beatsAll = c.pnl > baseline.pnl;
        const beats2 = c.pnl2 > baseline.pnl2 && c.n2 >= MIN_N;
        const tailUp = c.tailCapture > baseline.tailCapture;
        const verdict = c.name === baseline.name ? "  (baseline)" : beatsAll && beats2 ? (tailUp ? "  ✓ BOTH ERAS · tail↑" : "  ✓ BOTH ERAS") : beatsAll ? "  ⚠ era1 only" : "";
        console.log(show(c) + verdict);
    }
    await q.end();
})();
