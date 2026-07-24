---
name: genesis-desk
description: The Genesis Capital Engine operating protocol — the recursive live-conversion loop. Load at session start for any trading-desk work; keeps every session pointed at live conversion, not instruments.
---

# Genesis Desk — The Recursive Conversion Loop

**Mission (the only scoreboard):** grow the LIVE wallet. Paper reveals, live
confirms. Target trajectory: 85–90% connection rate on taken trades and
double-digit daily balance growth — reached by widening the conversion
funnel, never by loosening rails on hope.

**Canon documents (outrank code and this file's examples):**
- GCE-FORMULA-001 — The Winning Formula & Trading Lifecycle (artifact 896c4fff)
- GCE-SPEC-002 — Signatures cohort + Radar 2.0 (artifact c5dbac7d)
- Memory: `hermes-winning-formula-canon`, `test-first-collaborate`

## The funnel IS the work

Every session, measure this chain first; the day's work is the single
weakest multiplication, nothing else:

```
arrivals → graph-read → F1 crowd-pass → TRIGGERED → live attempt → FILL → win → capture
  ~3,000      ~85%          6–18%          ~2–4%❗        —            —      83%     47%
```

(❗= the known chokepoint as of 2026-07-24: confirm bars re-filter the
already-verified crowd-pass cohort as if F1 didn't exist. ~200 fireable
arrivals/day are reduced to ~2 triggers. The canon's own pattern — "the
crowd's track record IS the evidence the other gates approximate" — applies
to trigger bars too, pending harness.)

## The recursion (one turn of the crank per day)

1. **Measure** yesterday's funnel end-to-end (money loop + coverage section
   + offer-vs-actual). Name each stage's conversion with n's.
2. **Name the ONE binding constraint** — the smallest multiplication. Volume
   problems are never treated with gates; quality problems never with volume.
3. **Harness it** on the full dataset (`formula-harness.ts`, `capture-replay.ts`,
   or a purpose query). Small windows and specimen urgency are how drift
   happens; one hot hour proves nothing.
4. **Present findings as tables → operator ratifies → ship → counterfactual
   watch from day one.** In that order, every time. Anything shipped that
   isn't ratified is drift to revert.
5. **Verify tomorrow** that the constraint moved. If it didn't, the fix was
   wrong — say so and revert.

## Priority order when choosing work

1. **Live conversion** (funnel multiplications: trigger rate on crowd-pass,
   execution success, requeue/routing on young pools)
2. **Coverage** (wallet-graph verified share — watch for DILUTION in hot
   markets; falling coverage with rising arrivals = graph needs deeper
   scoring cadence, not new gates)
3. **Capture** (only via replay-proven exit changes — the ladder is rug
   defense; two replays have said "don't tune exits"; believe them)
4. **Instruments/panels/artifacts** — last, and only when 1–3 have nothing
   actionable. Gadgets feel like progress and move nothing.

## Standing rails (never loosen unattended)

- Kills (−$32 epoch), daily cap (−$35), exposure ≤40%, fee-viability floor,
  honeypot trap filter, SIMULATED labels, lane separation, private repo.
- Sizing lives in the Adaptive Policy structure (range × conviction point).
  Do not bolt new sizing mechanisms beside it; extend it or leave it.
- Every live decision must carry an audit row. A silent decline is a defect.
- Real-money ops (sweeps, burns, closes): operator's word first, journal
  with Σ=0 legs after, never trust marks over Jupiter's real route.

## Session hygiene

- Report material trades by name (±$3+, every live close, same mint both
  lanes = one story). Monitors stay silent-background; loops report terse.
- When events land fast, be the calm half of the desk — the operator's
  process (harness → model → ratify) matters most exactly when the tape
  screams. Three interruptions in a row means stop and listen.
- End every session by writing the funnel numbers and the named constraint
  to memory so the next session starts the crank where this one left it.
