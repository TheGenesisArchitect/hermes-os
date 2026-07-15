"use client";

import { Line, LineChart, ResponsiveContainer, YAxis } from "recharts";

/**
 * A bare trend line — no axes, grid, or labels. It carries shape, not value, so
 * the KPI's big number stays the headline. Colored by tone; degrades to a flat
 * baseline when there aren't yet two points to draw.
 */
export function Sparkline({
  data,
  tone = "var(--series-1)",
  height = 28,
}: {
  data: number[];
  tone?: string;
  height?: number;
}) {
  if (!data || data.length < 2) {
    return (
      <div
        className="flex items-center"
        style={{ height }}
        aria-hidden
      >
        <div className="h-px w-full" style={{ background: "var(--gridline)" }} />
      </div>
    );
  }
  const points = data.map((v, i) => ({ i, v }));
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 3, right: 1, bottom: 3, left: 1 }}>
          <YAxis hide domain={["dataMin", "dataMax"]} />
          <Line
            type="monotone"
            dataKey="v"
            stroke={tone}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
