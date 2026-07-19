// INVESTOR CURVE — the three-layer performance story, honest by construction:
//   ① measured edge (validated models) → ② proven at scale (paper) → ③ executing
//   with real capital (live wallet, hard caps). Paper is framed as strategy
//   validation, never as realized cash. Populates live through the trading day.
import { EquityChart } from "@/components/EquityChart";
import type { InvestorCurve as IC } from "@/lib/queries";

const usd = (v: number | null, d = 2) => (v === null ? "—" : `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(d)}`);

function Stat({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="rounded-lg p-4" style={{ background: "var(--surface-1)", border: "1px solid var(--gridline)" }}>
      <div className="text-[11px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>{label}</div>
      <div className="tabular mt-1 text-2xl font-semibold" style={{ color: accent ?? "var(--text-primary)" }}>{value}</div>
      {sub ? <div className="mt-0.5 text-[11px]" style={{ color: "var(--text-muted)" }}>{sub}</div> : null}
    </div>
  );
}

export function InvestorCurve({ data }: { data: IC }) {
  const { live, paper, models } = data;
  const liveDelta = live.currentEquity !== null && live.baselineUsd !== null ? live.currentEquity - live.baselineUsd : null;
  const liveGood = (live.realizedUsd ?? 0) >= 0;

  return (
    <div className="mx-auto max-w-5xl px-6 py-10" style={{ color: "var(--text-secondary)" }}>
      {/* Thesis */}
      <header className="mb-8">
        <div className="text-[11px] uppercase tracking-[0.2em]" style={{ color: "var(--series-1)" }}>Hermes OS · Live Performance</div>
        <h1 className="mt-2 text-3xl font-semibold" style={{ color: "var(--text-primary)", textWrap: "balance" as never }}>
          A measured edge, proven at scale, executing with real capital.
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed" style={{ color: "var(--text-muted)" }}>
          Three layers, each independently verifiable: a statistically-validated edge from the wallet-reputation graph and
          venue map, proven across thousands of paper trades, now executing on a live hot wallet under hard, code-enforced
          risk caps.
        </p>
      </header>

      {/* ③ LIVE — the hero */}
      <section className="mb-10">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: "var(--text-primary)" }}>
            <span style={{ color: "var(--status-good)" }}>●</span> Live wallet · real capital
          </h2>
          <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>hard caps: −$24 daily · −$36 kill · premium + wallet-graph + regime gates</span>
        </div>
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Equity now" value={usd(live.currentEquity)} sub={live.baselineUsd !== null ? `from ${usd(live.baselineUsd)} inception` : undefined} />
          <Stat label="Realized P&L" value={`${live.realizedUsd >= 0 ? "+" : ""}${usd(live.realizedUsd)}`} accent={liveGood ? "var(--status-good)" : "var(--status-critical)"} sub={`${live.closes} closes`} />
          <Stat label="Win rate" value={live.winRatePct === null ? "—" : `${live.winRatePct.toFixed(0)}%`} sub="real fills" />
          <Stat label="Open now" value={String(live.openPositions)} sub="marked to market" />
        </div>
        {live.series.length > 1 ? (
          <div className="rounded-lg p-2" style={{ background: "var(--surface-0, var(--page))", border: "1px solid var(--border)" }}>
            <EquityChart data={live.series} bankroll={live.baselineUsd ?? live.series[0]!.equity} />
          </div>
        ) : (
          <div className="rounded-lg px-4 py-10 text-center text-sm" style={{ background: "var(--surface-1)", border: "1px solid var(--gridline)", color: "var(--text-muted)" }}>
            Live equity curve populates as trades close through the session.
          </div>
        )}
      </section>

      {/* ② PAPER — proven at scale */}
      <section className="mb-10">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide" style={{ color: "var(--text-primary)" }}>
            <span style={{ color: "var(--series-1)" }}>●</span> Paper book · strategy validation at scale
          </h2>
          <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>simulated fills — statistical proof of edge, not realized cash</span>
        </div>
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3">
          <Stat label="Realized (sim)" value={`${paper.realizedUsd >= 0 ? "+" : ""}${usd(paper.realizedUsd, 0)}`} accent={paper.realizedUsd >= 0 ? "var(--status-good)" : "var(--status-critical)"} />
          <Stat label="Closed trades" value={paper.closes.toLocaleString()} sub="large-sample credibility" />
          <Stat label="Win rate" value={`${paper.winRatePct.toFixed(0)}%`} sub="convex: low hit, big winners" />
        </div>
        {paper.series.length > 1 ? (
          <div className="rounded-lg p-2" style={{ background: "var(--surface-0, var(--page))", border: "1px solid var(--border)" }}>
            <EquityChart data={paper.series} bankroll={paper.bankroll} />
          </div>
        ) : null}
      </section>

      {/* ① MODELS — the measured edge */}
      <section className="mb-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide" style={{ color: "var(--text-primary)" }}>
          The measured edge · validated, leak-free
        </h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Wallet-graph lift" value={`${models.walletLiftX.toFixed(1)}×`} accent="var(--status-good)" sub={`${models.walletWithPct}% vs ${models.walletBasePct}% base win`} />
          <Stat label="Rug model" value={`AUC ${models.rugAuc.toFixed(2)}`} sub="fitted, held-out" />
          <Stat label="Venue selection" value={`${usd(models.premiumVenue.realized, 0)}`} accent="var(--status-good)" sub={`${models.premiumVenue.name} · cut ${models.bleederVenue.name} ${usd(models.bleederVenue.realized, 0)}`} />
          <Stat label="Smart-money graph" value={models.smartWallets.toLocaleString()} sub={`winner wallets · ${models.rugWallets.toLocaleString()} ruggers flagged`} />
        </div>
        <p className="mt-3 text-[11px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
          The wallet-graph lift is measured out-of-sample on strictly-future tokens (reputation built only from the past):
          a token whose holders include a proven winner-wallet wins {models.walletWithPct}% of the time vs {models.walletBasePct}%
          baseline. Every live entry is ranked by a conviction score fusing these signals; the best setups get priority and size.
        </p>
      </section>

      <footer className="border-t pt-4 text-[10px]" style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}>
        Generated {new Date(data.generatedAt).toLocaleString()} · Live figures are real on-chain fills under code-enforced caps.
        Paper figures are simulated for strategy validation and are not realized returns. Past performance does not guarantee
        future results; micro-cap trading carries substantial risk.
      </footer>
    </div>
  );
}
