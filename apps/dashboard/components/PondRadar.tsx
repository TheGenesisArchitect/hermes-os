// POND RADAR — the Market R&D surface. Every venue the recorder observes walks
// a lifecycle (observed → watchlist → promoted, with decay demotion) computed
// from rolling 24h evidence; the trader's prime set follows automatically.
// This board is where new Blue Oceans surface before a dollar is risked there.
import type { PondRow } from "@/lib/queries";

const STATE_STYLE: Record<string, { color: string; label: string }> = {
  promoted: { color: "var(--status-good)", label: "PROMOTED · prime boost" },
  watchlist: { color: "var(--status-warning)", label: "WATCHLIST" },
  core: { color: "var(--series-1)", label: "CORE" },
  observed: { color: "var(--text-muted)", label: "OBSERVED" },
  blocked: { color: "var(--status-critical)", label: "BLOCKED" },
};
const RANK: Record<string, number> = { promoted: 0, watchlist: 1, core: 2, observed: 3, blocked: 4 };

export function PondRadar({ ponds }: { ponds: PondRow[] }) {
  if (ponds.length === 0) return null;
  const rows = [...ponds].sort((a, b) => (RANK[a.state] ?? 9) - (RANK[b.state] ?? 9) || b.watched - a.watched);
  return (
    <section className="rounded-lg border p-4" style={{ borderColor: "var(--border)", background: "var(--surface-0)" }}>
      <div className="mb-1 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          Pond Radar · venue R&amp;D
        </h2>
        <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          rolling 24h · promotion is earned on recorder evidence, boost is rented not owned
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs" style={{ color: "var(--text-secondary)" }}>
          <thead>
            <tr className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
              <th className="py-1 pr-3 text-left">Venue</th>
              <th className="py-1 pr-3 text-left">State</th>
              <th className="py-1 pr-3 text-right">Watched</th>
              <th className="py-1 pr-3 text-right">Win</th>
              <th className="py-1 pr-3 text-right">Rug</th>
              <th className="py-1 pr-3 text-right">Avg peak</th>
              <th className="py-1 pr-3 text-right">Traded</th>
              <th className="py-1 pr-3 text-right">Realized</th>
              <th className="py-1 text-right">In state</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const st = STATE_STYLE[p.state] ?? STATE_STYLE.observed!;
              return (
                <tr key={p.venue} className="border-t" style={{ borderColor: "var(--border)" }}>
                  <td className="tabular py-1.5 pr-3" style={{ color: "var(--text-primary)" }}>{p.venue}</td>
                  <td className="py-1.5 pr-3">
                    <span className="rounded px-1.5 py-px text-[9.5px]" style={{ color: st.color, border: `1px solid ${st.color}` }}>
                      {st.label}
                    </span>
                  </td>
                  <td className="tabular py-1.5 pr-3 text-right">{p.watched}</td>
                  <td className="tabular py-1.5 pr-3 text-right">{p.winRate === null ? "—" : `${Math.round(p.winRate * 100)}%`}</td>
                  <td className="tabular py-1.5 pr-3 text-right">{p.rugRate === null ? "—" : `${Math.round(p.rugRate * 100)}%`}</td>
                  <td className="tabular py-1.5 pr-3 text-right">{p.avgPeak === null ? "—" : `${p.avgPeak.toFixed(2)}×`}</td>
                  <td className="tabular py-1.5 pr-3 text-right">{p.traded}</td>
                  <td className="tabular py-1.5 pr-3 text-right" style={{ color: (p.realized ?? 0) >= 0 ? "var(--status-good)" : "var(--status-critical)" }}>
                    {p.realized === null ? "—" : `${p.realized >= 0 ? "+" : ""}$${p.realized.toFixed(2)}`}
                  </td>
                  <td className="tabular py-1.5 text-right" style={{ color: "var(--text-muted)" }}>{p.inStateHours < 1 ? "<1h" : `${Math.round(p.inStateHours)}h`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
