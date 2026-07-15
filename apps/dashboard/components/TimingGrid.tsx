"use client";

import { useState } from "react";
import type { TimingGridView, TimingTrade } from "@/lib/queries";

// The live timing field: time (seconds since entry) on the floor, multiple on the
// wall. Every trade is a trajectory colored by what it's doing RIGHT NOW — rising
// (green), stalling (amber), falling (red). TP rails and the DNA time-zones
// (danger <150s where rugs peak, runner >300s where winners live) turn it from a
// chart into the exit doctrine you can watch: floor set fast, ceiling left open.

const W = 1000;
const H = 300;
const PAD = { top: 16, right: 70, bottom: 30, left: 46 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

const STATE_COLOR: Record<TimingTrade["state"], string> = {
  rising: "var(--status-good)",
  stalling: "var(--status-warning)",
  falling: "var(--status-critical)",
};
const ZONE_TINT: Record<string, string> = {
  danger: "var(--status-critical)",
  develop: "var(--status-warning)",
  runner: "var(--status-good)",
};

const fmtSec = (s: number) => (s >= 60 ? `${Math.round(s / 60)}m` : `${Math.round(s)}s`);

export function TimingGrid({ view }: { view: TimingGridView }) {
  const [hovered, setHovered] = useState<number | null>(null);

  const open = view.trades.filter((t) => t.status === "open");
  if (view.trades.length === 0) {
    return (
      <div
        className="flex h-56 items-center justify-center text-sm"
        style={{ color: "var(--text-muted)" }}
      >
        No open or recently-closed trades — the timing field fills as the trader takes positions.
      </div>
    );
  }

  const yMax = Math.max(1.8, ...view.trades.map((t) => t.peakMult)) * 1.04;
  const yMin = 1.0;
  const x = (t: number) => PAD.left + Math.min(1, t / view.maxSec) * PLOT_W;
  const y = (mm: number) =>
    PAD.top + (1 - (Math.max(yMin, Math.min(yMax, mm)) - yMin) / (yMax - yMin)) * PLOT_H;

  // Major x gridlines anchored to the cohort peak-times, plus the horizon.
  const xTicks = [0, 150, 300, 600, 1000].filter((s) => s <= view.maxSec);
  if (!xTicks.includes(view.maxSec)) xTicks.push(view.maxSec);

  const path = (pts: { t: number; mm: number }[]) =>
    pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.mm).toFixed(1)}`).join(" ");

  const hoveredTrade = hovered != null ? view.trades.find((t) => t.id === hovered) ?? null : null;

  return (
    <div className="w-full">
      <div className="mb-1 flex items-center justify-between text-xs" style={{ color: "var(--text-muted)" }}>
        <span>
          Timing grid — {open.length} live · polled every {view.pollSec}s · 1.0× floor, seconds across
        </span>
        <span className="flex gap-3 tabular">
          <span style={{ color: "var(--status-good)" }}>▲ {view.counts.rising} rising</span>
          <span style={{ color: "var(--status-warning)" }}>▬ {view.counts.stalling} stalling</span>
          <span style={{ color: "var(--status-critical)" }}>▼ {view.counts.falling} falling</span>
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ height: "auto", display: "block" }}>
        {/* DNA time-zone bands */}
        {view.zones.map((z) => {
          const x0 = x(z.fromSec);
          const x1 = x(Math.min(z.toSec, view.maxSec));
          return (
            <g key={z.label}>
              <rect x={x0} y={PAD.top} width={Math.max(0, x1 - x0)} height={PLOT_H} fill={ZONE_TINT[z.tone]} opacity={0.05} />
              <text x={(x0 + x1) / 2} y={PAD.top + 12} textAnchor="middle" fontSize={10} fill={ZONE_TINT[z.tone]} opacity={0.65} style={{ textTransform: "uppercase", letterSpacing: 1 }}>
                {z.label}
              </text>
            </g>
          );
        })}

        {/* x gridlines + labels */}
        {xTicks.map((s) => (
          <g key={`x${s}`}>
            <line x1={x(s)} y1={PAD.top} x2={x(s)} y2={PAD.top + PLOT_H} stroke="var(--gridline)" strokeWidth={1} />
            <text x={x(s)} y={H - 10} textAnchor="middle" fontSize={11} fill="var(--text-muted)" className="tabular">
              {s === 0 ? "0" : fmtSec(s)}
            </text>
          </g>
        ))}

        {/* entry baseline 1.0× */}
        <line x1={PAD.left} y1={y(1)} x2={PAD.left + PLOT_W} y2={y(1)} stroke="var(--baseline)" strokeWidth={1.5} />
        <text x={PAD.left - 6} y={y(1) + 3} textAnchor="end" fontSize={11} fill="var(--text-muted)" className="tabular">1.0×</text>

        {/* TP rails */}
        {view.tpLevels.filter((tp) => tp.mult <= yMax).map((tp) => (
          <g key={tp.label}>
            <line x1={PAD.left} y1={y(tp.mult)} x2={PAD.left + PLOT_W} y2={y(tp.mult)} stroke="var(--series-1)" strokeWidth={1} strokeDasharray="4 4" opacity={0.55} />
            <text x={PAD.left - 6} y={y(tp.mult) + 3} textAnchor="end" fontSize={10} fill="var(--text-muted)" className="tabular">{tp.mult}×</text>
            <text x={PAD.left + PLOT_W + 4} y={y(tp.mult) + 3} textAnchor="start" fontSize={10} fill="var(--series-1)" opacity={0.7}>{tp.label}</text>
          </g>
        ))}

        {/* trajectories */}
        {view.trades.map((tr) => {
          if (tr.points.length < 1) return null;
          const dim = hovered != null && hovered !== tr.id;
          const isClosed = tr.status === "closed";
          const color = isClosed
            ? (tr.exit && tr.exit.pnl > 0 ? "var(--status-good)" : "var(--status-critical)")
            : STATE_COLOR[tr.state];
          const last = tr.points[tr.points.length - 1]!;
          return (
            <g
              key={tr.id}
              opacity={dim ? 0.12 : 1}
              onMouseEnter={() => setHovered(tr.id)}
              onMouseLeave={() => setHovered(null)}
              style={{ cursor: "pointer" }}
            >
              {tr.points.length >= 2 && (
                <path
                  d={path(tr.points)}
                  fill="none"
                  stroke={color}
                  strokeWidth={hovered === tr.id ? 2.4 : 1.6}
                  strokeOpacity={isClosed ? 0.4 : 0.9}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  strokeDasharray={tr.isFarm ? "5 3" : undefined}
                />
              )}
              {isClosed && tr.exit ? (
                // exit marker — diamond at the close point
                <path
                  d={`M${x(tr.exit.t)},${y(tr.exit.mm) - 4} L${x(tr.exit.t) + 4},${y(tr.exit.mm)} L${x(tr.exit.t)},${y(tr.exit.mm) + 4} L${x(tr.exit.t) - 4},${y(tr.exit.mm)} Z`}
                  fill={color}
                  opacity={0.85}
                />
              ) : (
                // live leading dot + symbol
                <>
                  <circle cx={x(last.t)} cy={y(last.mm)} r={hovered === tr.id ? 4.5 : 3.2} fill={color} stroke="var(--surface-1)" strokeWidth={1.5} />
                  <text x={x(last.t) + 7} y={y(last.mm) + 3} fontSize={10} fill="var(--text-secondary)" className="tabular">
                    {tr.symbol ?? "?"}
                  </text>
                </>
              )}
            </g>
          );
        })}

        {/* hover detail */}
        {hoveredTrade && (
          <text x={PAD.left + 4} y={PAD.top + PLOT_H - 6} fontSize={11} fill="var(--text-primary)" className="tabular">
            {hoveredTrade.symbol ?? "?"} · {hoveredTrade.curMult.toFixed(2)}× (peak {hoveredTrade.peakMult.toFixed(2)}×) · {fmtSec(hoveredTrade.ageSec)} ·{" "}
            {hoveredTrade.status === "closed"
              ? `${hoveredTrade.exit?.reason ?? "closed"} ${hoveredTrade.exit && hoveredTrade.exit.pnl >= 0 ? "+" : ""}$${hoveredTrade.exit?.pnl.toFixed(2)}`
              : hoveredTrade.state}
            {hoveredTrade.isFarm ? " · farm" : ""}
          </text>
        )}
      </svg>
    </div>
  );
}
