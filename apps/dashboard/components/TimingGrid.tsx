"use client";

import { useState, useTransition } from "react";
import { setManagementIntent } from "@/app/actions";
import type { TimingGridView, TimingTrade } from "@/lib/queries";

// The vertical Trade Matrix: one heat-bar per open trade, height = how high it has
// risen (mark multiple), filled with the progress-distribution palette (neutral at
// 1.0×, deepening green up / red down). A gold LOCK line rides up under the peak —
// the protected floor a close-now can't drop below — so "price gets locked in the
// higher it rises" is literal. TP rails cross behind; each bar is click-to-close.

const NEUTRAL: [number, number, number] = [38, 38, 36];
const GAIN: [number, number, number] = [22, 190, 80];
const LOSS: [number, number, number] = [214, 62, 62];
function mix(a: [number, number, number], b: [number, number, number], t: number): string {
  const g = Math.pow(Math.max(0, Math.min(1, t)), 0.7);
  return `rgb(${a.map((x, i) => Math.round(x + (b[i] - x) * g)).join(",")})`;
}
function heat(mm: number): string {
  return mm >= 1 ? mix(NEUTRAL, GAIN, (mm - 1) / 2) : mix(NEUTRAL, LOSS, (1 - mm) / 0.6);
}

const STATE_TONE: Record<TimingTrade["state"], string> = {
  rising: "var(--status-good)",
  stalling: "var(--status-warning)",
  falling: "var(--status-critical)",
};
const zoneTone = (sec: number) =>
  sec < 150 ? "var(--status-critical)" : sec < 300 ? "var(--status-warning)" : "var(--status-good)";
const fmtSec = (s: number) => (s >= 60 ? `${Math.round(s / 60)}m` : `${Math.round(s)}s`);

const TRACK_H = 300; // px — the shared 1.0×→yMax wall

export function TimingGrid({ view }: { view: TimingGridView }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [closing, setClosing] = useState<Set<number>>(new Set());
  const [, startTransition] = useTransition();

  const open = view.trades
    .filter((t) => t.status === "open")
    .sort((a, b) => b.curMult - a.curMult);
  const closed = view.trades
    .filter((t) => t.status === "closed")
    .sort((a, b) => b.ageSec - a.ageSec)
    .slice(0, 12);

  if (view.trades.length === 0) {
    return (
      <div className="flex h-52 items-center justify-center text-sm" style={{ color: "var(--text-muted)" }}>
        No open or recently-closed trades — the matrix fills as the trader takes positions.
      </div>
    );
  }

  const yMax = Math.max(1.8, ...view.trades.map((t) => t.peakMult)) * 1.05;
  const pct = (mult: number) => Math.max(0, Math.min(1, (mult - 1) / (yMax - 1))) * 100;

  // Minor gridlines — a light lattice between 1.0× and the ceiling so the field
  // reads as a levels chart even when only a few bars are live.
  const MINOR = 8;
  const minorLines = Array.from({ length: MINOR - 1 }, (_, i) => 1 + ((yMax - 1) * (i + 1)) / MINOR);

  const closePosition = (id: number) => {
    setClosing((s) => new Set(s).add(id));
    startTransition(() => {
      void setManagementIntent(id, "cut");
    });
  };

  return (
    <div className="w-full">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs" style={{ color: "var(--text-muted)" }}>
        <span>
          {open.length} live position{open.length === 1 ? "" : "s"} (entry-relative) · bar height = how high it rose · dashed = TP levels · gold = locked floor · click to close
        </span>
        <span className="flex items-center gap-3 tabular">
          <span style={{ color: "var(--status-good)" }}>▲ {view.counts.rising}</span>
          <span style={{ color: "var(--status-warning)" }}>▬ {view.counts.stalling}</span>
          <span style={{ color: "var(--status-critical)" }}>▼ {view.counts.falling}</span>
          <span className="flex items-center gap-1">
            <span>0.4×</span>
            <span className="inline-block h-2 w-16 rounded-sm" style={{ background: `linear-gradient(90deg, ${heat(0.4)}, ${heat(1)}, ${heat(2)}, ${heat(3)})` }} />
            <span>3×</span>
          </span>
        </span>
      </div>

      <div className="flex gap-2">
        {/* shared Y axis */}
        <div className="relative shrink-0" style={{ width: 34, height: TRACK_H }}>
          {[{ m: yMax, l: `${yMax.toFixed(1)}×` }, ...view.tpLevels.map((t) => ({ m: t.mult, l: t.label })), { m: 1, l: "1.0×" }].map((r, i) => (
            <div key={i} className="absolute right-0 -translate-y-1/2 text-[9px] tabular" style={{ bottom: `${pct(r.m)}%`, color: "var(--text-muted)" }}>
              {r.l}
            </div>
          ))}
        </div>

        {/* bar field */}
        <div className="relative flex-1 overflow-x-auto">
          {/* level grid — the adjustable TP levels + a light minor lattice, so the
              field has presence and every bar is read against the trading levels */}
          <div className="pointer-events-none absolute inset-0" style={{ height: TRACK_H }}>
            {/* minor lattice */}
            {minorLines.map((m, i) => (
              <div key={`min${i}`} className="absolute w-full" style={{ bottom: `${pct(m)}%`, borderTop: "1px solid var(--gridline)", opacity: 0.3 }} />
            ))}
            {/* TP level rails — labeled, the operator-adjustable take-profit levels */}
            {view.tpLevels.filter((t) => t.mult < yMax).map((t) => (
              <div key={t.label} className="absolute w-full" style={{ bottom: `${pct(t.mult)}%` }}>
                <div className="w-full border-t border-dashed" style={{ borderColor: "var(--series-1)", opacity: 0.55 }} />
                <span
                  className="absolute right-0 top-[-7px] rounded-sm px-1 text-[8px] font-medium tabular"
                  style={{ background: "var(--surface-1)", color: "var(--series-1)", opacity: 0.9 }}
                >
                  {t.label} {t.mult.toFixed(2)}×
                </span>
              </div>
            ))}
            {/* 1.0× baseline */}
            <div className="absolute w-full" style={{ bottom: 0, borderTop: "1.5px solid var(--baseline)" }} />
          </div>

          <div className="flex items-end gap-[3px]" style={{ height: TRACK_H }}>
            {open.map((t) => {
              const isClosing = closing.has(t.id);
              const hi = hovered === t.id;
              const dim = hovered != null && !hi;
              return (
                <div
                  key={t.id}
                  className="group relative flex h-full shrink-0 cursor-pointer flex-col justify-end"
                  style={{ width: 40, opacity: dim ? 0.4 : 1 }}
                  onMouseEnter={() => setHovered(t.id)}
                  onMouseLeave={() => setHovered(null)}
                  onClick={() => !isClosing && closePosition(t.id)}
                  title={`${t.symbol ?? "?"} — ${t.curMult.toFixed(2)}× (peak ${t.peakMult.toFixed(2)}×) · ${fmtSec(t.ageSec)} · ${t.state}${t.isFarm ? " · farm" : ""} — click to close`}
                >
                  {/* current mult label */}
                  <div className="absolute left-0 right-0 text-center text-[9px] font-semibold tabular" style={{ bottom: `calc(${pct(t.curMult)}% + 2px)`, color: STATE_TONE[t.state] }}>
                    {t.curMult.toFixed(2)}
                  </div>

                  {/* the heat bar: 1.0 → current mult */}
                  <div
                    className="relative w-full rounded-t-[2px] transition-all duration-500"
                    style={{
                      height: `${pct(t.curMult)}%`,
                      minHeight: 2,
                      background: `linear-gradient(to top, ${heat(1)}, ${heat(t.curMult)})`,
                      boxShadow: hi ? "0 0 0 1px var(--text-secondary)" : undefined,
                    }}
                  >
                    {/* peak cap — the high-water mark (gap above the bar = giveback) */}
                    {t.peakMult > t.curMult + 0.01 && (
                      <div className="absolute left-0 right-0 border-t border-dashed" style={{ bottom: `calc((${pct(t.peakMult)}% - ${pct(t.curMult)}%) )`, borderColor: "var(--text-muted)", opacity: 0.7 }} />
                    )}
                  </div>

                  {/* locked-floor line — rides up under the peak */}
                  {t.armed && t.lockedMult > 1.0 && (
                    <div className="absolute left-0 right-0" style={{ bottom: `${pct(t.lockedMult)}%` }}>
                      <div className="h-[2px] w-full" style={{ background: "var(--status-warning)", boxShadow: "0 0 3px var(--status-warning)" }} />
                    </div>
                  )}

                  {/* farm tag */}
                  {t.isFarm && <div className="absolute right-0 top-0 text-[8px]" style={{ color: "var(--text-muted)" }}>◇</div>}

                  {/* close affordance on hover */}
                  {hi && (
                    <div className="absolute inset-x-0 top-0 text-center text-[10px] font-bold" style={{ color: "var(--status-critical)" }}>
                      {isClosing ? "…" : "✕"}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* per-bar footers: ticker + age (zone-tinted) */}
          <div className="mt-1 flex gap-[3px]">
            {open.map((t) => (
              <div key={t.id} className="shrink-0 overflow-hidden text-center" style={{ width: 40 }}>
                <div className="truncate text-[9px]" style={{ color: hovered === t.id ? "var(--text-primary)" : "var(--text-secondary)" }}>
                  {t.symbol ?? "?"}
                </div>
                <div className="text-[8px] tabular" style={{ color: zoneTone(t.ageSec) }}>{fmtSec(t.ageSec)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* time-zone legend */}
      <div className="mt-2 flex items-center gap-3 text-[9px]" style={{ color: "var(--text-muted)" }}>
        <span>age zone:</span>
        <span style={{ color: "var(--status-critical)" }}>▮ &lt;150s danger (rugs peak)</span>
        <span style={{ color: "var(--status-warning)" }}>▮ 150–300s develop</span>
        <span style={{ color: "var(--status-good)" }}>▮ &gt;300s runner (winners grind)</span>
      </div>

      {/* recently closed */}
      {closed.length > 0 && (
        <div className="mt-3 border-t pt-2" style={{ borderColor: "var(--border)" }}>
          <div className="mb-1 text-[10px]" style={{ color: "var(--text-muted)" }}>just closed (20m window)</div>
          <div className="flex flex-wrap gap-1.5">
            {closed.map((t) => (
              <span
                key={t.id}
                className="rounded px-1.5 py-0.5 text-[10px] tabular"
                style={{
                  background: "var(--surface-1)",
                  border: `1px solid ${t.exit && t.exit.pnl >= 0 ? "var(--status-good)" : "var(--status-critical)"}`,
                  color: "var(--text-secondary)",
                }}
                title={`${t.exit?.reason ?? "closed"} · peak ${t.peakMult.toFixed(2)}× · ${fmtSec(t.ageSec)}`}
              >
                {t.symbol ?? "?"} {t.curMult.toFixed(2)}×{" "}
                <span style={{ color: t.exit && t.exit.pnl >= 0 ? "var(--status-good)" : "var(--status-critical)" }}>
                  {t.exit && t.exit.pnl >= 0 ? "+" : ""}${t.exit?.pnl.toFixed(2)}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
