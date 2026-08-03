/**
 * THE MANIFEST OPTIMIZER — the self-optimizing loop (operator, 2026-08-02:
 * "an Institutional Grade Live Lane that Self Optimizes as market data is
 * consumed").
 *
 * PURPOSE
 *   Every OPTIMIZER_INTERVAL the service recomputes the rug-adjusted signature
 *   table over a ROLLING window of paper's tape — the same arithmetic as
 *   packages/db/replays/formula-manifest.ts — plus the counterfactual verdict
 *   on the active manifest's own refusals, and compares the result against the
 *   ACTIVE manifest. A material delta becomes a PROPOSAL (config key
 *   `formula_manifest_proposal`, audit row `manifest_proposal`), never a
 *   silent change.
 *
 * GOVERNANCE — THE AUTONOMY LADDER (institutional-grade means governed):
 *   L1 (this file): the system computes and PROPOSES; the operator ratifies by
 *       promoting the proposal to `formula_manifest`. Demotion evidence and
 *       promotion evidence are both attached to the proposal.
 *   L2 (spec'd, not armed): auto-apply WITHIN pre-ratified bounds — weight
 *       nudges inside [0.6, 1.5] and demotions-only — behind
 *       OPTIMIZER_AUTO_APPLY, default false.
 *   L3 (not offered): unbounded self-modification. Rejected by design — the
 *       standing rail is "present tables → operator ratifies → ship".
 *
 * SUCCESS       A stale manifest term cannot survive a week of contrary tape
 *               without a proposal naming it, with n and dollars attached.
 * FAILURE MODE  A hot window proposes churn — damped by MIN_N, the material-
 *               delta threshold, and the rolling window being 14d, not 1d.
 * OWNER         Data Science (contents) · Portfolio Intelligence (governance)
 */
import { auditLog, db } from "@hermes/db";
import { sql } from "drizzle-orm";
import type { HermesConfig } from "@hermes/core";
import { loadManifest, type FormulaManifest } from "./manifest.js";

// HOURLY (operator "Let's fix", 2026-08-03): the drift verdict gates every
// seat in real time, so a 6h clock held the stand-down through a regime flip —
// 6 refused winners / 0 rugs / +$22 counterfactual in one 3h window. The
// verdict must move at the speed of the gate it feeds.
const OPTIMIZER_INTERVAL_MS = 60 * 60_000;
const FIRST_RUN_DELAY_MS = 5 * 60_000; // let the boot settle first
const WINDOW_DAYS = 14; // rolling window: self-optimizing means the fence moves
const DEAD_POOL_LIQ = 1200;
const MIN_N = 30;
const WEIGHT_DELTA_MATERIAL = 0.15;
// MODEL RISK (operator review, 2026-08-02): PSI thresholds — the standard
// bands. <0.10 stable, 0.10–0.25 moderate shift, >0.25 major shift. Under a
// MAJOR shift the optimizer must say "the market has changed — I am no longer
// confident" and propose DEMOTIONS ONLY: more cautious on its own, never
// bolder, which is the same asymmetry the L2 ladder rung is built on.
const PSI_MODERATE = 0.1;
const PSI_MAJOR = 0.25;

export type SignatureStat = { n: number; adjEv: number; evPerTrade: number };

export type DriftReport = {
  perFeature: Record<string, number>;
  max: number;
  verdict: "stable" | "moderate" | "major";
};

/** Population Stability Index between two binned distributions (aligned bins).
 *  Pure — unit-tested. Epsilon-floored so an empty bin cannot produce ±∞. */
export function psi(a: number[], b: number[]): number {
  const sumA = a.reduce((s, x) => s + x, 0);
  const sumB = b.reduce((s, x) => s + x, 0);
  if (sumA === 0 || sumB === 0) return 0; // no data is not evidence of drift
  let out = 0;
  for (let i = 0; i < a.length; i++) {
    const p = Math.max((a[i] ?? 0) / sumA, 1e-4);
    const q = Math.max((b[i] ?? 0) / sumB, 1e-4);
    out += (p - q) * Math.log(p / q);
  }
  return out;
}

/** Pure — the confidence clause. Under MAJOR drift, promotion/reweight deltas
 *  are withheld (they would be fitted to a regime that no longer exists) and
 *  only DROP deltas survive: retreat needs no confidence in the new regime,
 *  only lost confidence in the old one. */
export function applyDriftGate(
  deltas: string[],
  drift: DriftReport,
): { deltas: string[]; withheld: string[] } {
  if (drift.verdict !== "major") return { deltas, withheld: [] };
  const kept = deltas.filter((d) => d.startsWith("DROP "));
  return { deltas: kept, withheld: deltas.filter((d) => !d.startsWith("DROP ")) };
}

export type ManifestProposal = {
  basedOnVersion: number;
  computedAt: string;
  windowDays: number;
  signatures: Record<string, SignatureStat & { verdict: "PROMOTE" | "paper-only" | "insufficient-n"; weight: number }>;
  deltas: string[];
  withheldByDrift?: string[];
  drift?: DriftReport;
  refusalCounterfactual: { refused: number; paperGreens: number; paperDead: number } | null;
  status: string;
};

/** Pure — unit-tested. Compares a fresh signature table against the active
 *  manifest and names every material delta: genome add/drop candidates and
 *  weight moves ≥ WEIGHT_DELTA_MATERIAL. */
export function proposeManifest(
  active: FormulaManifest,
  table: Record<string, SignatureStat>,
  minN = MIN_N,
): { proposal: Omit<ManifestProposal, "computedAt" | "refusalCounterfactual">; material: boolean } {
  const signatures: ManifestProposal["signatures"] = {};
  for (const [sig, s] of Object.entries(table)) {
    const powered = s.n >= minN;
    const verdict = !powered ? "insufficient-n" : s.adjEv > 0 ? "PROMOTE" : "paper-only";
    signatures[sig] = { ...s, verdict, weight: active.genomes[sig] ?? 1 };
  }
  const promoted = Object.values(signatures).filter((v) => v.verdict === "PROMOTE");
  const meanEv = promoted.length ? promoted.reduce((a, v) => a + v.evPerTrade, 0) / promoted.length : 1;
  for (const v of promoted)
    v.weight = Math.round(Math.min(1.5, Math.max(0.6, meanEv > 0 ? v.evPerTrade / meanEv : 1)) * 20) / 20;

  const deltas: string[] = [];
  for (const [sig, v] of Object.entries(signatures)) {
    const inActive = active.genomes[sig] != null;
    if (v.verdict === "PROMOTE" && !inActive)
      deltas.push(`ADD ${sig} — adjEV $${v.adjEv.toFixed(2)} over n=${v.n} (not in active manifest)`);
    if (v.verdict === "paper-only" && inActive)
      deltas.push(`DROP ${sig} — adjEV $${v.adjEv.toFixed(2)} over n=${v.n} (active weight ×${active.genomes[sig]})`);
    if (v.verdict === "PROMOTE" && inActive && Math.abs(v.weight - active.genomes[sig]!) >= WEIGHT_DELTA_MATERIAL)
      deltas.push(`REWEIGHT ${sig} ×${active.genomes[sig]} → ×${v.weight} (adjEV/t $${v.evPerTrade.toFixed(2)}, n=${v.n})`);
  }
  return {
    proposal: {
      basedOnVersion: active.version,
      windowDays: WINDOW_DAYS,
      signatures,
      deltas,
      status: "PROPOSAL — operator ratifies by promoting to formula_manifest",
    },
    material: deltas.length > 0,
  };
}

/** The rolling rug-adjusted signature table — one SQL pass, same arithmetic as
 *  the harness: phantom proceeds (sell fills into pools under the dead-pool
 *  line) are subtracted from booked pnl. */
async function signatureTable(): Promise<Record<string, SignatureStat>> {
  const rows = (await db.execute(sql`
    WITH sells AS (
      SELECT f.position_id,
        sum(f.qty_tokens::float * f.price_usd::float)
          FILTER (WHERE lt.liq IS NOT NULL AND lt.liq < ${DEAD_POOL_LIQ}) phantom
      FROM fills f
      JOIN positions p ON p.id = f.position_id AND p.lane = 'paper' AND p.status = 'closed'
        AND p.opened_at >= now() - make_interval(days => ${WINDOW_DAYS})
      LEFT JOIN LATERAL (
        SELECT ct.liquidity_usd::float liq FROM candidate_ticks ct
        WHERE ct.mint = p.mint AND ct.snapped_at <= f.filled_at
          AND ct.snapped_at >= f.filled_at - interval '600 seconds'
        ORDER BY ct.snapped_at DESC LIMIT 1) lt ON true
      WHERE f.side = 'sell' GROUP BY f.position_id)
    SELECT co.signature sig, count(*) n,
      sum(p.realized_pnl_usd::float - coalesce(s.phantom, 0)) adj
    FROM positions p
    JOIN candidate_outcomes co ON co.mint = p.mint AND co.signature IS NOT NULL
    LEFT JOIN sells s ON s.position_id = p.id
    WHERE p.lane = 'paper' AND p.status = 'closed'
      AND p.opened_at >= now() - make_interval(days => ${WINDOW_DAYS})
    GROUP BY co.signature`)) as unknown as { sig: string; n: number; adj: number }[];
  const out: Record<string, SignatureStat> = {};
  for (const r of rows) {
    const n = Number(r.n);
    const adjEv = Number(r.adj);
    out[r.sig] = { n, adjEv: +adjEv.toFixed(2), evPerTrade: +(n > 0 ? adjEv / n : 0).toFixed(3) };
  }
  return out;
}

/** MODEL RISK — feature drift between the trailing 7d and the prior 7d, over
 *  the entry-knowable features the manifest actually gates on. The bins are
 *  the SAME bins the promotion tables use, so a drifted feature is drifted in
 *  exactly the space where the edge was measured. */
async function featureDrift(): Promise<DriftReport> {
  const half = Math.floor(WINDOW_DAYS / 2);
  const features: [string, string][] = [
    [
      "inflow",
      `CASE WHEN co.liq_growth IS NULL THEN 'null'
            WHEN co.liq_growth::float < 1.05 THEN 'a' WHEN co.liq_growth::float < 1.2 THEN 'b'
            WHEN co.liq_growth::float < 1.3 THEN 'c' WHEN co.liq_growth::float <= 2.05 THEN 'd'
            ELSE 'e' END`,
    ],
    [
      "buy_share",
      `CASE WHEN co.trigger_buy_share IS NULL THEN 'null'
            WHEN co.trigger_buy_share::float < 0.55 THEN 'a'
            WHEN co.trigger_buy_share::float < 0.7 THEN 'b' ELSE 'c' END`,
    ],
    ["venue", `coalesce(tk.dex, 'null')`],
    ["signature", `coalesce(co.signature, 'null')`],
  ];
  const perFeature: Record<string, number> = {};
  for (const [name, binExpr] of features) {
    const rows = (await db.execute(sql`
      SELECT ${sql.raw(binExpr)} AS bin,
        count(*) FILTER (WHERE p.opened_at >= now() - make_interval(days => ${half})) recent,
        count(*) FILTER (WHERE p.opened_at <  now() - make_interval(days => ${half})) prior
      FROM positions p
      LEFT JOIN candidate_outcomes co ON co.mint = p.mint
      LEFT JOIN tokens tk ON tk.mint = p.mint
      WHERE p.lane = 'paper' AND p.opened_at >= now() - make_interval(days => ${WINDOW_DAYS})
      GROUP BY 1`)) as unknown as { bin: string; recent: number; prior: number }[];
    perFeature[name] = +psi(rows.map((r) => Number(r.recent)), rows.map((r) => Number(r.prior))).toFixed(4);
  }
  const max = Math.max(0, ...Object.values(perFeature));
  return { perFeature, max, verdict: max > PSI_MAJOR ? "major" : max > PSI_MODERATE ? "moderate" : "stable" };
}

/** The manifest's own refusals, judged by their paper twins — the demotion
 *  evidence stream. A refusal cohort printing paper green is the case for
 *  loosening; one printing dead is the manifest earning its keep. */
async function refusalCounterfactual(): Promise<ManifestProposal["refusalCounterfactual"]> {
  const [r] = (await db.execute(sql`
    SELECT count(*) refused,
      count(*) FILTER (WHERE pp.realized_pnl_usd > 0) greens,
      count(*) FILTER (WHERE pp.realized_pnl_usd / nullif(pp.size_usd, 0) <= -0.55) dead
    FROM audit_log al
    LEFT JOIN LATERAL (
      SELECT * FROM positions p2 WHERE p2.lane = 'paper' AND p2.status = 'closed'
        AND p2.mint = al.details->>'mint'
        AND p2.opened_at BETWEEN al.created_at - interval '30 minutes' AND al.created_at + interval '30 minutes'
      ORDER BY p2.opened_at LIMIT 1) pp ON true
    WHERE al.action = 'live_buy_skipped' AND al.details->>'reason' LIKE 'manifest v%'
      AND al.created_at >= now() - make_interval(days => ${WINDOW_DAYS})`)) as unknown as {
    refused: number; greens: number; dead: number;
  }[];
  if (!r || Number(r.refused) === 0) return null;
  return { refused: Number(r.refused), paperGreens: Number(r.greens), paperDead: Number(r.dead) };
}

let optimizerStarted = false;
export function startManifestOptimizer(cfg: HermesConfig): void {
  if (optimizerStarted || !cfg.FORMULA_MANIFEST_ENABLED) return;
  optimizerStarted = true;
  const runOnce = async (): Promise<void> => {
    try {
      const active = await loadManifest();
      if (!active) return; // fail-open lane — nothing to optimize against
      const [table, cf, drift] = await Promise.all([signatureTable(), refusalCounterfactual(), featureDrift()]);
      const { proposal, material } = proposeManifest(active, table);
      // MODEL RISK GATE — under a major regime shift the optimizer stops
      // optimizing and says so: promotions/reweights are withheld (they were
      // fitted to the regime that just ended), demotions survive.
      const gated = applyDriftGate(proposal.deltas, drift);
      const full: ManifestProposal = {
        ...proposal,
        deltas: gated.deltas,
        withheldByDrift: gated.withheld.length ? gated.withheld : undefined,
        drift,
        computedAt: new Date().toISOString(),
        refusalCounterfactual: cf,
        status:
          drift.verdict === "major"
            ? `CONFIDENCE DEGRADED — max PSI ${drift.max} (major regime shift): demotion-only proposal, ${gated.withheld.length} delta(s) withheld`
            : proposal.status,
      };
      await db.execute(sql`
        INSERT INTO config (key, value) VALUES ('formula_manifest_proposal', ${JSON.stringify(full)}::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`);
      if (gated.deltas.length > 0 || gated.withheld.length > 0) {
        await db.insert(auditLog).values({
          actor: "trader-live",
          action: "manifest_proposal",
          details: {
            basedOnVersion: active.version,
            deltas: gated.deltas,
            withheldByDrift: gated.withheld,
            drift,
            refusalCounterfactual: cf,
          },
        });
        console.log(
          drift.verdict === "major"
            ? `🧪 MANIFEST PROPOSAL (drift ${drift.max} MAJOR — demotion-only): ${gated.deltas.join(" · ") || "no demotions"}; withheld: ${gated.withheld.length}`
            : `🧪 MANIFEST PROPOSAL — ${gated.deltas.length} material delta(s) vs v${active.version} (drift ${drift.max} ${drift.verdict}): ${gated.deltas.join(" · ")}`,
        );
      } else if (material) {
        console.log(`🧪 manifest optimizer: deltas resolved to none after drift gate (drift ${drift.max} ${drift.verdict})`);
      }
    } catch (err) {
      console.warn(`manifest optimizer pass failed (next interval retries): ${err instanceof Error ? err.message.slice(0, 100) : err}`);
    }
  };
  setTimeout(() => void runOnce(), FIRST_RUN_DELAY_MS);
  setInterval(() => void runOnce(), OPTIMIZER_INTERVAL_MS);
  console.log(`🧪 manifest optimizer armed — rolling ${WINDOW_DAYS}d rug-adjusted recompute every ${OPTIMIZER_INTERVAL_MS / 3_600_000}h, proposals only (L1)`);
}
