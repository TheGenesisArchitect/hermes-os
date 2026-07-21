"use client";

import {
  Area,
  ComposedChart,
  CartesianGrid,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface Point {
  at: string; // ISO
  equity: number;
  /** Live-wallet equity at the same instant, once the wallet is trading. */
  live?: number | null;
  /** Fitted paper trend at this instant — the dashed guide line. */
  trend?: number | null;
}

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

const fmtUsd = (v: number) =>
  v.toLocaleString(undefined, { style: "currency", currency: "USD" });

/**
 * EQUITY CURVE — paper, the live wallet once it trades, and a trendline.
 *
 * Live runs its OWN signals rather than mirroring, so the two curves are a real
 * comparison: same signatures, same rules, two balances. They share this one
 * panel deliberately — a second chart would invite reading them apart when the
 * gap between them is the whole point.
 *
 * The lanes hold very different capital, so live is plotted on its own right-hand
 * axis. Forcing both onto a single dollar scale would flatten the smaller lane
 * into a line at the bottom regardless of how it actually performed.
 */
export function EquityChart({
  data,
  bankroll,
  liveActive = false,
  paperTrendPerHour = 0,
  liveTrendPerHour = 0,
}: {
  data: Point[];
  bankroll: number;
  liveActive?: boolean;
  paperTrendPerHour?: number;
  liveTrendPerHour?: number;
}) {
  void bankroll;
  if (data.length < 2) {
    return (
      <div
        className="flex h-56 items-center justify-center text-sm"
        style={{ color: "var(--text-muted)" }}
      >
        Equity curve appears after a few snapshots — the trader records one every 5 minutes.
      </div>
    );
  }

  const fmtTrend = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%/h`;
  const lastLive = [...data].reverse().find((d) => d.live != null)?.live ?? null;

  return (
    <div className="flex flex-col gap-1">
      {/* The legend carries the TRENDS, because an equity curve is too noisy to
          read direction from by eye — the number is the signal, the line is context. */}
      <div className="flex flex-wrap gap-4 text-[11px] tabular">
        <span style={{ color: "var(--series-1)" }}>
          ● paper {fmtUsd(data[data.length - 1]!.equity)}
          <span style={{ color: "var(--text-muted)" }}> · trend {fmtTrend(paperTrendPerHour)}</span>
        </span>
        <span style={{ color: liveActive ? "var(--status-critical)" : "var(--text-muted)" }}>
          ● live {liveActive && lastLive != null ? fmtUsd(lastLive) : "off"}
          {liveActive && <span style={{ color: "var(--text-muted)" }}> · trend {fmtTrend(liveTrendPerHour)}</span>}
        </span>
      </div>

      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--series-1)" stopOpacity={0.25} />
                <stop offset="100%" stopColor="var(--series-1)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--gridline)" strokeWidth={1} vertical={false} />
            <XAxis
              dataKey="at"
              tickFormatter={fmtTime}
              tick={{ fill: "var(--text-muted)", fontSize: 11 }}
              axisLine={{ stroke: "var(--baseline)" }}
              tickLine={false}
              minTickGap={60}
            />
            <YAxis
              yAxisId="paper"
              domain={["auto", "auto"]}
              tickFormatter={(v: number) => `$${v.toFixed(0)}`}
              tick={{ fill: "var(--text-muted)", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={52}
            />
            {liveActive && (
              <YAxis
                yAxisId="live"
                orientation="right"
                domain={["auto", "auto"]}
                tickFormatter={(v: number) => `$${v.toFixed(0)}`}
                tick={{ fill: "var(--status-critical)", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={52}
              />
            )}
            <Tooltip
              cursor={{ stroke: "var(--text-muted)", strokeWidth: 1, strokeDasharray: "3 3" }}
              contentStyle={{
                background: "var(--surface-1)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                color: "var(--text-primary)",
                fontSize: 12,
              }}
              labelFormatter={(iso) => fmtTime(String(iso))}
              formatter={(value, name) => [
                fmtUsd(Number(value)),
                name === "live" ? "Live wallet" : name === "trend" ? "Paper trend" : "Paper equity",
              ]}
            />
            <Area
              yAxisId="paper"
              type="monotone"
              dataKey="equity"
              stroke="var(--series-1)"
              strokeWidth={2}
              fill="url(#equityFill)"
              dot={false}
              activeDot={{ r: 4, fill: "var(--series-1)", stroke: "var(--surface-1)", strokeWidth: 2 }}
              isAnimationActive={false}
            />
            {/* Least-squares trend on paper — direction at a glance. */}
            <Line
              yAxisId="paper"
              type="linear"
              dataKey="trend"
              stroke="var(--series-1)"
              strokeWidth={1.5}
              strokeDasharray="6 4"
              strokeOpacity={0.5}
              dot={false}
              isAnimationActive={false}
              connectNulls
            />
            {/* The live wallet on its own axis — same signals, real capital. */}
            {liveActive && (
              <Line
                yAxisId="live"
                type="monotone"
                dataKey="live"
                stroke="var(--status-critical)"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, fill: "var(--status-critical)", stroke: "var(--surface-1)", strokeWidth: 2 }}
                isAnimationActive={false}
                connectNulls
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {liveActive && (
        <p className="m-0 text-[10px]" style={{ color: "var(--text-muted)" }}>
          Live is plotted on the right axis — the lanes hold very different capital, so a single dollar scale would
          flatten the smaller one regardless of how it performed.
        </p>
      )}
    </div>
  );
}
