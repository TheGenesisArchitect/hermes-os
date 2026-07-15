"use client";

import { useMemo, useState } from "react";
import { MintLink, fmtTs, fmtTsFull, timeAgo, usd } from "@/components/ui";
import { TimeRangeChips, withinRange, type RangeKey } from "@/components/timeFilter";
import type { RecentTrade } from "@/lib/queries";

type SortKey = "filledAt" | "valueUsd" | "priceUsd";
type SideFilter = "all" | "buy" | "sell";

/**
 * Tiny-price formatter — memecoin prices live at 1e-7; scientific notation
 * ($9.661e-7) is unreadable in a ledger. Render leading zeros as a subscript
 * count: 0.0000009661 → $0.0₆9661 (6 zeros, then the significant digits).
 */
const SUBSCRIPTS = "₀₁₂₃₄₅₆₇₈₉";
function fmtPrice(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "$0";
  if (v >= 1000) return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (v >= 0.001) return `$${v.toPrecision(4)}`;
  const zeros = Math.max(0, -Math.floor(Math.log10(v)) - 1);
  const digits = Math.round(v * 10 ** (zeros + 4)).toString().slice(0, 4);
  const sub = String(zeros)
    .split("")
    .map((c) => SUBSCRIPTS[Number(c)])
    .join("");
  return `$0.0${sub}${digits}`;
}

/** Compact token quantity: 1_234_567 → 1.23M. */
function fmtQty(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(v >= 10 ? 0 : 2);
}

/** Exit-reason chip colors — the ledger reads at a glance. */
const REASON_TONE: Record<string, string> = {
  take_profit_0: "var(--status-good)",
  take_profit_1: "var(--status-good)",
  take_profit_2: "var(--status-good)",
  manual_harvest: "var(--status-good)",
  basket_harvest: "var(--status-good)",
  profit_trail: "var(--series-1)",
  stale_lock: "var(--series-1)",
  stale_take: "var(--status-good)",
  hard_stop: "var(--status-warning)",
  dust_rug: "var(--status-critical)",
  slot_displaced: "var(--text-muted)",
  user_cut: "var(--status-warning)",
};

export function FillsTable({ trades }: { trades: RecentTrade[] }) {
  const [query, setQuery] = useState("");
  const [side, setSide] = useState<SideFilter>("all");
  const [range, setRange] = useState<RangeKey>("all");
  const [sortKey, setSortKey] = useState<SortKey>("filledAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const rows = useMemo(() => {
    const now = Date.now();
    const q = query.trim().toLowerCase();
    const filtered = trades.filter((t) => {
      if (side !== "all" && t.side !== side) return false;
      if (!withinRange(t.filledAt, range, now)) return false;
      if (q && !(t.symbol ?? "").toLowerCase().includes(q) && !t.mint.toLowerCase().includes(q)) return false;
      return true;
    });
    const dir = sortDir === "desc" ? -1 : 1;
    const val = (t: RecentTrade, k: SortKey): number =>
      k === "filledAt" ? new Date(t.filledAt).getTime() : k === "priceUsd" ? Number(t.priceUsd) : Number(t.qtyTokens) * Number(t.priceUsd);
    return filtered.sort((a, b) => {
      const av = val(a, sortKey);
      const bv = val(b, sortKey);
      return av === bv ? 0 : av < bv ? -dir : dir;
    });
  }, [trades, query, side, range, sortKey, sortDir]);

  // Ledger summary over the FILTERED view — cash in, cash out, fees. This is the
  // accounting readout: sells − buys = net cash flow through the book.
  const summary = useMemo(() => {
    let buyUsd = 0,
      sellUsd = 0,
      fees = 0,
      buys = 0,
      sells = 0;
    for (const t of rows) {
      const v = Number(t.qtyTokens) * Number(t.priceUsd);
      if (t.side === "buy") {
        buyUsd += v;
        buys++;
      } else {
        sellUsd += v;
        sells++;
      }
      fees += Number(t.feeUsd ?? 0);
    }
    return { buyUsd, sellUsd, fees, buys, sells, net: sellUsd - buyUsd };
  }, [rows]);

  const toggleSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSortKey(k);
      setSortDir("desc");
    }
  };
  const arrow = (k: SortKey) => (k === sortKey ? (sortDir === "desc" ? " ↓" : " ↑") : "");

  const chip = (active: boolean) =>
    ({
      background: active ? "var(--series-1)" : "transparent",
      color: active ? "#fff" : "var(--text-muted)",
      border: `1px solid ${active ? "var(--series-1)" : "var(--gridline)"}`,
    }) as const;

  return (
    <section className="card p-4">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
          Fill ledger
          <span className="ml-2 text-xs font-normal" style={{ color: "var(--text-muted)" }}>
            {rows.length} of {trades.length}
            {range !== "all" ? " in range" : ""}
          </span>
        </h2>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="symbol / mint…"
          className="rounded px-2 py-1 text-xs"
          style={{ background: "var(--surface-1)", color: "var(--text-secondary)", border: "1px solid var(--gridline)" }}
        />
      </div>
      {/* Accounting strip — cash through the book for the filtered view */}
      <p className="mb-3 text-xs" style={{ color: "var(--text-muted)" }}>
        <span>{summary.buys} buys {usd(summary.buyUsd, 0)} in</span>
        <span className="mx-1.5">·</span>
        <span>{summary.sells} sells {usd(summary.sellUsd, 0)} out</span>
        <span className="mx-1.5">·</span>
        <span>fees {usd(summary.fees)}</span>
        <span className="mx-1.5">·</span>
        <span style={{ color: summary.net >= 0 ? "var(--status-good)" : "var(--text-secondary)" }}>
          net flow {summary.net >= 0 ? "+" : ""}
          {usd(summary.net, 0)}
        </span>
      </p>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="flex gap-1">
          <button onClick={() => setSide("all")} className="rounded px-2 py-0.5 text-xs font-medium" style={chip(side === "all")}>All</button>
          <button onClick={() => setSide("buy")} className="rounded px-2 py-0.5 text-xs font-medium" style={chip(side === "buy")}>Buys</button>
          <button onClick={() => setSide("sell")} className="rounded px-2 py-0.5 text-xs font-medium" style={chip(side === "sell")}>Sells</button>
        </div>
        <TimeRangeChips value={range} onChange={setRange} />
      </div>
      {rows.length === 0 ? (
        <p className="py-4 text-center text-sm" style={{ color: "var(--text-muted)" }}>
          No fills match.
        </p>
      ) : (
        <div className="max-h-[28rem] overflow-y-auto pr-3" style={{ scrollbarGutter: "stable" }}>
          <table className="w-full text-sm">
            <thead className="sticky top-0" style={{ background: "var(--surface-1)" }}>
              <tr className="text-left text-xs" style={{ color: "var(--text-muted)" }}>
                <th className="pb-2 pr-2 font-normal">Side · Token</th>
                <th className="pb-2 pr-2 text-right font-normal">Qty</th>
                <th className="cursor-pointer pb-2 pr-2 text-right font-normal" onClick={() => toggleSort("priceUsd")}>
                  Price{arrow("priceUsd")}
                </th>
                <th className="cursor-pointer pb-2 pr-2 text-right font-normal" onClick={() => toggleSort("valueUsd")}>
                  Value{arrow("valueUsd")}
                </th>
                <th className="pb-2 pr-2 text-right font-normal">Fee</th>
                <th className="pb-2 pr-2 font-normal">Reason</th>
                <th className="cursor-pointer pb-2 text-right font-normal" onClick={() => toggleSort("filledAt")}>
                  Time (UTC){arrow("filledAt")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const qty = Number(t.qtyTokens);
                const price = Number(t.priceUsd);
                const value = qty * price;
                const isSell = t.side === "sell";
                return (
                  <tr key={t.id} className="border-t" style={{ borderColor: "var(--gridline)" }}>
                    <td className="py-2 pr-2">
                      <span
                        className="mr-2 inline-block w-9 rounded px-1 text-center text-xs font-semibold"
                        style={{
                          background: isSell ? "rgba(255,255,255,0.06)" : "rgba(57,135,229,0.18)",
                          color: isSell ? "var(--text-secondary)" : "var(--series-1)",
                        }}
                      >
                        {t.side}
                      </span>
                      <MintLink mint={t.mint} symbol={t.symbol} />
                    </td>
                    <td className="tabular py-2 pr-2 text-right text-xs" style={{ color: "var(--text-muted)" }}>
                      {fmtQty(qty)}
                    </td>
                    <td className="tabular py-2 pr-2 text-right" style={{ color: "var(--text-secondary)" }} title={`$${price}`}>
                      {fmtPrice(price)}
                    </td>
                    <td className="tabular py-2 pr-2 text-right" style={{ color: "var(--text-primary)" }}>
                      {usd(value)}
                    </td>
                    <td className="tabular py-2 pr-2 text-right text-xs" style={{ color: "var(--text-muted)" }}>
                      {t.feeUsd === null ? "—" : usd(Number(t.feeUsd))}
                    </td>
                    <td className="py-2 pr-2 text-xs">
                      {(() => {
                        // Per-fill reason is the truth; older rows (pre-migration)
                        // fall back to the position's final exit reason on sells.
                        const r = t.fillReason ?? (isSell ? t.exitReason : null);
                        return r ? (
                          <span style={{ color: REASON_TONE[r] ?? "var(--text-secondary)" }}>{r}</span>
                        ) : (
                          <span style={{ color: "var(--text-muted)" }}>{isSell ? "partial" : "entry"}</span>
                        );
                      })()}
                    </td>
                    <td
                      className="tabular py-2 text-right text-xs"
                      style={{ color: "var(--text-muted)" }}
                      title={`${fmtTsFull(t.filledAt)} · ${timeAgo(t.filledAt)}`}
                    >
                      {fmtTs(t.filledAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
