"use client";

import { Panel } from "@/components/ui/Drawer";
import type { WinningFormulaView, LaneFormula } from "@/lib/queries";

/**
 * WINNING FORMULA — the real-time Paper-vs-Live divergence gauge. The per-trade
 * expectancy math (win rate, avg win/loss, tail, blow-ups), both lanes side by
 * side, with the biggest leak named. Read it live; tune the formula continuously.
 */

const pct = (v: number, d = 1) => `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`;

function Metric({
  label, paper, live, worseWhenBelow = true, unit = "%",
}: { label: string; paper: number; live: number; worseWhenBelow?: boolean; unit?: string }) {
  const worse = worseWhenBelow ? live < paper : live > paper;
  const liveColor = Math.abs(live - paper) < 1e-6 ? "var(--text-secondary)" : worse ? "var(--status-critical)" : "var(--status-good)";
  const fmt = (v: number) => (unit === "%" ? pct(v) : `${v >= 0 ? "+" : ""}${v.toFixed(0)}${unit}`);
  return (
    <div className="grid grid-cols-3 items-baseline gap-2 border-b py-1.5" style={{ borderColor: "var(--gridline)" }}>
      <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>{label}</span>
      <span className="tabular text-right text-[12px]" style={{ color: "var(--series-2, var(--text-secondary))" }}>{fmt(paper)}</span>
      <span className="tabular text-right text-[12px] font-semibold" style={{ color: liveColor }}>{fmt(live)}</span>
    </div>
  );
}

export function WinningFormula({ view }: { view: WinningFormulaView }) {
  const { paper, live, leak, windowHours } = view;
  const fences = view.fences ?? [];
  const onTrack = leak === "on track";
  const expWorse = live.expectancyPct < paper.expectancyPct;
  const badge = (
    <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold" style={{ color: onTrack ? "var(--status-good)" : "var(--status-critical)", border: `1px solid ${onTrack ? "var(--status-good)" : "var(--status-critical)"}` }}>
      {onTrack ? "on track" : "leak"}
    </span>
  );

  const detail = (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2 pb-1 text-[9px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
        <span></span><span className="text-right">paper</span><span className="text-right">live</span>
      </div>
      <div>
        <Metric label="expectancy / trade" paper={paper.expectancyPct} live={live.expectancyPct} />
        <Metric label="win rate" paper={paper.winPct} live={live.winPct} />
        <Metric label="avg win" paper={paper.avgWinPct} live={live.avgWinPct} />
        <Metric label="avg loss" paper={paper.avgLossPct} live={live.avgLossPct} worseWhenBelow />
        <Metric label="best trade (tail)" paper={paper.bestPct} live={live.bestPct} unit="%" />
        <Metric label="blow-ups (≥50% loss)" paper={paper.blowupPct} live={live.blowupPct} worseWhenBelow={false} unit="%" />
        <Metric label="full losses" paper={paper.fullLossPct} live={live.fullLossPct} worseWhenBelow={false} unit="%" />
      </div>
      <div className="grid grid-cols-3 items-baseline gap-2 text-[11px]">
        <span style={{ color: "var(--text-muted)" }}>net P&amp;L ({windowHours}h)</span>
        <span className="tabular text-right font-semibold" style={{ color: paper.netUsd >= 0 ? "var(--status-good)" : "var(--status-critical)" }}>{paper.netUsd >= 0 ? "+" : ""}${paper.netUsd.toFixed(0)}</span>
        <span className="tabular text-right font-semibold" style={{ color: live.netUsd >= 0 ? "var(--status-good)" : "var(--status-critical)" }}>{live.netUsd >= 0 ? "+" : ""}${live.netUsd.toFixed(0)}</span>
      </div>
      {fences.length > 0 && (
        <div className="space-y-1 border-t pt-2" style={{ borderColor: "var(--border)" }}>
          <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: "var(--status-warning, #d99a2b)" }}>
            ⚠ {fences.length} fence change{fences.length > 1 ? "s" : ""} inside this window — trailing lines mix pre/post-fix eras
          </div>
          {fences.map((f, i) => (
            <div key={i} className="flex items-baseline justify-between gap-2 text-[10px]" style={{ color: "var(--text-muted)" }}>
              <span className="truncate">{f.label}</span>
              <span className="tabular whitespace-nowrap">{f.hoursAgo}h ago</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <Panel
      title="⚖️ Winning Formula"
      badge={badge}
      accent={onTrack ? "var(--status-good)" : "var(--status-critical)"}
      storageKey="winning-formula"
      drawerTitle="Winning Formula · paper vs live"
      drawerSubtitle={`per-trade expectancy anatomy · ${windowHours}h rolling`}
      expandLabel="Full anatomy"
      drawer={detail}
    >
      {/* surface glance — the leak + the expectancy divergence, at a glance */}
      <div className="space-y-2">
        <div className="text-[11px] font-medium" style={{ color: onTrack ? "var(--status-good)" : "var(--status-critical)" }}>
          {onTrack ? "✓ Live tracking paper" : `⚠ Biggest leak: ${leak}`}
        </div>
        {fences.length > 0 && (
          <div className="text-[10px]" style={{ color: "var(--status-warning, #d99a2b)" }}>
            ⏱ {fences.length} fence change{fences.length > 1 ? "s" : ""} in window — read as pre/post-fix blend (latest {fences[0]!.hoursAgo}h ago)
          </div>
        )}
        <div className="flex items-end gap-6">
          <div>
            <div className="tabular text-lg font-bold" style={{ color: paper.expectancyPct >= 0 ? "var(--status-good)" : "var(--status-critical)" }}>{pct(paper.expectancyPct)}</div>
            <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>paper exp/trade ({paper.n})</div>
          </div>
          <div>
            <div className="tabular text-lg font-bold" style={{ color: live.expectancyPct >= 0 ? "var(--status-good)" : "var(--status-critical)" }}>{pct(live.expectancyPct)}</div>
            <div className="text-[10px]" style={{ color: expWorse ? "var(--status-critical)" : "var(--text-muted)" }}>live exp/trade ({live.n})</div>
          </div>
        </div>
      </div>
    </Panel>
  );
}
