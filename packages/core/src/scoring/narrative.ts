import { z } from "zod/v4";

const NarrativeVerdict = z.object({
  score: z.number().describe("0-100: how strong and current the narrative hook is"),
  narrative: z.string().describe("One short phrase naming the narrative, e.g. 'AI water scarcity'"),
  reasoning: z.string().describe("One sentence explaining the score"),
});

export interface NarrativeScore {
  score: number;
  narrative: string;
  reasoning: string;
}

const SYSTEM_PROMPT =
  "You are a memecoin narrative analyst. You score how strong and timely a new Solana token's narrative hook is, based only on its name/symbol. High scores (70+) need a hook tied to a live cultural or news cycle (AI, politics, viral memes, commodities scarcity). Generic animal/food coins with no twist score low (10-30). Obvious copycats of existing tickers score very low (0-10). Reply with ONLY a JSON object, no prose: {\"score\": number 0-100, \"narrative\": \"short hook phrase\", \"reasoning\": \"one sentence\"}.";

/** Extract the verdict object from an OpenAI-compatible chat.completions body. */
function verdictFromChat(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return null;
  const content = (payload as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
  if (typeof content !== "string") return null;
  // Tolerant: the model may wrap the JSON in prose or a code fence.
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Score how strong a token's narrative hook is right now (0-100) via the
 * internal Narrative API — the OmniRoute gateway (OpenAI-compatible
 * /v1/chat/completions), keeping a vendor SDK out of the critical path.
 * Returns null when no API URL is configured or the call fails — the
 * composite score then falls back to a neutral narrative component.
 */
export async function scoreNarrative(
  apiUrl: string,
  token: { name?: string; symbol?: string; dex?: string; liquidityUsd?: number },
  apiKey = "",
): Promise<NarrativeScore | null> {
  if (!apiUrl) return null;

  // Accept a base (http://host:port), a /v1 root, or a full endpoint URL.
  const base = apiUrl.replace(/\/+$/, "");
  const endpoint = /\/chat\/completions$/.test(base)
    ? base
    : /\/v1$/.test(base)
      ? `${base}/chat/completions`
      : `${base}/v1/chat/completions`;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // OmniRoute loopback is unauthenticated by design; any non-empty string works.
        authorization: `Bearer ${apiKey || "omniroute"}`,
      },
      body: JSON.stringify({
        // Latency-sensitive per-candidate scoring; the cheap alias resolved to a
        // provider that ignored the output contract (probe: scripts/probe-narrative.ts).
        model: "auto/best-fast",
        stream: false, // OmniRoute combo routes default to SSE; we want one JSON body.
        max_tokens: 512,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `New token launch: symbol "${token.symbol ?? "?"}", name "${token.name ?? "?"}", dex ${token.dex ?? "?"}, liquidity $${Math.round(token.liquidityUsd ?? 0)}. Score its narrative strength.`,
          },
        ],
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return null; // gateway down / timeout → neutral narrative, never block scoring
  }

  if (!response.ok) return null;

  const payload = (await response.json().catch(() => null)) as unknown;
  const parsed = NarrativeVerdict.safeParse(verdictFromChat(payload));
  return parsed.success ? parsed.data : null;
}
