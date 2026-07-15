"use client";

import { useState, useTransition } from "react";
import { requestHarvest } from "@/app/actions";

/**
 * Manual "collapse the winners" control. Shows the live green float so the
 * operator knows what a sweep would bank, and asks for one confirmation click
 * (the sweep is irreversible — it market-sells every green position). The trader
 * executes on its next 5s manage cycle and clears the flag.
 */
export function HarvestButton({
  greenCount,
  greenUsd,
  suspendedCount = 0,
}: {
  greenCount: number; // SELLABLE greens only — what the sweep will actually bank
  greenUsd: number;
  suspendedCount?: number; // greens on a dust/no-pair read this cycle — sweep skips them
}) {
  const [pending, startTransition] = useTransition();
  const [armed, setArmed] = useState(false);
  const nothingToSweep = greenCount === 0;

  return (
    <div className="flex items-center gap-2">
      {suspendedCount > 0 ? (
        <span
          className="text-xs"
          style={{ color: "var(--status-warning)" }}
          title="Green by last mark, but the pool read dust/no-pair this cycle — the sweep can't sell them until the pool reads real again."
        >
          ⏸ {suspendedCount} suspended
        </span>
      ) : null}
      {armed && !nothingToSweep ? (
        <>
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            Sell {greenCount} green (+${greenUsd.toFixed(2)})?
          </span>
          <button
            onClick={() => {
              setArmed(false);
              startTransition(() => requestHarvest());
            }}
            disabled={pending}
            className="rounded-md px-3 py-1.5 text-sm font-semibold transition-opacity disabled:opacity-50"
            style={{ background: "var(--status-good)", color: "#04120a" }}
          >
            {pending ? "…" : "Confirm sweep"}
          </button>
          <button
            onClick={() => setArmed(false)}
            className="rounded-md px-2 py-1.5 text-xs"
            style={{ background: "var(--surface-1)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}
          >
            Cancel
          </button>
        </>
      ) : (
        <button
          onClick={() => setArmed(true)}
          disabled={nothingToSweep}
          className="rounded-md px-3 py-1.5 text-sm font-medium transition-opacity disabled:opacity-40"
          style={{ background: "var(--surface-1)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}
          title={
            nothingToSweep
              ? "No green positions to harvest right now."
              : "Sell all green positions at market on the next trader cycle."
          }
        >
          {nothingToSweep ? "Harvest greens" : `💰 Harvest ${greenCount} green (+$${greenUsd.toFixed(2)})`}
        </button>
      )}
    </div>
  );
}
