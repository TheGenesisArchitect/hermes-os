/**
 * SENTINEL — the alert layer. Pushes the events that matter to the operator's
 * phone via ntfy.sh (keyless pub/sub; subscribe to the topic in the ntfy app).
 *
 * Born 2026-07-20 from the live_kill blindspot: the kill switch sat engaged for
 * TWO DAYS silently, and the operator discovered a 7.6x armed candidate on
 * DexScreener before the system said a word. Everything below already existed
 * in the database — this service is the missing path to a human.
 *
 * Events (v1):
 *  - kill/breaker TRANSITIONS (paper kill_switch, live_kill) — both directions
 *  - high-conviction ⚡ arms (conviction ≥ SENTINEL_CONV_MIN, or ≥3 winner-wallets)
 *  - runner banks: any sell fill ≥ SENTINEL_RUNNER_MULT × entry (both lanes)
 *  - EVERY live-lane fill (real capital moved — always worth a ping)
 *  - trader heartbeat stale >10min (service down), on transition only
 *
 * Delivery is best-effort (resilientFetch: native → curl fallback for this
 * host's DPI filter); a failed push never crashes the loop. State (last-seen
 * ids) persists in the `sentinel_state` config row so restarts don't replay
 * history or drop the kill-transition baseline.
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
loadEnv({ path: resolve(import.meta.dirname, "../../../.env") });
// ONE SENTINEL ONLY — four zombie instances ran for hours on stale code
// (2026-07-22) because taskkill missed the tree; the lock makes that loud.
import { acquireSingletonLock } from "@hermes/core";
acquireSingletonLock(resolve(import.meta.dirname, "../../../.hermes-sentinel.pid"), "sentinel");
import { loadConfig, resilientFetch } from "@hermes/core";
import { auditLog, candidateOutcomes, config, db, fills, positions, tokens } from "@hermes/db";
import { runLedgerSync, runReconciler } from "./ledger2.js";
import { and, eq, gt, sql } from "drizzle-orm";

const cfg = loadConfig();
const num = (v: string | number | null | undefined): number => (v == null ? 0 : Number(v));
const short = (m: string) => `${m.slice(0, 4)}…${m.slice(-4)}`;

interface SentinelState {
  lastFillId: number;
  lastTriggerAuditId: number;
  paperKill: boolean | null;
  liveKill: boolean | null;
  heartbeatStale: boolean;
  /** epoch ms of the last 20-min PULSE and hourly SUMMARY sent */
  lastTrendMs: number;
  lastRecapMs: number;
  /** previous pulse-window P&L per lane, so PULSE can show direction */
  prevTrendPaper: number;
  prevTrendLive: number;
  /** mints already announced as 🌙 moonshots — never ping the same one twice */
  moonshotSeen: string[];
}

async function loadState(): Promise<SentinelState> {
  const [row] = await db.select().from(config).where(eq(config.key, "sentinel_state"));
  const v = (row?.value ?? {}) as Partial<SentinelState>;
  return {
    lastFillId: v.lastFillId ?? -1,
    lastTriggerAuditId: v.lastTriggerAuditId ?? -1,
    paperKill: v.paperKill ?? null,
    liveKill: v.liveKill ?? null,
    heartbeatStale: v.heartbeatStale ?? false,
    lastTrendMs: v.lastTrendMs ?? 0,
    lastRecapMs: v.lastRecapMs ?? 0,
    prevTrendPaper: v.prevTrendPaper ?? 0,
    prevTrendLive: v.prevTrendLive ?? 0,
    moonshotSeen: v.moonshotSeen ?? [],
  };
}

async function saveState(s: SentinelState): Promise<void> {
  await db
    .insert(config)
    .values({ key: "sentinel_state", value: s })
    .onConflictDoUpdate({ target: config.key, set: { value: s, updatedAt: new Date() } });
}

/**
 * ALERT TEMPLATE — every push has the same shape so the phone reads at a glance:
 *   Title:  "CATEGORY · subject"        (plain ASCII — emoji live in ntfy tags)
 *   Body:   "key: value · key: value"   lines, most important first
 * Categories: KILL (halts, max priority) · LIVE (real capital moved) ·
 * RUNNER (tranche banked ≥1.5x) · ARM (high-conviction candidate) ·
 * HEALTH (service state) · OPS (window/pilot verdicts, pushed by the operator).
 *
 * Delivery uses ntfy's JSON publish API (POST to the root with the topic in the
 * body) — emoji in an HTTP header is not a ByteString and silently killed every
 * push in v1; JSON bodies are UTF-8 and immune.
 */
type Category = "KILL" | "LIVE" | "RUNNER" | "ARM" | "HEALTH" | "OPS" | "TREND" | "RECAP" | "PULSE" | "SUMMARY" | "MOONSHOT";

async function notify(
  category: Category,
  subject: string,
  lines: string[],
  priority = 3,
  tags: string[] = [],
): Promise<void> {
  if (!cfg.SENTINEL_NTFY_TOPIC) return;
  const title = `${category} · ${subject}`;
  const message = lines.join("\n");
  try {
    const res = await resilientFetch("https://ntfy.sh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: cfg.SENTINEL_NTFY_TOPIC, title, message, priority, tags }),
      timeoutMs: 10_000,
    });
    if (!res.ok) console.warn(`sentinel push HTTP ${res.status}: ${title}`);
    else console.log(`📣 ${title} — ${message.replace(/\n/g, " | ")}`);
  } catch (err) {
    console.warn(`sentinel push failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function checkKillSwitches(s: SentinelState): Promise<void> {
  const rows = await db.select().from(config).where(sql`${config.key} in ('kill_switch','live_kill')`);
  for (const r of rows) {
    const enabled = ((r.value ?? {}) as { enabled?: boolean }).enabled === true;
    if (r.key === "kill_switch") {
      if (s.paperKill !== null && enabled !== s.paperKill) {
        await notify(
          "KILL",
          enabled ? "paper lane ENGAGED" : "paper lane cleared",
          enabled
            ? ["state: halted (breaker or manual stop)", "action: investigate before releasing"]
            : ["state: trading again"],
          enabled ? 5 : 3,
          enabled ? ["rotating_light"] : ["white_check_mark"],
        );
      }
      s.paperKill = enabled;
    } else if (r.key === "live_kill") {
      if (s.liveKill !== null && enabled !== s.liveKill) {
        await notify(
          "KILL",
          enabled ? "live lane ENGAGED" : "live lane CLEARED",
          enabled
            ? [`reason: ${((r.value ?? {}) as { reason?: string }).reason ?? "engaged"}`, "state: no new live buys (exits still manage)"]
            : ["state: live mirror armed — will follow confirmed entries"],
          // Engagement is an emergency (max, breaks DND). Clearance is good news —
          // audible if awake, never a wake-up (operator: wake me only on NO-GO).
          enabled ? 5 : 3,
          enabled ? ["rotating_light"] : ["rocket"],
        );
      }
      s.liveKill = enabled;
    }
  }
}

// ── 🌙 THE MOONSHOT ALERT — the one per-event ping that survives ─────────────
// Per-trade pings are gone by operator directive; the scheduled PULSE and
// SUMMARY carry the flow. The exception is the trade this whole system exists
// to catch: a MOON-class candidate that qualifies at FULL 2★ conviction and
// ARMS. That is rare (two independent evidence marks on top of the moon
// fingerprint), it is the setup being perfected, and it deserves a phone
// buzz with the whole story on one screen.
async function checkMoonshots(s: SentinelState): Promise<void> {
  const rows = await db
    .select({
      mint: candidateOutcomes.mint,
      sig: candidateOutcomes.signature,
      stars: candidateOutcomes.stars,
      dip: candidateOutcomes.dipDepth,
      snap: candidateOutcomes.snapPct,
      rate: candidateOutcomes.snapRate,
      wWin: candidateOutcomes.walletWinnerHits,
      trigMult: candidateOutcomes.triggerMultiple,
      symbol: tokens.symbol,
      dex: tokens.dex,
    })
    .from(candidateOutcomes)
    .innerJoin(tokens, eq(tokens.mint, candidateOutcomes.mint))
    .where(
      and(
        // NOT gated on armed=true: entering CONSUMES the armed flag within
        // seconds, so every moonshot that actually fills would vanish between
        // 30s polls (AFTER: armed 2★, entered, armed=false by the next poll —
        // alert never fired). The qualification is stars+signature; the
        // 5-minute window plus the seen-set dedupe keeps it one ping per mint.
        eq(candidateOutcomes.stars, 2),
        sql`${candidateOutcomes.signature} like 'MOON%'`,
        sql`${candidateOutcomes.updatedAt} > now() - interval '5 minutes'`,
      ),
    )
    .limit(10);
  for (const r of rows) {
    if (s.moonshotSeen.includes(r.mint)) continue;
    s.moonshotSeen.push(r.mint);
    if (s.moonshotSeen.length > 60) s.moonshotSeen = s.moonshotSeen.slice(-40);
    const dipPct = r.dip == null ? null : Number(r.dip) * 100;
    const snapPct = r.snap == null ? null : Number(r.snap) * 100;
    const rate = r.rate == null ? null : Number(r.rate);
    const grade = (r.sig ?? "MOON").replace("MOON_", "").toLowerCase();
    await notify(
      "MOONSHOT",
      `${r.symbol ?? short(r.mint)} ★★ armed`,
      [
        `🌙 the ${grade} moon signature, at FULL conviction`,
        dipPct != null && snapPct != null
          ? `the tell: dipped ${dipPct.toFixed(0)}%, snapped +${snapPct.toFixed(0)}%${rate != null ? ` at ${rate.toFixed(1)}×/min` : ""}`
          : `confirmed off the trough${r.trigMult != null ? ` at ${Number(r.trigMult).toFixed(2)}×` : ""}`,
        `evidence: 2★${num(r.wWin) > 0 ? ` · ${num(r.wWin)} winner-rep wallet${num(r.wWin) > 1 ? "s" : ""} aboard` : " · retrace + holders confirm"}`,
        `venue ${r.dex ?? "?"} · both lanes firing · 🚀 shooting for the moon`,
      ],
      4,
      ["new_moon", "rocket"],
    );
  }
}

async function checkFills(s: SentinelState): Promise<void> {
  const rows = await db
    .select({
      id: fills.id,
      side: fills.side,
      price: fills.priceUsd,
      qty: fills.qtyTokens,
      reason: fills.reason,
      lane: positions.lane,
      entry: positions.entryPriceUsd,
      pnl: positions.realizedPnlUsd,
      symbol: tokens.symbol,
    })
    .from(fills)
    .innerJoin(positions, eq(positions.id, fills.positionId))
    .innerJoin(tokens, eq(tokens.mint, positions.mint))
    .where(gt(fills.id, s.lastFillId))
    .orderBy(fills.id)
    .limit(100);
  // TRADE-FOR-TRADE PINGS REMOVED by operator directive (2026-07-21): every
  // fill used to buzz the phone, which drowned the signal. The flow now lives
  // in the 20-min PULSE and the hourly SUMMARY; the only per-event pings left
  // are safety transitions (kill/heartbeat) and the 🌙 2★ MOONSHOT. The cursor
  // still advances so re-enabling per-fill alerts later never replays history.
  for (const r of rows) {
    s.lastFillId = r.id;
    void r;
  }
}

// ── DIGESTS — the scheduled progress report ──────────────────────────────────
// TREND every 15 min (light, priority 2) and RECAP + FORECAST on the hour
// (priority 3). Both are lane-separated: paper is the simulated sensor, live is
// real capital, and they are never summed together.

interface LaneStats {
  pnl: number;
  closes: number;
  wins: number;
  best: { sym: string; pnl: number } | null;
  worst: { sym: string; pnl: number } | null;
  deployed: number;
  /** lane equity at the latest snapshot — the denominator for "% of balance" */
  balance: number;
}

const money = (v: number): string => `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}`;
const pct = (v: number): string => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}%`;

async function laneStats(lane: string, minutes: number): Promise<LaneStats> {
  const rows = (await db.execute(sql`
    select coalesce(p.realized_pnl_usd, 0)::float as pnl, coalesce(p.size_usd,0)::float as size, t.symbol
    from positions p join tokens t on t.mint = p.mint
    where p.lane = ${lane} and p.status = 'closed'
      and p.closed_at > now() - make_interval(mins => ${minutes})
  `)) as unknown as { pnl: number; size: number; symbol: string | null }[];
  const [eq] = (await db.execute(sql`
    select coalesce(equity_usd, 0)::float as equity from pnl_snapshots
    where lane = ${lane} order by snapped_at desc limit 1
  `)) as unknown as { equity: number }[];
  const st: LaneStats = { pnl: 0, closes: 0, wins: 0, best: null, worst: null, deployed: 0, balance: num(eq?.equity) };
  for (const r of rows) {
    const pnl = Number(r.pnl);
    st.pnl += pnl;
    st.deployed += Number(r.size);
    st.closes += 1;
    if (pnl > 0.005) st.wins += 1;
    const sym = r.symbol ?? "?";
    if (!st.best || pnl > st.best.pnl) st.best = { sym, pnl };
    if (!st.worst || pnl < st.worst.pnl) st.worst = { sym, pnl };
  }
  return st;
}

/**
 * Two denominators, because they answer different questions:
 *   "on deployed" = how well the capital that went to work performed (edge)
 *   "of balance"  = what it did to the account (risk / drawdown felt)
 * A −$15 hour is a rounding error on a $2,500 book and a catastrophe on $200.
 */
function laneLine(tag: string, st: LaneStats, note?: string): string {
  if (st.closes === 0) return `${tag}: no closes${note ? ` (${note})` : ""}`;
  const wr = Math.round((100 * st.wins) / st.closes);
  const onDep = st.deployed > 0 ? ` · ${pct((100 * st.pnl) / st.deployed)} on deployed` : "";
  const ofBal = st.balance > 0 ? ` · ${pct((100 * st.pnl) / st.balance)} of bal` : "";
  return `${tag}: ${money(st.pnl)}${ofBal} · ${st.closes} closes · ${wr}% win${onDep}`;
}

// PULSE — 3× an hour, one screen, no jargon. Replaces both the 15-min TREND
// and the per-trade pings: what the last 20 minutes did, how well the moves
// were kept, what the router is finding, what's on right now.
async function sendTrend(s: SentinelState): Promise<void> {
  const [paper, live] = await Promise.all([laneStats("paper", 20), laneStats("live", 20)]);
  const killed = s.liveKill === true;
  const dir = (now: number, prev: number): string => (now > prev + 0.01 ? "▲" : now < prev - 0.01 ? "▼" : "▬");
  // Capture per lane, pooled (dollars kept ÷ dollars the peaks offered) over a
  // rolling 2h — the operator's cycle-management metric, target 40%. Twenty
  // minutes is too few moves to read; two hours is a stable signal that still
  // turns within a session.
  const capRows = (await db.execute(sql`
    select lane, case when coalesce(sum(size_usd*(peak_price_usd/nullif(entry_price_usd,0)-1))
                   filter (where peak_price_usd/nullif(entry_price_usd,0) >= 1.22),0) > 0
      then round((100*sum(realized_pnl_usd) filter (where peak_price_usd/nullif(entry_price_usd,0) >= 1.22)
           /sum(size_usd*(peak_price_usd/nullif(entry_price_usd,0)-1))
             filter (where peak_price_usd/nullif(entry_price_usd,0) >= 1.22))::numeric,0)::float
      else null end as capture
    from positions where status='closed' and closed_at > now() - interval '2 hours'
    group by lane
  `)) as unknown as { lane: string; capture: number | null }[];
  const capOf = (lane: string) => capRows.find((r) => r.lane === lane)?.capture ?? null;
  const capLine = (lane: string) => {
    const c = capOf(lane);
    return c == null ? "—" : `${Math.round(c)}%${c >= 40 ? " ✓" : ""}`;
  };
  const mix = (await db.execute(sql`
    select coalesce(signature,'?') as sig, count(*)::int as n from candidate_outcomes
    where updated_at > now() - interval '20 minutes' and signature is not null
    group by 1 order by n desc
  `)) as unknown as { sig: string; n: number }[];
  const [open] = (await db.execute(sql`
    select count(*) filter (where lane='paper')::int as p, count(*) filter (where lane='live')::int as l
    from positions where status='open'
  `)) as unknown as { p: number; l: number }[];
  const refused = mix.find((m) => m.sig === "RUG_RISK")?.n ?? 0;
  const found = mix.filter((m) => m.sig !== "RUG_RISK");
  const lines = [
    laneLine("paper", paper) + ` ${dir(paper.pnl, s.prevTrendPaper)}`,
    killed ? "live: standing down (kill engaged)" : laneLine("live", live) + ` ${dir(live.pnl, s.prevTrendLive)}`,
    (paper.best && paper.best.pnl > 0 ? `best ${paper.best.sym} ${money(paper.best.pnl)}` : "no standout"),
    `capture 2h (target 40%): paper ${capLine("paper")} · live ${capLine("live")}`,
    found.length
      ? `finding: ${found.slice(0, 3).map((m) => `${m.sig.replace("MOON_", "m·").toLowerCase()} ${m.n}`).join(" · ")}${refused ? ` · refused ${refused}` : ""}`
      : `quiet tape${refused ? ` · refused ${refused}` : ""}`,
    `open now: ${num(open?.p)} paper · ${num(open?.l)} live`,
  ];
  await notify("PULSE", "20 min", lines, 2, ["chart_with_upwards_trend"]);
  s.prevTrendPaper = paper.pnl;
  s.prevTrendLive = live.pnl;
}

async function sendRecap(s: SentinelState): Promise<void> {
  const [paper, live] = await Promise.all([laneStats("paper", 60), laneStats("live", 60)]);
  const killed = s.liveKill === true;
  // Loss-class mix — where the hour's damage came from.
  const lossRows = (await db.execute(sql`
    select coalesce(exit_reason,'?') as reason, round(sum(realized_pnl_usd)::numeric,2)::float as pnl
    from positions where lane='paper' and status='closed'
      and closed_at > now() - interval '60 minutes' and realized_pnl_usd < 0
    group by 1 order by pnl asc limit 3
  `)) as unknown as { reason: string; pnl: number }[];
  // FORECAST — this hour historically (all recorded history, same UTC hour),
  // plus the live tape's current edge and which families are hot.
  const nextHour = (new Date().getUTCHours() + 1) % 24;
  const [hist] = (await db.execute(sql`
    select count(*)::int as n,
      round(coalesce(avg(realized_pnl_usd),0)::numeric,3)::float as avg_pnl,
      round((100.0 * count(*) filter (where realized_pnl_usd > 0.005) / nullif(count(*),0))::numeric,0)::float as win_pct
    from positions where lane='paper' and status='closed'
      and extract(hour from closed_at at time zone 'UTC') = ${nextHour}
  `)) as unknown as { n: number; avg_pnl: number; win_pct: number }[];
  const [edge] = (await db.execute(sql`
    select case when coalesce(sum(p.size_usd),0) > 0
      then round((100.0*sum(p.realized_pnl_usd)/sum(p.size_usd))::numeric,1)::float else null end as edge_pct
    from positions p join tokens t on t.mint = p.mint
    where p.lane='paper' and p.status='closed' and p.closed_at > now() - interval '45 minutes'
      and lower(t.dex) = any(string_to_array(${cfg.LIVE_MIRROR_VENUES}, ','))
  `)) as unknown as { edge_pct: number | null }[];
  const hotRows = (await db.execute(sql`
    select lower(regexp_replace(t.symbol,'[^a-zA-Z0-9]','','g')) as fam
    from candidate_outcomes co join tokens t on t.mint = co.mint
    where co.label in ('winner','dud','rug') and co.first_seen_at >= now() - interval '6 hours'
      and t.symbol is not null and length(t.symbol) > 1
    group by 1 having count(*) filter (where co.label='winner') >= 2
      and count(*) filter (where co.label='rug')::numeric / count(*) < 0.5
    order by count(*) filter (where co.label='winner') desc limit 4
  `)) as unknown as { fam: string }[];

  const lines = [laneLine("paper", paper), killed ? "live: standing down (kill engaged)" : laneLine("live", live)];
  if (paper.best && paper.best.pnl > 0) lines.push(`best ${paper.best.sym} ${money(paper.best.pnl)}` + (paper.worst ? ` · worst ${paper.worst.sym} ${money(paper.worst.pnl)}` : ""));
  if (lossRows.length) lines.push(`bleed: ${lossRows.map((r) => `${r.reason} ${money(Number(r.pnl))}`).join(" · ")}`);
  lines.push("—");
  const h = hist;
  lines.push(
    `forecast ${String(nextHour).padStart(2, "0")}:00Z: ` +
      (h && h.n >= 10
        ? `hist ${money(Number(h.avg_pnl))}/trade on ${h.n} (${Math.round(Number(h.win_pct))}% win)`
        : "no hour history yet"),
  );
  lines.push(
    `mirror edge 45m: ${edge?.edge_pct === null || edge?.edge_pct === undefined ? "n/a" : `${Number(edge.edge_pct).toFixed(1)}%`}` +
      (hotRows.length ? ` · hot: ${hotRows.map((r) => r.fam).join(", ")}` : " · no hot families"),
  );
  // THE EDGE, monitored: strong-inflow vs flat-pool win rates over 24h. A
  // collapsing spread means the core signal is decaying — surface it, don't
  // wait for the P&L to say it later.
  const [inflow] = (await db.execute(sql`
    select
      round(100.0 * count(*) filter (where label='winner' and liq_growth >= 1.30)
            / nullif(count(*) filter (where liq_growth >= 1.30), 0), 1)::float as strong_win,
      round(100.0 * count(*) filter (where label='winner' and liq_growth < 1.05)
            / nullif(count(*) filter (where liq_growth < 1.05), 0), 1)::float as flat_win,
      count(*) filter (where liq_growth is not null)::int as n
    from candidate_outcomes
    where triggered_at > now() - interval '24 hours' and label in ('winner','dud','rug')
  `)) as unknown as { strong_win: number | null; flat_win: number | null; n: number }[];
  if (inflow && num(inflow.n) >= 20 && inflow.strong_win !== null && inflow.flat_win !== null) {
    const sp = Number(inflow.strong_win) - Number(inflow.flat_win);
    lines.push(
      `inflow edge: strong ${Number(inflow.strong_win).toFixed(0)}% win vs flat ${Number(inflow.flat_win).toFixed(0)}% · spread ${sp >= 0 ? "+" : ""}${sp.toFixed(0)}pp${sp <= 5 ? " ⚠ DECAYING" : ""}`,
    );
  }
  await notify("SUMMARY", "hour + forecast", lines, 3, ["bar_chart"]);
}

async function checkDigests(s: SentinelState): Promise<void> {
  if (!cfg.SENTINEL_DIGEST_ENABLED) return;
  const now = Date.now();
  const PULSE = 20 * 60_000; // 3× an hour, on :00 :20 :40
  const HOUR = 60 * 60_000;
  // Fire on wall-clock boundaries rather than drifting timers. The hourly
  // SUMMARY supersedes the :00 pulse — never send both in the same minute.
  const hourDue = Math.floor(now / HOUR) > Math.floor(s.lastRecapMs / HOUR);
  if (hourDue) {
    await sendRecap(s);
    s.lastRecapMs = now;
    s.lastTrendMs = now;
  } else if (Math.floor(now / PULSE) > Math.floor(s.lastTrendMs / PULSE)) {
    await sendTrend(s);
    s.lastTrendMs = now;
  }
}

async function checkHeartbeat(s: SentinelState): Promise<void> {
  const [hb] = (await db.execute(
    sql`select (max(snapped_at) < now() - interval '10 minutes') as stale from pnl_snapshots where lane='paper'`,
  )) as unknown as { stale: boolean | null }[];
  const stale = hb?.stale === true;
  if (stale && !s.heartbeatStale) {
    await notify("HEALTH", "trader heartbeat STALE", ["no pnl snapshot in 10+ min — check services"], 5, ["warning"]);
  } else if (!stale && s.heartbeatStale) {
    await notify("HEALTH", "trader heartbeat recovered", ["snapshots flowing again"], 2, ["white_check_mark"]);
  }
  s.heartbeatStale = stale;
}

if (!cfg.SENTINEL_ENABLED || !cfg.SENTINEL_NTFY_TOPIC) {
  console.log("SENTINEL disabled (SENTINEL_ENABLED=false or no SENTINEL_NTFY_TOPIC) — idle.");
  process.exit(0);
}

console.log(
  `SENTINEL online — pushing to ntfy.sh/${cfg.SENTINEL_NTFY_TOPIC} every ${cfg.SENTINEL_POLL_MS / 1000}s (conviction ≥ ${cfg.SENTINEL_CONV_MIN}, runner ≥ ${cfg.SENTINEL_RUNNER_MULT}x).`,
);

const state = await loadState();
// First run: baseline last-seen ids to NOW so we never replay history.
if (state.lastFillId < 0) {
  const [f] = (await db.execute(sql`select coalesce(max(id),0) as m from fills`)) as unknown as { m: number }[];
  state.lastFillId = num(f?.m);
}
if (state.lastTriggerAuditId < 0) {
  const [a] = (await db.execute(
    sql`select coalesce(max(id),0) as m from audit_log where action='entry_trigger'`,
  )) as unknown as { m: number }[];
  state.lastTriggerAuditId = num(a?.m);
}

// LEDGER PHASE 2 — journal sync + chain reconciler, every ~5 minutes (10 ticks
// at the 30s poll). Sync first so the reconciler always judges a fresh journal.
let ledgerTick = 0;

// eslint-disable-next-line no-constant-condition
while (true) {
  try {
    await checkKillSwitches(state);
    await checkMoonshots(state);
    await checkFills(state);
    await checkHeartbeat(state);
    await checkDigests(state);
    if (ledgerTick++ % 10 === 0) {
      try {
        await runLedgerSync();
        const line = await runReconciler(cfg, (title, lines) => notify("OPS", title, lines, 4, ["ledger"]));
        console.log(`📒 ${line}`);
      } catch (err) {
        console.warn(`ledger phase-2 cycle failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    await saveState(state);
  } catch (err) {
    console.error(`sentinel tick failed: ${err instanceof Error ? err.message : err}`);
  }
  await new Promise((r) => setTimeout(r, cfg.SENTINEL_POLL_MS));
}
