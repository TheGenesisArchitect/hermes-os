// NEW FRONTIER orchestration: ingest keyless RSS every cycle, classify fresh
// headlines through the 70B brain, store as market_news kind='frontier', and
// publish the professional Frontier Report (kind='frontier_report') at most
// once per hour. Fail-to-skip everywhere — the frontier lane must never block
// the Solana desk's own cycle.
import { db, marketNews } from "@hermes/db";
import { FRONTIER_FEEDS, fetchFeed, classifyFrontier, synthesizeFrontierReport } from "@hermes/core";
import { and, desc, eq, gte, sql } from "drizzle-orm";

const REPORT_EVERY_MS = 55 * 60_000;
const MAX_NEW_PER_CYCLE = 10;
const RELEVANCE_STORE_FLOOR = 25; // below this it's noise — don't even store

export async function runFrontier(): Promise<void> {
  // 1. Ingest.
  const feeds = await Promise.all(FRONTIER_FEEDS.map((f) => fetchFeed(f.source, f.url)));
  const fetched = feeds.flat();
  if (!fetched.length) return;

  // 2. Fresh-only: skip headlines already stored in the last 3 days.
  const recent = await db
    .select({ headline: marketNews.headline })
    .from(marketNews)
    .where(and(eq(marketNews.kind, "frontier"), gte(marketNews.createdAt, new Date(Date.now() - 3 * 86_400_000))));
  const seen = new Set(recent.map((r) => r.headline.toLowerCase().slice(0, 80)));
  const fresh = fetched.filter((i) => !seen.has(i.title.toLowerCase().slice(0, 80))).slice(0, MAX_NEW_PER_CYCLE);

  // 3. Classify + store.
  if (fresh.length) {
    const classified = await classifyFrontier(fresh);
    if (classified) {
      let stored = 0;
      for (let i = 0; i < classified.length && i < fresh.length; i++) {
        const c = classified[i]!;
        if (c.relevance < RELEVANCE_STORE_FLOOR) continue;
        await db.insert(marketNews).values({
          kind: "frontier",
          category: "other",
          narrative: c.narrative,
          headline: c.headline,
          whyItMatters: c.whyItMatters,
          importance: Math.round(c.relevance),
          refs: { source: fresh[i]!.source, link: fresh[i]!.link, ecosystem: c.ecosystem },
        });
        stored++;
      }
      if (stored) console.log(`🌐 frontier: ${stored}/${fresh.length} fresh items stored (floor ${RELEVANCE_STORE_FLOOR})`);
    }
  }

  // 4. Professional report, at most hourly, from the last 24h window.
  const [lastReport] = await db
    .select({ at: marketNews.createdAt })
    .from(marketNews)
    .where(eq(marketNews.kind, "frontier_report"))
    .orderBy(desc(marketNews.createdAt))
    .limit(1);
  if (lastReport && Date.now() - lastReport.at.getTime() < REPORT_EVERY_MS) return;

  const window = (await db.execute(sql`
    SELECT headline, coalesce(refs->>'ecosystem','?') ecosystem, coalesce(narrative,'') narrative,
      importance relevance, coalesce(why_it_matters,'') "whyItMatters"
    FROM market_news WHERE kind='frontier' AND created_at > now() - interval '24 hours'
    ORDER BY importance DESC LIMIT 20`)) as unknown as
    { headline: string; ecosystem: string; narrative: string; relevance: number; whyItMatters: string }[];
  if (window.length < 3) return; // too thin for a professional report

  const report = await synthesizeFrontierReport(window);
  if (!report) return;
  await db.insert(marketNews).values({
    kind: "frontier_report",
    category: "other",
    narrative: "new frontier report",
    headline: report.title,
    whyItMatters: report.executiveSummary,
    importance: Math.max(0, ...window.map((w) => Number(w.relevance) || 0)),
    contentDrafts: { sections: report.sections, watchlist: report.watchlist },
    refs: { itemCount: window.length, windowHours: 24 },
  });
  console.log(`🌐 FRONTIER REPORT published — "${report.title}" (${window.length} items, watchlist ${report.watchlist.length})`);
}
