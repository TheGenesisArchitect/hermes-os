import type { SignatureConsoleView, SignatureRow } from "@/lib/queries";

// SIGNATURE CONSOLE — the desk, reorganised around the five genomes.
//
// The old terminal exposed one global exit geometry (TP0/1/2, three trail
// widths, one hard stop). That geometry now belongs to the SIGNATURE: each class
// carries its own cover, trail, ladder and clock, fitted per class against
// held-out tape. So the console pairs the RULE with its RESULT on one row —
// what the class is instructed to do, and what it actually produced — because a
// dial you can turn is useless next to a rule you can't see.

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

function Geometry({ r }: { r: SignatureRow }) {
  if (!r.trade) return <span style={{ color: "var(--status-danger)" }}>refused — never opens</span>;
  return (
    <span style={{ fontVariantNumeric: "tabular-nums" }}>
      cover {mult(r.floor)} · trail {pct(r.trail * 100)} · TP {mult(r.tp1[0])}@{pct(r.tp1[1] * 100)} /{" "}
      {mult(r.tp2[0])}@{pct(r.tp2[1] * 100)}
      {r.holdSec > 0 ? ` · clock ${Math.round(r.holdSec / 60)}m` : ""} · snap ≥{pct(r.minSnap * 100)}
    </span>
  );
}

function Row({ r }: { r: SignatureRow }) {
  const tone = TONE[r.signature] ?? "var(--text-muted)";
  // EV is the same unit the learning loop optimises, so the console and the loop
  // never disagree about what "good" means. Below 1.0 the class is losing money.
  const evTone = r.trades === 0 ? "var(--text-muted)" : r.evPerDollar >= 1 ? "var(--status-ok)" : "var(--status-danger)";
  return (
    <tr>
      <td style={{ whiteSpace: "nowrap" }}>
        <span style={{ color: tone, fontWeight: 600 }}>{r.signature}</span>
        {r.source === "learned" && (
          <span
            title="promoted by the learning loop after beating the incumbent on held-out tape"
            style={{ marginLeft: 6, fontSize: 10, color: "var(--series-1)", border: "1px solid currentColor", padding: "0 4px", borderRadius: 2 }}
          >
            LEARNED
          </span>
        )}
        {r.size !== 1 && r.trade && (
          <span title="sized down while the class accumulates evidence" style={{ marginLeft: 6, fontSize: 10, color: "var(--text-muted)" }}>
            ×{r.size}
          </span>
        )}
      </td>
      <td style={{ fontSize: 11, color: "var(--text-muted)" }}>
        <Geometry r={r} />
      </td>
      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.routed || "—"}</td>
      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
        {r.trades || "—"}
        {r.openNow > 0 && <span style={{ color: "var(--series-1)", fontSize: 10 }}> +{r.openNow}</span>}
      </td>
      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
        {r.trades > 0 ? (
          <span style={{ color: r.winPct >= 75 ? "var(--status-ok)" : r.winPct >= 50 ? "var(--text)" : "var(--status-danger)" }}>
            {pct(r.winPct)}
          </span>
        ) : (
          "—"
        )}
      </td>
      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: evTone }}>
        {r.trades > 0 ? r.evPerDollar.toFixed(3) : "—"}
      </td>
      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: r.pnlUsd >= 0 ? "var(--status-ok)" : "var(--status-danger)" }}>
        {r.trades > 0 ? money(r.pnlUsd) : "—"}
      </td>
    </tr>
  );
}

export function SignatureConsole({ view }: { view: SignatureConsoleView }) {
  const { rows, totals, windowHours, promotedAt } = view;
  const traded = rows.filter((r) => r.trade);
  const refused = rows.filter((r) => !r.trade);

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 15 }}>Signature Console</h2>
          <p style={{ margin: "2px 0 0", fontSize: 11, color: "var(--text-muted)" }}>
            Each class carries its own cover, trail, ladder and clock. Exit geometry is owned here — the global TP and
            trail dials no longer reach a routed position.
          </p>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
          {totals.trades} closed · {pct(totals.winPct)} win ·{" "}
          <span style={{ color: totals.pnlUsd >= 0 ? "var(--status-ok)" : "var(--status-danger)" }}>{money(totals.pnlUsd)}</span>
          <br />
          {totals.routed} routed · last {windowHours}h
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
              <th style={{ textAlign: "right", padding: "4px 6px" }}>Routed</th>
              <th style={{ textAlign: "right", padding: "4px 6px" }}>Closed</th>
              <th style={{ textAlign: "right", padding: "4px 6px" }} title="target is 75%">
                Win
              </th>
              <th style={{ textAlign: "right", padding: "4px 6px" }} title="realised return per $1 deployed — the learning loop's objective">
                EV/$
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
                <td colSpan={7} style={{ paddingTop: 8, fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: ".08em" }}>
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
        EV/$ is realised return per dollar deployed — the same objective the learning loop optimises, so this table and
        the loop never disagree about what &ldquo;good&rdquo; means. Below 1.000 the class is losing money. A{" "}
        <span style={{ color: "var(--series-1)" }}>LEARNED</span> tag means the loop promoted that profile after it beat
        the incumbent on tape it had never seen; untagged rows are running the compiled default.
      </p>
    </section>
  );
}
