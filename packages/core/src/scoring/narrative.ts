import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
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

let client: Anthropic | null = null;

/**
 * Score how strong a token's narrative hook is right now (0-100) using Claude.
 * Returns null when no ANTHROPIC_API_KEY is configured — the composite score
 * then falls back to a neutral narrative component.
 */
export async function scoreNarrative(
  apiKey: string,
  token: { name?: string; symbol?: string; dex?: string; liquidityUsd?: number },
): Promise<NarrativeScore | null> {
  if (!apiKey) return null;
  client ??= new Anthropic({ apiKey });

  const response = await client.messages.parse({
    model: "claude-opus-4-8",
    max_tokens: 1024,
    output_config: {
      format: zodOutputFormat(NarrativeVerdict),
      effort: "low",
    },
    system:
      "You are a memecoin narrative analyst. You score how strong and timely a new Solana token's narrative hook is, based only on its name/symbol. High scores (70+) need a hook tied to a live cultural or news cycle (AI, politics, viral memes, commodities scarcity). Generic animal/food coins with no twist score low (10-30). Obvious copycats of existing tickers score very low (0-10).",
    messages: [
      {
        role: "user",
        content: `New token launch: symbol "${token.symbol ?? "?"}", name "${token.name ?? "?"}", dex ${token.dex ?? "?"}, liquidity $${Math.round(token.liquidityUsd ?? 0)}. Score its narrative strength.`,
      },
    ],
  });

  return response.parsed_output ?? null;
}
