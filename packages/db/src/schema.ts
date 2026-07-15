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
  tier: text("tier").notNull().default("base"), // capacity lane: moonshot | core | base — assigned at entry from the convexity fingerprint
  // Recorder trigger multiple at entry (market-PROVEN multiple vs ref). Trail
  // zones use entryRelativeMult × this so a token entered after proving 4.9x
  // gets the runner leash immediately instead of the tight spike-zone trail
  // (the ARGENTINU lesson: entered at 4.94x proven, peaked 11.4x, banked +15%
  // because entry-relative zones never left "tight").
  triggerMult: numeric("trigger_mult"),
  status: text("status").notNull().default("open"), // open | closed
  sizeUsd: numeric("size_usd").notNull(),
  // Confirm-quality sizing: 1 = full-conviction confirm, <1 = size reduced because
  // the confirm tick showed fading demand (buy-share below the quality floor).
  // Persisted at open so the Intel Report can compare tiers' live win rates.
  qualityMult: numeric("quality_mult"),
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
  // Per-fill reason — WHY this specific fill happened (take_profit_0, trail,
  // harvest…). The position's exit_reason only records the FINAL close, so a
  // TP0 trim on a position that later rugs would otherwise display as the rug.
  reason: text("reason"),
  feeUsd: numeric("fee_usd"),
  txSignature: text("tx_signature"), // null for paper fills
  filledAt: timestamp("filled_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per management poll of an OPEN position — the trajectory the
 * ride-vs-cut classifier reads. Entry/peak/exit alone can't tell a 327x runner
 * from a 1.5x wiggler; this captures the shape between them. The classifier's
 * call is stored inline (regime/action/score) so it's a full audit of every
 * decision over a position's life and the dashboard just reads the latest row.
 */
export const positionTicks = pgTable(
  "position_ticks",
  {
    id: serial("id").primaryKey(),
    positionId: integer("position_id")
      .notNull()
      .references(() => positions.id),
    priceUsd: numeric("price_usd").notNull(),
    markMultiple: numeric("mark_multiple").notNull(), // price / entry
    peakMultiple: numeric("peak_multiple").notNull(), // peak / entry at this tick
    drawdownFromPeakPct: numeric("drawdown_from_peak_pct").notNull(),
    liquidityUsd: numeric("liquidity_usd"),
    volM5: numeric("vol_m5"),
    volH1: numeric("vol_h1"),
    buysM5: integer("buys_m5"),
    sellsM5: integer("sells_m5"),
    buyShareM5: numeric("buy_share_m5"), // 0..1
    priceChangeM5Pct: numeric("price_change_m5_pct"),
    ageMinutes: numeric("age_minutes").notNull(),
    // classifier output for this tick
    regime: text("regime"), // IGNITION | RUNNER | BLOWOFF | STALL | FADE | WATCH
    action: text("action"), // RIDE | TRIM | CUT | HOLD
    continuationScore: numeric("continuation_score"), // 0..100
    reason: text("reason"),
    snappedAt: timestamp("snapped_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("position_ticks_position_idx").on(t.positionId)],
);

/**
 * User-set management intent for an open position — the "engage" channel.
 * The dashboard writes RIDE/CUT here; the trader honors it on its next poll.
 * One active row per position; consumed rows are marked applied.
 */
export const managementIntents = pgTable(
  "management_intents",
  {
    id: serial("id").primaryKey(),
    positionId: integer("position_id")
      .notNull()
      .references(() => positions.id),
    intent: text("intent").notNull(), // ride | cut
    source: text("source").notNull().default("user"), // user | hermes
    applied: boolean("applied").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
  },
  (t) => [index("management_intents_position_idx").on(t.positionId)],
);

/**
 * THE FLYWHEEL. One row per observation of EVERY candidate that cleared the
 * safety pipeline — entered or not — for its first RECORDER_WINDOW_MIN minutes.
 * At t≈1min a winner and a rug look identical (holders≈0, one shared txn
 * window), so the discriminating signal cannot live in the entry snapshot; it
 * lives in the trajectory we used to throw away. This is that trajectory,
 * recorded with zero capital via keyless DexScreener. Paired with
 * `candidate_outcomes` (the label), these rows are the training set that lets
 * us FIT the classifier's factor weights instead of guessing them.
 *
 * `markMultiple` is priced off the FIRST observation (refPriceUsd) — i.e. "what
 * if we had entered the instant the signal fired" — so a recorded basket is
 * directly simulatable with the management overlay + convex slippage.
 */
export const candidateTicks = pgTable(
  "candidate_ticks",
  {
    id: serial("id").primaryKey(),
    mint: text("mint")
      .notNull()
      .references(() => tokens.mint),
    signalId: integer("signal_id").references(() => signals.id),
    refPriceUsd: numeric("ref_price_usd").notNull(), // price at first observation
    priceUsd: numeric("price_usd").notNull(),
    markMultiple: numeric("mark_multiple").notNull(), // price / ref
    peakMultiple: numeric("peak_multiple").notNull(),
    drawdownFromPeakPct: numeric("drawdown_from_peak_pct").notNull(),
    liquidityUsd: numeric("liquidity_usd"),
    fdvUsd: numeric("fdv_usd"),
    volM5: numeric("vol_m5"),
    volH1: numeric("vol_h1"),
    buysM5: integer("buys_m5"),
    sellsM5: integer("sells_m5"),
    buyShareM5: numeric("buy_share_m5"), // 0..1
    priceChangeM5Pct: numeric("price_change_m5_pct"),
    ageMinutes: numeric("age_minutes").notNull(), // token age from pool creation
    watchMinutes: numeric("watch_minutes").notNull(), // minutes since first observation
    // classifier verdict over the trajectory so far — the "confirmation trigger"
    regime: text("regime"),
    action: text("action"),
    continuationScore: numeric("continuation_score"),
    snappedAt: timestamp("snapped_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("candidate_ticks_mint_idx").on(t.mint)],
);

/**
 * The LABEL row — one per candidate, written when its watch window closes.
 * Raw magnitudes are stored (not just a boolean) so the label definition can be
 * re-derived cheaply as the win criterion evolves (e.g. re-scored against the
 * convex-slippage model at a given position size). This is the `y` for the
 * logistic-regression weight fit; `candidate_ticks` supplies the `X`.
 */
export const candidateOutcomes = pgTable("candidate_outcomes", {
  mint: text("mint")
    .primaryKey()
    .references(() => tokens.mint),
  signalId: integer("signal_id").references(() => signals.id),
  refPriceUsd: numeric("ref_price_usd").notNull(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
  windowClosedAt: timestamp("window_closed_at", { withTimezone: true }),
  ticks: integer("ticks").notNull().default(0),
  peakMultiple: numeric("peak_multiple").notNull().default("1"),
  finalMultiple: numeric("final_multiple").notNull().default("1"),
  maxDrawdownFromPeakPct: numeric("max_drawdown_from_peak_pct").notNull().default("0"),
  minutesToPeak: numeric("minutes_to_peak"),
  peakLiquidityUsd: numeric("peak_liquidity_usd"),
  delisted: boolean("delisted").notNull().default(false),
  entered: boolean("entered").notNull().default(false), // did the trader take a real position?
  won: boolean("won").notNull().default(false), // provisional label: peak cleared WIN_MULT
  label: text("label").notNull().default("open"), // open | winner | dud | rug
  // Recorder-as-scout: set once when the candidate's trajectory CONFIRMS demand
  // acceleration (green + near-highs + buy-side winning). The trader consumes an
  // unconsumed trigger to open a position — this is what makes entry a
  // confirmation rather than a blind t=0 commit.
  triggeredAt: timestamp("triggered_at", { withTimezone: true }),
  triggerScore: numeric("trigger_score"), // continuation score at the trigger tick (context)
  triggerMultiple: numeric("trigger_multiple"), // markMultiple at the trigger tick
  triggerReason: text("trigger_reason"),
  // Freshest buy-share while armed — refreshed on EVERY armed poll (not just first
  // arm) so the trader sizes off the demand it is actually entering into, not a
  // minutes-old read. The hard-stop class confirms with fading buy-share (med 0.765
  // vs 0.925 for green exits); quality sizing shrinks that bet instead of vetoing.
  triggerBuyShare: numeric("trigger_buy_share"),
  // Fitted rug-model probability at the freshest armed tick (core rugModel.ts,
  // AUC 0.70 held-out). Trader sizes by it — shrink, never veto.
  rugProb: numeric("rug_prob"),
  triggerConsumed: boolean("trigger_consumed").notNull().default(false), // vestigial: entry is now gated by `armed`, not one-shot consumption
  // LIVE confirmation state — the fix for missed lightning. The recorder
  // re-evaluates the entry gate on EVERY poll and sets this true while the
  // candidate currently qualifies (in-window, ≥MIN_MULT green, ≤MAX_DD off peak,
  // ≥MIN_BUYSHARE buys) and we don't already hold it. Unlike the one-shot
  // triggeredAt, it re-arms and disarms with live demand: a candidate that
  // qualifies AFTER a breaker halt or a transient feed miss is still caught, and
  // one whose move died is dropped. The trader enters any armed + un-entered
  // candidate the recorder confirmed within the freshness window — nothing is
  // permanently burned by a timing/transient miss.
  armed: boolean("armed").notNull().default(false),
  category: text("category"), // news desk narrative category (controlled enum); backfilled by newsdesk
  narrative: text("narrative"), // news desk free-text hook phrase
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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

/** News desk: grounded, repackageable stories synthesized (local qwen) over our
 *  OWN market observations — the expert digest + content studio + ML theme
 *  substrate. `category` is a controlled enum for aggregation/emerging-theme
 *  detection; `narrative` is free-text novelty. Generation runs off the trader's
 *  critical path and this table is read-only to the dashboard. */
export const marketNews = pgTable(
  "market_news",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").notNull(), // mover | brief | rug
    mint: text("mint"), // set for mover/rug items; null for brief
    category: text("category"), // controlled NEWS_CATEGORIES enum; null for brief
    narrative: text("narrative"),
    headline: text("headline").notNull(),
    whyItMatters: text("why_it_matters"),
    importance: integer("importance").notNull().default(0),
    themes: jsonb("themes"), // brief: keyThemes[] + emerging-theme stats
    contentDrafts: jsonb("content_drafts"), // {xPost,shortTake} or {xThread,shortTake}
    refs: jsonb("refs"), // source provenance: symbol, multiples, outcome, dex, etc.
    model: text("model"), // which ollama model synthesized it
    windowStart: timestamp("window_start", { withTimezone: true }),
    windowEnd: timestamp("window_end", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("market_news_kind_created_idx").on(t.kind, t.createdAt)],
);
