"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Kpi, EdgePoint, ForecastView } from "@/lib/queries";
import { KpiStrip } from "@/components/KpiStrip";
import { EdgeChart } from "@/components/EdgeChart";
import { ForecastChart } from "@/components/ForecastChart";

const LS_KEY = "hermes.intelTerminal.open";

function Teaser({ kpis, onOpen }: { kpis: Kpi[]; onOpen: () => void }) {
  const edge = kpis.find((k) => k.key === "edge");
  const trig = kpis.find((k) => k.key === "triggers");
  return (
    <button
      onClick={onOpen}
      className="card flex w-full items-center justify-between gap-4 p-3 text-left transition-colors hover:brightness-110"
      style={{ cursor: "pointer" }}
      aria-haspopup="dialog"
    >
      <div className="flex items-center gap-3">
        <span
          className="grid h-8 w-8 place-items-center rounded-md text-sm"
          style={{ background: "var(--surface-2, var(--surface-1))", color: "var(--series-1)" }}
        >
          ◧
        </span>
        <div>
          <div className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
            Intel Terminal
          </div>
          <div className="text-xs" style={{ color: "var(--text-muted)" }}>
            KPIs · edge trend · methodology — computed from the data
          </div>
        </div>
      </div>
      <div className="flex items-center gap-4">
        {edge && edge.value !== null ? (
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
              Edge
            </div>
            <div className="tabular text-sm font-semibold" style={{ color: "var(--status-good)" }}>
              {edge.value.toFixed(1)}:1
            </div>
          </div>
        ) : null}
        {trig ? (
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
              ⚡ 24h
            </div>
            <div className="tabular text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
              {trig.value ?? 0}
            </div>
          </div>
        ) : null}
        <span className="text-sm" style={{ color: "var(--text-secondary)" }}>
          Open ▸
        </span>
      </div>
    </button>
  );
}

export function IntelTerminal({
  kpis,
  edgeSeries,
  forecast,
  newsHeadline,
  newsTopTheme,
  children,
}: {
  kpis: Kpi[];
  edgeSeries: EdgePoint[];
  forecast: ForecastView;
  newsHeadline?: string | null;
  newsTopTheme?: string | null;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  // Restore persisted open state after mount (avoids SSR hydration mismatch).
  useEffect(() => {
    if (typeof window !== "undefined" && window.localStorage.getItem(LS_KEY) === "1") {
      setOpen(true);
    }
  }, []);

  const setOpenPersist = useCallback((v: boolean) => {
    setOpen(v);
    try {
      window.localStorage.setItem(LS_KEY, v ? "1" : "0");
    } catch {
      /* private mode — non-fatal */
    }
  }, []);

  const close = useCallback(() => setOpenPersist(false), [setOpenPersist]);

  // ESC to close; lock body scroll while open; focus the close button on open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeBtnRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, close]);

  return (
    <>
      <Teaser kpis={kpis} onOpen={() => setOpenPersist(true)} />

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

      {/* Drawer panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Intel Terminal"
        className="fixed right-0 top-0 z-50 flex h-full w-[560px] max-w-[94vw] flex-col shadow-2xl transition-transform duration-300 ease-out"
        style={{
          background: "var(--surface-0, var(--background, #0b0d10))",
          borderLeft: "1px solid var(--border)",
          transform: open ? "translateX(0)" : "translateX(100%)",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between border-b px-4 py-3"
          style={{ borderColor: "var(--border)" }}
        >
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: "var(--status-good)", boxShadow: "0 0 0 3px color-mix(in srgb, var(--status-good) 25%, transparent)" }}
            />
            <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
              Intel Terminal
            </h2>
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              live · no black box
            </span>
          </div>
          <button
            ref={closeBtnRef}
            onClick={close}
            className="rounded-md px-2 py-1 text-sm transition-colors hover:brightness-125"
            style={{ color: "var(--text-secondary)", background: "var(--surface-1)" }}
            aria-label="Close Intel Terminal"
          >
            ✕
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          <KpiStrip kpis={kpis} />

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
                Edge over time · fire-rate on winners vs duds
              </h3>
              <div className="flex items-center gap-3 text-[10px]" style={{ color: "var(--text-muted)" }}>
                <span className="flex items-center gap-1">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--status-good)" }} />
                  winners
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--status-critical)" }} />
                  duds+rugs
                </span>
              </div>
            </div>
            <EdgeChart data={edgeSeries} />
            <p className="mt-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
              The gap between the lines is the alpha — winners fired on, duds passed over. Watch it
              hold as the sample grows.
            </p>
          </section>

          <section className="border-t pt-4" style={{ borderColor: "var(--gridline)" }}>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
                Performance forecast · 8h equity fan
              </h3>
              <div className="flex items-center gap-3 text-[10px]" style={{ color: "var(--text-muted)" }}>
                <span className="flex items-center gap-1">
                  <span
                    className="inline-block h-2 w-3 rounded-sm"
                    style={{ background: "var(--series-1)", opacity: 0.26 }}
                  />
                  p25–75
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block h-2 w-3 rounded-full" style={{ background: "var(--series-1)" }} />
                  median
                </span>
              </div>
            </div>
            <ForecastChart view={forecast} />
          </section>

          {/* News desk teaser — links to the full /news workspace */}
          <section className="border-t pt-4" style={{ borderColor: "var(--gridline)" }}>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
                News desk
              </h3>
              <a href="/news" className="text-[11px]" style={{ color: "var(--series-1)" }}>
                Open ▸
              </a>
            </div>
            {newsHeadline ? (
              <a href="/news" className="block rounded-lg p-3 transition-colors hover:brightness-110" style={{ background: "var(--surface-1)", border: "1px solid var(--gridline)" }}>
                {newsTopTheme ? (
                  <div className="mb-1 text-[10px] uppercase tracking-wide" style={{ color: "var(--series-1)" }}>
                    {newsTopTheme} heating
                  </div>
                ) : null}
                <div className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                  {newsHeadline}
                </div>
              </a>
            ) : (
              <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                No brief yet — run the news desk to synthesize the latest market.
              </p>
            )}
          </section>

          {/* Full detail / methodology — the existing report */}
          <section className="border-t pt-4" style={{ borderColor: "var(--gridline)" }}>
            {children}
          </section>
        </div>
      </div>
    </>
  );
}
