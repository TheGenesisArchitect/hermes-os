"use client";

// GENESIS QUANT DRAWER — the copilot's face. Slide-over chat grounded in a
// live universe snapshot built server-side (/api/quant). Read-only by
// construction: the brain discusses the desk; the cockpit buttons run it.
import { useEffect, useRef, useState } from "react";

interface Msg {
  role: "user" | "assistant";
  content: string;
}

const OPENERS = [
  "How's the proof gate tracking?",
  "Why did we skip the last few buys?",
  "Where is paper making money today?",
  "What's the moon funnel look like?",
];

export function QuantDrawer() {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [brain, setBrain] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, busy]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    const next: Msg[] = [...msgs, { role: "user", content }];
    setMsgs(next);
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/api/quant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });
      const j = (await res.json()) as { answer?: string; error?: string; brain?: string };
      if (j.brain) setBrain(j.brain);
      setMsgs([...next, { role: "assistant", content: j.answer ?? `⚠ ${j.error ?? "no answer"}` }]);
    } catch {
      setMsgs([...next, { role: "assistant", content: "⚠ quant unreachable — check the dashboard service logs" }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(!open)}
        className="fixed bottom-5 right-5 z-50 rounded-full px-4 py-2 text-sm font-semibold shadow-lg"
        style={{ background: "var(--series-1)", color: "#0a0a0a" }}
        aria-label="Genesis Quant copilot"
      >
        ◆ Quant
      </button>
      {open && (
        <div
          className="fixed bottom-16 right-5 z-50 flex h-[36rem] w-[26rem] max-w-[calc(100vw-2.5rem)] flex-col rounded-xl border shadow-2xl"
          style={{ background: "var(--panel, #111)", borderColor: "var(--border)" }}
        >
          <div className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: "var(--border)" }}>
            <span className="font-semibold">Genesis Quant</span>
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              {brain ? `brain: ${brain}` : "always-on analyst · read-only"}
            </span>
            <button className="ml-auto text-xs" style={{ color: "var(--text-muted)" }} onClick={() => setOpen(false)}>
              ✕
            </button>
          </div>
          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3 text-sm">
            {msgs.length === 0 && (
              <div className="space-y-2">
                <p style={{ color: "var(--text-muted)" }}>
                  Ask about the universe — the gate, the funnel, skips, moons, the wallet. Answers are grounded in a
                  live snapshot taken the moment you ask.
                </p>
                {OPENERS.map((o) => (
                  <button
                    key={o}
                    onClick={() => void send(o)}
                    className="block w-full rounded-md border px-3 py-2 text-left text-xs hover:opacity-80"
                    style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
                  >
                    {o}
                  </button>
                ))}
              </div>
            )}
            {msgs.map((m, i) => (
              <div key={i} className={m.role === "user" ? "text-right" : ""}>
                <div
                  className="inline-block max-w-[90%] whitespace-pre-wrap rounded-lg px-3 py-2 text-left"
                  style={
                    m.role === "user"
                      ? { background: "var(--series-1)", color: "#0a0a0a" }
                      : { background: "rgba(127,127,127,0.12)" }
                  }
                >
                  {m.content}
                </div>
              </div>
            ))}
            {busy && (
              <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                reading the tape…
              </div>
            )}
            <div ref={bottomRef} />
          </div>
          <form
            className="flex gap-2 border-t px-3 py-3"
            style={{ borderColor: "var(--border)" }}
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask the quant…"
              className="flex-1 rounded-md border bg-transparent px-3 py-2 text-sm outline-none"
              style={{ borderColor: "var(--border)" }}
            />
            <button
              type="submit"
              disabled={busy}
              className="rounded-md px-3 py-2 text-sm font-semibold disabled:opacity-50"
              style={{ background: "var(--series-1)", color: "#0a0a0a" }}
            >
              →
            </button>
          </form>
        </div>
      )}
    </>
  );
}
