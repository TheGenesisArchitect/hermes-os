"use client";

import {
  Area,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ForecastView } from "@/lib/queries";

const usd0 = (v: number) => `$${Math.round(v).toLocaleString()}`;

/**
 * Monte Carlo equity fan. The bands are drawn with the stacked-transparent-base
 * trick: a zero-opacity Area at the low edge reserves the stack offset, then the
 * visible band Area (high − low) stacks on top of it, filling exactly the p-range.
 * Two independent stacks give the outer (p5–p95) and inner (p25–p75) bands; the
 * median is a plain line; the dashed reference marks the starting equity.
 */
export function ForecastChart({ view }: { view: ForecastView }) {
  const { forecast: f, basis } = view;

  if (f.sampleN === 0) {
    return (
      <div
        className="flex h-52 items-center justify-center px-6 text-center text-xs"
        style={{ color: "var(--text-muted)" }}
      >
        The forecast needs closed, triggered outcomes to bootstrap from — it fills in as the recorder
        labels more confirmed candidates.
      </div>
    );
  }

  const data = f.buckets.map((b) => ({
    t: b.tHours,
    base5: b.p5,
    band5_95: b.p95 - b.p5,
    base25: b.p25,
    band25_75: b.p75 - b.p25,
    p50: b.p50,
    // keep raw for tooltip
    p5: b.p5,
    p25: b.p25,
    p75: b.p75,
    p95: b.p95,
  }));

  return (
    <div>
      <div className="h-52 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: -4 }}>
            <XAxis
              dataKey="t"
              type="number"
              domain={[0, f.assumptions.horizonHours]}
              ticks={Array.from({ length: f.assumptions.horizonHours + 1 }, (_, i) => i).filter((i) => i % 2 === 0)}
              tickFormatter={(v: number) => `${v}h`}
              tick={{ fill: "var(--text-muted)", fontSize: 10 }}
              axisLine={{ stroke: "var(--baseline)" }}
              tickLine={false}
            />
            <YAxis
              tickFormatter={usd0}
              tick={{ fill: "var(--text-muted)", fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              width={46}
              domain={["auto", "auto"]}
            />
            <ReferenceLine
              y={f.startEquity}
              stroke="var(--text-muted)"
              strokeDasharray="3 4"
              label={{ value: "start", fill: "var(--text-muted)", fontSize: 9, position: "insideTopLeft" }}
            />
            {/* outer band p5–p95 */}
            <Area dataKey="base5" stackId="outer" stroke="none" fill="none" isAnimationActive={false} />
            <Area
              dataKey="band5_95"
              stackId="outer"
              stroke="none"
              fill="var(--series-1)"
              fillOpacity={0.13}
              isAnimationActive={false}
            />
            {/* inner band p25–p75 */}
            <Area dataKey="base25" stackId="inner" stroke="none" fill="none" isAnimationActive={false} />
            <Area
              dataKey="band25_75"
              stackId="inner"
              stroke="none"
              fill="var(--series-1)"
              fillOpacity={0.26}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="p50"
              stroke="var(--series-1)"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            <Tooltip
              cursor={{ stroke: "var(--text-muted)", strokeWidth: 1, strokeDasharray: "3 3" }}
              contentStyle={{
                background: "var(--surface-1)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                color: "var(--text-primary)",
                fontSize: 12,
              }}
              labelFormatter={(v) => `+${v}h`}
              formatter={(value, name) => {
                const labels: Record<string, string> = {
                  p50: "median",
                  band5_95: "p95",
                  band25_75: "p75",
                  base5: "p5",
                  base25: "p25",
                };
                if (name === "base5" || name === "base25") return [usd0(Number(value)), labels[name as string]];
                if (name === "p50") return [usd0(Number(value)), "median"];
                return [null, null] as unknown as [string, string];
              }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* summary stats */}
      <div className="mt-2 grid grid-cols-3 gap-2 text-center">
        <Stat label="Median end" value={usd0(f.medianEnd)} tone={f.medianEnd >= f.startEquity ? "good" : "warn"} />
        <Stat label="P(profit)" value={`${Math.round(f.pProfit * 100)}%`} tone="neutral" />
        <Stat
          label="P(breaker)"
          value={`${Math.round(f.pBreaker * 100)}%`}
          tone={f.pBreaker > 0.5 ? "warn" : "neutral"}
        />
      </div>

      {/* basis / honesty caption */}
      <p className="mt-2 text-[11px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
        {basis.source === "baseline" ? (
          <>
            <span style={{ color: "var(--text-secondary)" }}>Baseline (null hypothesis):</span> each trade modeled
            at the recorder&apos;s 15-min window-close — the confirmation entry with{" "}
            <em>no trailing skill</em>. n={basis.nBaseline} closed triggers, mean{" "}
            {basis.meanBaselinePct >= 0 ? "+" : ""}
            {basis.meanBaselinePct.toFixed(1)}%/trade, {Math.round(basis.pctProfitableBaseline)}% profitable. The
            ratcheting trail is what beats this — {basis.nRealized} live trade{basis.nRealized === 1 ? "" : "s"} so
            far{basis.meanRealizedPct !== null ? ` (mean ${basis.meanRealizedPct >= 0 ? "+" : ""}${basis.meanRealizedPct.toFixed(1)}%)` : ""}.
          </>
        ) : (
          <>
            <span style={{ color: "var(--text-secondary)" }}>Live:</span> bootstrapped from {basis.nRealized}{" "}
            realized trades this run (mean {basis.meanRealizedPct! >= 0 ? "+" : ""}
            {basis.meanRealizedPct!.toFixed(1)}%/trade) vs the {basis.meanBaselinePct >= 0 ? "+" : ""}
            {basis.meanBaselinePct.toFixed(1)}% window-end baseline.
          </>
        )}{" "}
        Assumes{" "}
        <span style={{ color: basis.tradeRateAssumed ? "var(--status-warning, var(--text-secondary))" : "var(--text-secondary)" }}>
          {f.assumptions.tradesPerHour.toFixed(1)} trades/hr{basis.tradeRateAssumed ? " (default — no live rate yet)" : " (live)"}
        </span>{" "}
        at {usd0(f.assumptions.avgSizeUsd)}/position, {f.assumptions.nPaths.toLocaleString()} paths, breaker at −
        {f.assumptions.breakerDrawdownPct}% / −{usd0(f.assumptions.dailyLossCapUsd)}.
      </p>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: "good" | "warn" | "neutral" }) {
  const color =
    tone === "good" ? "var(--status-good)" : tone === "warn" ? "var(--status-critical)" : "var(--text-primary)";
  return (
    <div className="rounded-md px-2 py-1.5" style={{ background: "var(--surface-1)" }}>
      <div className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
        {label}
      </div>
      <div className="tabular text-sm font-semibold" style={{ color }}>
        {value}
      </div>
    </div>
  );
}
