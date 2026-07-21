"use client";

import {
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";

export interface CapturePoint {
  symbol: string;
  signature: string;
  lane: string;
  peakX: number;
  exitX: number;
  pnl: number;
  sizeUsd: number;
}

// PEAK vs EXIT — the one chart that shows trade MANAGEMENT rather than luck.
//
// The diagonal is a perfect exit: sold exactly at the high. Every point sits on
// or below it, and the vertical distance to the line is the give-back. The
// horizontal line at 1.0× is entry: a point that is right of 1.0× (the trade
// went up) and below 1.0× (it closed down) is a winner that was managed into a
// loss — the failure P&L alone can never surface.
//
// Both axes are logarithmic: peaks in this book run 1× to 20×+, and on a linear
// axis every normal trade collapses into the bottom-left corner.

const TICKS = [1, 1.5, 2, 3, 5, 10, 20, 50];
const FLOOR = 0.1; // exits below this (dust rugs) are pinned so log can plot them

export function CaptureScatter({ points }: { points: CapturePoint[] }) {
  if (points.length === 0) {
    return (
      <div className="flex h-[240px] items-center justify-center text-xs" style={{ color: "var(--text-muted)" }}>
        No closed trades in this window.
      </div>
    );
  }
  const maxX = Math.max(2, ...points.map((p) => p.peakX));
  const shape = (p: CapturePoint) => ({
    ...p,
    x: Math.max(1, p.peakX),
    y: Math.max(FLOOR, p.exitX),
    z: Math.max(1, p.sizeUsd),
  });
  const paper = points.filter((p) => p.lane !== "live").map(shape);
  const live = points.filter((p) => p.lane === "live").map(shape);

  return (
    <ResponsiveContainer width="100%" height={240}>
      <ScatterChart margin={{ top: 8, right: 12, bottom: 18, left: 4 }}>
        <CartesianGrid stroke="var(--gridline)" strokeDasharray="2 4" />
        <XAxis
          type="number"
          dataKey="x"
          scale="log"
          domain={[1, Math.ceil(maxX * 1.1)]}
          ticks={TICKS.filter((t) => t <= maxX * 1.1)}
          tickFormatter={(v: number) => `${v}×`}
          tick={{ fill: "var(--text-muted)", fontSize: 10 }}
          stroke="var(--baseline)"
          label={{ value: "peak reached", position: "insideBottom", offset: -12, fill: "var(--text-muted)", fontSize: 10 }}
        />
        <YAxis
          type="number"
          dataKey="y"
          scale="log"
          domain={[FLOOR, Math.ceil(maxX * 1.1)]}
          ticks={[0.1, 0.25, 0.5, 1, 2, 3, 5, 10, 20].filter((t) => t <= maxX * 1.1)}
          tickFormatter={(v: number) => `${v}×`}
          tick={{ fill: "var(--text-muted)", fontSize: 10 }}
          stroke="var(--baseline)"
          width={38}
        />
        <ZAxis type="number" dataKey="z" range={[24, 190]} />
        {/* perfect exit — sold at the high */}
        <ReferenceLine
          segment={[
            { x: 1, y: 1 },
            { x: Math.ceil(maxX * 1.1), y: Math.ceil(maxX * 1.1) },
          ]}
          stroke="var(--status-good)"
          strokeDasharray="4 4"
          strokeOpacity={0.7}
        />
        {/* entry — below this line the trade closed red */}
        <ReferenceLine y={1} stroke="var(--status-critical)" strokeOpacity={0.55} />
        <Tooltip
          cursor={{ stroke: "var(--gridline)" }}
          contentStyle={{
            background: "var(--surface-1)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            fontSize: 11,
          }}
          formatter={(_v, _n, item: { payload?: CapturePoint }) => {
            const p = item?.payload;
            if (!p) return null;
            return [
              `${p.peakX.toFixed(2)}× peak → ${p.exitX.toFixed(2)}× exit · ${p.pnl >= 0 ? "+" : "−"}$${Math.abs(p.pnl).toFixed(2)}`,
              `${p.symbol} · ${p.signature.replace("MOON_", "M·").toLowerCase()}`,
            ];
          }}
          labelFormatter={() => ""}
        />
        <Scatter name="paper" data={paper} fill="var(--series-1)" fillOpacity={0.55} stroke="var(--series-1)" />
        <Scatter name="live" data={live} fill="var(--status-serious)" fillOpacity={0.85} stroke="var(--status-serious)" />
      </ScatterChart>
    </ResponsiveContainer>
  );
}
