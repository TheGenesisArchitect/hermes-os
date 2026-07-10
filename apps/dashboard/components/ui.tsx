import Link from "next/link";

export function StatTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "good" | "bad" | "neutral";
}) {
  const color =
    tone === "good"
      ? "var(--status-good)"
      : tone === "bad"
        ? "var(--status-critical)"
        : "var(--text-primary)";
  return (
    <div className="card px-4 py-3">
      <div className="text-xs uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold" style={{ color }}>
        {value}
      </div>
      {sub ? (
        <div className="mt-0.5 text-xs" style={{ color: "var(--text-secondary)" }}>
          {sub}
        </div>
      ) : null}
    </div>
  );
}

export function ScoreBadge({ score }: { score: number }) {
  // score is data, not status — muted ink with a threshold marker
  const strong = score >= 55;
  return (
    <span
      className="tabular inline-block rounded px-1.5 py-0.5 text-xs font-semibold"
      style={{
        background: strong ? "rgba(57,135,229,0.18)" : "transparent",
        border: `1px solid ${strong ? "var(--series-1)" : "var(--border)"}`,
        color: strong ? "var(--series-1)" : "var(--text-secondary)",
      }}
    >
      {score.toFixed(0)}
    </span>
  );
}

export function MintLink({ mint, symbol }: { mint: string; symbol?: string | null }) {
  return (
    <Link
      href={`/token/${mint}`}
      className="hover:underline"
      style={{ color: "var(--text-primary)" }}
    >
      <span className="font-medium">{symbol ?? "?"}</span>{" "}
      <span className="text-xs" style={{ color: "var(--text-muted)" }}>
        {mint.slice(0, 4)}…{mint.slice(-4)}
      </span>
    </Link>
  );
}

export function timeAgo(date: Date | string | null): string {
  if (!date) return "—";
  const ms = Date.now() - new Date(date).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ${min % 60}m ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function usd(v: number | string | null | undefined, digits = 2): string {
  const num = Number(v ?? 0);
  return num.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}
