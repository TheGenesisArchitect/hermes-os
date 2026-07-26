"use server";

import {
  EMPTY_OVERRIDES,
  OVERRIDE_KNOBS,
  clampKnob,
  type AutoMode,
  type OverrideKey,
  type RuntimeOverrides,
} from "@hermes/core";
import { auditLog, config, db, managementIntents } from "@hermes/db";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getKillSwitch } from "@/lib/queries";

const OVERRIDES_KEY = "runtime_overrides";
const VALID_KEYS = new Set<string>(OVERRIDE_KNOBS.map((k) => k.key));

async function readOverrides(): Promise<RuntimeOverrides> {
  const [row] = await db.select().from(config).where(eq(config.key, OVERRIDES_KEY));
  const v = (row?.value ?? null) as Partial<RuntimeOverrides> | null;
  if (!v) return { ...EMPTY_OVERRIDES };
  return {
    autoMode: v.autoMode === "live" || v.autoMode === "off" ? v.autoMode : "advisory",
    manual: v.manual ?? {},
    auto: v.auto ?? {},
    regime: v.regime ?? null,
    updatedAt: v.updatedAt ?? 0,
  };
}

async function writeOverrides(next: RuntimeOverrides): Promise<void> {
  const value = { ...next, updatedAt: Date.now() };
  await db
    .insert(config)
    .values({ key: OVERRIDES_KEY, value })
    .onConflictDoUpdate({ target: config.key, set: { value, updatedAt: new Date() } });
}

/**
 * Pin a knob to a manual value — the operator's real-time override. Manual pins
 * ALWAYS win over the adaptive policy and the base config. Clamped to the knob's
 * safe band in core so no value here can be absurd; every change is audit-logged.
 */
export async function setManualOverride(key: string, value: number): Promise<void> {
  if (!VALID_KEYS.has(key) || !Number.isFinite(value)) return;
  const k = key as OverrideKey;
  const clamped = clampKnob(k, value);
  const cur = await readOverrides();
  cur.manual = { ...cur.manual, [k]: clamped };
  await writeOverrides(cur);
  await db.insert(auditLog).values({
    actor: "user",
    action: "override_set",
    details: { knob: k, value: clamped, via: "dashboard" },
  });
  revalidatePath("/");
}

/** Release a manual pin — the knob falls back to auto (if live) or base config. */
export async function clearManualOverride(key: string): Promise<void> {
  if (!VALID_KEYS.has(key)) return;
  const k = key as OverrideKey;
  const cur = await readOverrides();
  if (cur.manual[k] == null) return;
  const { [k]: _dropped, ...rest } = cur.manual;
  cur.manual = rest;
  await writeOverrides(cur);
  await db.insert(auditLog).values({
    actor: "user",
    action: "override_cleared",
    details: { knob: k, via: "dashboard" },
  });
  revalidatePath("/");
}

/** Release every manual pin at once — back to full auto/base control. */
export async function resetOverrides(): Promise<void> {
  const cur = await readOverrides();
  cur.manual = {};
  await writeOverrides(cur);
  await db.insert(auditLog).values({ actor: "user", action: "overrides_reset", details: { via: "dashboard" } });
  revalidatePath("/");
}

/**
 * Set the adaptive policy's authority: off (ignore it), advisory (compute + show
 * but never apply), or live (the policy's recommendations drive the trader where
 * no manual pin overrides them). Ships in advisory until a clean prime run gives
 * the policy its favorable-regime pole.
 */
export async function setAutoMode(mode: string): Promise<void> {
  const m: AutoMode = mode === "live" || mode === "off" ? mode : "advisory";
  const cur = await readOverrides();
  cur.autoMode = m;
  await writeOverrides(cur);
  await db.insert(auditLog).values({ actor: "user", action: "auto_mode_set", details: { mode: m, via: "dashboard" } });
  revalidatePath("/");
}

/**
 * The "engage" channel: the user sets RIDE or CUT on an open position from the
 * dashboard. The trader honors it on its next poll — CUT sells immediately, RIDE
 * suspends the mechanical trail/hard stops for one tick so a runner can push
 * through a wick. Supersedes any prior unapplied intent for the position.
 */
export async function setManagementIntent(positionId: number, intent: "ride" | "cut"): Promise<void> {
  await db
    .update(managementIntents)
    .set({ applied: true, appliedAt: new Date() })
    .where(and(eq(managementIntents.positionId, positionId), eq(managementIntents.applied, false)));
  await db.insert(managementIntents).values({ positionId, intent, source: "user" });
  await db.insert(auditLog).values({
    actor: "user",
    action: "management_intent",
    details: { positionId, intent, via: "dashboard" },
  });
  revalidatePath("/");
}

/**
 * Manual harvest: sell every green (profitable, sellable) open position at market
 * on the trader's next manage cycle. Sets the `harvest_now` flag the trader reads
 * (harvestRequested); the trader clears it after sweeping. This is the user's
 * "collapse all the winners when I want" button — banks the book before a rug
 * round-trips it, independent of the automatic $30 basket threshold.
 */
export async function requestHarvest(): Promise<void> {
  await db
    .insert(config)
    .values({ key: "harvest_now", value: { enabled: true }, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: config.key,
      set: { value: { enabled: true }, updatedAt: new Date() },
    });
  await db.insert(auditLog).values({
    actor: "user",
    action: "harvest_requested",
    details: { via: "dashboard" },
  });
  revalidatePath("/");
}

/**
 * Manual close for a LIVE position (operator control restored 2026-07-24 —
 * "PigMan opened but there is no way for me to close and manage the trade").
 * Writes a `live_close_request` the trader consumes on its next cycle (same
 * trusted queue pattern as wallet sends — the trader stays the single
 * money-mover); the close runs through liveSellPosition's full fire-sale
 * machinery as reason `user_cut`.
 */
/** Read back the close request's verdict so the button can report it —
 * the DIP incident (2026-07-25): a close against a drained pool failed
 * silently and looked like the click did nothing. */
export async function getLiveCloseStatus(
  positionId: number,
): Promise<"pending" | "failed" | "done" | "superseded" | null> {
  const [row] = await db.select().from(config).where(eq(config.key, "live_close_request"));
  const v = row?.value as { positionId?: number; status?: string } | undefined;
  if (!v || v.positionId !== positionId) return v ? "superseded" : null;
  if (v.status === "failed") return "failed";
  if (v.status === "done") return "done";
  return "pending";
}

export async function requestLiveClose(positionId: number): Promise<void> {
  const value = { positionId, status: "pending", requestedAt: new Date().toISOString() };
  await db
    .insert(config)
    .values({ key: "live_close_request", value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: config.key, set: { value, updatedAt: new Date() } });
  await db.insert(auditLog).values({
    actor: "user",
    action: "live_close_requested",
    details: { positionId, via: "dashboard" },
  });
  revalidatePath("/");
}

/** Toggle the kill switch: when enabled, the trader stops opening new positions. */
export async function toggleKillSwitch(): Promise<void> {
  const current = await getKillSwitch();
  const next = !current;
  await db
    .insert(config)
    .values({ key: "kill_switch", value: { enabled: next }, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: config.key,
      set: { value: { enabled: next }, updatedAt: new Date() },
    });
  // A manual halt must NOT be auto-resumed by the breaker cooldown — clear the
  // breaker's trippedAt marker so it's treated as operator-owned.
  if (next) {
    const [bs] = await db.select().from(config).where(eq(config.key, "breaker_state"));
    if (bs && (bs.value as { trippedAt?: number | null })?.trippedAt != null) {
      const merged = { ...(bs.value as object), trippedAt: null };
      await db
        .update(config)
        .set({ value: merged, updatedAt: new Date() })
        .where(eq(config.key, "breaker_state"));
    }
  }
  await db.insert(auditLog).values({
    actor: "user",
    action: next ? "kill_switch_engaged" : "kill_switch_released",
    details: { via: "dashboard" },
  });
  revalidatePath("/");
}

/** C-fix (operator 2026-07-26: "all Trades get a position on the board"):
 * lightweight open-book poll — the heavy page render takes 9-20s, so fast
 * moons opened and closed invisibly between refreshes. The board polls this
 * every few seconds and surfaces any open trade the last render missed. */
export interface OpenBookLite {
  id: number;
  mint: string;
  symbol: string | null;
  lane: string;
  sizeUsd: number;
  signature: string | null;
  openedAt: string;
}
export async function getOpenBookLite(): Promise<OpenBookLite[]> {
  try {
    const { sql } = await import("drizzle-orm");
    const rows = (await db.execute(sql`
      SELECT p.id, p.mint, tk.symbol, p.lane, p.size_usd::float AS size_usd,
             p.signature, p.opened_at
      FROM positions p LEFT JOIN tokens tk ON tk.mint = p.mint
      WHERE p.status = 'open' ORDER BY p.opened_at DESC`)) as unknown as {
      id: number; mint: string; symbol: string | null; lane: string;
      size_usd: number; signature: string | null; opened_at: Date;
    }[];
    return rows.map((r) => ({
      id: r.id, mint: r.mint, symbol: r.symbol, lane: r.lane,
      sizeUsd: Number(r.size_usd), signature: r.signature,
      openedAt: new Date(r.opened_at).toISOString(),
    }));
  } catch {
    return [];
  }
}
