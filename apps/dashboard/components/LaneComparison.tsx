// LANE COMPARISON — paper vs live, side by side. Live takes FEWER, higher-quality
// trades by design (premium-venue gate + hard caps), so the story is DIVERGENCE,
// not two P&L curves: paper opened N → live mirrored M → skipped K, with reasons.
// The skip breakdown explains exactly why live is more selective. On the Panel
// standard: core = the two lanes + funnel headline; drawer = full skip reasons.
import { Panel } from "@/components/ui/Drawer";
import type { LaneComparison as LC, LaneStats } from "@/lib/queries";

const usd = (v: number, d = 2) => `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(d)}`;
const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
const mult = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)}×`);

const REASON_LABEL: Record<string, string> = {
  disabled: "live disabled",
  "no wallet key": "no wallet",
  "no SOL price": "no SOL price",
  "concurrency cap": "at concurrency cap",
  "already held": "already held",
  "kill criterion met": "kill criterion",
  "live_kill engaged": "kill engaged",
  "honeypot not affirmatively verified": "honeypot unverified",
};
const reasonLabel = (r: string) => REASON_LABEL[r] ?? (r.startsWith("venue not premium") ? "venue not premium" : r.startsWith("daily loss cap") ? "daily loss cap" : r.startsWith("price impact") ? "price impact" : r);

function LaneCard({ name, color, s }: { name: string; color: string; s: LaneStats }) {
  return (
    <div className="flex-1 rounded-md p-3" style={{ background: "var(--surface-1)", border: "1px solid var(--gridline)" }}>
      <div className="mb-2 flex items-center gap-2">
        <span className="h-2 w-2 rounded-full" style={{ background: color }} />
        <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--text-primary)" }}>{name}</span>
      </div>
      <div className="tabular text-lg font-semibold" style={{ color: s.realizedUsd >= 0 ? "var(--status-good)" : "var(--status-critical)" }}>
        {usd(s.realizedUsd)}
      </div>
      <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>realized · 24h</div>
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]" style={{ color: "var(--text-secondary)" }}>
        <span>Opens <span className="tabular" style={{ color: "var(--text-primary)" }}>{s.opens}</span></span>
        <span>Closes <span className="tabular" style={{ color: "var(--text-primary)" }}>{s.closes}</span></span>
        <span>Win <span className="tabular" style={{ color: "var(--text-primary)" }}>{pct(s.winRate)}</span></span>
        <span>Best <span className="tabular" style={{ color: "var(--text-primary)" }}>{mult(s.bestPeakX)}</span></span>
      </div>
    </div>
  );
}

export function LaneComparison({ cmp }: { cmp: LC }) {
  const { paper, live, funnel } = cmp;
  const maxSkip = Math.max(1, ...funnel.skipReasons.map((r) => r.count));

  const badge = (
    <span className="rounded px-1.5 py-px text-[10px]" style={{ color: "var(--text-muted)", border: "1px solid var(--gridline)" }}>
      {funnel.paperOpens} paper → {funnel.liveOpens} live · {cmp.window}
    </span>
  );

  return (
    <Panel
      title="Paper vs Live"
      badge={badge}
      accent="var(--series-1)"
      storageKey="lane-comparison"
      drawerTitle="Paper vs Live · divergence"
      drawerSubtitle="why live is more selective"
      expandLabel="Divergence"
      drawer={
        <>
          <div className="flex gap-2">
            <LaneCard name="Paper" color="var(--series-1)" s={paper} />
            <LaneCard name="Live" color="var(--status-good)" s={live} />
          </div>

          {/* Funnel */}
          <section>
            <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Entry funnel · 24h</h3>
            <div className="flex items-center gap-1.5 text-xs">
              {[
                { k: "paper opened", v: funnel.paperOpens },
                { k: "live took", v: funnel.liveOpens },
                { k: "skipped", v: funnel.liveSkips },
                { k: "failed", v: funnel.liveFails },
              ].map((step, i, arr) => (
                <div key={step.k} className="flex items-center gap-1.5">
                  <div className="rounded-md px-2.5 py-1.5 text-center" style={{ background: "var(--surface-1)", border: "1px solid var(--gridline)", minWidth: 62 }}>
                    <div className="tabular text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{step.v}</div>
                    <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>{step.k}</div>
                  </div>
                  {i < arr.length - 1 ? <span style={{ color: "var(--text-muted)" }}>→</span> : null}
                </div>
              ))}
            </div>
          </section>

          {/* Skip reasons — the gold: WHY live is more selective */}
          <section>
            <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Why live skipped</h3>
            {funnel.skipReasons.length === 0 ? (
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>No skips recorded — live either took or hasn&apos;t evaluated any entries yet.</p>
            ) : (
              <div className="space-y-1.5">
                {funnel.skipReasons.map((r) => (
                  <div key={r.reason} className="flex items-center gap-2">
                    <span className="w-36 shrink-0 truncate text-[11px]" style={{ color: "var(--text-secondary)" }} title={r.reason}>{reasonLabel(r.reason)}</span>
                    <div className="h-4 flex-1 overflow-hidden rounded" style={{ background: "var(--gridline)" }}>
                      <div className="h-full rounded" style={{ width: `${(r.count / maxSkip) * 100}%`, background: "var(--status-warning)", opacity: 0.7 }} />
                    </div>
                    <span className="tabular w-8 shrink-0 text-right text-[11px]" style={{ color: "var(--text-primary)" }}>{r.count}</span>
                  </div>
                ))}
              </div>
            )}
            <p className="mt-2 text-[10.5px]" style={{ color: "var(--text-muted)" }}>
              Live is deliberately more selective than paper — the premium-venue gate + hard caps mean fewer, higher-quality shots. Divergence here is the design working, not a miss.
            </p>
          </section>
        </>
      }
    >
      {/* CORE glance */}
      <div className="flex gap-2">
        <LaneCard name="Paper" color="var(--series-1)" s={paper} />
        <LaneCard name="Live" color="var(--status-good)" s={live} />
      </div>
      {live.opens === 0 ? (
        <p className="mt-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
          Live lane dormant — {funnel.paperOpens} paper entries in 24h; live begins mirroring premium-venue entries once funded &amp; enabled.
        </p>
      ) : (
        <p className="mt-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
          {funnel.liveOpens} of {funnel.paperOpens} paper entries mirrored live · {funnel.liveSkips} skipped (see divergence).
        </p>
      )}
    </Panel>
  );
}
