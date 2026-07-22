-- PERF (2026-07-22): partial covering index for the edge-separation metric.
-- getEdgeSeparation's early-confirmation score aggregates max(continuation_score)
-- per mint within the first 5 watch-minutes; against a 1.1M-row candidate_ticks
-- this was the dashboard's hottest path (5-12s per instance in pg_stat_activity)
-- until the query was rewritten as one grouped pass over this index.
-- Applied to the live DB 2026-07-22; kept here so a rebuilt DB reproduces it.
CREATE INDEX IF NOT EXISTS candidate_ticks_early_score
  ON candidate_ticks (mint) INCLUDE (continuation_score)
  WHERE watch_minutes <= 5 AND continuation_score IS NOT NULL;
