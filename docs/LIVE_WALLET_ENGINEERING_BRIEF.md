# ENGINEERING BRIEF — LIVE WALLET UNDERPERFORMANCE

**Date 2026-07-31 · commit `604ce4e` · for external engineering review**

Read alongside `docs/LIVE_WALLET_ENGINEERING.md` (the system spec) and the
CSV extracts in `audit-dump/`.

---

## 1. THE PROBLEM IN ONE TABLE

Two lanes run the same strategy against the same market. `paper` is a
simulation; `live` is real capital. Seven days, closed positions:

| | n | deployed | P&L | **return on deployed** | win% | avg peak× | avg exit× | median hold | total-loss% |
|---|---|---|---|---|---|---|---|---|---|
| **paper** | 2,025 | $11,252 | **+$569.94** | **+5.07%** | 60% | 1.65 | 1.016 | 119s | 13% |
| **live** | 222 | $581 | **−$94.43** | **−16.25%** | 46% | 1.19 | 0.931 | **47s** | 17% |

**A 21-point swing in return on deployed capital, same strategy, same market,
same window.** That gap is what you are being asked to explain.

---

## 2. WHAT WE HAVE ALREADY RULED OUT

Do not re-litigate these; the data is in the dump if you want to check them.

### 2.1 It is not entry selection
Live's entries are **equal or better** on every entry-knowable feature
(7d, n=224 live / 1,813 paper):

| | live | paper |
|---|---|---|
| avg inflow at trigger | 1.195 | 1.211 |
| avg trigger multiple | 1.42 | 1.46 |
| **avg buy share** | **70.6%** | 64.6% |
| **avg modelled rug prob** | **0.242** | 0.317 |

### 2.2 It is not entry price, and it is not hold duration
The **paired control** — 214 positions where *both lanes bought the same mint*
(`audit-dump/01_paired_trades.csv`):

| | live | paper |
|---|---|---|
| entry price ratio | **1.015×** (live pays 1.5% more) | — |
| mean hold | **189s** | **185s** |
| peak from entry | **1.20** | **1.38** |
| return | **−15.6%** | **−7.9%** |

Same token, same entry price, matched mean hold — and live still returns
7.7 points worse with a 15% lower recorded peak.

### 2.3 The known-execution defects are fixed but UNPROVEN
Seventeen commits shipped 2026-07-31 (§9 of the spec). Four touched this
directly: the pre-signed exit now fires *before* the quote; `user_cut` /
`runner_timeout` are now classified protective; depth is read from the live
route rather than a lagging aggregator; the guard loop values the book in
parallel (marks went from ~8s to ~2s old).

**None of these has executed a single live protective exit.** Treat them as
untested.

---

## 3. THE THREE CANDIDATE EXPLANATIONS

We have not been able to separate these and that is the ask.

### H1 — Live exits earlier than paper on the same position
Mean hold matches (189 vs 185s) but the **median does not: 47s vs 119s**.
Live has a much heavier tail of very short holds. If live is cutting early,
the lower recorded peak (1.20 vs 1.38) is *caused by* the early exit rather
than being evidence of a worse token.

### H2 — Live's recorded peak is a sampling artifact, not a real difference
Peak is recorded from observations while the position is held. Paper marks
from a batched feed every ~2s. Live marked from a serial loop at ~8s until
today. **Live may simply have missed peaks paper saw on the identical token.**
If true, part of the "capture gap" is measurement, and any harness built on
live's recorded peak is biased.

### H3 — Live's fills are worse than its own quotes
A 6h sample showed live filling at **0.484** of its own sell quote vs paper's
0.948 — **but n=7, and three of those were LP pulls where $0.00 was the true
market price.** The 7-day average exit multiple is much closer (0.931 vs
1.016), so this is unresolved and probably over-stated.

**These are not mutually exclusive and they interact.** H2 would corrupt the
evidence for H1.

---

## 4. WHAT WE WANT FROM YOU

1. **Separate H1/H2/H3.** The paired dataset plus the raw market tape
   (`04_market_tape_paired.csv`, tick-level price + liquidity for every mint
   live traded) should let you reconstruct what each lane *could* have seen and
   what it *did* see, independent of our instrumentation.
2. **Tell us whether our recorded peaks are trustworthy.** If live's peak is
   under-sampled, say so — several of our conclusions depend on it.
3. **Audit the exit path** (`§4–5` of the spec) for anything that closes a
   position earlier on live than the shared `decideExit` would dictate. The
   live guard has its own rules gated `!genomeOwned`; verify that gating
   actually holds.
4. **Sanity-check the rails against the arithmetic.** See §5 below — we have
   one active defect where the position sizer produces a ticket below its own
   fee floor, causing silent skips.

---

## 5. ACTIVE DEFECTS WE ALREADY KNOW ABOUT

Full list in §8 of the spec. The one that matters today:

**The slot no longer clears its own fee floor.** Spec is "4 positions at $2.50
= 5% of balance", which is only self-consistent at equity ≥ $200.

```
equity $183.82 × 5% ÷ 4 slots = $2.30   ← below the $2.50 fee-viability floor
× daily throttle (−$22.98 of a −$35 cap) = $1.39
```

Only PRECISION and sub-floor entries are rescued *to* $2.50; everything else
**skips**. Proposed fix `slot = max(feeFloor, balance × agg ÷ slots)`, not yet
applied so this document matches the shipped code.

Also relevant to any analysis you do:

- **Paper's fill model is optimistic on the death cohort.** `convexSlippagePct`
  is depth-aware (`liq ≤ 0 ⇒ 99%`) but reads liquidity from DexScreener, which
  lags an LP pull. Paper books orderly exits on positions live cannot exit at
  all. **Paper is a valid model of selection and management, not of rug-class
  outcomes.** Some of the 21-point gap is a cost live pays and paper never books.
- **Config precedence is `.env` > code default.** Two knobs have misleading
  defaults (`LIVE_PRESIGNED_EXITS` default `false`, actually `true`;
  `LIVE_MIN_POSITION_USD` default 3.50, actually 2.50). §7 of the spec has the
  verified effective table.

---

## 6. THE DATA DUMP — `audit-dump/`

| file | rows | contents |
|---|---|---|
| `01_paired_trades.csv` | 214 | **the control.** Same mint both lanes: entry lag, entry price ratio, hold, peak, exit, exit reason, P&L for each lane, plus the token's true peak and entry features |
| `02_live_positions.csv` | 303 | every live position, 10d: full anatomy + entry features + rung counts + the token's true peak and final multiple |
| `03_live_refusals.csv` | 1,814 | every live refusal with its reason **and what the token went on to do** — the opportunity cost of each gate |
| `04_market_tape_paired.csv` | 12,235 | tick-level price + liquidity for every mint live traded in 3d — the ground truth both lanes were reading |
| `05_lane_summary.csv` | 2 | the §1 table, reproducible |

Column semantics:
- `*_peak_x`, `*_exit_x` are multiples of that lane's **own entry price**.
- `token_true_peak` is from `candidate_outcomes`, measured on the token
  independently of whether either lane held it — this is the honest denominator.
- `live_entry_vs_paper` > 1 means live paid more than paper for the same token.
- `live_entry_lag_s` is seconds between paper's fill and live's fill.

---

## 7. GROUND RULES FOR CONCLUSIONS

The operator's standing requirements, and they have caught real errors:

1. **Entry-knowable features only** when proposing an entry gate. We have
   previously fooled ourselves with post-hoc features (`peak_liquidity_usd`
   looked highly predictive; it is measured after the fact and the effect
   vanished at the trigger tick).
2. **Report total EV retained, not per-trade EV.** A filter that doubles
   quality while keeping 20% of the flow is usually a loss. Several apparently
   obvious gates destroy 40–64% of the class's expected value.
3. **Do not bring an under-powered sample to defend an existing rail.** The
   burden is on the rail.
4. **Every live decision must carry an audit row.** A silent decline is a
   defect, not a design.
