// CRASH-PROOFING (2026-08-04: a Postgres CONNECT_TIMEOUT escaped a background
// task, Node exited, and BOTH lanes were dead for 6 hours — the day's biggest
// loss was at-bats, not trades). A background blip must log and continue;
// only the tick loop's own throw semantics decide liveness. Availability is
// the account's first asset.
process.on("unhandledRejection", (err) => {
  console.error(`⚠️ unhandled rejection (survived): ${err instanceof Error ? err.message.slice(0, 200) : err}`);
});
process.on("uncaughtException", (err) => {
  console.error(`⚠️ uncaught exception (survived): ${err instanceof Error ? (err.stack ?? err.message).slice(0, 300) : err}`);
});
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
loadEnv({ path: resolve(import.meta.dirname, "../../../.env") });
// ONE TRADER ONLY — a duplicate daemon exits at boot instead of trading.
import { acquireSingletonLock } from "@hermes/core";
acquireSingletonLock(resolve(import.meta.dirname, "../../../.hermes-trader.pid"), "trader");
import { loadConfig } from "@hermes/core";
import { config, db } from "@hermes/db";
import { eq } from "drizzle-orm";
import { checkAutoHarvest, fastDrainExit, fastFloorSweep, managePositions, openConfirmedPositions, openNewPositions, snapshotEquity } from "./paper.js";
import { setDrainHandler } from "./slotWatch.js";

// P2 fast exit: the ws watcher calls this the instant a pool's SOL halves —
// the cut runs at event speed instead of paying the 13-16% poll-speed tax.
let latestEff = loadConfig();
setDrainHandler((mint) => void fastDrainExit(latestEff, mint));
import { readEffectiveConfig, refreshAdaptivePolicy } from "./adaptive.js";
import { startManifestOptimizer } from "./live/optimizer.js";
import { guardLiveBook, liveLaneStatus, scanLiveIndependent, processLiveCloseRequests, processLiveRequeues, processWalletSends, snapshotLiveEquity, startSniperRefresh, sweepLiveBook } from "./live/executor.js";

async function killSwitchEngaged(): Promise<boolean> {
  const [row] = await db.select().from(config).where(eq(config.key, "kill_switch"));
  return (row?.value as { enabled?: boolean } | undefined)?.enabled === true;
}

// Liveness heartbeat for the dashboard health panel. The trader logs equity every
// fast tick but only snapshots pnl every PNL_SNAPSHOT_MS (~5min), so pnl_snapshots
// is a poor liveness signal (idle looks dead). This proves the manage loop is
// actually turning, throttled so it doesn't spam config writes.
const HEARTBEAT_MS = 15_000;
let lastHeartbeat = 0;
async function writeTraderHealth(halted: boolean): Promise<void> {
  if (Date.now() - lastHeartbeat < HEARTBEAT_MS) return;
  lastHeartbeat = Date.now();
  const value = { ts: Date.now(), halted };
  await db
    .insert(config)
    .values({ key: "trader_health", value })
    .onConflictDoUpdate({ target: config.key, set: { value, updatedAt: new Date() } })
    .catch((err) => console.error(`trader heartbeat failed: ${err instanceof Error ? err.message : err}`));
}

const cfg = loadConfig();

console.log(
  `TRADER online — paper lane, $${cfg.PAPER_POSITION_USD}/position from $${cfg.PAPER_BANKROLL_USD} bankroll`,
);
console.log(
  cfg.CONFIRM_ENTRY_ENABLED
    ? `entry: RECORDER-CONFIRMED — enter on demand acceleration (≥${cfg.CONFIRM_MIN_MULT}x green, ≤${cfg.CONFIRM_MAX_DD_PCT}% off peak, ≥${(cfg.CONFIRM_MIN_BUYSHARE * 100).toFixed(0)}% buys, t∈[${cfg.CONFIRM_MIN_WATCH_MIN},${cfg.CONFIRM_MAX_WATCH_MIN}]m)`
    : `entry: BLIND t=0 — score ≥ ${cfg.SIGNAL_MIN_SCORE}, signal age ≤ ${cfg.SIGNAL_MAX_AGE_MIN}m`,
);
console.log(
  `exits: ratcheting profit-trail (arm ${cfg.PROFIT_LOCK_ARM_MULT}x, floor ${cfg.PROFIT_LOCK_FLOOR_MULT}x, trail ${cfg.TRAIL_TIGHT_PCT}/${cfg.TRAIL_MID_PCT}/${cfg.TRAIL_WIDE_PCT}% by run, +${cfg.TRAIL_RIDE_BONUS_PCT}% on RIDE), pre-profit hard -${cfg.HARD_STOP_PCT}%, no moonshot cap, max hold ${cfg.MAX_HOLD_HOURS}h`,
);
console.log(liveLaneStatus(cfg));
startSniperRefresh(cfg);
// The self-optimizing loop (L1): rolling rug-adjusted recompute → PROPOSALS
// against the active manifest. Arming a proposal stays the operator's word.
startManifestOptimizer(cfg);
if (cfg.LIVE_TRADING_ENABLED) {
  console.warn(
    "⚠️  LIVE LANE ENABLED — real capital. Confirm docs/GO_LIVE_GATE.md gates G1–G6 all PASS before funding.",
  );
}

console.log(
  `cadence: manage open positions every ${cfg.MANAGE_POLL_MS / 1000}s, scan for new entries every ${cfg.TRADER_POLL_MS / 1000}s`,
);

// No cold-start drain. The recorder maintains a LIVE `armed` flag and the entry
// path only acts on arms it re-confirmed within the freshness window, so a
// restart cannot sweep in a stale backlog — but it CAN pick up a candidate still
// genuinely qualifying, which is the point. (Burst is bounded by the concurrency
// cap.) This is the fix for the halt-drained lightning: ANSEM/brain/NECKY armed
// during a breaker halt and were previously drained on release.

let lastSnapshot = 0;
let lastOpen = 0;
let lastPolicy = 0;
let wasHalted = false;
let wasSessionOpen = true; // logs the OFF-HOURS/PRIME transition once per flip

// Recompute the adaptive policy this often. The panel reads it live and the
// operator sees the regime move; only APPLIED to the trader when autoMode=live.
const ADAPTIVE_REFRESH_MS = 60_000;

// The management loop runs on the FAST cadence — that's where gains are kept.
// Scanning for new entries is throttled to the slower cadence; being late to
// OPEN costs nothing, being late to MANAGE round-trips the winners.
// eslint-disable-next-line no-constant-condition
while (true) {
  try {
    const halted = await killSwitchEngaged();
    if (halted !== wasHalted) {
      if (halted) {
        console.log("⛔ kill switch ENGAGED — new entries halted");
      } else {
        // Coming back online. We do NOT drain: whatever is still armed (recorder
        // re-confirmed within the freshness window) is a live opportunity we want
        // to catch on the first scan — this is exactly the lightning we used to
        // drop on release. Dead arms are skipped by the freshness guard; the
        // concurrency cap bounds any burst.
        console.log("▶️  kill switch released — entries resumed (still-armed candidates eligible)");
      }
      wasHalted = halted;
    }
    // Off-hours entry pause — "survive until optimal hours" in its strongest
    // form: the off-hours tape is dominated by farm waves built to pass the
    // confirm gate (81% rug rate measured with every armor live), so outside
    // PRIME_HOURS_UTC the trader opens nothing. Exits/management never pause;
    // the recorder keeps labeling so the flywheel still learns the dead tape.
    const sessionOpen = cfg.OFF_HOURS_ENTRIES || cfg.PRIME_HOURS_UTC.has(new Date().getUTCHours());
    if (sessionOpen !== wasSessionOpen) {
      console.log(
        sessionOpen
          ? "🌅 PRIME window open — entries live at full size"
          : "🌙 OFF-HOURS — entries paused (farm-wave tape); managing exits only, recorder keeps learning",
      );
      wasSessionOpen = sessionOpen;
    }
    // Live control terminal: merge the dashboard's runtime overrides (manual
    // pins + adaptive policy when autoMode=live) over the static startup config.
    // Own try/catch inside — falls back to base cfg on any DB hiccup, never
    // throws into the loop. Static-cadence knobs (poll intervals, session
    // windows) stay on the base cfg; the tunable exit/size knobs use `eff`.
    const eff = await readEffectiveConfig(cfg);
    latestEff = eff; // the fast drain-exit handler always uses the freshest config

    if (!halted && sessionOpen && Date.now() - lastOpen >= cfg.TRADER_POLL_MS) {
      // Default: the recorder is the scout — enter only on confirmed demand.
      // Blind t=0 entry stays available as a flagged fallback.
      // ISOLATED: an entry-scan failure must never wedge the loop. The 06:25Z
      // incident: a throwing entry query hit the outer catch before lastOpen
      // advanced, so EVERY 5s tick retried the broken scan and management +
      // health never ran — a scan bug silently unmanaged the whole book.
      try {
        if (cfg.CONFIRM_ENTRY_ENABLED) await openConfirmedPositions(eff);
        else await openNewPositions(eff);
      } catch (err) {
        console.error(`entry scan failed (management continues): ${err instanceof Error ? err.message : err}`);
      }
      lastOpen = Date.now();
    }
    await managePositions(eff); // every fast tick
    // Live-book reconciliation (M5): force-close any live position whose paper
    // twin is gone. No-op unless the live lane is armed; internally guarded
    // against overlapping runs (chain confirms can outlast a tick).
    void sweepLiveBook(eff);
    // Live protective guard (M5): the live lane's own downside exit — cut a
    // pool-collapsing / catastrophe-drawdown position independent of the paper
    // twin, before it's swept to zero. Self-throttled to LIVE_GUARD_MS.
    void guardLiveBook(eff);
    // Operator wallet sends queued by the dashboard — the trader is the single
    // money-mover, so transfers ride the same RPC pool and audit trail as trades.
    void processWalletSends(eff);
    // Operator's manual live-close queue — same trust model as wallet sends.
    void processLiveCloseRequests(eff);
    // Bounded retry of unroutable young-pool buys (the BIO fix).
    void processLiveRequeues(eff);
    // THE INDEPENDENT LIVE SCAN — live evaluates every fresh armed candidate on
    // its own cadence, so paper portfolio caps never decide what real capital
    // can see. Self-throttled to LIVE_SCAN_INTERVAL_MS; every risk gate intact.
    void scanLiveIndependent(eff);
    if (Date.now() - lastSnapshot >= cfg.PNL_SNAPSHOT_MS) {
      await snapshotEquity(eff);
      void snapshotLiveEquity(eff); // real live wallet value → the investor curve
      lastSnapshot = Date.now();
    }
    if (Date.now() - lastPolicy >= ADAPTIVE_REFRESH_MS) {
      await refreshAdaptivePolicy(cfg);
      lastPolicy = Date.now();
      // Auto-harvest check rides the same 60s cadence — dormant until the
      // green float rebuilds, then fires the certified basket sweep.
      void checkAutoHarvest(eff);
    }
    await writeTraderHealth(halted);
  } catch (err) {
    console.error(`trader tick failed: ${err instanceof Error ? err.message : err}`);
  }
  // Fast-floor sub-poll between manage cycles — block-level Jupiter mark on lifted positions,
  // enforced at ~1s resolution so a rollover is caught near the floor instead of gapping through
  // it. SINGLE loop → serial with managePositions, so no double-sell race. When the fast floor is
  // disabled (default), this collapses to one MANAGE_POLL_MS sleep, unchanged from before.
  const subPolls = cfg.FAST_FLOOR_ENABLED ? Math.max(1, Math.round(cfg.MANAGE_POLL_MS / Math.max(250, cfg.FAST_FLOOR_MS))) : 1;
  for (let i = 0; i < subPolls; i++) {
    await new Promise((r) => setTimeout(r, cfg.MANAGE_POLL_MS / subPolls));
    if (cfg.FAST_FLOOR_ENABLED) await fastFloorSweep(latestEff); // eff, not cfg — the sweep must see dashboard overrides like every other call in the loop
  }
}
