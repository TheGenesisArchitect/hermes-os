/**
 * ENVIRONMENT STRIP — Command Center phase C2 (ratified 2026-07-25).
 *
 * The funnel condensed into one read-only context row beneath the vitals:
 * arrivals → qualified → boarded (coverage), the session, the F6 launch-order
 * mix, the adversary weather (settled rug share with a 2h trend), and the
 * live moon queue — every 2★/crowd-pass trigger of the last 25 minutes with
 * its boarded/waiting state. Weather is read-only by design: no controls.
 */
import type { EnvironmentView } from "@/lib/queries";

const MUT = "var(--text-muted)";
const SEC = "var(--text-secondary)";

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <span className="text-xs whitespace-nowrap" style={{ color: MUT }}>
      {label} <span className="tabular font-medium" style={{ color: tone ?? SEC }}>{value}</span>
    </span>
  );
}

export function EnvironmentStrip({ v }: { v: EnvironmentView }) {
  const weatherTone =
    v.rugShare2h == null ? MUT : v.rugShare2h >= 45 ? "var(--status-critical)" : v.rugShare2h >= 30 ? "#c9a94a" : "var(--status-good)";
  const trend =
    v.rugShare2h == null || v.rugSharePrev2h == null
      ? ""
      : v.rugShare2h - v.rugSharePrev2h > 3 ? " ↑" : v.rugSharePrev2h - v.rugShare2h > 3 ? " ↓" : " →";
  return (
    <div
      className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-2 rounded px-3 py-2"
      style={{ border: "1px solid var(--border-subtle)" }}
    >
      <Stat label="arrivals/h" value={String(v.arrivalsHr)} />
      <Stat label="qualified" value={String(v.qualifiedHr)} />
      <Stat
        label="boarded"
        value={`${v.enteredHr}${v.coveragePct == null ? "" : ` (${Math.round(v.coveragePct)}%)`}`}
        tone={v.coveragePct != null && v.coveragePct >= 90 ? "var(--status-good)" : SEC}
      />
      <Stat label="session" value={v.session.toUpperCase()} tone={v.session === "prime" ? "var(--status-good)" : SEC} />
      {v.launchMix.length > 0 && (
        <Stat
          label="launch mix 6h"
          value={v.launchMix.map((l) => `${l.bucket} ${l.n}`).join(" · ")}
        />
      )}
      <Stat
        label="weather"
        value={v.rugShare2h == null ? "—" : `${Math.round(v.rugShare2h)}% rug${trend}`}
        tone={weatherTone}
      />
      {v.drainCutsHr > 0 && <Stat label="drain cuts/h" value={String(v.drainCutsHr)} tone="#c9a94a" />}
      {v.moonQueue.length > 0 && (
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs" style={{ color: MUT }}>queue</span>
          {v.moonQueue.map((m, i) => (
            <span
              key={`${m.symbol}-${i}`}
              className="rounded px-1.5 py-0.5 text-xs whitespace-nowrap"
              style={{
                color: m.entered ? "var(--status-good)" : "#c9a94a",
                border: "1px solid var(--border-subtle)",
              }}
              title={`${m.signature ?? "?"} · ${m.stars ?? 0}★ · crowd ${m.wh ?? "?"}W/${m.rh ?? "?"}R · lg ${m.lg?.toFixed(2) ?? "—"} · ${m.trigMin.toFixed(0)}m ago`}
            >
              {m.entered ? "◉" : "○"} {m.symbol ?? "?"}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
