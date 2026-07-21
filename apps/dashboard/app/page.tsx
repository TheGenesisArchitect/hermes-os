import { loadConfig, harvestClock, type TradeDna } from "@hermes/core";
import { AccountingLedger } from "@/components/AccountingLedger";
import { HarvestClock } from "@/components/HarvestClock";
import { AutoRefresh } from "@/components/AutoRefresh";
import { ControlTerminal } from "@/components/ControlTerminal";
import { SignatureConsole } from "@/components/SignatureConsole";
import { EquityChart } from "@/components/EquityChart";
import { FillsTable } from "@/components/FillsTable";
import { HarvestButton } from "@/components/HarvestButton";
import { IntelReport } from "@/components/IntelReport";
import { IntelTerminal } from "@/components/IntelTerminal";
import { KillSwitch } from "@/components/KillSwitch";
import { ManagementBoard } from "@/components/ManagementBoard";
import { RecorderBoard } from "@/components/RecorderBoard";
import { PondRadar } from "@/components/PondRadar";
import { TickerRadar } from "@/components/TickerRadar";
import { InflowEdge } from "@/components/InflowEdge";
import { TradeLedger } from "@/components/TradeLedger";
import { SignalTicker } from "@/components/SignalTicker";
import { AnticipationForecast } from "@/components/AnticipationForecast";
import { WinningFormula } from "@/components/WinningFormula";
import { WalletDrawer } from "@/components/WalletDrawer";
import { LaneComparison } from "@/components/LaneComparison";
import { TimingGrid } from "@/components/TimingGrid";
import { MintLink, ScoreBadge, StatTile, fmtTs, fmtTsFull, timeAgo, usd } from "@/components/ui";
import {
  getAccountingLedger,
  getEdgeSeparation,
  getFillsSummary,
  getEdgeSeries,
  getEquitySeries,
  getForecast,
  getIntelReport,
  getKillSwitch,
  getControlTerminal,
  getSignatureConsole,
  getKpiStrip,
  getNews,
  getManagedPositions,
  getPondRadar,
  getTickerRadar,
  getTradeLedger,
  getLaneBalances,
  getInflowEdge,
  getAnticipation,
  getWinningFormula,
  getHourlyWindows,
  getWalletStatus,
  getLaneComparison,
  getWalletIntel,
  getTimingGrid,
  getRecentSignals,
  getRecentTrades,
  getRecorderOutcomes,
  getRecorderStats,
  getStats,
  getWatchingNow,
} from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function Overview() {
  const cfg = loadConfig();
  const [
    series,
    stats,
    recentSignals,
    managed,
    ledger,
    trades,
    fillsSummary,
    killSwitch,
    recorderStats,
    edgeSeparation,
    watching,
    recorderOutcomes,
    intel,
    kpis,
    edgeSeries,
    forecast,
    news,
    timingGrid,
    controlTerminal,
    signatureConsole,
    ponds,
    hourWindows,
    walletStatus,
    laneComparison,
    walletIntel,
    anticipation,
    winningFormula,
    tickerRadar,
    tradeLedger,
    laneBalances,
    inflowEdge,
  ] = await Promise.all([
    getEquitySeries(),
    getStats(),
    getRecentSignals(),
    getManagedPositions(),
    getAccountingLedger(),
    getRecentTrades(),
    getFillsSummary(),
    getKillSwitch(),
    getRecorderStats(),
    getEdgeSeparation(),
    getWatchingNow(),
    getRecorderOutcomes(),
    getIntelReport(),
    getKpiStrip(),
    getEdgeSeries(),
    getForecast(),
    getNews(),
    getTimingGrid(),
    getControlTerminal(),
    getSignatureConsole(),
    getPondRadar(),
    getHourlyWindows(),
    getWalletStatus(),
    getLaneComparison(),
    getWalletIntel(),
    getAnticipation(),
    getWinningFormula(),
    getTickerRadar(),
    getTradeLedger(),
    getLaneBalances(),
    getInflowEdge(),
  ]);

  const managedView = managed.map((p) => ({ ...p, openedAt: p.openedAt.toISOString() }));

  // Harvest clock — book-average moonshot clock across all open trades right now.
  const harvest = harvestClock(
    managed
      .map((p) => p.dna)
      .filter((d): d is NonNullable<typeof d> => d != null)
      .map((d) => ({ clockPct: d.clockPct, pastPrime: d.pastPrime })),
  );
  // mint→DNA map — reused by the Timing Grid (open bars) and Wallet matrix (live = paper twin).
  const dnaByMint: Record<string, TradeDna> = {};
  for (const p of managed) if (p.dna) dnaByMint[p.mint] = p.dna;

  // Live float read for the Intel Report — realizable (post-slippage) unrealized P&L.
  const greenPositions = managed.filter((p) => p.unrealizedNetUsd > 0);
  const liveRead = {
    openPositions: managed.length,
    floatNetUsd: managed.reduce((s, p) => s + p.unrealizedNetUsd, 0),
    greenCount: greenPositions.length,
    redCount: managed.filter((p) => p.unrealizedNetUsd <= 0).length,
  };
  const greenUsd = greenPositions.reduce((s, p) => s + p.unrealizedNetUsd, 0);
  // Harvest promises only what the trader's sweep can DELIVER this cycle: greens
  // whose latest read passed the sellability bar. A green on a dust-flip read is
  // shown as suspended, not silently counted (the "clicked 19, swept 2" gap).
  const sellableGreens = greenPositions.filter((p) => p.sellableNow);
  const sellableGreenUsd = sellableGreens.reduce((s, p) => s + p.unrealizedNetUsd, 0);
  const suspendedGreens = greenPositions.length - sellableGreens.length;

  // LIVE equity — realized P&L (ledger, always current) + realizable float
  // (marked this refresh, net of exit slippage/fees). The old read was the last
  // pnl_snapshot (~5min stale): the tile froze between snapshots while trades
  // closed live, which made the curve LOOK pinned at break-even. Snapshots now
  // only feed the chart; the headline number moves with every 10s refresh.
  const equity = cfg.PAPER_BANKROLL_USD + stats.realizedPnl + liveRead.floatNetUsd;
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

      {/* Scout tape — the signal FLOW as a marquee, freeing the page bottom for
          the trade ledger. Hover pauses it; every entry is clickable. */}
      <SignalTicker signals={recentSignals} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <StatTile
          label="Equity"
          value={usd(equity)}
          sub={`live · float ${liveRead.floatNetUsd >= 0 ? "+" : ""}${usd(liveRead.floatNetUsd)}`}
        />
        <StatTile
          label="P&L since start"
          value={`${pnlSinceStart >= 0 ? "+" : ""}${usd(pnlSinceStart)}`}
          tone={pnlSinceStart > 0 ? "good" : pnlSinceStart < 0 ? "bad" : "neutral"}
          sub={`realized ${usd(stats.realizedPnl)} · live`}
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

      {/* Timing grid — the live time×multiple field. Every trade a trajectory on
          the seconds floor, colored by rising/stalling/falling, against the TP
          rails and the DNA time-zones. The exit doctrine made watchable: floor
          set fast on the downside, ceiling left open on the upside. */}
      <section className="card p-4">
        <h2 className="mb-2 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
          Trade matrix — live positions, price locked in as they rise · click a bar to close
        </h2>
        <TimingGrid view={timingGrid} dnaByMint={dnaByMint} />
      </section>

      {/* Control terminal — the live trading desk. Every tunable exit/size knob
          the trader is running now, adjustable in real time. The adaptive policy
          reads the regime and recommends (ghost values); the operator's manual
          pins always win. Auto ships ADVISORY until a clean prime run gives the
          policy its favorable pole — see the one-pole caveat in overrides.ts. */}
      {/* The desk, reorganised around the five genomes. Exit geometry belongs to
          the signature now, so this sits ABOVE the control terminal — it is the
          surface that actually governs how a position is managed. */}
      <section className="card p-4">
        <SignatureConsole view={signatureConsole} />
      </section>

      <section className="card p-4">
        <h2 className="mb-2 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
          Control terminal — exposure &amp; regime · adaptive policy + manual override
        </h2>
        <ControlTerminal view={controlTerminal} />
      </section>

      {/* Intel Terminal — Bloomberg-style KPIs + edge trend in an on-demand drawer;
          the ML digest (IntelReport) rides inside as the full methodology detail.
          Keyless, computed from the data; makes the operator an SME on the market. */}
      <IntelTerminal
        kpis={kpis}
        edgeSeries={edgeSeries}
        forecast={forecast}
        newsHeadline={news.brief?.headline ?? null}
        newsTopTheme={news.themes[0]?.category ?? null}
      >
        <IntelReport report={intel} live={liveRead} />
      </IntelTerminal>

      {/* Position Command — the ride-vs-cut classifier, live and interactive */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h2 className="text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
              Position Command · ride vs cut
            </h2>
            <HarvestClock view={harvest} />
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              classifier {cfg.CLASSIFIER_ENABLED ? cfg.CLASSIFIER_MODE : "off"} · override any call
            </span>
            <HarvestButton greenCount={sellableGreens.length} greenUsd={sellableGreenUsd} suspendedCount={suspendedGreens} />
          </div>
        </div>
        <ManagementBoard positions={managedView} />
      </section>

      {/* The Recorder — the data flywheel. Watches every safety-passed candidate,
          entered or not, to build the labeled dataset that will fit the weights. */}
      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
            Recorder · the scout &amp; edge flywheel
          </h2>
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            {cfg.CONFIRM_ENTRY_ENABLED
              ? "fires ⚡ entry on confirmed demand — no blind t=0 commits"
              : "keyless · no capital · every candidate tracked for its first minutes"}
          </span>
        </div>
        <RecorderBoard
          stats={recorderStats}
          separation={edgeSeparation}
          watching={watching}
          outcomes={recorderOutcomes}
        />
      </section>

      {/* Winning Formula — real-time paper-vs-live per-trade divergence gauge */}
      <WinningFormula view={winningFormula} />

      {/* Live wallet + paper-vs-live divergence — the go-live command row */}
      <div className="grid gap-6 lg:grid-cols-2">
        <WalletDrawer wallet={walletStatus} dnaByMint={dnaByMint} />
        <LaneComparison cmp={laneComparison} />
      </div>

      {/* Anticipation Forecast — the forward-looking brain: when / where / tail odds */}
      <AnticipationForecast view={anticipation} />

      {/* Pond Radar — venue R&D lifecycle: discovery → watchlist → promotion */}
      {/* THE EDGE — pool inflow, re-measured from realized outcomes every refresh. */}
      <InflowEdge bands={inflowEdge} />
      <TickerRadar radar={tickerRadar} />
      <PondRadar ponds={ponds} hours={hourWindows} walletIntel={walletIntel} />

      {/* Accounting ledger — reconciled closed-trade truth + forecaster + portfolio */}
      <AccountingLedger
        ledger={ledger}
        bankroll={cfg.PAPER_BANKROLL_USD}
        floatNetUsd={liveRead.floatNetUsd}
        session={{ prime: cfg.PRIME_HOURS_UTC.has(new Date().getUTCHours()), mult: cfg.OFF_HOURS_SIZE_MULT }}
      />

      {/* Evidence & Value — one row per closed round trip: capital deployed,
          shares, entry/exit/peak, P&L, hold, and the on-chain tx hashes. Full
          width now that the signal feed lives in the header ticker. */}
      <TradeLedger trades={tradeLedger} balances={laneBalances} />

      {/* Raw fill stream — the per-fill audit trail behind the ledger above. */}
      <FillsTable trades={trades} summaryAll={fillsSummary} />
    </div>
  );
}
