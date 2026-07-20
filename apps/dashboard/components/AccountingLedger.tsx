"use client";

import { useMemo, useState } from "react";
import { SymbolMint, fmtTs, fmtTsFull, timeAgo, usd } from "@/components/ui";
import { TimeRangeChips, withinRange, type RangeKey } from "@/components/timeFilter";
import type { AccountingLedger as LedgerData, LedgerRow } from "@/lib/queries";

type SortKey = "closedAt" | "pnl" | "peakMultiple" | "sizeUsd" | "holdMinutes";
type Outcome = "all" | "win" | "loss";

const fmtMult = (m: number) => (m >= 10 ? m.toFixed(0) : m.toFixed(2)) + "×";
const hr = (h: number) => `${String(h).padStart(2, "0")}:00`;

const REASON_TONE: Record<string, string> = {
  take_profit_0: "var(--status-good)",
  take_profit_1: "var(--status-good)",
  take_profit_2: "var(--status-good)",
  manual_harvest: "var(--status-good)",
  basket_harvest: "var(--status-good)",
  profit_trail: "var(--series-1)",
  stale_lock: "var(--series-1)",
  stale_take: "var(--status-good)",
  hard_stop: "var(--status-warning)",
  dust_rug: "var(--status-critical)",
  slot_displaced: "var(--text-muted)",
  user_cut: "var(--status-warning)",
};

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs" style={{ color: "var(--text-muted)" }}>{label}</div>
      <div className="tabular truncate text-lg font-semibold" style={{ color: tone ?? "var(--text-primary)" }}>{value}</div>
      {sub ? <div className="truncate text-xs" style={{ color: "var(--text-muted)" }}>{sub}</div> : null}
    </div>
  );
}

/**
 * Accounting Ledger — the single reconciled truth for the trading book, plus a
 * forecaster computed from our own history. Replaces the old Closed Trades
 * panel: every row here is a closed position, the running balance column ties
 * to the equity curve, and the reconciliation strip proves positions ≡ fills.
 */
export function AccountingLedger({
  ledger,
  bankroll,
  floatNetUsd,
  session,
}: {
  ledger: LedgerData;
  bankroll: number;
  floatNetUsd: number;
  // Session sizing state — survive off-hours at reduced stakes, full size in
  // the moonshot window. Rendered so the operator always knows which mode the
  // trader is betting in right now.
  session?: { prime: boolean; mult: number };
}) {
  const { rows, recon, forecast } = ledger;
  const [query, setQuery] = useState("");
  const [outcome, setOutcome] = useState<Outcome>("all");
  const [range, setRange] = useState<RangeKey>("all");
  const [sortKey, setSortKey] = useState<SortKey>("closedAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const view = useMemo(() => {
    const now = Date.now();
    const q = query.trim().toLowerCase();
    const filtered = rows.filter((t) => {
      if (outcome === "win" && t.pnl <= 0) return false;
      if (outcome === "loss" && t.pnl > 0) return false;
      if (!withinRange(t.closedAt, range, now)) return false;
      if (q && !(t.symbol ?? "").toLowerCase().includes(q) && !t.mint.toLowerCase().includes(q)) return false;
      return true;
    });
    const dir = sortDir === "desc" ? -1 : 1;
    const val = (t: LedgerRow, k: SortKey): number => (k === "closedAt" ? new Date(t.closedAt ?? 0).getTime() : (t[k] as number));
    return filtered.sort((a, b) => {
      const av = val(a, sortKey);
      const bv = val(b, sortKey);
      return av === bv ? 0 : av < bv ? -dir : dir;
    });
  }, [rows, query, outcome, range, sortKey, sortDir]);

  const viewPnl = view.reduce((s, r) => s + r.pnl, 0);
  const viewSize = view.reduce((s, r) => s + r.sizeUsd, 0);
  const dryPowder = bankroll + recon.realizedTotal - recon.openCostBasis;
  const equityLive = bankroll + recon.realizedTotal + floatNetUsd;
  const reconOk = Math.abs(recon.gap) <= Math.max(5, recon.cashOutBuys * 0.01);
  const winPct = forecast.closedTrades > 0 ? (forecast.wins / forecast.closedTrades) * 100 : 0;

  const toggleSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSortKey(k);
      setSortDir("desc");
    }
  };
  const arrow = (k: SortKey) => (k === sortKey ? (sortDir === "desc" ? " ↓" : " ↑") : "");
  const th = (k: SortKey, label: string) => (
    <th className="cursor-pointer pb-2 pr-2 text-right font-normal" onClick={() => toggleSort(k)}>
      {label}
      {arrow(k)}
    </th>
  );
  const chip = (active: boolean) =>
    ({
      background: active ? "var(--series-1)" : "transparent",
      color: active ? "#fff" : "var(--text-muted)",
      border: `1px solid ${active ? "var(--series-1)" : "var(--gridline)"}`,
    }) as const;

  return (
    <section className="card p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
          Accounting ledger · paper wallet
        </h2>
        {/* Reconciliation — positions ≡ fills, proven live on every render */}
        <span className="text-xs" style={{ color: reconOk ? "var(--status-good)" : "var(--status-critical)" }} title={`sells ${usd(recon.cashInSells)} − buys ${usd(recon.cashOutBuys)} + deployed ${usd(recon.openCostBasis)} = realized ${usd(recon.realizedTotal)} (residual ${usd(recon.gap)})`}>
          {reconOk ? "✓ ledger reconciles" : `⚠ RECON GAP ${usd(recon.gap)}`}
          <span className="ml-1" style={{ color: "var(--text-muted)" }}>fills ≡ positions ± {usd(Math.abs(recon.gap))}</span>
        </span>
      </div>

      {/* PORTFOLIO — what the wallet is made of right now */}
      <div className="mb-3 grid grid-cols-2 gap-4 rounded-md p-3 md:grid-cols-4 lg:grid-cols-6" style={{ background: "var(--page)" }}>
        <Stat label="Equity · live" value={usd(equityLive)} sub={`start ${usd(bankroll, 0)}`} tone={equityLive >= bankroll ? "var(--status-good)" : "var(--status-critical)"} />
        <Stat label="Realized P&L" value={`${recon.realizedTotal >= 0 ? "+" : ""}${usd(recon.realizedTotal)}`} sub={`${forecast.closedTrades} closed · ${winPct.toFixed(0)}% win`} tone={recon.realizedTotal >= 0 ? "var(--status-good)" : "var(--status-critical)"} />
        <Stat label="Float" value={`${floatNetUsd >= 0 ? "+" : ""}${usd(floatNetUsd)}`} sub="realizable now" tone={floatNetUsd >= 0 ? "var(--status-good)" : "var(--status-critical)"} />
        <Stat label="Deployed" value={usd(recon.openCostBasis)} sub="cost basis in open positions" />
        <Stat label="Dry powder" value={usd(dryPowder)} sub="available to deploy" />
        <Stat label="Expectancy" value={forecast.expectancyUsd === null ? "—" : `${forecast.expectancyUsd >= 0 ? "+" : ""}${usd(forecast.expectancyUsd)}`} sub={`per trade · avg win ${forecast.avgWinUsd === null ? "—" : usd(forecast.avgWinUsd)} / loss ${forecast.avgLossUsd === null ? "—" : usd(forecast.avgLossUsd)}`} tone={(forecast.expectancyUsd ?? 0) >= 0 ? "var(--status-good)" : "var(--status-critical)"} />
      </div>

      {/* FORECASTER — projections from OUR history; run-rates, not promises */}
      <div className="mb-4 grid grid-cols-2 gap-4 rounded-md p-3 md:grid-cols-4" style={{ background: "var(--page)" }}>
        <Stat
          label="Run rate · last 6h"
          value={`${forecast.ratePerHour >= 0 ? "+" : ""}${usd(forecast.ratePerHour)}/hr`}
          sub={`${forecast.trades6h} closes · ${forecast.pnl6h >= 0 ? "+" : ""}${usd(forecast.pnl6h)} banked`}
          tone={forecast.ratePerHour >= 0 ? "var(--status-good)" : "var(--status-critical)"}
        />
        <Stat
          label="Projected · 24h"
          value={`${forecast.projectedDailyUsd >= 0 ? "+" : ""}$${Math.abs(forecast.projectedDailyUsd).toLocaleString()}`}
          sub="at current run rate"
          tone={forecast.projectedDailyUsd >= 0 ? "var(--status-good)" : "var(--status-critical)"}
        />
        <Stat
          label="Moonshot window"
          value={forecast.moonshotWindow ? `${hr(forecast.moonshotWindow.fromHour)}–${hr(forecast.moonshotWindow.toHour)} UTC` : "—"}
          sub={
            (forecast.moonshotWindow ? `${forecast.moonshotWindow.bigMovers} of the ≥3× movers land here` : "building history") +
            (session ? (session.prime ? " · session: PRIME, full size" : ` · session: off-hours ×${session.mult} size`) : "")
          }
          tone={session?.prime ? "var(--status-good)" : undefined}
        />
        <div className="min-w-0">
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>Top banked trades</div>
          {forecast.topWinners.length === 0 ? (
            <div className="text-sm" style={{ color: "var(--text-muted)" }}>—</div>
          ) : (
            <div className="space-y-0.5">
              {forecast.topWinners.map((w) => (
                <div key={w.mint} className="truncate text-xs">
                  <span style={{ color: "var(--text-primary)" }}>{w.symbol ?? "?"}</span>
                  <span className="tabular ml-1.5" style={{ color: "var(--status-good)" }}>+{usd(w.pnl)}</span>
                  <span className="tabular ml-1" style={{ color: "var(--text-muted)" }}>({fmtMult(w.peak)} pk)</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* LEDGER — every closed position, with the running balance that ties to the curve */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1">
            <button onClick={() => setOutcome("all")} className="rounded px-2 py-0.5 text-xs font-medium" style={chip(outcome === "all")}>All</button>
            <button onClick={() => setOutcome("win")} className="rounded px-2 py-0.5 text-xs font-medium" style={chip(outcome === "win")}>Wins</button>
            <button onClick={() => setOutcome("loss")} className="rounded px-2 py-0.5 text-xs font-medium" style={chip(outcome === "loss")}>Losses</button>
          </div>
          <TimeRangeChips value={range} onChange={setRange} />
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            {view.length} of {rows.length} · filtered P&L{" "}
            <span style={{ color: viewPnl >= 0 ? "var(--status-good)" : "var(--status-critical)" }}>
              {viewPnl >= 0 ? "+" : ""}
              {usd(viewPnl)}
            </span>{" "}
            on {usd(viewSize, 0)} traded
          </span>
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="symbol / mint…"
          className="rounded px-2 py-1 text-xs"
          style={{ background: "var(--surface-1)", color: "var(--text-secondary)", border: "1px solid var(--gridline)" }}
        />
      </div>
      {view.length === 0 ? (
        <p className="py-4 text-center text-sm" style={{ color: "var(--text-muted)" }}>
          No closed trades match.
        </p>
      ) : (
        <div className="max-h-[32rem] overflow-x-auto overflow-y-auto pr-3" style={{ scrollbarGutter: "stable" }}>
          <table className="w-full text-sm">
            <thead className="sticky top-0" style={{ background: "var(--surface-1)" }}>
              <tr className="text-left text-xs" style={{ color: "var(--text-muted)" }}>
                <th className="pb-2 pr-2 font-normal">Token</th>
                {th("sizeUsd", "Size")}
                {th("peakMultiple", "Peak")}
                <th className="pb-2 pr-2 text-right font-normal">Exit</th>
                {th("holdMinutes", "Hold")}
                <th className="pb-2 pr-2 font-normal">Reason</th>
                {th("pnl", "P&L")}
                <th className="pb-2 pr-2 text-right font-normal">Cum P&L</th>
                {th("closedAt", "Closed (UTC)")}
              </tr>
            </thead>
            <tbody>
              {view.map((t) => (
                <tr key={t.id} className="border-t" style={{ borderColor: "var(--gridline)" }}>
                  <td className="py-2 pr-2">
                    <SymbolMint symbol={t.symbol} mint={t.mint} />
                    {/* Size multiplier — show BOOSTS as well as shrinks. Showing only
                        <1 made the ledger read as if every position were penalised and
                        hid the pool-inflow boost entirely (Jabarkus sized ×1.50 → +$10.89
                        looked identical to an unsized entry). Rounded: the raw float
                        rendered as ×0.21599999999999997. */}
                    {t.qualityMult !== null && Math.abs(t.qualityMult - 1) > 0.005 ? (
                      <span
                        className="ml-1 text-xs"
                        style={{ color: t.qualityMult > 1 ? "var(--status-good)" : "var(--status-warning)" }}
                        title={t.qualityMult > 1 ? "sized UP on quality/inflow" : "quality-sized down"}
                      >
                        ×{t.qualityMult.toFixed(2)}
                      </span>
                    ) : null}
                  </td>
                  <td className="tabular py-2 pr-2 text-right text-xs" style={{ color: "var(--text-muted)" }}>
                    {usd(t.sizeUsd, 1)}
                  </td>
                  <td className="tabular py-2 pr-2 text-right" style={{ color: t.peakMultiple >= 2 ? "var(--status-good)" : "var(--text-secondary)" }}>
                    {fmtMult(t.peakMultiple)}
                  </td>
                  <td className="tabular py-2 pr-2 text-right" style={{ color: "var(--text-secondary)" }}>
                    {fmtMult(t.exitMultiple)}
                  </td>
                  <td className="tabular py-2 pr-2 text-right text-xs" style={{ color: "var(--text-muted)" }}>
                    {t.holdMinutes < 1 ? `${Math.round(t.holdMinutes * 60)}s` : `${t.holdMinutes.toFixed(0)}m`}
                  </td>
                  <td className="py-2 pr-2 text-xs">
                    <span style={{ color: REASON_TONE[t.exitReason ?? ""] ?? "var(--text-secondary)" }}>{t.exitReason ?? "—"}</span>
                  </td>
                  <td className="tabular py-2 pr-2 text-right" style={{ color: t.pnl > 0 ? "var(--status-good)" : "var(--status-critical)" }}>
                    {t.pnl >= 0 ? "+" : ""}
                    {usd(t.pnl)}
                  </td>
                  <td className="tabular py-2 pr-2 text-right text-xs" style={{ color: t.cumulativePnl >= 0 ? "var(--status-good)" : "var(--status-critical)" }}>
                    {t.cumulativePnl >= 0 ? "+" : ""}
                    {usd(t.cumulativePnl)}
                  </td>
                  <td
                    className="tabular py-2 text-right text-xs"
                    style={{ color: "var(--text-muted)" }}
                    title={t.closedAt ? `closed ${fmtTsFull(t.closedAt)} · ${timeAgo(t.closedAt)}\nopened ${fmtTsFull(t.openedAt)}` : "open"}
                  >
                    {fmtTs(t.closedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
