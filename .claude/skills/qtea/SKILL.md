---
name: qtea
description: Quantitative Trading Engineering Audit — run when asked to audit the platform, explain a losing day, verify a subsystem against GTPED, or before/after any live execution change. Eight recurring audit modules with the exact queries.
---

# QTEA — Quantitative Trading Engineering Audit

Mandate: **continuously verify that the production system behaves as
designed.** Governed by `docs/GTPED.md`. Read that first; §7 is the standing
compliance state and §8 the ordered backlog.

## The prime directive

> Attribute, don't speculate.

Every finding must name the module, the evidence, and the dollar amount. A
finding without a number is a hypothesis, and hypotheses are labelled as such.

**Run the query before the claim reaches the operator.** The most expensive
failure mode in this codebase's history is not caution — it is reporting a
conclusion that the very next query overturns.

---

## Module 1 — Architecture Audit
*Single responsibility, defined interfaces.*

- Does any function both DECIDE and EXECUTE? (`guardLiveBook`, `maybeLiveBuy`
  currently do — GTPED §7 P2.)
- Does any paper path reach into live execution? (`mirrorLiveSell` does.)
- Is decision state in-process? Enumerate every module-level `Map`/`Set` that a
  decision reads. Each one is a P3 violation.

## Module 2 — Execution Audit
*Decision-to-fill.*

```sql
-- quote-to-fill: what the guard's last mark said vs what the fill returned
WITH x AS (
  SELECT p.lane, p.id,
    (p.exit_price_usd::float/nullif(p.entry_price_usd::float,0)) fill_x,
    (SELECT pt.mark_multiple::float FROM position_ticks pt
      WHERE pt.position_id=p.id AND pt.snapped_at <= p.closed_at
      ORDER BY pt.snapped_at DESC LIMIT 1) last_mark_x,
    (SELECT extract(epoch from (p.closed_at - pt.snapped_at)) FROM position_ticks pt
      WHERE pt.position_id=p.id AND pt.snapped_at <= p.closed_at
      ORDER BY pt.snapped_at DESC LIMIT 1) mark_age_s
  FROM positions p WHERE p.status='closed' AND p.closed_at > now() - interval '24 hours'
    AND p.entry_price_usd::float>0 AND p.exit_price_usd::float IS NOT NULL)
SELECT lane, count(*) n, round(avg(fill_x/nullif(last_mark_x,0))::numeric,3) fill_over_quote,
       round(avg(mark_age_s)::numeric,0) avg_mark_age_s
FROM x WHERE last_mark_x > 0 GROUP BY lane;
```

Also: `landMs` and `latencyMs` from `live_open` audit rows. **Sell-path timing
is not yet instrumented** (GTPED §8 gap 2) — say so rather than inferring.

## Module 3 — Statistical Audit
*Do filters and thresholds improve EV?*

For any gate, produce **refused count · moon% · dud% · TOTAL EV retained**.
A gate is only justified when it refuses more duds than moons AND the EV it
removes is smaller than the EV it protects.

⚠️ **Total EV, not per-trade EV.** Filters that double per-trade quality
routinely destroy 40–64% of a class's total expected value.
⚠️ **Entry-knowable features only.** Exclude `peak_liquidity_usd`,
`minutes_to_peak`, `final_multiple`, `max_drawdown_from_peak_pct`.

## Module 4 — Infrastructure Audit
RPC health, provider breakers, deploy stability, persistence. Count restarts in
the window — restarts invalidate in-memory decision state and any
before/after comparison spanning one is confounded.

## Module 5 — Risk Audit

```sql
SELECT (SELECT value FROM config WHERE key='live_kill') AS kill_state,
       (SELECT round(sum(realized_pnl_usd)::numeric,2) FROM positions
         WHERE lane='live' AND closed_at >= date_trunc('day',now())) AS pnl_today,
       (SELECT round(sum(size_usd)::numeric,2) FROM positions
         WHERE lane='live' AND status='open') AS open_exposure;
```

Verify the sizer's arithmetic against its own floors. **Known live defect:**
`balance × agg ÷ slots` can compute below `LIVE_MIN_POSITION_USD`, causing
silent skips (GTPED §7).

## Module 6 — Simulation Audit
*Where paper diverges from live.*

The paired same-mint cut is the only controlled comparison — it holds token,
market and window constant.

⚠️ **Paper's fill model is optimistic on the death cohort.** `convexSlippagePct`
is depth-aware but reads liquidity from DexScreener, which lags an LP pull by
seconds. Paper books orderly exits on positions live cannot exit at all.
**Paper is a valid model of selection and management, NOT of rug-class
outcomes.** Never present a paper-vs-live gap without this caveat.

## Module 7 — Regression Audit
Replay historical trades through current code. `packages/db/replays/` holds the
decision-path harnesses. **There is no execution-path replay engine yet** —
until there is, execution changes ship unreplayed and must be labelled so.

## Module 8 — Performance Attribution Audit
The objective (GTPED §9): decompose underperformance into execution latency,
routing failures, configuration constraints, and market effects. **Not yet
automated.** Until it is, attribute manually and say it was manual.

---

## Reconciliation — run this first, always

Books must agree with chain. If they don't, every other finding is suspect.

```sql
SELECT (SELECT equity_usd FROM pnl_snapshots WHERE lane='live'
          ORDER BY snapped_at DESC LIMIT 1) AS equity_now,
       (SELECT sum(realized_pnl_usd) FROM positions WHERE lane='live') AS recorded_all_time;
```

And on-chain: the wallet may hold token inventory the book has zeroed —
`live_unsellable` write-offs legitimately leave tokens behind, but a position
closed via `basis_first`/`user_cut`/`profit_trail` with a non-zero chain
balance is a genuine mismatch. 32 such mismatches existed on 2026-07-31.

---

## Output contract

```
FINDING     one sentence, with the dollar amount
EVIDENCE    the query and its result — reproducible
MODULE      which subsystem owns it
SEVERITY    doctrine principle violated
FIX         the change, and what it is expected to move
CONFIDENCE  n, and whether the sample can carry the claim
```

Never emit a finding without `CONFIDENCE`. An n=7 sample cannot convict a rail,
and three of those seven being LP pulls makes it n=4.
