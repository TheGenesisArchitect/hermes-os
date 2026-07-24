-- RECOVERED TIER (ratified 2026-07-24): wallet_winner_hits widens to net-positive
-- wallets (wins > rugs); this column preserves the PRECISION subset (never-rugged)
-- so sizing can split the tiers. NULL on pre-tier rows = winner hits were strict.
ALTER TABLE candidate_outcomes ADD COLUMN IF NOT EXISTS wallet_strict_hits integer;
