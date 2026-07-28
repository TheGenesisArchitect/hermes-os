// GENESIS QUANT LLM ROUTER (operator 2026-07-28: "Groq would be an incredible
// addition... our Genesis Quant plugged in and working around the clock").
// Provider-routing client with the same contract as the Ollama client it
// wraps: schema-constrained JSON in, validated T | null out, degrades to null
// on ANY failure — the quant lane must never block or crash the trading desk.
//
// Routing: GROQ_API_KEY set → Groq (llama-3.3-70b-class brain, ~100x the
// local 3b, JSON mode, pennies per call). Groq miss or no key → local Ollama
// fallback, so the news desk keeps speaking through outages exactly as before.
//
// HARD LINE (ratified at design): this client is ANALYST-ONLY. Nothing in the
// live trade path may depend on it; its callers write narrative/hypothesis
// tables and audit rows, never positions.
import { z } from "zod/v4";
import { ollamaJson, ollamaUp, type OllamaJsonArgs } from "./ollama.js";
// resilientFetch, not raw fetch: this host's DPI resets undici on some TLS
// endpoints (the rpc-pool disease) — from the DASHBOARD runtime the Groq call
// hung to its 50s timeout while plain curl answered in <1s (quant drawer 503,
// 2026-07-28). resilientFetch fails over to curl per-host, transparently.
import { resilientFetch } from "../net.js";

// Env is read LAZILY at call time, not module scope: dotenv loads after these
// modules are imported (the OLLAMA_MODEL const has silently ignored .env
// overrides forever for exactly this reason — the 'qwen2.5:3b vs hermes3:3b'
// log quirk, diagnosed 2026-07-28 when GROQ_API_KEY came up empty).
const groqUrl = () => process.env.GROQ_URL ?? "https://api.groq.com/openai/v1";
const groqKey = () => process.env.GROQ_API_KEY ?? "";
export const GROQ_MODEL = "llama-3.3-70b-versatile";
const groqModel = () => process.env.GROQ_MODEL ?? GROQ_MODEL;

/** Which brain is answering — for log lines and the health panel. */
export function quantProvider(): "groq" | "ollama" {
  return groqKey() ? "groq" : "ollama";
}

async function groqJson<T>(args: OllamaJsonArgs<T>): Promise<T | null> {
  try {
    const jsonSchema = z.toJSONSchema(args.schema, { target: "draft-7" });
    const res = await resilientFetch(`${groqUrl()}/chat/completions`, {
      method: "POST",
      timeoutMs: args.timeoutMs ?? 45_000,
      headers: { "content-type": "application/json", authorization: `Bearer ${groqKey()}` },
      body: JSON.stringify({
        model: groqModel(),
        temperature: args.temperature ?? 0.4,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `${args.system}\n\nRespond ONLY with a single JSON object matching this JSON Schema exactly (no prose, no markdown):\n${JSON.stringify(jsonSchema)}`,
          },
          { role: "user", content: args.user },
        ],
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = args.schema.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Structured completion through the best available brain. Groq first (when
 * keyed), local Ollama as the fallback; null only when BOTH miss. The `model`
 * arg is honored only on the Ollama path — Groq's model is GROQ_MODEL.
 */
export async function llmJson<T>(args: OllamaJsonArgs<T>): Promise<T | null> {
  if (groqKey()) {
    const viaGroq = await groqJson(args);
    if (viaGroq != null) return viaGroq;
  }
  return ollamaJson(args);
}

/**
 * Free-prose completion for surfaces that don't want to carry a zod instance
 * (the dashboard's quant drawer): wraps llmJson with an internal one-field
 * schema and returns the text, or null when both brains miss.
 */
const AnswerSchema = z.object({
  answer: z.string().describe("Direct, grounded answer in plain prose. Cite only figures you were given; never invent numbers."),
});
export async function llmText(system: string, user: string, timeoutMs = 50_000): Promise<string | null> {
  const out = await llmJson({ system, user, schema: AnswerSchema, timeoutMs });
  return out?.answer ?? null;
}

/** Liveness for surfaces: Groq keyed counts as up (probed cheaply), else Ollama. */
export async function llmUp(timeoutMs = 3_000): Promise<boolean> {
  if (groqKey()) {
    try {
      const res = await resilientFetch(`${groqUrl()}/models`, {
        timeoutMs,
        headers: { authorization: `Bearer ${groqKey()}` },
      });
      if (res.ok) return true;
    } catch {
      /* fall through to ollama */
    }
  }
  return ollamaUp(timeoutMs);
}
