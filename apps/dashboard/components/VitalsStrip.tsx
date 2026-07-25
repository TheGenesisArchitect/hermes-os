/**
 * DNA VITALS STRIP — Command Center phase C1 (ratified 2026-07-25).
 *
 * The benchmark contract rendered as six tiles at the head of Position
 * Command: each is a standing promise with a bar, colored by whether the
 * last 24h kept it. Below, the Phase 2 diagnosis Pareto (loudest loss
 * class first — always the next crank) and the P0 chain anchor. Lanes are
 * never blended: the compound tile carries paper and live side by side.
 */
import type { VitalsView } from "@/lib/queries";

const GOOD = "var(--status-good)";
const WARN = "#c9a94a";
const CRIT = "var(--status-critical)";
const MUT = "var(--text-muted)";

function Tile({ label, value, bar, tone }: { label: string; value: string; bar: string; tone: string }) {
  return (
    <div>
      <div className="text-xs" style={{ color: MUT }}>{label}</div>
      <div className="tabular text-xl font-semibold" style={{ color: tone }}>{value}</div>
      <div className="text-xs" style={{ color: MUT }}>{bar}</div>
    </div>
  );
}

const VERDICT_LABEL: Record<string, string> = {
  no_rung_death: "rungless death",
  depth_rail_save: "rail save",
  liquidity_withdrawal_after_bank: "post-bank drain",
  giveback_after_bank: "post-bank giveback",
  clean_capture: "clean capture",
  partial_capture: "partial capture",
  scratch: "scratch",
};

export function VitalsStrip({ v }: { v: VitalsView }) {
  const pct = (x: number | null, d = 0) => (x == null ? "—" : `${x >= 0 ? "" : "−"}${Math.abs(x).toFixed(d)}%`);
  const tone3 = (x: number | null, good: (n: number) => boolean, warn: (n: number) => boolean) =>
    x == null ? MUT : good(x) ? GOOD : warn(x) ? WARN : CRIT;
  return (
    <div className="mb-3">
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <Tile
          label="Armed capture · paper 24h"
          value={pct(v.armedCapturePct)}
          bar="bar ≥40% of the offer once armed"
          tone={tone3(v.armedCapturePct, (n) => n >= 40, (n) => n >= 25)}
        />
        <Tile
          label="Gross W:L · 24h"
          value={v.grossWL == null ? "—" : v.grossWL.toFixed(2)}
          bar="bar ≥1.5 win$ per loss$"
          tone={tone3(v.grossWL, (n) => n >= 1.5, (n) => n >= 1.0)}
        />
        <Tile
          label="Rungless-death tax"
          value={pct(v.runglessTaxPct)}
          bar="bar ≤25% of gross wins"
          tone={tone3(v.runglessTaxPct, (n) => n <= 25, (n) => n <= 40)}
        />
        <Tile
          label="Live drag vs twin"
          value={v.liveDragPp == null ? "—" : `${v.liveDragPp >= 0 ? "+" : "−"}${Math.abs(v.liveDragPp).toFixed(1)}pp`}
          bar="bar ≥ −5pp vs paper"
          tone={tone3(v.liveDragPp, (n) => n >= -5, (n) => n >= -10)}
        />
        <Tile
          label="Board rate · live 24h"
          value={v.liveKilled ? "KILLED" : pct(v.boardRatePct)}
          bar={v.liveKilled ? "operator kill engaged" : "bar 100% of qualified flow"}
          tone={v.liveKilled ? WARN : tone3(v.boardRatePct, (n) => n >= 90, (n) => n >= 50)}
        />
        <Tile
          label="Compound · 24h"
          value={`P ${pct(v.compoundPaperPct, 1)} · L ${pct(v.compoundLivePct, 1)}`}
          bar="mandate 40%/day, each lane"
          tone={tone3(v.compoundPaperPct, (n) => n >= 40, (n) => n >= 0)}
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {v.pareto.map((p) => (
          <span
            key={p.verdict}
            className="rounded px-1.5 py-0.5 text-xs"
            style={{
              color: p.pnl < 0 ? CRIT : "var(--text-secondary)",
              border: `1px solid ${p.pnl < -5 ? CRIT : "var(--border-subtle)"}`,
            }}
          >
            {VERDICT_LABEL[p.verdict] ?? p.verdict} ×{p.n} {p.pnl >= 0 ? "+" : "−"}${Math.abs(p.pnl).toFixed(0)}
          </span>
        ))}
        <span className="rounded px-1.5 py-0.5 text-xs" style={{ color: "var(--text-secondary)", border: "1px solid var(--border-subtle)" }}>
          ⛓ chain-anchored {v.chainMatchedPct == null ? "—" : `${Math.round(v.chainMatchedPct)}%`} of live fills · {v.chainTxs} txs
        </span>
      </div>
    </div>
  );
}
