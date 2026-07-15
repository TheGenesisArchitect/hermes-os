"use client";

import { RecorderDrawer } from "@/components/RecorderDrawer";
import { TrajectoryHeatmap } from "@/components/TrajectoryHeatmap";
import type {
  EdgeSeparation,
  RecorderOutcome,
  RecorderStats,
  WatchingCandidate,
} from "@/lib/queries";

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="card p-3">
      <div className="text-xs" style={{ color: "var(--text-muted)" }}>{label}</div>
      <div className="tabular mt-0.5 text-xl font-semibold" style={{ color: tone ?? "var(--text-primary)" }}>{value}</div>
      {sub ? <div className="text-xs" style={{ color: "var(--text-muted)" }}>{sub}</div> : null}
    </div>
  );
}

/** The headline: does early classifier score separate winners from duds? */
function SeparationReadout({ sep }: { sep: EdgeSeparation }) {
  const ready = sep.winnersN > 0 && sep.dudsN > 0;
  const gap = ready ? (sep.winnersMean ?? 0) - (sep.dudsMean ?? 0) : null;
  const verdict =
    gap === null
      ? "waiting for the first labeled winner and dud"
      : gap >= 10
        ? "early trajectory is separating winners from duds — this is the edge"
        : gap <= 2
          ? "no separation yet — the early score alone isn't predictive"
          : "faint separation — needs more data before it's real";
  return (
    <div className="card p-4">
      <div className="mb-1 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
        Edge readout · mean early classifier score (first 5 min)
      </div>
      <p className="mb-3 text-xs" style={{ color: "var(--text-muted)" }}>
        The whole question, in one line: if winners carry a higher early continuation score than duds,
        the trajectory we used to throw away holds a real signal — and the weight fit will find it.
      </p>
      <div className="flex items-end gap-6">
        <div>
          <div className="tabular text-2xl font-semibold" style={{ color: "var(--status-good)" }}>
            {sep.winnersMean === null ? "—" : sep.winnersMean.toFixed(0)}
          </div>
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>winners (n={sep.winnersN})</div>
        </div>
        <div className="pb-1 text-lg" style={{ color: "var(--text-muted)" }}>vs</div>
        <div>
          <div className="tabular text-2xl font-semibold" style={{ color: "var(--text-secondary)" }}>
            {sep.dudsMean === null ? "—" : sep.dudsMean.toFixed(0)}
          </div>
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>duds + rugs (n={sep.dudsN})</div>
        </div>
        {gap !== null ? (
          <div className="ml-auto pb-1 text-right">
            <div className="tabular text-xl font-semibold" style={{ color: gap >= 10 ? "var(--status-good)" : "var(--text-secondary)" }}>
              {gap >= 0 ? "+" : ""}{gap.toFixed(0)}
            </div>
            <div className="text-xs" style={{ color: "var(--text-muted)" }}>separation</div>
          </div>
        ) : null}
      </div>
      <p className="mt-3 text-xs italic" style={{ color: "var(--text-secondary)" }}>{verdict}</p>
    </div>
  );
}

export function RecorderBoard({
  stats,
  separation,
  watching,
  outcomes,
}: {
  stats: RecorderStats;
  separation: EdgeSeparation;
  watching: WatchingCandidate[];
  outcomes: RecorderOutcome[];
}) {
  const fitPct = Math.min(100, (stats.labeled / stats.fitTarget) * 100);

  return (
    <div className="space-y-4">
      {/* The definitional wall — this whole surface is MARKET OBSERVATIONS, not
          our trades. "Winner" here = a 2×+ move existed in the watch window,
          whether or not we were in it. Our actual trades and their P&L live in
          Position Command and Recent fills above. Conflating the two is the #1
          source of confusion, so we say it plainly. */}
      <div
        className="rounded-md px-3 py-2 text-xs leading-relaxed"
        style={{ background: "rgba(57,135,229,0.08)", border: "1px solid var(--gridline)", color: "var(--text-secondary)" }}
      >
        <span style={{ color: "var(--series-1)" }}>ℹ Reading this board:</span> these are the recorder&apos;s{" "}
        <span style={{ color: "var(--text-primary)" }}>market observations</span> — every safety-passed
        candidate it watched, <span style={{ color: "var(--text-primary)" }}>entered or not</span>. A{" "}
        <span style={{ color: "var(--status-good)" }}>&quot;winner&quot;</span> means a 2×+ move existed in its
        15-min window, <span style={{ color: "var(--text-primary)" }}>not that we traded it</span>. Our
        actual positions and P&amp;L are in <span style={{ color: "var(--text-primary)" }}>Position Command</span> and{" "}
        <span style={{ color: "var(--text-primary)" }}>Recent fills</span> above. This is the training set that
        teaches the scout what to enter.
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="Candidates watched" value={String(stats.total)} sub={`${stats.totalTicks} ticks`} />
        <Stat label="Watching now" value={String(stats.watching)} tone="var(--series-1)" />
        <Stat label="2×+ winners" value={String(stats.winners)} tone="var(--status-good)" sub="market moves, not trades" />
        <Stat label="Duds" value={String(stats.duds)} sub="stayed flat/faded" />
        <Stat label="Confirmed ⚡" value={String(stats.triggered)} tone="var(--series-1)" sub="scout fired entry" />
        <Stat label="We entered" value={String(stats.entered)} sub="took a position" />
      </div>

      {/* readiness toward a weight fit */}
      <div className="card p-3">
        <div className="mb-1.5 flex items-baseline justify-between text-xs">
          <span style={{ color: "var(--text-secondary)" }}>Dataset toward first weight fit</span>
          <span className="tabular" style={{ color: "var(--text-muted)" }}>
            {stats.labeled} / {stats.fitTarget} labeled
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full" style={{ background: "var(--gridline)" }}>
          <div className="h-full rounded-full" style={{ width: `${fitPct}%`, background: "var(--series-1)" }} />
        </div>
      </div>

      <SeparationReadout sep={separation} />

      {/* live watch feed — dynamic heatmap, best performers on top */}
      <TrajectoryHeatmap watching={watching} />

      {/* best performers — LIVE candidates merged with labeled outcomes; the same
          armed/entered truth the trader acts on, plus the capture-rate readout */}
      <RecorderDrawer outcomes={outcomes} watching={watching} />
    </div>
  );
}
