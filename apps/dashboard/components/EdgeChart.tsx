"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { EdgePoint } from "@/lib/queries";

const fmtBucket = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit" });

/**
 * The live edge, over time: what share of each bucket's winners the gate fired on
 * (want high) vs its duds+rugs (want low). The gap between the two lines IS the
 * alpha — this chart is where its decay would show first.
 */
export function EdgeChart({ data }: { data: EdgePoint[] }) {
  const usable = data.filter((d) => d.winnersPct !== null || d.dudsPct !== null);
  if (usable.length < 2) {
    return (
      <div
        className="flex h-44 items-center justify-center px-6 text-center text-xs"
        style={{ color: "var(--text-muted)" }}
      >
        The edge-over-time trend needs a few hours of labeled outcomes to plot — it fills in as the
        recorder closes more 15-minute windows.
      </div>
    );
  }
  return (
    <div className="h-44 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={usable} margin={{ top: 6, right: 8, bottom: 0, left: -8 }}>
          <CartesianGrid stroke="var(--gridline)" strokeWidth={1} vertical={false} />
          <XAxis
            dataKey="bucket"
            tickFormatter={fmtBucket}
            tick={{ fill: "var(--text-muted)", fontSize: 10 }}
            axisLine={{ stroke: "var(--baseline)" }}
            tickLine={false}
            minTickGap={24}
          />
          <YAxis
            domain={[0, 100]}
            ticks={[0, 50, 100]}
            tickFormatter={(v: number) => `${v}%`}
            tick={{ fill: "var(--text-muted)", fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={36}
          />
          <ReferenceLine y={50} stroke="var(--gridline)" strokeDasharray="2 4" />
          <Tooltip
            cursor={{ stroke: "var(--text-muted)", strokeWidth: 1, strokeDasharray: "3 3" }}
            contentStyle={{
              background: "var(--surface-1)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              color: "var(--text-primary)",
              fontSize: 12,
            }}
            labelFormatter={(iso) => fmtBucket(String(iso))}
            formatter={(value, name) => [
              value === null ? "—" : `${Math.round(Number(value))}%`,
              name === "winnersPct" ? "Fired on winners" : "Fired on duds+rugs",
            ]}
          />
          <Line
            type="monotone"
            dataKey="winnersPct"
            name="winnersPct"
            stroke="var(--status-good)"
            strokeWidth={2}
            dot={{ r: 2.5, fill: "var(--status-good)" }}
            connectNulls
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="dudsPct"
            name="dudsPct"
            stroke="var(--status-critical)"
            strokeWidth={2}
            dot={{ r: 2.5, fill: "var(--status-critical)" }}
            connectNulls
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
