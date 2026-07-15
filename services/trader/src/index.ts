import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
loadEnv({ path: resolve(import.meta.dirname, "../../../.env") });
import { loadConfig } from "@hermes/core";
import { config, db } from "@hermes/db";
import { eq } from "drizzle-orm";
import { managePositions, openConfirmedPositions, openNewPositions, snapshotEquity } from "./paper.js";

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
if (cfg.LIVE_TRADING_ENABLED) {
  console.warn("⚠️  LIVE_TRADING_ENABLED is set but the live lane ships in M5 — ignored.");
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
let wasHalted = false;
let wasSessionOpen = true; // logs the OFF-HOURS/PRIME transition once per flip

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
    if (!halted && sessionOpen && Date.now() - lastOpen >= cfg.TRADER_POLL_MS) {
      // Default: the recorder is the scout — enter only on confirmed demand.
      // Blind t=0 entry stays available as a flagged fallback.
      if (cfg.CONFIRM_ENTRY_ENABLED) await openConfirmedPositions(cfg);
      else await openNewPositions(cfg);
      lastOpen = Date.now();
    }
    await managePositions(cfg); // every fast tick
    if (Date.now() - lastSnapshot >= cfg.PNL_SNAPSHOT_MS) {
      await snapshotEquity(cfg);
      lastSnapshot = Date.now();
    }
    await writeTraderHealth(halted);
  } catch (err) {
    console.error(`trader tick failed: ${err instanceof Error ? err.message : err}`);
  }
  await new Promise((r) => setTimeout(r, cfg.MANAGE_POLL_MS));
}
