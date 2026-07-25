"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { Line, LineChart, ReferenceLine, ResponsiveContainer, YAxis } from "recharts";
import type { ManagementFeature } from "@hermes/core";
import { getLiveCloseStatus, requestLiveClose, setManagementIntent } from "@/app/actions";
import { fmtTs, fmtTsFull } from "@/components/ui";
import { TradeDNA } from "@/components/TradeDNA";
import type { ManagedPosition } from "@/lib/queries";

/** Serialized shape passed from the server page (Date → ISO). */
export interface ManagedPositionView extends Omit<ManagedPosition, "openedAt"> {
  openedAt: string;
}

const money = (v: number, digits = 2) =>
  `${v >= 0 ? "+" : "−"}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

/**
 * Float box — the live unrealized P&L on winning-but-still-open trades. The
 * headline number is REALIZABLE: mark value minus the convex slippage it would
 * cost to exit that size now, minus fees. We never lead with gross mark P&L —
 * on a thin pool that overstates what you could actually bank (the exact error
 * this engine was built to kill).
 */
function FloatSummary({ positions }: { positions: ManagedPositionView[] }) {
  // LANE SEPARATION — the headline is the PAPER float; live gets its own tile.
  // Blending real-capital float into the paper number would corrupt both
  // ledgers at a glance (the lane-separation standard).
  const paper = positions.filter((p) => p.lane !== "live");
  const live = positions.filter((p) => p.lane === "live");
  const liveNet = live.reduce((s, p) => s + p.unrealizedNetUsd, 0);
  const netTotal = paper.reduce((s, p) => s + p.unrealizedNetUsd, 0);
  const grossTotal = paper.reduce((s, p) => s + p.unrealizedGrossUsd, 0);
  const green = paper.filter((p) => p.unrealizedNetUsd > 0);
  const red = paper.filter((p) => p.unrealizedNetUsd <= 0);
  const best = [...paper].sort((a, b) => b.unrealizedNetUsd - a.unrealizedNetUsd)[0];
  const slipHaircut = grossTotal - netTotal;
  const netTone = netTotal >= 0 ? "var(--status-good)" : "var(--status-critical)";

  return (
    <div className="card mb-4 p-4">
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <div>
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>Open float · realizable now</div>
          <div className="tabular text-3xl font-semibold" style={{ color: netTone }}>{money(netTotal)}</div>
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>
            net of exit slippage &amp; fees · {money(grossTotal)} at mark
            {slipHaircut > 0.01 ? <span> (−${slipHaircut.toFixed(2)} to get out)</span> : null}
          </div>
        </div>
        <div>
          <div className="tabular text-xl font-semibold" style={{ color: "var(--status-good)" }}>{green.length}</div>
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>green &amp; open</div>
        </div>
        <div>
          <div className="tabular text-xl font-semibold" style={{ color: "var(--text-secondary)" }}>{red.length}</div>
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>underwater</div>
        </div>
        {live.length > 0 ? (
          <div>
            <div className="tabular text-xl font-semibold" style={{ color: liveNet >= 0 ? "var(--status-good)" : "var(--status-critical)" }}>
              ◆ {money(liveNet)}
            </div>
            <div className="text-xs" style={{ color: "var(--status-serious)" }}>
              live float · {live.length} open · real capital
            </div>
          </div>
        ) : null}
        {best && best.unrealizedNetUsd > 0 ? (
          <div className="ml-auto text-right">
            <div className="text-xs" style={{ color: "var(--text-muted)" }}>top floater</div>
            <div className="text-sm font-semibold">
              {best.symbol ?? "?"} <span className="tabular" style={{ color: "var(--status-good)" }}>{money(best.unrealizedNetUsd)}</span>
              <span className="tabular ml-1 text-xs" style={{ color: "var(--text-muted)" }}>({best.markMultiple.toFixed(2)}×)</span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Per-card float readout — realizable net, the mark it came from, and the haircut. */
function FloatLine({ p }: { p: ManagedPositionView }) {
  const tone = p.unrealizedNetUsd >= 0 ? "var(--status-good)" : "var(--status-critical)";
  const haircut = p.unrealizedGrossUsd - p.unrealizedNetUsd;
  return (
    <div className="mt-3 flex items-baseline justify-between rounded-md px-2.5 py-2" style={{ background: "var(--page)" }}>
      <div>
        <div className="text-xs" style={{ color: "var(--text-muted)" }}>float · realizable</div>
        <div className="tabular text-lg font-semibold" style={{ color: tone }}>
          {money(p.unrealizedNetUsd)} <span className="text-xs font-normal" style={{ color: "var(--text-muted)" }}>({p.unrealizedNetPct >= 0 ? "+" : ""}{p.unrealizedNetPct.toFixed(0)}%)</span>
        </div>
      </div>
      <div className="text-right text-xs" style={{ color: "var(--text-muted)" }}>
        <div>{money(p.unrealizedGrossUsd)} at mark</div>
        <div>
          exit slip {p.exitSlipPct.toFixed(p.exitSlipPct >= 10 ? 0 : 1)}%
          {haircut > 0.01 ? <span> · −${haircut.toFixed(2)}</span> : null}
        </div>
        {p.realizedBankedUsd > 0.01 ? (
          <div style={{ color: "var(--status-good)" }}>+${p.realizedBankedUsd.toFixed(2)} already banked</div>
        ) : null}
      </div>
    </div>
  );
}

const ACTION_COLOR: Record<string, string> = {
  RIDE: "var(--status-good)",
  TRIM: "var(--series-1)",
  CUT: "var(--status-critical)",
  HOLD: "var(--text-muted)",
};

const REGIME_NOTE: Record<string, string> = {
  IGNITION: "first leg — climbing",
  RUNNER: "sustained higher-highs",
  BLOWOFF: "parabolic exhaustion",
  STALL: "rolled off peak, cold",
  FADE: "underwater, dying",
  WATCH: "no decisive signal",
};

function ageLabel(iso: string): string {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

function FactorBars({ features }: { features: ManagementFeature[] }) {
  const max = Math.max(30, ...features.map((f) => Math.abs(f.contribution)));
  return (
    <div className="space-y-1.5">
      {features.map((f) => {
        const pct = (Math.abs(f.contribution) / max) * 50; // half-width max
        const pos = f.contribution >= 0;
        return (
          <div key={f.key} className="flex items-center gap-2 text-xs">
            <div className="w-24 shrink-0 truncate" style={{ color: "var(--text-secondary)" }} title={f.note}>
              {f.label}
            </div>
            <div className="relative h-2.5 flex-1 rounded-sm" style={{ background: "var(--gridline)" }}>
              <div className="absolute left-1/2 top-0 h-full w-px" style={{ background: "var(--baseline)" }} />
              <div
                className="absolute top-0 h-full rounded-sm"
                style={{
                  width: `${pct}%`,
                  [pos ? "left" : "right"]: "50%",
                  background: pos ? "var(--status-good)" : "var(--status-critical)",
                  opacity: 0.85,
                }}
              />
            </div>
            <div className="tabular w-12 shrink-0 text-right" style={{ color: "var(--text-muted)" }}>
              {f.contribution >= 0 ? "+" : ""}
              {f.contribution.toFixed(0)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Sparkline({ spark, peakMultiple }: { spark: { i: number; mm: number }[]; peakMultiple: number }) {
  if (spark.length < 2) {
    return (
      <div className="flex h-16 items-center justify-center text-xs" style={{ color: "var(--text-muted)" }}>
        trajectory builds as the trader polls
      </div>
    );
  }
  return (
    <div className="h-16 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={spark} margin={{ top: 4, right: 2, bottom: 0, left: 0 }}>
          <YAxis hide domain={["dataMin", "dataMax"]} />
          <ReferenceLine y={peakMultiple} stroke="var(--baseline)" strokeDasharray="2 2" />
          <ReferenceLine y={1} stroke="var(--baseline)" strokeWidth={1} />
          <Line type="monotone" dataKey="mm" stroke="var(--series-1)" strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Two-step live close: first click arms, second confirms and queues the
 *  trader's fire-sale (user_cut). Auto-disarms after 5s untouched. */
function LiveCloseButton({ positionId, symbol }: { positionId: number; symbol: string }) {
  const [armed, setArmed] = useState(false);
  const [pending, start] = useTransition();
  const [queued, setQueued] = useState(false);
  // VERDICT READBACK (the DIP incident, 2026-07-25): a close against a
  // drained pool failed silently and looked like the click did nothing. The
  // button now polls the request status and reports the outcome.
  const [verdict, setVerdict] = useState<"pending" | "failed" | "done" | "superseded" | null>(null);
  useEffect(() => {
    if (!queued) return;
    let tries = 0;
    const iv = setInterval(async () => {
      tries++;
      const v = await getLiveCloseStatus(positionId);
      if (v === "done" || v === "failed" || tries > 20) {
        setVerdict(v);
        clearInterval(iv);
      }
    }, 2000);
    return () => clearInterval(iv);
  }, [queued, positionId]);
  if (queued)
    return (
      <span
        className="text-xs font-semibold"
        style={{
          color:
            verdict === "done" ? "var(--status-good)" : verdict === "failed" ? "var(--status-critical)" : "var(--status-warning)",
        }}
      >
        {verdict === "done"
          ? "✓ closed — sold on-chain"
          : verdict === "failed"
            ? "✗ close failed — pool unroutable (write-off/revival watch armed)"
            : "queued — trader sells next cycle"}
      </span>
    );
  return (
    <button
      disabled={pending}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          setTimeout(() => setArmed(false), 5000);
          return;
        }
        start(async () => {
          await requestLiveClose(positionId);
          setQueued(true);
        });
      }}
      className="rounded px-2.5 py-1 text-xs font-bold tracking-wide"
      style={
        armed
          ? { background: "var(--status-critical)", color: "#0d0d0d" }
          : { border: "1px solid var(--status-serious)", color: "var(--status-serious)" }
      }
    >
      {pending ? "…" : armed ? `CONFIRM CLOSE ${symbol}` : "CLOSE"}
    </button>
  );
}

function Card({ p }: { p: ManagedPositionView }) {
  const [pending, start] = useTransition();
  const action = p.call?.action ?? "HOLD";
  const regime = p.call?.regime ?? "WATCH";
  const color = ACTION_COLOR[action];
  const score = p.call?.continuationScore ?? 50;
  const isLive = p.lane === "live";

  const engage = (intent: "ride" | "cut") => start(() => setManagementIntent(p.id, intent));

  return (
    <div
      className="card overflow-hidden p-4"
      style={isLive ? { borderColor: "var(--status-serious)" } : undefined}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {isLive ? (
              <span
                title="LIVE wallet — real capital, genome-owned exits"
                className="rounded px-1.5 py-px text-[10px] font-bold tracking-wide"
                style={{ background: "color-mix(in srgb, var(--status-serious) 18%, transparent)", color: "var(--status-serious)", border: "1px solid var(--status-serious)" }}
              >
                ◆ LIVE
              </span>
            ) : null}
            <Link href={`/token/${p.mint}`} className="font-semibold hover:underline" style={{ color: "var(--text-primary)" }}>
              {p.symbol ?? "?"}
            </Link>
            {p.signature ? (
              // The routed genome from the Trading DNA matrix — shown from tick
              // zero so the board matches the matrix at open, before the health
              // chip has enough trajectory to classify.
              <span
                title="routed genome — the Trading DNA class that owns this trade's exits"
                className="rounded px-1.5 py-px text-[10px] font-bold tracking-wide"
                style={{ color: "var(--series-1)", border: "1px solid var(--series-1)" }}
              >
                🧬 {p.signature.replace("MOON_", "M·")}
              </span>
            ) : null}
            <span
              className="text-xs"
              style={{ color: "var(--text-muted)" }}
              title={`opened ${fmtTsFull(p.openedAt)}`}
            >
              {p.dex} · {p.mint.slice(0, 4)}…{p.mint.slice(-4)} · opened{" "}
              <span className="tabular">{fmtTs(p.openedAt)}</span>{" "}
              {/* age is Date.now()-derived: server HTML and hydration differ by
                  the render gap, so React must not diff this text (#418) */}
              <span suppressHydrationWarning>({ageLabel(p.openedAt)})</span>
            </span>
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="tabular text-2xl font-semibold">{p.markMultiple.toFixed(p.markMultiple >= 10 ? 0 : 2)}×</span>
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              peak {p.peakMultiple.toFixed(p.peakMultiple >= 10 ? 0 : 2)}× · {p.drawdownFromPeakPct.toFixed(0)}% off peak
            </span>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <span
            className="inline-block rounded px-2 py-1 text-xs font-bold tracking-wide"
            style={{ background: color, color: action === "HOLD" ? "var(--text-primary)" : "#0d0d0d" }}
          >
            {action}
          </span>
          <div className="mt-1 text-xs" style={{ color: "var(--text-secondary)" }}>
            {regime}
          </div>
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full" style={{ background: "var(--gridline)" }}>
          <div className="h-full rounded-full" style={{ width: `${score}%`, background: color }} />
        </div>
        <span className="tabular text-xs" style={{ color: "var(--text-muted)" }}>
          {score}/100 continuation
        </span>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>DNA</span>
        <TradeDNA dna={p.dna} />
        {p.launchOrder != null ? (
          <span
            className="rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide"
            title={`F6 launch order — launch #${p.launchOrder} of this ticker in 24h${p.launchOrder === 2 ? " · the adversary's re-harvest cell (half-clip)" : p.launchOrder >= 3 && p.launchOrder <= 4 ? " · golden window (+19.5¢/$)" : ""}`}
            style={{
              color: p.launchOrder === 2 ? "var(--status-critical)" : p.launchOrder >= 3 && p.launchOrder <= 4 ? "#ffc44d" : "var(--text-muted)",
              border: `1px solid ${p.launchOrder === 2 ? "var(--status-critical)" : p.launchOrder >= 3 && p.launchOrder <= 4 ? "#ffc44d" : "var(--border-subtle)"}`,
            }}
          >
            L{p.launchOrder}{p.launchOrder >= 3 && p.launchOrder <= 4 ? "⭐" : p.launchOrder === 2 ? "⚠" : ""}
          </span>
        ) : null}
      </div>

      <p className="mt-2 text-xs leading-relaxed" style={{ color: "var(--text-secondary)" }}>
        {p.call?.reason ?? "awaiting first observation"}
        <span style={{ color: "var(--text-muted)" }}> · {REGIME_NOTE[regime]}</span>
      </p>

      <FloatLine p={p} />

      <div className="mt-3">
        <Sparkline spark={p.spark} peakMultiple={p.peakMultiple} />
      </div>

      {p.call && p.call.features.length > 0 ? (
        <div className="mt-3 border-t pt-3" style={{ borderColor: "var(--gridline)" }}>
          <div className="mb-2 text-xs uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
            Why — factor breakdown
          </div>
          <FactorBars features={p.call.features} />
        </div>
      ) : null}

      {isLive ? (
        // Genome owns the automatic exits — but the OPERATOR owns the override
        // (2026-07-24: "PigMan opened but there is no way for me to close").
        // Two-step CLOSE queues live_close_request; the trader (the single
        // money-mover) fire-sales it as user_cut on its next cycle.
        <div className="mt-3 flex items-center justify-between gap-2 border-t pt-3" style={{ borderColor: "var(--gridline)" }}>
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            🧬 genome-owned exits · operator override →
          </span>
          <LiveCloseButton positionId={p.id} symbol={p.symbol ?? "?"} />
        </div>
      ) : (
      <div className="mt-3 flex items-center gap-2 border-t pt-3" style={{ borderColor: "var(--gridline)" }}>
        <button
          onClick={() => engage("ride")}
          disabled={pending}
          className="flex-1 rounded-md py-1.5 text-xs font-semibold transition-opacity disabled:opacity-40"
          style={{ background: "rgba(12,163,12,0.15)", border: "1px solid var(--status-good)", color: "var(--status-good)" }}
          title="Suspend the mechanical trail/hard stop for one tick — hold this runner through a wick."
        >
          ▲ Ride
        </button>
        <button
          onClick={() => engage("cut")}
          disabled={pending}
          className="flex-1 rounded-md py-1.5 text-xs font-semibold transition-opacity disabled:opacity-40"
          style={{ background: "rgba(208,59,59,0.15)", border: "1px solid var(--status-critical)", color: "var(--status-critical)" }}
          title="Sell the full remaining position on the trader's next poll."
        >
          ✕ Cut now
        </button>
      </div>
      )}
      {!isLive && p.pendingIntent ? (
        <div className="mt-1.5 text-center text-xs" style={{ color: p.pendingIntent === "cut" ? "var(--status-critical)" : "var(--status-good)" }}>
          ⏳ {p.pendingIntent === "cut" ? "CUT" : "RIDE"} queued — applies on the next trader poll
        </div>
      ) : null}
    </div>
  );
}

export function ManagementBoard({ positions }: { positions: ManagedPositionView[] }) {
  if (positions.length === 0) {
    return (
      <div className="card p-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>
        No open positions to manage. When a position opens, its live trajectory, the ride-vs-cut
        classifier verdict, and RIDE/CUT controls appear here — the classifier begins recording
        ticks on the next trader restart (run 1d).
      </div>
    );
  }
  return (
    <div>
      <FloatSummary positions={positions} />
      <div className="grid gap-4 md:grid-cols-2">
        {/* Biggest live float first — the star runner must never hide below the
            fold behind two fresher $0.90 positions (the missing-GAIN report). */}
        {[...positions].sort((a, b) => b.unrealizedNetUsd - a.unrealizedNetUsd).map((p) => (
          <Card key={p.id} p={p} />
        ))}
      </div>
    </div>
  );
}
