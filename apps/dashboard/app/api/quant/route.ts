import { NextResponse } from "next/server";
import { db } from "@hermes/db";
import { sql } from "drizzle-orm";
import { llmText, quantProvider } from "@hermes/core";

// GENESIS QUANT DRAWER (operator 2026-07-28: "a drawer for our copilot that we
// can ask engaging questions... it knows everything about our universe").
// READ-ONLY BY CONSTRUCTION: the model never writes SQL — the route runs a
// fixed set of curated snapshot queries and hands the results to the 70B brain
// as grounding. The copilot can discuss the kill switch; it can never touch it.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60;

async function q(label: string, query: ReturnType<typeof sql>): Promise<string> {
  try {
    const rows = (await db.execute(query)) as unknown as Record<string, unknown>[];
    return `## ${label}\n${JSON.stringify(rows).slice(0, 4000)}`;
  } catch (err) {
    return `## ${label}\n(unavailable: ${err instanceof Error ? err.message.slice(0, 80) : "error"})`;
  }
}

async function universeSnapshot(): Promise<string> {
  const parts = await Promise.all([
    q("proof gate (live, since arm epoch — bars: >=30 closes, win>=55%, EV>=+$0.10, full-loss<=10%, 0 unsellables, <2 buy-fails/day)", sql`
      SELECT count(*) closes, count(*) FILTER (WHERE realized_pnl_usd>0) wins,
        round(sum(realized_pnl_usd)::numeric,2) net_usd, round(avg(realized_pnl_usd)::numeric,3) ev_per_fill,
        count(*) FILTER (WHERE realized_pnl_usd/NULLIF(size_usd,0) <= -0.5) full_losses,
        count(*) FILTER (WHERE exit_reason='live_unsellable') unsellables
      FROM positions WHERE lane='live' AND status='closed'
        AND opened_at > (SELECT (value->>'clearedAt')::timestamptz FROM config WHERE key='live_kill')`),
    q("live kill/arm state", sql`SELECT value->>'enabled' AS kill_engaged, value->>'clearedAt' AS armed_since, value->>'reason' AS reason FROM config WHERE key='live_kill'`),
    q("lane equity (latest snapshots)", sql`
      SELECT DISTINCT ON (lane) lane, round(equity_usd::numeric,2) equity_usd, snapped_at
      FROM pnl_snapshots ORDER BY lane, snapped_at DESC`),
    q("open positions (both lanes, latest mark)", sql`
      SELECT p.lane, coalesce(t.symbol,'?') sym, round(p.size_usd::numeric,2) size_usd,
        round((SELECT mark_multiple::float FROM position_ticks WHERE position_id=p.id ORDER BY snapped_at DESC LIMIT 1)::numeric,2) mark,
        round(EXTRACT(EPOCH FROM now()-p.opened_at)::numeric/60,1) age_min
      FROM positions p LEFT JOIN tokens t USING (mint) WHERE p.status='open' ORDER BY p.lane, p.opened_at DESC LIMIT 20`),
    q("last 10 live closes", sql`
      SELECT coalesce(t.symbol,'?') sym, round(p.realized_pnl_usd::numeric,2) pnl, p.exit_reason,
        round(EXTRACT(EPOCH FROM p.closed_at-p.opened_at)::numeric/60,1) hold_min, t.dex
      FROM positions p LEFT JOIN tokens t USING (mint)
      WHERE p.lane='live' AND p.status='closed' ORDER BY p.closed_at DESC LIMIT 10`),
    q("last 10 live buy declines (audited reasons)", sql`
      SELECT substring(details->>'reason' for 90) reason, created_at
      FROM audit_log WHERE action='live_buy_skipped' ORDER BY created_at DESC LIMIT 10`),
    q("paper 24h by book (core = the live-shape wallet live models; probe = exploration, judged on information yield not P&L)", sql`
      SELECT book, count(*) n, count(*) FILTER (WHERE realized_pnl_usd>0) wins, round(sum(realized_pnl_usd)::numeric,2) pnl
      FROM positions WHERE lane='paper' AND status='closed' AND closed_at > now() - interval '24 hours' GROUP BY book`),
    q("moon funnel 24h (peak>=3x arrivals -> crowd-eligible -> live boarded)", sql`
      WITH m AS (SELECT mint, wallet_winner_hits wh, wallet_rug_hits rh FROM candidate_outcomes
        WHERE peak_multiple >= 3 AND triggered_at > now() - interval '24 hours')
      SELECT count(*) arrivals, count(*) FILTER (WHERE wh>=1 AND wh>coalesce(rh,0)) eligible,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM positions p WHERE p.mint=m.mint AND p.lane='live')) live_boarded FROM m`),
    q("venue P&L, paper 24h", sql`
      SELECT t.dex, count(*) n, round(sum(p.realized_pnl_usd)::numeric,2) pnl
      FROM positions p JOIN tokens t USING (mint)
      WHERE p.lane='paper' AND p.status='closed' AND p.closed_at > now() - interval '24 hours'
      GROUP BY t.dex ORDER BY pnl DESC LIMIT 8`),
    q("latest market brief (newsdesk, Groq-brained)", sql`
      SELECT headline, substring(why_it_matters for 400) why_it_matters FROM market_news
      WHERE kind='brief' ORDER BY created_at DESC LIMIT 1`),
    q("FENCE/POLICY CHANGE TIMESTAMPS — any trailing-rate metric or forecast computed over a window that CROSSES one of these timestamps is STALE (the cohort mix changed at that moment). Flag staleness explicitly whenever the 24h forecast window includes one.", sql`
      SELECT substring(details->>'reason' for 44) fence, min(created_at) first_seen
      FROM audit_log WHERE action='live_buy_skipped' AND created_at > now() - interval '7 days'
      GROUP BY 1 HAVING min(created_at) > now() - interval '48 hours'
      UNION ALL
      SELECT 'arm/kill event: ' || action, created_at FROM audit_log
      WHERE action IN ('live_kill_cleared','live_kill_engaged') AND created_at > now() - interval '48 hours'
      ORDER BY first_seen DESC LIMIT 12`),
    q("DETERMINISTIC FORECAST INPUTS — computed arithmetic, the ONLY basis for any forward-looking answer. Present as projections conditioned on current rates holding, never as promises. proj_24h = fills_24h × ev_per_fill; compound paths apply daily_return_pct to live equity.", sql`
      WITH l AS (
        SELECT count(*)::float fills_24h, coalesce(avg(realized_pnl_usd),0)::float ev,
          coalesce(sum(realized_pnl_usd),0)::float pnl_24h,
          coalesce(stddev_pop(realized_pnl_usd),0)::float sd
        FROM positions WHERE lane='live' AND status='closed' AND closed_at > now() - interval '24 hours'),
      pc AS (
        SELECT coalesce(sum(realized_pnl_usd),0)::float core_pnl_24h, count(*)::int core_n
        FROM positions WHERE lane='paper' AND book='core' AND status='closed' AND closed_at > now() - interval '24 hours'),
      eq AS (SELECT coalesce((SELECT equity_usd::float FROM pnl_snapshots WHERE lane='live' ORDER BY snapped_at DESC LIMIT 1),0) live_equity)
      SELECT round(l.fills_24h) fills_last_24h, round(l.ev::numeric,3) ev_per_fill,
        round(l.pnl_24h::numeric,2) live_pnl_24h, round(eq.live_equity::numeric,2) live_equity,
        round((l.fills_24h*l.ev)::numeric,2) proj_next_24h_pnl,
        round((l.fills_24h*l.ev - 1.5*l.sd*sqrt(GREATEST(l.fills_24h,1)))::numeric,2) proj_24h_low,
        round((l.fills_24h*l.ev + 1.5*l.sd*sqrt(GREATEST(l.fills_24h,1)))::numeric,2) proj_24h_high,
        CASE WHEN eq.live_equity>0 THEN round((100.0*l.fills_24h*l.ev/eq.live_equity)::numeric,2) END daily_return_pct,
        CASE WHEN eq.live_equity>0 THEN round((eq.live_equity*power(1+l.fills_24h*l.ev/eq.live_equity,7))::numeric,2) END compound_7d_equity,
        CASE WHEN eq.live_equity>0 THEN round((eq.live_equity*power(1+l.fills_24h*l.ev/eq.live_equity,30))::numeric,2) END compound_30d_equity,
        round(pc.core_pnl_24h::numeric,2) paper_core_pnl_24h_leading_indicator, pc.core_n paper_core_n
      FROM l, pc, eq`),
  ]);
  return parts.join("\n\n");
}

const SYSTEM = [
  "You are Genesis Quant — the always-on copilot of the Genesis Capital Engine, a Solana memecoin trading platform with a PAPER lane (explores) and a LIVE lane (real capital, exploits).",
  "Doctrine: base hits keep the wallet alive, MOONS expand the equity curve; protect capital from the adversarial side (rugs, LP pulls, drain plays). Paper reveals, live confirms. Nothing ships without harness evidence and operator ratification.",
  "You are READ-ONLY: you observe and analyze; you cannot trade, arm, disarm, or change anything, and you say so if asked to act.",
  "Answer from the UNIVERSE SNAPSHOT provided — cite its numbers. If the snapshot doesn't contain what's asked, say what's missing rather than inventing. Be sharp, direct, and honest about losses. No hype, no financial advice boilerplate.",
  "FORECASTS: use ONLY the 'DETERMINISTIC FORECAST INPUTS' block — those projections are arithmetic from measured rates, valid strictly 'if current rates hold'. Present the range (low/base/high), name the assumptions, and flag when the sample is thin (few fills) or the rates just changed (a gate restart or new fence makes trailing rates stale). Never extrapolate beyond what that block computes.",
].join(" ");

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { messages?: { role: string; content: string }[] };
    const messages = (body.messages ?? []).slice(-10);
    if (!messages.length) return NextResponse.json({ error: "no messages" }, { status: 400 });
    const snapshot = await universeSnapshot();
    const convo = messages.map((m) => `${m.role === "user" ? "OPERATOR" : "QUANT"}: ${m.content}`).join("\n");
    const answer = await llmText(
      SYSTEM,
      `UNIVERSE SNAPSHOT (live reads, just now):\n${snapshot}\n\nCONVERSATION:\n${convo}\n\nAnswer the operator's last message.`,
    );
    if (!answer) return NextResponse.json({ error: "quant brain unavailable (Groq + Ollama both missed)" }, { status: 503 });
    return NextResponse.json({ answer, brain: quantProvider() }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "quant failed" }, { status: 500 });
  }
}
