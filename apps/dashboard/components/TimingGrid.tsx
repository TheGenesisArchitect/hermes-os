"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { setManagementIntent } from "@/app/actions";
import type { TradeDna } from "@hermes/core";
import { TradeDNA } from "@/components/TradeDNA";
import type { TimingGridView, TimingTrade } from "@/lib/queries";

// The vertical Trade Matrix: one heat-bar per trade, height = how high it rose
// (mark multiple) on a LOG scale — a 41x parabolic bar no longer flattens the
// 1.1-2x field where most of the book lives. Ghost bars scroll back through 6h
// of history; hovering any bar opens its BASEBALL CARD (venue, sizing, model
// scores, value-over-time spark), and closing a live position is a deliberate
// two-step inside the card — no more accidental clicks on a trending candle.

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
// SIGNATURE-AWARE TIME ZONING.
//
// The old axis bucketed every trade on one genome (<150s critical, >300s good),
// which cannot be right for classes that peak at completely different times:
// MOON peaks ~1.6m after entry, CLIMBER ~4.2m, BASE ~7.7m, RISER ~9.8m. A moon
// at 200s is past its prime; a riser at 200s has barely started. Colouring both
// the same way told the operator nothing.
//
// So a bar is now read against ITS OWN class clock: green while it is inside the
// window where that signature does its work, amber as it approaches the horizon,
// red once past it. Unrouted (legacy) bars keep the original global zoning.
const PEAK_SEC: Record<string, number> = {
  MOON_FAST: 96, MOON_STEADY: 96, MOON_SLOW: 96, MOON_VIOLENT: 96,
  CLIMBER: 252, BASE: 462, RISER: 588,
};
const zoneTone = (sec: number, signature?: string | null) => {
  const peak = signature ? PEAK_SEC[signature] : undefined;
  if (peak === undefined) {
    return sec < 150 ? "var(--status-critical)" : sec < 300 ? "var(--status-warning)" : "var(--status-good)";
  }
  if (sec <= peak) return "var(--status-good)"; // inside its productive window
  if (sec <= peak * 2) return "var(--status-warning)"; // drifting past prime
  return "var(--status-critical)"; // well beyond what this class has ever paid
};

// One tone per genome, so a wall of bars reads as a distribution of classes at a
// glance rather than an undifferentiated field.
const SIG_TONE: Record<string, string> = {
  RISER: "var(--series-1)",
  BASE: "var(--series-2)",
  CLIMBER: "var(--series-3)",
  MOON_FAST: "var(--status-warning)",
  MOON_STEADY: "var(--status-warning)",
  MOON_SLOW: "var(--text-muted)",
  MOON_VIOLENT: "var(--status-critical)",
};
const sigShort = (s: string) => (s.startsWith("MOON_") ? `M·${s.slice(5, 9)}` : s.slice(0, 7));

// LANE. Live trades its own signals now, so the Matrix carries both books and
// must never let them blur — a live bar is real capital and has to read as such
// at a glance. Live bars carry a filled marker and the danger accent; paper is
// unmarked, so the default reading of the grid stays quiet.
const isLive = (lane: string) => lane === "live";
const LANE_MARK = "◆";
const fmtSec = (s: number) => (s >= 60 ? `${Math.round(s / 60)}m` : `${Math.round(s)}s`);
const fmtClock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// Presence: bars at 2x width and 2x height with real gaps between them — the
// grid flexes (scrolls) to accommodate the field, the candles carry the room.
const TRACK_H = 480; // px — the shared 1.0×→yMax wall (full module fits one viewport)
const GHOST_W = 60;
const LIVE_W = 80;
const BAR_GAP = 8;
const RIGHT_PAD = 40; // breathing room so live bars never sit against the right wall
const GHOST_OPACITY = 0.6; // pronounced history — readable at a glance, still clearly not live

// ── the baseball card ────────────────────────────────────────────────────────
function ValueSpark({ t }: { t: TimingTrade }) {
  const pts = t.points;
  if (pts.length < 2) return null;
  const W = 232;
  const H = 44;
  const vals = pts.map((p) => p.mm * t.sizeUsd);
  const lo = Math.min(...vals, t.sizeUsd);
  const hi = Math.max(...vals, t.sizeUsd * 1.02);
  const x = (i: number) => (i / (pts.length - 1)) * (W - 4) + 2;
  const y = (v: number) => H - 3 - ((v - lo) / (hi - lo)) * (H - 8);
  const d = vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const last = vals[vals.length - 1]!;
  const up = last >= t.sizeUsd;
  return (
    <svg width={W} height={H} aria-label="traded value over time">
      {/* cost-basis baseline */}
      <line x1={2} x2={W - 2} y1={y(t.sizeUsd)} y2={y(t.sizeUsd)} stroke="var(--gridline)" strokeDasharray="3 3" />
      <path d={d} fill="none" stroke={up ? "var(--status-good)" : "var(--status-critical)"} strokeWidth={1.5} />
      <circle cx={x(pts.length - 1)} cy={y(last)} r={2.5} fill={up ? "var(--status-good)" : "var(--status-critical)"} />
    </svg>
  );
}

function Card({
  t,
  dna,
  onClose,
  closing,
}: {
  t: TimingTrade;
  dna: TradeDna | null;
  onClose: (id: number) => void;
  closing: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setConfirming(false), [t.id]);
  const isOpen = t.status === "open";
  // Float on the REMAINDER only — TP tranches already sold are in `banked`.
  // Full-size × mark once overstated a GAIN runner 4.5x (+$39.52 shown, ~$8.7 real).
  const basisRem = t.sizeUsd * t.remFrac;
  const valueNow = t.sizeUsd * t.curMult * t.remFrac;
  const floatGross = valueNow - basisRem;
  const row = (k: string, v: React.ReactNode) => (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>{k}</span>
      <span className="tabular text-[11.5px]" style={{ color: "var(--text-primary)" }}>{v}</span>
    </div>
  );
  return (
    <div
      className="w-[260px] rounded-md border p-3 shadow-xl"
      style={{ background: "var(--surface-1)", borderColor: "var(--border)" }}
    >
      {/* header */}
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          {isLive(t.lane) && <span style={{ color: "var(--status-critical)" }}>{LANE_MARK} </span>}
          {t.symbol ?? "?"}
        </span>
        <span
          className="rounded px-1.5 py-px text-[9px] uppercase tracking-wide"
          style={{
            border: `1px solid ${isLive(t.lane) ? "var(--status-critical)" : "var(--border)"}`,
            color: isLive(t.lane) ? "var(--status-critical)" : "var(--text-secondary)",
          }}
        >
          {isLive(t.lane) ? "LIVE · " : ""}
          {t.venue ?? "unknown"}{t.isFarm ? " ◇ farm" : ""}
        </span>
      </div>
      <div className="mb-2 text-[10.5px]" style={{ color: isOpen ? STATE_TONE[t.state] : "var(--text-muted)" }}>
        {isOpen
          ? `OPEN · ${t.state} · ${fmtSec(t.ageSec)} · since ${fmtClock(t.openedAtIso)}`
          : `CLOSED · ${t.exit?.reason ?? "closed"} · held ${fmtSec(t.ageSec)} · opened ${fmtClock(t.openedAtIso)}`}
      </div>

      {/* SIGNAL vs EXECUTION — the routing evidence beside what it produced. This
          is the row worth reading: a class that consistently exits unlike its
          genome is either mis-routed or mis-tuned, and neither is visible from
          P&L alone. */}
      {t.signature && (
        <div
          className="mb-2 rounded px-1.5 py-1 text-[10px]"
          style={{ background: "var(--surface-2)", border: `1px solid ${SIG_TONE[t.signature] ?? "var(--border)"}` }}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold uppercase tracking-wide" style={{ color: SIG_TONE[t.signature] ?? "var(--text-secondary)" }}>
              {t.signature}
            </span>
            <span className="tabular" style={{ color: zoneTone(t.ageSec, t.signature) }}>
              {fmtSec(t.ageSec)} / peak ~{fmtSec(PEAK_SEC[t.signature] ?? 0)}
            </span>
          </div>
          <div className="mt-0.5 tabular" style={{ color: "var(--text-muted)" }}>
            {t.dipDepth != null && `dip ${(t.dipDepth * 100).toFixed(0)}%`}
            {t.snapPct != null && ` · snap +${(t.snapPct * 100).toFixed(0)}%`}
            {t.snapRate != null && ` · ${t.snapRate.toFixed(1)}×/min`}
          </div>
        </div>
      )}

      {isOpen && dna && (
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[9px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>DNA</span>
          <TradeDNA dna={dna} />
        </div>
      )}

      {/* value-over-time — the card's centerpiece */}
      <ValueSpark t={t} />
      <div className="mb-2 mt-1 flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
          {isOpen && t.remFrac < 0.999 ? `value · ${Math.round(t.remFrac * 100)}% held` : "value"}
        </span>
        <span className="tabular text-[13px] font-semibold" style={{ color: (isOpen ? floatGross + t.banked : (t.exit?.pnl ?? 0)) >= 0 ? "var(--status-good)" : "var(--status-critical)" }}>
          {isOpen
            ? `$${basisRem.toFixed(2)} → $${valueNow.toFixed(2)} (${floatGross >= 0 ? "+" : ""}$${floatGross.toFixed(2)} float${t.banked !== 0 ? ` · ${t.banked >= 0 ? "+" : ""}$${t.banked.toFixed(2)} banked` : ""})`
            : `$${t.sizeUsd.toFixed(2)} in (${(t.exit?.pnl ?? 0) >= 0 ? "+" : ""}$${(t.exit?.pnl ?? 0).toFixed(2)} realized)`}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 border-t pt-2" style={{ borderColor: "var(--border)" }}>
        {row("mark", `${t.curMult.toFixed(2)}×`)}
        {row("peak", `${t.peakMult.toFixed(2)}×`)}
        {row("conviction", t.triggerMult ? `${t.triggerMult.toFixed(2)}× proven` : "—")}
        {row("rug score", t.rugProb !== null ? `${Math.round(t.rugProb * 100)}%` : "—")}
        {row("size mult", t.qualityMult !== null ? `×${t.qualityMult.toFixed(2)}` : "—")}
        {isOpen ? row("locked floor", t.armed ? `${t.lockedMult.toFixed(2)}×` : "not armed") : row("exit fill", `${(t.exit?.mm ?? 0).toFixed(2)}×`)}
      </div>

      {isOpen && (
        <button
          className="mt-3 w-full rounded border py-1.5 text-[11px] font-medium"
          style={{
            borderColor: confirming ? "var(--status-critical)" : "var(--border)",
            color: confirming ? "var(--status-critical)" : "var(--text-secondary)",
            background: confirming ? "rgba(214,62,62,0.08)" : "transparent",
          }}
          onClick={() => {
            if (!confirming) {
              setConfirming(true);
              return;
            }
            onClose(t.id);
          }}
        >
          {closing ? "closing…" : confirming ? "Confirm close — sell at market ✕" : "Close position…"}
        </button>
      )}
    </div>
  );
}

// ── the matrix ───────────────────────────────────────────────────────────────
export function TimingGrid({ view, dnaByMint }: { view: TimingGridView; dnaByMint?: Record<string, TradeDna> }) {
  const [card, setCard] = useState<{ id: number; x: number; y: number } | null>(null);
  const [closing, setClosing] = useState<Set<number>>(new Set());
  const [, startTransition] = useTransition();
  const wrapRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const open = useMemo(
    () => view.trades.filter((t) => t.status === "open").sort((a, b) => b.curMult - a.curMult),
    [view.trades],
  );
  // History reads left → right, oldest → newest, ending at the live edge.
  const closed = useMemo(
    () => view.trades.filter((t) => t.status === "closed").sort((a, b) => a.id - b.id),
    [view.trades],
  );

  // Land on the live edge; history is a scroll to the left.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [closed.length, open.length]);

  // Scale to the CURRENT neighborhood — live bars + the newest ghosts — not
  // the tallest candle in six hours of history. A 41x monster from this
  // morning must not squash tonight's 1.1-1.2x field; when an older ghost
  // exceeds the scale it clips at the ceiling and wears a cap label instead.
  const neighborhood = [...open, ...closed.slice(-12)];
  const yMax = Math.max(1.8, ...neighborhood.map((t) => t.peakMult)) * 1.05;
  // LOG scale: a parabolic 41x bar keeps the 1.1-2x field readable — equal
  // ratios get equal pixels, which is the honest geometry for multiples.
  const pct = (mult: number) => Math.max(0, Math.min(1, Math.log(Math.max(mult, 1)) / Math.log(yMax))) * 100;
  const ticks = [1.2, 1.5, 2, 3, 5, 10, 20, 50, 100].filter((m) => m < yMax * 0.96).slice(0, 6);

  if (view.trades.length === 0) {
    return (
      <div className="flex h-52 items-center justify-center text-sm" style={{ color: "var(--text-muted)" }}>
        No open or recently-closed trades — the matrix fills as the trader takes positions.
      </div>
    );
  }

  const closePosition = (id: number) => {
    setClosing((s) => new Set(s).add(id));
    startTransition(() => {
      void setManagementIntent(id, "cut");
    });
    setCard(null);
  };

  const showCard = (id: number, el: HTMLElement, displayMult: number) => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    const wrap = wrapRef.current;
    if (!wrap) return;
    const w = wrap.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const x = Math.max(8, Math.min(r.left - w.left + r.width / 2 - 130, w.width - 268));
    // Anchor the card at the BAR'S VISUAL TOP, not the grid's top — the mouse
    // travels a few pixels to enter it, so the hover never expires en route.
    const CARD_H = 330;
    const barHeightPx = (pct(displayMult) / 100) * TRACK_H;
    const barTopY = r.bottom - w.top - barHeightPx; // el spans the wall; bottom = baseline
    const y = Math.max(4, Math.min(barTopY - CARD_H + 60, w.height - CARD_H - 8));
    setCard({ id, x, y });
  };
  const scheduleHide = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setCard(null), 600);
  };
  const cancelHide = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
  };

  const cardTrade = card ? view.trades.find((t) => t.id === card.id) : undefined;

  const Bar = ({ t, ghost }: { t: TimingTrade; ghost: boolean }) => {
    const exitUp = (t.exit?.pnl ?? 0) >= 0;
    return (
      <div
        className="relative flex h-full shrink-0 cursor-pointer flex-col justify-end"
        style={{ width: ghost ? GHOST_W : LIVE_W }}
        onMouseEnter={(e) => showCard(t.id, e.currentTarget, ghost ? t.peakMult : t.curMult)}
        onMouseLeave={scheduleHide}
      >
        {!ghost && (
          <div
            className="absolute left-0 right-0 text-center text-[11px] font-semibold tabular"
            style={{ bottom: `calc(${pct(t.curMult)}% + 2px)`, color: STATE_TONE[t.state] }}
          >
            {t.curMult.toFixed(2)}
          </div>
        )}
        <div
          className="relative w-full rounded-t-[2px] transition-all duration-500"
          style={{
            height: `${pct(ghost ? t.peakMult : t.curMult)}%`,
            minHeight: 2,
            background: `linear-gradient(to top, ${heat(1)}, ${heat(ghost ? t.peakMult : t.curMult)})`,
            opacity: ghost ? GHOST_OPACITY : 1,
          }}
        >
          {!ghost && t.peakMult > t.curMult + 0.01 && (
            <div
              className="absolute left-0 right-0 border-t border-dashed"
              style={{ bottom: `calc((${pct(t.peakMult)}% - ${pct(t.curMult)}%))`, borderColor: "var(--text-muted)", opacity: 0.7 }}
            />
          )}
        </div>
        {ghost && (
          <div className="absolute left-0 right-0" style={{ bottom: `${pct(Math.max(t.exit?.mm ?? 1, 1))}%` }}>
            <div className="h-[2px] w-full" style={{ background: exitUp ? "var(--status-good)" : "var(--status-critical)", opacity: 0.9 }} />
          </div>
        )}
        {!ghost && t.armed && t.lockedMult > 1.0 && (
          <div className="absolute left-0 right-0" style={{ bottom: `${pct(t.lockedMult)}%` }}>
            <div className="h-[2px] w-full" style={{ background: "var(--status-warning)", boxShadow: "0 0 3px var(--status-warning)" }} />
          </div>
        )}
        {t.isFarm && !ghost && (
          <div className="absolute right-0 top-0 text-[8px]" style={{ color: "var(--text-muted)" }}>◇</div>
        )}
      </div>
    );
  };

  return (
    <div className="w-full" ref={wrapRef} style={{ position: "relative" }}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs" style={{ color: "var(--text-muted)" }}>
        <span>
          {open.length} live · {closed.length} closed (6h — scroll ← for history) · log scale · hover a bar for its card · closing is two-step inside the card
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
        {/* shared Y axis — log ticks */}
        <div className="relative shrink-0" style={{ width: 38, height: TRACK_H }}>
          {[{ m: yMax, l: `${yMax >= 10 ? yMax.toFixed(0) : yMax.toFixed(1)}×` }, ...ticks.map((m) => ({ m, l: `${m}×` })), { m: 1, l: "1.0×" }].map((r, i) => (
            <div key={i} className="absolute right-0 -translate-y-1/2 text-[9px] tabular" style={{ bottom: `${pct(r.m)}%`, color: "var(--text-muted)" }}>
              {r.l}
            </div>
          ))}
        </div>

        {/* bar field — scrolls back through history */}
        <div className="matrix-scroll relative flex-1 overflow-x-auto" ref={scrollRef}>
          <div className="pointer-events-none sticky left-0 top-0 h-0 w-full" style={{ zIndex: 1 }}>
            <div className="absolute inset-x-0" style={{ height: TRACK_H }}>
              {ticks.map((m, i) => (
                <div key={`t${i}`} className="absolute w-full" style={{ bottom: `${pct(m)}%`, borderTop: "1px solid var(--gridline)", opacity: 0.3 }} />
              ))}
              {view.tpLevels.filter((t) => t.mult < yMax).map((t) => (
                <div key={t.label} className="absolute w-full" style={{ bottom: `${pct(t.mult)}%` }}>
                  <div className="w-full border-t border-dashed" style={{ borderColor: "var(--series-1)", opacity: 0.55 }} />
                  <span className="absolute right-0 top-[-7px] rounded-sm px-1 text-[8px] font-medium tabular" style={{ background: "var(--surface-1)", color: "var(--series-1)", opacity: 0.9 }}>
                    {t.label} {t.mult.toFixed(2)}×
                  </span>
                </div>
              ))}
              <div className="absolute w-full" style={{ bottom: 0, borderTop: "1.5px solid var(--baseline)" }} />
            </div>
          </div>

          <div className="flex items-end gap-[8px]" style={{ height: TRACK_H, minWidth: "100%", width: "max-content" }}>
            {closed.map((t) => (
              <Bar key={`c${t.id}`} t={t} ghost />
            ))}
            {closed.length > 0 && open.length > 0 && (
              <div className="h-full w-[2px] shrink-0" style={{ background: "var(--border)" }} />
            )}
            {open.map((t) => (
              <Bar key={t.id} t={t} ghost={false} />
            ))}
            <div className="h-full shrink-0" style={{ width: RIGHT_PAD }} />
          </div>

          {/* footers */}
          <div className="mt-1 flex gap-[8px]" style={{ width: "max-content", minWidth: "100%" }}>
            {closed.map((t) => {
              const exitUp = (t.exit?.pnl ?? 0) >= 0;
              return (
                <div key={`cf${t.id}`} className="shrink-0 overflow-hidden text-center" style={{ width: GHOST_W, opacity: 0.9 }}>
                  <div className="truncate text-[8px]" style={{ color: "var(--text-muted)" }}>{t.symbol ?? "?"}</div>
                  <div className="text-[10px] tabular" style={{ color: exitUp ? "var(--status-good)" : "var(--status-critical)" }}>
                    {exitUp ? "+" : ""}{(t.exit?.pnl ?? 0).toFixed(1)}
                  </div>
                  {t.signature && (
                    <div
                      className="truncate text-[7.5px] uppercase tracking-wide"
                      style={{ color: isLive(t.lane) ? "var(--status-critical)" : SIG_TONE[t.signature] ?? "var(--text-muted)" }}
                    >
                      {isLive(t.lane) ? `${LANE_MARK} ` : ""}
                      {sigShort(t.signature)}
                    </div>
                  )}
                </div>
              );
            })}
            {closed.length > 0 && open.length > 0 && <div className="w-[2px] shrink-0" />}
            {open.map((t) => (
              <div key={t.id} className="shrink-0 overflow-hidden text-center" style={{ width: LIVE_W }}>
                <div className="truncate text-[11px]" style={{ color: card?.id === t.id ? "var(--text-primary)" : "var(--text-secondary)" }}>
                  {t.symbol ?? "?"}
                </div>
                {/* age is now read against THIS class's clock, not a global one */}
                <div className="text-[10px] tabular" style={{ color: zoneTone(t.ageSec, t.signature) }}>{fmtSec(t.ageSec)}</div>
                {t.signature && (
                  <div
                    className="truncate text-[8px] uppercase tracking-wide"
                    style={{ color: isLive(t.lane) ? "var(--status-critical)" : SIG_TONE[t.signature] ?? "var(--text-muted)" }}
                  >
                    {isLive(t.lane) ? `${LANE_MARK} ` : ""}
                    {sigShort(t.signature)}
                  </div>
                )}
              </div>
            ))}
            <div className="shrink-0" style={{ width: RIGHT_PAD }} />
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

      {/* the baseball card */}
      {card && cardTrade && (
        <div
          style={{ position: "absolute", left: card.x, top: card.y, zIndex: 20 }}
          onMouseEnter={cancelHide}
          onMouseLeave={scheduleHide}
        >
          <Card t={cardTrade} dna={dnaByMint?.[cardTrade.mint] ?? null} onClose={closePosition} closing={closing.has(cardTrade.id)} />
        </div>
      )}
    </div>
  );
}
