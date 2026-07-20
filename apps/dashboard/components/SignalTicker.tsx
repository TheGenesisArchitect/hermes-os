"use client";

// SIGNAL TICKER — the scout's live tape as a marquee under the header. Replaces
// the old table panel: signals are a FLOW, not a table you read top-to-bottom,
// and freeing the bottom of the page buys room for the trade ledger.
// Pure CSS marquee (no JS timer), pauses on hover so a row can be clicked.
import { MintLink } from "@/components/ui";
import type { getRecentSignals } from "@/lib/queries";

type RecentSignal = Awaited<ReturnType<typeof getRecentSignals>>[number];

const STATUS_TONE: Record<string, string> = {
  traded_paper: "var(--status-good)",
  confirmed: "var(--status-good)",
  new: "var(--series-1)",
  expired: "var(--text-muted)",
  dismissed: "var(--text-muted)",
};

export function SignalTicker({ signals }: { signals: RecentSignal[] }) {
  if (signals.length === 0) return null;
  // Duplicate the run so the marquee loops seamlessly.
  const run = [...signals, ...signals];
  return (
    <div
      className="signal-ticker relative overflow-hidden rounded-lg"
      style={{ background: "var(--surface-0)", border: "1px solid var(--border)" }}
    >
      <div
        className="pointer-events-none absolute left-0 top-0 z-10 flex h-full items-center px-3 text-[10px] font-semibold uppercase tracking-wider"
        style={{ background: "linear-gradient(90deg, var(--surface-0) 70%, transparent)", color: "var(--series-1)" }}
      >
        ⚡ Scout tape
      </div>
      <div className="signal-ticker-track flex gap-6 whitespace-nowrap py-2 pl-28 pr-4">
        {run.map((s, i) => (
          <span key={`${s.id}-${i}`} className="inline-flex items-center gap-1.5 text-xs">
            <MintLink mint={s.mint} symbol={s.symbol} />
            <span className="tabular" style={{ color: "var(--text-muted)" }}>{Number(s.score).toFixed(0)}</span>
            <span style={{ color: STATUS_TONE[s.status] ?? "var(--text-muted)" }}>{s.status.replace("traded_paper", "traded")}</span>
            <span style={{ color: "var(--gridline)" }}>·</span>
          </span>
        ))}
      </div>
    </div>
  );
}
