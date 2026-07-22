"use client";

// GLOBAL WALLET FILTER — every lane-aware panel on the page follows this
// toggle (server-filtered via the ?lane= param, so aggregates recompute
// honestly rather than hiding rows client-side). ALL shows both books with
// their SIM / ◆ LIVE marks; PAPER and LIVE isolate one wallet for surgical
// review of that book alone.
import { usePathname, useRouter, useSearchParams } from "next/navigation";

const OPTIONS = [
  { key: "all", label: "All" },
  { key: "paper", label: "Paper" },
  { key: "live", label: "◆ Live" },
] as const;

export function LaneFilter() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const current = params.get("lane") ?? "all";

  const set = (key: string) => {
    const next = new URLSearchParams(params.toString());
    if (key === "all") next.delete("lane");
    else next.set("lane", key);
    router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false });
  };

  return (
    <div
      className="inline-flex overflow-hidden rounded-md text-xs"
      style={{ border: "1px solid var(--gridline)" }}
      role="tablist"
      aria-label="Wallet filter"
    >
      {OPTIONS.map((o) => {
        const active = current === o.key;
        return (
          <button
            key={o.key}
            role="tab"
            aria-selected={active}
            onClick={() => set(o.key)}
            className="px-3 py-1 font-medium transition-colors"
            style={{
              background: active ? "var(--surface-1)" : "transparent",
              color: active
                ? o.key === "live"
                  ? "var(--status-serious)"
                  : "var(--text-primary)"
                : "var(--text-muted)",
              borderLeft: o.key !== "all" ? "1px solid var(--gridline)" : "none",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
