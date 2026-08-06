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
/**
 * P1-3 (QA, 2026-08-06) — THE MANIFEST IS UNTRUSTED INPUT.
 *
 * The old check was `m && m.version >= 1 && m.elite && m.filler && m.genomes`,
 * which admits `{version:1, genomes:{}, elite:{}, filler:{}}`. `tierRefusal`
 * then reaches `spec.venues.includes(...)` on `undefined` and THROWS. That
 * throw is caught by the entry path's outer catch and audited as
 * `live_buy_failed` — so a malformed manifest does not "fail open to the old
 * lane" as this file promised: it WEDGES THE LANE, failing every candidate,
 * which is the failure mode the doc explicitly forbids.
 *
 * Validated by hand rather than a schema library: the trader package does not
 * depend on zod, and a release-gate fix should not add one. Every rule below
 * is a property `tierRefusal` actually relies on.
 */
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function validateTier(t: unknown, where: string, issues: string[]): void {
  if (typeof t !== "object" || t === null) { issues.push(`${where}: not an object`); return; }
  const s = t as Record<string, unknown>;
  if (!Array.isArray(s.venues) || s.venues.length === 0 || !s.venues.every((v) => typeof v === "string" && v.length > 0))
    issues.push(`${where}.venues: must be a non-empty string array`);
  for (const k of ["inflowMin", "inflowMax", "buyShareMin", "poolMinUsd"])
    if (s[k] !== undefined && !(num(s[k]) && (s[k] as number) >= 0)) issues.push(`${where}.${k}: must be a finite number >= 0`);
  for (const k of ["unmeasuredBuySharePasses", "crowdNetWinners", "refuseUnknownCrowd", "refuseSecondLaunch"])
    if (s[k] !== undefined && typeof s[k] !== "boolean") issues.push(`${where}.${k}: must be boolean`);
  if (num(s.inflowMin) && num(s.inflowMax) && (s.inflowMax as number) < (s.inflowMin as number))
    issues.push(`${where}: inflowMax < inflowMin`);
}

/** Returns the issue list — empty means the manifest is structurally safe. */
export function validateManifest(v: unknown): string[] {
  const issues: string[] = [];
  if (typeof v !== "object" || v === null) return ["manifest: not an object"];
  const m = v as Record<string, unknown>;
  if (!num(m.version) || (m.version as number) < 1 || !Number.isInteger(m.version)) issues.push("version: must be a positive integer");
  const g = m.genomes;
  if (typeof g !== "object" || g === null || Object.keys(g).length === 0) issues.push("genomes: must be a non-empty object");
  else for (const [k, w] of Object.entries(g as Record<string, unknown>))
    if (!(num(w) && (w as number) >= 0)) issues.push(`genomes.${k}: weight must be a finite number >= 0`);
  validateTier(m.elite, "elite", issues);
  validateTier(m.filler, "filler", issues);
  return issues;
}

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
  /** R2 (admission court, 2026-08-06): pool at entry below this is the
   * never-offered cohort — 47% dead, −$0.59/t. Unmeasured pool passes. */
  poolMinUsd?: number;
  /** R5 (admission court): a crowd with zero winner AND zero rug history is
   * unknown — 44% dead, −$0.45/t. Distinct from crowdNetWinners, which
   * refuses a MEASURED-but-losing crowd. */
  refuseUnknownCrowd?: boolean;
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
  /** pool liquidity at seat time (R2) */
  poolUsd?: number | null;
  /** P1-2: false when the depth observation came from a pool with no credible
   * quote reserve. Such an observation may never satisfy a depth floor. */
  poolDepthTrusted?: boolean;
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
    const raw = row?.value ?? null;
    const issues = raw == null ? ["absent"] : validateManifest(raw);
    if (issues.length) {
      if (raw != null) {
        // A manifest that EXISTS but is malformed is an operator-visible
        // incident, not a silent degrade — this is the "inert config" class.
        console.error(`⛔ manifest INVALID — degrading to no-manifest: ${issues.join("; ").slice(0, 200)}`);
        void db.execute(sql`INSERT INTO audit_log (actor, action, details) VALUES ('trader-live','manifest_invalid',
          ${JSON.stringify({ issues: issues.slice(0, 8) })}::jsonb)`).catch(() => {});
      }
      cache = { m: null, at: Date.now() };
      return null;
    }
    cache = { m: raw as FormulaManifest, at: Date.now() };
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
  // R2 — thin pool at entry (admission court): 47% dead, −$0.59/t. An
  // unmeasured pool passes; absence of measurement is not evidence.
  if (spec.poolMinUsd != null) {
    // P1-2 (QA): a depth number we cannot trust must never SATISFY a depth
    // floor. An untrusted observation is refused outright rather than compared.
    if (c.poolDepthTrusted === false)
      return "pool depth untrusted — no pool with a credible quote reserve";
    if (c.poolUsd != null && c.poolUsd > 0 && c.poolUsd < spec.poolMinUsd)
      return `pool $${Math.round(c.poolUsd)} below the $${spec.poolMinUsd} admission floor (47% dead)`;
  }
  // R5 — unknown crowd: MEASURED zero winners and MEASURED zero rugs (44%
  // dead). P2 (QA, 2026-08-06): the old `(c.winnerHits ?? 0) === 0` collapsed
  // null into 0, so an UNMEASURED crowd was refused under a rule documented as
  // "zero history". Absence of measurement is not evidence — that epistemic
  // rule governs every other term here (inflow, buy share, pool), and R5 now
  // obeys it too. A null crowd is refused one line below by crowdNetWinners
  // ("crowd unmeasured") when that term is enabled, which is the honest place
  // for it.
  if (spec.refuseUnknownCrowd && c.winnerHits === 0 && c.rugHits === 0)
    return "crowd 0W/0R — measured-empty history (44% dead)";
  if (!Array.isArray(spec.venues) || c.venue == null || !spec.venues.includes(c.venue))
    return `venue ${c.venue ?? "unknown"} not in tier list`;
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
