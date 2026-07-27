"use client";

/**
 * ARM / DISARM — the live wallet's master switch, on the cockpit
 * (operator 2026-07-27: "We need an Arm DisArm button right on the wallet").
 * Two-step confirm so a stray tap can never move the wallet's state.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setLiveArm } from "@/app/actions";

export function ArmSwitch({ armed: initial }: { armed: boolean }) {
  const [armed, setArmed] = useState(initial);
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();

  const label = armed ? "◆ LIVE ARMED" : "⛔ LIVE DISARMED";
  const action = armed ? "DISARM" : "ARM";
  const tone = armed ? "var(--status-good)" : "var(--status-critical)";

  return (
    <span className="flex items-center gap-2">
      <span className="text-xs font-semibold" style={{ color: tone }}>{label}</span>
      {confirming ? (
        <>
          <button
            className="rounded px-2 py-1 text-xs font-bold"
            style={{ border: `1px solid ${tone}`, color: tone, opacity: pending ? 0.5 : 1 }}
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await setLiveArm(!armed);
                setArmed(r.armed);
                setConfirming(false);
                router.refresh();
              })
            }
          >
            {pending ? "…" : `CONFIRM ${action}`}
          </button>
          <button
            className="rounded px-2 py-1 text-xs"
            style={{ border: "1px solid var(--border-subtle)", color: "var(--text-muted)" }}
            onClick={() => setConfirming(false)}
          >
            cancel
          </button>
        </>
      ) : (
        <button
          className="rounded px-2 py-1 text-xs font-bold"
          style={{ border: "1px solid var(--border-subtle)", color: "var(--text-secondary)" }}
          onClick={() => setConfirming(true)}
        >
          {action}
        </button>
      )}
    </span>
  );
}
