"use server";

import { auditLog, config, db } from "@hermes/db";
import { revalidatePath } from "next/cache";
import { getKillSwitch } from "@/lib/queries";

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
  await db.insert(auditLog).values({
    actor: "user",
    action: next ? "kill_switch_engaged" : "kill_switch_released",
    details: { via: "dashboard" },
  });
  revalidatePath("/");
}
