import {
  computeAdaptivePolicy,
  resolveOverrides,
  type HermesConfig,
  type RegimeStats,
  type RuntimeOverrides,
} from "@hermes/core";
import { config, db } from "@hermes/db";
import { eq, sql } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// The trader's half of the live control terminal.
//
//  readEffectiveConfig(cfg)   — merge the dashboard's runtime overrides over the
//                               static startup config, every manage cycle. Own
//                               try/catch: a DB hiccup on this read must NEVER
//                               throw into the manage loop — it falls back to the
//                               base config and the book keeps being managed.
//
//  refreshAdaptivePolicy(cfg) — recompute the regime from recent closes and write
//                               the policy's recommendation (auto) + regime into
//                               the runtime_overrides row, preserving the
//                               operator's manual pins and the autoMode switch.
//                               Throttled; a failure is logged and skipped.
// ─────────────────────────────────────────────────────────────────────────────

const OVERRIDES_KEY = "runtime_overrides";

async function readOverridesRow(): Promise<unknown> {
  const [row] = await db.select().from(config).where(eq(config.key, OVERRIDES_KEY));
  return row?.value ?? null;
}

/** Merge live overrides over the static config. Returns base cfg on any failure. */
export async function readEffectiveConfig(cfg: HermesConfig): Promise<HermesConfig> {
  try {
    const raw = await readOverridesRow();
    return resolveOverrides(cfg, raw).effective;
  } catch (err) {
    console.error(`override read failed (using base config): ${err instanceof Error ? err.message : err}`);
    return cfg;
  }
}

interface RegimeRow {
  n: number;
  wins: number;
  rugs: number;
  farm: number;
  avg_peak: number | null;
}

/**
 * Recompute the adaptive policy from the last window of closed positions and
 * persist it. The policy is DATA-DERIVED but honest about its one-pole training
 * set (see overrides.ts) — it writes into `auto`, which the trader only APPLIES
 * when the operator has flipped autoMode to "live". Manual pins and autoMode are
 * never touched here.
 */
export async function refreshAdaptivePolicy(cfg: HermesConfig, windowMin = 60): Promise<void> {
  try {
    const farmVenues = Array.from(cfg.FARM_VENUES);
    // Bind the venue list as an explicit IN list — interpolating a JS array into
    // drizzle's sql`` spreads it into scalar params, which breaks `= any($1)`.
    const farmCond = farmVenues.length
      ? sql`lower(t.dex) in (${sql.join(
          farmVenues.map((v) => sql`${v}`),
          sql`, `,
        )})`
      : sql`false`;
    // postgres-js: db.execute returns the row array directly (not { rows }).
    const result = (await db.execute(sql`
      with recent as (
        select
          p.realized_pnl_usd::float as pnl,
          p.size_usd::float as size_usd,
          p.exit_reason as reason,
          case when p.entry_price_usd::float > 0
               then p.peak_price_usd::float / p.entry_price_usd::float else 1 end as peak_mult,
          (${farmCond}) as is_farm
        from positions p
        join tokens t on t.mint = p.mint
        where p.status = 'closed'
          and p.closed_at >= now() - make_interval(mins => ${windowMin})
      )
      select
        count(*)::int as n,
        coalesce(sum((pnl > 0)::int), 0)::int as wins,
        coalesce(sum((reason ilike '%rug%' or reason ilike '%dust%' or pnl <= -0.5 * size_usd)::int), 0)::int as rugs,
        coalesce(sum(is_farm::int), 0)::int as farm,
        avg(peak_mult)::float as avg_peak
      from recent
    `)) as unknown as RegimeRow[];

    const r = result[0] ?? { n: 0, wins: 0, rugs: 0, farm: 0, avg_peak: 1 };
    const n = r.n ?? 0;
    const stats: RegimeStats = {
      n,
      winRate: n > 0 ? r.wins / n : 0,
      rugShare: n > 0 ? r.rugs / n : 0,
      farmShare: n > 0 ? r.farm / n : 0,
      session: cfg.PRIME_HOURS_UTC.has(new Date().getUTCHours()) ? "prime" : "off",
      avgPeakMult: r.avg_peak ?? 1,
    };

    const policy = computeAdaptivePolicy(stats, Date.now());

    // Preserve manual pins + autoMode; only refresh auto + regime.
    const prev = ((await readOverridesRow()) ?? {}) as Partial<RuntimeOverrides>;
    const next: RuntimeOverrides = {
      autoMode: prev.autoMode === "live" || prev.autoMode === "off" ? prev.autoMode : "advisory",
      manual: prev.manual ?? {},
      auto: policy.auto,
      regime: policy.regime,
      updatedAt: Date.now(),
    };

    await db
      .insert(config)
      .values({ key: OVERRIDES_KEY, value: next })
      .onConflictDoUpdate({ target: config.key, set: { value: next, updatedAt: new Date() } });
  } catch (err) {
    console.error(`adaptive policy refresh failed: ${err instanceof Error ? err.message : err}`);
  }
}
