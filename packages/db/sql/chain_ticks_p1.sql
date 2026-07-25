-- P1: SLOT TELEMETRY (ratified 2026-07-25, recursive upgrade loop).
-- One row per pool-account ws event (throttled) for OPEN positions: the
-- hot stream behind the event-driven depth rail and the card's flow tape.
CREATE TABLE IF NOT EXISTS chain_ticks (
  id        bigserial PRIMARY KEY,
  mint      text NOT NULL,
  pool      text NOT NULL,
  slot      bigint,
  lamports  bigint,           -- pool account SOL balance (bonding curves: the quote side)
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chain_ticks_mint_at_idx ON chain_ticks (mint, at DESC);
