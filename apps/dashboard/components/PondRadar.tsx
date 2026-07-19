// POND RADAR — the Market R&D surface, on the Panel/Drawer standard. Every venue
// the recorder observes walks a lifecycle (observed → watchlist → promoted, with
// decay demotion) from rolling 24h evidence; the trader's prime set follows it.
// Surface shows the CORE glance (hot venues + best windows); the full venue table
// and hourly grid live in the drawer, so this Blue-Ocean map stays clean until you
// want the detail.
import { Panel } from "@/components/ui/Drawer";
import type { HourWindow, PondRow, WalletIntel, WalletRow } from "@/lib/queries";

const shortW = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;

function WalletGraph({ intel }: { intel: WalletIntel }) {
  const row = (r: WalletRow, kind: "win" | "rug") => (
    <div key={r.wallet} className="flex items-center justify-between rounded-md px-2.5 py-1.5" style={{ background: "var(--surface-1)", border: "1px solid var(--gridline)" }}>
      <a href={`https://solscan.io/account/${r.wallet}`} target="_blank" rel="noreferrer" className="tabular text-[11px] hover:underline" style={{ color: "var(--text-primary)" }} title={r.wallet}>
        {shortW(r.wallet)} ↗
      </a>
      <span className="tabular text-[10.5px]" style={{ color: kind === "win" ? "var(--status-good)" : "var(--status-critical)" }}>
        {r.tokens} tokens · {kind === "win" ? `${r.wins}W 0R` : `${r.rugs}R 0W`}
      </span>
    </div>
  );
  return (
    <div className="mt-4 border-t pt-3" style={{ borderColor: "var(--border)" }}>
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[11px] font-medium" style={{ color: "var(--text-secondary)" }}>Smart-money · wallet graph</span>
        <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
          {intel.qualified.toLocaleString()} wallets tracked · validated 2.2× winner lift
        </span>
      </div>
      <div className="mb-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-md px-2 py-1.5" style={{ background: "var(--surface-1)", border: "1px solid var(--gridline)" }}>
          <div className="tabular text-sm font-semibold" style={{ color: "var(--status-good)" }}>{intel.winnerWallets.toLocaleString()}</div>
          <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>winner wallets</div>
        </div>
        <div className="rounded-md px-2 py-1.5" style={{ background: "var(--surface-1)", border: "1px solid var(--gridline)" }}>
          <div className="tabular text-sm font-semibold" style={{ color: "var(--status-critical)" }}>{intel.rugWallets.toLocaleString()}</div>
          <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>serial-rug wallets</div>
        </div>
        <div className="rounded-md px-2 py-1.5" style={{ background: "var(--surface-1)", border: "1px solid var(--gridline)" }}>
          <div className="tabular text-sm font-semibold" style={{ color: intel.liveWinnerHits > 0 ? "var(--status-good)" : "var(--text-primary)" }}>{intel.liveWinnerHits}</div>
          <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>live w/ smart-money</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wide" style={{ color: "var(--status-good)" }}>🟢 Top smart-money</div>
          <div className="space-y-1">{intel.topWinners.map((r) => row(r, "win"))}</div>
        </div>
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wide" style={{ color: "var(--status-critical)" }}>🔴 Serial ruggers</div>
          <div className="space-y-1">{intel.topRugs.map((r) => row(r, "rug"))}</div>
        </div>
      </div>
      <p className="mt-2 text-[10.5px]" style={{ color: "var(--text-muted)" }}>
        Reputation from the holder graph × labeled outcomes — the persistent layer across one-shot tokens. A candidate whose holders include a winner-wallet rises; an all-fresh holder set is the rug tell.
      </p>
    </div>
  );
}

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

function VenueTable({ rows }: { rows: PondRow[] }) {
  return (
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
  );
}

export function PondRadar({ ponds, hours, walletIntel }: { ponds: PondRow[]; hours: HourWindow[]; walletIntel?: WalletIntel }) {
  if (ponds.length === 0) return null;
  const rows = [...ponds].sort((a, b) => (RANK[a.state] ?? 9) - (RANK[b.state] ?? 9) || b.watched - a.watched);

  // ── CORE glance (surface): hot venues as chips + the best windows ──
  const promoted = rows.filter((p) => p.state === "promoted");
  const watchlist = rows.filter((p) => p.state === "watchlist");
  const hot = [...promoted, ...watchlist].slice(0, 6);
  const bestPeakHour = hours.length ? hours.reduce((b, h) => ((h.bestPeak ?? 0) > (b.bestPeak ?? 0) ? h : b), hours[0]!) : null;
  const bestPnlHour = hours.length ? hours.reduce((b, h) => ((h.realized ?? -Infinity) > (b.realized ?? -Infinity) ? h : b), hours[0]!) : null;

  const badge = (
    <span className="rounded px-1.5 py-px text-[10px]" style={{ color: "var(--text-muted)", border: "1px solid var(--gridline)" }}>
      {rows.length} venues · {promoted.length} promoted
    </span>
  );

  return (
    <Panel
      title="Pond Radar · venue R&D"
      badge={badge}
      accent="var(--status-good)"
      storageKey="pond-radar"
      drawerTitle="Pond Radar · venue R&D"
      drawerSubtitle="rolling 24h · promotion earned on recorder evidence"
      expandLabel="Full map"
      drawer={
        <>
          <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            Every venue the recorder watches walks a lifecycle from rolling 24h evidence — promotion is earned, the boost is rented not owned. The trader&apos;s prime set follows this map automatically.
          </p>
          <VenueTable rows={rows} />
          <HourStrip hours={hours} />
          {walletIntel ? <WalletGraph intel={walletIntel} /> : null}
        </>
      }
    >
      {/* CORE: what's hot + when */}
      <div className="flex flex-wrap gap-1.5">
        {hot.length === 0 ? (
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>No promoted or watchlist venues yet — observing.</span>
        ) : (
          hot.map((p) => {
            const st = STATE_STYLE[p.state] ?? STATE_STYLE.observed!;
            return (
              <span
                key={p.venue}
                className="tabular inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px]"
                style={{ background: "var(--surface-0, var(--page))", border: `1px solid ${st.color}`, color: "var(--text-secondary)" }}
                title={`${st.label} · ${p.watched} watched · win ${p.winRate === null ? "—" : Math.round(p.winRate * 100) + "%"} · rug ${p.rugRate === null ? "—" : Math.round(p.rugRate * 100) + "%"}`}
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: st.color }} />
                <span style={{ color: "var(--text-primary)" }}>{p.venue}</span>
                {p.avgPeak !== null ? <span style={{ color: "var(--text-muted)" }}>{p.avgPeak.toFixed(1)}×</span> : null}
              </span>
            );
          })
        )}
      </div>
      {bestPeakHour && bestPnlHour ? (
        <div className="mt-3 flex flex-wrap gap-4 text-[11px]" style={{ color: "var(--text-muted)" }}>
          <span>
            ⭐ Best mover: <span style={{ color: "var(--text-secondary)" }}>{fmtHour(bestPeakHour.hour)} ET</span>
            {bestPeakHour.bestSymbol ? ` — ${bestPeakHour.bestSymbol} ${bestPeakHour.bestPeak?.toFixed(1)}×` : ""}
          </span>
          <span>
            💰 Best banked: <span style={{ color: "var(--text-secondary)" }}>{fmtHour(bestPnlHour.hour)} ET</span>
            {bestPnlHour.realized !== null ? ` (+$${bestPnlHour.realized.toFixed(0)})` : ""}
          </span>
          {watchlist.length > 0 ? <span style={{ color: "var(--status-warning)" }}>{watchlist.length} on watchlist</span> : null}
          {walletIntel ? (
            <span style={{ color: walletIntel.liveWinnerHits > 0 ? "var(--status-good)" : "var(--text-muted)" }}>
              🟢 {walletIntel.winnerWallets.toLocaleString()} smart-money wallets{walletIntel.liveWinnerHits > 0 ? ` · ${walletIntel.liveWinnerHits} live` : ""}
            </span>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}
