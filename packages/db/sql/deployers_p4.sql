-- P4: DEPLOYER FINGERPRINTS (ordered 2026-07-26). One row per mint: the
-- proven creator (fee payer of the mint's genesis transaction, found by
-- paginated history walk). deployer_rep aggregates launches -> outcomes.
CREATE TABLE IF NOT EXISTS token_deployers (
  mint         text PRIMARY KEY,
  deployer     text,
  creation_sig text,
  created_at   timestamptz,
  tx_pages     int,
  walked_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS token_deployers_deployer_idx ON token_deployers (deployer);
