// Keyless local LLM client — talks to Ollama on localhost:11434. This is the ONLY
// LLM Hermes uses: no pay gate, no Anthropic key (the Anthropic-based
// scoreNarrative is dead code — the key is never set here by design). Everything
// degrades gracefully to null on any failure, because the news desk must never be
// a hard dependency and must never block the trader.
import { z } from "zod/v4";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
// Default to 3b: on this box, under the live 4-service load, qwen2.5:7b (4.7GB)
// thrashes and hangs — 3b (1.9GB) stays responsive. Override with OLLAMA_MODEL to
// a heavier model when the machine is idle or on better hardware (the pipeline is
// model-agnostic — it just changes prose quality, not structure).
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5:3b";

export interface OllamaJsonArgs<T> {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  model?: string;
  timeoutMs?: number;
  temperature?: number;
}

/**
 * Structured chat completion with schema-constrained JSON output. Uses Ollama's
 * `format` field (a JSON Schema) so qwen is decoded straight into the shape, then
 * validates with zod. Returns null on timeout, transport error, bad JSON, or a
 * schema-validation miss — the caller always handles null.
 */
export async function ollamaJson<T>(args: OllamaJsonArgs<T>): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs ?? 60_000);
  try {
    const jsonSchema = z.toJSONSchema(args.schema, { target: "draft-7" });
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: args.model ?? OLLAMA_MODEL,
        stream: false,
        format: jsonSchema,
        options: { temperature: args.temperature ?? 0.4 },
        messages: [
          { role: "system", content: args.system },
          { role: "user", content: args.user },
        ],
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { message?: { content?: string } };
    const content = body.message?.content;
    if (!content) return null;
    const parsed = args.schema.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Cheap liveness probe so surfaces can show "news desk offline" instead of hanging. */
export async function ollamaUp(timeoutMs = 3_000): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
