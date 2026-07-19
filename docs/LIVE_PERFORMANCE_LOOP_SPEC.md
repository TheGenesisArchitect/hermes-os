# Live Performance Loop — Tech Spec

Status: **DRAFT for review** (design; implement after sign-off)
Author: Hermes OS · 2026-07-17
North star: **a compelling live equity curve to share with the investor team by 5:30pm EST.**

---

## 0. Objective, and what "compelling" actually means

The Loop's job is to **maximize the probability of a compelling live equity curve** over the
trading window ending 5:30pm EST — by concentrating real capital on the highest-conviction setups
our validated models identify, sizing into conviction, cutting losers fast, and standing down when
the regime is hostile.

"Compelling" is defined so we optimize the right thing (P&L alone is not enough — investors read
the *shape*):

| Property | Target | Why it matters to an investor |
|---|---|---|
| Slope | Net **up** over the window | The headline |
| Max drawdown | **≤ 25%** of peak equity | Shows risk control, not gambling |
| Runner capture | **≥ 1** multi-× win visible on the curve | Proves the convex thesis is real |
| Per-trade expectancy | **> 0**, net of fees/slippage | Repeatable edge, not one lucky spike |
| Sample | **≥ 25** live closes | Statistical credibility |
| Smoothness | Grind-up with pops, not one spike | Distinguishes edge from luck |

**Honest caveat, stated first:** this is a ~$60 real-money wallet in the highest-variance market
that exists. The Loop can stack the odds hard in our favor; it **cannot guarantee** a green curve by
a specific clock time. §8 defines the fallback narrative so the investor meeting is strong *either
way*.

---

## 1. What the Loop IS

A continuous **observe → model → allocate → manage → adjust → report** cycle over the live wallet,
integrating every validated model we've built, running on a fixed cadence, bounded by hard
guardrails. It is the orchestration layer that turns our individual edges (wallet graph, venue map,
regime, rug model, sizer) into **one conviction-driven allocation policy** and a clean equity
telemetry stream.

```
        ┌──────────────────────────────────────────────────────────┐
        │  OBSERVE  live equity · per-trade · gate rates · regime   │
        │  MODEL    conviction score per armed candidate            │
        │  ALLOCATE priority (creme first) + conviction-scaled size │
        │  MANAGE   fast-cut losers · ride winners · sweep-protect  │
        │  ADJUST   bounded auto-tune + regime pause (guardrailed)  │
        │  REPORT   live equity curve → investor surface            │
        └──────────────────────────────────────────────────────────┘
                    cadence: 5s manage / 20s scan / 60s telemetry
```

---

## 2. The high-performance model — the **Conviction Score** (the core new piece)

Everything we validated individually gets fused into ONE point-in-time score per armed candidate.
All inputs are already computed and stored at arm time; this is a scoring function, not a new fit.

| Factor | Signal (validated) | Direction |
|---|---|---|
| **Wallet-graph edge** | winner-rep holder = 2.2× winner lift; rug-rep = 7.7% win | ↑ / ↓↓ |
| **Venue quality** | premium (proven-profitable/promoted); rug rate | ↑ / ↓ |
| **Rug model** | fitted prob, AUC 0.79 | ↓ |
| **Microstructure gate** | trigger mult × buy-share (88% win gate) | ↑ |
| **Regime** | hour policy (prime/probe) + bleeding sensor | ↑ / pause |

```
conviction = w1·walletEdge + w2·venueQuality + w3·(1−rugProb)
           + w4·gateStrength + w5·regimeMult          ∈ [0,1]
```
Weights seed from each factor's validated lift and are **frozen for the window** (no live weight-
fitting — that reintroduces look-ahead). Conviction drives two things:
- **Priority:** when ≥3 premium candidates are armed against open slots (observed: 2 armed in 45ms),
  the **highest conviction wins the slot** — creme rises, not FIFO.
- **Size:** position = balance × sizeFrac × **conviction band** (not a flat fraction), so the best
  setups get the biggest (still-capped) bets and thus move the curve.

---

## 3. What's REQUIRED to build (delta over what exists)

**Already shipped (the Loop stands on these):** wallet-graph gate + reputation, premium-venue gate,
rug model, balance+regime Sizer, bleeding-regime gate, honeypot gate, per-wallet telemetry
(`getWalletStatus`), trade-for-trade panel.

**New for the Loop:**
1. **Conviction score** — fuse the 5 factors (packages/core, pure + testable); store per arm.
2. **Priority allocation** — order contended armed candidates by conviction for the scarce live
   slots (executor).
3. **Conviction-scaled sizing** — replace flat `sizeFrac` with `sizeFrac × convictionBand`
   (executor; live-path only, paper untouched).
4. **Sweep-protect / fast live stop** — the −$3.85 `live_sweep_close` (a token dumped to ~zero
   before the paper twin closed) is the #1 curve-killer. Give the LIVE lane its own fast protective
   stop (cut at −Xa% or on a rug/dust signal) so it exits a dumping position *itself*, never gets
   swept to zero.
5. **Live equity telemetry** — a per-minute live equity snapshot series (balance + realizable
   float), the raw material of the curve.
6. **The Loop orchestrator** — a thin scheduler wiring observe→adjust on the cadence, emitting an
   audit trail of every decision (so the curve is explainable to investors).
7. **Investor equity-curve surface** — a clean, shareable curve (live + paper context) with the
   models annotated. Reuses the equity chart + artifact publishing we already have.

---

## 4. Guardrails (this is real money, and the Loop is semi-autonomous)

- **Hard stops (already live):** kill −$36, daily −$24, regime pause, premium+wallet+honeypot gates.
- **Bounded auto-tune only:** any parameter the Loop adjusts moves **within a pre-declared safe
  range**, logged, and reversible. No unbounded self-modification on real capital.
- **No weight-fitting in the window** — conviction weights are frozen; we tune *thresholds* within
  ranges, not the model, to avoid overfitting to a few hours of noise.
- **Human review gate** for any range change (you said "we will review and implement" — that stays
  true for parameter ranges, not just code).
- **Every Loop decision is audited** — priority picks, size, skips, pauses — so the equity curve is
  fully explainable and nothing is a black box in front of investors.

---

## 5. Expected outcomes (KPIs the Loop optimizes toward)

- **Expectancy > 0** per live close, net of fees/slippage.
- **Win/loss asymmetry:** small frequent losses (fast cuts) « occasional large wins (rides) — the
  convex signature; median loss bounded near −$1, winners uncapped.
- **Drawdown ≤ 25%** of peak equity (guarded by fast stops + regime pause).
- **≥ 1 runner captured** in the window (the wallet-graph slice makes this materially likelier).
- **Curve shape:** grind-up with pops. The sweep-protect fix alone removes the worst curve dents.
- **Explainability:** every up-tick and down-tick traceable to a logged Loop decision.

---

## 6. The investor deliverable

The curve we share is strongest as a **three-layer story**, all of which we already have the data for:
1. **The validated models** — wallet graph (2.2× winner lift, leak-free), venue quality
   (pumpswap +$713 vs the −$111 bleeder cut), rug model (AUC 0.79). *The edge is measured, not
   claimed.*
2. **The paper track record** — thousands of closes, +$797 realized/day, as the **statistically
   credible** proof of the strategy (large N).
3. **The live wallet curve** — real money, the **execution proof** that the models translate to
   actual fills on a hot wallet.

Framing: "Here is a measured edge (1), proven at scale on paper (2), now executing with real
capital under hard risk caps (3)." That is compelling and honest regardless of the live curve's
exact position at 5:30.

---

## 7. Timeline to 5:30pm EST (build order)

1. **Sweep-protect / fast live stop** (biggest curve-quality win; removes the −100% dents) — first.
2. **Conviction score + priority allocation** (concentrate capital on the best setups).
3. **Conviction-scaled sizing** (let winners move the curve).
4. **Live equity telemetry + investor curve surface** (the actual deliverable).
5. Let it run the trading day; monitor via the Loop's audit trail; publish the curve for 5:30.

Items 1–4 are ~a focused build; the rest is runtime. Paper stays untouched throughout (its G1–G4
validity and its role as the regime sensor + statistical-proof layer must be preserved).

---

## 8. Risks & the fallback narrative

- **Variance:** a few hours can be red on $60 of memecoins. Mitigation: the three-layer story (§6)
  leads with the *measured edge + paper proof*, so a temporarily-red live curve reads as "early,
  small-sample execution under strict caps," not a failure.
- **Overfitting to the window:** avoided by frozen conviction weights + bounded threshold tuning.
- **Fee drag on tiny positions:** real (~8% on a $3.50 position); the conviction-sizing sends more
  capital to the best setups, improving the fee-adjusted curve.
- **Tail rug between paper-close and live-sweep:** the exact −$3.85 event; the fast live stop
  (item 1) is the direct fix.

---

## 9. Open decisions (for your review before build)
1. **Conviction weights** — seed from validated lifts (my default), or do you want a specific tilt
   (e.g., wallet-graph dominant)?
2. **Conviction-sizing aggressiveness** — how much bigger may a max-conviction position be vs a
   floor one (e.g., 1.0× floor → 2.5× at top of band, still under the 14%-of-balance cap)?
3. **Fast live stop threshold** — cut a live position at −X% (e.g., −35%) independent of the paper
   twin?
4. **Investor curve scope** — live only, or the three-layer (live + paper + models) story?
5. **Auto-tune scope** — thresholds only within ranges (my default), or fully manual for the window?
