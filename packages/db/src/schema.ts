import {
  pgTable,
  text,
  timestamp,
  boolean,
  jsonb,
  numeric,
  integer,
  serial,
  index,
} from "drizzle-orm/pg-core";

/** Every token the scanner has ever seen, keyed by mint address. */
export const tokens = pgTable("tokens", {
  mint: text("mint").primaryKey(),
  chain: text("chain").notNull().default("solana"),
  name: text("name"),
  symbol: text("symbol"),
  poolAddress: text("pool_address"),
  dex: text("dex"),
  baseTokenMint: text("base_token_mint"),
  liquidityUsd: numeric("liquidity_usd"),
  fdvUsd: numeric("fdv_usd"),
  poolCreatedAt: timestamp("pool_created_at", { withTimezone: true }),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  raw: jsonb("raw"),
});

/** One row per safety check per token — evidence preserved for the dashboard and Hermes. */
export const safetyChecks = pgTable(
  "safety_checks",
  {
    id: serial("id").primaryKey(),
    mint: text("mint")
      .notNull()
      .references(() => tokens.mint),
    checkName: text("check_name").notNull(),
    passed: boolean("passed").notNull(),
    evidence: jsonb("evidence"),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("safety_checks_mint_idx").on(t.mint)],
);

/** A token that passed the full safety pipeline (score is refined in M2). */
export const signals = pgTable(
  "signals",
  {
    id: serial("id").primaryKey(),
    mint: text("mint")
      .notNull()
      .references(() => tokens.mint),
    score: numeric("score").notNull(),
    reasons: jsonb("reasons"),
    status: text("status").notNull().default("new"), // new | traded_paper | traded_live | expired | dismissed
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("signals_mint_idx").on(t.mint)],
);

/** Paper and live positions share one table; `lane` distinguishes them. */
export const positions = pgTable("positions", {
  id: serial("id").primaryKey(),
  signalId: integer("signal_id").references(() => signals.id),
  mint: text("mint")
    .notNull()
    .references(() => tokens.mint),
  lane: text("lane").notNull().default("paper"), // paper | live
  status: text("status").notNull().default("open"), // open | closed
  sizeUsd: numeric("size_usd").notNull(),
  qtyTokens: numeric("qty_tokens").notNull().default("0"),
  qtyRemaining: numeric("qty_remaining").notNull().default("0"),
  peakPriceUsd: numeric("peak_price_usd"),
  entryPriceUsd: numeric("entry_price_usd").notNull(),
  exitPriceUsd: numeric("exit_price_usd"),
  realizedPnlUsd: numeric("realized_pnl_usd"),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  exitReason: text("exit_reason"), // tp_ladder | stop_volume | stop_time | manual | kill_switch
});

/** Individual simulated or real fills against a position. */
export const fills = pgTable("fills", {
  id: serial("id").primaryKey(),
  positionId: integer("position_id")
    .notNull()
    .references(() => positions.id),
  side: text("side").notNull(), // buy | sell
  qtyTokens: numeric("qty_tokens").notNull(),
  priceUsd: numeric("price_usd").notNull(),
  slippagePct: numeric("slippage_pct"),
  feeUsd: numeric("fee_usd"),
  txSignature: text("tx_signature"), // null for paper fills
  filledAt: timestamp("filled_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Periodic equity-curve snapshots per lane. */
export const pnlSnapshots = pgTable("pnl_snapshots", {
  id: serial("id").primaryKey(),
  lane: text("lane").notNull(),
  equityUsd: numeric("equity_usd").notNull(),
  openPositions: integer("open_positions").notNull(),
  snappedAt: timestamp("snapped_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Runtime-tunable config, seeded from env; dashboard edits land here. */
export const config = pgTable("config", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Append-only audit: every automated action writes here before executing. */
export const auditLog = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  actor: text("actor").notNull(), // scout | trader | hermes | user
  action: text("action").notNull(),
  details: jsonb("details"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
