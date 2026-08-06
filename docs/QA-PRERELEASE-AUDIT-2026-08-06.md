# QA PRE-RELEASE AUDIT — Live Wallet Sample Run

**Prepared:** 2026-08-06 · **Branch:** `main` @ `bd4a0a2` · **Suite:** 57/57 green
**Decision requested:** approve (or block) a **10-seat live sample run** whose
only purpose is to audit the execution and capture pipeline with real capital.
**Current state:** live kill **ENGAGED** by operator; paper lane running the
same admission policy; book flat.

> Reviewer's mandate: assume nothing in this document is true until you have
> run the verification commands in §7. Two defects in the last 24h were
> **inert configuration** — data written, no code reading it — including one
> the author introduced while claiming the opposite. Verify enforcement, not
> intent.

---

## 1. What changed since the last audit (`aa5cd43`)

| Commit | Change | Class |
|---|---|---|
| `6975a8a` | **Quote-depth pool selection** — decoy-pool trap closed | P0 correctness |
| `3b016f4` `4080b3b` `dbb0891` | Three drizzle binding bugs (`ANY(array)`, bound `Date`, `make_interval(days=>$n)`) | P0 silent-failure |
| `e1f46dd` `594d046` | Market Truth Engine + look-ahead invariant | Architecture |
| `8e8017c` | F2 high-water rung evaluation (capture fix) | Capture |
| `dd66fa8` | Every replay court decontaminated | Evidence integrity |
| `1ff0bed` `6c7d244` | Instant-death autopsy → admission court | Selection |
| `9d4d837` `bd4a0a2` | Admission policy shipped both lanes + enforcement | Selection |

---

## 2. The finding that reframed the project

Capture was assumed to be a trade-manager defect. It is not.

```
24h paper, decomposed by whether the market OFFERED anything
  trades that offered (peak >= 1.15x)   n=125   offered $2,211   captured +$714   = 32.3%
  trades that never offered             n=102   offered   $123   captured -$890   =  n/a
  blended                                                                          = -7.6%
```

**On trades that offer, the manager already captures 32.3%** — inside the
20–40% target band. The blended number was dragged negative by a cohort that
never rose (avg peak 1.05x, dead in ~48s). Six exit courts had already
rejected exit-policy changes; this decomposition explains why they were right.

**The entry-knowable signature** (`instant-death-court.ts`, 1,650 closes,
38% baseline death rate):

| Cohort | n | dead % | ev/trade |
|---|---:|---:|---:|
| unrouted (no signature) | 361 | **54%** | +$0.05 |
| meteora-dbc | 316 | 47% | −$0.59 |
| pool < $5k at entry | 311 | 47% | −$0.59 |
| crowd R≥W (rug history) | 67 | **51%** | −$1.17 |
| crowd 0W/0R (unknown) | 398 | 44% | −$0.45 |
| *(contrast)* buy share ≥70% | 396 | 30% | **+$2.76** |

Every "unmeasured feature" cell is the **same 361 unrouted trades** — no
signature means no measurements at all.

---

## 3. The admission policy and its court

`admission-court.ts`, 1,652 paper closes / 7d, both-halves bar:

| policy | seats | 1st half | 2nd half | total | capture | ev/t |
|---|---:|---:|---:|---:|---:|---:|
| INCUMBENT (take all) | 1652 | +$856.82 | +$258.81 | +$1,115.63 | 7.4% | +$0.68 |
| R1+R2 | 1118 | +$896.21 | +$412.29 | +$1,308.50 | 12.8% | +$1.17 ✅ |
| R1+R2+R3+R4 | 1069 | +$905.58 | +$474.15 | +$1,379.72 | 13.7% | +$1.29 ✅ |
| **ALL R1–R5** | 864 | +$925.60 | +$637.07 | **+$1,562.68** | **16.3%** | **+$1.81** ✅ |

First gate to clear the bar in seven courts. **Live's actual manifest v5
policy replayed on the same tape: 52 seats · +$327.57 · capture 26.0% ·
+$6.30/trade** — better than the court cohort because v5 stacks the R-terms
*plus* genome allowlist, inflow band, buy-share floor and F6.

**Reviewer challenge points:** (a) v5's 52 seats is a thin sample — is 26%
credible or a small-n artifact? (b) the court is in-sample on the tape that
generated the hypothesis; out-of-sample evidence is the sample run itself.
(c) `capture %` denominator = tape high-water within the trusted liquidity
band — argue with that definition if you disagree with it.

---

## 4. The decoy-pool defect (read this one closely)

Position #8165 (DORAE) booked **+$47,421.58 on a $6.73 seat** — a 7,104x
"exit". Chain validation:

```
same mint, three pools (DexScreener):
  pumpswap  px $0.0001239  liq    $24,389  fdv    $122,074   <- real
  meteora   px $0.1522     liq $91,360,362 fdv $149,944,232  <- what we used
    composition: 600,070,580 DORAE vs 0.02717 SOL (~$5), ZERO trades ever
```

A Meteora DLMM permits single-sided liquidity in any price bin. DexScreener
values the tokens **at that fake bin price**, so "liquidity" and "FDV" are
derived FROM the price and cannot validate it. Our selector took the pool
with the highest reported liquidity — an adversarial invitation costing the
deployer ~$5.

**Fix (`6975a8a`):** selection now ranks by **quote-side depth** (the asset a
pool must actually pay us in), minimum $500 credible.
**Blast radius:** 96,494 phantom ticks across 474 mints, 11 of 14 days.
**Live exposure: ZERO** — the live lane prices exits through
`swapRouter.quoteValue` (executable quotes), never aggregator marks.
**Ledger:** #8165 restated to +$0.89 at the chain-verified clean price under
the documented `hermes.unlock` escape; the immutable sell fill retains the
corrupt price; audit row `ledger_correction` records both.
**Courts re-run clean:** every governance verdict held (manifest v3 still
beat the gate stack; the Winner Queue still failed promotion).

---

## 5. Known-inert-config risk (the pattern to hunt)

Four defects this session shared one shape: **feature armed, code not reading
it, failure swallowed by a fail-open catch.**

1. `ANY(${array})` — 1,571 silent truth-engine skips
2. bound `Date` in `sql` — F2 window query inert
3. `make_interval(days => $n)` — optimizer dead, gate-#2 clock at zero
4. `poolMinUsd` / `refuseUnknownCrowd` — written to manifest v5, **no verdict
   code read them** until `bd4a0a2` (caught by the operator asking for
   end-to-end confirmation)

**Reviewer request:** grep for other config keys with no consuming code path.
A pass-health counter (N consecutive failures → audit row + push) is
specified but **not yet built** — treat that as an open P1.

---

## 6. Live pipeline as coded (verify each claim)

| Stage | Mechanism | File |
|---|---|---|
| Selection | manifest v5 verdict, all five R-terms + genome/inflow/buy-share/F6 | `live/manifest.ts` `tierRefusal()` |
| Solvency | kill, daily cap, concurrency, exposure, SOL reserve — **outside** the strategy wraps (test-pinned) | `live/executor.ts` |
| Exit certification | mark ✓ quote ✓ build ✓ against the live tape | `src/tools/sell-certify.ts` |
| Valuation | best-of executable marks (aggregator + reserve math) | `live/swap/router.ts` `quoteValue()` |
| Protective exit | pre-signed durable-nonce chamber, fires before any quote | `live/presigned.ts` |
| Floor | cost-basis floor priced from the executable mark; fail-open only when nothing can value | `live/executor.ts` |
| Telemetry | every sell writes class, tolerance, provider, landMs, stage clock | `live/executor.ts` |
| Governance | hourly optimizer (own process), PSI drift gates proposals only | `live/optimizer.ts` |

---

## 7. Verification commands (run before approving)

```bash
pnpm --filter @hermes/trader typecheck && pnpm --filter @hermes/trader test   # expect 57/57
npx tsx services/trader/src/tools/sell-certify.ts        # live-tape exit certification
npx tsx packages/db/replays/admission-court.ts 7         # the policy's own court
npx tsx packages/db/replays/instant-death-court.ts 7     # the entry-knowable autopsy
npx tsx packages/db/replays/wealth-curve.ts              # promotion standard, decontaminated
```

Reconciliation queries (books vs chain) are in `.claude/skills/qtea/SKILL.md`.

---

## 8. Proposed sample run — scope and stop conditions

**Scope:** 10 live seats maximum, $2.50–3.75 tickets (~$30 total exposure),
4 concurrent slots, manifest v5 selection, kill cleared by operator only.

**Judged on three things, nothing else:**
1. **Capture %** vs the 26.0% the tape predicts for this policy
2. **Zero unsellables** through the doors
3. **Every red floor-bounded** (no −100% of ticket outside a liquidity removal)

**Abort immediately if:** two unsellables occur · any red exceeds the floor
without an LP-removal explanation · sell-path stage clocks show >5s
decision-to-fill on a protective exit · chain/ledger mismatch appears.

**Expected duration:** manifest v5 admits ~7 seats/day, so ~1.5 days of tape.

**Known limitations, stated:** F2 high-water has **never fired** (`0` rung
arms since deployment) — the capture fix is installed and test-pinned but
unproven in production. Live all-time is **−$273.67 over 452 trades**, all
pre-dating this architecture. The stack currently runs on an operator laptop
with hand-rolled process management; the migration spec
(`SPEC-INFRASTRUCTURE-MIGRATION.md`) is written but not executed, and three
operational outages in 72h trace to that arrangement.
