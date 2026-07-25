-- F6: LAUNCH ORDER (the adversary's tempo) — ratified 2026-07-25.
-- Which launch of this ticker the candidate is, counted over the prior 24h
-- (1 = first launch). Full-dataset harness: 2nd launches are the only
-- net-negative cell (−2.3¢/$); 3rd–4th are the golden window (+19.5¢/$).
-- Stamped by the recorder at trigger time so every trade traces with it.
ALTER TABLE candidate_outcomes ADD COLUMN IF NOT EXISTS launch_order integer;
