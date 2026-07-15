import type { HermesConfig } from "./config.js";

// ─────────────────────────────────────────────────────────────────────────────
// RUNTIME OVERRIDES — the live control terminal's substrate.
//
// The trader loads `cfg = loadConfig()` ONCE at startup; every knob is static
// for the life of the process. This module makes a whitelisted set of SCALAR
// knobs live-adjustable without a restart: the dashboard writes overrides into
// the `runtime_overrides` config row, and the trader merges them over `cfg` on
// every manage cycle.
//
// Two override channels, with a strict precedence:
//   manual  — the operator pins a value from the dashboard. ALWAYS wins. This is
//             the "manually adjust and override in real time" the user asked for.
//   auto    — the adaptive policy computes a value from recent-close data. Applied
//             ONLY when autoMode === "live"; in "advisory" it's computed and shown
//             next to the manual dial but never touches the trader.
//
// Every override is CLAMPED to a sane band here (min/max on each knob) so neither
// a fat-fingered operator nor a policy bug can drive a knob to an absurd value.
// Only scalar numbers route through this — never the Set/transform knobs
// (FARM_VENUES, PRIME_HOURS_UTC, …), which have no meaningful live-merge.
// ─────────────────────────────────────────────────────────────────────────────

export type OverrideKey =
  | "PAPER_POSITION_USD"
  | "OFF_HOURS_SIZE_MULT"
  | "TP0_MULT"
  | "TP1_MULT"
  | "TP2_MULT"
  | "HARD_STOP_PCT"
  | "TRAIL_TIGHT_PCT"
  | "TRAIL_MID_PCT"
  | "TRAIL_WIDE_PCT"
  | "PROFIT_LOCK_ARM_MULT"
  | "PROFIT_FLOOR_USD"
  | "FARM_MAX_SLOTS";

export type OverrideGroup = "size" | "tp" | "stop";

export interface OverrideKnob {
  key: OverrideKey;
  label: string;
  hint: string;
  group: OverrideGroup;
  unit: "$" | "x" | "%" | "slots";
  min: number;
  max: number;
  step: number;
}

// The exposed knobs, in dashboard display order. Bands are deliberately generous
// enough to tune but tight enough to be safe (no $5,000 size, no 90% stop).
export const OVERRIDE_KNOBS: OverrideKnob[] = [
  { key: "PAPER_POSITION_USD", label: "Position size", hint: "base $/entry — off-hours throttle & per-candidate risk/quality apply on top", group: "size", unit: "$", min: 0.5, max: 200, step: 0.5 },
  { key: "OFF_HOURS_SIZE_MULT", label: "Off-hours throttle", hint: "× base size outside prime (18–23 UTC). 1.0 = full size off-hours (removes the probe cap)", group: "size", unit: "x", min: 0, max: 1, step: 0.05 },
  { key: "FARM_MAX_SLOTS", label: "Farm book cap", hint: "max concurrent farm-tape positions — dry powder waits for the organic pond", group: "size", unit: "slots", min: 0, max: 24, step: 1 },
  { key: "TP0_MULT", label: "TP0", hint: "first tranche — bank into the blow-off", group: "tp", unit: "x", min: 1.02, max: 3, step: 0.01 },
  { key: "TP1_MULT", label: "TP1", hint: "bank the bulk", group: "tp", unit: "x", min: 1.05, max: 5, step: 0.01 },
  { key: "TP2_MULT", label: "TP2", hint: "most banked; remainder rides uncapped", group: "tp", unit: "x", min: 1.1, max: 20, step: 0.05 },
  { key: "TRAIL_TIGHT_PCT", label: "Trail · tight", hint: "giveback in the 1–2.5x spike zone", group: "stop", unit: "%", min: 2, max: 40, step: 0.5 },
  { key: "TRAIL_MID_PCT", label: "Trail · mid", hint: "giveback for a 2.5–6x runner", group: "stop", unit: "%", min: 2, max: 50, step: 0.5 },
  { key: "TRAIL_WIDE_PCT", label: "Trail · wide", hint: "giveback for a ≥6x parabolic", group: "stop", unit: "%", min: 2, max: 60, step: 0.5 },
  { key: "HARD_STOP_PCT", label: "Hard stop", hint: "pre-ignition cut on a confirmed entry that reverses", group: "stop", unit: "%", min: 1, max: 30, step: 0.5 },
  { key: "PROFIT_LOCK_ARM_MULT", label: "Arm at", hint: "multiple that ignites the never-close-red floor", group: "stop", unit: "x", min: 1.02, max: 2, step: 0.01 },
  { key: "PROFIT_FLOOR_USD", label: "Arm at $", hint: "dollar profit that also arms the floor (base hits)", group: "stop", unit: "$", min: 0, max: 20, step: 0.05 },
];

const KNOB_BY_KEY = new Map(OVERRIDE_KNOBS.map((k) => [k.key, k] as const));

export function clampKnob(key: OverrideKey, value: number): number {
  const spec = KNOB_BY_KEY.get(key);
  if (!spec) return value;
  if (!Number.isFinite(value)) return spec.min;
  return Math.min(spec.max, Math.max(spec.min, value));
}

export type AutoMode = "off" | "advisory" | "live";

// The persisted shape of the `runtime_overrides` config row.
export interface RuntimeOverrides {
  autoMode: AutoMode;
  manual: Partial<Record<OverrideKey, number>>;
  auto: Partial<Record<OverrideKey, number>>;
  regime: RegimeState | null;
  updatedAt: number;
}

export const EMPTY_OVERRIDES: RuntimeOverrides = {
  autoMode: "advisory",
  manual: {},
  auto: {},
  regime: null,
  updatedAt: 0,
};

export type OverrideSource = "base" | "auto" | "manual";

export interface ResolvedKnob {
  key: OverrideKey;
  value: number; // the EFFECTIVE value the trader will use this cycle
  base: number; // the loadConfig() default
  auto: number | null; // policy recommendation (clamped), or null
  manual: number | null; // operator pin (clamped), or null
  source: OverrideSource; // which channel won
}

export interface ResolvedOverrides {
  effective: HermesConfig;
  resolved: Record<OverrideKey, ResolvedKnob>;
  autoMode: AutoMode;
  regime: RegimeState | null;
}

function coerceOverrides(raw: unknown): RuntimeOverrides {
  const r = (raw ?? {}) as Partial<RuntimeOverrides>;
  const mode: AutoMode = r.autoMode === "live" || r.autoMode === "off" ? r.autoMode : "advisory";
  return {
    autoMode: mode,
    manual: (r.manual ?? {}) as Partial<Record<OverrideKey, number>>,
    auto: (r.auto ?? {}) as Partial<Record<OverrideKey, number>>,
    regime: r.regime ?? null,
    updatedAt: r.updatedAt ?? 0,
  };
}

// Merge the persisted overrides over a base config and report, per knob, which
// channel won. Pure and total: any missing/garbage field falls back to base, so
// a malformed row can never break the trader — it just resolves to base cfg.
export function resolveOverrides(cfg: HermesConfig, raw: unknown): ResolvedOverrides {
  const o = coerceOverrides(raw);
  const effective = { ...cfg } as HermesConfig;
  const resolved = {} as Record<OverrideKey, ResolvedKnob>;

  for (const knob of OVERRIDE_KNOBS) {
    const base = cfg[knob.key] as number;
    const auto = typeof o.auto[knob.key] === "number" ? clampKnob(knob.key, o.auto[knob.key] as number) : null;
    const manual = typeof o.manual[knob.key] === "number" ? clampKnob(knob.key, o.manual[knob.key] as number) : null;

    let value = base;
    let source: OverrideSource = "base";
    if (o.autoMode === "live" && auto != null) {
      value = auto;
      source = "auto";
    }
    if (manual != null) {
      // Manual always wins — the operator's real-time override is king.
      value = manual;
      source = "manual";
    }

    (effective as Record<string, unknown>)[knob.key] = value;
    resolved[knob.key] = { key: knob.key, value, base, auto, manual, source };
  }

  return { effective, resolved, autoMode: o.autoMode, regime: o.regime };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE ADAPTIVE POLICY — data-derived tighten/loosen.
//
// CAVEAT that governs this whole function: the closes it learns from are ~95%
// meteora-damm-v2 farm tape (a regime we've PROVEN unwinnable). The favorable
// pole — organic, prime — is a handful of closes. So the policy is honest about
// one thing: it can confidently detect and respond to a HOSTILE regime (its
// training data is nearly all hostile), but its "favorable → loosen and let
// winners run" side is a PRIOR, not a measurement, until a clean prime run gives
// it the second pole. That is exactly why autoMode ships in "advisory": the
// policy is computed and displayed, but not wired to live capital until the
// operator has watched it agree with a good regime.
// ─────────────────────────────────────────────────────────────────────────────

export interface RegimeStats {
  n: number; // recent closes in the window
  winRate: number; // 0..1
  rugShare: number; // 0..1 — closes that terminally collapsed
  farmShare: number; // 0..1 of recent opens on farm venues
  session: "prime" | "off";
  avgPeakMult: number; // mean peak multiple of recent closes
}

export interface RegimeState extends RegimeStats {
  hostility: number; // 0 (favorable) .. 1 (hostile)
  label: string; // human tag
  computedAt: number;
}

export interface AdaptivePolicy {
  regime: RegimeState;
  auto: Partial<Record<OverrideKey, number>>;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const lerp = (favorable: number, hostile: number, hostility: number) =>
  favorable + (hostile - favorable) * hostility;
const round = (x: number, dp: number) => {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
};

// Minimum recent-close sample below which we refuse to trust the read and hold a
// cautious hostility floor — thin data defaults to the regime we know is real.
export const ADAPTIVE_MIN_N = 15;

export function computeAdaptivePolicy(stats: RegimeStats, now: number): AdaptivePolicy {
  const rugHostility = clamp01((stats.rugShare - 0.35) / 0.35); // 0.35 rug = neutral, ≥0.70 = max
  const sessionHostility = stats.session === "prime" ? 0.2 : 0.8; // off-hours tape is the farm's home turf
  const winRelief = clamp01((stats.winRate - 0.4) / 0.3); // >40% win rate relieves hostility
  const farmHostility = clamp01((stats.farmShare - 0.4) / 0.5); // a book full of farm tape is hostile by construction

  let hostility = clamp01(
    0.4 * rugHostility + 0.25 * sessionHostility + 0.2 * farmHostility + 0.15 * (1 - winRelief),
  );
  // Thin data → don't extrapolate toward the unproven favorable pole.
  if (stats.n < ADAPTIVE_MIN_N) hostility = Math.max(hostility, 0.6);

  const label =
    hostility >= 0.66 ? "hostile — tighten & shrink" : hostility >= 0.4 ? "mixed — hold the line" : "favorable — let winners run";

  // Poles chosen from the doctrine already in the code:
  //  favorable → bigger base size, wider trails, more room before the hard stop,
  //             TPs let to breathe (bank a touch later), fuller farm book allowed.
  //  hostile   → probe size, tight trails, fast hard stop, bank TPs earlier,
  //             fewer farm slots (dry powder waits for the organic pond).
  const auto: Partial<Record<OverrideKey, number>> = {
    PAPER_POSITION_USD: round(lerp(50, 8, hostility), 2),
    TRAIL_TIGHT_PCT: round(lerp(8, 3, hostility), 1),
    TRAIL_MID_PCT: round(lerp(14, 8, hostility), 1),
    HARD_STOP_PCT: round(lerp(7, 4, hostility), 1),
    TP0_MULT: round(lerp(1.2, 1.12, hostility), 2),
    TP1_MULT: round(lerp(1.35, 1.25, hostility), 2),
    FARM_MAX_SLOTS: Math.round(lerp(10, 4, hostility)),
  };
  // Clamp every recommendation to its knob band.
  for (const k of Object.keys(auto) as OverrideKey[]) {
    auto[k] = clampKnob(k, auto[k] as number);
  }

  return {
    regime: { ...stats, hostility: round(hostility, 3), label, computedAt: now },
    auto,
  };
}
