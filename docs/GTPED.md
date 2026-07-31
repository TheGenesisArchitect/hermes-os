# Genesis Trading Platform Engineering Doctrine (GTPED)

**v1.0 · established 2026-07-31 · operator doctrine**

> Never optimize for more trades.
> Optimize for more **correctly executed** trades.

Every feature must answer one question: **does this preserve expected value?**
If not, it does not belong.

This document is binding. §7 is an honest audit of the current codebase
against it — including where we currently fail.

---

## 1. THE FOUR PRINCIPLES

### P1 — Every dollar must be explainable
If the wallet loses $1.13, engineering must name the module, the RPC, the
quote, the route, and the decision that produced it. **No unexplained losses.**

### P2 — Decision ≠ Execution
```
Signal → Decision → Portfolio → Execution → Settlement → Accounting
```
Every layer owns ONE responsibility. Never two.

### P3 — Deterministic decisions
Given identical market data, the engine makes the identical decision, 100% of
the time. **No hidden state. No randomness.**

### P4 — Execution must be observable
Every API call, RPC, route, retry, timeout, quote and fill is measurable.
What cannot be measured cannot be optimized.

---

## 2. OWNERSHIP

| team | owns | never touches |
|---|---|---|
| **A · Portfolio Intelligence** | strategy, AI, learning, sizing, paper | wallet code |
| **B · Execution** | live executor, sniper, router, priority fees, RPC | strategy |
| **C · Market Data** | DexScreener, Jupiter, pool reads, price feed, latency | — |
| **D · Risk** | kill switch, daily loss, exposure, limits, breakers | — |
| **E · Data Science** | statistics, analytics, feature importance, model validation | — |
| **F · Infrastructure** | deploy, monitoring, persistence, database | — |
| **G · Quality Assurance** | regression, simulation, replay, chaos | — |

**One KPI per subsystem:**

| subsystem | KPI |
|---|---|
| Execution | quote latency · fill latency · success rate · retry rate · failure rate |
| Router | provider success · route availability · median fill time · route cost |
| Strategy | win rate · profit factor · Sharpe · EV · max drawdown |
| Risk | daily loss · exposure · tail loss · survival rate |

---

## 3. EVERY PULL REQUEST ANSWERS FIVE QUESTIONS

No merge unless all five exist.

1. **What defect exists?**
2. **Root cause**
3. **Evidence**
4. **Expected improvement**
5. **Risk introduced**

---

## 4. CODE STANDARD

No conditional ships without purpose, metric, failure mode and owner.

```typescript
/**
 * PURPOSE       Prevent LP-pull victims.
 * SUCCESS       Reduce catastrophic exits >35%.
 * FAILURE MODE  False negatives reduce moon captures.
 * OWNER         Execution Team
 */
```

---

## 5. LIFECYCLE — SIX GATES, NO SKIPPING

```
Research → Specification → Simulation → Paper Validation → Live Canary → Production
```

### 5.1 The Replay-Before-Repair rule
Before any bug is fixed:
1. Capture full market state at the time of the trade.
2. Replay the exact sequence through current code.
3. Apply the proposed fix.
4. Replay the identical state again.
5. Compare outcomes.

Improved execution with no regression → eligible for paper. Not before.

---

## 6. FAILURE TAXONOMY

Every error belongs to a category and a path. No generic errors.

```
Market · Liquidity · Execution · Infrastructure · Configuration
RPC · Strategy · Wallet · Database · Human
```

```
Execution → Router → PumpSwap → Quote Timeout → Retry Success
```

---

## 7. COMPLIANCE AUDIT — CURRENT STATE, 2026-07-31

Honest assessment. Evidence is from this date's production tape.

### P1 — Every dollar explainable · **PARTIAL**
✅ We can do it. A −$1.64 loss on MOONDOGE (`#6853`) was traced to the exact
tick where liquidity went `$13,420 → $2` in six seconds, with the fill
signature and the two-leg fill breakdown.
❌ It is **manual and reactive**. There is no automatic attribution. Nothing
produces "underperformed by 3.2%: 1.4% latency, 0.9% routing, 0.5% sizing".
**Gap: attribution engine.**

### P2 — Decision ≠ Execution · **VIOLATED**
❌ `guardLiveBook()` values positions, decides exits, AND executes sells in one
loop. `maybeLiveBuy()` gates, sizes, AND buys.
❌ Paper's `basket_harvest` calls `mirrorLiveSell()` directly — a **paper
decision reaching into live execution**, which is the exact coupling P2 forbids.
**Gap: extract a Portfolio layer between Decision and Execution.**

### P3 — Deterministic decisions · **VIOLATED**
❌ Decisions depend on in-process state that a restart destroys:
`exitLatch`, `poolPeak`, `livePeakMark`, `chambers`, `sellExclude`,
`ripeClock`, `guardHits`.
❌ Measured consequence: sniper hit rate **12 fired / 20 fallback (37%)** across
a day with ~8 deploys. Identical market data produced different decisions
before and after each restart.
**Gap: persist decision state. This is the highest-severity violation.**

### P4 — Execution observable · **PARTIAL**
✅ Every live decision writes an `audit_log` row. Every fill carries a tx
signature. The journal is append-only with Σ legs = 0 enforced.
❌ Latency is captured **only at buy** (`latencyMs: {gates, quote, total, swapAndConfirm}`).
The sell path records none of it. We measured an 8-second mark age by
inference, not instrumentation.
**Gap: per-stage timing on the sell path.**

### Lifecycle · **VIOLATED — 17 production changes today**
Commits `ae3c428` → `604ce4e` went Research → Production. **No Live Canary
gate exists.** Several shipped on harness evidence alone; four shipped on a
single trade's evidence, and two of those were later corrected by the next
query.

### Replay-Before-Repair · **PARTIALLY AVAILABLE**
✅ `packages/db/replays/` holds 12 replay harnesses and `candidate_ticks`
retains tick-level price + liquidity — the raw material exists.
❌ No harness replays the **execution** path, only the decision path. Every
execution fix today (sniper ordering, protective classification, parallel
valuation) shipped **unreplayed**.
**Gap: an execution replay engine.**

### Failure taxonomy · **ABSENT**
❌ Errors are free-text strings. `pumpportal build 400`,
`tx failed on-chain: {"InstructionError":[3,{"Custom":6001}]}` are parsed by
regex at the call site. Not searchable, not categorised, not aggregatable.
**Gap: typed error taxonomy.**

---

## 8. THE ORDERED BACKLOG

Ranked by severity of doctrine violation × measured cost.

| # | gap | principle | evidence |
|---|---|---|---|
| 1 | **Persist decision state** | P3 | 37% sniper hit rate; restarts change decisions |
| 2 | **Sell-path telemetry** | P4 | 8s mark age found by inference, not instrumentation |
| 3 | **Execution replay engine** | Replay | every execution fix today shipped unreplayed |
| 4 | **Failure taxonomy** | §6 | errors are regex-matched strings |
| 5 | **Attribution engine** | P1 | no automatic explanation of a losing day |
| 6 | **Extract Portfolio layer** | P2 | paper's harvest calls live's executor |
| 7 | **Live Canary gate** | §5 | 17 changes went straight to production today |

---

## 9. THE OBJECTIVE

The platform must become **self-diagnosing**. Instead of an engineer asking
"why did the wallet lose money today?", the platform answers:

> The live wallet underperformed by 3.2% relative to model. Attributable
> causes: 1.4% execution latency, 0.9% routing failures, 0.5%
> configuration-induced sizing constraints, 0.4% market effects.

When attribution is automatic, engineering becomes evidence-driven and work is
prioritised by measured impact rather than intuition.

---

## 10. STANDING RULES THAT PREDATE THIS DOCTRINE AND SURVIVE IT

Earned from production losses; GTPED absorbs rather than replaces them.

1. **Entry-knowable features only.** A post-hoc feature that looks predictive
   is look-ahead bias (`peak_liquidity_usd` showed "2% death / 90% run"; the
   effect vanished when re-measured at the trigger tick).
2. **Report total EV retained, not per-trade EV.** Filters that double
   per-trade quality routinely destroy 40–64% of a class's total EV.
3. **Never bring an under-powered sample to defend a rail.** The burden is on
   the rail.
4. **A silent decline is a defect.** Every live decision carries an audit row.
5. **Read offer tables as offer, not as risk.** A 7,759-tail band with a 22%
   dud rate is the largest opportunity in the book, not the worst cohort.
6. **Config precedence is `.env` > code default.** Grep the VALUE, not the
   name, and check for hardcoded literals — all three layers, every time.
7. **A conviction expires with its cause.** Evidence generated under a
   superseded architecture does not convict the current one.
