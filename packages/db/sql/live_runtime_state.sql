-- ── PERSISTENT EXECUTION STATE (QTES Phase A, priority #1, 2026-07-31) ──────
-- GTPED P3 says: given identical market data the engine makes the identical
-- decision, 100% of the time. It does not. Seven module-level Maps hold
-- decision state that a process restart destroys, and the cost is measured:
-- sniper hit rate 13 fired / 39 chambered (33%) across a day with ~8 deploys,
-- with 11 chambers never consulted and 16 missing.
--
-- Auditor: "Process restarts should never erase tactical state."
--
-- scope = which map · key = position id or mint · value = the entry
CREATE TABLE IF NOT EXISTS live_runtime_state (
  scope      text NOT NULL,
  key        text NOT NULL,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);
CREATE INDEX IF NOT EXISTS live_runtime_state_scope_idx ON live_runtime_state (scope);
