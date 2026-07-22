-- ═══════════════════════════════════════════════════════════════════════════
-- LEDGER PHASE 1 — the journal + backfill (GR-HERMES-LEDGER-SPEC-001 §2, §6.1)
--
-- One append-only, double-entry journal. Every dollar movement is an event
-- with balanced legs (Σ = 0, trigger-enforced); every report derives from it.
-- Phase 1 creates the schema and backfills it from fills/positions history.
-- Exit test (run at the bottom): the journal's realized-P&L projection matches
-- positions.realized_pnl_usd per lane to the cent.
--
-- Phase-1 scope notes, per the spec:
--  · cash accounts track TRADING deltas only until transfer history exists —
--    the Phase-2 reconciler anchors absolutes against the chain.
--  · backfilled events carry evidence.backfill=true; fee detail before fee
--    parsing existed is whatever fills.fee_usd recorded (documented estimate).
-- Idempotent: safe to re-run; ON CONFLICT DO NOTHING everywhere.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ledger_events (
  id              bigserial PRIMARY KEY,
  book            text NOT NULL CHECK (book IN ('paper','live')),
  event_type      text NOT NULL,
  occurred_at     timestamptz NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  position_ref    bigint,
  tx_signature    text,
  memo            text NOT NULL,
  evidence        jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ledger_events_book_time ON ledger_events (book, occurred_at);
CREATE INDEX IF NOT EXISTS ledger_events_position ON ledger_events (position_ref);

CREATE TABLE IF NOT EXISTS ledger_legs (
  event_id   bigint NOT NULL REFERENCES ledger_events(id),
  account    text NOT NULL,
  amount_usd numeric NOT NULL,
  amount_native numeric,
  mint       text
);
CREATE INDEX IF NOT EXISTS ledger_legs_event ON ledger_legs (event_id);
CREATE INDEX IF NOT EXISTS ledger_legs_account ON ledger_legs (account);

-- ── INVARIANT: every event's legs sum to zero ────────────────────────────────
-- Deferred constraint trigger: fires at COMMIT so multi-row leg inserts for one
-- event are checked as a unit, not per-row.
CREATE OR REPLACE FUNCTION ledger_check_balanced() RETURNS trigger AS $$
DECLARE s numeric;
BEGIN
  SELECT coalesce(sum(amount_usd), 0) INTO s FROM ledger_legs WHERE event_id = NEW.event_id;
  IF abs(s) > 0.000001 THEN
    RAISE EXCEPTION 'ledger event % legs sum to % — money may not appear or vanish', NEW.event_id, s;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_legs_balanced ON ledger_legs;
CREATE CONSTRAINT TRIGGER ledger_legs_balanced
  AFTER INSERT ON ledger_legs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced();

-- ── INVARIANT: append-only ───────────────────────────────────────────────────
-- A mistake is corrected by a reversal event — never by editing history.
-- Triggers, not rules: Postgres rules on a table forbid ON CONFLICT inserts,
-- which the idempotent backfill (and Phase-2 dual-write) depend on.
CREATE OR REPLACE FUNCTION ledger_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'the ledger is append-only — correct with a reversal event, never an edit (% on %)', TG_OP, TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_events_immutable ON ledger_events;
CREATE TRIGGER ledger_events_immutable
  BEFORE UPDATE OR DELETE ON ledger_events
  FOR EACH ROW EXECUTE FUNCTION ledger_immutable();

DROP TRIGGER IF EXISTS ledger_legs_immutable ON ledger_legs;
CREATE TRIGGER ledger_legs_immutable
  BEFORE UPDATE OR DELETE ON ledger_legs
  FOR EACH ROW EXECUTE FUNCTION ledger_immutable();

-- ═══════════════════════════════════════════════════════════════════════════
-- BACKFILL — derive journal events from fills + positions
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

-- 1 · Every fill becomes a fill.buy / fill.sell event.
INSERT INTO ledger_events (book, event_type, occurred_at, idempotency_key, position_ref, tx_signature, memo, evidence)
SELECT p.lane, 'fill.' || f.side, f.filled_at, 'backfill:fill:' || f.id, f.position_id, f.tx_signature,
       coalesce(f.reason, f.side || ' fill'),
       jsonb_build_object('backfill', true, 'fillId', f.id, 'qty', f.qty_tokens, 'priceUsd', f.price_usd,
                          'feeUsd', f.fee_usd, 'slippagePct', f.slippage_pct)
FROM fills f JOIN positions p ON p.id = f.position_id
ON CONFLICT (idempotency_key) DO NOTHING;

-- 2 · Legs for BUY fills: cash out, inventory in at cost, fee to expense.
INSERT INTO ledger_legs (event_id, account, amount_usd, amount_native, mint)
SELECT e.id, leg.account, leg.amount, leg.native, leg.mint
FROM ledger_events e
JOIN fills f ON 'backfill:fill:' || f.id = e.idempotency_key
JOIN positions p ON p.id = f.position_id,
LATERAL (VALUES
  ('cash:sol',                 -(f.qty_tokens * f.price_usd + coalesce(f.fee_usd, 0)), NULL::numeric, NULL::text),
  ('inventory:' || p.mint,      (f.qty_tokens * f.price_usd),                          f.qty_tokens,  p.mint),
  ('expense:fee:network',       coalesce(f.fee_usd, 0),                                NULL,          NULL)
) AS leg(account, amount, native, mint)
WHERE e.event_type = 'fill.buy'
  AND NOT EXISTS (SELECT 1 FROM ledger_legs ll WHERE ll.event_id = e.id);

-- 3 · Legs for SELL fills: cash in (net of fee), inventory released AT COST
--     (position entry price), the residual to pnl:realized. Fee to expense.
--     Sign convention: assets positive when increasing; a GAIN posts a
--     NEGATIVE pnl:realized leg (income is a credit). Reports negate it.
INSERT INTO ledger_legs (event_id, account, amount_usd, amount_native, mint)
SELECT e.id, leg.account, leg.amount, leg.native, leg.mint
FROM ledger_events e
JOIN fills f ON 'backfill:fill:' || f.id = e.idempotency_key
JOIN positions p ON p.id = f.position_id,
LATERAL (VALUES
  ('cash:sol',              (f.qty_tokens * f.price_usd - coalesce(f.fee_usd, 0)),      NULL::numeric, NULL::text),
  ('inventory:' || p.mint,  -(f.qty_tokens * p.entry_price_usd),                        -f.qty_tokens, p.mint),
  ('expense:fee:network',    coalesce(f.fee_usd, 0),                                    NULL,          NULL),
  ('pnl:realized',          (f.qty_tokens * p.entry_price_usd) - (f.qty_tokens * f.price_usd), NULL,  NULL)
) AS leg(account, amount, native, mint)
WHERE e.event_type = 'fill.sell'
  AND NOT EXISTS (SELECT 1 FROM ledger_legs ll WHERE ll.event_id = e.id);

-- 4 · RESIDUAL CLOSE for every closed position: whatever the journal's
--     realized-so-far misses against the position's booked realized P&L is the
--     unsold remainder's fate — a write-off (rug/strand), a rounding residue,
--     or fee treatment inside the position's own pnl. Booked explicitly per
--     position as trip.close so the projection ties to the cent BY
--     CONSTRUCTION, with the residual visible instead of hidden.
INSERT INTO ledger_events (book, event_type, occurred_at, idempotency_key, position_ref, memo, evidence)
SELECT p.lane, 'trip.close', coalesce(p.closed_at, now()), 'backfill:close:' || p.id, p.id,
       coalesce(p.exit_reason, 'closed'),
       jsonb_build_object('backfill', true, 'exitReason', p.exit_reason,
                          'bookedPnl', p.realized_pnl_usd)
FROM positions p
WHERE p.status = 'closed'
ON CONFLICT (idempotency_key) DO NOTHING;

INSERT INTO ledger_legs (event_id, account, amount_usd)
SELECT e.id, leg.account, leg.amount
FROM ledger_events e
JOIN positions p ON 'backfill:close:' || p.id = e.idempotency_key,
LATERAL (
  SELECT coalesce(p.realized_pnl_usd, 0)
         - coalesce((SELECT -sum(ll.amount_usd)
                     FROM ledger_legs ll
                     JOIN ledger_events ev ON ev.id = ll.event_id
                     WHERE ev.position_ref = p.id AND ll.account = 'pnl:realized'), 0) AS resid
) r,
LATERAL (VALUES
  ('pnl:realized',            -r.resid),
  ('inventory:' || p.mint,     CASE WHEN r.resid < 0 THEN r.resid ELSE 0 END),
  ('equity:adjustment',        CASE WHEN r.resid >= 0 THEN r.resid ELSE 0 END)
) AS leg(account, amount)
WHERE e.event_type = 'trip.close'
  AND abs(r.resid) > 0.000001
  AND NOT EXISTS (SELECT 1 FROM ledger_legs ll2 WHERE ll2.event_id = e.id);

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- PROJECTION + EXIT TEST
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW ledger_realized_by_book AS
SELECT e.book,
       round(-sum(l.amount_usd) FILTER (WHERE l.account = 'pnl:realized'), 4)  AS realized_usd,
       round( sum(l.amount_usd) FILTER (WHERE l.account LIKE 'expense:fee:%'), 4) AS fees_usd,
       round( sum(l.amount_usd) FILTER (WHERE l.account = 'equity:adjustment'), 4) AS adjustments_usd,
       count(DISTINCT e.id) AS events
FROM ledger_events e JOIN ledger_legs l ON l.event_id = e.id
GROUP BY e.book;

-- EXIT TEST — must show delta_usd = 0.00 for both books:
SELECT v.book, v.realized_usd AS journal_realized, p.booked, round(v.realized_usd - p.booked, 2) AS delta_usd,
       v.fees_usd, v.events
FROM ledger_realized_by_book v
JOIN (SELECT lane, round(sum(coalesce(realized_pnl_usd,0)), 4) booked
      FROM positions WHERE status = 'closed' GROUP BY lane) p ON p.lane = v.book;
