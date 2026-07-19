"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { SymbolMint } from "@/components/ui";
import type { WatchingCandidate } from "@/lib/queries";

// TIME RUNGS (minutes) — the columns of the DNA map, out to the ~1000s moonshot horizon.
// Every row's columns are the SAME moment, so the archetype reads right off the shape: a
// dud stays cold across all rungs, a climber warms left→right, a moonshot goes incandescent.
const RUNGS = [0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 7, 10, 13, 16];

// mark AS OF a rung = the latest tick with age ≤ rung; null if the trade hasn't reached it yet.
function markAtRung(spark: { mm: number; t: number }[], rung: number): number | null {
  const latest = spark.length ? spark[spark.length - 1]!.t : 0;
  if (latest < rung) return null; // future rung — not lit yet
  let m: number | null = null;
  for (const p of spark) if (p.t <= rung) m = p.mm;
  return m;
}

// live archetype read off the unfolding shape (the genome: winners lift by ~2.5m, peak ~15m).
function archetype(mark: number, peak: number, age: number): { tag: string; color: string } {
  if (peak >= 3) return { tag: "MOON", color: "var(--status-good)" };
  if (mark >= 1.5) return { tag: "CLIMBER", color: "var(--status-good)" };
  if (age >= 2.5 && peak < 1.08) return { tag: "DUD", color: "var(--text-muted)" };
  if (age >= 2.5 && mark < peak * 0.9) return { tag: "STALLER", color: "var(--status-warning)" };
  if (mark >= 1.1) return { tag: "RISING", color: "var(--series-1)" };
  return { tag: "…", color: "var(--text-muted)" };
}

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
  const arch = archetype(c.markMultiple, c.peakMultiple, c.watchMinutes);
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
      {/* archetype read-off */}
      <span className="w-[62px] shrink-0 text-[9px] font-bold uppercase tracking-wide" style={{ color: arch.color }} title="live archetype from the trajectory shape">
        {arch.tag}
      </span>
      {/* DNA strip — mark at each fixed TIME RUNG (same moment every row) */}
      <div className="flex flex-1 gap-[2px]">
        {RUNGS.map((rung) => {
          const m = markAtRung(c.spark, rung);
          return (
            <div
              key={rung}
              className="h-3.5 flex-1 rounded-[1px] transition-colors duration-500"
              style={{ background: m == null ? "var(--page)" : heatColor(m) }}
              title={m == null ? `${rung}m: not reached` : `${rung}m: ${m.toFixed(2)}×`}
            />
          );
        })}
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
          Trade DNA · trajectory rungs · {watching.length} live
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
          {/* rung header — the time axis every row shares */}
          <div className="flex items-center gap-2 px-2">
            <div className="w-[132px] shrink-0" />
            <div className="w-[62px] shrink-0" />
            <div className="flex flex-1 gap-[2px]">
              {RUNGS.map((r) => (
                <span key={r} className="flex-1 text-center text-[8px]" style={{ color: "var(--text-muted)" }}>
                  {r < 1 ? `${Math.round(r * 60)}s` : `${r}m`}
                </span>
              ))}
            </div>
          </div>
          {sorted.map((c) => (
            <Row key={c.mint} c={c} />
          ))}
        </div>
      )}
      <p className="mt-2 text-[10px]" style={{ color: "var(--text-muted)" }}>
        Columns are fixed TIME RUNGS (30s → 16m, the ~1000s horizon) — every row shares the same clock, so the
        shape IS the genome: a dud stays cold flat, a climber warms left→right, a moonshot goes incandescent.
        Green = above entry, red = below, grey = rung not reached yet. ⚡ = confirmed for entry. Live.
      </p>
    </div>
  );
}
