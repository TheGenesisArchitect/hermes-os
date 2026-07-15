import type { CohortStat, FastLoss, IntelReport as IntelReportData, QualityTier } from "@/lib/queries";
import { usd } from "@/components/ui";

/**
 * Intel Report — the ML digest, in plain English. Everything here is computed
 * from the DB by the transparent factor model; there is NO black-box call. The
 * goal is to make the operator a subject-matter expert, so the report leans on
 * the two things that teach regardless of sample size — the FUNNEL (how the
 * engine narrows the market) and the METHODOLOGY (why entries are chosen the way
 * they are) — and it labels every performance number with its sample size, and
 * refuses to name a "pattern" from a bucket too small to mean anything.
 */

interface LiveRead {
  openPositions: number;
  floatNetUsd: number;
  greenCount: number;
  redCount: number;
}

const REGIMES: { key: string; color: string; means: string; does: string }[] = [
  { key: "IGNITION", color: "var(--status-good)", means: "first leg up, climbing", does: "RIDE — trail kept tight so a fast roll-over still exits green" },
  { key: "RUNNER", color: "var(--status-good)", means: "sustained higher-highs", does: "RIDE — trail widens to give a proven mover room" },
  { key: "BLOWOFF", color: "var(--series-1)", means: "parabolic, exhausting", does: "TRIM — snug the stop to bank near the top" },
  { key: "STALL", color: "var(--status-warning)", means: "rolled off the peak, cold", does: "CUT — the move is over" },
  { key: "FADE", color: "var(--status-critical)", means: "underwater and dying", does: "CUT — stop the bleed" },
  { key: "WATCH", color: "var(--text-muted)", means: "no decisive signal", does: "HOLD — let the mechanical trail run" },
];

function pct(n: number, d: number): string {
  if (d <= 0) return "—";
  return `${Math.round((100 * n) / d)}%`;
}

function Row({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t py-1.5 first:border-t-0" style={{ borderColor: "var(--gridline)" }}>
      <span className="text-xs" style={{ color: "var(--text-secondary)" }}>{label}</span>
      <span className="tabular text-sm font-semibold text-right" style={{ color: tone ?? "var(--text-primary)" }}>
        {value}
        {sub ? <span className="ml-1 text-xs font-normal" style={{ color: "var(--text-muted)" }}>{sub}</span> : null}
      </span>
    </div>
  );
}

/** A human read of the current state, assembled from real numbers (never canned). */
function bottomLine(r: IntelReportData, live: LiveRead): string {
  const { funnel, edge, performance } = r;
  const wr = edge.winnersTotal > 0 ? Math.round((100 * edge.winnersTriggered) / edge.winnersTotal) : null;
  const dr = edge.dudsTotal > 0 ? Math.round((100 * edge.dudsTriggered) / edge.dudsTotal) : null;

  const parts: string[] = [];
  parts.push(
    `In the last 24h the engine saw ${funnel.scanned24h} launches and passed ${funnel.safetyPassed24h} through the trap-only safety gate. ` +
      `Across the whole recorder dataset the confirmation scout has fired ${funnel.triggeredTotal} ⚡ entry triggers and we took ${funnel.enteredTotal} positions.`,
  );
  if (wr !== null && dr !== null && edge.winnersTotal >= 4 && edge.dudsTotal >= 4) {
    parts.push(
      `The gate is doing its job: it fired on ${wr}% of the ${edge.winnersTotal} candidates that went on to 2×+ but only ${dr}% of the ${edge.dudsTotal} that didn't — that separation is the entire edge.`,
    );
  } else {
    parts.push(
      `Not enough labeled outcomes yet to quote a live win/dud fire-rate (${edge.winnersTotal} winners / ${edge.dudsTotal} duds so far) — the ${edge.winnersTotal + edge.dudsTotal < 8 ? "calibration prior stands (fired on 88% of winners vs 40% of duds in replay)" : "sample is still thin"}.`,
    );
  }
  if (performance.closedTrades >= 8) {
    parts.push(
      `On ${performance.closedTrades} closed trades we're ${pct(performance.wins, performance.closedTrades)} green for ${performance.realizedPnlUsd >= 0 ? "+" : ""}${usd(performance.realizedPnlUsd)} realized — still a small sample, read it as a signal not a verdict.`,
    );
  } else {
    parts.push(
      `Only ${performance.closedTrades} trades have closed — far too few to judge expectancy. Watch the funnel and the confirmation separation; the P&L will follow once the sample is real.`,
    );
  }
  if (live.openPositions > 0) {
    parts.push(
      `Right now ${live.openPositions} position${live.openPositions === 1 ? " is" : "s are"} open with ${live.floatNetUsd >= 0 ? "+" : ""}${usd(live.floatNetUsd)} of realizable (post-slippage) float — ${live.greenCount} green, ${live.redCount} red.`,
    );
  }
  return parts.join(" ");
}

const FAST_LOSS_META: Record<FastLoss["classification"], { label: string; color: string; blurb: string }> = {
  phantom_divergence: {
    label: "REGRESSION",
    color: "var(--status-critical)",
    blurb: "a feed divergence was present at entry — the skip-on-divergence guard let a phantom through. Investigate now.",
  },
  real_rug: {
    label: "real rug",
    color: "var(--status-warning)",
    blurb: "recorder independently labeled this a rug — a genuine atomic LP-pull, not a bug. Entry-selection problem, not an execution one.",
  },
  review: {
    label: "review",
    color: "var(--series-1)",
    blurb: "died fast but the recorder hasn't corroborated a rug — eyeball the tick history.",
  },
};

/**
 * Fast-loss tripwire — the regression detector the phantom-loss fix left behind.
 * Post-fix, a <5s / >50%-loss close should only ever be a real rug; a
 * "phantom_divergence" row means the guard failed and needs immediate eyes.
 */
function FastLossTriage({ rows }: { rows: FastLoss[] }) {
  const regressions = rows.filter((r) => r.classification === "phantom_divergence").length;
  return (
    <div className="mt-5 border-t pt-4" style={{ borderColor: "var(--gridline)" }}>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
          Fast-loss triage · &lt;5s held, &gt;50% loss · last 24h
        </span>
        <span className="text-xs" style={{ color: regressions > 0 ? "var(--status-critical)" : "var(--text-muted)" }}>
          {regressions > 0 ? `⚠ ${regressions} regression${regressions === 1 ? "" : "s"}` : `${rows.length} flagged`}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs italic" style={{ color: "var(--status-good)" }}>
          Clean — no position has died inside 5 seconds for a &gt;50% loss. The skip-on-divergence guard is holding; any future
          hit lands here tagged as a real rug or a regression.
        </p>
      ) : (
        <div className="space-y-1">
          {rows.map((r) => {
            const meta = FAST_LOSS_META[r.classification];
            return (
              <div key={`${r.mint}-${r.openedAt}`} className="flex items-baseline justify-between gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate" style={{ color: "var(--text-primary)" }}>
                  <span className="font-semibold uppercase" style={{ color: meta.color }}>{meta.label}</span>
                  <span className="ml-2" style={{ color: "var(--text-secondary)" }}>{r.symbol ?? "?"}</span>
                  <span className="ml-1" style={{ color: "var(--text-muted)" }}>{r.mint.slice(0, 4)}…</span>
                </span>
                <span className="tabular shrink-0" style={{ color: "var(--text-muted)" }}>
                  {r.heldSeconds.toFixed(0)}s · {Math.round(r.lossPct * 100)}% ·{" "}
                  <span style={{ color: "var(--status-critical)" }}>{usd(r.pnlUsd)}</span>
                  {r.exitReason ? <span className="ml-1">· {r.exitReason}</span> : null}
                </span>
              </div>
            );
          })}
          <p className="mt-1.5 text-xs" style={{ color: "var(--text-muted)" }}>
            {regressions > 0 ? (
              <span style={{ color: "var(--status-critical)" }}>{FAST_LOSS_META.phantom_divergence.blurb}</span>
            ) : (
              <span>Real rugs are an entry-selection problem, not execution — they inform the entry filter, not a bug hunt.</span>
            )}
          </p>
        </div>
      )}
    </div>
  );
}

const QUALITY_LABEL: Record<QualityTier["tier"], { label: string; desc: string }> = {
  full: { label: "FULL", desc: "buys ≥ 80% at confirm — full conviction" },
  reduced: { label: "×0.6", desc: "buys < 80% at confirm — demand fading, bet shrunk" },
};

/**
 * Confirm-quality sizing scoreboard — the live A/B the sizing rule runs on
 * itself. The hard-stop class confirms with fading buy-share (med 0.765 vs
 * 0.925 green), so those entries get 0.6× size instead of a veto (a hard gate
 * costs ~30% of total EV). This panel answers: does the reduced tier actually
 * underperform live? If it doesn't, the knob loosens; if it craters, tighten.
 */
function QualitySizing({ tiers }: { tiers: QualityTier[] }) {
  return (
    <div className="mt-5 border-t pt-4" style={{ borderColor: "var(--gridline)" }}>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
          Confirm-quality sizing · buy-share at entry → bet size
        </span>
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>
          {tiers.reduce((s, t) => s + t.openN, 0)} open · {tiers.reduce((s, t) => s + t.closedN, 0)} closed
        </span>
      </div>
      {tiers.length === 0 ? (
        <p className="text-xs italic" style={{ color: "var(--text-muted)" }}>
          Live from this run&apos;s first confirmed entry — every position opens tagged full-size
          (buys ≥ 80% at confirm) or reduced (×0.6, demand fading). Win rates per tier land here.
        </p>
      ) : (
        <div className="space-y-1">
          {tiers.map((t) => {
            const meta = QUALITY_LABEL[t.tier];
            return (
              <div key={t.tier} className="flex items-baseline justify-between gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate" style={{ color: "var(--text-primary)" }}>
                  <span className="font-semibold" style={{ color: t.tier === "full" ? "var(--status-good)" : "var(--status-warning)" }}>
                    {meta.label}
                  </span>
                  <span className="ml-2" style={{ color: "var(--text-muted)" }}>{meta.desc}</span>
                </span>
                <span className="tabular shrink-0" style={{ color: "var(--text-muted)" }}>
                  {t.openN > 0 ? `${t.openN} open · ` : ""}
                  {t.closedN > 0 ? (
                    <>
                      {t.wins}/{t.closedN} ({pct(t.wins, t.closedN)}) ·{" "}
                      <span style={{ color: t.netPnlUsd >= 0 ? "var(--status-good)" : "var(--status-critical)" }}>
                        {t.netPnlUsd >= 0 ? "+" : ""}
                        {usd(t.netPnlUsd, 0)}
                      </span>
                    </>
                  ) : (
                    "no closes yet"
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Cohorts({ title, note, stats, minN, showPnl }: { title: string; note: string; stats: CohortStat[]; minN: number; showPnl: boolean }) {
  const meaningful = stats.filter((s) => s.trades >= minN);
  const thin = stats.filter((s) => s.trades < minN);
  return (
    <div>
      <div className="mb-1 text-xs font-medium" style={{ color: "var(--text-secondary)" }}>{title}</div>
      <p className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>{note}</p>
      {meaningful.length === 0 ? (
        <p className="text-xs italic" style={{ color: "var(--text-muted)" }}>
          Not enough data yet — no venue has reached {minN} closed trades. Numbers below this bar are noise, so we don&apos;t name a &quot;best&quot; anything.
        </p>
      ) : (
        <div className="space-y-1">
          {meaningful.map((s) => (
            <div key={s.key} className="flex items-baseline justify-between gap-2 text-xs">
              <span style={{ color: "var(--text-primary)" }}>{s.key}</span>
              <span className="tabular" style={{ color: "var(--text-muted)" }}>
                {s.wins}/{s.trades} ({pct(s.wins, s.trades)})
                {showPnl ? <span className="ml-2" style={{ color: s.pnl >= 0 ? "var(--status-good)" : "var(--status-critical)" }}>{s.pnl >= 0 ? "+" : ""}{usd(s.pnl, 0)}</span> : null}
              </span>
            </div>
          ))}
        </div>
      )}
      {thin.length > 0 ? (
        <p className="mt-1.5 text-xs" style={{ color: "var(--text-muted)" }}>
          Below the bar ({minN} trades): {thin.map((s) => `${s.key} (${s.trades})`).join(", ")} — tracked, not yet trusted.
        </p>
      ) : null}
    </div>
  );
}

export function IntelReport({ report, live }: { report: IntelReportData; live: LiveRead }) {
  const { funnel, edge, performance, cohorts, fastLossTriage, qualityTiers } = report;
  const wr = edge.winnersTotal > 0 ? (100 * edge.winnersTriggered) / edge.winnersTotal : null;
  const dr = edge.dudsTotal > 0 ? (100 * edge.dudsTriggered) / edge.dudsTotal : null;
  const sep = wr !== null && dr !== null && dr > 0 ? wr / dr : null;

  return (
    <section className="card p-4">
      <div className="mb-1 flex items-baseline justify-between">
        <h2 className="text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
          Intel Report · what the engine is doing
        </h2>
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>
          computed from the data · no black box
        </span>
      </div>

      {/* Bottom line first — the digest */}
      <p className="mb-4 text-sm leading-relaxed" style={{ color: "var(--text-primary)" }}>
        {bottomLine(report, live)}
      </p>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* The funnel — robust counts, teaches how the market is narrowed */}
        <div>
          <div className="mb-2 text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
            The funnel · how the market narrows (24h, except trigger/entered = dataset)
          </div>
          <Row label="Launches scanned" value={String(funnel.scanned24h)} />
          <Row
            label="Passed safety (trap-only gate)"
            value={String(funnel.safetyPassed24h)}
            sub={funnel.scanned24h > 0 ? pct(funnel.safetyPassed24h, funnel.scanned24h) : undefined}
          />
          <Row
            label="⚡ Confirmed by scout"
            value={String(funnel.triggeredTotal)}
            tone="var(--series-1)"
          />
          <Row label="Positions taken" value={String(funnel.enteredTotal)} />
          <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
            Each row is a stricter bar. Safety only blocks traps (honeypot / live mint or freeze /
            confirmed rug); soft flags shrink size instead of vetoing. The scout is what turns
            &quot;safe&quot; into &quot;confirmed demand&quot; before any capital moves.
          </p>
        </div>

        {/* The edge — methodology, n-independent + live fire rate with n */}
        <div>
          <div className="mb-2 text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
            The edge · why we enter when we do
          </div>
          <p className="mb-2 text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
            At t=0 winners and duds look identical — the early continuation score saturates near 99
            for both, so entering blind is a coin flip. What separates them is <span style={{ color: "var(--text-secondary)" }}>microstructure</span>:
            being green and holding near the highs on real buy-flow. The scout waits for that
            confirmation (≥1.25× vs ref, ≤10% off peak, ≥60% buys, 2–12 min in) before it fires.
          </p>
          <Row
            label="Fired on winners"
            value={`${edge.winnersTriggered}/${edge.winnersTotal}`}
            sub={wr === null ? "n=0" : pct(edge.winnersTriggered, edge.winnersTotal)}
            tone="var(--status-good)"
          />
          <Row
            label="Fired on duds + rugs"
            value={`${edge.dudsTriggered}/${edge.dudsTotal}`}
            sub={dr === null ? "n=0" : pct(edge.dudsTriggered, edge.dudsTotal)}
          />
          <Row
            label="Separation"
            value={sep === null ? "—" : `${sep.toFixed(1)}:1`}
            sub={edge.winnersTotal + edge.dudsTotal < 8 ? "prior 2.2:1" : "live"}
            tone={sep !== null && sep >= 2 ? "var(--status-good)" : "var(--text-secondary)"}
          />
          <p className="mt-2 text-xs italic" style={{ color: "var(--text-muted)" }}>
            {edge.winnersTotal + edge.dudsTotal < 8
              ? "Live sample still thin — this is the replay-calibrated prior (n=24 winners), not a fit. It will re-validate as outcomes land."
              : "Now computed from live labeled outcomes, not just the prior."}
          </p>
        </div>
      </div>

      {/* Fast-loss tripwire — regression detector behind the phantom-loss fix */}
      <FastLossTriage rows={fastLossTriage} />

      <QualitySizing tiers={qualityTiers} />

      {/* Regime glossary — pure education, sample-size-independent */}
      <div className="mt-5 border-t pt-4" style={{ borderColor: "var(--gridline)" }}>
        <div className="mb-2 text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
          Reading the classifier · what each regime means and does
        </div>
        <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
          {REGIMES.map((r) => (
            <div key={r.key} className="flex items-baseline gap-2 text-xs">
              <span className="w-16 shrink-0 font-semibold" style={{ color: r.color }}>{r.key}</span>
              <span style={{ color: "var(--text-muted)" }}>
                <span style={{ color: "var(--text-secondary)" }}>{r.means}</span> → {r.does}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Cohort intelligence — n-inline, suppressed below the bar */}
      <div className="mt-5 grid gap-5 border-t pt-4 lg:grid-cols-2" style={{ borderColor: "var(--gridline)" }}>
        <Cohorts
          title="By venue · closed trades"
          note="Win rate and realized P&L per DEX, once a venue has enough closed trades to mean something."
          stats={cohorts.byVenue}
          minN={cohorts.minN}
          showPnl
        />
        <div>
          <Cohorts
            title="By time-to-confirm"
            note="How long after first-seen the gate fired, in three bands. Win = the recorder later labeled it a winner — so this reads whether a fast or a late confirmation converts better (the CONFIRM_*_WATCH_MIN lever)."
            stats={cohorts.byRegime}
            minN={cohorts.minN}
            showPnl={false}
          />
          <div className="mt-4 border-t pt-3" style={{ borderColor: "var(--gridline)" }}>
            <div className="mb-1 text-xs font-medium" style={{ color: "var(--text-secondary)" }}>Realized performance</div>
            {performance.closedTrades === 0 ? (
              <p className="text-xs italic" style={{ color: "var(--text-muted)" }}>No closed trades yet.</p>
            ) : (
              <>
                <Row label="Closed trades" value={String(performance.closedTrades)} sub={`${pct(performance.wins, performance.closedTrades)} green`} />
                <Row label="Realized P&L" value={`${performance.realizedPnlUsd >= 0 ? "+" : ""}${usd(performance.realizedPnlUsd)}`} tone={performance.realizedPnlUsd >= 0 ? "var(--status-good)" : "var(--status-critical)"} />
                <Row label="Avg win / loss" value={`${performance.avgWinUsd === null ? "—" : "+" + usd(performance.avgWinUsd)} / ${performance.avgLossUsd === null ? "—" : usd(performance.avgLossUsd)}`} />
                {performance.closedTrades < 8 ? (
                  <p className="mt-1.5 text-xs italic" style={{ color: "var(--status-warning)" }}>
                    n={performance.closedTrades} — too small to judge expectancy. Preliminary.
                  </p>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
