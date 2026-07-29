"use client";

import { useState } from "react";
import { Panel } from "@/components/ui/Drawer";
import type { TradeRewind } from "@/lib/queries";

/**
 * TRADE REWIND — the flight recorder (operator 2026-07-29: "illustrate all 5
 * targets right on the candlestick so performance is clear and easy to
 * rewind"). One trade's whole life on one axis: the price path in multiples of
 * entry, the breakeven line, the peak, and EVERY rung marked where it actually
 * fired — TP0/TP1/micro/ratchet/sweep — with the share of the position it sold.
 *
 * The story it makes visible in one glance is the TABLE story: rungs climbing
 * 1.26× → 2.36× → 3.38× → 5.72×, then the runner meeting a 79% one-tick
 * collapse at 1.19×. Capture is no longer a number you take on faith; it is a
 * shape you can point at.
 */

const RUNG_LABEL: Record<string, string> = {
  take_profit_0: "TP0",
  take_profit_1: "TP1",
  take_profit_2: "TP2",
  take_profit_micro: "micro",
  basis_first: "basis",
  moon_ratchet: "ratchet",
  ripe_sweep: "sweep",
  profit_trail: "trail",
  stale_take: "stale",
  basket_harvest: "harvest",
  drain_guard_cut: "drain",
  floor_45: "floor",
  hard_stop: "stop",
  runner_timeout: "clock",
};
const label = (r: string) => RUNG_LABEL[r] ?? r.replace(/_/g, " ").slice(0, 8);

const W = 720;
const H = 200;
const PAD = { l: 34, r: 12, t: 16, b: 20 };

export function TradeRewind({ rewinds }: { rewinds: TradeRewind[] }) {
  const [sel, setSel] = useState(0);
  // HORIZONTAL DRAWER (operator 2026-07-29: "lets tuck into a nice horizontal
  // drawer so that we can open can close when needed"). Collapsed by default —
  // one strip that slides open when a flight is worth rewinding, closed the
  // rest of the time so the board stays quiet.
  const [open, setOpen] = useState(false);
  if (!rewinds.length) {
    return (
      <Panel
        title="⏮ Trade Rewind"
        storageKey="trade-rewind"
        drawerTitle="Trade Rewind"
        drawerSubtitle="the flight recorder — every rung on the price path"
        drawer={<p className="text-[11px]">No trade peaked ≥2× in the last 24h — the recorder arms on the next one.</p>}
      >
        <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          No trade peaked ≥2× in the last 24h.
        </p>
      </Panel>
    );
  }

  const t = rewinds[Math.min(sel, rewinds.length - 1)]!;
  const maxSec = Math.max(t.holdSec || 1, ...t.path.map((p) => p.sec), ...t.fills.map((f) => f.sec), 1);
  const maxMark = Math.max(t.peakMark, ...t.path.map((p) => p.mark), 1.1) * 1.08;
  const x = (s: number) => PAD.l + (s / maxSec) * (W - PAD.l - PAD.r);
  const y = (m: number) => H - PAD.b - (m / maxMark) * (H - PAD.t - PAD.b);

  const line = t.path.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.sec).toFixed(1)},${y(p.mark).toFixed(1)}`).join(" ");
  const area = t.path.length
    ? `${line} L${x(t.path[t.path.length - 1]!.sec).toFixed(1)},${y(0)} L${x(t.path[0]!.sec).toFixed(1)},${y(0)} Z`
    : "";
  const laneColor = t.lane === "live" ? "var(--series-2, #B0801F)" : "var(--series-1, #5390CE)";
  const captured = t.sizeUsd > 0 ? (t.pnlUsd / (t.sizeUsd * (t.peakMark - 1))) * 100 : 0;

  const chart = (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px]">
        <span className="font-semibold" style={{ color: "var(--text-primary)" }}>{t.symbol}</span>
        <span className="rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider"
          style={{ color: laneColor, border: `1px solid ${laneColor}` }}>{t.lane}</span>
        {t.signature ? <span style={{ color: "var(--text-muted)" }}>{t.signature}</span> : null}
        <span className="tabular" style={{ color: "var(--text-muted)" }}>
          peak <b style={{ color: "var(--text-primary)" }}>{t.peakMark.toFixed(2)}×</b> @ {t.peakSec}s
        </span>
        <span className="tabular" style={{ color: t.pnlUsd >= 0 ? "var(--status-good)" : "var(--status-critical)" }}>
          {t.pnlUsd >= 0 ? "+" : ""}${t.pnlUsd.toFixed(2)} on ${t.sizeUsd.toFixed(2)}
        </span>
        <span className="tabular" style={{ color: "var(--text-muted)" }}>
          captured <b style={{ color: captured >= 30 ? "var(--status-good)" : "var(--status-warning, #d99a2b)" }}>{captured.toFixed(0)}%</b> of the flight
        </span>
      </div>

      <div style={{ overflowX: "auto" }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img"
          aria-label={`${t.symbol} price path with ${t.fills.length} exit rungs, peak ${t.peakMark.toFixed(2)}x`}>
          {[1, Math.ceil(maxMark / 2), Math.floor(maxMark)].filter((v, i, a) => v > 0 && a.indexOf(v) === i).map((m) => (
            <g key={m}>
              <line x1={PAD.l} y1={y(m)} x2={W - PAD.r} y2={y(m)}
                stroke={m === 1 ? "var(--text-muted)" : "var(--gridline)"} strokeWidth="1"
                strokeDasharray={m === 1 ? "3 3" : undefined} opacity={m === 1 ? 0.7 : 0.5} />
              <text x={4} y={y(m) + 3} fontSize="9" className="tabular" fill="var(--text-muted)">{m}×</text>
            </g>
          ))}
          {area ? <path d={area} fill={laneColor} opacity="0.12" /> : null}
          <path d={line} fill="none" stroke={laneColor} strokeWidth="2" strokeLinejoin="round" />
          {/* the peak */}
          <circle cx={x(t.peakSec)} cy={y(t.peakMark)} r="4.5" fill="none" stroke="var(--text-primary)" strokeWidth="1.5" />
          <text x={x(t.peakSec)} y={y(t.peakMark) - 8} fontSize="9.5" textAnchor="middle" className="tabular"
            fill="var(--text-primary)">{t.peakMark.toFixed(2)}×</text>
          {/* every rung, where it actually fired */}
          {t.fills.map((f, i) => (
            <g key={i}>
              <line x1={x(f.sec)} y1={y(f.mark)} x2={x(f.sec)} y2={H - PAD.b} stroke="var(--status-good)" strokeWidth="1" opacity="0.35" />
              <circle cx={x(f.sec)} cy={y(f.mark)} r="4" fill="var(--status-good)" stroke="var(--surface-1)" strokeWidth="1.5" />
              <text x={x(f.sec)} y={H - PAD.b + 12} fontSize="9" textAnchor="middle" fill="var(--text-muted)">
                {label(f.reason)}
              </text>
              <title>{`${label(f.reason)} — sold ${f.qtyPct.toFixed(0)}% at ${f.mark.toFixed(2)}× (${f.sec}s)`}</title>
            </g>
          ))}
        </svg>
      </div>

      <div className="flex flex-wrap gap-1">
        {rewinds.map((r, i) => (
          <button key={r.id} onClick={() => setSel(i)}
            className="rounded px-2 py-1 text-[10px] tabular"
            style={{
              border: `1px solid ${i === sel ? "var(--series-1)" : "var(--gridline)"}`,
              color: i === sel ? "var(--text-primary)" : "var(--text-muted)",
              background: i === sel ? "var(--surface-1)" : "transparent",
            }}>
            {r.symbol} {r.peakMark.toFixed(1)}×
          </button>
        ))}
      </div>
    </div>
  );

  const liveCount = rewinds.filter((r) => r.lane === "live").length;
  const strip = (
    <div className="rounded-md" style={{ border: "1px solid var(--gridline)", background: "var(--surface-1)" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px]"
        style={{ color: "var(--text-secondary)" }}
      >
        <span style={{ color: "var(--series-1)" }}>{open ? "▾" : "▸"}</span>
        <span className="font-semibold" style={{ color: "var(--text-primary)" }}>⏮ Trade Rewind</span>
        <span style={{ color: "var(--text-muted)" }}>
          {rewinds.length} flights{liveCount ? ` · ${liveCount} live` : ""} — every rung on the price path
        </span>
        <span className="ml-auto tabular" style={{ color: "var(--text-muted)" }}>
          {open ? "close" : `top ${t.symbol} ${t.peakMark.toFixed(1)}×`}
        </span>
      </button>
      {open && <div className="border-t px-3 py-3" style={{ borderColor: "var(--gridline)" }}>{chart}</div>}
    </div>
  );
  if (!open) return strip;

  return (
    <Panel
      title="⏮ Trade Rewind"
      accent="var(--series-1)"
      storageKey="trade-rewind"
      drawerTitle="Trade Rewind · the flight recorder"
      drawerSubtitle="every rung on the price path — where each target actually fired"
      expandLabel="Full flight"
      drawer={
        <div className="space-y-3">
          {chart}
          <table className="w-full text-[11px]">
            <thead>
              <tr style={{ color: "var(--text-muted)" }}>
                <th className="pb-1 text-left font-normal">Rung</th>
                <th className="pb-1 text-right font-normal">At</th>
                <th className="pb-1 text-right font-normal">Mark</th>
                <th className="pb-1 text-right font-normal">Sold</th>
              </tr>
            </thead>
            <tbody>
              {t.fills.map((f, i) => (
                <tr key={i} style={{ borderTop: "1px solid var(--gridline)" }}>
                  <td className="py-1">{label(f.reason)}</td>
                  <td className="tabular py-1 text-right" style={{ color: "var(--text-muted)" }}>{f.sec}s</td>
                  <td className="tabular py-1 text-right">{f.mark.toFixed(2)}×</td>
                  <td className="tabular py-1 text-right">{f.qtyPct.toFixed(0)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>
            Captured = realized ÷ (peak − entry) × size. The gap between the last rung and the peak marker is the
            give-back the exit machinery is aiming at.
          </p>
        </div>
      }
    >
      <div className="space-y-2">
        <button
          onClick={() => setOpen(false)}
          className="text-[10px]"
          style={{ color: "var(--text-muted)" }}
          aria-label="Collapse Trade Rewind"
        >
          ▾ tuck away
        </button>
        {chart}
      </div>
    </Panel>
  );
}
