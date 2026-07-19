"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SystemHealthView } from "@/lib/queries";

const POLL_MS = 20_000;
const LS_KEY = "hermes.systemHealth.open";

function fmtAge(sec: number | null): string {
  if (sec === null) return "—";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
}

function Dot({ ok, warn }: { ok: boolean; warn?: boolean }) {
  const color = ok ? "var(--status-good)" : warn ? "var(--status-warning)" : "var(--status-critical)";
  return (
    <span
      className="inline-block h-2 w-2 shrink-0 rounded-full"
      style={{ background: color, boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 22%, transparent)` }}
    />
  );
}

const OVERALL_LABEL: Record<SystemHealthView["overall"], string> = {
  ok: "All systems live",
  warn: "Degraded feed",
  down: "Attention needed",
};

export function SystemHealth() {
  const [open, setOpen] = useState(false);
  const [health, setHealth] = useState<SystemHealthView | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as SystemHealthView;
      setHealth(data);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally {
      setLoading(false);
    }
  }, []);

  // Keep the pill dot live even while closed; poll faster is unnecessary — the
  // feed probes cost ~3.5s of blocked-host timeouts, so 20s is the right cadence.
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const setOpenPersist = useCallback((v: boolean) => {
    setOpen(v);
    try {
      window.localStorage.setItem(LS_KEY, v ? "1" : "0");
    } catch {
      /* private mode — non-fatal */
    }
  }, []);
  const close = useCallback(() => setOpenPersist(false), [setOpenPersist]);

  // Restore persisted open state after mount (survives a genuine F5; router.refresh
  // is soft and never unmounts us, but a hard reload would otherwise drop the drawer).
  useEffect(() => {
    if (typeof window !== "undefined" && window.localStorage.getItem(LS_KEY) === "1") {
      setOpen(true);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load(); // fresh read on open
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    closeBtnRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close, load]);

  const overall = health?.overall ?? "warn";
  const pillOk = overall === "ok";
  const pillWarn = overall === "warn";

  return (
    <>
      {/* Pin — lives top-right in the header */}
      <button
        onClick={() => setOpenPersist(true)}
        className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs transition-colors hover:brightness-125"
        style={{ background: "var(--surface-1)", border: "1px solid var(--border)", cursor: "pointer" }}
        aria-haspopup="dialog"
        aria-label="System health"
        title={health ? OVERALL_LABEL[overall] : "System health"}
      >
        <Dot ok={pillOk} warn={pillWarn} />
        <span style={{ color: "var(--text-secondary)" }}>System</span>
        {health ? (
          <span className="tabular" style={{ color: "var(--text-muted)" }}>
            {health.pipeline.killSwitch ? "⛔" : `${health.pipeline.openPositions}○`}
          </span>
        ) : null}
      </button>

      {/* Backdrop */}
      <div
        onClick={close}
        aria-hidden
        className="fixed inset-0 z-40 transition-opacity duration-300"
        style={{
          background: "rgba(0,0,0,0.55)",
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
        }}
      />

      {/* Drawer */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="System health"
        className="fixed right-0 top-0 z-50 flex h-full w-[440px] max-w-[94vw] flex-col shadow-2xl transition-transform duration-300 ease-out"
        style={{
          background: "var(--surface-0, var(--background, #0b0d10))",
          borderLeft: "1px solid var(--border)",
          transform: open ? "translateX(0)" : "translateX(100%)",
        }}
      >
        <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: "var(--border)" }}>
          <div className="flex items-center gap-2">
            <Dot ok={pillOk} warn={pillWarn} />
            <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
              System Health
            </h2>
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              {health ? OVERALL_LABEL[overall] : "…"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void load()}
              className="rounded-md px-2 py-1 text-xs transition-colors hover:brightness-125"
              style={{ color: "var(--text-secondary)", background: "var(--surface-1)" }}
              aria-label="Refresh"
            >
              {loading ? "…" : "↻"}
            </button>
            <button
              ref={closeBtnRef}
              onClick={close}
              className="rounded-md px-2 py-1 text-sm transition-colors hover:brightness-125"
              style={{ color: "var(--text-secondary)", background: "var(--surface-1)" }}
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          {err ? (
            <div
              className="rounded-md px-3 py-2 text-xs"
              style={{ background: "rgba(208,59,59,0.12)", border: "1px solid var(--status-critical)", color: "var(--text-secondary)" }}
            >
              Health read failed: {err}
            </div>
          ) : null}

          {/* Services */}
          <section>
            <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
              Services
            </h3>
            <div className="space-y-1.5">
              {(health?.services ?? []).map((s) => (
                <div
                  key={s.name}
                  className="flex items-center justify-between rounded-md px-3 py-2"
                  style={{ background: "var(--surface-1)", border: "1px solid var(--gridline)" }}
                >
                  <div className="flex items-center gap-2">
                    <Dot ok={s.ok} />
                    <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                      {s.name}
                    </span>
                    <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                      {s.detail}
                    </span>
                  </div>
                  <span className="tabular text-xs" style={{ color: s.ok ? "var(--text-secondary)" : "var(--status-critical)" }}>
                    {s.ageSec === null ? "no data" : `${fmtAge(s.ageSec)} ago`}
                  </span>
                </div>
              ))}
              {!health ? <p className="text-xs" style={{ color: "var(--text-muted)" }}>Loading…</p> : null}
            </div>
          </section>

          {/* Sell-route watchdog — the live EXIT path. Alarms before a position needs out. */}
          {health?.sellRoute ? (
            <section>
              <h3 className="mb-2 flex items-center justify-between text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                <span>Sell route · live exit path</span>
                <span
                  className="rounded px-1.5 py-px text-[9px] tracking-normal"
                  style={{
                    color: health.sellRoute.liveEnabled ? "var(--status-critical)" : "var(--text-muted)",
                    border: `1px solid ${health.sellRoute.liveEnabled ? "var(--status-critical)" : "var(--gridline)"}`,
                  }}
                >
                  {health.sellRoute.liveEnabled ? "LIVE" : "PAPER"}
                </span>
              </h3>
              {(() => {
                const sr = health.sellRoute;
                // Failover stack: healthy if ANY swap provider + ANY RPC is up.
                // Only "critical/blocked" when the WHOLE stack is dark AND live.
                const critical = !sr.ok && sr.liveEnabled;
                const bannerColor = sr.ok ? "var(--status-good)" : critical ? "var(--status-critical)" : "var(--status-warning)";
                const bannerBg = sr.ok ? "rgba(63,185,80,0.10)" : critical ? "rgba(208,59,59,0.14)" : "rgba(210,153,34,0.12)";
                const bannerText = sr.ok
                  ? `Exit path clear — failing over via ${sr.activeProvider ?? "a route"}`
                  : critical
                    ? "⚠ ALL SELL ROUTES DARK WHILE LIVE — open positions may be unsellable"
                    : "All sell routes down — go-live blocked until one clears";
                const row = (p: { name: string; ok: boolean; latencyMs: number | null; note: string; dormant?: boolean }) => (
                  <div
                    key={p.name}
                    className="flex items-center justify-between rounded-md px-3 py-1.5"
                    style={{ background: "var(--surface-1)", border: "1px solid var(--gridline)" }}
                  >
                    <div className="flex items-center gap-2">
                      <Dot ok={p.ok} warn={!p.ok && (p.dormant || !sr.liveEnabled)} />
                      <span className="tabular text-[11px] font-medium" style={{ color: "var(--text-primary)" }}>{p.name}</span>
                      {p.name === sr.activeProvider ? (
                        <span className="rounded px-1 py-px text-[8px]" style={{ color: "var(--status-good)", border: "1px solid var(--status-good)" }}>ACTIVE</span>
                      ) : null}
                    </div>
                    <span className="tabular text-[10.5px]" style={{ color: p.ok ? "var(--text-muted)" : p.dormant ? "var(--text-muted)" : "var(--status-warning)" }}>
                      {p.ok ? `${p.latencyMs}ms · ${p.note}` : p.note}
                    </span>
                  </div>
                );
                return (
                  <div className="space-y-1.5">
                    <div className="rounded-md px-3 py-2 text-[11px] font-medium" style={{ background: bannerBg, border: `1px solid ${bannerColor}`, color: bannerColor }}>
                      {bannerText}
                    </div>
                    <div className="pt-1 text-[9px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Swap providers (priority order)</div>
                    {sr.providers.map(row)}
                    <div className="pt-1 text-[9px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>RPC pool (send + confirm)</div>
                    {sr.rpcs.map(row)}
                  </div>
                );
              })()}
            </section>
          ) : null}

          {/* Feeds */}
          <section>
            <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
              Feed reachability
            </h3>
            <div className="grid grid-cols-2 gap-1.5">
              {(health?.feeds ?? []).map((f) => {
                // Optional feeds are known-filtered on this host — down is expected,
                // so show amber ("off, by design") not red ("something broke").
                const optionalDown = !f.ok && !f.essential;
                return (
                  <div
                    key={f.name}
                    className="flex items-center justify-between rounded-md px-3 py-2"
                    style={{ background: "var(--surface-1)", border: "1px solid var(--gridline)" }}
                  >
                    <div className="flex items-center gap-2">
                      <Dot ok={f.ok} warn={optionalDown} />
                      <span className="text-xs font-medium" style={{ color: "var(--text-primary)" }}>
                        {f.name}
                      </span>
                    </div>
                    <span
                      className="tabular text-[11px]"
                      style={{ color: f.ok ? "var(--text-muted)" : optionalDown ? "var(--status-warning)" : "var(--status-critical)" }}
                    >
                      {f.ok ? `${f.latencyMs}ms` : f.note}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>

          {/* PumpPortal WS canary */}
          {health?.pumpportal ? (
            <section>
              <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                PumpPortal · graduation stream
              </h3>
              <div
                className="rounded-md px-3 py-2.5"
                style={{ background: "var(--surface-1)", border: "1px solid var(--gridline)" }}
              >
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Dot ok={health.pumpportal.connected && (health.pumpportal.heartbeatAgeSec ?? 99) < 40} />
                    <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                      {health.pumpportal.connected ? "Connected" : "Disconnected"}
                    </span>
                  </div>
                  <span className="tabular text-xs" style={{ color: "var(--text-muted)" }}>
                    heartbeat {fmtAge(health.pumpportal.heartbeatAgeSec)} ago
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div>
                    <div className="tabular text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
                      {health.pumpportal.migrationsSeen}
                    </div>
                    <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>graduations</div>
                  </div>
                  <div>
                    <div className="tabular text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
                      {fmtAge(health.pumpportal.lastMigrationAgeSec)}
                    </div>
                    <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>last grad</div>
                  </div>
                  <div>
                    <div className="tabular text-sm font-semibold" style={{ color: health.pumpportal.reconnects > 0 ? "var(--status-warning)" : "var(--text-primary)" }}>
                      {health.pumpportal.reconnects}
                    </div>
                    <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>reconnects</div>
                  </div>
                </div>
              </div>
            </section>
          ) : null}

          {/* Pipeline funnel */}
          {health ? (
            <section>
              <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                Pipeline · last 24h
              </h3>
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                {[
                  { label: "scanned", value: health.pipeline.scanned24h },
                  { label: "signals", value: health.pipeline.signals24h },
                  { label: "watching", value: health.pipeline.watching },
                  { label: "armed", value: health.pipeline.armed },
                  { label: "open", value: health.pipeline.openPositions },
                ].map((step, i, arr) => (
                  <div key={step.label} className="flex items-center gap-1.5">
                    <div
                      className="rounded-md px-2.5 py-1.5 text-center"
                      style={{ background: "var(--surface-1)", border: "1px solid var(--gridline)", minWidth: 56 }}
                    >
                      <div className="tabular text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
                        {step.value}
                      </div>
                      <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>{step.label}</div>
                    </div>
                    {i < arr.length - 1 ? <span style={{ color: "var(--text-muted)" }}>→</span> : null}
                  </div>
                ))}
              </div>
              <div className="mt-3 flex items-center justify-between">
                <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                  Equity{" "}
                  <span className="tabular font-semibold" style={{ color: "var(--text-primary)" }}>
                    {health.pipeline.equity === null ? "—" : `$${health.pipeline.equity.toFixed(2)}`}
                  </span>
                </span>
                <span
                  className="rounded px-2 py-0.5 text-[11px] font-medium"
                  style={
                    health.pipeline.killSwitch
                      ? { background: "rgba(208,59,59,0.15)", color: "var(--status-critical)" }
                      : { background: "rgba(63,185,80,0.12)", color: "var(--status-good)" }
                  }
                >
                  {health.pipeline.killSwitch ? "⛔ kill switch engaged" : "● trading live"}
                </span>
              </div>
            </section>
          ) : null}

          {health ? (
            <p className="pt-1 text-[10px]" style={{ color: "var(--text-muted)" }}>
              as of {new Date(health.at).toLocaleTimeString()} · auto-refresh {POLL_MS / 1000}s
            </p>
          ) : null}
        </div>
      </div>
    </>
  );
}
