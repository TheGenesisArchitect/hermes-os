// INFLOW EDGE — the system's core edge, continuously re-measured.
// Pool growth at arm (liquidity now ÷ liquidity at first read) is the one signal
// a wash-traded fake cannot manufacture: recycled volume leaves a pool flat,
// real demand pulls new capital in. This panel re-derives the edge from realized
// outcomes every refresh, so decay shows up as a shrinking spread rather than a
// silent assumption. If the bands converge, the edge is gone — act on it.
import type { InflowBand } from "@/lib/queries";
import { usd } from "@/components/ui";

export function InflowEdge({ bands, hours = 24 }: { bands: InflowBand[]; hours?: number }) {
  if (bands.length === 0) return null;
  const real = bands.filter((b) => !b.band.startsWith("z"));
  const strong = real.find((b) => b.band.startsWith("a"));
  const flat = real.find((b) => b.band.startsWith("d"));
  const spread =
    strong?.winPct != null && flat?.winPct != null ? strong.winPct - flat.winPct : null;
  const rugSpread =
    strong?.rugPct != null && flat?.rugPct != null ? flat.rugPct - strong.rugPct : null;

  return (
    <section className="card p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
          Inflow edge <span className="font-normal" style={{ color: "var(--text-muted)" }}>· pool growth at arm · last {hours}h</span>
        </h2>
        <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          {spread !== null ? (
            <>
              win spread{" "}
              <span style={{ color: spread > 15 ? "var(--status-good)" : spread > 5 ? "var(--status-warning)" : "var(--status-critical)" }}>
                {spread >= 0 ? "+" : ""}{spread.toFixed(1)}pp
              </span>
              {rugSpread !== null ? (
                <>
                  {" · rug spread "}
                  <span style={{ color: rugSpread > 10 ? "var(--status-good)" : "var(--status-warning)" }}>
                    {rugSpread >= 0 ? "−" : "+"}{Math.abs(rugSpread).toFixed(1)}pp
                  </span>
                </>
              ) : null}
              {spread <= 5 ? " ⚠ edge decaying" : ""}
            </>
          ) : (
            "building sample…"
          )}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs" style={{ color: "var(--text-muted)" }}>
              <th className="pb-2 pr-3 font-normal">Pool growth at arm</th>
              <th className="pb-2 pr-3 text-right font-normal">Armed</th>
              <th className="pb-2 pr-3 text-right font-normal">Win %</th>
              <th className="pb-2 pr-3 text-right font-normal">Rug %</th>
              <th className="pb-2 pr-3 text-right font-normal">Avg peak</th>
              <th className="pb-2 pr-3 text-right font-normal">Traded</th>
              <th className="pb-2 pr-3 text-right font-normal">Avg size</th>
              <th className="pb-2 text-right font-normal">Realized</th>
            </tr>
          </thead>
          <tbody>
            {bands.map((b) => {
              const label = b.band.slice(2).trim();
              const isStrong = b.band.startsWith("a") || b.band.startsWith("b");
              const isFlat = b.band.startsWith("d");
              return (
                <tr key={b.band} className="border-t" style={{ borderColor: "var(--gridline)" }}>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    <span
                      className="mr-2 inline-block h-2 w-2 rounded-full align-middle"
                      style={{ background: isStrong ? "var(--status-good)" : isFlat ? "var(--status-critical)" : "var(--text-muted)" }}
                    />
                    <span style={{ color: "var(--text-primary)" }}>{label}</span>
                    {isStrong ? <span className="ml-1.5 text-[10px]" style={{ color: "var(--status-good)" }}>💧 boosted</span> : null}
                    {isFlat ? <span className="ml-1.5 text-[10px]" style={{ color: "var(--status-critical)" }}>shrunk</span> : null}
                  </td>
                  <td className="tabular py-2 pr-3 text-right" style={{ color: "var(--text-secondary)" }}>{b.armed}</td>
                  <td className="tabular py-2 pr-3 text-right font-medium" style={{ color: b.winPct != null && b.winPct >= 40 ? "var(--status-good)" : "var(--text-secondary)" }}>
                    {b.winPct === null ? "—" : `${b.winPct.toFixed(1)}%`}
                  </td>
                  <td className="tabular py-2 pr-3 text-right" style={{ color: b.rugPct != null && b.rugPct >= 30 ? "var(--status-critical)" : "var(--text-secondary)" }}>
                    {b.rugPct === null ? "—" : `${b.rugPct.toFixed(1)}%`}
                  </td>
                  <td className="tabular py-2 pr-3 text-right" style={{ color: "var(--text-secondary)" }}>{b.avgPeak === null ? "—" : `${b.avgPeak.toFixed(2)}×`}</td>
                  <td className="tabular py-2 pr-3 text-right text-xs" style={{ color: "var(--text-muted)" }}>{b.traded}</td>
                  <td className="tabular py-2 pr-3 text-right text-xs" style={{ color: "var(--text-muted)" }}>{b.avgSize === null ? "—" : usd(b.avgSize)}</td>
                  <td className="tabular py-2 text-right font-medium" style={{ color: (b.realized ?? 0) >= 0 ? "var(--status-good)" : "var(--status-critical)" }}>
                    {b.realized === null ? "—" : `${b.realized >= 0 ? "+" : ""}${usd(b.realized)}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[10.5px]" style={{ color: "var(--text-muted)" }}>
        Wash trading recycles the same capital and leaves the pool flat; real demand adds to it. Strong-inflow arms are sized up and jump the entry
        queue; price-up-on-a-flat-pool (the wash signature) is sized down. Watch the <strong>win spread</strong> — if the top and bottom bands
        converge, the edge is decaying and the multipliers need re-fitting.
      </p>
    </section>
  );
}
