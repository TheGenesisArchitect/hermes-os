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
  /** last LIVE position id announced as a 🧬 OPEN card */
  lastOpenPosId: number;
  /** announced moonshots awaiting their outcome debrief (🌕/🌗/🌑) */
  moonshotPending: { mint: string; at: number }[];
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
    lastOpenPosId: v.lastOpenPosId ?? -1,
    moonshotPending: v.moonshotPending ?? [],
  };
}

// ── MOONSHOT OUTCOME DEBRIEF — closing the loop the 🌙 call opens (operator,
// 2026-07-23: "we never find out whether we caught it, how much of it, if we
// missed why"). Every announced moonshot resolves to exactly one verdict card:
//   🌕 CAUGHT — live rode it: flight size, exit multiple, capture %, per lane
//   🌗 HALF   — SIM rode it but live refused: the refusal reason, named
//   🌑 MISSED — nobody boarded: what it did + which gate/timing kept us out
// Each verdict names the master-equation term it scores: P(board) for misses,
// P(ride)+capture for catches. Resolves once positions settle (≥30m after the
// call) or at the 120m hard cap if something is still riding.
async function checkMoonshotOutcomes(s: SentinelState): Promise<void> {
  if (!s.moonshotPending.length) return;
  const now = Date.now();
  const keep: { mint: string; at: number }[] = [];
  for (const pend of s.moonshotPending) {
    const ageMin = (now - pend.at) / 60_000;
    if (ageMin < 30) { keep.push(pend); continue; }
    const atIso = new Date(pend.at).toISOString();
    const trades = (await db.execute(sql`
      SELECT p.lane, p.status, p.size_usd::float AS size, p.realized_pnl_usd::float AS pnl,
        p.entry_price_usd::float AS entry, p.peak_price_usd::float AS peak
      FROM positions p
      WHERE p.mint = ${pend.mint} AND p.opened_at > ${atIso}::timestamptz - interval '20 minutes'`)) as unknown as
      { lane: string; status: string; size: number; pnl: number | null; entry: number; peak: number | null }[];
    const stillOpen = trades.some((t) => t.status === "open");
    if (stillOpen && ageMin < 120) { keep.push(pend); continue; }
    const [flight] = (await db.execute(sql`
      SELECT t.symbol, co.peak_multiple::float AS peakx, co.minutes_to_peak::float AS ttp, co.label,
        co.ref_price_usd::float AS refp
      FROM candidate_outcomes co LEFT JOIN tokens t ON t.mint = co.mint
      WHERE co.mint = ${pend.mint}`)) as unknown as
      { symbol: string | null; peakx: number | null; ttp: number | null; label: string | null; refp: number | null }[];
    const sym = flight?.symbol ?? short(pend.mint);
    const peakX = flight?.peakx != null ? Number(flight.peakx) : null;
    const ttp = flight?.ttp != null ? Number(flight.ttp) : null;
    // the moon's peak PRICE — the top of the flight, independent of our entries
    const moonPeakPrice = peakX != null && flight?.refp != null ? peakX * Number(flight.refp) : null;
    const flightLine = `flight   ${peakX != null ? `peak ${peakX.toFixed(1)}×` : "peak unknown"}${ttp != null ? ` @ ${Math.round(ttp)}m` : ""}${flight?.label ? ` · settled ${flight.label}` : ""}`;
    // THE BUSINESS STAT (operator, 2026-07-23): the moon's total OFFERING at our
    // traded size — what a perfect rider would have banked on the capital we
    // actually deployed, riding entry → flight peak — and how much we captured.
    const laneStat = (lane: string) => {
      const rows = trades.filter((t) => t.lane === lane && t.status === "closed");
      if (!rows.length) return null;
      const captured = rows.reduce((a, t) => a + num(t.pnl), 0);
      const offered = rows.reduce((a, t) => {
        if (!(t.entry > 0)) return a;
        // offer per position = traded size × (best reachable peak / entry − 1);
        // best reachable = the flight peak, or the position's own peak if we
        // entered after the top (the moon offered us less, not zero)
        const bestPeak = Math.max(moonPeakPrice ?? 0, num(t.peak));
        return a + (bestPeak / t.entry > 1 ? t.size * (bestPeak / t.entry - 1) : 0);
      }, 0);
      return { captured, offered, capture: offered > 0 ? Math.max(0, captured / offered) : null };
    };
    const live = laneStat("live");
    const paper = laneStat("paper");
    const offerBits = (tag: string, x: ReturnType<typeof laneStat>) =>
      x ? `${tag} ${money(x.captured)} of $${x.offered.toFixed(2)} offered${x.capture != null ? ` (${(x.capture * 100).toFixed(0)}%)` : ""}` : null;
    if (live) {
      const pct = live.capture != null ? `${(live.capture * 100).toFixed(0)}% of the moon` : money(live.captured);
      await notify("MOONWIN", `CAUGHT · ${sym} — ${pct}`,
        [flightLine, `capture  ${[offerBits("live", live), offerBits("SIM", paper)].filter(Boolean).join(" · ")}`, `scores   capture — the stat the business rides on`],
        4, ["full_moon"], `https://dexscreener.com/solana/${pend.mint}`);
    } else {
      // why didn't live board? the latest refusal audit is the named reason
      const [ref] = (await db.execute(sql`
        SELECT action, details->>'reason' AS reason, created_at
        FROM audit_log
        WHERE details->>'mint' = ${pend.mint}
          AND action IN ('live_buy_skipped','entry_crowd_unknown_refused','entry_wallet_antigate','live_buy_failed')
          AND created_at > ${atIso}::timestamptz - interval '20 minutes'
        ORDER BY created_at DESC LIMIT 1`)) as unknown as { action: string; reason: string | null; created_at: Date }[];
      const why = ref
        ? `refused  ${(ref.reason ?? ref.action).slice(0, 90)}`
        : `no entry — trigger/confirm never fired for live (aperture or arrival timing)`;
      if (paper) {
        const pct = paper.capture != null ? `${(paper.capture * 100).toFixed(0)}%` : money(paper.captured);
        await notify("MOONHALF", `HALF · ${sym} — SIM took ${pct}, live took 0%`,
          [flightLine, `capture  ${offerBits("SIM", paper)} · live $0.00 (never boarded)`, why, `scores   P(board|live) — the receiver gap`],
          4, ["last_quarter_moon"], `https://dexscreener.com/solana/${pend.mint}`);
      } else {
        await notify("MOONMISS", `MISSED · ${sym}${peakX != null ? ` — 0% of a ${peakX.toFixed(1)}× flight` : " — 0% captured"}`,
          [flightLine, `capture  $0.00 — no size aboard, the offering flew unpriced`, why, `scores   P(board) — every miss is boarding tuition`],
          4, ["new_moon"], `https://dexscreener.com/solana/${pend.mint}`);
      }
    }
  }
  s.moonshotPending = keep;
}

// ── LIVE OPEN CARDS — the board and the phone reflect the Trading DNA matrix
// the moment real capital boards (operator, 2026-07-23: "when trades are opened
// the Cards should also reflect as well"). LIVE lane only: live opens are rare,
// real-capital events; paper opens stay in the 20-min PULSE so the phone
// doesn't drown (the 2026-07-21 per-fill-ping lesson).
async function checkLiveOpens(s: SentinelState): Promise<void> {
  const rows = (await db.execute(sql`
    SELECT p.id, p.mint, p.signature, p.size_usd::float AS size, t.symbol, t.dex,
      co.stars, co.liq_growth::float AS inflow,
      co.wallet_winner_hits AS wh, co.wallet_rug_hits AS rh,
      (SELECT ct.liquidity_usd::float FROM candidate_ticks ct
        WHERE ct.mint = p.mint ORDER BY ct.id DESC LIMIT 1) AS liq
    FROM positions p
    JOIN tokens t ON t.mint = p.mint
    LEFT JOIN candidate_outcomes co ON co.mint = p.mint
    WHERE p.lane = 'live' AND p.id > ${s.lastOpenPosId}
    ORDER BY p.id
    LIMIT 10`)) as unknown as {
    id: number; mint: string; signature: string | null; size: number;
    symbol: string | null; dex: string | null; stars: number | null;
    inflow: number | null; wh: number | null; rh: number | null; liq: number | null;
  }[];
  for (const r of rows) {
    s.lastOpenPosId = Number(r.id);
    const genome = (r.signature ?? "UNROUTED").replace("MOON_", "M·");
    const inflow = r.inflow != null ? Number(r.inflow) : null;
    const band = inflow == null ? "unmeasured" : inflow >= 1.3 ? "strong" : inflow >= 1.2 ? "good" : "mild";
    const crowd =
      r.wh == null && r.rh == null
        ? "no crowd read"
        : `${num(r.wh)}W/${num(r.rh)}R${num(r.wh) - num(r.rh) >= 1 ? " winner-rep" : ""}`;
    await notify(
      "OPEN",
      `OPEN · ${r.symbol ?? short(r.mint)} — ${genome} $${Number(r.size).toFixed(2)}`,
      [
        `genome   ${genome}${r.stars != null ? ` · ${num(r.stars)}★` : ""} · ${r.dex ?? "?"}`,
        `band     inflow ${inflow != null ? `${inflow.toFixed(2)}×` : "—"} (${band}) · crowd ${crowd}`,
        `entry    $${Number(r.size).toFixed(2)} @ pool ${r.liq != null ? `$${(Number(r.liq) / 1000).toFixed(1)}k` : "—"}`,
      ],
      3,
      ["dna"],
      `https://dexscreener.com/solana/${r.mint}`,
    );
  }
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
type Category =
  | "KILL" | "LIVE" | "RUNNER" | "ARM" | "HEALTH" | "OPS" | "TREND" | "RECAP"
  | "PULSE" | "SUMMARY" | "MOONSHOT" | "OPEN" | "MOONWIN" | "MOONHALF" | "MOONMISS";

const CATEGORY_EMOJI: Record<Category, string> = {
  KILL: "⛔", LIVE: "🔴", RUNNER: "🏃", ARM: "🎯", HEALTH: "🩺", OPS: "🔧",
  TREND: "📈", RECAP: "🧾", PULSE: "❤️", SUMMARY: "📊", MOONSHOT: "🌙", OPEN: "🧬",
  MOONWIN: "🌕", MOONHALF: "🌗", MOONMISS: "🌑",
};

async function notify(
  category: Category,
  subject: string,
  lines: string[],
  priority = 3,
  tags: string[] = [],
  click?: string,
): Promise<void> {
  if (!cfg.SENTINEL_NTFY_TOPIC) return;
  // CARD SYSTEM (2026-07-23): the title IS the verdict — emoji + one number,
  // readable on a lock screen; bodies are <=4 fixed-grammar lines.
  const title = `${CATEGORY_EMOJI[category] ?? ""} ${subject}`.trim();
  const message = lines.join("\n");
  try {
    const res = await resilientFetch("https://ntfy.sh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: cfg.SENTINEL_NTFY_TOPIC, title, message, priority, tags, ...(click ? { click } : {}) }),
      timeoutMs: 10_000,
    });
    if (!res.ok) console.warn(`sentinel push HTTP ${res.status}: ${title}`);
    else console.log(`📣 ${title} — ${message.replace(/\n/g, " | ")}`);
  } catch (err) {
    console.warn(`sentinel push failed: ${err instanceof Error ? err.message : err}`);
  }
}

// ── PIPELINE STALENESS — services that die silently must page (87.8h newsdesk
// outage, 2026-07-23). Transition-only: one alert on stale, one on recovery.
const staleFlags = new Map<string, boolean>();
async function checkPipelineStaleness(): Promise<void> {
  const checks: [string, string, number][] = [
    ["news desk", "select extract(epoch from (now() - max(created_at)))/3600 as h from market_news", 3],
    ["discovery (scout)", "select extract(epoch from (now() - max(first_seen_at)))/3600 as h from tokens", 0.33],
  ];
  for (const [name, query, maxH] of checks) {
    try {
      const rows = (await db.execute(sql.raw(query))) as unknown as { h: number | null }[];
      const age = rows[0]?.h == null ? null : Number(rows[0].h);
      const stale = age != null && age > maxH;
      const was = staleFlags.get(name) ?? false;
      if (stale && !was)
        await notify("HEALTH", `${name} STALE — ${age!.toFixed(1)}h since last output`, [`threshold ${maxH}h · investigate the daemon/roster`], 4, ["warning"]);
      if (!stale && was)
        await notify("HEALTH", `${name} recovered`, [`fresh output within ${maxH}h`], 3, ["white_check_mark"]);
      staleFlags.set(name, stale);
    } catch { /* a staleness probe must never crash the sentinel */ }
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
    // every 🌙 call owes the operator a verdict — queue the outcome debrief
    s.moonshotPending.push({ mint: r.mint, at: Date.now() });
    if (s.moonshotSeen.length > 60) s.moonshotSeen = s.moonshotSeen.slice(-40);
    const dipPct = r.dip == null ? null : Number(r.dip) * 100;
    const snapPct = r.snap == null ? null : Number(r.snap) * 100;
    const rate = r.rate == null ? null : Number(r.rate);
    const grade = (r.sig ?? "MOON").replace("MOON_", "");
    const SHAPE: Record<string, string> = { VIOLENT: "whipsaw", FAST: "ignition", STEADY: "staircase", SLOW: "grinder" };
    const shape = SHAPE[grade] ?? "moon";
    await notify(
      "MOONSHOT",
      `MOONSHOT · ${r.symbol ?? short(r.mint)} — ${grade} 2★`,
      [
        `shape    ${shape}${dipPct != null && dipPct > 5 ? ` · wick −${dipPct.toFixed(0)}%` : ""}${snapPct != null ? ` · snap +${snapPct.toFixed(0)}%` : ""}${rate != null ? ` @ ${rate.toFixed(1)}×/min` : ""}`,
        `crowd    ${num(r.wWin) > 0 ? `${num(r.wWin)} winner-rep wallet${num(r.wWin) > 1 ? "s" : ""} aboard` : "retrace + holders confirm"}`,
        `machine  both lanes firing · boost ×1.5 · rung arms 1.2×`,
        `tap to watch the flight ↗`,
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
  void dir; void found; void refused;
  const [day] = (await db.execute(sql`
    select round(coalesce(sum(realized_pnl_usd),0)::numeric,2)::float as pnl,
      count(*) filter (where realized_pnl_usd > 0)::int as g, count(*)::int as n
    from positions where lane='live' and status='closed' and closed_at > date_trunc('day', now())
  `)) as unknown as { pnl: number; g: number; n: number }[];
  const title = `${live.balance.toFixed(2)} · day ${num(day?.pnl) >= 0 ? "+" : "−"}${Math.abs(num(day?.pnl)).toFixed(2)} · ${num(open?.p) + num(open?.l)} open`;
  const lines = [
    `live ${num(day?.g)}/${num(day?.n)} green${killed ? " · KILL ENGAGED" : ""} · capture live ${capLine("live")} · paper ${capLine("paper")}`,
  ];
  await notify("PULSE", title, lines, 2, ["chart_with_upwards_trend"]);
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
  // SMART-MONEY FORECAST TRACKING — the 30-day study (config smart_money_forecast)
  // predicted equity bands from the measured edge and three execution-drag
  // scenarios. Every summary scores live against the base band, so the team
  // sees forecast-vs-actual daily instead of at post-mortem.
  const fcRows = (await db.execute(sql`select value from config where key = 'smart_money_forecast'`)) as unknown as {
    value: { createdAt: string; baselineUsd: number; horizonDays: number; scenarios: Record<string, { p10: number[]; p50: number[]; p90: number[] }> };
  }[];
  const fc = fcRows[0]?.value;
  if (fc?.scenarios?.base) {
    const day = Math.min(fc.horizonDays - 1, Math.max(0, Math.floor((Date.now() - new Date(fc.createdAt).getTime()) / 86_400_000)));
    const [snap] = (await db.execute(sql`select equity_usd::float e from pnl_snapshots where lane='live' order by id desc limit 1`)) as unknown as { e: number }[];
    const b = fc.scenarios.base;
    const p50 = b.p50[day], p10 = b.p10[day], p90 = b.p90[day];
    if (snap && p50 != null && p10 != null && p90 != null) {
      const vsP50 = snap.e - p50;
      // TRADING-ONLY line (operator, 2026-07-23): the wallet holds SOL, so a
      // SOL rally can carry equity above band while the ENGINE runs at its
      // edge. Baseline + cumulative realized live P&L since the forecast's
      // birth = the alpha path the model actually predicts; beta never gets
      // to flatter the engine on its own scoreboard.
      // ISO-string bind — a raw Date param dies in postgres-js argv binding
      // (the journalFill lesson); strings + explicit cast always land.
      const [tp] = (await db.execute(sql`select coalesce(sum(realized_pnl_usd),0)::float8 s from positions
        where lane='live' and status='closed' and closed_at >= ${new Date(fc.createdAt).toISOString()}::timestamptz`)) as unknown as { s: number }[];
      const tradingEq = Number(fc.baselineUsd) + num(tp?.s);
      const tMark = tradingEq < p10 ? " ⚠" : tradingEq > p90 ? " 🚀" : "";
      lines.push(
        `📐 forecast d${day + 1}: ${snap.e.toFixed(0)} vs base p50 ${p50.toFixed(0)} (${vsP50 >= 0 ? "+" : ""}${vsP50.toFixed(0)}) · band ${p10.toFixed(0)}–${p90.toFixed(0)}${snap.e < p10 ? " ⚠ BELOW BAND" : snap.e > p90 ? " 🚀 ABOVE BAND" : ""}`,
        `   trading-only ${tradingEq.toFixed(0)}${tMark} (alpha path, SOL beta stripped)`,
      );
    }
  }
  // Four fixed lines: money · machine · forecast · watch. The old dense lines
  // (bleed mix, hour history, mirror/inflow edges) belong to the Console now.
  const regimeRows = (await db.execute(sql`
    select signature, count(*)::int n,
      case when coalesce(sum(size_usd),0) > 0 then 100*sum(realized_pnl_usd)/sum(size_usd) else 0 end as ret
    from positions where lane='paper' and status='closed' and signature in ('RISER','MOON_FAST','MOON_STEADY')
      and closed_at > now() - make_interval(hours => ${cfg.LIVE_REGIME_CLASS_WINDOW_H})
    group by 1`)) as unknown as { signature: string; n: number; ret: number }[];
  const stateIcon = (sig: string, core: boolean) => {
    const r = regimeRows.find((x) => x.signature === sig);
    if (!r || r.n < cfg.LIVE_REGIME_CLASS_MIN_N) return core ? "🟡" : "⛔";
    return Number(r.ret) > 0 ? "✅" : "⛔";
  };
  const [refusedHr] = (await db.execute(sql`
    select count(*)::int as n from audit_log where action='live_buy_skipped' and created_at > now() - interval '60 minutes'
  `)) as unknown as { n: number }[];
  const fcLine = lines.find((l) => l.startsWith("📐")) ?? "📐 forecast: warming up";
  const hotLine = hotRows.length ? `hot: ${hotRows.slice(0, 3).map((h) => h.fam).join(", ")}` : "quiet families";
  const card = [
    `money    live ${money(live.pnl)} (${live.closes} closed) · paper ${money(paper.pnl)} SIM`,
    `machine  RISER${stateIcon("RISER", true)} FAST${stateIcon("MOON_FAST", true)} STEADY${stateIcon("MOON_STEADY", true)} · ${num(refusedHr?.n)} refused/h`,
    fcLine,
    `watch    ${hotLine}`,
  ];
  await notify("SUMMARY", `Hour: live ${money(live.pnl)} · ${live.balance.toFixed(2)}`, card, 3, ["bar_chart"]);
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
if (state.lastOpenPosId < 0) {
  const [p] = (await db.execute(
    sql`select coalesce(max(id),0) as m from positions where lane='live'`,
  )) as unknown as { m: number }[];
  state.lastOpenPosId = num(p?.m);
}

// LEDGER PHASE 2 — journal sync + chain reconciler, every ~5 minutes (10 ticks
// at the 30s poll). Sync first so the reconciler always judges a fresh journal.
let ledgerTick = 0;

// eslint-disable-next-line no-constant-condition
while (true) {
  try {
    await checkKillSwitches(state);
    await checkPipelineStaleness();
    await checkMoonshots(state);
    await checkLiveOpens(state);
    await checkMoonshotOutcomes(state);
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
