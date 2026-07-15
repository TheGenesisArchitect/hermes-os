// News synthesis: turn our OWN proprietary market observations (movers, rugs,
// theme aggregates, regime) into grounded, repackageable content via local qwen.
//
// Two hard rules, both from hard-won lessons:
//  1. CATEGORY is a controlled enum (for ML aggregation + "emerging theme"
//     detection); NARRATIVE is free-text (for display + capturing the next meme
//     the enum doesn't have yet). Keying ML off free-text would fragment the same
//     theme into n=1 rows — the exact trigger_reason mistake.
//  2. GROUNDING: synthesis may use ONLY the numbers/labels we observed. It must
//     not assert facts about a token's team/project/backstory — this is
//     public-facing content and a confabulated claim repackaged into a post is a
//     credibility hit. "Why it matters" is pattern-analytical, never about the coin.
import { z } from "zod/v4";
import { ollamaJson } from "../llm/ollama.js";

/** Controlled top-level narrative buckets. Grow this list by periodic review of
 *  the free-text `narrative` field — do NOT let the model invent enum members. */
export const NEWS_CATEGORIES = [
  "ai-agents",
  "politics",
  "celebrity",
  "animal",
  "meme-viral",
  "defi-infra",
  "commodity",
  "culture",
  "other",
] as const;
export type NewsCategory = (typeof NEWS_CATEGORIES)[number];

const GROUNDING = [
  "You are Hermes, a Solana memecoin market analyst writing for a trader building genuine expertise.",
  "You may ONLY use the numeric observations and labels provided (price multiples, timings, liquidity, win/loss/rug outcomes, counts, rates).",
  "You must NOT invent or assert ANY fact about a token's team, project, partnership, roadmap, backers, or real-world backstory — you have no such information and stating any is fabrication that destroys the reader's credibility.",
  "'Why it matters' is PATTERN-ANALYTICAL: what the observed microstructure and outcome imply about how THIS MARKET behaves — never claims about the coin itself.",
  "Classify category only by the apparent narrative hook of the name/symbol; when unsure use 'other'.",
  "Use the EXACT terms given: 'liquidity' means liquidity — never call it 'volume' or 'liquidation'. Do not mention winners, losers, holders, or buyers you were not explicitly told about.",
  "'narrative' is a SHORT NOUN PHRASE (≤8 words), never a sentence. 'headline' is punchy and specific, never circular (bad: 'X's peak validates its mover status'; good: 'USOH ran 167x in 66 seconds, then round-tripped to flat').",
  "'whyItMatters' MUST be a real 2-3 sentence pattern analysis — never a placeholder like 'default' or 'testing'. It is the most important field; put your best analytical thinking here, not in the content drafts.",
  "'importance' is an INTEGER 0-100 (100 = most market-significant).",
  "End every field on a complete sentence — never cut off mid-word. Do NOT use hype words ('explosive', 'mind-blowing', 'jaw-dropping', 'insane', 'to the moon'). Be sharp and factual. No price predictions, no financial advice, no emoji.",
].join(" ");

// ── Mover story ─────────────────────────────────────────────────────────────
export interface MoverInput {
  symbol: string;
  name?: string;
  source?: string; // dex / launchpad
  refToPeakMultiple: number; // peak vs first-seen reference
  finalMultiple: number;
  minutesToPeak?: number | null;
  peakLiquidityUsd?: number | null;
  outcome: string; // winner | dud | rug | delisted
}

// Field order matters for small models: the analytical fields come FIRST so the
// model spends its effort there, and the derived content drafts LAST. Maxes are
// generous (validation guards only) — real target lengths live in the prose
// instructions, so the model finishes sentences instead of hard-truncating.
const MoverStory = z.object({
  headline: z.string().max(140).describe("Punchy, specific, ≤12 words. Never circular. No hype adjectives."),
  category: z.enum(NEWS_CATEGORIES),
  narrative: z.string().max(80).describe("SHORT NOUN PHRASE naming the hook, ≤8 words, e.g. 'AI water scarcity'. NOT a sentence."),
  whyItMatters: z
    .string()
    .max(600)
    .describe("2-3 full sentences of PATTERN analysis grounded strictly in the provided numbers. Your best thinking goes here."),
  importance: z.number().int().min(0).max(100),
  contentDrafts: z.object({
    xPost: z.string().max(320).describe("One ready-to-post note, aim ≤260 chars, end on a complete sentence, no invented facts"),
    shortTake: z.string().max(220).describe("One complete sentence analyst take"),
  }),
});
export type MoverStory = z.infer<typeof MoverStory>;

export async function synthesizeMover(input: MoverInput, model?: string): Promise<MoverStory | null> {
  const user = [
    "Observed mover (all facts you may use):",
    `- symbol: ${input.symbol}`,
    input.name ? `- name: ${input.name}` : "",
    input.source ? `- source: ${input.source}` : "",
    `- peak was ${input.refToPeakMultiple.toFixed(2)}x the first-seen reference price`,
    `- ended the 15-min window at ${input.finalMultiple.toFixed(2)}x reference`,
    input.minutesToPeak != null ? `- minutes from first-seen to peak: ${input.minutesToPeak.toFixed(1)}` : "",
    input.peakLiquidityUsd != null ? `- peak liquidity: $${Math.round(input.peakLiquidityUsd).toLocaleString()}` : "",
    `- recorder outcome label: ${input.outcome}`,
    "",
    "Write the mover story. Ground every claim in these numbers only.",
  ]
    .filter(Boolean)
    .join("\n");
  return ollamaJson({ system: GROUNDING, user, schema: MoverStory, model, temperature: 0.4 });
}

// ── Cheap category classification (breadth, for emerging-theme aggregation) ──
// A tiny fast call: category + narrative only. Run over many candidates so the
// theme aggregates have coverage; full synthesizeMover is reserved for the few
// headline movers. Keying ML off `category` (not free-text) is the whole point.
const CategoryOnly = z.object({
  category: z.enum(NEWS_CATEGORIES),
  narrative: z.string().max(60).describe("SHORT NOUN PHRASE, ≤8 words, naming the hook"),
});
export type CategoryOnly = z.infer<typeof CategoryOnly>;

export async function classifyCategory(
  token: { symbol: string; name?: string },
  model?: string,
): Promise<CategoryOnly | null> {
  const user = `Classify this Solana token's narrative by its name only. symbol="${token.symbol}"${token.name ? `, name="${token.name}"` : ""}. Return the category enum + a short narrative phrase. No other analysis.`;
  return ollamaJson({ system: GROUNDING, user, schema: CategoryOnly, model, temperature: 0.2, timeoutMs: 30_000 });
}

// ── Market brief (theme/regime digest — the headline content) ────────────────
export interface ThemeStat {
  category: NewsCategory;
  launches: number;
  winners: number;
  winRatePct: number;
  volumeGrowthPct: number; // recent-window launch count vs prior window
  emergingScore: number; // volumeGrowth * winRate, precomputed
}
export interface BriefInput {
  windowHours: number;
  totalLaunches: number;
  confirmedTriggers: number;
  overallWinRatePct: number;
  themes: ThemeStat[]; // ranked by emergingScore desc
  topMovers: { symbol: string; refToPeakMultiple: number; outcome: string }[];
  rugCount: number;
}

const MarketBrief = z.object({
  headline: z.string().describe("The single most important market read right now, max ~12 words"),
  whyItMatters: z.string().describe("3-4 sentences of grounded market analysis from the aggregates provided"),
  keyThemes: z.array(z.string()).describe("2-4 display phrases naming what is heating up, grounded in the theme stats"),
  contentDrafts: z.object({
    xThread: z.array(z.string()).describe("3-5 tweets, each <=280 chars, a coherent grounded thread"),
    shortTake: z.string().describe("One-sentence market summary"),
  }),
});
export type MarketBrief = z.infer<typeof MarketBrief>;

export async function synthesizeBrief(input: BriefInput, model?: string): Promise<MarketBrief | null> {
  const themeLines = input.themes
    .map(
      (t) =>
        `- ${t.category}: ${t.launches} launches, ${t.winners} winners (${t.winRatePct.toFixed(0)}% win rate), launch volume ${t.volumeGrowthPct >= 0 ? "+" : ""}${t.volumeGrowthPct.toFixed(0)}% vs prior window, emerging-score ${t.emergingScore.toFixed(1)}`,
    )
    .join("\n");
  const moverLines = input.topMovers
    .map((m) => `- ${m.symbol}: peaked ${m.refToPeakMultiple.toFixed(2)}x (${m.outcome})`)
    .join("\n");
  const user = [
    `Market aggregates over the last ${input.windowHours}h (all facts you may use):`,
    `- ${input.totalLaunches} tokens scanned/launched, ${input.confirmedTriggers} confirmation triggers fired`,
    `- overall confirmed win rate: ${input.overallWinRatePct.toFixed(0)}%`,
    `- ${input.rugCount} rugs/traps blocked or observed`,
    "",
    "Theme aggregates (an emerging theme = rising launch volume AND above-average win rate):",
    themeLines || "- (no theme data)",
    "",
    "Top movers:",
    moverLines || "- (none)",
    "",
    "Write the market brief. Lead with the strongest emerging pattern. Ground everything in these aggregates only.",
  ].join("\n");
  return ollamaJson({ system: GROUNDING, user, schema: MarketBrief, model, temperature: 0.5 });
}
