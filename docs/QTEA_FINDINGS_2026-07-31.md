# QTEA FINDINGS — 2026-07-31

Response to the external audit. Four of the seven phases answered with
production data. Every finding carries n and a confidence statement.

**Auditor's thesis — execution architecture, not alpha — is supported, with
one correction: the entry stack is also leaking, and it is leaking more.**

---

## PHASE 1 — Capital Allocation · **DEFECT CONFIRMED**

The auditor's read was sharper than ours. We called §8.1 "silent skips"; it is
an **invisible portfolio bias.**

`183.82 × 0.05 ÷ 4 = $2.30` against a `$2.50` floor. PRECISION entries are
rescued *to* $2.50; everything else skips. What that actually selects:

| cohort | n | 2× | 5× | **dud** | avg peak | tail |
|---|---|---|---|---|---|---|
| RESCUED to $2.50 (PRECISION) | 157 | 63% | 17% | **15%** | 3.57 | 369 |
| **SKIPPED sub-viable** | 15 | **80%** | **20%** | **7%** | **4.29** | 48 |

**We fund the worse cohort and skip the better one.** PRECISION requires
in-envelope inflow and excludes RUG_RISK — it *is* the safe cohort. A sizing
arithmetic accident became a systematic bias toward safety.

`CONFIDENCE` — n=15 skipped. Direction unambiguous, magnitude not.
`FIX` — `slot = max(feeFloor, balance × agg ÷ slots)`. Not yet applied.

---

## PHASE 2 — Entry Engine · **SYSTEMIC DEFECT**

The confusion matrix the auditor asked for. 7d, live-eligible.
Correct skip = refused a dud (<1.5×). False skip = refused a 2×+.

| gate | refused | correct | **false** | dud:moon | tail refused |
|---|---|---|---|---|---|
| inflow below band | 99 | 32% | 45% | **0.71** | 314 |
| RUG_RISK class | 590 | 21% | 45% | 0.48 | 916 |
| MOON_STEADY regime | 38 | 13% | 55% | 0.24 | 280 |
| pool depth floor | 156 | 13% | 65% | 0.20 | **2,682** |
| inflow below floor | 81 | 9% | 70% | 0.12 | 282 |
| build-back mode | 69 | 7% | 75% | 0.10 | 327 |
| RECOVERED (all venues) | 75 | 7% | 72% | 0.09 | 236 |
| live_kill engaged | 190 | 6% | 80% | 0.08 | 659 |
| pool depth (smart-money) | 73 | 4% | 74% | 0.06 | 1,083 |
| RECOVERED meteora-damm-v2 | 74 | 4% | 82% | 0.05 | 362 |
| clone wave | 49 | 4% | 82% | 0.05 | 190 |
| **trigger sensor slice** | 90 | **0%** | **97%** | **0.00** | 977 |
| **trigger declined @strong** | 29 | **0%** | **100%** | **0.00** | 262 |
| RUG_RISK plug-in list | 33 | 0% | 76% | 0.00 | 113 |

**NOT ONE GATE EXCEEDS 1.0.** The best refuses 1.4 moons per dud. Two refuse
at 97% and 100% false-skip with **zero** correct skips. Aggregate tail refused
across the stack: **~8,683**.

The entry stack does not discriminate duds from moons. It discriminates
**flow from no-flow**.

`CONFIDENCE` — well powered (n=25–590 per gate). ⚠️ Late-stage gates see a
pre-filtered population, so ratios are not directly comparable across rows.
⚠️ A "false skip" is not automatically wrong: the depth floors guard
*exitability*, which Phase 3 shows is a real constraint.

---

## PHASE 4 — Router · **LATENCY ASYMMETRY CONFIRMED**

| provider | fills | land ms | quote ms | **total ms** |
|---|---|---|---|---|
| pumpswap | 39 | 4,922 | **77** | **7,817** |
| jupiter-hosted | 38 | 6,972 | **377** | **10,761** |

Jupiter is **5× slower to quote** and **38% slower end-to-end** — ~2.9 seconds
per trade. The auditor asked whether one provider dominates latency; it does.

`CONFIDENCE` — n=77 fills, evenly split. Solid.
⚠️ Not necessarily a defect: Jupiter routes pools PumpSwap cannot. The question
is whether we should *prefer* PumpSwap when both can serve.

---

## PHASE 5 — Sniper Forensics · **ROOT CAUSE FOUND**

The 37% was two distinct failures, not one:

| outcome | positions |
|---|---|
| chambered | **39** |
| fired | 13 (33%) |
| fell back (chamber missed) | 16 (41%) |
| **chambered and NEVER CONSULTED** | **11 (28%)** |

The 11 never reached the sniper hook at all — their exit reason was not
classified protective. `user_cut` and `runner_timeout` were absent from the
`isProtective` predicate until commit `c1cf66f` today, so a signed round sat
unused while the position reverted three times and was written off.

`CONFIDENCE` — n=39 chambers. The 11-never-consulted has a named mechanism and
a shipped fix; the 16 fallbacks do not yet — they need per-miss reason logging.

---

## WHAT THE AUDITOR GOT RIGHT THAT WE MISSED

1. **§8.1 is a portfolio bias, not a skip bug.** Reframing it as a distribution
   effect made it measurable — Phase 1 exists because of that sentence.
2. **"At what stage does EV leak"** is the correct question. Asking "why did we
   lose" produced six hours of single-trade forensics today.
3. **The sniper deserved forensic decomposition.** 37% looked like one number;
   it is 33% fired / 41% missed / 28% never asked — three different fixes.

## WHERE WE'D EXTEND THE AUDITOR'S THESIS

The thesis is *execution architecture, not alpha*. Phase 2 says the entry stack
is leaking **~8,683 of tail mass** with no gate achieving positive
discrimination. That is larger than the measured execution leak.

**Both are true and they interact**: the depth floors — the single largest tail
refuser at 3,765 combined — exist *because* exits are unreliable. Opening them
before execution is proven would convert refused upside into realised losses.

**Correct sequence: fix execution first, then open the gates it was protecting
us from.** That ordering falls directly out of the auditor's framework, and it
is the opposite of what we would have done on intuition.

---

## OPEN — NOT YET ANSWERED

- **Phase 3 (Exit Engine timing)** — blocked. Sell-path latency is not
  instrumented (GTPED §7 P4). The 8s mark age was *inferred*. This is backlog
  item #2 and it gates real exit forensics.
- **Phase 6 (State Machine)** — diagnosed, not fixed. Seven module-level Maps;
  measured cost is the 37% sniper rate. Backlog #1.
- **Phase 7 (Attribution)** — not built. Decision/Execution/Network alpha
  decomposition requires Phase 3's timestamps first.
