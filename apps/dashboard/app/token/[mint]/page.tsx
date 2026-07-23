import Link from "next/link";
import { notFound } from "next/navigation";
import { ScoreBadge, timeAgo, usd } from "@/components/ui";
import { getTokenDetail } from "@/lib/queries";
import { db } from "@hermes/db";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

const CHECK_LABELS: Record<string, string> = {
  mint_authority: "Mint & freeze authority revoked",
  rugcheck: "RugCheck risk report",
  holder_concentration: "Holder concentration",
  honeypot_probe: "Honeypot probe (Jupiter round-trip)",
};

export default async function TokenPage({ params }: { params: Promise<{ mint: string }> }) {
  const { mint } = await params;
  const detail = await getTokenDetail(mint);
  if (!detail) notFound();
  // CLONE TWINS (bitcat, 2026-07-23): two mints wore one ticker; the operator
  // pulled the untraded twin's page and read it as our trade. Same-symbol
  // siblings from the last 24h are surfaced up top so a symbol collision can
  // never masquerade as the position again.
  const siblings = detail.token?.symbol
    ? ((await db.execute(sql`
        SELECT tk.mint, to_char(tk.first_seen_at,'HH24:MI') seen,
          EXISTS (SELECT 1 FROM positions p WHERE p.mint = tk.mint) traded
        FROM tokens tk WHERE tk.symbol = ${detail.token.symbol} AND tk.mint <> ${mint}
          AND tk.first_seen_at > now() - interval '24 hours'
        ORDER BY tk.first_seen_at DESC LIMIT 6`)) as unknown as { mint: string; seen: string; traded: boolean }[])
    : [];
  const { token, checks, signals, positions, recorderOutcome, recorderTrajectory, fills, mgmtTrajectory } = detail;
  const num = (v: unknown): number => (v == null ? 0 : Number(v));

  // latest run per check
  const latest = new Map<string, (typeof checks)[number]>();
  for (const check of checks) {
    if (!latest.has(check.checkName)) latest.set(check.checkName, check);
  }

  return (
    <div className="space-y-6">
      <div>
        <Link href="/" className="text-xs hover:underline" style={{ color: "var(--text-muted)" }}>
          ← overview
        </Link>
        <h1 className="mt-1 text-xl font-semibold">
          {token.symbol ?? "?"}{" "}
          <span className="text-sm font-normal" style={{ color: "var(--text-secondary)" }}>
            {token.name}
          </span>
        </h1>
        {siblings.length > 0 && (
          <div
            className="mt-2 rounded-md px-3 py-2 text-xs"
            style={{ border: "1px solid var(--status-warning)", color: "var(--status-warning)" }}
          >
            ⚠ {siblings.length} other mint{siblings.length > 1 ? "s" : ""} wore the ticker “{token.symbol}” in the last
            24h — verify you are reading the right one:{" "}
            {siblings.map((s, i) => (
              <span key={s.mint}>
                {i > 0 ? " · " : ""}
                <Link href={`/token/${s.mint}`} className="underline">
                  {s.mint.slice(0, 4)}…{s.mint.slice(-4)}
                </Link>{" "}
                ({s.seen}Z{s.traded ? ", TRADED" : ", never traded"})
              </span>
            ))}
          </div>
        )}
        <div className="mt-1 flex flex-wrap gap-4 text-xs" style={{ color: "var(--text-muted)" }}>
          <span className="tabular">{token.mint}</span>
          <span>dex: {token.dex ?? "?"}</span>
          <span>liq at discovery: {usd(token.liquidityUsd, 0)}</span>
          <span>first seen {timeAgo(token.firstSeenAt)}</span>
          <a
            className="hover:underline"
            style={{ color: "var(--series-1)" }}
            href={`https://dexscreener.com/solana/${token.mint}`}
            target="_blank"
            rel="noreferrer"
          >
            dexscreener ↗
          </a>
        </div>
      </div>

      <section className="card p-4">
        <h2 className="mb-3 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
          Safety checklist
        </h2>
        <div className="space-y-3">
          {[...latest.values()].map((check) => (
            <div key={check.id} className="border-t pt-3 first:border-t-0 first:pt-0" style={{ borderColor: "var(--gridline)" }}>
              <div className="flex items-center gap-2 text-sm">
                <span
                  className="inline-flex h-5 w-5 items-center justify-center rounded-full text-xs font-bold"
                  style={{
                    background: check.passed ? "rgba(12,163,12,0.18)" : "rgba(208,59,59,0.18)",
                    color: check.passed ? "var(--status-good)" : "var(--status-critical)",
                  }}
                >
                  {check.passed ? "✓" : "✗"}
                </span>
                <span className="font-medium">
                  {CHECK_LABELS[check.checkName] ?? check.checkName}
                </span>
                <span className="ml-auto text-xs" style={{ color: "var(--text-muted)" }}>
                  {timeAgo(check.checkedAt)}
                </span>
              </div>
              <pre
                className="tabular mt-2 overflow-x-auto rounded p-2 text-xs leading-relaxed"
                style={{ background: "var(--page)", color: "var(--text-secondary)" }}
              >
                {JSON.stringify(check.evidence, null, 2)}
              </pre>
            </div>
          ))}
          {latest.size === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              No safety checks recorded for this token.
            </p>
          ) : null}
        </div>
      </section>

      {/* Recorder view — how the scout watched this token unfold, entered or not */}
      {recorderOutcome ? (
        <section className="card p-4">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
              Recorder view · how the scout saw it
            </h2>
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              a &quot;winner&quot; here = a 2×+ move existed in the window — a market observation, not our trade
            </span>
          </div>
          <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            <Mini label="Label" value={String(recorderOutcome.label)} tone={recorderOutcome.label === "winner" ? "var(--status-good)" : recorderOutcome.label === "rug" ? "var(--status-critical)" : "var(--text-primary)"} />
            <Mini label="Peak" value={`${num(recorderOutcome.peakMultiple).toFixed(2)}×`} />
            <Mini label="Final" value={`${num(recorderOutcome.finalMultiple).toFixed(2)}×`} />
            <Mini label="Max DD" value={`${num(recorderOutcome.maxDrawdownFromPeakPct).toFixed(0)}%`} />
            <Mini label="→ Peak" value={recorderOutcome.minutesToPeak == null ? "—" : `${num(recorderOutcome.minutesToPeak).toFixed(0)}m`} />
            <Mini
              label="Scout trigger"
              value={recorderOutcome.triggeredAt ? `⚡ ${num(recorderOutcome.triggerMultiple).toFixed(2)}×` : "—"}
              tone={recorderOutcome.triggeredAt ? "var(--series-1)" : "var(--text-muted)"}
            />
          </div>
          {recorderOutcome.triggeredAt ? (
            <p className="mb-3 text-xs" style={{ color: "var(--text-muted)" }}>
              Confirmed for entry at {timeAgo(recorderOutcome.triggeredAt)} · {recorderOutcome.triggerReason ?? "confirmed demand"}
              {recorderOutcome.entered ? <span style={{ color: "var(--series-1)" }}> · we took a position</span> : <span> · not entered</span>}
            </p>
          ) : null}
          {recorderTrajectory.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs" style={{ color: "var(--text-muted)" }}>
                    <th className="pb-2 font-normal">Watch min</th>
                    <th className="pb-2 text-right font-normal">Mark</th>
                    <th className="pb-2 text-right font-normal">DD</th>
                    <th className="pb-2 text-right font-normal">Buy share</th>
                    <th className="pb-2 text-right font-normal">Liquidity</th>
                    <th className="pb-2 text-right font-normal">Score</th>
                    <th className="pb-2 text-right font-normal">Call</th>
                  </tr>
                </thead>
                <tbody>
                  {recorderTrajectory.map((t, i) => (
                    <tr key={i} className="border-t" style={{ borderColor: "var(--gridline)" }}>
                      <td className="tabular py-1.5 text-xs" style={{ color: "var(--text-muted)" }}>{t.watchMinutes.toFixed(1)}m</td>
                      <td className="tabular py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{t.markMultiple.toFixed(2)}×</td>
                      <td className="tabular py-1.5 text-right text-xs" style={{ color: t.drawdownFromPeakPct >= 10 ? "var(--status-warning)" : "var(--text-muted)" }}>{t.drawdownFromPeakPct.toFixed(0)}%</td>
                      <td className="tabular py-1.5 text-right text-xs" style={{ color: "var(--text-muted)" }}>{t.buyShareM5 == null ? "—" : `${(t.buyShareM5 * 100).toFixed(0)}%`}</td>
                      <td className="tabular py-1.5 text-right text-xs" style={{ color: "var(--text-muted)" }}>{t.liquidityUsd == null ? "—" : usd(t.liquidityUsd, 0)}</td>
                      <td className="tabular py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{t.continuationScore == null ? "—" : t.continuationScore.toFixed(0)}</td>
                      <td className="py-1.5 text-right text-xs" style={{ color: "var(--text-muted)" }}>{t.action ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>No recorder ticks captured for this token.</p>
          )}
        </section>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card p-4">
          <h2 className="mb-3 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
            Signals
          </h2>
          {signals.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              Never signaled.
            </p>
          ) : (
            signals.map((s) => (
              <div key={s.id} className="border-t py-2 first:border-t-0 first:pt-0 text-sm" style={{ borderColor: "var(--gridline)" }}>
                <div className="flex items-center gap-2">
                  <ScoreBadge score={Number(s.score)} />
                  <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                    {s.status}
                  </span>
                  <span className="ml-auto text-xs" style={{ color: "var(--text-muted)" }}>
                    {timeAgo(s.createdAt)}
                  </span>
                </div>
                <pre
                  className="tabular mt-2 overflow-x-auto rounded p-2 text-xs leading-relaxed"
                  style={{ background: "var(--page)", color: "var(--text-secondary)" }}
                >
                  {JSON.stringify(s.reasons, null, 2)}
                </pre>
              </div>
            ))
          )}
        </section>

        <section className="card p-4">
          <h2 className="mb-3 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
            Positions
          </h2>
          {positions.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>
              Never traded.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs" style={{ color: "var(--text-muted)" }}>
                  <th className="pb-2 font-normal">Lane</th>
                  <th className="pb-2 font-normal">Size</th>
                  <th className="pb-2 font-normal">Entry</th>
                  <th className="pb-2 font-normal">Exit</th>
                  <th className="pb-2 text-right font-normal">P&L</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => {
                  const pnl = Number(p.realizedPnlUsd ?? 0);
                  return (
                    <tr key={p.id} className="border-t" style={{ borderColor: "var(--gridline)" }}>
                      <td className="py-2 text-xs">{p.lane} · {p.status}</td>
                      <td className="tabular py-2">{usd(p.sizeUsd, 0)}</td>
                      <td className="tabular py-2">${Number(p.entryPriceUsd).toPrecision(4)}</td>
                      <td className="py-2 text-xs" style={{ color: "var(--text-muted)" }}>
                        {p.exitReason ?? "—"}
                      </td>
                      <td
                        className="tabular py-2 text-right font-medium"
                        style={{
                          color:
                            p.status === "closed"
                              ? pnl >= 0
                                ? "var(--status-good)"
                                : "var(--status-critical)"
                              : "var(--text-secondary)",
                        }}
                      >
                        {p.status === "closed" ? `${pnl >= 0 ? "+" : ""}${usd(pnl)}` : "open"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {/* Trade drill-down — fills + the classifier's tick-by-tick management calls
          on our most recent position in this token */}
      {(fills.length > 0 || mgmtTrajectory.length > 0) ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="card p-4">
            <h2 className="mb-3 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
              Fills · latest position
            </h2>
            {fills.length === 0 ? (
              <p className="text-sm" style={{ color: "var(--text-muted)" }}>No fills.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs" style={{ color: "var(--text-muted)" }}>
                    <th className="pb-2 font-normal">Side</th>
                    <th className="pb-2 text-right font-normal">Qty</th>
                    <th className="pb-2 text-right font-normal">Price</th>
                    <th className="pb-2 text-right font-normal">Slip</th>
                    <th className="pb-2 text-right font-normal">When</th>
                  </tr>
                </thead>
                <tbody>
                  {fills.map((f) => (
                    <tr key={f.id} className="border-t" style={{ borderColor: "var(--gridline)" }}>
                      <td className="py-1.5">
                        <span
                          className="inline-block w-9 rounded px-1 text-center text-xs font-semibold"
                          style={{
                            background: f.side === "buy" ? "rgba(57,135,229,0.18)" : "rgba(255,255,255,0.06)",
                            color: f.side === "buy" ? "var(--series-1)" : "var(--text-secondary)",
                          }}
                        >
                          {f.side}
                        </span>
                      </td>
                      <td className="tabular py-1.5 text-right text-xs" style={{ color: "var(--text-muted)" }}>{num(f.qtyTokens).toPrecision(3)}</td>
                      <td className="tabular py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>${num(f.priceUsd).toPrecision(4)}</td>
                      <td className="tabular py-1.5 text-right text-xs" style={{ color: num(f.slippagePct) >= 10 ? "var(--status-warning)" : "var(--text-muted)" }}>{num(f.slippagePct).toFixed(1)}%</td>
                      <td className="py-1.5 text-right text-xs" style={{ color: "var(--text-muted)" }}>{timeAgo(f.filledAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="card p-4">
            <h2 className="mb-1 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>
              Management trajectory · every ride/cut call
            </h2>
            <p className="mb-3 text-xs" style={{ color: "var(--text-muted)" }}>
              The classifier&apos;s read on each poll while we held it — how the position was managed to its exit.
            </p>
            {mgmtTrajectory.length === 0 ? (
              <p className="text-sm" style={{ color: "var(--text-muted)" }}>No management ticks recorded.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs" style={{ color: "var(--text-muted)" }}>
                      <th className="pb-2 font-normal">Age</th>
                      <th className="pb-2 text-right font-normal">Mark</th>
                      <th className="pb-2 text-right font-normal">Peak</th>
                      <th className="pb-2 text-right font-normal">DD</th>
                      <th className="pb-2 text-right font-normal">Liquidity</th>
                      <th className="pb-2 text-right font-normal">Score</th>
                      <th className="pb-2 text-right font-normal">Regime</th>
                      <th className="pb-2 text-right font-normal">Call</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mgmtTrajectory.map((t, i) => (
                      <tr key={i} className="border-t" style={{ borderColor: "var(--gridline)" }}>
                        <td className="tabular py-1.5 text-xs" style={{ color: "var(--text-muted)" }}>{t.ageMinutes.toFixed(0)}m</td>
                        <td className="tabular py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{t.markMultiple.toFixed(2)}×</td>
                        <td className="tabular py-1.5 text-right text-xs" style={{ color: "var(--text-muted)" }}>{t.peakMultiple.toFixed(2)}×</td>
                        <td className="tabular py-1.5 text-right text-xs" style={{ color: t.drawdownFromPeakPct >= 20 ? "var(--status-warning)" : "var(--text-muted)" }}>{t.drawdownFromPeakPct.toFixed(0)}%</td>
                        <td className="tabular py-1.5 text-right text-xs" style={{ color: t.liquidityUsd != null && t.liquidityUsd < 1000 ? "var(--status-warning)" : "var(--text-muted)" }} title={t.liquidityUsd != null && t.liquidityUsd < 1000 ? "sub-$1k read — likely an empty-pool flicker, not a real drain" : undefined}>{t.liquidityUsd == null ? "—" : usd(t.liquidityUsd, 0)}</td>
                        <td className="tabular py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>{t.continuationScore == null ? "—" : t.continuationScore.toFixed(0)}</td>
                        <td className="py-1.5 text-right text-xs" style={{ color: "var(--text-muted)" }}>{t.regime ?? "—"}</td>
                        <td className="py-1.5 text-right text-xs font-semibold" style={{ color: ACTION_COLOR[t.action ?? ""] ?? "var(--text-muted)" }}>{t.action ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}

const ACTION_COLOR: Record<string, string> = {
  RIDE: "var(--status-good)",
  TRIM: "var(--series-1)",
  CUT: "var(--status-critical)",
  HOLD: "var(--text-muted)",
};

function Mini({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-xs" style={{ color: "var(--text-muted)" }}>{label}</div>
      <div className="tabular text-lg font-semibold" style={{ color: tone ?? "var(--text-primary)" }}>{value}</div>
    </div>
  );
}
