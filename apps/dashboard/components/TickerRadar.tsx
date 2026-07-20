// TICKER RADAR — the meta-momentum surface. Symbol families printing winners in
// the rolling 6h run HOT (the trader boosts same-family confirms ×1.35 + queue
// priority; validated 19.6% vs 13.0% base win rate). Farm-blacklisted tickers
// (≥50% rug share, n≥20/24h) get the no-runner ladder and are never boosted.
import type { TickerRadar as TickerRadarData } from "@/lib/queries";

export function TickerRadar({ radar }: { radar: TickerRadarData }) {
  if (radar.hot.length === 0 && radar.farm.length === 0) return null;
  return (
    <section className="rounded-xl p-4" style={{ background: "var(--surface-0)", border: "1px solid var(--border)" }}>
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          Ticker Radar <span className="font-normal" style={{ color: "var(--text-muted)" }}>· family meta-momentum</span>
        </h2>
        <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
          hot = ≥2 family winners / 6h · boosted ×1.35 + queue priority · validated 1.5× win lift
        </span>
      </div>
      {radar.hot.length > 0 && (
        <div className="mb-3">
          <div className="mb-1.5 text-[10px] uppercase tracking-wide" style={{ color: "var(--status-good)" }}>
            🔥 Hot families ({radar.hot.length})
          </div>
          <div className="flex flex-wrap gap-1.5">
            {radar.hot.map((f) => (
              <span
                key={f.fam}
                className="rounded-full px-2.5 py-1 text-[11px]"
                style={{ background: "var(--surface-1)", border: "1px solid var(--gridline)", color: "var(--text-primary)" }}
                title={`${f.wins} winners / ${f.n} launches (${f.rugs} rugs) in 6h`}
              >
                {f.fam}
                <span className="tabular" style={{ color: "var(--status-good)" }}>
                  {" "}{f.wins}W
                </span>
                {f.bestPeak !== null && (
                  <span className="tabular" style={{ color: "var(--text-muted)" }}> · {f.bestPeak.toFixed(1)}×</span>
                )}
              </span>
            ))}
          </div>
        </div>
      )}
      {radar.farm.length > 0 && (
        <div>
          <div className="mb-1.5 text-[10px] uppercase tracking-wide" style={{ color: "var(--status-critical)" }}>
            🎰 Farm blacklist ({radar.farm.length}) — never boosted, no-runner ladder
          </div>
          <div className="flex flex-wrap gap-1.5">
            {radar.farm.map((s) => (
              <span
                key={s}
                className="rounded-full px-2.5 py-1 text-[11px] line-through"
                style={{ background: "var(--surface-1)", border: "1px solid var(--gridline)", color: "var(--text-muted)" }}
              >
                {s}
              </span>
            ))}
          </div>
        </div>
      )}
      <p className="mt-2.5 text-[10.5px]" style={{ color: "var(--text-muted)" }}>
        Keyed by mint, signaled by family — same ticker ≠ same token (the W26 lesson). A family in both lists stays blacklisted.
      </p>
    </section>
  );
}
