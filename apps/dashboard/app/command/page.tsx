/**
 * /command — THE COCKPIT (operator 2026-07-26: "how do we ensure that I am
 * available to harvest?"). Only the action surface: vitals, environment, the
 * open book with boarding cards, the harvest button, and the last 30m of
 * closes. ~5 light queries → sub-second render, 5s auto-refresh. The heavy
 * analytics stay on /.
 */
import { ArmSwitch } from "@/components/ArmSwitch";
import { AutoRefresh } from "@/components/AutoRefresh";
import { EnvironmentStrip } from "@/components/EnvironmentStrip";
import { HarvestButton } from "@/components/HarvestButton";
import { ManagementBoard } from "@/components/ManagementBoard";
import { VitalsStrip } from "@/components/VitalsStrip";
import {
  getChainPulse,
  getEnvironment,
  getManagedPositions,
  getRecentCloses,
  getVitals,
} from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function CommandPage() {
  const [vitals, environment, managed, chain, recent] = await Promise.all([
    getVitals(),
    getEnvironment(),
    getManagedPositions(),
    getChainPulse(),
    getRecentCloses(30),
  ]);
  const managedView = managed.map((p) => ({ ...p, openedAt: p.openedAt.toISOString() }));
  const paper = managed.filter((p) => p.lane === "paper");
  const greens = paper.filter((p) => p.unrealizedNetUsd > 0);
  const sellable = greens.filter((p) => p.sellableNow);
  const sellableUsd = sellable.reduce((s, p) => s + p.unrealizedNetUsd, 0);
  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <AutoRefresh ms={5_000} />
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
          Command · the working book
        </h1>
        <span className="flex items-center gap-4"><ArmSwitch armed={!vitals.liveKilled} /><HarvestButton greenCount={sellable.length} greenUsd={sellableUsd} suspendedCount={greens.length - sellable.length} /></span>
      </div>
      <VitalsStrip v={vitals} />
      <EnvironmentStrip v={environment} />
      <ManagementBoard positions={managedView} chain={chain} />
      {recent.length > 0 && (
        <section className="mt-5">
          <h2 className="mb-2 text-xs uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
            closed · last 30m
          </h2>
          <div className="grid gap-2 md:grid-cols-3">
            {recent.map((r) => (
              <div key={r.id} className="card px-3 py-2 text-xs">
                <div className="flex items-baseline justify-between">
                  <span className="font-medium">{r.lane === "live" ? "◆ " : ""}{r.symbol ?? r.mint.slice(0, 6)}</span>
                  <span className="tabular font-semibold" style={{ color: r.pnl >= 0 ? "var(--status-good)" : "var(--status-critical)" }}>
                    {r.pnl >= 0 ? "+" : "−"}${Math.abs(r.pnl).toFixed(2)}
                  </span>
                </div>
                <div style={{ color: "var(--text-muted)" }}>
                  {r.signature ?? "—"} · ${r.sizeUsd.toFixed(2)} · peak {r.peakx.toFixed(2)}× · {r.rungs} rung{r.rungs === 1 ? "" : "s"} · {r.exitReason ?? "?"}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
