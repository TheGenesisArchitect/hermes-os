import type { TradeDna, DnaState } from "@hermes/core";

/**
 * TradeDNA — the shared live health chip (docs/trade-dna-health.md). One readout on every
 * scorecard: state + health score + the moonshot clock. Green = winner shape, ride it;
 * a red clock past prime = off-genome, manage it out.
 */
const STATE_STYLE: Record<DnaState, { label: string; color: string }> = {
  IGNITION: { label: "IGNITION", color: "var(--status-warning)" },
  RIDE: { label: "RIDE", color: "var(--status-good)" },
  PEAKING: { label: "PEAKING", color: "var(--series-2, #4aa3c7)" },
  DECAY: { label: "DECAY", color: "var(--status-warning)" },
  DEAD: { label: "DEAD", color: "var(--status-critical)" },
  STILLBORN: { label: "STILLBORN", color: "var(--text-muted)" }, // never lifted — dud, size it down
};

export function TradeDNA({ dna, showClock = true }: { dna: TradeDna | null; showClock?: boolean }) {
  if (!dna) return <span style={{ color: "var(--text-muted)" }}>—</span>;
  const s = STATE_STYLE[dna.state] ?? STATE_STYLE.IGNITION;
  const clockFill = Math.min(1, dna.clockPct);
  const clockColor = dna.pastPrime ? "var(--status-critical)" : dna.provenRunner ? "var(--status-good)" : "var(--text-muted)";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide"
        style={{ color: s.color, border: `1px solid ${s.color}` }}
      >
        {s.label}
      </span>
      <span className="tabular text-[11px]" style={{ color: "var(--text-secondary)" }} title="health score (continuation × clock)">
        {dna.healthScore}
      </span>
      {showClock && (
        <span
          className="inline-flex items-center gap-1"
          title={`moonshot clock ${(dna.clockPct * 100).toFixed(0)}%${dna.pastPrime ? " · PAST PRIME" : ""}${dna.provenRunner ? " · proven runner (exempt)" : ""}`}
        >
          <span className="relative inline-block h-1.5 w-8 overflow-hidden rounded-full" style={{ background: "var(--gridline)" }}>
            <span className="absolute left-0 top-0 h-full rounded-full" style={{ width: `${clockFill * 100}%`, background: clockColor }} />
          </span>
          <span className="tabular text-[9px]" style={{ color: dna.pastPrime ? "var(--status-critical)" : "var(--text-muted)" }}>
            {Math.round(dna.clockPct * 100)}%
          </span>
        </span>
      )}
    </span>
  );
}
