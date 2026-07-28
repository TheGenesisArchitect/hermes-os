// NEW FRONTIER FEED (operator 2026-07-28: "Groq would also be aware of what's
// happening outside the Solana Universe... collecting a watchlist of 100x
// opportunities" + "Notifications become the Professional Report our Users can
// now digest"). Keyless RSS ingestion from major crypto desks → 70B
// classification into structured frontier items → a professional report.
// RESEARCH LANE ONLY: nothing here touches trading; the watchlist earns paper
// exploration first and real capital only on operator ratification.
import { z } from "zod/v4";
import { llmJson } from "../llm/quant.js";

export const FRONTIER_FEEDS: { source: string; url: string }[] = [
  { source: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { source: "Cointelegraph", url: "https://cointelegraph.com/rss" },
  { source: "Decrypt", url: "https://decrypt.co/feed" },
];

export interface FeedItem {
  source: string;
  title: string;
  link: string;
}

const strip = (s: string) =>
  s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').trim();

/** Fetch one RSS feed and regex-parse items — no XML dependency, fail-to-empty. */
export async function fetchFeed(source: string, url: string, cap = 15): Promise<FeedItem[]> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 12_000);
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "GenesisQuant/1.0" } });
    clearTimeout(t);
    if (!res.ok) return [];
    const xml = await res.text();
    const items: FeedItem[] = [];
    for (const m of xml.matchAll(/<item[\s\S]*?<\/item>/g)) {
      const block = m[0];
      const title = strip(/<title[^>]*>([\s\S]*?)<\/title>/.exec(block)?.[1] ?? "");
      const link = strip(/<link[^>]*>([\s\S]*?)<\/link>/.exec(block)?.[1] ?? "");
      if (title) items.push({ source, title: title.slice(0, 200), link: link.slice(0, 300) });
      if (items.length >= cap) break;
    }
    return items;
  } catch {
    return [];
  }
}

const FrontierBatch = z.object({
  items: z.array(
    z.object({
      headline: z.string().max(160).describe("The original headline, lightly cleaned"),
      ecosystem: z.string().max(40).describe("Chain/ecosystem/sector, e.g. 'Ethereum L2', 'Bitcoin', 'AI x crypto', 'Solana', 'macro/regulatory'"),
      narrative: z.string().max(60).describe("SHORT NOUN PHRASE naming the hook, <=8 words"),
      relevance: z.number().int().min(0).max(100).describe("100x-opportunity relevance for a fast-rotation trader: 80+ = a tradable frontier forming, <30 = noise"),
      whyItMatters: z.string().max(400).describe("1-2 sentences: what this implies for capital rotation and where the asymmetric opportunity could form"),
    }),
  ),
});
export type FrontierClassified = z.infer<typeof FrontierBatch>["items"][number];

const FRONTIER_SYSTEM = [
  "You are Genesis Quant's Horizon Watch — scanning news OUTSIDE our home Solana-memecoin universe for forming 100x-class frontiers (new chains heating up, narrative rotations, regulatory unlocks, infrastructure shifts).",
  "You are given only headlines; classify conservatively — relevance 80+ is reserved for genuinely tradable frontier formation, not routine price coverage.",
  "Never invent facts beyond the headline. No hype words. No financial advice framing — this is desk research.",
].join(" ");

/** Classify a batch of fresh headlines into structured frontier items. */
export async function classifyFrontier(items: FeedItem[]): Promise<FrontierClassified[] | null> {
  if (!items.length) return [];
  const user = `Fresh headlines:\n${items.map((i, n) => `${n + 1}. [${i.source}] ${i.title}`).join("\n")}\n\nClassify EVERY headline (same order, same count).`;
  const out = await llmJson({ system: FRONTIER_SYSTEM, user, schema: FrontierBatch, timeoutMs: 60_000, temperature: 0.3 });
  return out?.items ?? null;
}

const FrontierReport = z.object({
  title: z.string().max(120).describe("Professional report title with the single dominant frontier theme"),
  executiveSummary: z.string().max(700).describe("3-4 sentence executive summary a subscriber can digest in 20 seconds"),
  sections: z
    .array(z.object({ heading: z.string().max(80), body: z.string().max(600) }))
    .max(4)
    .describe("2-4 sections: the frontiers forming, ranked by opportunity"),
  watchlist: z
    .array(z.object({ name: z.string().max(60), ecosystem: z.string().max(40), thesis: z.string().max(200) }))
    .max(6)
    .describe("The 100x watchlist entries this window justifies — research candidates, not positions"),
});
export type FrontierReport = z.infer<typeof FrontierReport>;

/** Synthesize the professional Frontier Report from the window's classified items. */
export async function synthesizeFrontierReport(
  classified: { headline: string; ecosystem: string; narrative: string; relevance: number; whyItMatters: string }[],
): Promise<FrontierReport | null> {
  const user = [
    "Classified frontier items from the last window (relevance 0-100):",
    ...classified.map((c) => `- [${c.relevance}] (${c.ecosystem}) ${c.headline} — ${c.whyItMatters}`),
    "",
    "Write the professional Frontier Report: executive summary, ranked sections, and the research watchlist. Subscribers are traders; be precise, grounded ONLY in these items, zero hype.",
  ].join("\n");
  return llmJson({ system: FRONTIER_SYSTEM, user, schema: FrontierReport, timeoutMs: 60_000, temperature: 0.4 });
}
