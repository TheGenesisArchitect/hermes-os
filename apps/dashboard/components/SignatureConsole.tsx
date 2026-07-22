import type { SignatureConsoleView, SignatureRow } from "@/lib/queries";

// SIGNATURE CONSOLE 2.0 (GR-HERMES-SIGCON-SPEC-001) — the desk that answers:
// which classes deserve capital right now, at what size, at what expected
// capture — and is live executing them at forecast-grade drag?
//
// v1's spine survives: each row pairs the class RULE (geometry) with its
// RESULT (EV/$). v2 adds the five KPI groups from the spec — REGIME, SIGNAL,
// ADMISSION, EXECUTION, MONEY — and a per-class drawer (<details>, no client
// JS) holding the last trades and the last live refusals with their reasons,
// so a miss like Li (5.25× smart-money runner refused on a stale regime read)
// is reconstructable from this one surface.

const TONE: Record<string, string> = {
  RISER: "var(--series-1)",
  BASE: "var(--series-2)",
  CLIMBER: "var(--series-3)",
  MOON_FAST: "var(--status-warning)",
  MOON_STEADY: "var(--status-warning)",
  MOON_SLOW: "var(--text-muted)",
  MOON_VIOLENT: "var(--status-danger)",
  RUG_RISK: "var(--status-danger)",
};

const pct = (v: number) => `${v.toFixed(0)}%`;
const mult = (v: number) => `${v.toFixed(2)}×`;
const money = (v: number) => `${v < 0 ? "−" : ""}$${Math.abs(v).toFixed(2)}`;
const tab = { fontVariantNumeric: "tabular-nums" } as const;

function Geometry({ r }: { r: SignatureRow }) {
  if (!r.trade) return <span style={{ color: "var(--status-danger)" }}>refused — never opens</span>;
  return (
    <span style={tab}>
      cover {mult(r.floor)} · trail {pct(r.trail * 100)} · TP {mult(r.tp1[0])}@{pct(r.tp1[1] * 100)} /{" "}
      {mult(r.tp2[0])}@{pct(r.tp2[1] * 100)}
      {r.holdSec > 0 ? ` · clock ${Math.round(r.holdSec / 60)}m` : ""} · snap ≥{pct(r.minSnap * 100)}
    </span>
  );
}

function RegimeChip({ r }: { r: SignatureRow }) {
  const k = r.kpi.regime;
  const color = k.status === "ACTIVE" ? "var(--status-ok)" : k.status === "PRIOR" ? "var(--status-warning)" : "var(--status-danger)";
  return (
    <span title={k.why} style={{ color, border: "1px solid currentColor", borderRadius: 3, padding: "0 4px", fontSize: 9, fontWeight: 600 }}>
      {k.status}
    </span>
  );
}

function Row({ r }: { r: SignatureRow }) {
  const tone = TONE[r.signature] ?? "var(--text-muted)";
  const k = r.kpi;
  const evTone = r.trades === 0 ? "var(--text-muted)" : r.evPerDollar >= 1 ? "var(--status-ok)" : "var(--status-danger)";
  const dragBad = k.execution.dragPp != null && k.execution.dragPp > 9;
  return (
    <tr>
      <td style={{ whiteSpace: "nowrap", verticalAlign: "top" }}>
        <details>
          <summary style={{ cursor: "pointer", listStyle: "none" }}>
            <span style={{ color: tone, fontWeight: 600 }}>{r.signature}</span>
            {r.source === "learned" && (
              <span
                title="promoted by the learning loop after beating the incumbent on held-out tape"
                style={{ marginLeft: 5, fontSize: 9, color: "var(--series-1)", border: "1px solid currentColor", padding: "0 3px", borderRadius: 2 }}
              >
                LEARNED
              </span>
            )}
            <span style={{ marginLeft: 5 }}>
              <RegimeChip r={r} />
            </span>
            {k.signal.smSharePct >= 15 && (
              <span title={`smart-money share ${k.signal.smSharePct.toFixed(0)}% of confirms`} style={{ marginLeft: 4 }}>
                🐋
              </span>
            )}
          </summary>
          <div style={{ margin: "6px 0 4px", fontSize: 10.5, color: "var(--text-secondary)", whiteSpace: "normal", maxWidth: 640 }}>
            <div style={{ marginBottom: 2, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: ".07em", fontSize: 9 }}>
              Last trades (48h, both lanes)
            </div>
            {r.recentTrades.length ? (
              r.recentTrades.map((t, i) => (
                <div key={i} style={tab}>
                  {t.at} {t.lane === "live" ? "◆" : "SIM"} {(t.symbol ?? "?").slice(0, 10)} · peak {t.peak.toFixed(2)}× ·{" "}
                  <span style={{ color: t.pnl >= 0 ? "var(--status-ok)" : "var(--status-danger)" }}>{money(t.pnl)}</span> ·{" "}
                  {t.exitReason ?? "?"}
                </div>
              ))
            ) : (
              <div>none</div>
            )}
            <div style={{ margin: "6px 0 2px", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: ".07em", fontSize: 9 }}>
              Last live refusals (24h)
            </div>
            {r.recentRefusals.length ? (
              r.recentRefusals.map((t, i) => (
                <div key={i} style={tab}>
                  {t.at} {(t.symbol ?? "?").slice(0, 10)} · gate: {t.gate} · ran {t.peak.toFixed(2)}× ({t.label})
                  {t.wh != null && t.wh >= 2 && (t.net ?? 0) >= 1 ? " 🐋" : ""}
                </div>
              ))
            ) : (
              <div>none</div>
            )}
          </div>
        </details>
      </td>
      <td style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
        <Geometry r={r} />
      </td>
      {/* ADMISSION — 24h funnel: confirmed → live fills, dominant refusal gate */}
      <td
        style={{ textAlign: "right", ...tab }}
        title={`24h: ${k.admission.confirmed} confirmed → ${k.admission.refused} refused${k.admission.topGate ? ` (mostly ${k.admission.topGate})` : ""} → ${k.admission.liveFills} live fills · refusal book ${money(k.admission.refusalPnlUsd)} HYPOTHETICAL`}
      >
        {k.admission.confirmed}
        <span style={{ color: "var(--text-muted)" }}>→</span>
        {k.admission.liveFills}
        {k.admission.topGate && k.admission.refused > 0 && (
          <div style={{ fontSize: 9, color: "var(--text-muted)" }}>
            {k.admission.refused}× {k.admission.topGate}
          </div>
        )}
      </td>
      {/* EXECUTION — capture vs 40% target · drag vs the 9pp falsifier */}
      <td style={{ textAlign: "right", ...tab }}>
        {k.execution.capturePct != null ? (
          <span style={{ color: k.execution.capturePct >= 40 ? "var(--status-ok)" : "var(--text)" }}>{pct(k.execution.capturePct)}</span>
        ) : (
          "—"
        )}
      </td>
      <td
        style={{ textAlign: "right", ...tab }}
        title={`live−paper twin gap, n=${k.execution.twinN}${k.execution.unsellable ? ` · ${k.execution.unsellable} unsellable` : ""}${k.execution.tpBankedPct != null ? ` · TP banked ${k.execution.tpBankedPct.toFixed(0)}%` : ""}`}
      >
        {k.execution.dragPp != null ? (
          <span style={{ color: dragBad ? "var(--status-danger)" : "var(--text)" }}>
            {k.execution.dragPp.toFixed(1)}pp{dragBad ? " ⚠" : ""}
          </span>
        ) : (
          "—"
        )}
      </td>
      {/* MONEY — paper (window) beside live (48h); never summed */}
      <td style={{ textAlign: "right", ...tab }}>
        {r.trades || "—"}
        {r.openNow > 0 && <span style={{ color: "var(--series-1)", fontSize: 10 }}> +{r.openNow}</span>}
      </td>
      <td style={{ textAlign: "right", ...tab, color: evTone }}>{r.trades > 0 ? r.evPerDollar.toFixed(3) : "—"}</td>
      <td
        style={{ textAlign: "right", ...tab }}
        title={`live 48h: ${k.live.n} closed · ${money(k.live.pnl)} · ${k.live.deployedSharePct.toFixed(0)}% of live capital`}
      >
        {k.live.n > 0 ? (
          <span style={{ color: k.live.ev >= 1 ? "var(--status-ok)" : "var(--status-danger)" }}>{k.live.ev.toFixed(3)}</span>
        ) : (
          "—"
        )}
      </td>
      <td style={{ textAlign: "right", ...tab, color: r.pnlUsd >= 0 ? "var(--status-ok)" : "var(--status-danger)" }}>
        {r.trades > 0 ? money(r.pnlUsd) : "—"}
      </td>
    </tr>
  );
}

export function SignatureConsole({ view }: { view: SignatureConsoleView }) {
  const { rows, totals, windowHours, promotedAt, forecast, regimeWindowH } = view;
  const traded = rows.filter((r) => r.trade);
  const refused = rows.filter((r) => !r.trade);

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 15 }}>Signature Console</h2>
          <p style={{ margin: "2px 0 0", fontSize: 11, color: "var(--text-muted)" }}>
            Rule beside result, five KPI groups per class. Click a class name for its last trades and live refusals.
          </p>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", textAlign: "right", ...tab }}>
          {forecast && (
            <div
              title={`Smart Money Forecast, base scenario day ${forecast.day}: band $${forecast.p10.toFixed(0)}–$${forecast.p90.toFixed(0)}`}
              style={{
                color:
                  forecast.equity < forecast.p10
                    ? "var(--status-danger)"
                    : forecast.equity > forecast.p90
                      ? "var(--status-ok)"
                      : "var(--text-secondary)",
              }}
            >
              📐 d{forecast.day}: ${forecast.equity.toFixed(0)} vs p50 ${forecast.p50.toFixed(0)}
              {forecast.equity < forecast.p10 ? " ⚠ below band" : forecast.equity > forecast.p90 ? " 🚀 above band" : ""}
            </div>
          )}
          {totals.trades} closed · {pct(totals.winPct)} win ·{" "}
          <span style={{ color: totals.pnlUsd >= 0 ? "var(--status-ok)" : "var(--status-danger)" }}>{money(totals.pnlUsd)}</span>
          <br />
          {totals.routed} routed · paper {windowHours}h · regime {regimeWindowH}h
          {promotedAt && (
            <>
              <br />
              loop promoted {new Date(promotedAt).toLocaleString()}
            </>
          )}
        </div>
      </header>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ color: "var(--text-muted)", fontSize: 10, textTransform: "uppercase", letterSpacing: ".08em" }}>
              <th style={{ textAlign: "left", padding: "4px 6px" }}>Signature</th>
              <th style={{ textAlign: "left", padding: "4px 6px" }}>Live geometry</th>
              <th style={{ textAlign: "right", padding: "4px 6px" }} title="24h admission funnel: confirmed → live fills, with the dominant refusal gate">
                Funnel
              </th>
              <th style={{ textAlign: "right", padding: "4px 6px" }} title="pooled dollars kept ÷ dollars peaks offered (≥1.2× positions) — target 40%">
                Capture
              </th>
              <th style={{ textAlign: "right", padding: "4px 6px" }} title="live−paper twin gap per trade (48h) — the forecast's managed number; ⚠ above 9pp">
                Drag
              </th>
              <th style={{ textAlign: "right", padding: "4px 6px" }}>Closed</th>
              <th style={{ textAlign: "right", padding: "4px 6px" }} title="paper: realised return per $1 deployed — the learning loop's objective">
                EV/$
              </th>
              <th style={{ textAlign: "right", padding: "4px 6px" }} title="live 48h: realised return per $1 deployed — SIM and ◆ LIVE are never summed">
                ◆ EV/$
              </th>
              <th style={{ textAlign: "right", padding: "4px 6px" }}>P&amp;L</th>
            </tr>
          </thead>
          <tbody>
            {traded.map((r) => (
              <Row key={r.signature} r={r} />
            ))}
            {refused.length > 0 && (
              <tr>
                <td colSpan={9} style={{ paddingTop: 8, fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: ".08em" }}>
                  Refused at the gate
                </td>
              </tr>
            )}
            {refused.map((r) => (
              <Row key={r.signature} r={r} />
            ))}
          </tbody>
        </table>
      </div>

      <p style={{ margin: 0, fontSize: 10, color: "var(--text-muted)" }}>
        EV/$ is realised return per dollar deployed — the loop&rsquo;s own objective. Capture pools dollars (never
        averages ratios); drag is the live−paper twin gap the forecast lives on. Refusal-book figures in the tooltips
        are HYPOTHETICAL by construction. SIM and ◆ LIVE never sum. Regime status mirrors the trader&rsquo;s gate on the
        same {regimeWindowH}h window: <span style={{ color: "var(--status-ok)" }}>ACTIVE</span> trades,{" "}
        <span style={{ color: "var(--status-warning)" }}>PRIOR</span> trades on core priors while the sample is thin,{" "}
        <span style={{ color: "var(--status-danger)" }}>BENCHED</span> waits for the class to pay again.
      </p>
    </section>
  );
}
