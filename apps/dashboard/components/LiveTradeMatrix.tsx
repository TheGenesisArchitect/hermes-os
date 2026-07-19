"use client";

import type { LiveTrade } from "@/lib/queries";

/**
 * MINI TRADE MATRIX for the Live Wallet panel. The big Trade Matrix is paper-
 * dominated (thousands of closes to live's dozens), so live trades vanish in it.
 * This is the live book at a glance: one bar per recent live trade, DIVERGING
 * from a breakeven baseline —
 *   • UP / green   = banked a profit   (height ∝ % gained)
 *   • DOWN / red   = closed a loss      (depth ∝ % lost)
 *   • blue + glow  = OPEN right now     (level = current mark vs cost)
 * Oldest → newest, left → right. Hover a bar for the detail.
 *
 * (Height encodes the realized/marked multiple, not the peak — live positions
 * don't yet track peak_price the way paper does; that's a follow-up that would
 * add the "money left on the table" notch the big matrix shows.)
 */

const HALF = 26; // px each side of the breakeven baseline

// sqrt so a small ±20% move is still clearly visible; ±100% fills the half-bar.
function mag(devAbs: number): number {
  return Math.sqrt(Math.min(1, devAbs));
}
function fmtPct(mult: number): string {
  const p = (mult - 1) * 100;
  return `${p >= 0 ? "+" : ""}${p.toFixed(0)}%`;
}

export function LiveTradeMatrix({ trades }: { trades: LiveTrade[] }) {
  if (!trades.length) {
    return (
      <div
        className="rounded-md px-3 py-4 text-center text-[11px]"
        style={{ background: "var(--surface-1)", border: "1px solid var(--gridline)", color: "var(--text-muted)" }}
      >
        No live trades yet — bars appear as the wallet mirrors paper.
      </div>
    );
  }

  const ordered = [...trades].reverse(); // query is most-recent-first
  const openCount = trades.filter((t) => t.status === "open").length;

  return (
    <div className="rounded-md px-3 py-2.5" style={{ background: "var(--surface-1)", border: "1px solid var(--gridline)" }}>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
          Live matrix · last {ordered.length}
          {openCount ? ` · ${openCount} open` : ""}
        </span>
        <span className="text-[9px]" style={{ color: "var(--text-muted)" }}>up = banked · down = loss</span>
      </div>

      {/* diverging bars around a center breakeven line */}
      <div className="relative flex items-stretch gap-[3px] overflow-x-auto" style={{ height: HALF * 2 }}>
        {/* breakeven baseline */}
        <div className="pointer-events-none absolute inset-x-0" style={{ top: HALF, height: 1, background: "var(--gridline)" }} />
        {ordered.map((t, i) => {
          const isOpen = t.status === "open";
          const mult = isOpen ? (t.sizeUsd > 0 && t.markUsd != null ? t.markUsd / t.sizeUsd : 1) : t.resultMult;
          const dev = mult - 1;
          const up = dev >= 0;
          const h = Math.max(2, Math.round(mag(Math.abs(dev)) * HALF));
          const color = isOpen ? "var(--series-1)" : up ? "var(--status-good)" : "var(--status-critical)";
          const detail = isOpen
            ? `OPEN · mark $${(t.markUsd ?? 0).toFixed(2)} / cost $${t.sizeUsd.toFixed(2)} (${fmtPct(mult)})`
            : `${t.pnlUsd >= 0 ? "+" : ""}$${t.pnlUsd.toFixed(2)} (${fmtPct(mult)}) · ${t.exitReason ?? "closed"}`;
          return (
            <div
              key={`${t.mint}-${i}`}
              className="group relative flex shrink-0 flex-col justify-center transition-transform hover:-translate-y-px"
              style={{ width: 7 }}
              title={`${t.symbol ?? t.mint.slice(0, 4)} · $${t.sizeUsd.toFixed(2)} · ${detail}`}
            >
              {/* the half we don't use keeps the bar centered on the baseline */}
              <div className="flex flex-col justify-end" style={{ height: HALF }}>
                {up ? (
                  <div
                    className="w-full rounded-t-[2px]"
                    style={{ height: h, background: color, opacity: isOpen ? 0.95 : 0.82, boxShadow: isOpen ? `0 0 5px ${color}` : "none" }}
                  />
                ) : null}
              </div>
              <div className="flex flex-col justify-start" style={{ height: HALF }}>
                {!up ? (
                  <div
                    className="w-full rounded-b-[2px]"
                    style={{ height: h, background: color, opacity: isOpen ? 0.95 : 0.82, boxShadow: isOpen ? `0 0 5px ${color}` : "none" }}
                  />
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {/* legend */}
      <div className="mt-1.5 flex items-center gap-3 text-[9px]" style={{ color: "var(--text-muted)" }}>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm" style={{ background: "var(--series-1)", boxShadow: "0 0 4px var(--series-1)" }} />
          open
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm" style={{ background: "var(--status-good)" }} />
          banked
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm" style={{ background: "var(--status-critical)" }} />
          loss
        </span>
      </div>
    </div>
  );
}
