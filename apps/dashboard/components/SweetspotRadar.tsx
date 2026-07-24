"use client";

import type { SweetspotRadarView } from "@/lib/queries";

// SWEETSPOT RADAR — the boarding band as a spinning instrument (operator,
// 2026-07-23: "literally a radar, spinning clockwise, scanning where prices
// are taking off and where the sweetspots are landing").
//
// Geometry: the center is 1.0× (entry par); rings step out through the
// trigger-multiple buckets to 2.4× at the rim. A blip is a boarding — bearing
// = recency (12 o'clock is NOW, one full turn is the trailing hour, clockwise
// into the past), ring = its trigger multiple. Green paid, red paid the tab,
// hollow still riding, gold = it mooned (peak ≥3×). The glowing annulus is the
// band the finder currently has locked; the sweep hand spins clockwise unless
// the viewer prefers reduced motion.

const RINGS = [1.3, 1.45, 1.65, 1.9, 2.2];
const R_MAX = 118; // px radius of the 2.4× rim
const MULT_MIN = 1.0;
const MULT_MAX = 2.4;

const rOf = (mult: number): number => {
  const m = Math.min(MULT_MAX, Math.max(MULT_MIN, mult));
  return ((m - MULT_MIN) / (MULT_MAX - MULT_MIN)) * R_MAX;
};

export function SweetspotRadar({ view }: { view: SweetspotRadarView }) {
  const cx = 145;
  const cy = 145;
  const bandInner = rOf(view.lo);
  const bandOuter = rOf(view.hi);
  return (
    <div className="flex flex-wrap items-start gap-5">
      <div className="relative shrink-0">
        <svg width={290} height={290} role="img" aria-label={`Sweetspot radar — band ${view.lo}–${view.hi}×`}>
          <defs>
            {/* phosphor scope face — near-black with a faint green breath at center */}
            <radialGradient id="scopeFace" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#0a1410" />
              <stop offset="70%" stopColor="#060a08" />
              <stop offset="100%" stopColor="#04070a" />
            </radialGradient>
            {/* sweep wedge fades behind the hand */}
            <linearGradient id="sweepFade" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#35d07f" stopOpacity="0.35" />
              <stop offset="100%" stopColor="#35d07f" stopOpacity="0" />
            </linearGradient>
            <filter id="blipGlow" x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur stdDeviation="1.6" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          {/* scope face + rim */}
          <circle cx={cx} cy={cy} r={R_MAX + 8} fill="url(#scopeFace)" stroke="#1d2b24" strokeWidth={1.5} />
          {/* ARM SPEC zones (ratified 2026-07-24): CONVICTION seat 1.2–1.65
              (green, live fires full size) · SENSOR slice 1.65–2.05 (amber,
              paper probes / live declines) · the finder band is a measured
              overlay for tiers and display — it no longer gates admission. */}
          <circle cx={cx} cy={cy} r={rOf(1.65)} fill="#35d07f" fillOpacity={0.05} />
          <circle cx={cx} cy={cy} r={rOf(1.2)} fill="#060a08" fillOpacity={0.9} />
          <circle cx={cx} cy={cy} r={rOf(2.05)} fill="none" stroke="#ffc44d" strokeOpacity={0.4} strokeDasharray="3 3" />
          <circle cx={cx} cy={cy} r={rOf(1.2)} fill="none" stroke="#3ee68c" strokeOpacity={0.6} />
          <circle cx={cx} cy={cy} r={rOf(1.65)} fill="none" stroke="#3ee68c" strokeOpacity={0.6} />
          {/* finder band — the measured expectancy overlay (blue dashes) */}
          <circle cx={cx} cy={cy} r={bandInner} fill="none" stroke="#5aa7e8" strokeOpacity={0.55} strokeDasharray="1 4" />
          <circle cx={cx} cy={cy} r={bandOuter} fill="none" stroke="#5aa7e8" strokeOpacity={0.55} strokeDasharray="1 4" />
          {/* rings + labels down the 45° axis so they never collide */}
          {RINGS.map((m) => {
            const r = rOf(m);
            const lx = cx + r * Math.SQRT1_2;
            const ly = cy - r * Math.SQRT1_2;
            return (
              <g key={m}>
                <circle cx={cx} cy={cy} r={r} fill="none" stroke="#274236" strokeOpacity={0.8} strokeWidth={0.75} />
                <text x={lx + 3} y={ly - 3} fontSize={8.5} fill="#5f8371" style={{ fontVariantNumeric: "tabular-nums" }}>
                  {m}×
                </text>
              </g>
            );
          })}
          {/* crosshair, whisper-quiet */}
          <line x1={cx} y1={cy - R_MAX} x2={cx} y2={cy + R_MAX} stroke="#1d2b24" strokeWidth={0.75} />
          <line x1={cx - R_MAX} y1={cy} x2={cx + R_MAX} y2={cy} stroke="#1d2b24" strokeWidth={0.75} />
          {/* blips — bearing by recency (clockwise into the past), ring by trigger multiple */}
          {view.blips.map((b, i) => {
            const theta = ((b.minutesAgo % 60) / 60) * 2 * Math.PI - Math.PI / 2; // 12 o'clock = now, clockwise back
            const r = rOf(b.trig);
            const x = cx + r * Math.cos(theta);
            const y = cy + r * Math.sin(theta);
            const moon = b.peakX >= 3;
            const color = b.pnl == null ? "#7d8f86" : b.pnl >= 0 ? "#3ee68c" : "#ff5d5d";
            return (
              <g key={i} filter="url(#blipGlow)">
                <circle
                  cx={x}
                  cy={y}
                  r={moon ? 5.5 : 4}
                  fill={b.pnl == null ? "transparent" : moon ? "#ffc44d" : color}
                  stroke={b.lane === "ghost" ? "#c9a94a" : moon ? "#ffc44d" : color}
                  strokeWidth={1.4}
                  strokeDasharray={b.lane === "ghost" ? "2.5 2" : undefined}
                  opacity={b.lane === "ghost" ? 0.7 : Math.max(0.55, 1 - b.minutesAgo / 90)}
                >
                  <title>
                    {`${b.symbol ?? "?"} · ${b.trig.toFixed(2)}× trigger · ${Math.round(b.minutesAgo)}m ago · ${
                      b.pnl == null ? "riding" : `${b.pnl >= 0 ? "+" : "−"}$${Math.abs(b.pnl).toFixed(2)}`
                    }${moon ? ` · MOON ${b.peakX.toFixed(1)}×` : ""}${b.lane === "live" ? " · LIVE" : b.lane === "ghost" ? " · SEEN, NOT BOARDED" : ""}`}
                  </title>
                </circle>
                {b.lane === "live" ? (
                  <circle cx={x} cy={y} r={moon ? 8.5 : 7} fill="none" stroke="#ff8c42" strokeWidth={1.4} />
                ) : null}
              </g>
            );
          })}
          {/* the sweep — phosphor hand with a fading wedge; paused under reduced motion */}
          <g className="radar-sweep" style={{ transformOrigin: `${cx}px ${cy}px` }}>
            <path
              d={`M ${cx} ${cy} L ${cx} ${cy - R_MAX} A ${R_MAX} ${R_MAX} 0 0 1 ${cx + R_MAX * Math.sin(0.7)} ${cy - R_MAX * Math.cos(0.7)} Z`}
              fill="url(#sweepFade)"
              transform={`rotate(${(0.7 * 180) / Math.PI * -1} ${cx} ${cy})`}
            />
            <line x1={cx} y1={cy} x2={cx} y2={cy - R_MAX} stroke="#3ee68c" strokeWidth={1.6} strokeOpacity={0.95} />
          </g>
          <circle cx={cx} cy={cy} r={2.5} fill="#3ee68c" />
          <style>{`
            .radar-sweep { animation: sweetspot-sweep 8s linear infinite; }
            @keyframes sweetspot-sweep { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
            @media (prefers-reduced-motion: reduce) { .radar-sweep { animation: none; } }
          `}</style>
        </svg>
      </div>
      <div className="grid min-w-[220px] flex-1 grid-cols-2 gap-3">
        <Stat
          label="Conviction seat"
          value="1.20–1.65×"
          sub={`finder band ${view.lo.toFixed(2)}–${view.hi.toFixed(2)}× (${view.measured ? "measured" : "fallback"}) · sensor to 2.05`}
        />
        <Stat
          label="In-band fills · 1h"
          value={view.inBandPct1h == null ? "—" : `${view.inBandPct1h.toFixed(0)}%`}
          sub="golden-week level was 93%"
        />
        <Stat
          label="Band $/trade · 24h"
          value={view.bandPerTrade24h == null ? "—" : `${view.bandPerTrade24h >= 0 ? "+" : "−"}$${Math.abs(view.bandPerTrade24h).toFixed(2)}`}
          sub="realized, inside the band"
        />
        <Stat label="Chases refused · 2h" value={String(view.chasesRefused2h)} sub="past-band qualifiers let go" />
        {view.buckets ? (
          <div className="col-span-2 text-[10px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
            {view.buckets}
            {view.refreshedAgoMin != null ? ` · re-measured ${Math.round(view.refreshedAgoMin)}m ago` : ""}
          </div>
        ) : null}
        {/* LEGEND — every mark on the scope, named */}
        <div
          className="col-span-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-md border p-2 text-[10px]"
          style={{ borderColor: "var(--gridline)", color: "var(--text-secondary)" }}
        >
          <LegendDot color="var(--status-good)" filled label="banked green" />
          <LegendDot color="var(--status-critical)" filled label="paid the tab" />
          <LegendDot color="var(--text-muted)" filled={false} label="still riding" />
          <LegendDot color="var(--status-warning)" filled big label="moon (peak ≥3×)" />
          <span className="inline-flex items-center gap-1.5">
            <svg width={14} height={14}>
              <circle cx={7} cy={7} r={3} fill="var(--status-good)" />
              <circle cx={7} cy={7} r={6} fill="none" stroke="var(--status-serious)" strokeWidth={1.2} />
            </svg>
            LIVE trade (real capital)
          </span>
          <span className="inline-flex items-center gap-1.5">
            <svg width={14} height={14}>
              <circle cx={7} cy={7} r={5.5} fill="none" stroke="#3ee68c" strokeOpacity={0.6} />
            </svg>
            conviction seat 1.2–1.65 (live fires)
          </span>
          <span className="inline-flex items-center gap-1.5">
            <svg width={14} height={14}>
              <circle cx={7} cy={7} r={5.5} fill="none" stroke="#ffc44d" strokeOpacity={0.5} strokeDasharray="2 2" />
            </svg>
            sensor slice to 2.05 (paper probes)
          </span>
          <span className="inline-flex items-center gap-1.5">
            <svg width={14} height={14}>
              <circle cx={7} cy={7} r={5.5} fill="none" stroke="#5aa7e8" strokeOpacity={0.6} strokeDasharray="1 3" />
            </svg>
            finder band (measured expectancy)
          </span>
          <span style={{ color: "var(--text-muted)" }}>
            rings = trigger multiple (1× center → 2.4× rim) · bearing = age (12 o&apos;clock = now, one turn = 60m) ·
            sweep = live scan
          </span>
        </div>
      </div>
    </div>
  );
}

function LegendDot({ color, filled, big, label }: { color: string; filled: boolean; big?: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg width={14} height={14}>
        <circle cx={7} cy={7} r={big ? 5 : 3.5} fill={filled ? color : "transparent"} stroke={color} strokeWidth={1.2} />
      </svg>
      {label}
    </span>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-md border p-2.5" style={{ borderColor: "var(--gridline)" }}>
      <div className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
        {label}
      </div>
      <div className="tabular mt-0.5 text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
        {value}
      </div>
      <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>
        {sub}
      </div>
    </div>
  );
}
