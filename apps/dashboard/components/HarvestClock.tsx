import type { HarvestClockView } from "@hermes/core";

/**
 * HARVEST CLOCK — the book-level gauge above the per-trade DNA chips: the average moonshot
 * clock across every open trade right now. Low = a young book still developing; high = the
 * book as a whole is maturing past prime → the portfolio's "time to harvest" reading.
 */
export function HarvestClock({ view }: { view: HarvestClockView }) {
  if (view.n === 0) return null;
  const pct = Math.round(view.avgClockPct * 100);
  const hot = view.avgClockPct >= 0.9;
  const warm = view.avgClockPct >= 0.6;
  const color = hot ? "var(--status-critical)" : warm ? "var(--status-warning)" : "var(--status-good)";
  const avgMin = (view.avgAgeSec / 60).toFixed(1);
  return (
    <div className="flex items-center gap-2 text-xs" title="average moonshot clock across the open book">
      <span className="uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Harvest clock</span>
      <span className="relative inline-block h-2 w-24 overflow-hidden rounded-full" style={{ background: "var(--gridline)" }}>
        <span className="absolute left-0 top-0 h-full rounded-full" style={{ width: `${Math.min(100, pct)}%`, background: color }} />
      </span>
      <span className="tabular font-semibold" style={{ color }}>{pct}%</span>
      <span className="tabular" style={{ color: "var(--text-muted)" }}>
        avg {avgMin}m · {view.n} open{view.pastPrime > 0 ? ` · ${view.pastPrime} past prime` : ""}
      </span>
    </div>
  );
}
