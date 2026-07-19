# Trade DNA — Real-Time Health Score

## Concept
Entry is settled (the gates already qualified the trade). Post-entry, the only lever is
**time**, so every open trade needs a live **health readout** — where it sits on the genome
we sequenced (the moonshot anatomy), updated every tick, plotted on every scorecard. Green =
tracking the winner shape, ride it; rolling over past its clock = manage it out. The operator
sees each trade's health instead of trusting a fixed timer (the "held it 27m when a moonshot's
productive life is ~1000s" blind spot).

**This is a forecast/observability instrument, not a new gate and not a new exit rule.** Entry
already qualified; the trail replay proved fixed exit-rule tuning doesn't move P&L. The DNA is
the missing *management intelligence* layer — and any automated action derived from it is
replay-validated before it touches capital.

## The genome (measured anatomy — the reference bands)
From `project_hermes_moonshot_anatomy` (recorder candidate_ticks, n≈9k):
- rug median peak ≈ **220s** (3.7m); winner first-lift ≈ **190s** (3.2m); winner median peak ≈ **888s** (14.8m)
- moonshot productive horizon ≈ **1000s** (~16.7m — the TimingGrid's own window)
- winners run **clean** (median DD-before-peak 0%); deep early DD (≥40%) is the rug/give-back tell

## The strands (already recorded every tick in `position_ticks`)
The classifier (`packages/core/src/management/classifier.ts`) already fuses 6 into a 0–100
`continuation_score` + a regime. The DNA keeps these and adds the missing 7th (age/clock):

| strand | source | reads |
|---|---|---|
| new-high recency | `ticksSinceNewHigh` | runner keeps printing highs; wiggler goes cold |
| 5m momentum | `price_change_m5_pct` | velocity of rise (accel / stall / roll-over) |
| drawdown-from-peak | `drawdown_from_peak_pct` | inside winner band vs crossed into rug territory |
| buy pressure | `buy_share_m5` | demand holding vs the instant-death fade |
| volume trend | `vol_m5` vs `vol_h1` | fresh fuel vs collapse |
| survival | `mark_multiple < 1` | underwater ≠ off-peak |
| **★ moonshot clock (NEW)** | `age_minutes` vs genome | % of the ~1000s productive window elapsed |

## The state machine (user vocabulary ↔ classifier regime, calibrated to the genome)
| DNA state | classifier regime | genome condition |
|---|---|---|
| **IGNITION** | IGNITION | young (< ~220s), accelerating, high continuation — the launch window |
| **RIDE** | RUNNER | 220–900s, printing highs, DD low, buys strong — the winner shape |
| **PEAKING** | BLOWOFF | high mult, momentum stalling near peak — convex, bank into strength |
| **DECAY** | STALL | rolling over (DD into rug band) **OR past ~1000s without a proven runner** |
| **DEAD** | FADE | underwater + volume gone + buys faded — recycle the slot |

The **moonshot clock is the new modifier**: `clockPct = clamp(ageSec / 1000, 0, ∞)`. Past
`clockPct ≥ 1` a trade that is **not** a proven runner (≥3× and still near highs) tilts toward
**DECAY** regardless of a lukewarm score — this is the fix for holding 27m past prime. Proven
runners are exempt (never cap the moonshot).

**Health score (0–100)** = `continuation_score × clockHealth`, where `clockHealth` = 1.0 until
~900s then decays toward the horizon (unless proven-runner). One number, one color, per trade.

## Calibration (fit the priors to the genome — the classifier invites this)
`DEFAULT_CLASSIFIER` is explicitly "later fittable from labeled trajectories." We now have them.
Fit from the anatomy tick set, then A/B the fitted vs current priors on the same replay:
- `ignitionAgeMin` 8 → align to the genome (lift ~3.2m, IGNITION window ~0–4m before the rug-peak at 3.7m)
- `runnerMult` 3 / `blowoffMult` 8 → check against the winner peak-mult distribution
- `stallDrawdownPct` 22 → check against the winner-DD vs rug-DD separation (deep-DD = rug tell)
- **NEW knobs:** `MOONSHOT_HORIZON_SEC` (1000), `PROVEN_RUNNER_MULT` (3.0), `CLOCK_DECAY_START_SEC` (900)

## Where it plots (every scorecard)
1. **Timing grid** — recolor each bar by DNA state (IGNITION/RIDE/PEAKING/DECAY/DEAD) and draw a
   **moonshot-clock marker** on the time axis. **Recalibrate the DNA zones** from the current wrong
   `danger<150s / develop 150–300s / runner>300s` to the genome: `danger<220s / develop 220–900s /
   runner 900–1000s / past-prime>1000s`. The zones must match the anatomy, not a guess.
2. **Management board** — elevate the health readout to the primary chip per card: **state +
   health score + clock%** (the classifier `call` is already rendered — add the state label + the
   clock, so "RIDE · 78 · 40% clock" reads at a glance).
3. **Wallet trade-matrix (live)** — the same health chip per live position, so the live book shows
   each trade's DNA identically to paper.
4. **A shared legend** — the 5 states + the clock, one component reused across surfaces.

## Data path
`getManagedPositions` / `getTimingGrid` already recompute `classify(series)` per open position.
Add: (a) the moonshot-clock from `age_minutes`, (b) the fused health state + score, (c) expose
both on the view types (`ManagedPosition`, `TimingTrade`) so all three surfaces render one shared
`<TradeDNA>` component. No new query, no new tick data — it's a fusion + render layer over what
the recorder already writes.

## Management use & discipline
- **Primary value is observability** — the operator (and the live mirror) *sees* health in real
  time; the manual engage/cut channel acts on it.
- **Any automated action is replay-first.** The trail replay showed exit-*timing* changes are
  marginal (the ladder + harvest already exit decayed trades), so don't wire DECAY→auto-cut on
  faith. Candidate to test: DECAY past-clock → recycle the *slot* (paper already CUTs dead losers
  via the classifier) and/or snug the trail — validated on the recorder sequence before shipping.
- **Never cap a proven runner** — the clock exempts ≥3× near-highs, consistent with maximize-don't-minimize.

## Rollout
1. Add the moonshot-clock + fused health state/score (core + queries), render the shared
   `<TradeDNA>` on all three scorecards. Recalibrate the timing zones. *Instrument only — no
   management behavior change.*
2. Fit the classifier priors from the anatomy; A/B fitted vs current on the replay.
3. Only then, replay-test any DNA-driven management action (slot recycle / trail snug) before enabling.
