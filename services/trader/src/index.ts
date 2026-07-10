import "dotenv/config";
import { loadConfig } from "@hermes/core";
import { managePositions, openNewPositions, snapshotEquity } from "./paper.js";

const cfg = loadConfig();

console.log(
  `TRADER online — paper lane, $${cfg.PAPER_POSITION_USD}/position from $${cfg.PAPER_BANKROLL_USD} bankroll`,
);
console.log(
  `entry: score ≥ ${cfg.SIGNAL_MIN_SCORE}, signal age ≤ ${cfg.SIGNAL_MAX_AGE_MIN}m | exits: TP ${cfg.TP_SELL_FRACTION * 100}% @ ${cfg.TP_MULTIPLIER}x, trail -${cfg.TRAIL_DROP_PCT}% from peak, hard -${cfg.HARD_STOP_PCT}%, volume collapse, max hold ${cfg.MAX_HOLD_HOURS}h`,
);
if (cfg.LIVE_TRADING_ENABLED) {
  console.warn("⚠️  LIVE_TRADING_ENABLED is set but the live lane ships in M5 — ignored.");
}

let lastSnapshot = 0;

// eslint-disable-next-line no-constant-condition
while (true) {
  try {
    await openNewPositions(cfg);
    await managePositions(cfg);
    if (Date.now() - lastSnapshot >= cfg.PNL_SNAPSHOT_MS) {
      await snapshotEquity(cfg);
      lastSnapshot = Date.now();
    }
  } catch (err) {
    console.error(`trader tick failed: ${err instanceof Error ? err.message : err}`);
  }
  await new Promise((r) => setTimeout(r, cfg.TRADER_POLL_MS));
}
