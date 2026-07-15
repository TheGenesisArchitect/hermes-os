"use client";

/**
 * Global error boundary — when a client component throws, show the ACTUAL
 * error on a dark card instead of a dead white page or a truncated console
 * line. The operator triages by screenshot; this page makes every future
 * crash self-reporting: name, message, digest, and the top of the stack.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const stackHead = (error.stack ?? "").split("\n").slice(0, 6).join("\n");
  return (
    <main className="mx-auto max-w-3xl px-5 py-10" style={{ color: "var(--text-primary)" }}>
      <div className="rounded-xl p-6" style={{ background: "var(--surface-1)", border: "1px solid var(--status-critical)" }}>
        <div className="mb-1 text-[10px] uppercase tracking-wide" style={{ color: "var(--status-critical)" }}>
          Client error — snapshot this card
        </div>
        <h1 className="text-lg font-semibold">{error.name}: {error.message || "(no message)"}</h1>
        {error.digest ? (
          <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>digest {error.digest}</p>
        ) : null}
        {stackHead ? (
          <pre className="mt-3 overflow-x-auto rounded-md p-3 text-[11px] leading-relaxed" style={{ background: "var(--page)", color: "var(--text-secondary)" }}>
            {stackHead}
          </pre>
        ) : null}
        <button
          onClick={() => reset()}
          className="mt-4 rounded-md px-3 py-1.5 text-sm font-medium"
          style={{ background: "var(--series-1)", color: "#fff" }}
        >
          Try again
        </button>
      </div>
    </main>
  );
}
