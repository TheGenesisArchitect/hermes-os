/**
 * LIVE-RECEIPT REPLAY — validation that does not depend on the paper lane.
 *
 * PURPOSE
 *   Every replay harness we own runs on paper data, and paper's fill model
 *   books orderly exits on positions live cannot exit at all (it prices
 *   against a DexScreener liquidity read that lags an LP pull). So the
 *   substrate we validate against is biased for exactly the failure mode
 *   killing the live wallet: a fix can pass every harness in the repo and
 *   still be wrong on live.
 *
 *   This reconstructs each live trade from ITS OWN RECEIPTS — real tx
 *   signatures, real fill prices, real fees, against the real tick tape — and
 *   derives the fill function EMPIRICALLY from what the chain actually paid us.
 *   No paper marks anywhere in the loop.
 *
 * SUCCESS METRIC
 *   An execution change can be A/B'd against recorded live reality before it
 *   ships. GTPED §5 Replay-Before-Repair, made real.
 *
 * FAILURE MODE
 *   Thin samples. Live has few fills, so the empirical model is reported with
 *   n on every bucket and refuses to extrapolate past its support.
 *
 * OWNER
 *   Execution Team
 *
 * USAGE
 *   npx tsx packages/db/replays/live-receipt-replay.ts [days=10]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))?.[1]?.trim()
  ?? "postgres://hermes:hermes@localhost:5433/hermes";
const sql = postgres(url);
const DAYS = Number(process.argv[2] ?? 10);

// ─────────────────────────────────────────────────────────────────────────────
// STAGE 1 — THE EMPIRICAL FILL MODEL
// For every REAL live sell: what did the tape say the token was worth at that
// instant, and what did the chain actually pay us? That ratio, bucketed by the
// pool depth we sold into, IS our fill function. It replaces paper's
// convexSlippagePct — which is theoretically depth-aware but fed a lagging
// liquidity number, and therefore optimistic precisely when it matters.
// ─────────────────────────────────────────────────────────────────────────────
interface Receipt {
  position_id: number; reason: string; qty: number; fill_px: number;
  tape_px: number | null; tape_liq: number | null; tape_age_s: number | null;
  notional: number; filled_at: Date; sig: string | null;
}

const receipts = (await sql`
  SELECT f.position_id, f.reason, f.qty_tokens::float AS qty, f.price_usd::float AS fill_px,
         f.tx_signature AS sig, f.filled_at,
         (f.qty_tokens::float * f.price_usd::float) AS notional,
         (SELECT ct.price_usd::float FROM candidate_ticks ct
           WHERE ct.mint = p.mint AND ct.snapped_at <= f.filled_at
           ORDER BY ct.snapped_at DESC LIMIT 1) AS tape_px,
         (SELECT ct.liquidity_usd::float FROM candidate_ticks ct
           WHERE ct.mint = p.mint AND ct.snapped_at <= f.filled_at
           ORDER BY ct.snapped_at DESC LIMIT 1) AS tape_liq,
         (SELECT extract(epoch from (f.filled_at - ct.snapped_at)) FROM candidate_ticks ct
           WHERE ct.mint = p.mint AND ct.snapped_at <= f.filled_at
           ORDER BY ct.snapped_at DESC LIMIT 1) AS tape_age_s
  FROM fills f JOIN positions p ON p.id = f.position_id
  WHERE p.lane = 'live' AND f.side = 'sell'
    AND f.filled_at > now() - ${`${DAYS} days`}::interval
    AND f.tx_signature IS NOT NULL`) as unknown as Receipt[];

const usable = receipts.filter((r) => r.tape_px != null && Number(r.tape_px) > 0);
const ratio = (r: Receipt) => Number(r.fill_px) / Number(r.tape_px);

const med = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

console.log(`\n${"=".repeat(96)}`);
console.log(`LIVE-RECEIPT REPLAY — ${DAYS}d · ${receipts.length} live sell receipts (${usable.length} with tape coverage)`);
console.log(`Ground truth: real tx signatures, real fill prices, real tape. No paper marks.`);
console.log(`${"=".repeat(96)}`);

console.log(`\nSTAGE 1 — EMPIRICAL FILL MODEL  (fill ÷ tape, by the pool depth we sold into)`);
console.log(`  ${"pool depth at fill".padEnd(24)} ${"n".padStart(4)} ${"median".padStart(8)} ${"mean".padStart(8)} ${"p10".padStart(8)} ${"zero-fills".padStart(11)}`);
const DEPTH_BINS: [string, number, number][] = [
  ["< $2k (pulled/dust)", 0, 2_000],
  ["$2k – $8k", 2_000, 8_000],
  ["$8k – $15k", 8_000, 15_000],
  ["$15k – $30k", 15_000, 30_000],
  [">= $30k", 30_000, Infinity],
];
for (const [label, lo, hi] of DEPTH_BINS) {
  const b = usable.filter((r) => Number(r.tape_liq ?? 0) >= lo && Number(r.tape_liq ?? 0) < hi);
  if (!b.length) continue;
  const rs = b.map(ratio).sort((a, b2) => a - b2);
  const zero = b.filter((r) => ratio(r) < 0.01).length;
  console.log(
    `  ${label.padEnd(24)} ${String(b.length).padStart(4)} ${med(rs).toFixed(3).padStart(8)}` +
    ` ${(rs.reduce((s, x) => s + x, 0) / rs.length).toFixed(3).padStart(8)}` +
    ` ${rs[Math.floor(rs.length * 0.1)]!.toFixed(3).padStart(8)} ${`${zero}/${b.length}`.padStart(11)}`,
  );
}

console.log(`\n  by exit reason:`);
const byReason = new Map<string, Receipt[]>();
for (const r of usable) byReason.set(r.reason, [...(byReason.get(r.reason) ?? []), r]);
for (const [reason, rs] of [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const v = rs.map(ratio);
  console.log(`    ${reason.padEnd(20)} n=${String(rs.length).padStart(3)}  median fill/tape ${med(v).toFixed(3)}  zero ${rs.filter((r) => ratio(r) < 0.01).length}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// STAGE 2 — PER-TRADE EV LEAKAGE
// Decompose each live position into where value was lost, using only receipts.
//   offered  = best price the TAPE showed while we held (what was reachable)
//   decided  = tape price at the moment the exit fired (decision quality)
//   filled   = what the chain actually paid  (execution quality)
// ─────────────────────────────────────────────────────────────────────────────
interface Pos {
  id: number; mint: string; symbol: string | null; signature: string | null;
  size: number; entry: number; opened_at: Date; closed_at: Date | null;
  exit_reason: string | null; pnl: number;
}
const positions = (await sql`
  SELECT p.id, p.mint, t.symbol, p.signature, p.size_usd::float AS size,
         p.entry_price_usd::float AS entry, p.opened_at, p.closed_at,
         p.exit_reason, p.realized_pnl_usd::float AS pnl
  FROM positions p LEFT JOIN tokens t ON t.mint = p.mint
  WHERE p.lane='live' AND p.status='closed'
    AND p.closed_at > now() - ${`${DAYS} days`}::interval
    AND p.entry_price_usd::float > 0
  ORDER BY p.closed_at DESC`) as unknown as Pos[];

let evOffered = 0, evAtDecision = 0, evFilled = 0, n = 0;
const rows: string[] = [];

for (const p of positions) {
  const ticks = (await sql`
    SELECT price_usd::float AS px, liquidity_usd::float AS liq, snapped_at
    FROM candidate_ticks WHERE mint=${p.mint}
      AND snapped_at BETWEEN ${p.opened_at}::timestamptz AND ${p.closed_at}::timestamptz
    ORDER BY snapped_at`) as unknown as { px: number; liq: number; snapped_at: Date }[];
  if (ticks.length < 2) continue;
  const fills = usable.filter((r) => r.position_id === p.id);
  if (!fills.length) continue;
  n++;

  const bestTape = Math.max(...ticks.map((t) => Number(t.px)));
  const lastTick = ticks[ticks.length - 1]!;
  const offeredX = bestTape / p.entry;            // reachable at the tape's best
  const decidedX = Number(lastTick.px) / p.entry; // tape when the exit fired
  const filledX = fills.reduce((s, f) => s + Number(f.qty) * Number(f.fill_px), 0)
    / Math.max(fills.reduce((s, f) => s + Number(f.qty), 0), 1e-9) / p.entry;

  evOffered += p.size * (offeredX - 1);
  evAtDecision += p.size * (decidedX - 1);
  evFilled += p.size * (filledX - 1);

  if (rows.length < 15) {
    rows.push(
      `  ${String(p.id).padStart(5)} ${String(p.symbol ?? "?").slice(0, 10).padEnd(10)}` +
      ` ${String(p.exit_reason ?? "").slice(0, 15).padEnd(15)}` +
      ` offered ${offeredX.toFixed(2).padStart(6)}  decided ${decidedX.toFixed(2).padStart(6)}` +
      `  filled ${filledX.toFixed(2).padStart(6)}  pnl ${p.pnl.toFixed(2).padStart(7)}`,
    );
  }
}

console.log(`\nSTAGE 2 — EV LEAKAGE  (${n} live positions with full receipt + tape coverage)`);
console.log(rows.join("\n"));
console.log(`\n  ${"stage".padEnd(34)} ${"EV ($)".padStart(10)}   ${"leak vs prior".padStart(14)}`);
console.log(`  ${"A  offered by the tape (best)".padEnd(34)} ${evOffered.toFixed(2).padStart(10)}`);
console.log(`  ${"B  tape price when we decided".padEnd(34)} ${evAtDecision.toFixed(2).padStart(10)}   ${(evAtDecision - evOffered).toFixed(2).padStart(14)}  <- DECISION (timing)`);
console.log(`  ${"C  what the chain actually paid".padEnd(34)} ${evFilled.toFixed(2).padStart(10)}   ${(evFilled - evAtDecision).toFixed(2).padStart(14)}  <- EXECUTION (fill)`);
console.log(`\n  Decision leak  A→B : ${(evAtDecision - evOffered).toFixed(2)}`);
console.log(`  Execution leak B→C : ${(evFilled - evAtDecision).toFixed(2)}`);
console.log(`  TOTAL          A→C : ${(evFilled - evOffered).toFixed(2)}`);

// ─────────────────────────────────────────────────────────────────────────────
// STAGE 3 — SNIPER A/B, from receipts only
// Did the pre-signed path actually fill better than the fallback path?
// This is the first honest test of commit 5676fbe (shipped on reasoning).
// ─────────────────────────────────────────────────────────────────────────────
const sniperPids = new Set(((await sql`
  SELECT DISTINCT (details->>'positionId')::int AS pid FROM audit_log
  WHERE action='live_presigned_fired' AND created_at > now() - ${`${DAYS} days`}::interval`) as unknown as { pid: number }[]).map((r) => r.pid));
const fallbackPids = new Set(((await sql`
  SELECT DISTINCT (details->>'positionId')::int AS pid FROM audit_log
  WHERE action='live_presigned_fallback' AND created_at > now() - ${`${DAYS} days`}::interval`) as unknown as { pid: number }[]).map((r) => r.pid));

console.log(`\nSTAGE 3 — SNIPER A/B  (fill ÷ tape, by path actually taken)`);
for (const [label, set] of [["sniper fired", sniperPids], ["fallback path", fallbackPids]] as const) {
  const rs = usable.filter((r) => set.has(r.position_id)).map(ratio);
  if (!rs.length) { console.log(`  ${label.padEnd(16)} n=0 — no receipts`); continue; }
  console.log(`  ${label.padEnd(16)} n=${String(rs.length).padStart(3)}  median ${med(rs).toFixed(3)}  mean ${(rs.reduce((s, x) => s + x, 0) / rs.length).toFixed(3)}`);
}
console.log(`\n  ⚠️  CONFIDENCE: report n on every line above. Live sample sizes are small;`);
console.log(`  a bucket under ~20 receipts cannot carry a claim about a rail.`);
await sql.end();
