-- P0: CHAIN-TRUTH LEDGER (ratified 2026-07-25, recursive upgrade loop).
-- One row per live-wallet on-chain transaction, parsed from the RPC: the raw
-- truth layer beneath the books. fills become intent records reconciled
-- against this per signature.
CREATE TABLE IF NOT EXISTS chain_txs (
  signature   text PRIMARY KEY,
  slot        bigint,
  block_time  timestamptz,
  sol_delta   numeric,          -- wallet lamports delta / 1e9 (fee-inclusive)
  fee_sol     numeric,          -- tx fee when the wallet paid it
  token_mint  text,             -- principal token moved (largest |delta|), null if none
  token_delta numeric,          -- ui-amount delta of that token for the wallet
  class       text,             -- buy | sell | rent | transfer | unknown
  matched_fill_id integer,      -- fills.id when reconciled
  ingested_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chain_txs_block_time_idx ON chain_txs (block_time);
