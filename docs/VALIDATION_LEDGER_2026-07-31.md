# VALIDATION LEDGER — 2026-07-31

Operator: *"You were not validating data or engineering mechanics before
fixing and it cost us the entire day."*

Correct. This is the per-change audit. **Measuring a problem is not validating
a fix**, and I repeatedly reported the first as if it were the second.

Legend:
- **V** — the FIX was validated before or immediately after shipping
- **M** — the PROBLEM was measured; the FIX was not validated
- **R** — shipped on REASONING alone
- **D** — introduced a defect
- **X** — did not actually take effect

---

## The ledger

| commit | change | status | what evidence actually existed |
|---|---|---|---|
| `d999546` | exit latch | **M** | traced FLAPDOGE (real specimen); fix never replayed |
| `c4bbed1` | MOON_STEADY/SLOW admitted | **M** | tail-mass measured (8,057); outcome never validated |
| `3d2e41d` | pool ownership | **D** | harnessed — **on summed P&L, the wrong metric**. Caused the profit-lock regression the operator caught in production |
| `53c1b98` | profit-lock restore | **M** | reactive fix to my own regression; capture-harness built *after* |
| `e93e906` | ladder E | **V** | `tp-ladder.ts`, 2,406 positions, 9 variants |
| `7933b1e` | basket bar scaled | **M** | problem measured (344% of book); new bar never validated |
| `a9bcdd8` | admission 1.25 | **X** | **`.env` pin overrode it. Reported as shipped. It was not.** |
| `ec47217` | Control Terminal | **V** | computed $2.87 against actual $2.86/$2.87/$2.88 fills |
| `5676fbe` | sniper before quote | **R** | pure reasoning. No replay, no before/after |
| `4c958cb` | basket anchor + qty guard | **M/R** | anchor measured (23 fills); guard was advisor-caught reasoning |
| `782b4a4` | live basket 4×$2.50 | **D** | arithmetic correct at $200; **created the sub-floor skip defect at $183** |
| `8d479a9` | pool feed freshness | **M** | staleness measured (7% >60s); fix unvalidated |
| `c1cf66f` | user_cut/runner_timeout protective | **M** | traced BingBing (real specimen); fix never replayed |
| `3e5cd1a` | RUG_RISK admitted | **M** | 811 positions measured; outcome unvalidated |
| `51ee3bd` | depth from route | **R** | reasoning + an arithmetic sanity check. No live evidence |
| `28eb13b` | seat 2.05 | **M** | 536 candidates, 0% duds — strong measurement, outcome unvalidated |
| `604ce4e` | parallel guard | **M** | 8s vs 2s measured; fix unvalidated |
| `ba2dbf3` | persist state | **V** | functional round-trip against the live DB |

**Tally: 3 validated · 11 measured-but-unvalidated · 2 reasoning-only ·
2 defect-introducing · 1 that never took effect.**

---

## The structural cause, which is worse than the individual lapses

Every replay harness in `packages/db/replays/` runs on **paper data**.

Today's own finding (`LIVE_WALLET_ENGINEERING.md` §8.6): paper's fill model
reads liquidity from DexScreener, which lags an LP pull, so **paper books
orderly exits on positions live cannot exit at all.**

Therefore: **the substrate I validate against is biased for precisely the
failure mode that is killing the live wallet.** A fix can pass every harness we
own and still be wrong on live. That is not a discipline failure — it is a
missing capability, and it is why "validated" has meant less than it sounded.

The operator's stated goal — *a real-world model that functions positively,
independent of a paper lane* — cannot be reached with a paper-only validation
substrate.

---

## What must exist before more code ships

### 1. Live-receipt replay (the missing capability)
We already hold everything needed to replay what live ACTUALLY did:

| source | contains |
|---|---|
| `audit_log` | every decision, gate, quote, refusal, with timestamps |
| `fills` | tx signature, real qty, real fill price, real fee |
| `candidate_ticks` | tick-level price + liquidity — the true tape |
| `positions` | entry, peak, exit, reason |

A live-receipt replay reconstructs each live trade from its own receipts and
answers: **given the same tape, would the changed code have produced a
different fill?** No paper marks anywhere in the loop.

That is the only instrument that can validate an execution change honestly, and
it is GTPED §5's Replay-Before-Repair rule made real.

### 2. Back-validate what is already in production
Eleven changes are live on measured problems and unvalidated fixes. Two shipped
on reasoning alone. Those two — `5676fbe` (sniper ordering) and `51ee3bd`
(depth from route) — are the ones I would put first through the replay, because
they touch the exit path and neither has any evidence behind it.

### 3. Then instrument
Sell-path telemetry (backlog #2) is still the right next build. It should not
go in ahead of the validation capability, because it would produce more numbers
of the same kind we have been mis-using.

---

## The rule this ledger establishes

> **Measuring a problem is not validating a fix.**
> A change ships with evidence that the CHANGE improves the outcome, on a
> substrate that models the failure mode being fixed — or it ships labelled
> `UNVALIDATED` and is listed here until it is.

No change goes to production described as anything stronger than what this
table can support.
