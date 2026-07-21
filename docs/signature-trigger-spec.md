# Signature Trigger — Spec

**Status:** proposed, not implemented. Nothing in the running system has been changed.
**Measured from:** `candidate_ticks` + `candidate_outcomes`, 2026-07-15 → 2026-07-21, n=11,896
candidates with ≥8 ticks. Entry simulated at the 3.0m mark; every outcome scored strictly
after the tick that produced the decision. Leak-free by construction.

## 1. The change in one sentence

The entry trigger anchors to the wrong reference point: it measures `markMultiple` against
**watch-zero**, when the predictive quantity is the rise off the candidate's own **trough** —
the low of its first false step.

For a candidate that never dipped, these are the same test: its trough *is* its reference, so
"+35% off trough" and "≥1.35× ref" admit nearly the same tokens. For a candidate that dipped,
they diverge completely — and that divergence is the population we are structurally missing.

## 2. Why (measured)

Each signature announces itself with a **false step** — an early adverse move whose depth
scales with the class — and confirms itself with the **snap** back off that low. The two legs
do different jobs, and they are separable.

Detection window = first 3.0m only. `dip = 1 − trough / pre-dip high`; `snap = mark / trough − 1`.
Outcomes scored after 3.0m. EV is realized return per $1 with the **current ladder simulated**
(TP0 1.15×40%, TP1 1.30×10%, TP2 1.58×30%, 20% runner on a 45% trail), so rugs are fully costed.

| false step | confirmation | n | EV/$ | median | % profitable | best |
|---|---|---|---|---|---|---|
| none (<10%) | limp (<+10%) | 3,012 | 1.039 | 1.000 | 84.4% | 1.9 |
| none | partial | 4,889 | 1.087 | 1.178 | 78.8% | 21.3 |
| **none** | **SNAP (≥+35%)** | **1,279** | **1.111** | **1.188** | **72.8%** | 2.7 |
| stumble 10–25% | partial | 160 | 1.105 | 1.171 | 67.5% | 3.7 |
| stumble 10–25% | **SNAP** | 143 | 1.084 | 1.191 | 65.7% | 3.0 |
| **dip 25–40%** | **SNAP** | **92** | **1.117** | **1.224** | 64.1% | 2.1 |
| slingshot 40–60% | partial | 22 | 0.838 | 0.881 | 36.4% | 1.4 |
| slingshot 40–60% | **SNAP** | 69 | 1.306 | 0.981 | 49.3% | **28.8** |
| break 60%+ | **limp** | 433 | **0.865** | 1.000 | 68.1% | 1.4 |
| break 60%+ | **SNAP** | 45 | 1.102 | 1.064 | 60.0% | 3.8 |

**The snap is the edge.** Positive EV in *every* dip band (+8.4% to +30.6%). The limp buckets
are negative or marginal, and `break + limp` is the largest avoidable loss pool in the data
(n=433, −13.5%).

**The depth is not — at this sample size.** The slingshot bucket's +30.6% rests on a single
28.8× in 69 observations: remove that one trade and EV falls to **0.90 (−10%)**. Median return
in that bucket is 0.981, below break-even, with only 49.3% profitable. It is an anecdote with
error bars, not an edge. The most *robust* bucket is `no false step + SNAP` — n=1,279, EV
+11.1%, max outcome only 2.7×, i.e. **no tail dependence at all**.

## 3. Algorithm

Evaluated per tick inside the existing watch window, on the series the recorder already passes.

```
troughMark   = min(markMultiple) over ticks so far          // the false step low
preHigh      = max(markMultiple) over ticks at/before trough
dipDepth     = 1 − troughMark / preHigh                     // classifies the signature
snapPct      = last.markMultiple / troughMark − 1           // confirms it
```

Gate, in addition to every existing condition:

```
if (snapPct < CONFIRM_MIN_SNAP) reject("no snap off the low")
```

and the drawdown ceiling becomes conditional, because for a snapped candidate the dip **is**
the signal:

```
ddCeiling = snapPct >= CONFIRM_MIN_SNAP ? CONFIRM_MAX_DD_SNAPPED : CONFIRM_MAX_DD_PCT
if (last.drawdownFromPeakPct > ddCeiling) reject(...)
```

This is required, not cosmetic. A candidate that broke 60%+ and snapped back still carries
~46% drawdown-from-peak at its qualifying tick, so today's `CONFIRM_MAX_DD_PCT = 40`
**hard-rejects the highest-5× cohort in the dataset** (11.9%, versus 3.0% for the current gate).

`CONFIRM_MIN_MULT` drops from 1.35 to a not-underwater floor (1.00). The 1.35 bar was doing the
snap's job from the wrong anchor; keeping both would re-exclude every dipped candidate and
make the change a no-op.

## 4. New config knobs

| knob | default | rationale |
|---|---|---|
| `CONFIRM_MIN_SNAP` | `0.35` | Bucket boundary from the EV table. **Chosen for readable buckets, not fitted** — see §7. |
| `CONFIRM_MAX_DD_SNAPPED` | `70` | Admits the break+SNAP cohort (~46% dd at entry) while still refusing the 80%+ dead zone. |
| `CONFIRM_DEEP_DIP_PCT` | `0.40` | Boundary above which sizing is experimental. |
| `CONFIRM_DEEP_DIP_SIZE_MULT` | `0.40` | Size multiplier for deep-break entries — see §5. |
| `CONFIRM_MIN_MULT` | `1.35 → 1.00` | Re-anchored; the snap replaces it. |

## 5. Sizing — flat, with one experimental carve-out

EV is statistically indistinguishable across the robust bands (+8.4% to +11.7%), so **size flat
across dip depth up to 40%.** Do not scale size with dip depth; the data does not support it.

Above 40%, size at `CONFIRM_DEEP_DIP_SIZE_MULT` (0.40×). This is an explicit experimental
allocation to grow the sample, *not* a conviction bet — its apparent edge is one trade, and it
carries 37–55% rug rates. Revisit when the deep bands reach three figures.

## 6. What does NOT change

- **The watch window stays 2–3m.** Measured against 2–5m, 2–8m and 1.7–12m, the current window
  wins on every quality metric (rug 18.7% vs 28.1%; doubles 28.4% vs 12.9%). We see only 36% of
  climbers and 9.5% of risers, but reaching the rest later means buying the same names with
  less runway — a climber caught at 8m has six minutes to its 14m peak instead of eleven.
  **The edge is selection inside the window, not more time.**
- Buy-share floor, dead-zone veto and its pool-growth exemption, volume acceleration, the
  vertical-spike ceiling, and the CUT guard all stand unchanged.
- The exit ladder and trail are **out of scope** for this spec. They are separately and badly
  miscalibrated (winning climbers dip to 0.37× of entry and give back 34.6% before their real
  high, against a 5% stop and 5% tight trail) and need their own spec and their own EV pass.

## 7. Risks and unfitted parameters

- **Thresholds are picked, not fitted.** `0.35` snap and the 3.0m detection window were chosen
  to produce readable buckets. Both should be swept before they are treated as settings.
- **Deep bands are thin.** n=69 and n=45, with 37.7% and 54.8% rug rates. §5 sizes for this.
- **The EV model is optimistic.** TP rungs are assumed to fill *at* the rung price with no
  slippage or fees. Applied identically to every bucket, so bucket-to-bucket comparison holds,
  but **+11% is a ceiling, not a forecast.**
- **Simulated edge vs realized loss.** The live lane lost $31.93 on 2026-07-20 against a
  simulated +11%. That gap is execution and selection, and it is unexplained.
- **BLOCKING for live:** the mirror computes exit triggers against *paper's* entry price, not
  live's. Live TP0 fills at a 1.019× median against paper's 1.154× with **zero** slippage
  refusals — the loss is upstream of execution. Per-signature entry logic cannot be trusted in
  the live lane until this is found. Paper is unaffected.

## 8. Rollout

1. **Shadow-log only.** Compute `dipDepth` / `snapPct` on every candidate and persist them with
   the would-have-fired decision. No behavior change. Confirms the buckets reproduce forward.
2. **Paper.** Enable the gate in paper alone. Compare realized return per dollar against the
   measured EV — this is where the optimistic fill assumption gets its reality check.
3. **Live.** Only after (a) paper reproduces the edge and (b) the basis mismatch in §7 is fixed.
