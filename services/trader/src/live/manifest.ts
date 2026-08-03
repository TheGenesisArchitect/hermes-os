/**
 * THE FORMULA MANIFEST — paper is the laboratory, live inherits the ratified
 * winning architecture (operator, 2026-08-02: "Yes let's execute with
 * precision").
 *
 * PURPOSE
 *   Load the operator-ratified manifest (config key `formula_manifest`) and
 *   render the entry verdict for a live candidate: ELITE seat, FILLER seat, or
 *   refuse — with the reason spelled out for the audit row. The manifest is
 *   data, not code: promotion/demotion of signatures, floors and venues happens
 *   by ratifying a new manifest version, never by editing gates.
 *
 * SUCCESS
 *   Every live entry decision carries the manifest version and tier; the
 *   counterfactual watch (packages/db/replays/manifest-watch.ts) measures what
 *   each tier takes and refuses from day one.
 *
 * FAILURE MODE
 *   A missing or corrupt manifest must never wedge the lane: verdict returns
 *   pass-through ("no-manifest") and the caller trades exactly as before —
 *   solvency rails are upstream and unaffected. Fail-open, and the fallback is
 *   visible in the audit row.
 *
 * OWNER
 *   Portfolio Intelligence (contents) · Execution (this wiring)
 */
import { db } from "@hermes/db";
import { sql } from "drizzle-orm";

export type ManifestTierSpec = {
  /** minimum measured inflow; an UNMEASURED inflow passes (absence isn't evidence) */
  inflowMin?: number;
  /** maximum measured inflow (the canon envelope ceiling) */
  inflowMax?: number;
  /** minimum measured buy share at trigger */
  buyShareMin?: number;
  /** when false, an unmeasured buy share refuses; default true (passes) */
  unmeasuredBuySharePasses?: boolean;
  /** crowd rule: winners aboard and winners outnumber rug history (W≥1 ∧ W>R) */
  crowdNetWinners?: boolean;
  /** venue allowlist for this tier */
  venues: string[];
  /** refuse relaunched tickers (F6 — the adversary's re-harvest cell; BROKER
   * #7319 entered one flagged two audit lines above its seat) */
  refuseSecondLaunch?: boolean;
};

export type FormulaManifest = {
  version: number;
  ratifiedAt: string;
  genomes: Record<string, number>; // signature → sizing weight
  elite: ManifestTierSpec;
  filler: ManifestTierSpec;
};

export type ManifestInput = {
  signature: string | null;
  inflow: number | null;
  buyShare: number | null;
  winnerHits: number | null;
  rugHits: number | null;
  venue: string | null;
  /** launchOrder ≥ 2 — a relaunch of an existing ticker */
  secondLaunch?: boolean;
};

export type ManifestVerdict =
  | { kind: "no-manifest" }
  | { kind: "seat"; tier: "elite" | "filler"; weight: number; version: number }
  | { kind: "refuse"; reason: string; version: number };

let cache: { m: FormulaManifest | null; at: number } = { m: null, at: 0 };
const CACHE_MS = 30_000;

export async function loadManifest(): Promise<FormulaManifest | null> {
  if (Date.now() - cache.at < CACHE_MS) return cache.m;
  try {
    const [row] = (await db.execute(
      sql`SELECT value FROM config WHERE key = 'formula_manifest'`,
    )) as unknown as { value: FormulaManifest }[];
    const m = row?.value ?? null;
    cache = { m: m && m.version >= 1 && m.elite && m.filler && m.genomes ? m : null, at: Date.now() };
  } catch {
    cache = { m: null, at: Date.now() }; // fail-open; retried next cache window
  }
  return cache.m;
}

/** Test seam. */
export function _resetManifestCache(): void {
  cache = { m: null, at: 0 };
}

function tierRefusal(spec: ManifestTierSpec, c: ManifestInput): string | null {
  if (spec.refuseSecondLaunch && c.secondLaunch) return "second launch (F6 re-harvest cell)";
  if (c.venue == null || !spec.venues.includes(c.venue)) return `venue ${c.venue ?? "unknown"} not in tier list`;
  if (spec.crowdNetWinners) {
    if (c.winnerHits == null || c.rugHits == null) return "crowd unmeasured";
    if (!(c.winnerHits >= 1 && c.winnerHits > c.rugHits)) return `crowd ${c.winnerHits}W/${c.rugHits}R fails W≥1∧W>R`;
  }
  if (spec.inflowMin != null && c.inflow != null && c.inflow < spec.inflowMin)
    return `inflow ${c.inflow.toFixed(2)}× below ${spec.inflowMin}×`;
  if (spec.inflowMax != null && c.inflow != null && c.inflow > spec.inflowMax)
    return `inflow ${c.inflow.toFixed(2)}× above the ${spec.inflowMax}× envelope`;
  if (spec.buyShareMin != null) {
    if (c.buyShare == null) {
      if (spec.unmeasuredBuySharePasses === false) return "buy share unmeasured";
    } else if (c.buyShare < spec.buyShareMin) {
      return `buy share ${(c.buyShare * 100).toFixed(0)}% below ${(spec.buyShareMin * 100).toFixed(0)}%`;
    }
  }
  return null;
}

/**
 * Pure verdict — no I/O, directly unit-tested. Elite is tried first; a
 * candidate failing both tiers is refused with both reasons named.
 */
export function manifestVerdict(m: FormulaManifest | null, c: ManifestInput): ManifestVerdict {
  if (!m) return { kind: "no-manifest" };
  // Drift-major seat veto REMOVED 2026-08-03 (convicted: 76 refusals / 75
  // winners / 8 rugs overnight — 7d-vs-7d PSI measures composition change,
  // not current-hour hostility; the rug-tide doors own that on the right
  // clock). PSI governs optimizer PROPOSALS only. Never re-add here.
  if (c.signature == null || m.genomes[c.signature] == null)
    return { kind: "refuse", reason: `${c.signature ?? "unrouted"} — genome not in manifest v${m.version}`, version: m.version };
  const weight = m.genomes[c.signature]!;
  const eliteWhy = tierRefusal(m.elite, c);
  if (eliteWhy == null) return { kind: "seat", tier: "elite", weight, version: m.version };
  const fillerWhy = tierRefusal(m.filler, c);
  if (fillerWhy == null) return { kind: "seat", tier: "filler", weight, version: m.version };
  return { kind: "refuse", reason: `manifest v${m.version}: elite → ${eliteWhy}; filler → ${fillerWhy}`, version: m.version };
}
