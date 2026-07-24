/**
 * TRADE MANAGER — the live wallet's visual trade pipeline (operator,
 * 2026-07-24: "Real Time R&D Required to Perfect the Trading Funnel for the
 * Live Wallet... track exactly what's happening when a trade is opened so we
 * can pinpoint where our process is broken").
 *
 * Four headline KPIs = "convert and compound" as numbers; below them, one row
 * per recent live trade with a stage verdict at every hop of the lifecycle:
 * TIER → FILL → MANAGE → EXIT → CAPTURE → vs TWIN. Observation surface only —
 * every fix it reveals still rides harness → ratify → ship.
 */
import type { TradeManagerView, TradePipelineRow } from "@/lib/queries";
import { fmtTs } from "@/components/ui";

const money = (v: number, digits = 2) =>
  `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(digits)}`;

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: string }) {
  return (
    <div>
      <div className="text-xs" style={{ color: "var(--text-muted)" }}>{label}</div>
      <div className="tabular text-2xl font-semibold" style={{ color: tone }}>{value}</div>
      <div className="text-xs" style={{ color: "var(--text-muted)" }}>{sub}</div>
    </div>
  );
}

const TIER_TONE: Record<string, string> = {
  "MOON SHOT": "#ffc44d",
  "RUG_RISK ✓": "#c9a94a",
  PRECISION: "var(--status-good)",
  TICKET: "var(--status-good)",
  RECOVERED: "#7d8f86",
  STANDARD: "var(--text-secondary)",
};

function Row({ r }: { r: TradePipelineRow }) {
  const pnlTone = r.pnl == null ? "var(--text-muted)" : r.pnl >= 0 ? "var(--status-good)" : "var(--status-critical)";
  const capW = r.capturePct == null ? 0 : Math.max(2, Math.min(100, r.capturePct));
  return (
    <tr style={{ borderTop: "1px solid var(--border-subtle)" }}>
      <td className="py-2 pr-3 whitespace-nowrap">
        <span className="font-medium" style={{ color: "var(--text-primary)" }}>{r.symbol ?? r.mint.slice(0, 6)}</span>
        <span className="ml-2 text-xs" style={{ color: "var(--text-muted)" }}>{fmtTs(r.openedAt)}</span>
      </td>
      <td className="py-2 pr-3">
        <span
          className="rounded px-1.5 py-0.5 text-xs"
          style={{ color: TIER_TONE[r.tier] ?? "var(--text-secondary)", border: `1px solid ${TIER_TONE[r.tier] ?? "var(--border-subtle)"}` }}
        >
          {r.tier}
        </span>
      </td>
      <td className="tabular py-2 pr-3 text-xs whitespace-nowrap" style={{ color: "var(--text-secondary)" }}>
        ${r.sizeUsd.toFixed(2)}
        {r.latencyTotalMs != null ? ` · ${(r.latencyTotalMs / 1000).toFixed(1)}s fill` : ""}
        {r.requeues > 0 ? ` · ↻${r.requeues}` : ""}
      </td>
      <td className="py-2 pr-3 text-xs whitespace-nowrap" style={{ color: "var(--text-secondary)" }}>
        {r.rungs > 0 ? `${r.rungs} rung${r.rungs > 1 ? "s" : ""}` : "no rung"}
        {r.sellFails > 0 ? <span style={{ color: "var(--status-critical)" }}> · {r.sellFails} sell-fail</span> : null}
      </td>
      <td className="py-2 pr-3 text-xs whitespace-nowrap" style={{ color: "var(--text-muted)" }}>
        {r.status === "open" ? "RIDING" : (r.exitReason ?? "—")}
      </td>
      <td className="tabular py-2 pr-3 whitespace-nowrap" style={{ color: pnlTone }}>
        {r.pnl == null ? "—" : money(r.pnl)}
      </td>
      <td className="py-2 pr-3" style={{ minWidth: 90 }}>
        {r.capturePct == null ? (
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>—</span>
        ) : (
          <div className="flex items-center gap-1.5">
            <div style={{ width: 56, height: 5, background: "var(--border-subtle)", borderRadius: 2 }}>
              <div
                style={{
                  width: `${capW}%`,
                  height: 5,
                  borderRadius: 2,
                  background: r.capturePct >= 40 ? "var(--status-good)" : r.capturePct >= 0 ? "#c9a94a" : "var(--status-critical)",
                }}
              />
            </div>
            <span className="tabular text-xs" style={{ color: "var(--text-secondary)" }}>{Math.round(r.capturePct)}%</span>
          </div>
        )}
      </td>
      <td className="tabular py-2 text-xs whitespace-nowrap" style={{ color: r.dragPp == null ? "var(--text-muted)" : r.dragPp >= 0 ? "var(--status-good)" : "var(--status-critical)" }}>
        {r.dragPp == null ? "no twin" : `${r.dragPp >= 0 ? "+" : "−"}${Math.abs(r.dragPp).toFixed(1)}pp`}
      </td>
    </tr>
  );
}

export function TradeManager({ view }: { view: TradeManagerView }) {
  const fmtPct = (v: number | null, digits = 0) => (v == null ? "—" : `${v >= 0 ? "" : "−"}${Math.abs(v).toFixed(digits)}%`);
  return (
    <div className="card p-4">
      <div className="mb-4 flex flex-wrap items-end gap-x-8 gap-y-3">
        <Kpi
          label="Connection rate · 24h"
          value={fmtPct(view.connectPct)}
          sub="live fills ÷ qualified hand-offs"
          tone={view.connectPct != null && view.connectPct >= 50 ? "var(--status-good)" : "var(--text-secondary)"}
        />
        <Kpi
          label="Execution drag vs paper"
          value={view.dragPp == null ? "—" : `${view.dragPp >= 0 ? "+" : "−"}${Math.abs(view.dragPp).toFixed(1)}pp`}
          sub="same-mint twin, avg"
          tone={view.dragPp != null && view.dragPp >= -2 ? "var(--status-good)" : "var(--status-critical)"}
        />
        <Kpi
          label="Capture · 24h"
          value={fmtPct(view.capturePct)}
          sub="banked ÷ offered at traded size"
          tone={view.capturePct != null && view.capturePct >= 40 ? "var(--status-good)" : "var(--text-secondary)"}
        />
        <Kpi
          label="Compound · 24h"
          value={fmtPct(view.compound24hPct, 1)}
          sub="live equity vs 24h ago · target 10-30%"
          tone={view.compound24hPct != null && view.compound24hPct > 0 ? "var(--status-good)" : "var(--status-critical)"}
        />
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr className="text-left text-xs" style={{ color: "var(--text-muted)" }}>
              <th className="pb-2 pr-3 font-normal">Trade</th>
              <th className="pb-2 pr-3 font-normal">Tier</th>
              <th className="pb-2 pr-3 font-normal">Fill</th>
              <th className="pb-2 pr-3 font-normal">Manage</th>
              <th className="pb-2 pr-3 font-normal">Exit</th>
              <th className="pb-2 pr-3 font-normal">P&amp;L</th>
              <th className="pb-2 pr-3 font-normal">Capture</th>
              <th className="pb-2 font-normal">vs twin</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-4 text-xs" style={{ color: "var(--text-muted)" }}>
                  no live trades yet in this window — the pipeline fills as the wallet fires
                </td>
              </tr>
            ) : (
              view.rows.map((r) => <Row key={`${r.mint}-${r.openedAt.toISOString?.() ?? r.openedAt}`} r={r} />)
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
