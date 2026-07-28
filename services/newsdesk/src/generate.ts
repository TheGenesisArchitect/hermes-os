import "dotenv/config";
import { db, candidateOutcomes, tokens, marketNews } from "@hermes/db";
import {
  classifyCategory,
  synthesizeMover,
  synthesizeBrief,
  llmUp,
  quantProvider,
  GROQ_MODEL,
  OLLAMA_MODEL,
  type ThemeStat,
  type NewsCategory,
} from "@hermes/core";
import { and, desc, eq, gte, isNull, isNotNull, sql } from "drizzle-orm";
import { pathToFileURL } from "node:url";

const WINDOW_HOURS = Number(process.env.NEWSDESK_WINDOW_HOURS ?? 12);
const CLASSIFY_LIMIT = Number(process.env.NEWSDESK_CLASSIFY_LIMIT ?? 40);
const MOVERS_LIMIT = Number(process.env.NEWSDESK_MOVERS_LIMIT ?? 6);
const MIN_PEAK = Number(process.env.NEWSDESK_MIN_PEAK ?? 1.5); // only movers that actually moved

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

/**
 * One news-desk generation cycle. Runs OFF the trader's critical path (its own
 * process), read-mostly against recorder tables, writes only to market_news and
 * backfills candidate_outcomes.category. Every LLM call degrades to a skip on
 * null, so a slow/offline qwen never throws — it just produces less news.
 */
export async function generate(): Promise<{ classified: number; movers: number; brief: boolean }> {
  if (!(await llmUp())) {
    console.log("📰 newsdesk: no LLM reachable (Groq + Ollama both down) — skipping cycle (news desk degrades, never blocks)");
    return { classified: 0, movers: 0, brief: false };
  }
  const recentStart = hoursAgo(WINDOW_HOURS);
  const priorStart = hoursAgo(WINDOW_HOURS * 2);
  console.log(`📰 newsdesk cycle — brain=${quantProvider()} (${quantProvider() === "groq" ? GROQ_MODEL : OLLAMA_MODEL}), window=${WINDOW_HOURS}h`);

  // 1) Classify breadth: give recent closed candidates a controlled category so
  //    the theme aggregates have coverage. Bounded per cycle; accumulates over runs.
  const toClassify = await db
    .select({ mint: candidateOutcomes.mint, symbol: tokens.symbol, name: tokens.name })
    .from(candidateOutcomes)
    .leftJoin(tokens, eq(tokens.mint, candidateOutcomes.mint))
    .where(
      and(
        isNull(candidateOutcomes.category),
        sql`${candidateOutcomes.label} <> 'open'`,
        gte(candidateOutcomes.firstSeenAt, recentStart),
      ),
    )
    .orderBy(desc(candidateOutcomes.peakMultiple))
    .limit(CLASSIFY_LIMIT);

  let classified = 0;
  for (const c of toClassify) {
    if (!c.symbol) continue;
    const cat = await classifyCategory({ symbol: c.symbol, name: c.name ?? undefined });
    if (!cat) continue;
    await db
      .update(candidateOutcomes)
      .set({ category: cat.category, narrative: cat.narrative })
      .where(eq(candidateOutcomes.mint, c.mint));
    classified++;
  }
  console.log(`   classified ${classified}/${toClassify.length} candidates`);

  // 2) Emerging themes: category volume-growth × winner-rate (the leading
  //    indicator). recent vs prior window for growth; win rate over recent closed.
  const themeRows = await db
    .select({
      category: candidateOutcomes.category,
      recent: sql<number>`count(*) filter (where ${candidateOutcomes.firstSeenAt} >= ${recentStart.toISOString()})::int`,
      prior: sql<number>`count(*) filter (where ${candidateOutcomes.firstSeenAt} >= ${priorStart.toISOString()} and ${candidateOutcomes.firstSeenAt} < ${recentStart.toISOString()})::int`,
      winners: sql<number>`count(*) filter (where ${candidateOutcomes.firstSeenAt} >= ${recentStart.toISOString()} and ${candidateOutcomes.label} = 'winner')::int`,
      closed: sql<number>`count(*) filter (where ${candidateOutcomes.firstSeenAt} >= ${recentStart.toISOString()} and ${candidateOutcomes.label} <> 'open')::int`,
    })
    .from(candidateOutcomes)
    .where(and(isNotNull(candidateOutcomes.category), gte(candidateOutcomes.firstSeenAt, priorStart)))
    .groupBy(candidateOutcomes.category);

  const themes: ThemeStat[] = themeRows
    .filter((t) => t.category && t.recent > 0)
    .map((t) => {
      const winRatePct = t.closed > 0 ? (100 * t.winners) / t.closed : 0;
      const volumeGrowthPct = ((t.recent - t.prior) / Math.max(t.prior, 1)) * 100;
      return {
        category: t.category as NewsCategory,
        launches: t.recent,
        winners: t.winners,
        winRatePct,
        volumeGrowthPct,
        emergingScore: (volumeGrowthPct * winRatePct) / 100,
      };
    })
    .sort((a, b) => b.emergingScore - a.emergingScore);
  console.log(`   ${themes.length} themes; top: ${themes.slice(0, 3).map((t) => `${t.category}(${t.emergingScore.toFixed(1)})`).join(", ") || "none"}`);

  // 3) Mover feed: full stories for the top notable movers not already published.
  const published = await db
    .select({ mint: marketNews.mint })
    .from(marketNews)
    .where(and(eq(marketNews.kind, "mover"), gte(marketNews.createdAt, recentStart)));
  const publishedMints = new Set(published.map((p) => p.mint));

  const moverRows = await db
    .select({
      mint: candidateOutcomes.mint,
      symbol: tokens.symbol,
      name: tokens.name,
      dex: tokens.dex,
      peak: candidateOutcomes.peakMultiple,
      final: candidateOutcomes.finalMultiple,
      mtp: candidateOutcomes.minutesToPeak,
      peakLiq: candidateOutcomes.peakLiquidityUsd,
      label: candidateOutcomes.label,
      category: candidateOutcomes.category,
    })
    .from(candidateOutcomes)
    .leftJoin(tokens, eq(tokens.mint, candidateOutcomes.mint))
    .where(
      and(
        sql`${candidateOutcomes.label} <> 'open'`,
        gte(candidateOutcomes.firstSeenAt, recentStart),
        sql`${candidateOutcomes.peakMultiple} >= ${MIN_PEAK}`,
      ),
    )
    .orderBy(desc(candidateOutcomes.peakMultiple))
    .limit(MOVERS_LIMIT * 3);

  let movers = 0;
  for (const m of moverRows) {
    if (movers >= MOVERS_LIMIT) break;
    if (!m.symbol || publishedMints.has(m.mint)) continue;
    const story = await synthesizeMover({
      symbol: m.symbol,
      name: m.name ?? undefined,
      source: m.dex ?? undefined,
      refToPeakMultiple: Number(m.peak),
      finalMultiple: Number(m.final),
      minutesToPeak: m.mtp != null ? Number(m.mtp) : null,
      peakLiquidityUsd: m.peakLiq != null ? Number(m.peakLiq) : null,
      outcome: m.label,
    });
    if (!story) continue;
    await db.insert(marketNews).values({
      kind: "mover",
      mint: m.mint,
      category: story.category,
      narrative: story.narrative,
      headline: story.headline,
      whyItMatters: story.whyItMatters,
      importance: Math.round(story.importance),
      contentDrafts: story.contentDrafts,
      refs: {
        symbol: m.symbol,
        dex: m.dex,
        refToPeakMultiple: Number(m.peak),
        finalMultiple: Number(m.final),
        minutesToPeak: m.mtp != null ? Number(m.mtp) : null,
        peakLiquidityUsd: m.peakLiq != null ? Number(m.peakLiq) : null,
        outcome: m.label,
      },
      model: OLLAMA_MODEL,
      windowStart: recentStart,
      windowEnd: new Date(),
    });
    // keep candidate_outcomes category in sync with the story's classification
    if (!m.category) {
      await db
        .update(candidateOutcomes)
        .set({ category: story.category, narrative: story.narrative })
        .where(eq(candidateOutcomes.mint, m.mint));
    }
    movers++;
  }
  console.log(`   published ${movers} mover stories`);

  // 4) Market brief — the headline expert content, led by the strongest theme.
  const [reg] = await db
    .select({
      scanned: sql<number>`count(*)::int`,
      triggers: sql<number>`count(*) filter (where ${candidateOutcomes.triggeredAt} is not null)::int`,
      trigWinners: sql<number>`count(*) filter (where ${candidateOutcomes.triggeredAt} is not null and ${candidateOutcomes.label} = 'winner')::int`,
      trigClosed: sql<number>`count(*) filter (where ${candidateOutcomes.triggeredAt} is not null and ${candidateOutcomes.label} <> 'open')::int`,
      rugs: sql<number>`count(*) filter (where ${candidateOutcomes.label} in ('rug','delisted') or ${candidateOutcomes.delisted} = true)::int`,
    })
    .from(candidateOutcomes)
    .where(gte(candidateOutcomes.firstSeenAt, recentStart));

  const topMovers = moverRows.slice(0, 5).map((m) => ({
    symbol: m.symbol ?? "?",
    refToPeakMultiple: Number(m.peak),
    outcome: m.label,
  }));
  const winRate = reg && reg.trigClosed > 0 ? (100 * reg.trigWinners) / reg.trigClosed : 0;

  let briefDone = false;
  const brief = await synthesizeBrief({
    windowHours: WINDOW_HOURS,
    totalLaunches: reg?.scanned ?? 0,
    confirmedTriggers: reg?.triggers ?? 0,
    overallWinRatePct: winRate,
    themes,
    topMovers,
    rugCount: reg?.rugs ?? 0,
  });
  if (brief) {
    await db.insert(marketNews).values({
      kind: "brief",
      headline: brief.headline,
      whyItMatters: brief.whyItMatters,
      importance: 100,
      themes: { keyThemes: brief.keyThemes, stats: themes.slice(0, 6) },
      contentDrafts: brief.contentDrafts,
      refs: { windowHours: WINDOW_HOURS, ...reg, winRatePct: winRate },
      model: OLLAMA_MODEL,
      windowStart: recentStart,
      windowEnd: new Date(),
    });
    briefDone = true;
  }
  console.log(`   brief: ${briefDone ? "published" : "skipped"}`);
  return { classified, movers, brief: briefDone };
}

// Run directly: `pnpm --filter @hermes/newsdesk generate`
// pathToFileURL normalizes the Windows path (C:\… → file:///C:/…) so this guard
// actually matches when invoked as the entrypoint.
if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  generate()
    .then((r) => {
      console.log("📰 done:", r);
      process.exit(0);
    })
    .catch((e) => {
      console.error("newsdesk generate failed:", e);
      process.exit(1);
    });
}
