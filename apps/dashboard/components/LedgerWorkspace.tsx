// LEDGER WORKSPACE (spec §5, Phase 3) — the one clean P&L surface. Every number
// on it derives from the journal; every row traces to an immutable event. The
// header carries the proof: the reconciler's "chain-verified N min ago" tick.
// Replaces the Accounting Ledger, Trade Ledger, and Fills panels.
import { Panel } from "@/components/ui/Drawer";
import type { LedgerWorkspaceView } from "@/lib/queries";

const money = (v: number) => `${v < 0 ? "−" : "+"}$${Math.abs(v).toFixed(2)}`;
const pretty = (s: string) => s.replace("MOON_", "m·").replace("(unrouted)", "unrouted").toLowerCase();

function Kpi({ label, value, tone, sub }: { label: string; value: string; tone?: string; sub: string }) {
  return (
    <div className="flex-1 rounded-md p-3" style={{ background: "var(--page)", border: "1px solid var(--gridline)", minWidth: 150 }}>
      <div className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>{label}</div>
      <div className="tabular mt-1 text-xl font-semibold" style={{ color: tone ?? "var(--text-primary)" }}>{value}</div>
      <div className="mt-0.5 text-[10px]" style={{ color: "var(--text-secondary)" }}>{sub}</div>
    </div>
  );
}

export function LedgerWorkspace({ view }: { view: LedgerWorkspaceView }) {
  const paper = view.books.find((b) => b.book === "paper");
  const live = view.books.find((b) => b.book === "live");
  const recon = view.recon;
  const reconAgeMin = recon.at ? Math.round((Date.now() - new Date(recon.at).getTime()) / 60_000) : null;
  const paperDaily = view.daily.filter((d) => d.book === "paper");
  const maxAbs = Math.max(1, ...paperDaily.map((d) => Math.abs(d.net)));

  const badge = (
    <span
      title={recon.at ? `chain ${recon.chainSol?.toFixed(6)} SOL · drift $${recon.driftUsd?.toFixed(3)} · checked ${reconAgeMin}m ago` : "reconciler has not reported yet"}
      className="tabular rounded px-1.5 py-px text-[10px]"
      style={{
        border: `1px solid ${recon.green ? "var(--status-good)" : reconAgeMin == null ? "var(--gridline)" : "var(--status-critical)"}`,
        color: recon.green ? "var(--status-good)" : reconAgeMin == null ? "var(--text-muted)" : "var(--status-critical)",
      }}
    >
      {recon.green ? `✓ chain-verified ${reconAgeMin}m ago` : reconAgeMin == null ? "reconciler warming up" : `⚠ drift $${recon.driftUsd?.toFixed(2)}`}
    </span>
  );

  return (
    <Panel
      title="Ledger"
      badge={badge}
      accent="var(--series-1)"
      storageKey="ledger-workspace"
      drawerTitle="The journal"
      drawerSubtitle="Every dollar movement as an immutable event — append-only, balanced, chain-reconciled"
      expandLabel="Journal"
      drawer={
        <div className="space-y-4">
          {recon.adjustments.length > 0 ? (
            <div>
              <div className="mb-1 text-[11px] font-medium" style={{ color: "var(--text-primary)" }}>Reconciliation history</div>
              <table className="w-full text-[11px]">
                <tbody>
                  {recon.adjustments.map((a, i) => (
                    <tr key={i} style={{ borderTop: "1px solid var(--gridline)" }}>
                      <td className="tabular py-1 pr-3" style={{ color: "var(--text-muted)" }}>{a.at.toISOString().slice(5, 16).replace("T", " ")}</td>
                      <td className="tabular py-1 pr-3" style={{ color: "var(--status-warning)" }}>{money(a.driftUsd)}</td>
                      <td className="py-1" style={{ color: "var(--text-secondary)" }}>{a.memo}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              Reconciliation history is empty — no drift has ever exceeded tolerance. That is the goal state.
            </p>
          )}
          <div>
            <div className="mb-1 text-[11px] font-medium" style={{ color: "var(--text-primary)" }}>Journal · most recent events</div>
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)", textAlign: "left" }}>
                  <th className="pb-1 font-medium">When</th>
                  <th className="pb-1 font-medium">Event</th>
                  <th className="pb-1 font-medium">Token</th>
                  <th className="pb-1 text-right font-medium">Primary leg</th>
                  <th className="pb-1 font-medium">Memo</th>
                </tr>
              </thead>
              <tbody>
                {view.journal.map((j) => (
                  <tr key={j.id} style={{ borderTop: "1px solid var(--gridline)" }}>
                    <td className="tabular whitespace-nowrap py-1 pr-2" style={{ color: "var(--text-muted)" }}>
                      {j.at.toISOString().slice(5, 16).replace("T", " ")}
                    </td>
                    <td className="whitespace-nowrap py-1 pr-2">
                      {j.book === "live" ? <span title="live wallet" style={{ color: "var(--status-serious)" }}>◆ </span> : <span title="simulated" style={{ color: "var(--text-muted)" }}>SIM </span>}
                      <span className="mono" style={{ color: "var(--text-primary)" }}>{j.eventType}</span>
                    </td>
                    <td className="py-1 pr-2" style={{ color: "var(--text-secondary)" }}>{j.symbol ?? "—"}</td>
                    <td className="tabular whitespace-nowrap py-1 pr-2 text-right">
                      <span style={{ color: "var(--text-muted)" }}>{j.account.replace("inventory:", "inv:").slice(0, 18)} </span>
                      <span style={{ color: j.amountUsd >= 0 ? "var(--text-primary)" : "var(--status-critical)" }}>{money(j.amountUsd)}</span>
                    </td>
                    <td className="max-w-[220px] truncate py-1 text-[10px]" style={{ color: "var(--text-muted)" }} title={j.memo}>
                      {j.memo}{j.tx ? " · tx ✓" : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      }
    >
      {/* ── per-book statement tiles ── */}
      <div className="mb-3 flex flex-wrap gap-2">
        <Kpi
          label="Paper · realized today"
          value={money(paper?.realizedToday ?? 0)}
          tone={(paper?.realizedToday ?? 0) >= 0 ? "var(--status-good)" : "var(--status-critical)"}
          sub={`all-time ${money(paper?.realizedAll ?? 0)} · fees $${(paper?.feesAll ?? 0).toFixed(0)} (modelled) · SIM`}
        />
        <Kpi
          label="Live · realized today"
          value={money(live?.realizedToday ?? 0)}
          tone={(live?.realizedToday ?? 0) >= 0 ? "var(--status-good)" : "var(--status-critical)"}
          sub={`all-time ${money(live?.realizedAll ?? 0)} · fees $${(live?.feesAll ?? 0).toFixed(2)} recorded · ◆ real capital`}
        />
        <Kpi
          label="Chain position"
          value={recon.chainSol != null ? `${recon.chainSol.toFixed(4)} SOL` : "—"}
          sub={recon.chainSol != null && recon.solUsd != null ? `≈ $${(recon.chainSol * recon.solUsd).toFixed(2)} · drift $${(recon.driftUsd ?? 0).toFixed(3)}` : "awaiting reconciler"}
        />
        <Kpi
          label="Journal"
          value={`${((paper?.events ?? 0) + (live?.events ?? 0)).toLocaleString()}`}
          sub={`events · append-only · Σ legs = 0 enforced`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ── daily statement, paper (the sensor's curve) ── */}
        <div>
          <div className="mb-1 text-[11px] font-medium" style={{ color: "var(--text-primary)" }}>
            Daily net by book <span style={{ color: "var(--text-muted)" }}>(realized − fees, last 7d)</span>
          </div>
          <table className="w-full text-[11px]">
            <tbody>
              {paperDaily.map((d) => {
                const liveRow = view.daily.find((x) => x.book === "live" && x.day === d.day);
                return (
                  <tr key={d.day} style={{ borderTop: "1px solid var(--gridline)" }}>
                    <td className="tabular py-1 pr-2" style={{ color: "var(--text-muted)", width: 44 }}>{d.day}</td>
                    <td className="py-1 pr-2" style={{ width: "40%" }}>
                      <div className="h-3 rounded-sm" style={{
                        width: `${Math.max(3, (Math.abs(d.net) / maxAbs) * 100)}%`,
                        background: d.net >= 0 ? "var(--status-good)" : "var(--status-critical)", opacity: 0.75,
                      }} />
                    </td>
                    <td className="tabular py-1 pr-3 text-right" style={{ color: d.net >= 0 ? "var(--status-good)" : "var(--status-critical)" }}>{money(d.net)}</td>
                    <td className="tabular py-1 text-right" style={{ color: liveRow == null ? "var(--text-muted)" : liveRow.net >= 0 ? "var(--status-good)" : "var(--status-critical)" }}>
                      {liveRow ? `◆ ${money(liveRow.net)}` : "◆ —"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* ── today's per-signature statement ── */}
        <div>
          <div className="mb-1 text-[11px] font-medium" style={{ color: "var(--text-primary)" }}>Today by signature</div>
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                <th className="pb-1 text-left font-medium">Signature</th>
                <th className="pb-1 text-right font-medium">Trips</th>
                <th className="pb-1 text-right font-medium">Net</th>
              </tr>
            </thead>
            <tbody>
              {view.bySignature.slice(0, 10).map((s, i) => (
                <tr key={i} style={{ borderTop: "1px solid var(--gridline)" }}>
                  <td className="py-1" style={{ color: "var(--text-primary)" }}>
                    {s.book === "live" ? <span style={{ color: "var(--status-serious)" }}>◆ </span> : null}{pretty(s.signature)}
                  </td>
                  <td className="tabular py-1 text-right" style={{ color: "var(--text-secondary)" }}>{s.trips}</td>
                  <td className="tabular py-1 text-right" style={{ color: s.net >= 0 ? "var(--status-good)" : "var(--status-critical)" }}>{money(s.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[10px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
            Every figure derives from the append-only journal — corrections are reversal events, never edits, and the
            live book is proven against the blockchain every five minutes. SIM and ◆ LIVE are never summed together.
          </p>
        </div>
      </div>
    </Panel>
  );
}
