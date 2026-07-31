/**
 * PURPOSE
 *   Make live decision state survive a process restart. GTPED P3 requires that
 *   identical market data produce an identical decision, 100% of the time. It
 *   did not: seven module-level Maps held tactical state that every deploy
 *   erased, and the cost is measured — 13 fired of 39 chambers (33%) across a
 *   day with ~8 restarts, 11 of them never consulted and 16 missing.
 *
 * SUCCESS METRIC
 *   Sniper fired-rate no longer correlates with deploy count. Target ≥70% of
 *   chambered protective exits firing their round.
 *
 * FAILURE MODE
 *   A stale row rehydrates a decision the market has moved past. Mitigated by
 *   a TTL on load and by every consumer re-validating against chain (the
 *   chamber checks live quantity before firing).
 *
 * OWNER
 *   Execution Team
 *
 * DESIGN
 *   Write-through, never blocking. Mutations fire-and-forget into Postgres;
 *   the in-memory Map stays the read path so the hot loop is untouched. On
 *   boot each scope is rehydrated once. A DB failure degrades to exactly
 *   today's behaviour (in-memory only) rather than breaking the lane.
 */
import { db } from "@hermes/db";
import { sql } from "drizzle-orm";

export type StateScope =
  | "chamber" // pre-signed exit rounds — the measured 33%
  | "latch" // commanded protective exits that must complete
  | "exclude" // per-position poisoned sell venues
  | "peak" // live peak mark (arms the profit floor)
  | "poolpeak"; // pool running peak (the liquid window's trailing stop)

/** Rows older than this are not rehydrated — a day-old chamber is not tactical. */
const REHYDRATE_MAX_AGE_MS = 6 * 60 * 60_000;

export async function persist(scope: StateScope, key: string | number, value: unknown): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO live_runtime_state (scope, key, value, updated_at)
      VALUES (${scope}, ${String(key)}, ${JSON.stringify(value)}::jsonb, now())
      ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value, updated_at = now()`);
  } catch {
    /* persistence is best-effort: never break the trading path for bookkeeping */
  }
}

export async function forget(scope: StateScope, key: string | number): Promise<void> {
  try {
    await db.execute(sql`DELETE FROM live_runtime_state WHERE scope=${scope} AND key=${String(key)}`);
  } catch {
    /* see persist() */
  }
}

/** Rehydrate one scope. Returns [key, value] pairs fresh enough to still matter. */
export async function rehydrate<T>(scope: StateScope): Promise<[string, T][]> {
  try {
    const rows = (await db.execute(sql`
      SELECT key, value, extract(epoch from (now() - updated_at)) * 1000 AS age_ms
      FROM live_runtime_state WHERE scope = ${scope}`)) as unknown as {
      key: string;
      value: T;
      age_ms: number;
    }[];
    const fresh = rows.filter((r) => Number(r.age_ms) <= REHYDRATE_MAX_AGE_MS);
    if (rows.length > fresh.length) {
      // Stale rows are dropped, not resurrected — and swept so the table stays small.
      void db
        .execute(sql`DELETE FROM live_runtime_state WHERE scope=${scope}
                     AND updated_at < now() - ${`${REHYDRATE_MAX_AGE_MS} milliseconds`}::interval`)
        .catch(() => {});
    }
    return fresh.map((r) => [r.key, r.value] as [string, T]);
  } catch {
    return [];
  }
}

/** Drop every row for a scope — used when the open book empties. */
export async function clearScope(scope: StateScope, keepKeys: Set<string>): Promise<void> {
  try {
    const keep = [...keepKeys];
    if (keep.length === 0) {
      await db.execute(sql`DELETE FROM live_runtime_state WHERE scope=${scope}`);
      return;
    }
    await db.execute(sql`
      DELETE FROM live_runtime_state WHERE scope=${scope}
        AND key <> ALL(${sql.raw(`ARRAY[${keep.map((k) => `'${k.replace(/'/g, "''")}'`).join(",")}]::text[]`)})`);
  } catch {
    /* see persist() */
  }
}
