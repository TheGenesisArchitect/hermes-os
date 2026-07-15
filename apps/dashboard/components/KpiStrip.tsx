"use client";

import type { Kpi } from "@/lib/queries";
import { usd } from "@/components/ui";
import { Sparkline } from "@/components/Sparkline";

function fmtValue(k: Kpi): string {
  if (k.value === null) return "—";
  switch (k.format) {
    case "ratio":
      return `${k.value.toFixed(1)}:1`;
    case "pct":
      return `${Math.round(k.value)}%`;
    case "usd":
      return usd(k.value, 0);
    case "int":
      return String(Math.round(k.value));
  }
}

function fmtDelta(k: Kpi): string {
  if (k.delta === null || k.delta === 0) return "";
  const s = k.delta > 0 ? "+" : "−";
  const a = Math.abs(k.delta);
  switch (k.format) {
    case "ratio":
      return `${s}${a.toFixed(1)}`;
    case "pct":
      return `${s}${Math.round(a)}pts`;
    case "usd":
      return `${s}${usd(a, 0).replace("$", "$")}`;
    case "int":
      return `${s}${Math.round(a)}`;
  }
}

/** How to color the delta: a move in the "better" direction is good. */
function deltaTone(k: Kpi): string {
  if (k.delta === null || k.delta === 0) return "var(--text-muted)";
  const good = k.higherIsBetter ? k.delta > 0 : k.delta < 0;
  return good ? "var(--status-good)" : "var(--status-critical)";
}

/** Sparkline tone follows the metric's own trend, not the delta color. */
function sparkTone(k: Kpi): string {
  return k.higherIsBetter ? "var(--status-good)" : "var(--series-1)";
}

function Tile({ k }: { k: Kpi }) {
  const delta = fmtDelta(k);
  const arrow = k.delta === null || k.delta === 0 ? "" : k.delta > 0 ? "▲" : "▼";
  return (
    <div
      className="flex flex-col justify-between rounded-lg border p-2.5"
      style={{ borderColor: "var(--border)", background: "var(--surface-1)" }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] leading-tight" style={{ color: "var(--text-secondary)" }}>
          {k.label}
        </span>
        {delta ? (
          <span className="tabular text-[11px] font-medium whitespace-nowrap" style={{ color: deltaTone(k) }}>
            {arrow} {delta}
          </span>
        ) : null}
      </div>
      <div className="mt-1 flex items-end justify-between gap-2">
        <span className="tabular text-xl font-semibold leading-none" style={{ color: "var(--text-primary)" }}>
          {fmtValue(k)}
        </span>
        {k.sub ? (
          <span className="tabular text-[10px] pb-0.5" style={{ color: "var(--text-muted)" }}>
            {k.sub}
          </span>
        ) : null}
      </div>
      <div className="mt-1.5">
        <Sparkline data={k.spark} tone={sparkTone(k)} />
      </div>
    </div>
  );
}

export function KpiStrip({ kpis }: { kpis: Kpi[] }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {kpis.map((k) => (
        <Tile key={k.key} k={k} />
      ))}
    </div>
  );
}
