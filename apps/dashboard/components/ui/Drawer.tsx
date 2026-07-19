"use client";

// THE PANEL/DRAWER STANDARD — the going-forward pattern for dashboard surfaces.
// A panel shows a compact CORE summary on the surface (always visible, scannable)
// and tucks full detail into a right-side slide-in Drawer, so the page stays clean
// while core data is one click away. Extracted from the proven SystemHealth drawer
// (backdrop + escape + localStorage-persist + themed slide) so every panel behaves
// identically. New panels should compose <Panel> rather than hand-rolling a card.

import { useCallback, useEffect, useRef, useState } from "react";

/** Persisted open/close state — survives a hard reload, keyed per drawer. */
export function useDrawerState(key: string): [boolean, (v: boolean) => void] {
  const storageKey = `hermes.drawer.${key}`;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (typeof window !== "undefined" && window.localStorage.getItem(storageKey) === "1") setOpen(true);
  }, [storageKey]);
  const set = useCallback(
    (v: boolean) => {
      setOpen(v);
      try {
        window.localStorage.setItem(storageKey, v ? "1" : "0");
      } catch {
        /* private mode — non-fatal */
      }
    },
    [storageKey],
  );
  return [open, set];
}

/** Right-side slide-in overlay. Backdrop click + Escape close it; opening focuses
 *  the close button. Theming matches the System Health drawer exactly. */
export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  accent = "var(--series-1)",
  width = 480,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  accent?: string;
  width?: number;
  children: React.ReactNode;
}) {
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    closeBtnRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <>
      <div
        onClick={onClose}
        aria-hidden
        className="fixed inset-0 z-40 transition-opacity duration-300"
        style={{ background: "rgba(0,0,0,0.55)", opacity: open ? 1 : 0, pointerEvents: open ? "auto" : "none" }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="fixed right-0 top-0 z-50 flex h-full max-w-[94vw] flex-col shadow-2xl transition-transform duration-300 ease-out"
        style={{
          width,
          background: "var(--surface-0, var(--page, #0b0d10))",
          borderLeft: "1px solid var(--border)",
          transform: open ? "translateX(0)" : "translateX(100%)",
        }}
      >
        <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: "var(--border)" }}>
          <div className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: accent, boxShadow: `0 0 0 3px color-mix(in srgb, ${accent} 22%, transparent)` }} />
            <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
              {title}
            </h2>
            {subtitle ? (
              <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                {subtitle}
              </span>
            ) : null}
          </div>
          <button
            ref={closeBtnRef}
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm transition-colors hover:brightness-125"
            style={{ color: "var(--text-secondary)", background: "var(--surface-1)" }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto p-4">{children}</div>
      </div>
    </>
  );
}

/** The standard panel: a `.card` with a header (title · badge · actions · Expand),
 *  a compact CORE summary on the surface, and full `drawer` detail one click away. */
export function Panel({
  title,
  badge,
  actions,
  accent = "var(--series-1)",
  storageKey,
  drawerTitle,
  drawerSubtitle,
  expandLabel = "Expand",
  drawer,
  children,
}: {
  title: string;
  badge?: React.ReactNode;
  actions?: React.ReactNode;
  accent?: string;
  storageKey: string;
  drawerTitle?: string;
  drawerSubtitle?: string;
  expandLabel?: string;
  drawer: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useDrawerState(storageKey);
  return (
    <section className="card p-4">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          {title}
        </h2>
        {badge}
        <div className="ml-auto flex items-center gap-2">
          {actions}
          <button
            onClick={() => setOpen(true)}
            className="rounded-md px-2.5 py-1 text-[11px] transition-colors hover:brightness-125"
            style={{ background: "var(--surface-0, var(--page))", border: "1px solid var(--border)", color: "var(--text-secondary)" }}
            aria-haspopup="dialog"
          >
            {expandLabel} ⤢
          </button>
        </div>
      </div>
      {children}
      <Drawer open={open} onClose={() => setOpen(false)} title={drawerTitle ?? title} subtitle={drawerSubtitle} accent={accent}>
        {drawer}
      </Drawer>
    </section>
  );
}
