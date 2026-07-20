"use client";

// TRADE LEDGER — the Evidence & Value report. One row per round trip: capital
// deployed, shares, entry/exit/peak, realized P&L, hold time, exit reason, and
// the on-chain transaction hashes. Lane is explicit on every row — LIVE rows
// carry Solscan links (verifiable on-chain evidence); PAPER rows are marked
// SIM so simulated results can never read as real capital.
import { useMemo, useState } from "react";
import { MintLink, fmtTs, fmtTsFull, timeAgo, usd } from "@/components/ui";
import { TimeRangeChips, withinRange, type RangeKey } from "@/components/timeFilter";
import type { TradeRow } from "@/lib/queries";

const SUBSCRIPTS = "₀₁₂₃₄₅₆₇₈₉";
function fmtPrice(v: number | null): string {
  if (v === null || !Number.isFinite(v) || v <= 0) return "—";
  if (v >= 1000) return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (v >= 0.001) return `$${v.toPrecision(4)}`;
  const zeros = Math.max(0, -Math.floor(Math.log10(v)) - 1);
  const digits = Math.round(v * 10 ** (zeros + 4)).toString().slice(0, 4);
  const sub = String(zeros).split("").map((c) => SUBSCRIPTS[Number(c)]).join("");
  return `$0.0${sub}${digits}`;
}
function fmtQty(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(v >= 10 ? 0 : 2);
}
function fmtHold(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  return `${(sec / 3600).toFixed(1)}h`;
}

const REASON_TONE: Record<string, string> = {
  take_profit_0: "var(--status-good)",
  take_profit_1: "var(--status-good)",
  take_profit_2: "var(--status-good)",
  manual_harvest: "var(--status-good)",
  basket_harvest: "var(--status-good)",
  stale_take: "var(--status-good)",
  profit_trail: "var(--series-1)",
  stale_lock: "var(--series-1)",
  hard_stop: "var(--status-warning)",
  classifier_stall: "var(--status-warning)",
  dust_rug: "var(--status-critical)",
  live_catastrophe_stop: "var(--status-warning)",
  live_sweep_close: "var(--text-secondary)",
  live_unsellable: "var(--status-critical)",
  slot_displaced: "var(--text-muted)",
  user_cut: "var(--status-warning)",
};

type LaneFilter = "all" | "live" | "paper";
type SortKey = "closedAt" | "pnlUsd" | "returnPct" | "deployedUsd";

export function TradeLedger({ trades }: { trades: TradeRow[] }) {
  const [query, setQuery] = useState("");
  const [lane, setLane] = useState<LaneFilter>("all");
  const [range, setRange] = useState<RangeKey>("all");
  const [sortKey, setSortKey] = useState<SortKey>("closedAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const rows = useMemo(() => {
    const now = Date.now();
    const q = query.trim().toLowerCase();
    const filtered = trades.filter((t) => {
      if (lane !== "all" && t.lane !== lane) return false;
      if (t.closedAt && !withinRange(t.closedAt, range, now)) return false;
      if (q && !(t.symbol ?? "").toLowerCase().includes(q) && !t.mint.toLowerCase().includes(q)) return false;
      return true;
    });
    const dir = sortDir === "desc" ? -1 : 1;
    const val = (t: TradeRow): number =>
      sortKey === "closedAt"
        ? new Date(t.closedAt ?? t.openedAt).getTime()
        : sortKey === "pnlUsd"
          ? (t.pnlUsd ?? 0)
          : sortKey === "returnPct"
            ? (t.returnPct ?? 0)
            : t.deployedUsd;
    return [...filtered].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      return av === bv ? 0 : av < bv ? -dir : dir;
    });
  }, [trades, query, lane, range, sortKey, sortDir]);

  // Evidence totals over the FILTERED view — the value statement.
  const tot = useMemo(() => {
    let deployed = 0, pnl = 0, fees = 0, wins = 0, verified = 0;
    for (const t of rows) {
      deployed += t.deployedUsd;
      pnl += t.pnlUsd ?? 0;
      fees += t.feesUsd ?? 0;
      if ((t.pnlUsd ?? 0) > 0.005) wins++;
      if (t.buySig || t.sellSigs.length) verified++;
    }
    return {
      deployed, pnl, fees, wins, verified,
      n: rows.length,
      winPct: rows.length ? (100 * wins) / rows.length : 0,
      retPct: deployed > 0 ? (100 * pnl) / deployed : 0,
    };
  }, [rows]);

  const toggleSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else { setSortKey(k); setSortDir("desc"); }
  };
  const arrow = (k: SortKey) => (k === sortKey ? (sortDir === "desc" ? " ↓" : " ↑") : "");
  const chip = (active: boolean) =>
    ({
      background: active ? "var(--series-1)" : "transparent",
      color: active ? "#fff" : "var(--text-muted)",
      border: `1px solid ${active ? "var(--series-1)" : "var(--gridline)"}`,
    }) as const;

  const th = "pb-2 pr-3 font-normal whitespace-nowrap";

  return (
    <section className="card p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
          Trade ledger
          <span className="ml-2 text-xs font-normal" style={{ color: "var(--text-muted)" }}>
            evidence &amp; value · {rows.length} closed round trips
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

      {/* Value statement — the filtered view's bottom line */}
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {[
          { label: "capital deployed", value: usd(tot.deployed, 0), tone: "var(--text-primary)" },
          { label: "realized P&L", value: `${tot.pnl >= 0 ? "+" : ""}${usd(tot.pnl)}`, tone: tot.pnl >= 0 ? "var(--status-good)" : "var(--status-critical)" },
          { label: "return on deployed", value: `${tot.retPct >= 0 ? "+" : ""}${tot.retPct.toFixed(1)}%`, tone: tot.retPct >= 0 ? "var(--status-good)" : "var(--status-critical)" },
          { label: "win rate", value: `${tot.winPct.toFixed(0)}% (${tot.wins}/${tot.n})`, tone: "var(--text-primary)" },
          { label: "on-chain verified", value: `${tot.verified}`, tone: tot.verified > 0 ? "var(--series-1)" : "var(--text-muted)" },
        ].map((s) => (
          <div key={s.label} className="rounded-md px-2.5 py-1.5" style={{ background: "var(--surface-1)", border: "1px solid var(--gridline)" }}>
            <div className="tabular text-sm font-semibold" style={{ color: s.tone }}>{s.value}</div>
            <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>{s.label}</div>
          </div>
        ))}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="flex gap-1">
          <button onClick={() => setLane("all")} className="rounded px-2 py-0.5 text-xs font-medium" style={chip(lane === "all")}>All lanes</button>
          <button onClick={() => setLane("live")} className="rounded px-2 py-0.5 text-xs font-medium" style={chip(lane === "live")}>Live only</button>
          <button onClick={() => setLane("paper")} className="rounded px-2 py-0.5 text-xs font-medium" style={chip(lane === "paper")}>Paper only</button>
        </div>
        <TimeRangeChips value={range} onChange={setRange} />
      </div>

      {rows.length === 0 ? (
        <p className="py-4 text-center text-sm" style={{ color: "var(--text-muted)" }}>No trades match.</p>
      ) : (
        <div className="max-h-[32rem] overflow-auto pr-2" style={{ scrollbarGutter: "stable" }}>
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10" style={{ background: "var(--surface-1)" }}>
              <tr className="text-left text-xs" style={{ color: "var(--text-muted)" }}>
                <th className={th}>Lane · Token</th>
                <th className={`${th} text-right cursor-pointer`} onClick={() => toggleSort("deployedUsd")}>Deployed{arrow("deployedUsd")}</th>
                <th className={`${th} text-right`}>Shares</th>
                <th className={`${th} text-right`}>Entry</th>
                <th className={`${th} text-right`}>Exit</th>
                <th className={`${th} text-right`}>Peak</th>
                <th className={`${th} text-right cursor-pointer`} onClick={() => toggleSort("pnlUsd")}>P&amp;L{arrow("pnlUsd")}</th>
                <th className={`${th} text-right cursor-pointer`} onClick={() => toggleSort("returnPct")}>Return{arrow("returnPct")}</th>
                <th className={`${th} text-right`}>Hold</th>
                <th className={th}>Exit</th>
                <th className={`${th} text-right cursor-pointer`} onClick={() => toggleSort("closedAt")}>Closed (UTC){arrow("closedAt")}</th>
                <th className={th}>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const live = t.lane === "live";
                const pnl = t.pnlUsd ?? 0;
                const tone = pnl > 0.005 ? "var(--status-good)" : pnl < -0.005 ? "var(--status-critical)" : "var(--text-secondary)";
                return (
                  <tr key={`${t.lane}-${t.id}`} className="border-t" style={{ borderColor: "var(--gridline)" }}>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      <span
                        className="mr-2 inline-block rounded px-1.5 text-[10px] font-semibold uppercase"
                        style={{
                          background: live ? "rgba(26,191,106,0.16)" : "rgba(255,255,255,0.06)",
                          color: live ? "var(--status-good)" : "var(--text-muted)",
                        }}
                        title={live ? "real capital, on-chain" : "simulated — no capital at risk"}
                      >
                        {live ? "LIVE" : "SIM"}
                      </span>
                      <MintLink mint={t.mint} symbol={t.symbol} />
                      {t.dex ? <span className="ml-1.5 text-[10px]" style={{ color: "var(--text-muted)" }}>{t.dex}</span> : null}
                    </td>
                    <td className="tabular py-2 pr-3 text-right" style={{ color: "var(--text-primary)" }}>{usd(t.deployedUsd)}</td>
                    <td className="tabular py-2 pr-3 text-right text-xs" style={{ color: "var(--text-muted)" }}>{fmtQty(t.shares)}</td>
                    <td className="tabular py-2 pr-3 text-right" style={{ color: "var(--text-secondary)" }} title={`$${t.entryPrice}`}>{fmtPrice(t.entryPrice)}</td>
                    <td className="tabular py-2 pr-3 text-right" style={{ color: "var(--text-secondary)" }} title={t.exitPrice ? `$${t.exitPrice}` : ""}>{fmtPrice(t.exitPrice)}</td>
                    <td className="tabular py-2 pr-3 text-right text-xs" style={{ color: "var(--text-muted)" }} title="peak mark reached while held">
                      {t.peakMult ? `${t.peakMult.toFixed(2)}×` : "—"}
                    </td>
                    <td className="tabular py-2 pr-3 text-right font-medium" style={{ color: tone }}>
                      {pnl >= 0 ? "+" : ""}{usd(pnl)}
                    </td>
                    <td className="tabular py-2 pr-3 text-right" style={{ color: tone }}>
                      {t.returnPct === null ? "—" : `${t.returnPct >= 0 ? "+" : ""}${t.returnPct.toFixed(1)}%`}
                    </td>
                    <td className="tabular py-2 pr-3 text-right text-xs" style={{ color: "var(--text-muted)" }}>{fmtHold(t.holdSec)}</td>
                    <td className="py-2 pr-3 text-xs whitespace-nowrap">
                      <span style={{ color: REASON_TONE[t.exitReason ?? ""] ?? "var(--text-secondary)" }}>{t.exitReason ?? "—"}</span>
                    </td>
                    <td className="tabular py-2 pr-3 text-right text-xs whitespace-nowrap" style={{ color: "var(--text-muted)" }} title={t.closedAt ? `${fmtTsFull(t.closedAt)} · ${timeAgo(t.closedAt)}` : ""}>
                      {t.closedAt ? fmtTs(t.closedAt) : "—"}
                    </td>
                    <td className="py-2 pr-3 text-xs whitespace-nowrap">
                      {live ? (
                        <span className="inline-flex gap-1.5">
                          {t.buySig ? (
                            <a href={`https://solscan.io/tx/${t.buySig}`} target="_blank" rel="noreferrer" className="hover:underline" style={{ color: "var(--series-1)" }} title={t.buySig}>buy ↗</a>
                          ) : null}
                          {t.sellSigs.map((s, i) => (
                            <a key={s} href={`https://solscan.io/tx/${s}`} target="_blank" rel="noreferrer" className="hover:underline" style={{ color: "var(--series-1)" }} title={s}>
                              sell{t.sellSigs.length > 1 ? ` ${i + 1}` : ""} ↗
                            </a>
                          ))}
                          {!t.buySig && t.sellSigs.length === 0 ? <span style={{ color: "var(--text-muted)" }}>—</span> : null}
                        </span>
                      ) : (
                        <span style={{ color: "var(--text-muted)" }}>{t.fillCount} fills · sim</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-[10.5px]" style={{ color: "var(--text-muted)" }}>
        One row per closed round trip. LIVE rows are real capital with verifiable Solscan transactions; SIM rows are simulated fills and are not
        indicative of live performance. Peak is the best mark reached while the position was held, entry-relative.
      </p>
    </section>
  );
}
