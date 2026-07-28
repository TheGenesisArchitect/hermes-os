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

const GROQ_URL = process.env.GROQ_URL ?? "https://api.groq.com/openai/v1";
const GROQ_KEY = process.env.GROQ_API_KEY ?? "";
export const GROQ_MODEL = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";

/** Which brain is answering — for log lines and the health panel. */
export function quantProvider(): "groq" | "ollama" {
  return GROQ_KEY ? "groq" : "ollama";
}

async function groqJson<T>(args: OllamaJsonArgs<T>): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs ?? 45_000);
  try {
    const jsonSchema = z.toJSONSchema(args.schema, { target: "draft-7" });
    const res = await fetch(`${GROQ_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${GROQ_KEY}` },
      signal: controller.signal,
      body: JSON.stringify({
        model: GROQ_MODEL,
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
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Structured completion through the best available brain. Groq first (when
 * keyed), local Ollama as the fallback; null only when BOTH miss. The `model`
 * arg is honored only on the Ollama path — Groq's model is GROQ_MODEL.
 */
export async function llmJson<T>(args: OllamaJsonArgs<T>): Promise<T | null> {
  if (GROQ_KEY) {
    const viaGroq = await groqJson(args);
    if (viaGroq != null) return viaGroq;
  }
  return ollamaJson(args);
}

/** Liveness for surfaces: Groq keyed counts as up (probed cheaply), else Ollama. */
export async function llmUp(timeoutMs = 3_000): Promise<boolean> {
  if (GROQ_KEY) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${GROQ_URL}/models`, {
        headers: { authorization: `Bearer ${GROQ_KEY}` },
        signal: controller.signal,
      });
      if (res.ok) return true;
    } catch {
      /* fall through to ollama */
    } finally {
      clearTimeout(timeout);
    }
  }
  return ollamaUp(timeoutMs);
}
