# QTEA Repository Audit — Remediation Response

**Repo:** `TheGenesisArchitect/hermes-os` · **As of:** `main` @ `852fed3`, 2026-08-02
**Responds to:** QTEA Repository Audit (QTEA-001 … QTEA-015), received 2026-08-01
**Verification:** every disposition below was re-confirmed from source or production
tape on 2026-08-02, not from memory. Test suite: 32/32 passing
(`pnpm --filter @hermes/trader test`).

---

## Executive summary

All five P0 items are fixed, pinned by regression tests, and running in
production. Of the fifteen findings: **eight are FIXED, four are PARTIAL, three
remain OPEN** (router-wide valuation, breaker dimensions, best-route selection —
all P1 architecture items, scheduled below).

Two material events occurred after your audit and are disclosed here because an
audit response that hides its own incidents is worthless:

1. **A same-day regression (2026-08-02) disabled the live solvency rails for
   ~5 hours.** Commit `789f3c1` swept the `liveBuyGate` call inside a
   default-false strategy flag; live bought through an engaged kill switch and
   accepted a failed honeypot probe (2 positions, −$5.08, both unsellable).
   Root cause was the same class of defect as QTEA-001 (a brace/scope error the
   tests didn't pin). Fixed same day; the invariant test now asserts the **gate
   call site** sits outside the strategy wraps, not just the rail strings.
2. **Selection governance was formally resolved (your QTEA-005 "required
   decision").** The operator ratified Mode B — shared-strategy independent
   lane — and the selection layer is now a versioned, operator-ratified
   **Formula Manifest** (config `formula_manifest`, v2) rather than accreted
   gates. Promotion evidence is **rug-adjusted**: re-scoring paper's tape
   against the liquidity tape at fill time showed **$2,953 of paper's +$4,035
   (73%) was phantom proceeds** booked into dead pools. Your Module-6-style
   caveat is now arithmetic, not narrative.

---

## Updated audit ratings

| Domain | Was | Now | Basis |
| --- | ---: | ---: | --- |
| Shared exit strategy | B | **B+** | Same `decideExit`; live marks from real sell quotes; peak state now survives restarts. Residual: `fdvUsd`/`dexId` stubs in live's synthetic market object. |
| Live entry parity | D | **B−** | Mode B formally ratified; Formula Manifest v2 is the promotion contract; every `live_open` carries its manifest tier; counterfactual watch from day one. Not yet a full normalized `decision_packet` (P2). |
| Live valuation | D | **D+** | QTEA-003 still open (Jupiter-only executable marks). Mitigations shipped: parallel whole-book valuation (mark age ~8s → ~2s), feed fallback with peak-sanity guard. |
| Protective selling | C− | **B** | Latch braces fixed + awaited + tested; chamber-before-quote; fail-closed chamber (`canFloor`); on-chain floor corrected to the −45% standard (0.40 → 0.55 minOut); event-speed drain cut now fires for live-only seats; floor blocks count as unsellability evidence. |
| Presigned sniper | C | **B** | Books `fired.qtyRaw` (executed, not requested); chain-truth `closeVerdict`; chambers/nonces persisted + rehydrated; rehydration decoupled from the sniper flag. Fire-rate ≥70% target: instrumented, not yet proven over a multi-deploy week. |
| Runtime persistence | C+ | **B−** | `latch` write awaited (sync-durable); `chamber`, `exclude`, `peak` persisted + rehydrated. Residual: `poolpeak` scope declared but unwired; `sellBackoff`/`floorBlockAt` counters restart-amnesiac; TTL still global 6h (QTEA-015 open). |
| Router | C | **C** | Unchanged: one-dimensional breakers, first-route selection. Mitigation: protective full exits bypass the router entirely via the chamber; per-position route poisoning (`sellExclude`) is persisted. |
| Accounting/reconciliation | D+ | **B−** | `closeVerdict` closes from post-settlement chain truth; mismatch refuses to close and books the expense, never a fill; ledger-reversal reconcile tool shipped (`chain-recon.ts`, #7110). Residual: fill/journal/position projection still not one transaction (QTEA-012). |
| Automated testing | F | **C** | `test` + `typecheck` scripts exist; 32 invariant tests pin QTEA-001/002/004/010/011/014, admission-door semantics, chamber fail-closed, solvency-rail placement, and manifest verdicts. Missing: provider contract fixtures, property tests, execution-path replay engine. |
| **Selection governance** (new) | — | **A−** | Selection as ratified data: rug-adjusted harness (`formula-manifest.ts`), 1,241-combo sweep with cross-era replication (`formula-combo.ts`), counterfactual watch (`manifest-watch.ts`), fail-open module with pure tested verdict. |

---

## Finding-by-finding disposition

| ID | Finding | Status | Evidence |
| --- | --- | --- | --- |
| QTEA-001 | Latch persisted outside its conditional | **FIXED** | `shouldPersistLatch` pure predicate (`invariants.ts`); write is inside the branch and `await`ed (`executor.ts` — "governed by the `if`; persistState ran on EVERY sell"). Tests 1–4. Hardening beyond the ask: latch/exclude rehydration no longer dies when `LIVE_PRESIGNED_EXITS` is off. |
| QTEA-002 | Sniper sells 99.5%, books 100% | **FIXED** | `executedRaw = fired.qtyRaw`; settlement parsed from tx meta. Tests 7–8 ("a sniper residual prevents a false full closure"). |
| QTEA-003 | Jupiter-only executable valuation | **OPEN (P1)** | Guard still values via `exitJup`; direct-route positions fall to the feed mark (peak-sanity-guarded). Router-wide `ExecutableMarkProvider` accepted as the design; not yet built. |
| QTEA-004 | Price-impact units not normalized | **FIXED** | `impactFraction`/`impactPct`/`impliedLiquidityUsd` (`invariants.ts`); tests 5–6 include the 101×-liquidity regression guard and malformed/zero/total-impact cases. |
| QTEA-005 | Live is not a paper mirror | **RESOLVED BY DECISION** | Mode B ratified 2026-08-02. Formula Manifest v2 is the formal promotion contract; boot banner and docs no longer claim strict mirror; the twin-paired same-mint cut is the only sanctioned cross-lane comparison. Full `decision_packet` remains P2. |
| QTEA-006 | Best-effort persistence | **PARTIAL** | Latch: awaited (sync-durable ✓). Chamber: still `void` — mitigated by the 90s re-chamber loop and durable-nonce validity, accepted risk for now. Fill journal: Σ=0 enforced. Durability-class table adopted in principle; not yet encoded. |
| QTEA-007 | Global breakers across buy/sell | **OPEN (P1)** | `Map<string, Breaker>` keyed by provider only. Mitigations: chambered protective exits skip the router; per-position `sellExclude` persisted. Dimension work (side × urgency) not started. |
| QTEA-008 | First-route, not best-route | **OPEN (P1)** | Unchanged. Note: protective path already follows your "prebuilt route first" prescription via the chamber. |
| QTEA-009 | Sizing floor / silent sub-viable skips | **FIXED** | `LIVE_SLOT_FLOOR_AWARE` (default true); residual skips audited; audit row prints the effective aggregate ("floor can widen it past LIVE_MANDATE_AGG_FRAC and that must be visible"). 2026-08-02: mandate slot additionally clamped to `affordable` — the prior expression was an unconditional identity that skipped the exposure clamp. |
| QTEA-010 | Audit message reports paper config | **FIXED** | Live sizing audit prints `LIVE_MANDATE_*`; test 11 pins it (paper keys assert-absent). |
| QTEA-011 | `rawSell === raw` as close predicate | **FIXED** | `closeVerdict` closes from post-settlement chain balance with explicit `dust_close` and `mismatch` outcomes; mismatch branch returns before any fill is journalled (tested). |
| QTEA-012 | Fill/position update not atomic | **PARTIAL** | Conditional `status='open'` close; Σ=0 journal; reconcile tooling. Single-transaction idempotent projection: not yet. |
| QTEA-013 | TP failures excluded from evidence | **PARTIAL** | Route-class failures poison the provider regardless of reason (persisted `exclude`); floor blocks now count toward unsellability (`547a670`). TP tolerance-reverts still deliberately never feed `fails` — position-level rationale documented in-line; failure-type (not reason-type) counting accepted as the right model, not yet implemented. |
| QTEA-014 | Regex error classification | **PARTIAL→GOOD** | `classifySwapFailure` classifies by **program + code** ("6001 is NOT slippage on pumpswap — it is ZeroBaseAmount"); bare codes are never guessed. Full structured `ExecutionFailure` union across every call site: not yet; regexes remain at some boundaries. |
| QTEA-015 | Global 6h TTL for all scopes | **OPEN (P2)** | Single `REHYDRATE_MAX_AGE_MS`. Agreed: latch/chamber TTL should be book-state-scoped. |

---

## Work beyond the audit's scope (2026-08-02)

1. **Solvency-rail regression + same-day fix** (disclosed above). Fix commit
   `852fed3`; invariant now pins the `liveBuyGate` call site outside both
   strategy wraps. This closes the test gap that let the regression pass CI.
2. **Event-speed drain cut for live-only seats.** `fastDrainExit` previously
   required an open paper twin and a priceable aggregator market before
   mirroring to live — a pulled pool is precisely when neither holds. The live
   cut now fires first, unconditionally. Context: `drain_guard_cut` had fired
   once in 14d against 59 unsellables (−$157.24).
3. **Rug-adjusted promotion pipeline.** `formula-manifest.ts` re-reads every
   paper sell fill against the liquidity tape at fill time ($1,200 dead-pool
   line): paper's star venue (meteora-dbc, booked +$2,848) adjusts to −$76.
   All future signature/band/venue promotion is scored on live-executable EV.
4. **Formula Manifest v2 wired and armed** behind `FORMULA_MANIFEST_ENABLED`:
   pure fail-open verdict, both tiers' refusal reasons audited, manifest tier
   stamped on every `live_open`, counterfactual watch script shipped.
5. **Silent-decline audits** added at the wallet-null swap stage and the
   whole-book guard skip (throttled), plus `fastFloorSweep` now reads the
   effective (dashboard-merged) config.
6. **Architecture fence declared in the manifest itself:** venue evidence
   recorded before 2026-08-02T14:41Z was generated under the defective lane
   (no live drain cut, disabled rails, no honeypot gate) and does not convict
   the fixed lane; damm-v2 re-qualifies through the filler tier under clean
   fills.

---

## Production gates — current status

| Gate | Status |
| --- | --- |
| Protective exits consulting chamber when eligible | Instrumented (`live_presigned_fallback` + fire audits); coverage % not yet computed over a clean week |
| Terminal exits with structured final outcome | Partial — `closeVerdict` outcomes are structured; free-text reasons remain elsewhere |
| Chain/ledger token-quantity reconciliation | Tooling live (`chain-recon.ts`); 32 historic mismatches identified 2026-07-31, remediation in progress |
| Unexplained live/paper decision divergence | Superseded by Mode B + manifest audit trail; twin-paired cut is the sanctioned comparison |
| Duplicate sell incidents | Guarded (in-flight claims + conditional close); claims are process-local — a known residual |
| Negative remaining quantities | Blocked by `closeVerdict` (test-pinned) |
| Restart survival for active latches | **Met** (persisted, awaited, rehydrated — decoupled from sniper flag) |
| Restart survival for chambers | **Met** (persisted + 90s re-arm loop; write itself still best-effort) |
| Sell-path timestamp coverage | **Not met** — sell-path telemetry remains the top instrumentation gap (GTPED §8 #2); next engineering item |
| Provider-attributed failure coverage | Partial — provider recorded on poisoning and fills; not yet on every failure row |

**Depth/exitability floors remain in place.** The kill switch is engaged pending
operator re-qualification; nothing in this response loosens a rail.

---

## Remaining work, in order

1. **P1 — Sell-path telemetry** (quote age, class, tolerance, landMs per sell) — unlocks the gate table above.
2. **P1 — Router-wide executable valuation** (QTEA-003): `ExecutableMarkProvider` across the direct providers.
3. **P1 — Breaker dimensions** (QTEA-007) and **best-route scoring** (QTEA-008).
4. **P1 — Transactional fill/journal/position projection** (QTEA-012).
5. **P2 — `decision_packet` persistence** for full parity attribution (QTEA-005 completion).
6. **P2 — Scope-specific TTLs** (QTEA-015); wire `poolpeak`; persist the write-off counters.
7. **P2 — Structured `ExecutionFailure` union** end-to-end (QTEA-014 completion); failure-type evidence counting (QTEA-013).
8. **P3 — Provider contract fixtures, property tests, execution-path replay engine.**

---

*Prepared by the desk, 2026-08-02. Every claim above is reproducible from
source at `852fed3`, the test suite, or the production `audit_log`; the two
incidents disclosed were surfaced by our own audit, not external report.*
