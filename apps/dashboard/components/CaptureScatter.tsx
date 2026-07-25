"use client";

import { useMemo, useState } from "react";
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
  /** epoch ms of the close — powers the history scrubber. */
  closedAtMs: number;
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
//
// ZOOM + HISTORY (operator-requested, 2026-07-23): the dense 1–1.5× cluster is
// where the information lives, so a zoom cap re-domains both axes to spread it;
// the span buttons + offset scrubber page back through 24h of closes.

const TICKS = [1, 1.5, 2, 3, 5, 10, 20, 50];
const FLOOR = 0.1; // exits below this (dust rugs) are pinned so log can plot them
const ZOOMS: (number | null)[] = [1.5, 2, 3, 5, null]; // peak-cap domains; null = all
const SPANS_H = [1, 3, 6, 12, 24];

export function CaptureScatter({ points }: { points: CapturePoint[] }) {
  const [zoom, setZoom] = useState<number | null>(null);
  const [spanH, setSpanH] = useState(6);
  const [offsetMin, setOffsetMin] = useState(0); // minutes back from now for the window END

  const { visible, windowLabel, maxOffset } = useMemo(() => {
    const now = Date.now();
    const end = now - offsetMin * 60_000;
    const start = end - spanH * 3_600_000;
    const vis = points.filter((p) => p.closedAtMs >= start && p.closedAtMs <= end);
    const fmt = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    return {
      visible: vis,
      windowLabel: `${fmt(start)} → ${offsetMin === 0 ? "now" : fmt(end)}`,
      maxOffset: Math.max(0, 24 * 60 - spanH * 60),
    };
  }, [points, spanH, offsetMin]);

  const maxX = zoom ?? Math.max(2, ...visible.map((p) => p.peakX), 2);
  const shape = (p: CapturePoint) => ({
    ...p,
    x: Math.min(Math.max(1, p.peakX), maxX), // clamp into the zoom domain so off-scale points pin to the edge
    y: Math.min(Math.max(FLOOR, p.exitX), maxX),
    z: Math.max(1, p.sizeUsd),
  });
  const paper = visible.filter((p) => p.lane !== "live").map(shape);
  const live = visible.filter((p) => p.lane === "live").map(shape);
  const ticks = TICKS.filter((t) => t <= maxX);

  const btn = (active: boolean): React.CSSProperties => ({
    padding: "1px 7px",
    fontSize: 10,
    borderRadius: 4,
    border: "1px solid var(--gridline)",
    background: active ? "var(--surface-1)" : "transparent",
    color: active ? "var(--text-primary)" : "var(--text-muted)",
    cursor: "pointer",
  });

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center gap-2 text-[10px]" style={{ color: "var(--text-muted)" }}>
        <span>zoom</span>
        {ZOOMS.map((zl) => (
          <button key={String(zl)} style={btn(zoom === zl)} onClick={() => setZoom(zl)}>
            {zl == null ? "all" : `≤${zl}×`}
          </button>
        ))}
        <span className="ml-2">span</span>
        {SPANS_H.map((s) => (
          <button
            key={s}
            style={btn(spanH === s)}
            onClick={() => {
              setSpanH(s);
              setOffsetMin((o) => Math.min(o, Math.max(0, 24 * 60 - s * 60)));
            }}
          >
            {s}h
          </button>
        ))}
        <span suppressHydrationWarning className="ml-2 tabular">{windowLabel}</span>
        <span className="tabular" style={{ marginLeft: "auto" }}>
          {visible.length} trades
        </span>
      </div>
      {maxOffset > 0 && (
        <input
          type="range"
          min={0}
          max={maxOffset}
          step={15}
          value={maxOffset - offsetMin}
          onChange={(e) => setOffsetMin(maxOffset - Number(e.currentTarget.value))}
          className="mb-1 w-full"
          style={{ accentColor: "var(--series-1)", height: 14 }}
          title="scrub back through the last 24h of closes"
        />
      )}
      {visible.length === 0 ? (
        <div className="flex h-[240px] items-center justify-center text-xs" style={{ color: "var(--text-muted)" }}>
          No closed trades in this window — scrub or widen the span.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <ScatterChart margin={{ top: 8, right: 12, bottom: 18, left: 4 }}>
            <CartesianGrid stroke="var(--gridline)" strokeDasharray="2 4" />
            <XAxis
              type="number"
              dataKey="x"
              scale="log"
              domain={[1, maxX]}
              ticks={ticks}
              tick={{ fontSize: 10, fill: "var(--text-muted)" }}
              tickFormatter={(v: number) => `${v}×`}
              label={{ value: "peak reached", position: "insideBottom", offset: -12, fontSize: 10, fill: "var(--text-muted)" }}
            />
            <YAxis
              type="number"
              dataKey="y"
              scale="log"
              domain={[FLOOR, maxX]}
              ticks={[FLOOR, 0.5, ...ticks]}
              tick={{ fontSize: 10, fill: "var(--text-muted)" }}
              tickFormatter={(v: number) => `${v}×`}
              width={40}
            />
            <ZAxis dataKey="z" range={zoom != null ? [40, 320] : [20, 200]} />
            <ReferenceLine
              segment={[{ x: 1, y: 1 }, { x: maxX, y: maxX }]}
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
                // recharts defaults tooltip text to near-black; on the dark surface
                // that reads as blank. Theme both levels explicitly.
                color: "var(--text-primary)",
              }}
              itemStyle={{ color: "var(--text-primary)" }}
              labelStyle={{ color: "var(--text-secondary)" }}
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
      )}
    </div>
  );
}
