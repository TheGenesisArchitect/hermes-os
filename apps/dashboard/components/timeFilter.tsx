"use client";

// Shared time-range filter for the timestamped ledgers (fills, closed trades,
// and — next — signals / open positions). Default is "all" so the SSR render and
// the client's first render agree (withinRange ignores `now` for "all"), which
// sidesteps any hydration mismatch from Date.now().

export type RangeKey = "all" | "1h" | "6h" | "24h" | "7d";

const RANGE_MS: Record<RangeKey, number | null> = {
  all: null,
  "1h": 3_600_000,
  "6h": 21_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
};

export const RANGE_ORDER: RangeKey[] = ["all", "1h", "6h", "24h", "7d"];

export function withinRange(iso: string | null, key: RangeKey, now: number): boolean {
  const ms = RANGE_MS[key];
  if (ms === null) return true;
  if (!iso) return false;
  return now - new Date(iso).getTime() <= ms;
}

export function TimeRangeChips({
  value,
  onChange,
}: {
  value: RangeKey;
  onChange: (k: RangeKey) => void;
}) {
  return (
    <div className="flex gap-1">
      {RANGE_ORDER.map((k) => {
        const active = k === value;
        return (
          <button
            key={k}
            onClick={() => onChange(k)}
            className="rounded px-2 py-0.5 text-xs font-medium"
            style={{
              background: active ? "var(--series-1)" : "transparent",
              color: active ? "#fff" : "var(--text-muted)",
              border: `1px solid ${active ? "var(--series-1)" : "var(--gridline)"}`,
            }}
          >
            {k === "all" ? "All" : k}
          </button>
        );
      })}
    </div>
  );
}
