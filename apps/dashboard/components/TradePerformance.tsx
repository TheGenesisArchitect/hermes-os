// TRADE PERFORMANCE ANALYZER — every closed trade scored through the whole
// pipeline: entry, floor, ladder, trail, peak-vs-exit.
//
// P&L answers "did it win". It does not answer "was it MANAGED well", and those
// come apart constantly: a +$1 win that gave back a 4× peak is a worse outcome
// than a −$0.30 loss that exited exactly where the genome said. Every exit
// defect found in the 2026-07-21 audit — the trail walking winners into losses,
// rungs that never fired, runners stranded past their clock — was invisible in
// P&L and only appeared when trades were read stage by stage. This panel makes
// that reading permanent instead of a one-off audit.
//
// Core = the four headline KPIs, the peak-vs-exit chart and per-signature
// management quality. Drawer = trade by trade with the pipeline lamps.
import { Panel } from "@/components/ui/Drawer";
import { CaptureScatter } from "@/components/CaptureScatter";
import { LivePill } from "@/components/LaneScorecard";
import type { TradePerformanceView, TradeScore } from "@/lib/queries";

const money = (v: number) => `${v < 0 ? "−" : "+"}$${Math.abs(v).toFixed(2)}`;
const pretty = (s: string | null) => (s ?? "unrouted").replace("MOON_", "M·").toLowerCase();

const GRADE_TONE: Record<string, string> = {
  A: "var(--status-good)",
  B: "var(--series-1)",
  C: "var(--text-secondary)",
  D: "var(--status-serious)",
  F: "var(--status-critical)",
};

/** Compact KPI tile — matches the LaneCard idiom; StatTile is a `.card` and
 *  would nest a card inside this panel's card. */
function Kpi({ label, value, tone, sub }: { label: string; value: string; tone?: string; sub: string }) {
  return (
    <div className="flex-1 rounded-md p-3" style={{ background: "var(--page)", border: "1px solid var(--gridline)" }}>
      <div className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
        {label}
      </div>
      <div className="tabular mt-1 text-xl font-semibold" style={{ color: tone ?? "var(--text-primary)" }}>
        {value}
      </div>
      <div className="mt-0.5 text-[10px]" style={{ color: "var(--text-secondary)" }}>
        {sub}
      </div>
    </div>
  );
}

/** A stage lamp: did this checkpoint do its job on this trade? */
function Stage({ label, state, title }: { label: string; state: "ok" | "miss" | "na"; title: string }) {
  const tone =
    state === "ok" ? "var(--status-good)" : state === "miss" ? "var(--status-critical)" : "var(--text-muted)";
  return (
    <span title={title} className="inline-flex items-center gap-1 whitespace-nowrap text-[10px]" style={{ color: tone }}>
      <span
        className="inline-block rounded-full"
        style={{ width: 5, height: 5, background: tone, opacity: state === "na" ? 0.35 : 1 }}
      />
      {label}
    </span>
  );
}

function Row({ t }: { t: TradeScore }) {
  const isLive = t.lane === "live";
  return (
    <tr style={{ borderTop: "1px solid var(--gridline)" }}>
      <td className="whitespace-nowrap py-1.5 pr-3">
        <span className="font-semibold" style={{ color: GRADE_TONE[t.grade] }}>
          {t.grade}
        </span>
        {isLive ? (
          <span title="live wallet" className="ml-1.5" style={{ color: "var(--status-serious)" }}>
            ◆
          </span>
        ) : null}
        <span className="ml-2" style={{ color: "var(--text-primary)" }}>
          {t.symbol ?? "?"}
        </span>
        <span className="ml-1.5 text-[10px]" style={{ color: "var(--text-muted)" }}>
          {pretty(t.signature)}
          {t.stars ? ` ${"★".repeat(t.stars)}` : ""}
        </span>
      </td>
      <td className="py-1.5 pr-3">
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          <Stage
            label={`snap${t.snapPct != null ? ` +${(t.snapPct * 100).toFixed(0)}%` : ""}`}
            state={t.snapPct != null ? "ok" : "na"}
            title="ENTRY — the confirmation snap that qualified this trade"
          />
          <Stage
            label={t.rungsReachable === 0 ? "no rung" : `rungs ${t.rungsHit}/${t.rungsReachable}`}
            state={t.rungsReachable === 0 ? "na" : t.rungsHit >= t.rungsReachable ? "ok" : "miss"}
            title="LADDER — rungs the peak made reachable vs rungs that actually filled"
          />
          <Stage
            label={t.bankedFrac > 0 ? `banked ${(t.bankedFrac * 100).toFixed(0)}%` : "banked 0%"}
            state={t.bankedFrac > 0 ? "ok" : t.rungsReachable > 0 ? "miss" : "na"}
            title="How much of the position was sold ON THE WAY UP, before the final exit"
          />
          <Stage
            label={t.exitReason}
            state={t.flags.includes("trailed red") || t.flags.includes("stranded") ? "miss" : "ok"}
            title="EXIT — which mechanism closed the trade"
          />
        </div>
      </td>
      <td className="tabular whitespace-nowrap py-1.5 pr-3 text-right" style={{ color: "var(--text-secondary)" }}>
        {t.peakX.toFixed(2)}× → {t.exitX > 0 ? `${t.exitX.toFixed(2)}×` : "—"}
      </td>
      <td className="tabular py-1.5 pr-3 text-right">
        {t.captureP == null ? (
          <span style={{ color: "var(--text-muted)" }}>—</span>
        ) : (
          <span
            style={{
              color:
                t.captureP >= 60
                  ? "var(--status-good)"
                  : t.captureP >= 30
                    ? "var(--text-primary)"
                    : "var(--status-critical)",
            }}
          >
            {t.captureP.toFixed(0)}%
          </span>
        )}
      </td>
      <td
        className="tabular py-1.5 pr-3 text-right"
        style={{ color: t.pnl >= 0 ? "var(--status-good)" : "var(--status-critical)" }}
      >
        {money(t.pnl)}
      </td>
      <td className="py-1.5 text-[10px]" style={{ color: "var(--status-warning)" }}>
        {t.flags.join(" · ")}
      </td>
    </tr>
  );
}

export function TradePerformance({ view, liveEnabled }: { view: TradePerformanceView; liveEnabled: boolean }) {
  const { trades, byGrade, bySignature, totals, windowHours } = view;
  const liveN = trades.filter((t) => t.lane === "live").length;
  const capture = totals.avgCapture;
  const wellPct = totals.n ? (100 * totals.wellManaged) / totals.n : 0;

  const badge = (
    <span
      className="tabular rounded px-1.5 py-px text-[10px]"
      style={{ color: "var(--text-muted)", border: "1px solid var(--gridline)" }}
    >
      {totals.n} closed · last {windowHours}h
    </span>
  );

  return (
    <Panel
      title="Trade Performance Analyzer"
      badge={badge}
      accent="var(--series-1)"
      storageKey="trade-performance"
      drawerTitle="Every trade, stage by stage"
      drawerSubtitle="Entry snap → ladder rungs → banked on the way up → exit mechanism"
      expandLabel="All trades"
      actions={<LivePill enabled={liveEnabled} n={liveN} />}
      drawer={
        <div className="space-y-3">
          <p className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
            Sorted most recent first. ◆ marks a live-wallet trade. A red lamp means that checkpoint did not do
            its job on this trade — those are the rows the learning loop should be reading.
          </p>
          <table className="w-full text-[11px]">
            <thead>
              <tr
                className="text-[10px] uppercase tracking-wide"
                style={{ color: "var(--text-muted)", textAlign: "left" }}
              >
                <th className="pb-1 font-medium">Trade</th>
                <th className="pb-1 font-medium">Pipeline</th>
                <th className="pb-1 text-right font-medium">Peak → exit</th>
                <th className="pb-1 text-right font-medium">Capture</th>
                <th className="pb-1 text-right font-medium">P&amp;L</th>
                <th className="pb-1 font-medium">Flags</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <Row key={`${t.lane}-${t.id}`} t={t} />
              ))}
            </tbody>
          </table>
        </div>
      }
    >
      {/* ── the four numbers that say whether the machine is managing well ── */}
      <div className="mb-3 flex flex-wrap gap-2">
        <Kpi
          label="Capture"
          value={capture == null ? "—" : `${capture.toFixed(0)}%`}
          tone={
            capture == null
              ? undefined
              : capture >= 40
                ? "var(--status-good)"
                : capture >= 0
                  ? "var(--status-warning)"
                  : "var(--status-critical)"
          }
          sub={`of the dollars ${totals.reachedRung} peaks offered`}
        />
        <Kpi
          label="Ladder fill"
          value={`${totals.ladderFillRate.toFixed(0)}%`}
          tone={totals.ladderFillRate >= 60 ? "var(--status-good)" : "var(--status-critical)"}
          sub={`${totals.bankedNothing} reached a rung and banked nothing`}
        />
        <Kpi
          label="Trailed red"
          value={`${totals.trailedRed}`}
          tone={totals.trailedRed === 0 ? "var(--status-good)" : "var(--status-critical)"}
          sub="winners managed into a loss"
        />
        <Kpi
          label="Net P&L"
          value={money(totals.pnl)}
          tone={totals.pnl >= 0 ? "var(--status-good)" : "var(--status-critical)"}
          sub={`${wellPct.toFixed(0)}% graded A or B`}
        />
      </div>

      {/* ── grade ribbon ── */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[10px]">
        {byGrade
          .filter((g) => g.n > 0)
          .map((g) => (
            <span
              key={g.grade}
              title={`${g.n} trades graded ${g.grade}`}
              className="tabular rounded px-1.5 py-px"
              style={{ border: `1px solid ${GRADE_TONE[g.grade]}`, color: GRADE_TONE[g.grade] }}
            >
              {g.grade} · {g.n} · {money(g.pnl)}
            </span>
          ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ── hero chart: how much of each move was kept ── */}
        <div>
          <div className="mb-1 flex items-baseline gap-2">
            <span className="text-[11px] font-medium" style={{ color: "var(--text-primary)" }}>
              Peak reached vs exit taken
            </span>
            <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
              distance below the dashed line = give-back
            </span>
          </div>
          <CaptureScatter
            points={trades.map((t) => ({
              symbol: t.symbol ?? "?",
              signature: t.signature ?? "unrouted",
              lane: t.lane,
              peakX: t.peakX,
              exitX: t.exitX,
              pnl: t.pnl,
              sizeUsd: t.sizeUsd,
            }))}
          />
          <div className="mt-1 flex flex-wrap gap-3 text-[10px]" style={{ color: "var(--text-muted)" }}>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--series-1)" }} /> paper
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--status-serious)" }} /> live
            </span>
            <span>— · — perfect exit</span>
            <span style={{ color: "var(--status-critical)" }}>—— entry (below = closed red)</span>
          </div>
        </div>

        {/* ── management quality per signature, separate from profitability ── */}
        <div>
          <div className="mb-1 text-[11px] font-medium" style={{ color: "var(--text-primary)" }}>
            Management quality by signature
          </div>
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                <th className="pb-1 text-left font-medium">Signature</th>
                <th className="pb-1 text-right font-medium">N</th>
                <th className="pb-1 text-right font-medium" title="Share of the dollars the peaks offered that was actually kept">
                  Capture
                </th>
                <th className="pb-1 text-right font-medium" title="Of trades that reached a rung, how many actually filled one">
                  Ladder
                </th>
                <th className="pb-1 text-right font-medium">P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              {bySignature.map((s) => (
                <tr key={s.signature} style={{ borderTop: "1px solid var(--gridline)" }}>
                  <td className="py-1" style={{ color: "var(--text-primary)" }}>
                    {pretty(s.signature)}
                  </td>
                  <td className="tabular py-1 text-right" style={{ color: "var(--text-secondary)" }}>
                    {s.n}
                  </td>
                  <td className="tabular py-1 text-right">
                    {s.avgCapture == null ? (
                      <span style={{ color: "var(--text-muted)" }}>—</span>
                    ) : (
                      <span
                        style={{
                          color:
                            s.avgCapture >= 40
                              ? "var(--status-good)"
                              : s.avgCapture >= 0
                                ? "var(--text-primary)"
                                : "var(--status-critical)",
                        }}
                      >
                        {s.avgCapture.toFixed(0)}%
                      </span>
                    )}
                  </td>
                  <td
                    className="tabular py-1 text-right"
                    style={{ color: s.bankedRate >= 60 ? "var(--text-primary)" : "var(--status-critical)" }}
                  >
                    {s.n === 0 ? "—" : `${s.bankedRate.toFixed(0)}%`}
                  </td>
                  <td
                    className="tabular py-1 text-right"
                    style={{ color: s.pnl >= 0 ? "var(--status-good)" : "var(--status-critical)" }}
                  >
                    {money(s.pnl)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[10px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
            <strong style={{ color: "var(--text-secondary)" }}>Capture</strong> pools dollars kept over dollars the
            peaks put on the table — the one number separating a well-managed book from a lucky one.{" "}
            <strong style={{ color: "var(--text-secondary)" }}>Ladder</strong> is the share of trades that reached a
            rung and actually filled it; under 60% means the ladder is not firing, which P&amp;L alone never shows.
          </p>
        </div>
      </div>
    </Panel>
  );
}
