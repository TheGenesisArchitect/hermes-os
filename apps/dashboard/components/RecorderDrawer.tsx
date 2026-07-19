"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { SymbolMint } from "@/components/ui";
import type { RecorderOutcome, WatchingCandidate } from "@/lib/queries";

const LABEL_COLOR: Record<string, string> = {
  live: "var(--series-1)",
  winner: "var(--status-good)",
  dud: "var(--text-muted)",
  rug: "var(--status-critical)",
};

type SortKey = "peakMultiple" | "finalMultiple" | "maxDrawdownFromPeakPct" | "minutesToPeak" | "earlyScore" | "walletEdge";
type LabelFilter = "all" | "live" | "winner" | "dud" | "rug";

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "peakMultiple", label: "Peak" },
  { key: "finalMultiple", label: "Now / Final" },
  { key: "maxDrawdownFromPeakPct", label: "Max DD" },
  { key: "minutesToPeak", label: "→Peak" },
  { key: "earlyScore", label: "Score" },
  { key: "walletEdge", label: "Wallet" },
];

/** Smart-money chip from the wallet graph — the creme-rises signal. */
function WalletChip({ row }: { row: Row }) {
  if (row.walletWinnerHits > 0)
    return (
      <span className="rounded px-1 py-0.5 text-[10px] font-bold" style={{ background: "rgba(12,163,12,0.15)", color: "var(--status-good)" }} title={`${row.walletWinnerHits} smart-money wallet(s) in holders — validated 2.2× winner lift`}>
        🟢{row.walletWinnerHits}
      </span>
    );
  if (row.walletRugHits > 0)
    return (
      <span className="rounded px-1 py-0.5 text-[10px] font-bold" style={{ background: "rgba(208,59,59,0.12)", color: "var(--status-critical)" }} title={`${row.walletRugHits} serial-rug wallet(s) in holders`}>
        🔴{row.walletRugHits}
      </span>
    );
  if (row.walletEdge != null)
    return <span className="tabular text-[11px]" style={{ color: "var(--text-muted)" }} title="wallet-graph edge (neutral holders)">{Math.round(row.walletEdge * 100)}</span>;
  return <span style={{ color: "var(--text-muted)" }}>—</span>;
}

const fmtMult = (m: number) => (m >= 10 ? m.toFixed(0) : m.toFixed(2)) + "×";

/** Unified row: a closed outcome OR a live in-window candidate (label "live"). */
interface Row {
  mint: string;
  symbol: string | null;
  dex: string | null;
  peakMultiple: number;
  finalMultiple: number; // live rows: CURRENT mark
  maxDrawdownFromPeakPct: number;
  minutesToPeak: number | null;
  ticks: number;
  label: string;
  entered: boolean;
  armed: boolean;
  earlyScore: number | null; // live rows: current continuation score
  walletEdge: number | null; // wallet-graph edge (live rows)
  walletWinnerHits: number; // smart-money holders
  walletRugHits: number; // serial-rug holders
}

/**
 * Trade-status chip — the "did we take the shot?" readout, same truth the
 * trader acts on: IN = position taken; ARMED = qualifies right now, trader
 * enters on its next scan (or displaces deadweight to make room); MISSED = a
 * closed winner we never entered (the capture gap this panel exists to shrink).
 */
function StatusChip({ row }: { row: Row }) {
  if (row.entered)
    return (
      <span className="rounded px-1.5 py-0.5 text-[10px] font-bold" style={{ background: "rgba(12,163,12,0.15)", color: "var(--status-good)" }} title="we took the shot">
        IN
      </span>
    );
  if (row.label === "live" && row.armed)
    return (
      <span className="rounded px-1.5 py-0.5 text-[10px] font-bold" style={{ background: "rgba(229,160,57,0.15)", color: "var(--status-warning)" }} title="qualifies right now — trader enters on its next scan">
        ⚡ ARMED
      </span>
    );
  if (row.label === "winner")
    return (
      <span className="rounded px-1.5 py-0.5 text-[10px] font-bold" style={{ background: "rgba(208,59,59,0.12)", color: "var(--status-critical)" }} title="a winner we never entered — the capture gap">
        MISSED
      </span>
    );
  return null;
}

export function RecorderDrawer({ outcomes, watching = [] }: { outcomes: RecorderOutcome[]; watching?: WatchingCandidate[] }) {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [labelFilter, setLabelFilter] = useState<LabelFilter>("all");
  const [enteredOnly, setEnteredOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("peakMultiple");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // Merge LIVE in-window candidates with closed outcomes — one board, same truth
  // the trader sees (armed = it WILL take the shot). Live rows win a mint clash.
  const all = useMemo<Row[]>(() => {
    const liveMints = new Set(watching.map((w) => w.mint));
    const liveRows: Row[] = watching.map((w) => ({
      mint: w.mint,
      symbol: w.symbol,
      dex: w.dex,
      peakMultiple: w.peakMultiple,
      finalMultiple: w.markMultiple,
      maxDrawdownFromPeakPct: w.drawdownFromPeakPct,
      minutesToPeak: null,
      ticks: w.ticks,
      label: "live",
      entered: w.entered,
      armed: w.armed,
      earlyScore: w.continuationScore,
      walletEdge: w.walletEdge,
      walletWinnerHits: w.walletWinnerHits,
      walletRugHits: w.walletRugHits,
    }));
    const closedRows: Row[] = outcomes
      .filter((o) => !liveMints.has(o.mint))
      .map((o) => ({ ...o, label: o.label, armed: false, walletEdge: null, walletWinnerHits: 0, walletRugHits: 0 }));
    return [...liveRows, ...closedRows];
  }, [outcomes, watching]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = all.filter((o) => {
      if (labelFilter !== "all" && o.label !== labelFilter) return false;
      if (enteredOnly && !o.entered) return false;
      if (q && !(o.symbol ?? "").toLowerCase().includes(q) && !o.mint.toLowerCase().includes(q)) return false;
      return true;
    });
    const dir = sortDir === "desc" ? -1 : 1;
    return filtered.sort((a, b) => {
      const av = a[sortKey] ?? -Infinity;
      const bv = b[sortKey] ?? -Infinity;
      return av === bv ? 0 : av < bv ? -dir : dir;
    });
  }, [all, query, labelFilter, enteredOnly, sortKey, sortDir]);

  // Capture rate over the loaded outcome window — the number this board moves.
  const winners = outcomes.filter((o) => o.label === "winner");
  const captured = winners.filter((o) => o.entered).length;
  const armedNow = watching.filter((w) => w.armed && !w.entered).length;

  const shown = expanded ? rows : rows.slice(0, 6);
  const toggleSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSortKey(k);
      setSortDir("desc");
    }
  };

  const chip = (active: boolean) =>
    ({
      background: active ? "var(--series-1)" : "var(--surface-1)",
      border: "1px solid var(--border)",
      color: active ? "#fff" : "var(--text-secondary)",
    }) as const;

  return (
    <div className="card p-4">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h3 className="mr-auto text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
          Best performers · {rows.length}
          {rows.length !== all.length ? <span style={{ color: "var(--text-muted)" }}> of {all.length}</span> : null}
          <span className="ml-2 text-xs font-normal" style={{ color: "var(--series-1)" }}>
            {watching.length} live
          </span>
          {armedNow > 0 ? (
            <span className="ml-2 text-xs font-normal" style={{ color: "var(--status-warning)" }}>
              ⚡ {armedNow} armed
            </span>
          ) : null}
        </h3>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search symbol / mint…"
          className="tabular rounded-md px-2 py-1 text-xs outline-none"
          style={{ background: "var(--page)", border: "1px solid var(--border)", color: "var(--text-primary)", width: 180 }}
        />
        {(["all", "live", "winner", "dud", "rug"] as LabelFilter[]).map((l) => (
          <button
            key={l}
            onClick={() => setLabelFilter(l)}
            className="rounded px-2 py-1 text-[11px] capitalize transition-colors hover:brightness-125"
            style={chip(labelFilter === l)}
          >
            {l}
          </button>
        ))}
        <button
          onClick={() => setEnteredOnly((v) => !v)}
          className="rounded px-2 py-1 text-[11px] transition-colors hover:brightness-125"
          style={chip(enteredOnly)}
          title="only candidates we took a position in"
        >
          ● entered
        </button>
      </div>
      <p className="mb-3 text-xs" style={{ color: "var(--text-muted)" }}>
        Live board + labeled history, exactly what the trader acts on. Capture:{" "}
        <span style={{ color: winners.length > 0 && captured / Math.max(winners.length, 1) >= 0.5 ? "var(--status-good)" : "var(--status-warning)" }}>
          {captured}/{winners.length} winners entered
        </span>{" "}
        in the loaded window — ⚡ armed rows are shots the trader is taking now (full book displaces deadweight to make room).
      </p>

      {rows.length === 0 ? (
        <div className="py-6 text-center text-xs" style={{ color: "var(--text-muted)" }}>
          {all.length === 0
            ? "No candidates yet — live rows appear the moment the recorder starts watching a launch."
            : "No candidates match these filters."}
        </div>
      ) : (
        <>
          <div className={expanded ? "max-h-[28rem] overflow-y-auto pr-3" : ""} style={expanded ? { scrollbarGutter: "stable" } : undefined}>
            <table className="w-full text-sm">
              <thead className="sticky top-0" style={{ background: "var(--surface-1)" }}>
                <tr className="text-left text-xs" style={{ color: "var(--text-muted)" }}>
                  <th className="pb-2 font-normal">Token</th>
                  <th className="pb-2 font-normal">Venue</th>
                  {COLUMNS.map((c) => (
                    <th
                      key={c.key}
                      onClick={() => toggleSort(c.key)}
                      className="cursor-pointer select-none pb-2 text-right font-normal hover:brightness-150"
                      style={{ color: sortKey === c.key ? "var(--series-1)" : "var(--text-muted)" }}
                    >
                      {c.label}
                      {sortKey === c.key ? (sortDir === "desc" ? " ↓" : " ↑") : ""}
                    </th>
                  ))}
                  <th className="pb-2 text-right font-normal">Label</th>
                  <th className="pb-2 text-right font-normal">Trade</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((o) => (
                  <tr key={o.mint} className="border-t" style={{ borderColor: "var(--gridline)" }}>
                    <td className="py-2">
                      <Link href={`/token/${o.mint}`} className="hover:underline">
                        <SymbolMint symbol={o.symbol} mint={o.mint} />
                      </Link>
                    </td>
                    <td className="py-2 text-xs" style={{ color: "var(--text-muted)" }}>
                      {o.dex}
                    </td>
                    <td className="tabular py-2 text-right" style={{ color: o.peakMultiple >= 2 ? "var(--status-good)" : "var(--text-secondary)" }}>
                      {fmtMult(o.peakMultiple)}
                    </td>
                    <td className="tabular py-2 text-right" style={{ color: o.label === "live" ? "var(--series-1)" : "var(--text-secondary)" }}>
                      {fmtMult(o.finalMultiple)}
                    </td>
                    <td className="tabular py-2 text-right" style={{ color: o.maxDrawdownFromPeakPct >= 40 ? "var(--status-critical)" : "var(--text-muted)" }}>
                      {o.maxDrawdownFromPeakPct.toFixed(0)}%
                    </td>
                    <td className="tabular py-2 text-right text-xs" style={{ color: "var(--text-muted)" }}>
                      {o.minutesToPeak === null ? "—" : `${o.minutesToPeak.toFixed(0)}m`}
                    </td>
                    <td className="tabular py-2 text-right font-semibold" style={{ color: "var(--text-secondary)" }}>
                      {o.earlyScore === null ? "—" : o.earlyScore.toFixed(0)}
                    </td>
                    <td className="py-2 text-right">
                      <WalletChip row={o} />
                    </td>
                    <td className="py-2 text-right">
                      <span className="text-xs font-semibold uppercase" style={{ color: LABEL_COLOR[o.label] ?? "var(--text-muted)" }}>
                        {o.label}
                      </span>
                    </td>
                    <td className="py-2 text-right">
                      <StatusChip row={o} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > 6 ? (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="mt-3 w-full rounded-md py-1.5 text-xs transition-colors hover:brightness-125"
              style={{ background: "var(--surface-1)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}
            >
              {expanded ? "▲ Collapse" : `▼ Expand all ${rows.length} · scroll`}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
