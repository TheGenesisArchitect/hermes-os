-- ═══════════════════════════════════════════════════════════════════════════
-- LEDGER PHASE 4 — freeze the money facts (GR-HERMES-LEDGER-SPEC-001 §6.4)
--
-- The spec's exit test: "No code path can mutate a money fact outside the
-- journal." Enforced here at the schema:
--
--   · fills      — immutable entirely (no UPDATE, no DELETE, ever)
--   · positions  — while OPEN, the trader manages freely (trims, peaks,
--                  realized accrual). The close transition (open→closed) sets
--                  the final money facts ONCE. After that, every money column
--                  is frozen: realized_pnl_usd, exit_price_usd, exit_reason,
--                  entry_price_usd, size_usd, qty_tokens, qty_remaining,
--                  peak_price_usd, closed_at, status. The DEXBULL incident —
--                  a concurrent sweep stamping live_desync_empty over a
--                  correct profit_trail — becomes structurally impossible.
--   · pnl_snapshots — append-only (history is history).
--
-- ESCAPE HATCH for deliberate manual archaeology (never for code):
--   SET LOCAL hermes.unlock = 'on';   -- inside a transaction, then the edit
-- Every use is a conscious, transaction-scoped act that cannot leak.
--
-- NOTE ON DIRECTION: journal derivation still READS fills/positions (Phase 2
-- chose derivation-as-dual-write). Full write-retirement — trader emits
-- journal events, legacy becomes views — is the Phase-4b refactor; this file
-- delivers the spec's INVARIANT within the current architecture.
-- Idempotent: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION money_fact_frozen() RETURNS trigger AS $$
BEGIN
  IF current_setting('hermes.unlock', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'money facts are frozen (% on %) — correct via a ledger reversal event; manual archaeology requires SET LOCAL hermes.unlock = ''on''',
    TG_OP, TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;

-- ── fills: immutable ─────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS fills_frozen ON fills;
CREATE TRIGGER fills_frozen
  BEFORE UPDATE OR DELETE ON fills
  FOR EACH ROW EXECUTE FUNCTION money_fact_frozen();

-- ── pnl_snapshots: append-only ───────────────────────────────────────────────
DROP TRIGGER IF EXISTS pnl_snapshots_frozen ON pnl_snapshots;
CREATE TRIGGER pnl_snapshots_frozen
  BEFORE UPDATE OR DELETE ON pnl_snapshots
  FOR EACH ROW EXECUTE FUNCTION money_fact_frozen();

-- ── positions: closed rows' money columns freeze ─────────────────────────────
CREATE OR REPLACE FUNCTION closed_position_frozen() RETURNS trigger AS $$
BEGIN
  IF current_setting('hermes.unlock', true) = 'on' THEN
    -- COALESCE, not NEW: a BEFORE DELETE trigger returning NEW (which is NULL
    -- on DELETE) silently SKIPS the delete — the exit test's own cleanup
    -- leaked a scratch position through exactly this and polluted the tape.
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'positions are never deleted — history is evidence';
  END IF;
  -- The close transition itself (open → closed) is the one write that sets
  -- the final facts; everything while still open is the trader managing.
  IF OLD.status = 'open' THEN
    RETURN NEW;
  END IF;
  -- Row is closed: any change to a money fact is refused.
  IF NEW.realized_pnl_usd IS DISTINCT FROM OLD.realized_pnl_usd
     OR NEW.exit_price_usd  IS DISTINCT FROM OLD.exit_price_usd
     OR NEW.exit_reason     IS DISTINCT FROM OLD.exit_reason
     OR NEW.entry_price_usd IS DISTINCT FROM OLD.entry_price_usd
     OR NEW.size_usd        IS DISTINCT FROM OLD.size_usd
     OR NEW.qty_tokens      IS DISTINCT FROM OLD.qty_tokens
     OR NEW.qty_remaining   IS DISTINCT FROM OLD.qty_remaining
     OR NEW.peak_price_usd  IS DISTINCT FROM OLD.peak_price_usd
     OR NEW.closed_at       IS DISTINCT FROM OLD.closed_at
     OR NEW.status          IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'position % is closed — its money facts are frozen (correct via ledger reversal; SET LOCAL hermes.unlock = ''on'' for manual archaeology)', OLD.id;
  END IF;
  RETURN NEW; -- non-money columns (nothing today, future metadata) pass
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS positions_closed_frozen ON positions;
CREATE TRIGGER positions_closed_frozen
  BEFORE UPDATE OR DELETE ON positions
  FOR EACH ROW EXECUTE FUNCTION closed_position_frozen();

-- ═══════════════════════════════════════════════════════════════════════════
-- EXIT TEST (self-contained, rolls back) — each blocked case must RAISE.
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE fid bigint; pid bigint; blocked int := 0;
BEGIN
  -- a scratch closed position + fill to attack
  INSERT INTO positions (mint, lane, status, size_usd, entry_price_usd, exit_price_usd,
                         realized_pnl_usd, qty_tokens, qty_remaining, exit_reason, closed_at)
  SELECT mint, 'paper', 'closed', 1, 1, 1.1, 0.1, 1, 0, 'phase4_test', now()
  FROM tokens LIMIT 1
  RETURNING id INTO pid;
  INSERT INTO fills (position_id, side, qty_tokens, price_usd)
  VALUES (pid, 'sell', 1, 1.1) RETURNING id INTO fid;

  BEGIN
    UPDATE positions SET realized_pnl_usd = 999 WHERE id = pid;
  EXCEPTION WHEN OTHERS THEN blocked := blocked + 1;
  END;
  BEGIN
    UPDATE positions SET exit_reason = 'tampered' WHERE id = pid;
  EXCEPTION WHEN OTHERS THEN blocked := blocked + 1;
  END;
  BEGIN
    UPDATE fills SET price_usd = 999 WHERE id = fid;
  EXCEPTION WHEN OTHERS THEN blocked := blocked + 1;
  END;
  BEGIN
    DELETE FROM fills WHERE id = fid;
  EXCEPTION WHEN OTHERS THEN blocked := blocked + 1;
  END;

  IF blocked <> 4 THEN
    RAISE EXCEPTION 'PHASE 4 EXIT TEST FAILED: only % of 4 tamper attempts were blocked', blocked;
  END IF;
  RAISE NOTICE 'PHASE 4 EXIT TEST PASSED: 4/4 tamper attempts blocked';

  -- clean up the scratch rows via the escape hatch (the one legitimate door)
  PERFORM set_config('hermes.unlock', 'on', true);
  DELETE FROM fills WHERE id = fid;
  DELETE FROM positions WHERE id = pid;
  PERFORM set_config('hermes.unlock', 'off', true);
END $$;
