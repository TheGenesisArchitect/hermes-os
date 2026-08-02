# SPEC — The Institutional-Grade, Self-Optimizing Live Lane

**v1.1 · 2026-08-02 · operator directive:** *"build the Tech Specs and Execution
Services to bring all domains up to an A Average… an Institutional Grade Live
Lane that Self Optimizes as market data is consumed."*

**v1.1 changes (operator spec review, same day):** four governance domains
elevated to first-class — Decision Provenance, Model Risk Management (v1
SHIPPED), Configuration Governance, Risk Attribution — plus the Trading
Digital Twin lane, the EV Preservation Ratio headline KPI, and the expanded
Institutional Readiness scoreboard. The review's verdict is adopted verbatim
as the thesis of this revision: *the remaining gap is governance around the
optimizer itself.*

Governed by GTPED. Companion to `docs/QTEA-RESPONSE-2026-08-02.md` (the domain
scorecard this spec drives to A) and the Formula Manifest
(`formula_manifest`, the ratified selection artifact).

---

## 0. Definition of "institutional grade"

Five invariants, each measurable, none negotiable:

1. **Chain and ledger agree** — every closed position reconciles to chain truth.
2. **Exit intent is durable** — no restart, deploy, or flag flip can forget a
   commanded exit or a chambered round.
3. **Execution is measurable** — every stage of every buy AND sell carries its
   own clock and its own structured outcome.
4. **Provider selection is adaptive** — routing health is scoped to what
   actually failed; profit routing optimizes proceeds, protective routing
   optimizes time-to-land.
5. **Selection is governed data** — one versioned manifest, promoted by
   evidence, demoted by counterfactual, ratified by the operator.

"Self-optimizes" means: **the system recomputes its own edge from the rolling
tape and proposes its own changes** — with an explicit autonomy ladder so the
governance rail ("present tables → operator ratifies → ship") is never bypassed.

---

## 1. The self-optimization architecture (the flywheel)

```
paper tape (24/7 sensor)                    live tape (ground truth)
        │                                          │
        ▼                                          ▼
RUG-ADJUSTED RECOMPUTE  ◄──────────  COUNTERFACTUAL WATCH
(rolling 14d, fill-level             (every manifest seat and refusal,
 phantom detection)                   judged by its twin's outcome)
        │                                          │
        └────────────► PROPOSAL ◄──────────────────┘
                (formula_manifest_proposal
                 + manifest_proposal audit)
                          │
                   OPERATOR RATIFIES
                          │
                          ▼
              formula_manifest vN+1  ──► live selection (fail-open)
```

### Autonomy ladder — the governance contract

| Level | Behaviour | Status |
|---|---|---|
| **L0** | Manual: operator runs harnesses, edits manifest by hand | superseded 2026-08-02 |
| **L1** | **System computes and PROPOSES** — 6h rolling recompute, material deltas audited, operator promotes proposal → manifest | **SHIPPED, armed** (`optimizer.ts`) |
| **L2** | Auto-apply WITHIN pre-ratified bounds: weight nudges inside [0.6, 1.5] and **demotions only** (the system may get more cautious on its own, never bolder), behind `OPTIMIZER_AUTO_APPLY` default false | spec'd; arm only after L1 proposals prove calibrated over ≥2 weeks |
| **L3** | Unbounded self-modification | **rejected by design** |

Material-delta thresholds (damping against hot-window churn): genome
ADD/DROP requires n≥30 on the rolling window; REWEIGHT requires a move ≥0.15.
The rolling window is 14d — long enough to hold both regimes, short enough
that a dead edge cannot coast.

**The rug adjustment is permanent law:** every promotion computation re-reads
paper's sell fills against the liquidity tape at fill time ($1,200 dead-pool
line). Measured 2026-08-02: 73% of paper's booked profit was phantom.
Unadjusted promotion funds the death cohort — never score without it.

---

## 2. Per-domain path to A

### 2.1 Live valuation — D+ → A− *(largest single lift; core shipped today)*

**Defect:** Jupiter was the only valuation instrument; every direct provider
returned `canValue:false`, so fresh-pool positions were valued off the recorder
feed — non-executable marks in exactly the minutes these tokens live and die.

**Shipped (2026-08-02):**
- `SwapProvider.quoteSellValue` — the EXECUTABLE MARK seam: a direct provider
  prices a sell from its own pool reserves. No tx, no breaker mutation.
- PumpSwap implementation: one `swapSolanaState` read → orientation + both
  reserves → constant-product out with the ~30bps fee stack, impact as a
  FRACTION (QTEA-004 contract). PumpSwap is the elite tier's venue — the mark
  that matters most now exists in the pre-index window.
- `swapRouter.quoteValue()` — two-pass walk: cheap aggregator quotes first
  (common case = one HTTP call), reserve-math providers second. Read-only by
  contract: never mutates `lastRoute`, never trips a breaker. Wired at all
  three guard/probe sites; the feed-mark fallback now owns a much narrower
  window.

**Remaining for A:** `quoteSellValue` for meteora-damm-v2 (filler-tier venue;
`@meteora-ag/cp-amm-sdk` exposes pool state), meteora-dbc, and the pumpfun
curve (closed-form virtual-reserve math). Acceptance: **≥99% of open live
seats carry an executable mark ≤5s old**, measured from `position_ticks`.

### 2.2 Router — C → A− *(core shipped today)*

**Shipped (2026-08-02):**
- **Side-scoped breakers** (QTEA-007): keyed `provider#side`; three buy
  failures can no longer suppress a provider during a sell. Watchdog health
  reports either-side-routable.
- **Protective bypass:** `opts.protective` walks past OPEN breakers — the
  breaker becomes advisory for a flee; trips still record.
- **Best-sell routing** (QTEA-008): non-protective sells quote the first two
  eligible providers in parallel and take the higher output. Protective stays
  on the ordered walk (time-to-land beats price) and the chamber stays first.

**Remaining for A:** urgency dimension on breakers (protective trips tracked
separately so ordinary flow can't be poisoned by flee-storm failures);
route scoring beyond top-2 (expected proceeds net of priority fee and
historical land rate — feed from the sell telemetry below). Acceptance:
**zero protective exits delayed by a breaker opened on the buy path** (now
structural), route-choice regret measured weekly.

### 2.3 Execution observability — sell path *(shipped today)*

Every `live_sell` row now carries: `class` (protective/take_profit/ordinary),
`toleranceBps`, `provider`, `landMs`, `chambered`, `escalation{fails,holdouts}`,
`latencyMs{quote, swapAndConfirm, total}`. This closes GTPED §8 gap 2 and
unlocks four production gates in the QA response. Acceptance: **≥99% of sells
carry the full stage clock** (structural — same audit row), and the twin-drag
decomposition can now separate quote-age drag from land drag.

### 2.4 Protective selling — B → A

Remaining: (a) failure-TYPE evidence counting (QTEA-013): a `NO_ROUTE`
classification on a take-profit attempt feeds route-deterioration evidence
even though tolerance-reverts stay out of the write-off counter; (b) chamber
persistence awaited (sync-durable class) — today it is `void` + 90s self-heal;
(c) ws-watch independence: `syncSlotWatch` callable from the live guard loop
so live seats stay subscribed even when paper's loop throws, and live
positions without `pool_address` get a resolution pass instead of silence.
Acceptance: the QA gate table — 100% chamber consultation, 100% restart
survival, zero unsellables through the doors on the rolling 10.

### 2.5 Runtime persistence — B− → A

Remaining: wire `poolpeak` (declared, dead); persist `sellBackoff`/
`floorBlockAt` (the write-off counters reset on deploy — the exact counters
built to reclaim frozen slots); scope-specific TTLs (QTEA-015): latch/chamber
live with the position, not with a 6h clock; exclusions expire in minutes.
Acceptance: a kill −9 during any protective sequence resumes it identically
(chaos-tested in CI via the replay engine below).

### 2.6 Accounting — B− → A

Remaining: the idempotent transactional projection (QTEA-012): fill insert +
journal legs + position update in one DB transaction keyed by tx signature
(natural idempotency key — a duplicate settlement replay is a no-op).
Chain remains authoritative; the projection becomes exactly-once.
Acceptance: zero unexplained ledger/chain mismatches in the daily recon.

### 2.7 Testing — C → A *(the multiplier on everything else)*

- **Contract fixtures per provider** (QTEA audit's ask): one recorded quote +
  build fixture each; assert units, decimals, impact-as-fraction, no-route
  semantics. The fake-provider harness shipped today (`router.test.ts`) is the
  pattern — 41 tests now pass.
- **Execution replay engine** (GTPED §8 #3): record full market state +
  provider responses per incident; replay the exact sequence through current
  code in CI. Every named incident (FLAPDOGE, BingBing, THUNDERCAT, Wanjan,
  zuckbot #6910, JORDAN #7110, RABBIT #7280) becomes a permanent fixture.
- **Property tests:** sold ≤ pre-sell balance · remaining ≥ 0 · realized basis
  ≤ original · closed ⇒ chain ≤ dust · partial exit can never latch · manifest
  verdict is total (every input gets seat or refusal, never a throw).
- Acceptance: CI blocks merge on all three suites; the Five Questions in every
  PR body (GTPED §3).

### 2.8 Selection governance — A− → A

Remaining: the `decision_packet` (QTEA-005 completion) — persist the full
normalized input the manifest verdict consumed (every term + its source
timestamp) per entry, both lanes, so parity is provable field-by-field, and
the optimizer can re-verdict history against any manifest version offline.
Acceptance: any live/paper divergence attributable to a named packet field.

---

## 2.9 THE GOVERNANCE DOMAINS (v1.1 — the gap the operator review named)

### 2.9.1 Decision Provenance — its own subsystem, not a P2 line-item

Every entry and exit decision receives an immutable **Decision ID** anchoring
the full forensic chain:

```
decision_id → market_snapshot_hash → manifest_version → feature_vector_hash
           → wallet_state → provider_state → decision → execution (tx sig)
```

Concretely in this codebase: a `decision_packets` table (append-only, frozen
by trigger like `fills`); `maybeLiveBuy` and `decideExit` write one packet per
verdict — every term the manifest/genome consumed, each with its source
timestamp; `positions` and `management_intents` carry `decision_id` FKs; the
audit row carries it too. **Acceptance: "Why was Position #8147 opened?" is
answerable six months later from one indexed lookup, without replaying the
engine.** The optimizer gains offline re-verdicting: any manifest version can
be applied to any historical packet — which is also the Digital Twin's input
format (§2.9.5, one schema serves both).

### 2.9.2 Model Risk Management — **v1 SHIPPED 2026-08-02**

Engineering defects, statistical drift, and model drift are different
failures and get different instruments. Shipped in `optimizer.ts`:

- **PSI feature drift** — trailing 7d vs prior 7d over the exact bins the
  promotion tables gate on (inflow bands, buy-share bands, venue mix,
  signature mix). Standard thresholds: <0.10 stable · 0.10–0.25 moderate ·
  >0.25 major.
- **The confidence clause** — under a MAJOR shift the optimizer says *"the
  market has changed — I am no longer confident"*: the proposal is stamped
  `CONFIDENCE DEGRADED`, promotions and reweights are **withheld** (they were
  fitted to the regime that just ended), and only DROP deltas survive.
  Retreat requires no confidence in the new regime — only lost confidence in
  the old one. Same asymmetry as the L2 ladder rung, pinned by test.
- Every proposal carries its full `drift` block (per-feature PSI + verdict),
  so ratification always happens with the regime context attached.

**Next (v2):** regime-change detection on the outcome side (win-rate CUSUM on
the rolling tape), confidence intervals on adjEV/t (a PROMOTE whose CI spans
zero is `insufficient-evidence`, not `insufficient-n`), and optimizer
calibration tracking — proposals scored retrospectively against what
ratifying them would have earned (the L2 arming evidence).

### 2.9.3 Configuration Governance — the Configuration Registry

The config surface is already hundreds of knobs. The registry makes it a
ledger: for every parameter — name, owner (GTPED team), default, effective
value, layer that set it (.env / config default / runtime override — the §10.6
precedence), last-changed date, reason (QTEA/commit ref), experiment tag,
rollback-safe flag. v1 is **generated, not hand-maintained**: a script walks
`config.ts`'s zod schema + `.env` + `runtime_overrides` + git blame and emits
the registry to `config_registry` (+ a drift check in CI: an undocumented new
knob fails the build). **Acceptance: zero knobs without an owner and a
reason; every fence-era question ("what was LIVE_STOP_PCT on the 27th and
why?") answerable from the ledger.**

### 2.9.4 Risk Attribution — the full tree

The §4 attribution engine extends to the complete decomposition, every
production day:

```
P&L → Selection → Sizing → Execution → Routing → Market → Infrastructure → Accounting
```

Each node has a data source already building: Selection (manifest tier
counterfactuals), Sizing (mandate audit rows vs sizer intent), Execution
(sell/buy stage clocks), Routing (best-of-N regret from `quoteBestSell`),
Market (twin-paired drift), Infrastructure (restart/RPC incident windows),
Accounting (recon deltas). **Acceptance: the daily report sums to the day's
realized P&L with a residual under 5% — an unexplained residual above that is
itself a named finding.**

### 2.9.5 The Trading Digital Twin — the third lane

```
paper (selection sensor) → DIGITAL TWIN (execution simulator) → live (capital)
```

The twin consumes the identical `decision_packet` stream and the **recorded
provider responses and RPC latencies** (captured by the execution replay
recorder — same infrastructure, §2.7), routes through the identical router
code, and books what *would* have settled — but never broadcasts. It runs in
two modes: **shadow** (real-time, alongside live — its fills vs live's fills
isolate execution error from strategy error from market error) and **replay**
(historical — the execution replay engine IS the twin in batch mode; one
system, two clocks). The twin is also the promotion proving-ground: an L2
auto-applied manifest change runs in the twin before live consumes it.
**Acceptance: twin-vs-live fill divergence <2% on matched decisions; every
execution-affecting change ships with a twin run attached (closes GTPED §5's
missing Live Canary gate without risking a dollar).**

### 2.9.6 EV Preservation Ratio — the headline KPI

```
EV Preservation = Realized EV / Expected EV        (target ≥ 90%)
   decomposed:   × Selection retention  (manifest counterfactual)
                 × Execution retention  (decision-mark → fill, stage clocks)
                 × Routing retention    (best-route regret)
```

Expected EV is stamped at decision time from the decision packet's executable
mark (the QTEA-003 valuation makes this honest — it's a sellable price, not a
feed print). Every subsystem's work now moves one number engineering can be
held to; the twin supplies the counterfactual denominator where live didn't
trade.

---

## 3. Execution-services delivery map

| Service | Domain | Status |
|---|---|---|
| `manifest.ts` — ratified selection, fail-open verdict | Selection | **live** |
| `optimizer.ts` — L1 self-optimization (rolling recompute → proposals) | Selection | **live** |
| `router.quoteValue` + PumpSwap reserve math | Valuation | **live** |
| Side-scoped breakers + protective bypass | Router | **live** |
| `quoteBestSell` parallel proceeds routing | Router | **live** |
| Sell-path stage clock on every `live_sell` | Observability | **live** |
| `manifest-watch.ts` counterfactual reporting | Governance | **live** |
| **PSI drift guard + confidence clause (MRM v1)** | Model Risk | **live** |
| Meteora/curve `quoteSellValue` | Valuation | next |
| Failure-type evidence counting (`ExecutionFailure` union end-to-end) | Protective | next |
| Transactional projection (idempotent by tx signature) | Accounting | next |
| Scope-specific TTL + `poolpeak`/backoff persistence | Persistence | next |
| ws-watch independence for live seats | Protective | next |
| `decision_packets` table + Decision ID chain (Provenance §2.9.1) | Provenance | next |
| Configuration Registry, generated + CI drift check (§2.9.3) | Config Governance | next |
| Execution replay recorder → **Digital Twin** shadow/replay (§2.9.5) | Twin / Testing | next |
| Full attribution tree + EV Preservation Ratio report (§2.9.4/6) | Attribution | next |
| MRM v2: outcome CUSUM, CI-gated verdicts, optimizer calibration | Model Risk | next |
| Contract fixtures + property tests | Testing | next |
| L2 auto-apply (bounded, demotion-only, twin-proven) | Self-optimization | after L1 calibration |

**Sequencing law (unchanged from GTPED §9):** truth → durability →
measurability → adaptivity → parity → allocation → opportunity. Nothing on the
"next" list loosens a rail; the kill switch and depth floors stay where the
operator put them.

---

## 4. The scoreboard that declares victory

One page, every morning — the **Institutional Readiness report**:

```
INSTITUTIONAL READINESS — <date>                      manifest vN · drift: <verdict>

EV Preservation        __._%   (target ≥90)   = selection × execution × routing
Execution Integrity    __._%   (stage clocks present; protective chamber-consulted)
Accounting Integrity   ___%    (chain/ledger recon, Σ legs = 0)
Decision Provenance    ___%    (positions with a resolvable decision_id)
Chain Reconciliation   ___%    (closed ⇒ chain ≤ dust)
Restart Survival       ___%    (latches, chambers, peaks across deploys)
Replay Coverage        __%     (incidents with passing twin-replay fixtures)
Provider Health        __%     (per-side breaker uptime)
Manifest Stability     __%     (terms unchanged across last N proposals)
Twin Divergence        _._%    (twin-vs-live fill delta on matched decisions)

Attribution: P&L $__ = selection $__ + sizing $__ + execution $__ + routing $__
             + market $__ + infrastructure $__ + accounting $__ (residual _._%)
Proposal pending: [deltas] · withheld by drift: [n] · Five invariants: HELD/BROKEN
```

Every line is computed, none is asserted. The attribution line is the GTPED §9
objective; the drift stamp is MRM saying whether the optimizer trusts its own
numbers today; the pending-proposal line is the crank turning itself — with
the operator's hand on the ratification lever, where it belongs. When this
page prints daily with the targets met, the platform is no longer an
institutional-grade execution stack; it is an **institutional quantitative
trading operating system** — every capital deployment explainable, replayable,
measurable, and audited end-to-end.
