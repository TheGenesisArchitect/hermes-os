"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { SymbolMint } from "@/components/ui";
import type { WatchingCandidate } from "@/lib/queries";

// Trajectory resolution — the most-recent N ticks form each candidate's heat row.
const COLS = 28;

// Diverging heat around the 1.0× breakeven midpoint: gridline-neutral at flat,
// deepening green above (gain) and red below (loss). Gamma < 1 so small moves are
// still visible. This is the dataviz "magnitude+polarity → diverging" rule: two
// hues + a neutral midpoint, never a rainbow.
const NEUTRAL: [number, number, number] = [38, 38, 36];
const GAIN: [number, number, number] = [22, 190, 80];
const LOSS: [number, number, number] = [214, 62, 62];

function mix(a: [number, number, number], b: [number, number, number], t: number): string {
  const g = Math.pow(Math.max(0, Math.min(1, t)), 0.7);
  return `rgb(${a.map((x, i) => Math.round(x + (b[i] - x) * g)).join(",")})`;
}
function heatColor(mm: number): string {
  if (mm >= 1) return mix(NEUTRAL, GAIN, (mm - 1) / 2); // 1×→neutral, 3×+→full green
  return mix(NEUTRAL, LOSS, (1 - mm) / 0.6); // 1×→neutral, 0.4×→full red
}

function Row({ c }: { c: WatchingCandidate }) {
  const cells = c.spark.slice(-COLS);
  const pad = Math.max(0, COLS - cells.length);
  return (
    <div
      className="flex items-center gap-2 rounded-md px-2 py-1"
      style={c.triggered ? { background: "rgba(57,135,229,0.08)", boxShadow: "inset 2px 0 0 var(--series-1)" } : undefined}
    >
      {/* identity */}
      <div className="flex w-[132px] shrink-0 items-center gap-1 overflow-hidden">
        {c.triggered ? <span title="confirmed for entry" className="text-[10px]">⚡</span> : null}
        <Link href={`/token/${c.mint}`} className="truncate text-xs hover:underline">
          <SymbolMint symbol={c.symbol} mint={c.mint} />
        </Link>
      </div>
      {/* heat strip */}
      <div className="flex flex-1 gap-[2px]">
        {Array.from({ length: pad }).map((_, i) => (
          <div key={`p${i}`} className="h-3.5 flex-1 rounded-[1px]" style={{ background: "var(--page)" }} />
        ))}
        {cells.map((t, i) => (
          <div
            key={i}
            className="h-3.5 flex-1 rounded-[1px] transition-colors duration-500"
            style={{ background: heatColor(t.mm) }}
            title={`t${t.i}: ${t.mm.toFixed(2)}×`}
          />
        ))}
      </div>
      {/* trader disposition — why an armed row is/isn't a trade */}
      {c.disposition ? (
        <span
          className="shrink-0 rounded px-1 py-px text-[9px]"
          style={{
            color:
              c.disposition === "in book ✓" || c.disposition.startsWith("traded ✓")
                ? "var(--status-good)"
                : c.disposition.startsWith("traded ·")
                  ? "var(--status-critical)"
                  : c.disposition.startsWith("queued")
                    ? "var(--status-warning)"
                    : "var(--text-muted)",
            border: "1px solid var(--border)",
            background: "var(--surface-1)",
          }}
          title="what the trader did with this confirmation"
        >
          {c.disposition}
        </span>
      ) : null}
      {/* current + peak */}
      <div className="w-[92px] shrink-0 text-right">
        <span
          className="tabular text-xs font-semibold"
          style={{ color: c.markMultiple >= 1 ? "var(--status-good)" : "var(--status-critical)" }}
        >
          {c.markMultiple.toFixed(2)}×
        </span>
        <span className="tabular ml-1 text-[10px]" style={{ color: "var(--text-muted)" }}>
          pk {c.peakMultiple.toFixed(1)}×
        </span>
      </div>
    </div>
  );
}

export function TrajectoryHeatmap({ watching }: { watching: WatchingCandidate[] }) {
  const [byPeak, setByPeak] = useState(false);
  // Best performers on top — by live mark (heat right now) or session peak.
  const sorted = useMemo(
    () =>
      [...watching].sort((a, b) =>
        byPeak ? b.peakMultiple - a.peakMultiple : b.markMultiple - a.markMultiple,
      ),
    [watching, byPeak],
  );

  return (
    <div className="card p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
          Live trajectories · {watching.length} in window
        </h3>
        <div className="flex items-center gap-3">
          {/* diverging legend */}
          <div className="flex items-center gap-1 text-[10px]" style={{ color: "var(--text-muted)" }}>
            <span>0.4×</span>
            <div
              className="h-2 w-24 rounded-sm"
              style={{ background: `linear-gradient(90deg, ${heatColor(0.4)}, ${heatColor(1)}, ${heatColor(2)}, ${heatColor(3)})` }}
            />
            <span>3×+</span>
          </div>
          <button
            onClick={() => setByPeak((v) => !v)}
            className="rounded px-2 py-0.5 text-[11px] transition-colors hover:brightness-125"
            style={{ background: "var(--surface-1)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}
          >
            sort: {byPeak ? "peak" : "live"}
          </button>
        </div>
      </div>
      {watching.length === 0 ? (
        <div className="py-6 text-center text-xs" style={{ color: "var(--text-muted)" }}>
          No candidates in their watch window right now. Each row lights up the moment SCOUT passes one
          through safety — the strip is its mark-multiple every tick, oldest → newest.
        </div>
      ) : (
        <div className="space-y-[3px]">
          {sorted.map((c) => (
            <Row key={c.mint} c={c} />
          ))}
        </div>
      )}
      <p className="mt-2 text-[10px]" style={{ color: "var(--text-muted)" }}>
        Each strip = one candidate&apos;s mark multiple every tick (oldest left → newest right). Green = above
        entry, red = below. ⚡ = confirmed for entry. Refreshes live.
      </p>
    </div>
  );
}
