"use client";

import { useState } from "react";

type Drafts = { xPost?: string; shortTake?: string; xThread?: string[] } | null;

/**
 * Normalize LLM-shaped drafts before rendering. The drafts JSON is written by
 * the local model and its shape DRIFTS between runs: xThread arrives as a
 * string (passes a truthy `.length` check, then `.map` throws — an Uncaught
 * client crash), or as an array of objects (invalid React children). Coerce
 * everything to plain strings once, here, so no shape ever reaches JSX raw.
 */
function normalizeDrafts(raw: unknown): { xPost: string | null; shortTake: string | null; xThread: string[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
  let thread: string[] = [];
  const t = d.xThread;
  if (Array.isArray(t)) {
    thread = t.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).filter((x) => x.trim());
  } else if (typeof t === "string" && t.trim()) {
    thread = t.split(/\n+/).filter((x) => x.trim()); // a string thread = newline-separated posts
  }
  const xPost = str(d.xPost);
  const shortTake = str(d.shortTake);
  if (!xPost && !shortTake && thread.length === 0) return null;
  return { xPost, shortTake, xThread: thread };
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        } catch {
          /* clipboard blocked — non-fatal */
        }
      }}
      className="rounded-md px-2 py-1 text-[11px] font-medium transition-colors hover:brightness-125"
      style={{
        background: copied ? "var(--status-good)" : "var(--surface-2, var(--surface-1))",
        color: copied ? "#04120a" : "var(--text-secondary)",
        border: "1px solid var(--border)",
      }}
    >
      {copied ? "✓ copied" : label}
    </button>
  );
}

/**
 * The content-studio affordance: takes a story's drafts and lets the user copy a
 * ready-to-edit post/thread. Framed as a starting point — every draft is edited
 * before it goes out (the model is grounded but not authoritative).
 */
export function RepackagePanel({ drafts: rawDrafts }: { drafts: Drafts }) {
  const [open, setOpen] = useState(false);
  const drafts = normalizeDrafts(rawDrafts);
  if (!drafts) return null;

  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-[11px] font-medium transition-colors hover:brightness-125"
        style={{ color: "var(--series-1)" }}
      >
        <span>{open ? "▾" : "▸"}</span> Repackage
      </button>
      {open ? (
        <div
          className="mt-2 space-y-3 rounded-lg p-3"
          style={{ background: "var(--surface-1)", border: "1px solid var(--gridline)" }}
        >
          {drafts.xThread && drafts.xThread.length ? (
            <Draft label="Thread">
              <ol className="space-y-1.5">
                {drafts.xThread.map((t, i) => (
                  <li key={i} className="text-xs leading-relaxed" style={{ color: "var(--text-primary)" }}>
                    <span style={{ color: "var(--text-muted)" }}>{i + 1}/</span> {t}
                  </li>
                ))}
              </ol>
              <div className="mt-2">
                <CopyButton text={drafts.xThread.map((t, i) => `${i + 1}/ ${t}`).join("\n\n")} label="Copy thread" />
              </div>
            </Draft>
          ) : null}
          {drafts.xPost ? (
            <Draft label="Post">
              <p className="text-xs leading-relaxed" style={{ color: "var(--text-primary)" }}>
                {drafts.xPost}
              </p>
              <div className="mt-2">
                <CopyButton text={drafts.xPost} label="Copy post" />
              </div>
            </Draft>
          ) : null}
          {drafts.shortTake ? (
            <Draft label="Short take">
              <p className="text-xs leading-relaxed" style={{ color: "var(--text-primary)" }}>
                {drafts.shortTake}
              </p>
              <div className="mt-2">
                <CopyButton text={drafts.shortTake} label="Copy" />
              </div>
            </Draft>
          ) : null}
          <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>
            AI-drafted from our observed numbers — edit before posting.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function Draft({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
        {label}
      </div>
      {children}
    </div>
  );
}
