import Link from "next/link";
import { notFound } from "next/navigation";
import { ScoreBadge, timeAgo, usd } from "@/components/ui";
import { getTokenDetail } from "@/lib/queries";

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
  const { token, checks, signals, positions } = detail;

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
    </div>
  );
}
