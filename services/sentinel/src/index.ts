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
import { loadConfig, resilientFetch } from "@hermes/core";
import { auditLog, candidateOutcomes, config, db, fills, positions, tokens } from "@hermes/db";
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
  };
}

async function saveState(s: SentinelState): Promise<void> {
  await db
    .insert(config)
    .values({ key: "sentinel_state", value: s })
    .onConflictDoUpdate({ target: config.key, set: { value: s, updatedAt: new Date() } });
}

/** Push one notification. Priority: 1=min … 5=urgent (ntfy semantics). */
async function push(title: string, body: string, priority = 3, tags = ""): Promise<void> {
  if (!cfg.SENTINEL_NTFY_TOPIC) return;
  try {
    const res = await resilientFetch(`https://ntfy.sh/${cfg.SENTINEL_NTFY_TOPIC}`, {
      method: "POST",
      headers: {
        Title: title,
        Priority: String(priority),
        ...(tags ? { Tags: tags } : {}),
      },
      body,
      timeoutMs: 10_000,
    });
    if (!res.ok) console.warn(`sentinel push HTTP ${res.status}: ${title}`);
    else console.log(`📣 ${title} — ${body}`);
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
        await push(
          enabled ? "🛑 PAPER KILL ENGAGED" : "✅ Paper kill cleared",
          enabled ? "Paper lane halted — breaker or manual stop. Investigate." : "Paper lane trading again.",
          enabled ? 5 : 3,
          enabled ? "rotating_light" : "white_check_mark",
        );
      }
      s.paperKill = enabled;
    } else if (r.key === "live_kill") {
      if (s.liveKill !== null && enabled !== s.liveKill) {
        await push(
          enabled ? "🛑 LIVE KILL ENGAGED" : "🟢 LIVE KILL CLEARED",
          enabled
            ? `Live lane halted: ${((r.value ?? {}) as { reason?: string }).reason ?? "engaged"}`
            : "Live lane is armed and will mirror confirmed entries.",
          5,
          enabled ? "rotating_light" : "rocket",
        );
      }
      s.liveKill = enabled;
    }
  }
}

async function checkArms(s: SentinelState): Promise<void> {
  const rows = await db
    .select({ id: auditLog.id, details: auditLog.details })
    .from(auditLog)
    .where(and(eq(auditLog.action, "entry_trigger"), gt(auditLog.id, s.lastTriggerAuditId)))
    .orderBy(auditLog.id)
    .limit(50);
  for (const r of rows) {
    s.lastTriggerAuditId = r.id;
    const d = (r.details ?? {}) as { mint?: string; reason?: string };
    if (!d.mint) continue;
    const [c] = await db
      .select({
        conv: candidateOutcomes.convictionScore,
        wWin: candidateOutcomes.walletWinnerHits,
        symbol: tokens.symbol,
        dex: tokens.dex,
      })
      .from(candidateOutcomes)
      .innerJoin(tokens, eq(tokens.mint, candidateOutcomes.mint))
      .where(eq(candidateOutcomes.mint, d.mint));
    const conv = c?.conv == null ? null : Number(c.conv);
    const wWin = num(c?.wWin);
    if ((conv !== null && conv >= cfg.SENTINEL_CONV_MIN) || wWin >= 3) {
      await push(
        `⚡ ARMED ${c?.symbol ?? short(d.mint)}${conv !== null ? ` · conviction ${(conv * 100).toFixed(0)}` : ""}`,
        `${c?.dex ?? "?"} · ${wWin > 0 ? `${wWin} winner-wallets · ` : ""}${d.reason ?? ""}`,
        4,
        "zap",
      );
    }
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
  for (const r of rows) {
    s.lastFillId = r.id;
    const mult = num(r.entry) > 0 ? num(r.price) / num(r.entry) : 0;
    const usd = num(r.qty) * num(r.price);
    if (r.lane === "live") {
      await push(
        `💰 LIVE ${r.side.toUpperCase()} ${r.symbol}`,
        `$${usd.toFixed(2)}${r.side === "sell" ? ` at ${mult.toFixed(2)}x (${r.reason ?? "exit"})` : ""}`,
        4,
        "moneybag",
      );
    } else if (r.side === "sell" && mult >= cfg.SENTINEL_RUNNER_MULT) {
      await push(
        `🏃 Runner banked ${mult.toFixed(2)}x — ${r.symbol}`,
        `paper · $${usd.toFixed(2)} (${r.reason ?? "exit"})`,
        3,
        "chart_with_upwards_trend",
      );
    }
  }
}

async function checkHeartbeat(s: SentinelState): Promise<void> {
  const [hb] = (await db.execute(
    sql`select (max(snapped_at) < now() - interval '10 minutes') as stale from pnl_snapshots where lane='paper'`,
  )) as unknown as { stale: boolean | null }[];
  const stale = hb?.stale === true;
  if (stale && !s.heartbeatStale) {
    await push("⚠️ Trader heartbeat STALE", "No pnl snapshot in 10+ minutes — check services.", 5, "warning");
  } else if (!stale && s.heartbeatStale) {
    await push("✅ Trader heartbeat recovered", "Snapshots flowing again.", 2, "white_check_mark");
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

// eslint-disable-next-line no-constant-condition
while (true) {
  try {
    await checkKillSwitches(state);
    await checkArms(state);
    await checkFills(state);
    await checkHeartbeat(state);
    await saveState(state);
  } catch (err) {
    console.error(`sentinel tick failed: ${err instanceof Error ? err.message : err}`);
  }
  await new Promise((r) => setTimeout(r, cfg.SENTINEL_POLL_MS));
}
