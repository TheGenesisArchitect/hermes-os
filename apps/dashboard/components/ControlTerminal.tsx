"use client";

import { useState, useTransition } from "react";
import { clearManualOverride, resetOverrides, setAutoMode, setManualOverride } from "@/app/actions";
import type { ControlKnobView, ControlTerminalView } from "@/lib/queries";

// The live trading desk. A persistent HEADER always shows the real money hitting
// the next trade (so the book can never lie about size again) plus the regime and
// auto-mode; the dials live in a collapsible drawer below. Two authorities per
// knob: the adaptive policy (data-derived, shown as a ghost value) and the
// operator's manual pin (always wins). Auto ships ADVISORY until a clean prime run
// gives the policy its favorable-regime pole.

const SOURCE_TONE: Record<ControlKnobView["source"], string> = {
  base: "var(--text-muted)",
  auto: "var(--series-1)",
  manual: "var(--status-warning)",
};
const SOURCE_LABEL: Record<ControlKnobView["source"], string> = {
  base: "default",
  auto: "policy",
  manual: "pinned",
};

function fmt(v: number, unit: ControlKnobView["unit"]): string {
  if (unit === "$") return `$${v % 1 === 0 ? v : v.toFixed(2)}`;
  if (unit === "x") return `${v}×`;
  if (unit === "%") return `${v}%`;
  return String(v);
}
const money = (v: number) => `$${v.toFixed(2)}`;

function KnobRow({ k }: { k: ControlKnobView }) {
  const [draft, setDraft] = useState<string>("");
  const [pending, start] = useTransition();
  const editing = draft !== "";

  const commit = () => {
    const n = Number.parseFloat(draft);
    if (Number.isFinite(n)) start(() => void setManualOverride(k.key, n).then(() => setDraft("")));
    else setDraft("");
  };

  return (
    <div className="flex items-center gap-2 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: SOURCE_TONE[k.source] }} />
          <span className="text-xs" style={{ color: "var(--text-secondary)" }}>{k.label}</span>
        </div>
        <div className="pl-3 text-[10px]" style={{ color: "var(--text-muted)" }}>{k.hint}</div>
      </div>

      {/* ghost recommendation from the policy + base default */}
      <div className="hidden w-24 shrink-0 text-right text-[10px] tabular sm:block" style={{ color: "var(--text-muted)" }}>
        <div>
          <span style={{ color: "var(--series-1)" }}>{k.auto != null ? fmt(k.auto, k.unit) : "—"}</span> policy
        </div>
        <div>{fmt(k.base, k.unit)} default</div>
      </div>

      {/* effective value + source tag */}
      <div className="w-16 shrink-0 text-right">
        <div className="text-sm font-semibold tabular" style={{ color: SOURCE_TONE[k.source] }}>
          {fmt(k.value, k.unit)}
        </div>
        <div className="text-[9px] uppercase tracking-wide" style={{ color: SOURCE_TONE[k.source] }}>
          {SOURCE_LABEL[k.source]}
        </div>
      </div>

      {/* manual override input */}
      <div className="flex w-28 shrink-0 items-center gap-1">
        <input
          type="number"
          inputMode="decimal"
          step={k.step}
          min={k.min}
          max={k.max}
          value={editing ? draft : ""}
          placeholder={String(k.value)}
          onChange={(e) => setDraft(e.target.value === "" ? " " : e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && commit()}
          onBlur={() => editing && commit()}
          disabled={pending}
          className="w-16 rounded px-1.5 py-1 text-right text-xs tabular outline-none"
          style={{ background: "var(--surface-1)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
          title={`${k.min}–${k.max}`}
        />
        {k.manual != null ? (
          <button
            onClick={() => start(() => void clearManualOverride(k.key))}
            disabled={pending}
            className="rounded px-1 py-0.5 text-[10px]"
            style={{ color: "var(--status-warning)", border: "1px solid var(--status-warning)" }}
            title="Release this pin"
          >
            ✕
          </button>
        ) : (
          <span className="w-4" />
        )}
      </div>
    </div>
  );
}

const MODES: { key: "off" | "advisory" | "live"; label: string; hint: string }[] = [
  { key: "off", label: "Off", hint: "ignore the policy entirely" },
  { key: "advisory", label: "Advisory", hint: "compute & show, don't apply" },
  { key: "live", label: "Live", hint: "policy drives unpinned knobs" },
];

export function ControlTerminal({ view }: { view: ControlTerminalView }) {
  const [open, setOpen] = useState(true);
  const [pending, start] = useTransition();
  const r = view.regime;
  const s = view.sizing;
  const hostility = r?.hostility ?? 0;
  const hostTone =
    hostility >= 0.66 ? "var(--status-critical)" : hostility >= 0.4 ? "var(--status-warning)" : "var(--status-good)";
  const knobs = view.groups.flatMap((g) => g.knobs);
  const pinned = knobs.filter((k) => k.manual != null).length;
  const sizePinned = knobs.some((k) => (k.key === "PAPER_POSITION_USD" || k.key === "OFF_HOURS_SIZE_MULT") && k.manual != null);
  const throttled = !s.primeNow && s.offHoursMult < 1;

  return (
    <div className="w-full">
      {/* ── persistent header: the real per-trade size + regime + mode ── */}
      <div className="rounded-md" style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 p-3">
          {/* the money that hits the next trade */}
          <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 text-left" title={open ? "Collapse the dials" : "Open the dials"}>
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>{open ? "▾" : "▸"}</span>
            <div>
              <div className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Next trade size</div>
              <div className="flex items-baseline gap-1.5">
                <span className="text-lg font-bold tabular" style={{ color: sizePinned ? "var(--status-warning)" : "var(--text-primary)" }}>
                  {s.perTradeLo === s.perTradeHi ? money(s.perTradeHi) : `${money(s.perTradeLo)}–${money(s.perTradeHi)}`}
                </span>
                {sizePinned && <span className="text-[9px] uppercase" style={{ color: "var(--status-warning)" }}>pinned</span>}
              </div>
            </div>
          </button>

          {/* the honest breakdown — no hidden haircut */}
          <div className="min-w-0 text-[11px] leading-tight tabular" style={{ color: "var(--text-secondary)" }}>
            <div>
              {money(s.base)} base
              {throttled ? (
                <>
                  {" × "}
                  <b style={{ color: "var(--status-warning)" }}>{s.offHoursMult}× off-hrs</b>
                  {" = "}{money(s.sessionAdjusted)}
                </>
              ) : (
                <span style={{ color: "var(--status-good)" }}> · PRIME · full size</span>
              )}
            </div>
            <div style={{ color: "var(--text-muted)" }}>then × risk {s.riskFloor}–1.0 × quality per candidate</div>
          </div>

          <div className="flex-1" />

          {/* regime chip */}
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Regime</div>
            <div className="text-xs font-semibold" style={{ color: hostTone }}>{r ? r.label.split(" — ")[0] : "…"}</div>
          </div>

          {/* auto-mode segmented control */}
          <div className="flex overflow-hidden rounded-md" style={{ border: "1px solid var(--border)" }}>
            {MODES.map((m) => {
              const active = view.autoMode === m.key;
              return (
                <button
                  key={m.key}
                  onClick={() => !active && start(() => void setAutoMode(m.key))}
                  disabled={pending}
                  title={m.hint}
                  className="px-2.5 py-1 text-xs font-medium transition-colors"
                  style={{
                    background: active ? (m.key === "live" ? "var(--status-warning)" : "var(--series-1)") : "transparent",
                    color: active ? "var(--page)" : "var(--text-secondary)",
                  }}
                >
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>

        {throttled && (
          <div className="border-t px-3 py-1.5 text-[11px]" style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}>
            💡 Off-hours probe throttle is capping size to {Math.round(s.offHoursMult * 100)}%. Set{" "}
            <b style={{ color: "var(--status-warning)" }}>Off-hours throttle → 1.0</b> below for full size now, or it lifts automatically at 18:00 UTC (2 PM ET).
          </div>
        )}
      </div>

      {/* ── the drawer: regime detail + all dials ── */}
      {open && (
        <div className="mt-3">
          {/* regime detail + hostility bar */}
          {r && (
            <div className="mb-3 rounded-md p-2.5" style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] tabular" style={{ color: "var(--text-secondary)" }}>
                  <span style={{ color: hostTone }}>{r.label}</span>
                  <span>session <b style={{ color: r.session === "prime" ? "var(--status-good)" : "var(--text-muted)" }}>{r.session}</b></span>
                  <span>n {r.n}</span>
                  <span>win {(r.winRate * 100).toFixed(0)}%</span>
                  <span>rug {(r.rugShare * 100).toFixed(0)}%</span>
                  <span>farm {(r.farmShare * 100).toFixed(0)}%</span>
                  <span>peak {r.avgPeakMult.toFixed(2)}×</span>
                </div>
                <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>hostility {(hostility * 100).toFixed(0)}%</span>
              </div>
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full" style={{ background: "var(--gridline)" }}>
                <div className="h-full rounded-full transition-all" style={{ width: `${Math.round(hostility * 100)}%`, background: hostTone }} />
              </div>
              {view.autoMode === "live" ? (
                <div className="mt-2 text-[11px]" style={{ color: "var(--status-warning)" }}>
                  ⚠ Live — policy driving unpinned knobs. Calibrated almost entirely on hostile farm tape; its favorable side is a prior until a clean prime run validates it.
                </div>
              ) : view.autoMode === "advisory" ? (
                <div className="mt-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
                  Advisory — policy shown as the <span style={{ color: "var(--series-1)" }}>ghost</span> value; trader runs default/pinned only.
                </div>
              ) : null}
            </div>
          )}

          {/* knob groups */}
          <div className="grid gap-x-6 gap-y-1 lg:grid-cols-2">
            {view.groups.map((g) => (
              <div key={g.group} className="min-w-0">
                <div className="mb-1 flex items-center justify-between border-b pb-1" style={{ borderColor: "var(--gridline)" }}>
                  <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>{g.label}</span>
                  <span className="hidden text-[9px] uppercase tracking-wide sm:inline" style={{ color: "var(--text-muted)" }}>
                    policy · default · effective · pin
                  </span>
                </div>
                {g.knobs.map((k) => (
                  <KnobRow key={k.key} k={k} />
                ))}
              </div>
            ))}
          </div>

          {/* footer */}
          <div className="mt-3 flex items-center justify-between text-[11px]" style={{ color: "var(--text-muted)" }}>
            <span>
              {pinned > 0 ? (
                <span style={{ color: "var(--status-warning)" }}>{pinned} knob{pinned === 1 ? "" : "s"} pinned</span>
              ) : (
                "no manual pins — running policy/default"
              )}
            </span>
            {pinned > 0 && (
              <button
                onClick={() => start(() => void resetOverrides())}
                disabled={pending}
                className="rounded px-2 py-0.5 text-[11px]"
                style={{ border: "1px solid var(--border)", color: "var(--text-secondary)" }}
              >
                Release all pins
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
