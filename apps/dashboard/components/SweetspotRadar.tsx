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
  const cx = 130;
  const cy = 130;
  const bandInner = rOf(view.lo);
  const bandOuter = rOf(view.hi);
  return (
    <div className="flex flex-wrap items-start gap-5">
      <div className="relative shrink-0">
        <svg width={260} height={260} role="img" aria-label={`Sweetspot radar — band ${view.lo}–${view.hi}×`}>
          {/* the locked band — a glowing annulus */}
          <circle
            cx={cx}
            cy={cy}
            r={(bandInner + bandOuter) / 2}
            fill="none"
            stroke="var(--status-good)"
            strokeOpacity={0.16}
            strokeWidth={Math.max(4, bandOuter - bandInner)}
          />
          {/* rings at bucket edges */}
          {RINGS.map((m) => (
            <g key={m}>
              <circle cx={cx} cy={cy} r={rOf(m)} fill="none" stroke="var(--gridline)" strokeDasharray="2 4" />
              <text x={cx + 4} y={cy - rOf(m) - 2} fontSize={8} fill="var(--text-muted)">
                {m}×
              </text>
            </g>
          ))}
          {/* band edge rings, solid */}
          <circle cx={cx} cy={cy} r={bandInner} fill="none" stroke="var(--status-good)" strokeOpacity={0.55} />
          <circle cx={cx} cy={cy} r={bandOuter} fill="none" stroke="var(--status-good)" strokeOpacity={0.55} />
          {/* cross hairs */}
          <line x1={cx} y1={cy - R_MAX} x2={cx} y2={cy + R_MAX} stroke="var(--gridline)" strokeOpacity={0.5} />
          <line x1={cx - R_MAX} y1={cy} x2={cx + R_MAX} y2={cy} stroke="var(--gridline)" strokeOpacity={0.5} />
          {/* blips — bearing by recency (clockwise into the past), ring by trigger multiple */}
          {view.blips.map((b, i) => {
            const theta = ((b.minutesAgo % 60) / 60) * 2 * Math.PI - Math.PI / 2; // 12 o'clock = now, clockwise back
            const r = rOf(b.trig);
            const x = cx + r * Math.cos(theta);
            const y = cy + r * Math.sin(theta);
            const moon = b.peakX >= 3;
            const color =
              b.pnl == null ? "var(--text-muted)" : b.pnl >= 0 ? "var(--status-good)" : "var(--status-critical)";
            return (
              <g key={i}>
                <circle
                  cx={x}
                  cy={y}
                  r={moon ? 5 : 3}
                  fill={b.pnl == null ? "transparent" : moon ? "var(--status-warning)" : color}
                  stroke={moon ? "var(--status-warning)" : color}
                  strokeWidth={1.2}
                  opacity={Math.max(0.35, 1 - b.minutesAgo / 75)}
                >
                  <title>
                    {`${b.symbol ?? "?"} · ${b.trig.toFixed(2)}× trigger · ${Math.round(b.minutesAgo)}m ago · ${
                      b.pnl == null ? "riding" : `${b.pnl >= 0 ? "+" : "−"}$${Math.abs(b.pnl).toFixed(2)}`
                    }${moon ? ` · MOON ${b.peakX.toFixed(1)}×` : ""}${b.lane === "live" ? " · LIVE" : ""}`}
                  </title>
                </circle>
                {b.lane === "live" ? (
                  <circle cx={x} cy={y} r={moon ? 8 : 6} fill="none" stroke="var(--status-serious)" strokeWidth={1} />
                ) : null}
              </g>
            );
          })}
          {/* the sweep — clockwise, one turn per 8s; paused under reduced motion */}
          <g className="radar-sweep" style={{ transformOrigin: `${cx}px ${cy}px` }}>
            <line x1={cx} y1={cy} x2={cx} y2={cy - R_MAX} stroke="var(--series-1)" strokeWidth={1.5} strokeOpacity={0.9} />
            <path
              d={`M ${cx} ${cy} L ${cx} ${cy - R_MAX} A ${R_MAX} ${R_MAX} 0 0 1 ${cx + R_MAX * Math.sin(0.6)} ${cy - R_MAX * Math.cos(0.6)} Z`}
              fill="var(--series-1)"
              opacity={0.08}
            />
          </g>
          <circle cx={cx} cy={cy} r={2.5} fill="var(--series-1)" />
          <style>{`
            .radar-sweep { animation: sweetspot-sweep 8s linear infinite; }
            @keyframes sweetspot-sweep { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
            @media (prefers-reduced-motion: reduce) { .radar-sweep { animation: none; } }
          `}</style>
        </svg>
      </div>
      <div className="grid min-w-[220px] flex-1 grid-cols-2 gap-3">
        <Stat
          label="Locked band"
          value={`${view.lo.toFixed(2)}–${view.hi.toFixed(2)}×`}
          sub={view.measured ? "measured from tape" : "static fallback"}
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
      </div>
    </div>
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
