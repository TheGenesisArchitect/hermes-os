import { db, marketNews } from "@hermes/db";
import { sql } from "drizzle-orm";

/**
 * PROPRIETARY SIGNAL FEED — the enrichment. Turns Hermes's own edge-data into a
 * live intelligence stream: tail events, venue momentum, smart-money moves, and a
 * market pulse from the anticipation forecast. Pure data — NO LLM, no hallucination,
 * transparent and reliable. Runs independent of Ollama so the feed is never dead.
 * Writes into market_news as movers (model='hermes-signals') so the existing feed
 * surfaces them with zero UI change. De-duped so the same story doesn't repeat.
 */

const SOURCE = "hermes-signals";

async function seen(category: string, mint: string | null, sinceHours: number): Promise<boolean> {
  const rows = (await db.execute(sql`
    select 1 from market_news
    where model = ${SOURCE} and category = ${category}
      and ${mint ? sql`mint = ${mint}` : sql`mint is null`}
      and created_at > now() - make_interval(mins => ${Math.round(sinceHours * 60)})
    limit 1
  `)) as unknown as unknown[];
  return rows.length > 0;
}

interface SignalRow {
  category: string;
  mint: string | null;
  headline: string;
  whyItMatters: string;
  importance: number;
  refs: Record<string, unknown>;
}
async function publish(r: SignalRow): Promise<void> {
  await db.insert(marketNews).values({
    kind: "mover",
    mint: r.mint,
    category: r.category,
    headline: r.headline,
    whyItMatters: r.whyItMatters,
    importance: Math.max(0, Math.min(100, Math.round(r.importance))),
    refs: r.refs,
    model: SOURCE,
    windowStart: null,
    windowEnd: null,
  });
}

const etHour = () =>
  Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date())) % 24;

/** Generate the current proprietary signals. Returns how many were published. */
export async function generateSignals(): Promise<number> {
  let n = 0;

  // 1) TAIL ALERTS — recent 3×+ convex moves (the profile the engine hunts).
  try {
    const tails = (await db.execute(sql`
      select o.mint, t.symbol, t.dex, o.peak_multiple as peak
      from candidate_outcomes o join tokens t on t.mint = o.mint
      where o.peak_multiple >= 3 and o.first_seen_at > now() - interval '6 hours'
      order by o.peak_multiple desc limit 6
    `)) as unknown as { mint: string; symbol: string | null; dex: string | null; peak: number }[];
    for (const x of tails) {
      if (await seen("tail", x.mint, 24)) continue;
      const peak = Number(x.peak);
      await publish({
        category: "tail",
        mint: x.mint,
        headline: `🚀 $${x.symbol ?? "?"} ran ${peak.toFixed(1)}× on ${x.dex ?? "?"}`,
        whyItMatters: `A ${peak.toFixed(1)}× convex move on ${x.dex ?? "an executable venue"} — exactly the tail the engine exists to catch. ${x.dex ?? "This venue"} is printing winners right now.`,
        importance: Math.min(100, peak * 6),
        refs: { mint: x.mint, symbol: x.symbol, peak, venue: x.dex },
      });
      n++;
    }
  } catch (err) {
    console.error("signals/tail:", err instanceof Error ? err.message : err);
  }

  // 2) SMART-MONEY — winner-wallets backing a fresh candidate (the moat). Only the
  //    proven-winning slice: multiple winner-wallets, zero rug-wallets.
  try {
    const sm = (await db.execute(sql`
      select o.mint, t.symbol, t.dex, o.wallet_winner_hits as wins
      from candidate_outcomes o join tokens t on t.mint = o.mint
      where o.wallet_winner_hits >= 2 and coalesce(o.wallet_rug_hits,0) = 0
        and o.first_seen_at > now() - interval '3 hours'
      order by o.wallet_winner_hits desc limit 5
    `)) as unknown as { mint: string; symbol: string | null; dex: string | null; wins: number }[];
    for (const x of sm) {
      if (await seen("smart-money", x.mint, 12)) continue;
      const wins = Number(x.wins);
      await publish({
        category: "smart-money",
        mint: x.mint,
        headline: `💰 ${wins} winner-wallets backing $${x.symbol ?? "?"}`,
        whyItMatters: `${wins} wallets with a proven winning history just showed up in $${x.symbol ?? "this token"} on ${x.dex ?? "?"}, with zero rug-linked holders — the smart-money slice that lifts win-rate 2×+ in our data.`,
        importance: Math.min(100, 50 + wins * 6),
        refs: { mint: x.mint, symbol: x.symbol, winnerWallets: wins, venue: x.dex },
      });
      n++;
    }
  } catch (err) {
    console.error("signals/smart-money:", err instanceof Error ? err.message : err);
  }

  // 3) VENUE MOMENTUM — the hottest and coldest executable venue, last 3h vs prior.
  try {
    const vm = (await db.execute(sql`
      select t.dex as venue,
        coalesce(sum(p.realized_pnl_usd::float) filter (where p.closed_at > now()-interval '3 hours'),0) as recent,
        coalesce(sum(p.realized_pnl_usd::float) filter (where p.closed_at between now()-interval '6 hours' and now()-interval '3 hours'),0) as prior,
        count(*) filter (where p.closed_at > now()-interval '3 hours') as n
      from positions p join tokens t on t.mint = p.mint
      where p.lane='paper' and p.status='closed' and t.dex is not null and p.closed_at > now()-interval '6 hours'
      group by 1 having count(*) filter (where p.closed_at > now()-interval '3 hours') >= 3
    `)) as unknown as { venue: string; recent: number; prior: number; n: number }[];
    const withDelta = vm.map((v) => ({ ...v, delta: Number(v.recent) - Number(v.prior) })).sort((a, b) => b.delta - a.delta);
    const hottest = withDelta[0];
    const coldest = withDelta[withDelta.length - 1];
    if (hottest && hottest.delta > 5 && !(await seen("venue", null, 3))) {
      await publish({
        category: "venue",
        mint: null,
        headline: `📈 ${hottest.venue} heating — +$${Number(hottest.recent).toFixed(0)} last 3h`,
        whyItMatters: `${hottest.venue} flow is accelerating (${hottest.n} trades, +$${Number(hottest.recent).toFixed(0)} vs +$${Number(hottest.prior).toFixed(0)} prior). Where flow heats, tails follow — the engine leans in here.`,
        importance: Math.min(90, 50 + hottest.delta),
        refs: { venue: hottest.venue, recent: Number(hottest.recent), prior: Number(hottest.prior), trades: hottest.n },
      });
      n++;
    }
    if (coldest && coldest !== hottest && coldest.delta < -5 && !(await seen("venue-cold", null, 3))) {
      await publish({
        category: "venue-cold",
        mint: null,
        headline: `📉 ${coldest.venue} cooling — ${Number(coldest.recent).toFixed(0)} last 3h`,
        whyItMatters: `${coldest.venue} has turned cold (+$${Number(coldest.recent).toFixed(0)} vs +$${Number(coldest.prior).toFixed(0)} prior). Not a stand-down — but the tape here is thinner right now.`,
        importance: 45,
        refs: { venue: coldest.venue, recent: Number(coldest.recent), prior: Number(coldest.prior) },
      });
      n++;
    }
  } catch (err) {
    console.error("signals/venue:", err instanceof Error ? err.message : err);
  }

  // 4) MARKET PULSE — the anticipation forecast as a headline: window + tail odds.
  try {
    if (!(await seen("pulse", null, 1.5))) {
      const h = etHour();
      const [pol] = (await db.execute(sql`select value->'hours'->>${String(h)} as cls from config where key='hour_policy'`)) as unknown as { cls: string | null }[];
      const cls = pol?.cls ?? "unmeasured";
      const [tl] = (await db.execute(sql`
        select count(*) filter (where peak_multiple >= 3 and first_seen_at > now()-interval '24 hours')::int as tails24
        from candidate_outcomes where label in ('winner','dud','rug')
      `)) as unknown as { tails24: number }[];
      const tails24 = Number(tl?.tails24 ?? 0);
      const rate = (tails24 / 24).toFixed(1);
      const isPrime = cls === "prime";
      await publish({
        category: "pulse",
        mint: null,
        headline: isPrime
          ? `🎯 Prime window open — ${tails24} tails/24h (${rate}/hr)`
          : cls === "probe"
            ? `🌤️ Probe window — reduced conviction, ${rate} tails/hr`
            : `🌙 Off-hours — flow cold, ${rate} tails/hr`,
        whyItMatters: isPrime
          ? `The measured-best hour is live and the tape is producing ${rate} 3×+ moves/hour. This is when the engine hunts hardest.`
          : `Historically a ${cls} hour. The engine is present but sizing to the tape — anticipation says the richer windows are elsewhere in the clock.`,
        importance: isPrime ? 70 : 40,
        refs: { etHour: h, class: cls, tails24h: tails24 },
      });
      n++;
    }
  } catch (err) {
    console.error("signals/pulse:", err instanceof Error ? err.message : err);
  }

  // 5) FRESH BRIEF — a data-driven market top-line so the feed's headline is never
  //    stale, even when the LLM is offline. Summarizes the live state at a glance.
  try {
    if (!(await seen("brief-signal", null, 0.2))) {
      const h = etHour();
      const [row] = (await db.execute(sql`
        select
          (select value->'hours'->>${String(h)} from config where key='hour_policy') as cls,
          (select count(*) from candidate_outcomes where peak_multiple>=3 and first_seen_at>now()-interval '24 hours') as tails24,
          (select count(*) from candidate_outcomes where wallet_winner_hits>=2 and coalesce(wallet_rug_hits,0)=0 and first_seen_at>now()-interval '6 hours') as sm6,
          (select t.symbol from candidate_outcomes o join tokens t on t.mint=o.mint where o.peak_multiple>=3 and o.first_seen_at>now()-interval '24 hours' order by o.peak_multiple desc limit 1) as top_sym,
          (select round(o.peak_multiple::numeric,1) from candidate_outcomes o where o.peak_multiple>=3 and o.first_seen_at>now()-interval '24 hours' order by o.peak_multiple desc limit 1) as top_peak
      `)) as unknown as { cls: string | null; tails24: number; sm6: number; top_sym: string | null; top_peak: number | null }[];
      const cls = row?.cls ?? "unmeasured";
      const tails = Number(row?.tails24 ?? 0);
      const sm = Number(row?.sm6 ?? 0);
      const window = cls === "prime" ? "Prime window — hunting" : cls === "probe" ? "Probe window — measured" : "Off-hours — cold tape";
      await db.insert(marketNews).values({
        kind: "brief",
        mint: null,
        category: "brief-signal",
        headline: `${window} · ${tails} tails/24h${row?.top_sym ? ` · top $${row.top_sym} ${Number(row.top_peak).toFixed(1)}×` : ""}`,
        whyItMatters: `${tails} convex 3×+ moves in the last 24h${sm > 0 ? `, ${sm} tokens carrying smart-money in the last 6h` : ""}. ${cls === "prime" ? "The clock says hunt." : "The engine is present and sizing to the tape."} Live intelligence from the recorder flywheel, refreshed continuously.`,
        importance: 100,
        themes: { stats: [] },
        model: SOURCE,
      });
      n++;
    }
  } catch (err) {
    console.error("signals/brief:", err instanceof Error ? err.message : err);
  }

  if (n > 0) console.log(`📡 hermes-signals — published ${n} proprietary signal(s)`);
  return n;
}
