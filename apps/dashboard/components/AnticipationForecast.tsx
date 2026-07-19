"use client";

import { Panel } from "@/components/ui/Drawer";
import type { AnticipationView } from "@/lib/queries";

/**
 * ANTICIPATION FORECAST — the forward-looking brain. Answers "what's coming":
 * WHEN the next prime window is, WHERE flow is heating/cooling, and the TAIL ODDS
 * for the current window. Every number is measured from the recorder + hour policy.
 */

function fmtEt(h: number): string {
  const ap = h < 12 ? "a" : "p";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}${ap}`;
}
function policyColor(p: string): string {
  return p === "prime" ? "var(--status-good)" : p === "probe" ? "var(--status-warning)" : "var(--text-muted)";
}

export function AnticipationForecast({ view }: { view: AnticipationView }) {
  const { timeline, venues, tail, nextPrime, nowPolicy } = view;
  const maxAbs = Math.max(1, ...timeline.map((t) => Math.abs(t.realizedHist ?? 0)));
  const maxTail = Math.max(1, ...timeline.map((t) => t.tailHist));

  const nowLabel =
    nowPolicy === "prime" ? "PRIME — hunting" : nowPolicy === "probe" ? "PROBE — reduced size" : "OFF-HOURS — throttled";
  const nowColor = policyColor(nowPolicy);

  const nextLine = nextPrime ? (
    <>
      next prime in <strong style={{ color: "var(--status-good)" }}>{nextPrime.inHours}h</strong> ({fmtEt(nextPrime.etHour)} ET)
    </>
  ) : nowPolicy === "prime" ? (
    "prime window open now"
  ) : (
    "no prime window in next 12h"
  );
  return (
    <Panel
      title="🎯 Anticipation"
      badge={<span className="rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide" style={{ color: nowColor, border: `1px solid ${nowColor}` }}>{nowLabel}</span>}
      accent={nowColor}
      storageKey="anticipation"
      drawerTitle="Anticipation · when / where / tail odds"
      drawerSubtitle="forward 12h · venue momentum · moonshot odds"
      expandLabel="Forecast detail"
      drawer={
        <div>
          {/* WHEN — forward 12h timeline */}
      <div className="mb-1 text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
        Next 12 hours · bar = measured hourly P&amp;L · ★ = tail hour
      </div>
      <div className="flex items-end gap-1 overflow-x-auto pb-1" style={{ height: 78 }}>
        {timeline.map((t) => {
          const pnl = t.realizedHist ?? 0;
          const h = Math.round((Math.abs(pnl) / maxAbs) * 40);
          const up = pnl >= 0;
          const isNow = t.inHours === 0;
          const hot = t.tailHist / maxTail >= 0.6 && t.tailHist > 0;
          return (
            <div
              key={t.inHours}
              className="flex shrink-0 flex-col items-center justify-end"
              style={{ width: 26, height: 72 }}
              title={`${fmtEt(t.etHour)} ET · ${t.policy} · hist P&L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(0)} · ${t.tailHist} tail · ${t.watchedHist} flow`}
            >
              <span className="mb-0.5 text-[9px]" style={{ color: hot ? "var(--status-good)" : "var(--text-muted)" }}>
                {hot ? "★" : ""}
              </span>
              {/* P&L bar (diverging around a baseline) */}
              <div className="flex w-full flex-col items-center justify-end" style={{ height: 40 }}>
                <div
                  className="w-[10px] rounded-t-[2px]"
                  style={{ height: Math.max(2, h), background: up ? "var(--status-good)" : "var(--status-critical)", opacity: isNow ? 1 : 0.7 }}
                />
              </div>
              {/* policy tick + hour */}
              <div className="mt-1 h-1 w-full rounded-full" style={{ background: policyColor(t.policy), opacity: t.policy === "unmeasured" ? 0.35 : 0.9 }} />
              <span
                className="mt-0.5 text-[9px]"
                style={{ color: isNow ? "var(--text-primary)" : "var(--text-muted)", fontWeight: isNow ? 700 : 400 }}
              >
                {isNow ? "now" : fmtEt(t.etHour)}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mb-3 mt-1 flex items-center gap-3 text-[9px]" style={{ color: "var(--text-muted)" }}>
        <span className="flex items-center gap-1"><span className="inline-block h-1.5 w-3 rounded-full" style={{ background: "var(--status-good)" }} />prime</span>
        <span className="flex items-center gap-1"><span className="inline-block h-1.5 w-3 rounded-full" style={{ background: "var(--status-warning)" }} />probe</span>
        <span className="flex items-center gap-1"><span className="inline-block h-1.5 w-3 rounded-full" style={{ background: "var(--text-muted)" }} />off-hours</span>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {/* WHERE — venue momentum */}
        <div>
          <div className="mb-1.5 text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
            Where · venue momentum (3h vs prior)
          </div>
          <div className="space-y-1">
            {venues.length === 0 ? (
              <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>No venue flow in the last 3h.</p>
            ) : (
              venues.slice(0, 6).map((v) => {
                const arrow = v.momentum === "heating" ? "▲" : v.momentum === "cooling" ? "▼" : "—";
                const color = v.momentum === "heating" ? "var(--status-good)" : v.momentum === "cooling" ? "var(--status-critical)" : "var(--text-muted)";
                return (
                  <div key={v.venue} className="flex items-center justify-between rounded-md px-2.5 py-1.5" style={{ background: "var(--surface-1)", border: "1px solid var(--gridline)" }}>
                    <div className="flex items-center gap-2">
                      <span style={{ color, fontWeight: 700 }}>{arrow}</span>
                      <span className="tabular text-[11px]" style={{ color: "var(--text-primary)" }}>{v.venue}</span>
                      <span className="rounded px-1 py-px text-[8px] uppercase" style={{ color: "var(--text-muted)", border: "1px solid var(--gridline)" }}>{v.state}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="tabular text-[11px] font-medium" style={{ color: v.recentPnl >= 0 ? "var(--status-good)" : "var(--status-critical)" }}>
                        {v.recentPnl >= 0 ? "+" : ""}${v.recentPnl.toFixed(0)}
                      </span>
                      <span className="tabular text-[9px]" style={{ color: "var(--text-muted)" }}>{v.winPct == null ? "" : `${v.winPct.toFixed(0)}% · ${v.recentN}`}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* TAIL ODDS */}
        <div>
          <div className="mb-1.5 text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
            Tail odds · this window
          </div>
          <div className="rounded-md px-3 py-3" style={{ background: "var(--surface-1)", border: "1px solid var(--gridline)" }}>
            <div className="flex items-baseline gap-2">
              <span
                className="text-lg font-bold uppercase"
                style={{ color: tail.odds === "elevated" ? "var(--status-good)" : tail.odds === "low" ? "var(--status-critical)" : "var(--text-secondary)" }}
              >
                {tail.odds}
              </span>
              <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>moonshot odds now</span>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2 text-center">
              <div>
                <div className="tabular text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{tail.last24h}</div>
                <div className="text-[9px]" style={{ color: "var(--text-muted)" }}>3×+ / 24h</div>
              </div>
              <div>
                <div className="tabular text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{tail.ratePerHr.toFixed(1)}</div>
                <div className="text-[9px]" style={{ color: "var(--text-muted)" }}>per hour</div>
              </div>
              <div>
                <div className="tabular text-sm font-semibold" style={{ color: "var(--status-good)" }}>{tail.bestHourEt == null ? "—" : `${fmtEt(tail.bestHourEt)}`}</div>
                <div className="text-[9px]" style={{ color: "var(--text-muted)" }}>hottest hr</div>
              </div>
            </div>
          </div>
        </div>
      </div>
        </div>
      }
    >
      {/* surface glance — window status + next-prime countdown */}
      <div className="text-[12px]" style={{ color: "var(--text-secondary)" }}>{nextLine}</div>
    </Panel>
  );
}
