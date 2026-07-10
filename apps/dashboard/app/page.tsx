import { loadConfig } from "@hermes/core";
import { AutoRefresh } from "@/components/AutoRefresh";
import { EquityChart } from "@/components/EquityChart";
import { KillSwitch } from "@/components/KillSwitch";
import { MintLink, ScoreBadge, StatTile, timeAgo, usd } from "@/components/ui";
import {
  getEquitySeries,
  getKillSwitch,
  getOpenPositions,
  getRecentSignals,
  getRecentTrades,
  getStats,
} from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function Overview() {
  const cfg = loadConfig();
  const [series, stats, recentSignals, openPositions, trades, killSwitch] = await Promise.all([
    getEquitySeries(),
    getStats(),
    getRecentSignals(),
    getOpenPositions(),
    getRecentTrades(),
    getKillSwitch(),
  ]);

  const equity = stats.equity ?? cfg.PAPER_BANKROLL_USD;
  const pnlSinceStart = equity - cfg.PAPER_BANKROLL_USD;
  const chartData = series.map((p) => ({
    at: p.at.toISOString(),
    equity: Number(p.equity),
  }));

  return (
    <div className="space-y-6">
      <AutoRefresh />

      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Paper lane</h1>
        <KillSwitch engaged={killSwitch} />
      </div>

      {killSwitch ? (
        <div
          className="rounded-md px-4 py-2 text-sm font-medium"
          style={{ background: "rgba(208,59,59,0.15)", border: "1px solid var(--status-critical)" }}
        >
          ⛔ Kill switch engaged — the trader is not opening new positions. Open positions are
          still managed to exit.
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <StatTile
          label="Equity"
          value={usd(equity)}
          sub={stats.equityAt ? `as of ${timeAgo(stats.equityAt)}` : "no snapshots yet"}
        />
        <StatTile
          label="P&L since start"
          value={`${pnlSinceStart >= 0 ? "+" : ""}${usd(pnlSinceStart)}`}
          tone={pnlSinceStart > 0 ? "good" : pnlSinceStart < 0 ? "bad" : "neutral"}
          sub={`realized ${usd(stats.realizedPnl)}`}
        />
        <StatTile label="Open positions" value={String(stats.openPositions)} />
        <StatTile
          label="Closed trades"
          value={String(stats.closedTrades)}
          sub={stats.closedTrades > 0 ? `${stats.wins} wins` : undefined}
        />
        <StatTile label="Signals · 24h" value={String(stats.signals24h)} />
        <StatTile label="Scanned · 24h" value={String(stats.scanned24h)} />
      </div>

      <section className="card p-4">
        <h2 className="mb-2 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
          Equity — paper lane (start {usd(cfg.PAPER_BANKROLL_USD, 0)})
        </h2>
        <EquityChart data={chartData} bankroll={cfg.PAPER_BANKROLL_USD} />
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card p-4">
          <h2 className="mb-3 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
            Signal feed
          </h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs" style={{ color: "var(--text-muted)" }}>
                <th className="pb-2 font-normal">Token</th>
                <th className="pb-2 font-normal">Score</th>
                <th className="pb-2 font-normal">Liquidity</th>
                <th className="pb-2 font-normal">Status</th>
                <th className="pb-2 text-right font-normal">When</th>
              </tr>
            </thead>
            <tbody>
              {recentSignals.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-6 text-center" style={{ color: "var(--text-muted)" }}>
                    No signals yet — SCOUT inserts one for every launch that survives all four
                    safety checks.
                  </td>
                </tr>
              ) : (
                recentSignals.map((s) => (
                  <tr key={s.id} className="border-t" style={{ borderColor: "var(--gridline)" }}>
                    <td className="py-2">
                      <MintLink mint={s.mint} symbol={s.symbol} />
                    </td>
                    <td className="py-2">
                      <ScoreBadge score={Number(s.score)} />
                    </td>
                    <td className="tabular py-2" style={{ color: "var(--text-secondary)" }}>
                      {usd(s.liquidityUsd, 0)}
                    </td>
                    <td className="py-2 text-xs" style={{ color: "var(--text-secondary)" }}>
                      {s.status}
                    </td>
                    <td className="py-2 text-right text-xs" style={{ color: "var(--text-muted)" }}>
                      {timeAgo(s.createdAt)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>

        <div className="space-y-6">
          <section className="card p-4">
            <h2 className="mb-3 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
              Open positions
            </h2>
            {openPositions.length === 0 ? (
              <p className="py-4 text-center text-sm" style={{ color: "var(--text-muted)" }}>
                No open positions.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs" style={{ color: "var(--text-muted)" }}>
                    <th className="pb-2 font-normal">Token</th>
                    <th className="pb-2 font-normal">Size</th>
                    <th className="pb-2 font-normal">Entry</th>
                    <th className="pb-2 text-right font-normal">Age</th>
                  </tr>
                </thead>
                <tbody>
                  {openPositions.map((p) => (
                    <tr key={p.id} className="border-t" style={{ borderColor: "var(--gridline)" }}>
                      <td className="py-2">
                        <MintLink mint={p.mint} symbol={p.symbol} />
                      </td>
                      <td className="tabular py-2">{usd(p.sizeUsd, 0)}</td>
                      <td className="tabular py-2" style={{ color: "var(--text-secondary)" }}>
                        ${Number(p.entryPriceUsd).toPrecision(4)}
                      </td>
                      <td className="py-2 text-right text-xs" style={{ color: "var(--text-muted)" }}>
                        {timeAgo(p.openedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="card p-4">
            <h2 className="mb-3 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
              Recent fills
            </h2>
            {trades.length === 0 ? (
              <p className="py-4 text-center text-sm" style={{ color: "var(--text-muted)" }}>
                No fills yet.
              </p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {trades.map((t) => (
                    <tr key={t.id} className="border-t" style={{ borderColor: "var(--gridline)" }}>
                      <td className="py-2">
                        <span
                          className="mr-2 inline-block w-9 rounded px-1 text-center text-xs font-semibold"
                          style={{
                            background: t.side === "buy" ? "rgba(57,135,229,0.18)" : "rgba(255,255,255,0.06)",
                            color: t.side === "buy" ? "var(--series-1)" : "var(--text-secondary)",
                          }}
                        >
                          {t.side}
                        </span>
                        <MintLink mint={t.mint} symbol={t.symbol} />
                      </td>
                      <td className="tabular py-2" style={{ color: "var(--text-secondary)" }}>
                        ${Number(t.priceUsd).toPrecision(4)}
                      </td>
                      <td className="py-2 text-xs" style={{ color: "var(--text-muted)" }}>
                        {t.exitReason ?? ""}
                      </td>
                      <td className="py-2 text-right text-xs" style={{ color: "var(--text-muted)" }}>
                        {timeAgo(t.filledAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
