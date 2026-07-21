import type { LaneScorecard as View, LaneScoreRow } from "@/lib/queries";

// LANE SCORECARD — the same signatures, scored separately for paper and live.
//
// Live trades its OWN signals now rather than mirroring paper, so the two lanes
// see the same candidates and can legitimately diverge on fills, slippage and
// timing. That divergence is the single most useful number on the dashboard —
// it is the answer to "does the edge survive real execution" — and blending the
// lanes into one figure would bury it. Every row is paper beside live, never
// summed.

const money = (v: number) => `${v < 0 ? "−" : "+"}$${Math.abs(v).toFixed(2)}`;
const pretty = (s: string) => s.replace("MOON_", "MOON ").toLowerCase();

const TONE: Record<string, string> = {
  RISER: "var(--series-1)",
  BASE: "var(--series-2)",
  CLIMBER: "var(--series-3)",
  MOON_FAST: "var(--status-warning)",
  MOON_STEADY: "var(--status-warning)",
  MOON_SLOW: "var(--text-muted)",
  MOON_VIOLENT: "var(--status-danger)",
};

/** LIVE PILL — unmissable state of the real-capital lane. */
export function LivePill({ enabled, n }: { enabled: boolean; n: number }) {
  const on = enabled;
  return (
    <span
      title={on ? "Live lane is ARMED — real capital is at risk" : "Live lane is disabled — paper only"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "2px 9px",
        borderRadius: 999,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: ".08em",
        textTransform: "uppercase",
        color: on ? "var(--status-danger)" : "var(--text-muted)",
        border: `1px solid ${on ? "var(--status-danger)" : "var(--border)"}`,
        background: on ? "color-mix(in srgb, var(--status-danger) 12%, transparent)" : "transparent",
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: on ? "var(--status-danger)" : "var(--text-muted)",
          boxShadow: on ? "0 0 6px var(--status-danger)" : "none",
        }}
      />
      {on ? `LIVE ARMED${n > 0 ? ` · ${n}` : ""}` : "LIVE OFF"}
    </span>
  );
}

function Cell({ s, dim }: { s: LaneScoreRow["paper"]; dim?: boolean }) {
  if (s.n === 0) return <td style={{ textAlign: "right", color: "var(--text-muted)", opacity: dim ? 0.5 : 1 }}>—</td>;
  return (
    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", opacity: dim ? 0.6 : 1 }}>
      <span style={{ color: s.pnl >= 0 ? "var(--status-ok)" : "var(--status-danger)" }}>{money(s.pnl)}</span>
      <span style={{ color: "var(--text-muted)", fontSize: 10 }}>
        {" "}
        {s.n}t · {s.winPct.toFixed(0)}% · {s.ev.toFixed(2)}×
      </span>
    </td>
  );
}

export function LaneScorecard({ view }: { view: View }) {
  const { rows, totals, windowHours, liveEnabled } = view;
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h2 style={{ margin: 0, fontSize: 15 }}>Lane Scorecard</h2>
          <LivePill enabled={liveEnabled} n={totals.live.n} />
        </div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
          paper {money(totals.paper.pnl)} · {totals.paper.n}t · {totals.paper.ev.toFixed(3)}×
          <br />
          live {money(totals.live.pnl)} · {totals.live.n}t · {totals.live.ev.toFixed(3)}×
          <br />
          last {windowHours}h
        </div>
      </header>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ color: "var(--text-muted)", fontSize: 10, textTransform: "uppercase", letterSpacing: ".08em" }}>
              <th style={{ textAlign: "left", padding: "4px 6px" }}>Signature</th>
              <th style={{ textAlign: "right", padding: "4px 6px" }}>Paper</th>
              <th style={{ textAlign: "right", padding: "4px 6px" }}>Live</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.signature}>
                <td style={{ padding: "4px 6px", whiteSpace: "nowrap", color: TONE[r.signature] ?? "var(--text-muted)", fontWeight: 600 }}>
                  {pretty(r.signature)}
                </td>
                <Cell s={r.paper} />
                {/* Live is dimmed when the lane is off, so an empty column reads as
                    "not trading" rather than "traded and made nothing". */}
                <Cell s={r.live} dim={!liveEnabled} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p style={{ margin: 0, fontSize: 10, color: "var(--text-muted)" }}>
        Each row is <strong>paper beside live, never summed</strong>. Both lanes trade the same signatures on the same
        signals with the same rules — the gap between the columns is execution, not strategy, and it is the number that
        decides whether the edge survives real capital. Format: P&amp;L · trades · win% · EV per $.
      </p>
    </section>
  );
}
