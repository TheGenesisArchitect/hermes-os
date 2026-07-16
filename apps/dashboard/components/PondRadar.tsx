// POND RADAR — the Market R&D surface. Every venue the recorder observes walks
// a lifecycle (observed → watchlist → promoted, with decay demotion) computed
// from rolling 24h evidence; the trader's prime set follows automatically.
// This board is where new Blue Oceans surface before a dollar is risked there.
import type { HourWindow, PondRow } from "@/lib/queries";

const fmtHour = (h: number) => {
  const ampm = h < 12 ? "a" : "p";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}${ampm}`;
};

const STATE_STYLE: Record<string, { color: string; label: string }> = {
  promoted: { color: "var(--status-good)", label: "PROMOTED · prime boost" },
  watchlist: { color: "var(--status-warning)", label: "WATCHLIST" },
  core: { color: "var(--series-1)", label: "CORE" },
  observed: { color: "var(--text-muted)", label: "OBSERVED" },
  blocked: { color: "var(--status-critical)", label: "BLOCKED" },
};
const RANK: Record<string, number> = { promoted: 0, watchlist: 1, core: 2, observed: 3, blocked: 4 };

function HourStrip({ hours }: { hours: HourWindow[] }) {
  if (hours.length === 0) return null;
  const maxWatched = Math.max(1, ...hours.map((h) => h.watched));
  const bestPeakHour = hours.reduce((b, h) => ((h.bestPeak ?? 0) > (b.bestPeak ?? 0) ? h : b), hours[0]!);
  const bestPnlHour = hours.reduce((b, h) => ((h.realized ?? -Infinity) > (b.realized ?? -Infinity) ? h : b), hours[0]!);
  return (
    <div className="mt-4 border-t pt-3" style={{ borderColor: "var(--border)" }}>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[11px] font-medium" style={{ color: "var(--text-secondary)" }}>Hourly windows · ET</span>
        <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
          bar = launch flow (all history) · bar color = realized P&amp;L in that hour (current run) · ⭐ best mover · 💰 best banked · rail = throttle (green full · amber probe · gray static)
        </span>
      </div>
      <div className="flex items-end gap-[3px]" style={{ height: 64 }}>
        {hours.map((h) => {
          const hgt = Math.max(3, (h.watched / maxWatched) * 56);
          const pnl = h.realized ?? 0;
          const bg =
            h.traded === 0
              ? "var(--gridline)"
              : pnl >= 0
                ? "var(--status-good)"
                : "var(--status-critical)";
          return (
            <div
              key={h.hour}
              className="relative flex-1 rounded-t-[2px]"
              style={{ height: hgt, background: bg, opacity: h.traded === 0 ? 0.5 : 0.85 }}
              title={`${fmtHour(h.hour)} ET — flow ${h.watched} candidates · win ${h.winRate === null ? "—" : Math.round(h.winRate * 100) + "%"} · best ${h.bestSymbol ?? "—"} ${h.bestPeak ? h.bestPeak.toFixed(1) + "×" : ""} · traded ${h.traded} (${pnl >= 0 ? "+" : ""}$${pnl.toFixed(0)})`}
            >
              {h.hour === bestPeakHour.hour && <span className="absolute -top-4 left-1/2 -translate-x-1/2 text-[10px]">⭐</span>}
              {h.hour === bestPnlHour.hour && h.hour !== bestPeakHour.hour && (
                <span className="absolute -top-4 left-1/2 -translate-x-1/2 text-[10px]">💰</span>
              )}
            </div>
          );
        })}
      </div>
      {/* hour-driven throttle readout: which hours trade full size vs probe */}
      <div className="mt-0.5 flex gap-[3px]">
        {hours.map((h) => (
          <div
            key={`p${h.hour}`}
            className="h-[3px] flex-1 rounded-full"
            title={`${fmtHour(h.hour)} ET — throttle: ${h.policy ?? "unmeasured (static schedule decides)"}`}
            style={{
              background:
                h.policy === "prime"
                  ? "var(--status-good)"
                  : h.policy === "probe"
                    ? "var(--status-warning)"
                    : "var(--gridline)",
            }}
          />
        ))}
      </div>
      <div className="mt-0.5 flex gap-[3px]">
        {hours.map((h) => (
          <div key={h.hour} className="flex-1 text-center text-[8px] tabular" style={{ color: "var(--text-muted)" }}>
            {h.hour % 3 === 0 ? fmtHour(h.hour) : ""}
          </div>
        ))}
      </div>
      <div className="mt-1 text-[10.5px]" style={{ color: "var(--text-muted)" }}>
        ⭐ Best mover window: <span style={{ color: "var(--text-secondary)" }}>{fmtHour(bestPeakHour.hour)} ET</span>
        {bestPeakHour.bestSymbol ? ` — ${bestPeakHour.bestSymbol} hit ${bestPeakHour.bestPeak?.toFixed(1)}×` : ""} ·
        💰 Best banked hour: <span style={{ color: "var(--text-secondary)" }}>{fmtHour(bestPnlHour.hour)} ET</span>
        {bestPnlHour.realized !== null ? ` (+$${bestPnlHour.realized.toFixed(0)})` : ""}
      </div>
    </div>
  );
}

export function PondRadar({ ponds, hours }: { ponds: PondRow[]; hours: HourWindow[] }) {
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
      <HourStrip hours={hours} />
    </section>
  );
}
