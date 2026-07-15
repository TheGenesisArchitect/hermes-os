"use server";

import { auditLog, config, db, managementIntents } from "@hermes/db";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getKillSwitch } from "@/lib/queries";

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
