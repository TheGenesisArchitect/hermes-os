# TP0 / Entry-Weight / News-Signal Tuning Plan

_Draft 2026-07-14 — gated Track B work toward a positive equity curve before a live wallet. This is a PLAN, not a build. Pick the order before anything ships._

---

## 0. The hidden gem is real — the mechanism is not what it looks like

The instinct is correct and it's the most important finding in the whole audit:
**we traded ZERO of the bangers our own system saw.** Every one of these is
recorder-labeled `winner` and we captured none of them:

> BLIMPCAT 5.85× · EARTH 6.97× · NECKY 39.76× · ROW 5.83× · TrumpBills 5.48× ·
> DrawnBull 4.86× · Brain 17× (and more)

That capture gap **is** the gem. We have line-of-sight into these — the recorder
watches every safety-passed candidate's first 15 minutes and labels the outcome.
The winners are in our data. The trader just never fires on them.

**What the "news tweets" actually are.** The news page is not an external
intel feed. The newsdesk is a *downstream, read-only* content engine: it reads
our own `candidate_outcomes` (the recorder's labels), asks the local Ollama model
to write market-analyst prose, and stores it in `market_news`. The
"tweets" you're looking at are the `contentDrafts.xPost` / `xThread` fields —
**outgoing post copy the LLM writes about our own movers**, not incoming market
signal. Trading never reads any of it back. There is no external Twitter/RSS
ingest anywhere in the repo (confirmed by a full wiring trace).

So the reframe: we are not blind to bangers because we lack an external feed —
we're blind because **the recorder's winner-knowledge never flows back into the
scorer or the trader.** Closing that loop is the actionable ML play. It's cheaper
and higher-signal than building an external feed, because the data is already
ours and already labeled.

One honest calibration on the word "forecast": what the recorder gives us is
**backward-looking labels** — it tells us which *category* is hot *right now*
based on outcomes already closed. That supports a **category tilt** (politics
coins are winning today → nudge their score up), not a banger-*predictor*. The
only genuinely forward signal at entry is the microstructure confirm tick, and
the separation study showed that signal is **real but weak**. The plan below
treats it that way — no lever promises prediction it can't deliver.

---

## Three levers, ranked by confidence

Each lever gets a "prove it on recorded outcomes before live" step — the same
replay discipline that carried the whole audit.

### Lever 1 — TP0 exit tranche  *(highest confidence · already replay-sized)*

**The finding.** Replaying all 408 confirmed rugs and 374 confirmed winners,
re-anchored at their ≥1.25× confirm tick (where we actually enter):

| Post-confirm peak reaches | Rugs (n=408) | Winners (n=374) |
|---|---|---|
| ≥ 1.15× | **62%** | **98%** |
| ≥ 1.30× (today's first sell) | 33% | 97% |
| avg post-confirm ratio | 1.166× | 1.925× |

**The change.** Add a first take-profit tranche *below* the current TP1:

```
TP0_MULT      = 1.15    # relative to entry
TP0_CUM_SELL  = 0.40    # bank 40% of the position here
```

TP1 (1.30× → 0.50 cum) and TP2 (1.70× → 0.80 cum) stay; the ~20% runner stays
uncapped with the ratchet. This is take-profit-into-strength with a runner — it
does NOT cap the tail (`feedback_maximize_dont_minimize`): winners average 1.9×
post-confirm and 57% clear 1.70×, so the runner still rides the moonshot.

**Why it works.** 62% of rugs reach 1.15× on the blow-off top *before* the LP is
pulled — today we bank $0 on them. A 40% tranche at 1.15× converts the majority
of the −$120 rug bucket from full loss to partial. It barely touches winners:
98% clear 1.15× and keep running, so we sell 40% early and let 60% ride to ~1.9×.

**What it CANNOT fix (state it plainly).** 17% of rugs never reach even 1.05×
after confirm — they only fall. No take-profit can touch those; they are pure
entry-quality residue and are Lever 2's job. TP0 is a large partial mitigant of
the rug bucket, not the cure.

**Prove-it step.** Replay the closed rug + winner ledger with TP0 inserted;
confirm net rug-bucket loss shrinks and winner realized-P&L is materially
unchanged (runner intact). Files: `packages/core/src/config.ts` (add the two
knobs, keep `RECORDER_*` lockstep discipline), `services/trader/src/paper.ts`
`decideExit` (insert the TP0 rung above TP1 in the existing ladder branch).

---

### Lever 2 — Entry weighting  *(medium confidence · straight from the separation study)*

The separation study on clean labels (rugs now produce 399 clean confirm-ticks,
was 0) found the confirm gate is partly selecting *for* rugs. Two fixes:

1. **Buy-share: floor → BAND.** Today the gate requires `buyShareM5 ≥ 0.60` (a
   floor). But rugs run **0.91** buy-share vs winners **0.86** — one-sided
   all-buys is the coordinated pump *before* the pull, so the floor mildly
   selects for rugs. Change to a band, ~`0.60–0.85`, rejecting the >0.90
   all-buys blow-off. New knob `CONFIRM_MAX_BUYSHARE ≈ 0.85` in
   `entryTrigger.ts`.

2. **Volume-acceleration: add as a positive gate/weight.** This is the one clean
   positive edge — winners **0.51** vs rugs **0.36**. It is not yet in the
   confirm gate at all. Add `volAccel` to the tick features and require/weight
   it (e.g. `CONFIRM_MIN_VOLACCEL ≈ 0.45`), tuned on the replay so it shaves rugs
   without starving winner entries.

**Honest scope.** These *shave* the rug rate — they don't eliminate it (liquidity
does NOT separate winner from rug; both ~170k median). Combined with TP0 they
attack the 17% TP0 can't reach. Expect a modest, not dramatic, improvement.

**Prove-it step.** Re-run the confirm gate over history with the band + vol-accel
gate; measure the winner/rug ratio *among fired triggers* before vs after. Ship
only if rug-share of triggers drops without losing the labeled winners.

---

### Lever 3 — News category-tilt → fill the dead 20-pt narrative slot  *(lowest confidence · cheapest to wire · needs guards)*

**The dead slot.** `score.ts` has a 20-point `narrative` component that today
returns a flat neutral 10 — it's wired to a *separate* Anthropic Claude call over
the token name (`narrative.ts`), which Hermes must NEVER use. So 20 of 100 points
are dead weight on every score.

**The fill.** The recorder already knows which *categories* are winning. Compute a
per-category rolling win-rate from `candidate_outcomes` (via the local Ollama
categorizer the newsdesk already runs — gate-free, allowed) and feed it into the
narrative slot as a **category-momentum tilt**: a token whose category is hot in
our own recent data gets a score nudge. This closes the recorder→scorer loop —
the winner-knowledge finally flows back to entry selection.

**Two non-negotiable guards (this is a feedback loop over data we just cleaned).**
1. **Clean labels only.** Recompute every category stat on the *corrected* labels.
   The current briefs are noise built on poison — e.g. `meme-viral: 1/1 = 100%`,
   `other: 32/32 = 100%`. Weighting entries on that chases exactly the fake
   bangers (ANSEM 30×, USOH 167×) we just purged.
2. **Hard MIN_N sample guard.** A category tilts the score only above a minimum
   sample (reuse the Intel Report's "tracked, not yet trusted" discipline). Below
   MIN_N the tilt is neutral. No small-sample category may move an entry.

**Follow-on (fold in here).** Apply the poison-signature guard to the newsdesk's
own mover-detection so it stops minting fake-banger headlines from constant-price
pool-flip artifacts (same signature: peak≈final AND maxdd<1 AND peak>threshold).

**Prove-it step.** Backtest scoring with the tilt on: does adding the category
tilt raise the score of the labeled winners we missed (BLIMPCAT, EARTH, NECKY…)
relative to the rugs, at their confirm tick? Ship only if it separates them.

---

## Suggested order of execution

1. **Lever 1 (TP0)** — biggest proven lever, self-contained, replay-sized already.
2. **Lever 2 (entry band + vol-accel)** — attacks the 17% TP0 can't reach.
3. **Lever 3 (news tilt)** — cheapest to wire but a feedback loop; do it last, with
   both guards, after the label base is trusted.

Live-wallet gate stays where the audit put it: Track B (signal-driven live)
remains BLOCKED until the equity curve is positive on replay with these in place.

---

## Open decision for you

Which lever ships first? Recommendation: **Lever 1 (TP0)** — it's the only one
already sized on evidence and it's self-contained. But the order is yours.
