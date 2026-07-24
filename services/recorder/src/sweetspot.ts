import { auditLog, config, db } from "@hermes/db";
import { sql } from "drizzle-orm";
import type { EntryTriggerConfig } from "@hermes/core";

// ─────────────────────────────────────────────────────────────────────────────
// THE SWEETSPOT FINDER (operator, 2026-07-23: "the data can reflect where the
// sweetspot is in the current regime — a sweetspot finder at any moment of the
// day").
//
// The boarding band started as a constant (1.35–1.65) fitted to this week's
// tape. But the sweetspot is a property of the CURRENT regime — the golden
// days filled at a 1.29× median, today's hot tape qualified at 1.77×, and
// tomorrow's market will pick its own number. So the band is now a rolling
// MEASUREMENT: every refresh, bucket the trailing day's closed routed trades
// by their trigger multiple and let realized expectancy choose the widest
// contiguous run of buckets that pays. The measurement moves the band; hard
// rails bound how far it can wander.
//
//   • Buckets: [1.30,1.45) [1.45,1.65) [1.65,1.90) [1.90,2.20)
//   • A bucket qualifies when n ≥ SWEETSPOT_MIN_N and avg P&L/trade > 0.
//   • Band = widest contiguous run of qualifying buckets containing at least
//     one of the two core buckets (≤1.65 — the historically proven seat).
//   • Fallback: static CONFIRM_MIN_MULT/CONFIRM_MAX_MULT when nothing
//     qualifies or the sample is thin — an unmeasured hour never widens risk.
//   • Hard rails: lo never below 1.30, hi never above 2.20, and the band is
//     applied by MUTATING the recorder's live triggerCfg (evaluate reads the
//     fields per call). Transition-only audit (sweetspot_band) — no log spam.
// ─────────────────────────────────────────────────────────────────────────────

const EDGES = [1.3, 1.45, 1.65, 1.9, 2.2] as const;
// THE CANON SEAT CEILING (Formula v2, ratified 2026-07-24 after the model
// run): the finder's first widening to 2.2 — fit on a chase-flattered 24h
// expectancy — admitted 4 of the 07-23 atomic deaths (triggers 1.70–2.14×).
// Outer buckets stay MEASURED as evidence; the band tightens inside the seat,
// never widens past it. Week ledger: ≤1.65 earned $870 of $1,013.
const SEAT_MAX = 1.65;

interface Bucket {
  lo: number;
  hi: number;
  n: number;
  pnl: number;
}

let lastApplied: { lo: number; hi: number } | null = null;

export async function refreshSweetspot(
  opts: { minN: number; windowHours: number; staticLo: number; staticHi: number },
  triggerCfg: EntryTriggerConfig,
): Promise<void> {
  const rows = (await db.execute(sql`
    SELECT co.trigger_multiple::float t, p.realized_pnl_usd::float pnl
    FROM positions p JOIN candidate_outcomes co ON co.mint = p.mint
    WHERE p.lane = 'paper' AND p.status = 'closed' AND p.signature IS NOT NULL
      AND p.closed_at > now() - make_interval(hours => ${opts.windowHours})
      AND co.trigger_multiple IS NOT NULL`)) as unknown as { t: number; pnl: number }[];

  const buckets: Bucket[] = [];
  for (let i = 0; i < EDGES.length - 1; i++) {
    const lo = EDGES[i]!;
    const hi = EDGES[i + 1]!;
    const inB = rows.filter((r) => Number(r.t) >= lo && Number(r.t) < hi);
    buckets.push({ lo, hi, n: inB.length, pnl: inB.reduce((a, r) => a + Number(r.pnl), 0) });
  }
  const qualifies = (b: Bucket) => b.hi <= SEAT_MAX + 1e-9 && b.n >= opts.minN && b.pnl / Math.max(b.n, 1) > 0;

  // Widest contiguous qualifying run that touches a core bucket (index 0 or 1).
  let best: { start: number; end: number } | null = null;
  for (let s = 0; s < buckets.length; s++) {
    if (!qualifies(buckets[s]!)) continue;
    let e = s;
    while (e + 1 < buckets.length && qualifies(buckets[e + 1]!)) e++;
    const touchesCore = s <= 1;
    if (touchesCore && (best === null || e - s > best.end - best.start)) best = { start: s, end: e };
    s = e;
  }

  const band = best
    ? { lo: Math.max(1.2, buckets[best.start]!.lo), hi: Math.min(SEAT_MAX, buckets[best.end]!.hi) }
    : { lo: Math.max(1.2, opts.staticLo), hi: Math.min(SEAT_MAX, opts.staticHi) };

  if (lastApplied && lastApplied.lo === band.lo && lastApplied.hi === band.hi) return;

  // DECOUPLED (ARM SPEC ratified 2026-07-24): the finder's band informs the
  // radar and the sizing tiers but NEVER admission — mutating the trigger's
  // min/max here is what starved the morning's boardings (9 crowd-pass
  // arrivals, 0 armed). Admission is owned by CONFIRM_MIN/MAX_MULT statics
  // (1.2 floor, 2.05 sensor ceiling); the conviction seat cap lives in
  // CONVICTION_SEAT_MAX. triggerCfg is intentionally untouched.
  void triggerCfg;
  lastApplied = band;
  const evidence = buckets.map((b) => `${b.lo}-${b.hi}: n=${b.n} $${b.pnl.toFixed(2)}`).join(" · ");
  console.log(`🎯 SWEETSPOT ${band.lo}–${band.hi}× (${best ? "measured" : "fallback static"}) — ${evidence}`);
  await db.insert(auditLog).values({
    actor: "recorder",
    action: "sweetspot_band",
    details: { lo: band.lo, hi: band.hi, measured: best !== null, buckets: evidence, windowHours: opts.windowHours },
  });
  // Surface for dashboards/sentinel without them re-deriving it.
  const value = { lo: band.lo, hi: band.hi, measured: best !== null, at: Date.now(), buckets: evidence };
  await db
    .insert(config)
    .values({ key: "sweetspot_band", value })
    .onConflictDoUpdate({ target: config.key, set: { value, updatedAt: new Date() } })
    .catch(() => {});
}
