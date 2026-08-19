-- P5: WALLET VALUE WALK (SPEC-WALLET-GRAPH-VALUE Workstream A, 2026-08-14).
-- Per-wallet realized-P&L reconstruction from on-chain swaps (Helius enhanced
-- transactions). The reputation graph counts WINS; this layer counts DOLLARS —
-- the dust-vs-whale discriminator the graph was blind to.

-- Per (wallet, mint) swap accounting. realized_sol uses the cost basis of the
-- SOLD portion only; tokens still held are unrealized and excluded (honest floor).
CREATE TABLE IF NOT EXISTS wallet_trades (
  wallet         text NOT NULL,
  mint           text NOT NULL,
  buys           int      NOT NULL DEFAULT 0,
  sells          int      NOT NULL DEFAULT 0,
  tokens_bought  numeric  NOT NULL DEFAULT 0,
  tokens_sold    numeric  NOT NULL DEFAULT 0,
  sol_spent      numeric  NOT NULL DEFAULT 0,  -- SOL out on buys (fee-inclusive)
  sol_received   numeric  NOT NULL DEFAULT 0,  -- SOL in on sells (fee-netted)
  realized_sol   numeric  NOT NULL DEFAULT 0,  -- sol_received − cost basis of sold portion
  first_trade_at timestamptz,
  last_trade_at  timestamptz,
  PRIMARY KEY (wallet, mint)
);
CREATE INDEX IF NOT EXISTS wallet_trades_mint_idx ON wallet_trades (mint);
CREATE INDEX IF NOT EXISTS wallet_trades_realized_idx ON wallet_trades (realized_sol DESC);

-- Per-wallet rollup — the value-tier qualification record. This is what the
-- VALUE-WINNER tier reads (SPEC §1.2): realized dollars + volume + median entry
-- size, not win counts.
CREATE TABLE IF NOT EXISTS wallet_value (
  wallet         text PRIMARY KEY,
  sigs_seen      int      NOT NULL DEFAULT 0,
  txs_parsed     int      NOT NULL DEFAULT 0,
  swaps_counted  int      NOT NULL DEFAULT 0,  -- single-mint SOL swaps attributed
  txs_skipped    int      NOT NULL DEFAULT 0,  -- multi-token/transfer-only (reported, not hidden)
  tokens_traded  int      NOT NULL DEFAULT 0,  -- distinct mints with ≥1 attributed swap
  sol_spent      numeric  NOT NULL DEFAULT 0,
  sol_received   numeric  NOT NULL DEFAULT 0,
  realized_sol   numeric  NOT NULL DEFAULT 0,  -- Σ per-mint realized
  volume_sol     numeric  NOT NULL DEFAULT 0,  -- sol_spent + sol_received (scale signal)
  median_entry_sol numeric,                    -- dust discriminator: median per-buy notional
  sol_usd_at_walk numeric,                     -- SOL price used for the USD conversion
  realized_usd   numeric,                      -- realized_sol × sol_usd_at_walk
  oldest_sig     text,                         -- watermark: oldest sig processed (incremental walks)
  pages          int      NOT NULL DEFAULT 0,
  capped         boolean  NOT NULL DEFAULT false, -- page cap hit = history truncated
  walked_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wallet_value_realized_idx ON wallet_value (realized_usd DESC NULLS LAST);
