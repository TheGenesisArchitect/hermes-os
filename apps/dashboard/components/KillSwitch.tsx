"use client";

import { useTransition } from "react";
import { toggleKillSwitch } from "@/app/actions";

export function KillSwitch({ engaged }: { engaged: boolean }) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      onClick={() => startTransition(() => toggleKillSwitch())}
      disabled={pending}
      className="rounded-md px-3 py-1.5 text-sm font-medium transition-opacity disabled:opacity-50"
      style={
        engaged
          ? { background: "var(--status-critical)", color: "#fff" }
          : { background: "var(--surface-1)", border: "1px solid var(--border)", color: "var(--text-secondary)" }
      }
      title={
        engaged
          ? "Trading halted — no new positions will open. Click to resume."
          : "Click to halt all new position entries."
      }
    >
      {pending ? "…" : engaged ? "⛔ HALTED — resume trading" : "Kill switch"}
    </button>
  );
}
