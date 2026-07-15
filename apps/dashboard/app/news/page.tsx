import Link from "next/link";
import { getNews, type NewsStory, type NewsThemeStat } from "@/lib/queries";
import { RepackagePanel } from "@/components/RepackagePanel";

export const dynamic = "force-dynamic";

const CAT: Record<string, { label: string; color: string }> = {
  "ai-agents": { label: "AI agents", color: "var(--series-1)" },
  politics: { label: "Politics", color: "var(--series-2, #d08770)" },
  celebrity: { label: "Celebrity", color: "var(--series-3, #b48ead)" },
  animal: { label: "Animal", color: "var(--series-4, #a3be8c)" },
  "meme-viral": { label: "Meme / viral", color: "var(--series-5, #ebcb8b)" },
  "defi-infra": { label: "DeFi / infra", color: "var(--series-6, #88c0d0)" },
  commodity: { label: "Commodity", color: "var(--series-7, #d8a657)" },
  culture: { label: "Culture", color: "var(--series-8, #81a1c1)" },
  other: { label: "Other", color: "var(--text-muted)" },
};
const cat = (k: string | null) => CAT[k ?? "other"] ?? CAT.other;
const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
};

export default async function NewsPage() {
  const news = await getNews();
  const empty = !news.brief && news.movers.length === 0;

  return (
    <main className="mx-auto max-w-5xl px-5 py-8" style={{ color: "var(--text-primary)" }}>
      {/* header */}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3 border-b pb-4" style={{ borderColor: "var(--border)" }}>
        <div>
          <div className="flex items-center gap-2">
            <Link href="/" className="text-xs" style={{ color: "var(--text-muted)" }}>
              ← dashboard
            </Link>
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">News Desk</h1>
          <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
            Grounded market intelligence synthesized from our own observations — become the expert, spot the theme,
            repackage the story.
          </p>
        </div>
        <div className="text-right text-[11px]" style={{ color: "var(--text-muted)" }}>
          {news.generatedAt ? <div>updated {ago(news.generatedAt)}</div> : null}
          {news.model ? <div className="mt-0.5">synthesis · {news.model}</div> : null}
        </div>
      </div>

      {empty ? (
        <div className="rounded-xl p-8 text-center" style={{ background: "var(--surface-1)", border: "1px solid var(--gridline)" }}>
          <div className="text-sm" style={{ color: "var(--text-secondary)" }}>
            No stories yet. Run the news desk to synthesize the latest market:
          </div>
          <code className="mt-2 inline-block rounded-md px-2 py-1 text-xs" style={{ background: "var(--surface-0, #0b0d10)", color: "var(--series-1)" }}>
            pnpm --filter @hermes/newsdesk generate
          </code>
        </div>
      ) : null}

      {/* emerging themes rail — the opportunity-anticipation surface */}
      {news.themes.length ? (
        <section className="mb-7">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-xs font-medium uppercase tracking-wide" style={{ color: "var(--text-secondary)" }}>
              Emerging themes
            </h2>
            <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              ranked by launch-volume growth × win rate
            </span>
          </div>
          <div className="flex gap-3 overflow-x-auto pb-1">
            {news.themes.map((t) => (
              <ThemeCard key={t.category} t={t} />
            ))}
          </div>
          <p className="mt-1.5 text-[11px]" style={{ color: "var(--text-muted)" }}>
            A rising theme = more launches than the prior window <em>and</em> an above-average win rate. This is the ML
            substrate — feeding it back into entry scoring is a labeled next step, not yet live.
          </p>
        </section>
      ) : null}

      {/* market brief hero */}
      {news.brief ? (
        <section
          className="mb-7 rounded-xl p-5"
          style={{ background: "var(--surface-1)", border: "1px solid var(--gridline)" }}
        >
          <div className="mb-1 text-[10px] uppercase tracking-wide" style={{ color: "var(--series-1)" }}>
            Market brief
          </div>
          <h2 className="text-xl font-semibold leading-snug">{news.brief.headline}</h2>
          {news.brief.whyItMatters ? (
            <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--text-secondary)" }}>
              {news.brief.whyItMatters}
            </p>
          ) : null}
          <RepackagePanel drafts={news.brief.contentDrafts} />
        </section>
      ) : null}

      {/* mover feed */}
      {news.movers.length ? (
        <section>
          <h2 className="mb-3 text-xs font-medium uppercase tracking-wide" style={{ color: "var(--text-secondary)" }}>
            Movers
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {news.movers.map((m) => (
              <StoryCard key={m.id} m={m} />
            ))}
          </div>
        </section>
      ) : null}

      <p className="mt-8 border-t pt-4 text-[11px]" style={{ borderColor: "var(--gridline)", color: "var(--text-muted)" }}>
        Stories are synthesized by a local model strictly from numbers we observed (multiples, timings, liquidity,
        outcomes). It does not know anything about a token&apos;s team or project and is instructed never to claim
        otherwise — treat every draft as a starting point to verify and edit.
      </p>
    </main>
  );
}

function ThemeCard({ t }: { t: NewsThemeStat }) {
  const c = cat(t.category);
  const up = t.volumeGrowthPct >= 0;
  return (
    <div
      className="min-w-[150px] shrink-0 rounded-lg p-3"
      style={{ background: "var(--surface-1)", border: "1px solid var(--gridline)" }}
    >
      <div className="flex items-center gap-1.5">
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: c.color }} />
        <span className="text-xs font-medium">{c.label}</span>
      </div>
      <div className="mt-2 tabular text-lg font-semibold" style={{ color: c.color }}>
        {t.emergingScore >= 0 ? "+" : ""}
        {t.emergingScore.toFixed(0)}
      </div>
      <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>
        emerging score
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px]" style={{ color: "var(--text-secondary)" }}>
        <span>{t.winRatePct.toFixed(0)}% win</span>
        <span style={{ color: up ? "var(--status-good)" : "var(--status-critical)" }}>
          {up ? "▲" : "▼"} {Math.abs(t.volumeGrowthPct).toFixed(0)}%
        </span>
      </div>
      <div className="mt-0.5 text-[10px]" style={{ color: "var(--text-muted)" }}>
        {t.launches} launches · {t.winners}W
      </div>
    </div>
  );
}

function StoryCard({ m }: { m: NewsStory }) {
  const c = cat(m.category);
  const peak = (m.refs as { refToPeakMultiple?: number } | null)?.refToPeakMultiple;
  return (
    <article
      className="flex flex-col rounded-xl p-4"
      style={{ background: "var(--surface-1)", border: "1px solid var(--gridline)" }}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span
          className="rounded-full px-2 py-0.5 text-[10px] font-medium"
          style={{ background: "color-mix(in srgb, " + c.color + " 18%, transparent)", color: c.color }}
        >
          {c.label}
        </span>
        {typeof peak === "number" ? (
          <span className="tabular text-[11px] font-semibold" style={{ color: "var(--status-good)" }}>
            {peak.toFixed(1)}x peak
          </span>
        ) : null}
      </div>
      <h3 className="text-sm font-semibold leading-snug">{m.headline}</h3>
      {m.narrative ? (
        <div className="mt-0.5 text-[11px]" style={{ color: "var(--text-muted)" }}>
          {m.narrative}
        </div>
      ) : null}
      {m.whyItMatters ? (
        <p className="mt-2 flex-1 text-xs leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          {m.whyItMatters}
        </p>
      ) : null}
      <RepackagePanel drafts={m.contentDrafts} />
    </article>
  );
}
