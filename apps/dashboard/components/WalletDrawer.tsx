"use client";

// WALLET DRAWER — the live-lane hot wallet, clean to manage. Surface shows the
// core glance (armed state · balance · exposure · today's P&L); the drawer holds
// the address (copy), funding CTA, code-enforced caps, premium gate, and kill
// state. Built on the Panel/Drawer standard.
import { useState } from "react";
import { Panel } from "@/components/ui/Drawer";
import { LiveTradeMatrix } from "@/components/LiveTradeMatrix";
import { TradeDNA } from "@/components/TradeDNA";
import type { TradeDna } from "@hermes/core";
import type { WalletStatus } from "@/lib/queries";

const usd = (v: number | null, d = 2) => (v === null ? "—" : `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(d)}`);

function statusOf(w: WalletStatus): { label: string; color: string; note: string } {
  if (w.kill.engaged) return { label: "⛔ KILL ENGAGED", color: "var(--status-critical)", note: w.kill.reason ?? "halted" };
  if (!w.liveEnabled) return { label: "PAPER MODE", color: "var(--text-muted)", note: "live trading disabled" };
  if (!w.configured) return { label: "NO KEY", color: "var(--status-warning)", note: "generate a wallet first" };
  if (!w.funded) return { label: "AWAITING FUNDS", color: "var(--status-warning)", note: "fund to arm the lane" };
  return { label: "● LIVE ARMED", color: "var(--status-good)", note: "trading real capital" };
}

function CopyRow({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-md px-3 py-2" style={{ background: "var(--surface-1)", border: "1px solid var(--gridline)" }}>
      <code className="tabular flex-1 break-all text-[11px]" style={{ color: "var(--text-primary)" }}>{value}</code>
      <button
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="shrink-0 rounded px-2 py-1 text-[11px] transition-colors hover:brightness-125"
        style={{ background: "var(--surface-0, var(--page))", border: "1px solid var(--border)", color: copied ? "var(--status-good)" : "var(--text-secondary)" }}
      >
        {copied ? "copied ✓" : "copy"}
      </button>
    </div>
  );
}

const shortM = (m: string) => `${m.slice(0, 4)}…${m.slice(-4)}`;
const fmtAgo = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
};

export function WalletDrawer({ wallet, dnaByMint }: { wallet: WalletStatus; dnaByMint?: Record<string, TradeDna> }) {
  const s = statusOf(wallet);
  const maxExposure = (wallet.balanceUsd ?? 0) * (wallet.sizer.exposureFracPct / 100);
  const exposurePct = maxExposure > 0 ? (wallet.live.openExposureUsd / maxExposure) * 100 : 0;

  const badge = (
    <span className="rounded px-1.5 py-px text-[10px] font-semibold" style={{ color: s.color, border: `1px solid ${s.color}` }}>
      {s.label}
    </span>
  );

  const cap = (label: string, value: string) => (
    <div className="flex items-center justify-between rounded-md px-3 py-2" style={{ background: "var(--surface-1)", border: "1px solid var(--gridline)" }}>
      <span className="text-xs" style={{ color: "var(--text-muted)" }}>{label}</span>
      <span className="tabular text-xs font-medium" style={{ color: "var(--text-primary)" }}>{value}</span>
    </div>
  );

  return (
    <Panel
      title="Live Wallet"
      badge={badge}
      accent={s.color}
      storageKey="wallet"
      drawerTitle="Live Wallet · management"
      drawerSubtitle={s.note}
      expandLabel="Manage"
      drawer={
        <>
          {/* Status banner */}
          <div className="rounded-md px-3 py-2 text-[12px] font-medium" style={{ background: `color-mix(in srgb, ${s.color} 12%, transparent)`, border: `1px solid ${s.color}`, color: s.color }}>
            {s.label} — {s.note}
          </div>

          {/* Address */}
          <section>
            <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Wallet address</h3>
            {wallet.address ? <CopyRow value={wallet.address} /> : <p className="text-xs" style={{ color: "var(--text-muted)" }}>No wallet configured. Run <code>ops/live/generate-wallet.mjs</code>.</p>}
          </section>

          {/* Balance + funding */}
          <section>
            <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Balance</h3>
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-md px-3 py-2 text-center" style={{ background: "var(--surface-1)", border: "1px solid var(--gridline)" }}>
                <div className="tabular text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{wallet.balanceUsd === null ? "—" : usd(wallet.balanceUsd)}</div>
                <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>USD value</div>
              </div>
              <div className="rounded-md px-3 py-2 text-center" style={{ background: "var(--surface-1)", border: "1px solid var(--gridline)" }}>
                <div className="tabular text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{wallet.balanceSol === null ? "RPC…" : wallet.balanceSol.toFixed(4)}</div>
                <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>SOL</div>
              </div>
              <div className="rounded-md px-3 py-2 text-center" style={{ background: "var(--surface-1)", border: "1px solid var(--gridline)" }}>
                <div className="tabular text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{wallet.solPrice === null ? "—" : usd(wallet.solPrice)}</div>
                <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>SOL price</div>
              </div>
            </div>
            {!wallet.funded && wallet.address ? (
              <div className="mt-2 rounded-md px-3 py-2 text-[11px]" style={{ background: "rgba(250,178,25,0.10)", border: "1px solid var(--status-warning)", color: "var(--text-secondary)" }}>
                Fund with <strong>~$55–60 of native SOL</strong> (not USDC) to arm the lane. Pocket change only — exposure caps at {wallet.sizer.exposureFracPct.toFixed(0)}% of balance ({usd(maxExposure, 0)}).
              </div>
            ) : null}
          </section>

          {/* The Sizer — regime + balance aware (NOT flat hard-caps) */}
          <section>
            <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Sizer · regime + balance aware</h3>
            <div className="space-y-1.5">
              {cap("Base position", `${wallet.sizer.sizeFracPct.toFixed(0)}% of balance × regime`)}
              {cap("Per-position range", `${usd(wallet.sizer.minPositionUsd, 2)} floor → ${wallet.sizer.maxPositionFracPct.toFixed(0)}% of balance`)}
              {cap("Max exposure", `${wallet.sizer.exposureFracPct.toFixed(0)}% of balance (${usd(maxExposure, 0)})`)}
              {cap("Max concurrent", `${wallet.caps.maxConcurrent} (exposure-bounded)`)}
              {cap("Daily loss cap", `−${usd(wallet.caps.dailyLossCapUsd, 0)} · kill −${usd(wallet.caps.killLossUsd, 0)}`)}
              {cap("Venue gate", wallet.premiumOnly ? "PREMIUM only (proven-profitable ∪ promoted ∪ prime)" : "off")}
            </div>
          </section>

          {/* Bleeding-regime gate */}
          <section>
            <div
              className="rounded-md px-3 py-2 text-[11px]"
              style={
                wallet.regime.bleeding
                  ? { background: "rgba(250,178,25,0.12)", border: "1px solid var(--status-warning)", color: "var(--text-secondary)" }
                  : { background: "var(--surface-1)", border: "1px solid var(--gridline)", color: "var(--text-secondary)" }
              }
            >
              <span style={{ color: wallet.regime.bleeding ? "var(--status-warning)" : "var(--status-good)", fontWeight: 600 }}>
                {wallet.regime.bleeding ? "⚠ REGIME BLEEDING — live standing down" : "✓ Regime OK"}
              </span>{" "}
              {wallet.regime.mirror ? (
                <>
                  — {wallet.regime.scope} edge{" "}
                  {wallet.regime.windowEdgePct === null ? "n/a" : `${wallet.regime.windowEdgePct.toFixed(0)}%`} ({usd(wallet.regime.windowPnlUsd)} on {usd(wallet.regime.windowGrossUsd, 0)} deployed) over {wallet.regime.windowMin}m; live pauses only below −{wallet.regime.maxLossPct.toFixed(0)}% edge (needs ≥{usd(wallet.regime.minGrossUsd, 0)} deployed). Open positions still manage/exit.
                </>
              ) : (
                <>
                  — paper (the sensor) {usd(wallet.regime.windowPnlUsd)} over {wallet.regime.windowMin}m; live pauses new entries below −{usd(wallet.regime.maxLossUsd, 0)}. Open positions still manage/exit.
                </>
              )}
            </div>
          </section>

          {/* Trade-for-trade */}
          <section>
            <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Trade for trade · live</h3>
            {wallet.recentTrades.length === 0 ? (
              <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>No live trades yet.</p>
            ) : (
              <div className="space-y-1">
                {wallet.recentTrades.map((t, i) => (
                  <div key={`${t.mint}-${i}`} className="flex items-center justify-between rounded-md px-3 py-1.5" style={{ background: "var(--surface-1)", border: "1px solid var(--gridline)" }}>
                    <div className="flex items-center gap-2">
                      <a href={`https://solscan.io/token/${t.mint}`} target="_blank" rel="noreferrer" className="tabular text-[11px] hover:underline" style={{ color: "var(--text-primary)" }}>
                        {t.symbol ?? shortM(t.mint)}
                      </a>
                      <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>{usd(t.sizeUsd, 2)}</span>
                      {t.status === "open" ? (
                        <span className="rounded px-1 py-0.5 text-[9px] font-bold" style={{ background: "rgba(57,135,229,0.15)", color: "var(--series-1)" }}>OPEN</span>
                      ) : (
                        <span className="text-[9px]" style={{ color: "var(--text-muted)" }}>{t.exitReason ?? "closed"}</span>
                      )}
                      {t.status === "open" && dnaByMint?.[t.mint] ? <TradeDNA dna={dnaByMint[t.mint]!} showClock={false} /> : null}
                    </div>
                    <div className="flex items-center gap-2">
                      {t.status === "open" && t.markUsd != null ? (
                        <span className="tabular text-[11px] font-medium" style={{ color: t.markUsd - t.sizeUsd >= 0 ? "var(--status-good)" : "var(--status-critical)" }} title={`mark ${usd(t.markUsd, 2)} vs cost ${usd(t.sizeUsd, 2)}`}>
                          {usd(t.markUsd, 2)} ({t.markUsd - t.sizeUsd >= 0 ? "+" : ""}{usd(t.markUsd - t.sizeUsd, 2)})
                        </span>
                      ) : (
                        <span className="tabular text-[11px] font-medium" style={{ color: t.pnlUsd >= 0 ? "var(--status-good)" : "var(--status-critical)" }}>
                          {t.pnlUsd >= 0 ? "+" : ""}{usd(t.pnlUsd, 2)}
                        </span>
                      )}
                      <span suppressHydrationWarning className="tabular text-[9px]" style={{ color: "var(--text-muted)" }}>{fmtAgo(t.openedAt)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Live P&L */}
          <section>
            <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Live lane · realized</h3>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-md px-3 py-2" style={{ background: "var(--surface-1)", border: "1px solid var(--gridline)" }}>
                <div className="tabular text-sm font-semibold" style={{ color: wallet.live.cumRealizedUsd >= 0 ? "var(--status-good)" : "var(--status-critical)" }}>{usd(wallet.live.cumRealizedUsd)}</div>
                <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>cumulative ({wallet.live.closes} closes)</div>
              </div>
              <div className="rounded-md px-3 py-2" style={{ background: "var(--surface-1)", border: "1px solid var(--gridline)" }}>
                <div className="tabular text-sm font-semibold" style={{ color: wallet.live.todayRealizedUsd >= 0 ? "var(--status-good)" : "var(--status-critical)" }}>{usd(wallet.live.todayRealizedUsd)}</div>
                <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>today · toward −{usd(wallet.caps.dailyLossCapUsd, 0)} cap</div>
              </div>
            </div>
            {wallet.live.openPositions > 0 ? (
              <div className="mt-2 flex items-center justify-between rounded-md px-3 py-2" style={{ background: "var(--surface-1)", border: "1px solid var(--gridline)" }}>
                <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                  Open (marked): {usd(wallet.live.openMarkUsd, 2)} vs cost {usd(wallet.live.openExposureUsd, 2)}
                </span>
                <span className="tabular text-[11px] font-medium" style={{ color: wallet.live.unrealizedUsd >= 0 ? "var(--status-good)" : "var(--status-critical)" }}>
                  unreal {wallet.live.unrealizedUsd >= 0 ? "+" : ""}{usd(wallet.live.unrealizedUsd, 2)}
                </span>
              </div>
            ) : null}
            {wallet.live.closes === 0 && wallet.live.openPositions === 0 ? (
              <p className="mt-2 text-[11px]" style={{ color: "var(--text-muted)" }}>No live trades yet — the lane mirrors paper&apos;s premium-venue entries once funded and enabled.</p>
            ) : null}
          </section>

          {wallet.kill.engaged ? (
            <div className="rounded-md px-3 py-2 text-[11px]" style={{ background: "rgba(208,59,59,0.12)", border: "1px solid var(--status-critical)", color: "var(--text-secondary)" }}>
              <strong style={{ color: "var(--status-critical)" }}>Kill switch engaged:</strong> {wallet.kill.reason}. Live buys refused until cleared after a fresh paper re-qualification.
            </div>
          ) : null}
        </>
      }
    >
      {/* CORE glance */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <div>
          <div className="tabular text-lg font-semibold" style={{ color: "var(--text-primary)" }}>{wallet.balanceUsd === null ? (wallet.address ? "RPC…" : "—") : usd(wallet.balanceUsd)}</div>
          <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>{wallet.balanceSol === null ? "balance" : `${wallet.balanceSol.toFixed(3)} SOL`}</div>
        </div>
        <div>
          <div className="tabular text-sm font-medium" style={{ color: "var(--text-secondary)" }}>{usd(wallet.live.openExposureUsd, 0)} / {usd(maxExposure, 0)}</div>
          <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>exposure · {wallet.live.openPositions} open</div>
        </div>
        <div>
          <div className="tabular text-sm font-medium" style={{ color: wallet.live.cumRealizedUsd >= 0 ? "var(--status-good)" : "var(--status-critical)" }}>{usd(wallet.live.cumRealizedUsd)}</div>
          <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>live realized ({wallet.live.closes})</div>
        </div>
        {wallet.regime.bleeding ? (
          <div>
            <div className="text-sm font-medium" style={{ color: "var(--status-warning)" }}>⚠ paused</div>
            <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>regime bleeding</div>
          </div>
        ) : null}
        {wallet.address ? (
          <div className="ml-auto tabular text-[10px]" style={{ color: "var(--text-muted)" }} title={wallet.address}>
            {wallet.address.slice(0, 4)}…{wallet.address.slice(-4)}
          </div>
        ) : null}
      </div>
      {/* exposure bar */}
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full" style={{ background: "var(--gridline)" }}>
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, exposurePct)}%`, background: s.color }} />
      </div>
      {/* mini trade matrix — live book at a glance, no tab needed */}
      <div className="mt-3">
        <LiveTradeMatrix trades={wallet.recentTrades} />
      </div>
    </Panel>
  );
}
