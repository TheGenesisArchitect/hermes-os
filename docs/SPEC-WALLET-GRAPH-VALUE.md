# SPEC — Value-Weighted Wallet Graph + Smart-Money Copy-Trigger + Manual Buy

**Status:** DRAFT for operator ratification (2026-08-14)
**Author:** Hermes OS
**Origin:** Operator — "Our winning wallets only have a couple hundred dollars. Orangie/Brez
have MILLIONS from high-value captures. We must improve the Wallet Graph and what we qualify
as a winning wallet. Build for where we're going. It should trigger, not just alert. Add a
manual buy/sell too."

---

## 0. The diagnosis (proven on the tape, 2026-08-14)

The wallet graph is **value-blind**. `wallet_reputation` is built from
`safety_checks.evidence->holdersSampled`, which carries `{pct, owner}` — percentage of
supply, never dollars. Reputation counts **wins, never notional.**

Measured (packages/db/replays/wallet-value.ts):

| activity band | wallets | strict winners |
|---|---|---|
| 1 token | 91,753 | 12,710 |
| 2–4 | 18,757 | 2,223 |
| 5–9 | 6,118 | 231 |
| 10–19 | 4,175 | 21 |
| **20+ (prolific)** | **6,189** | **0** |

Two structural failures:
1. **`rugs===0` zero-tolerance expels the professionals.** Anyone trading hundreds of tokens
   catches rugs. The prolific cohort (the ones who trade for a living — the Orangie/Brez
   class) has **zero** strict winners under our rule. We select for lucky dust tourists.
2. **No dollar signal.** A 0.12% holder of a $20k-liq token has ~$24 in it; a "win" is a
   $24 win. The graph is full of these. It cannot distinguish a whale's conviction bet from
   a dust position, so it cannot rank by realized dollar edge.

**The thesis:** the highest-alpha signal on-chain is *a proven high-value wallet entering a
new mint with size.* We currently neither measure value nor act on entry. This spec fixes both.

---

## 1. WORKSTREAM A — Value-weighted wallet graph (the foundation)

Replace win-count reputation with **realized-dollar reputation.** New per-wallet fields on
`wallet_reputation` (additive — keep tokens/wins/rugs for continuity):

```
realizedPnlUsd    numeric   -- Σ (proceeds − cost basis) across all reconstructed trades
volumeUsd         numeric   -- Σ notional traded (activity/scale signal)
avgEntryUsd       numeric   -- mean position notional (conviction sizing)
winRateValue      numeric   -- value-weighted win rate (not count)
medianEntryUsd    numeric   -- the dust-vs-whale discriminator
```

### 1.1 Data source — on-chain reconstruction (the "A" path, build for the destination)

**BUILT 2026-08-16** — packages/db/replays/wallet-value-walk.ts +
packages/db/sql/wallet_value_p5.sql (tables `wallet_trades`, `wallet_value`).
Engine: Helius enhanced-transactions API (one call = 100 fully-parsed txs), walking
each wallet's swap history.

- **The cash-leg fix (the crux):** Solana AMM swaps move the SOL side as a WSOL
  tokenTransfer AND (when wrapping/unwrapping) as a native transfer. Counting both
  double-counts; counting only native misses most swaps. Rule: WSOL delta is the cash
  leg when present, native net only when absent.
- **Clean-swap attribution:** exactly one non-WSOL mint + opposite-sign cash leg;
  multi-token and transfer-only txs are counted and reported as skipped, not dropped.
- **Realized = proceeds − cost basis of the SOLD portion**; open holdings are
  unrealized and excluded (honest floor).
- **First proof (25 wallets):** surfaced the whale class the win-count graph was blind
  to — CRks3VHdjX +$160k, C1yS51LRBD +$22k, F6nfjkFmmd +$16.5k — AND the sized losers
  (5Zgw6xZGdV −$7.8k, 4XcRF86BiF −$4.5k) that win-count can't distinguish from winners.

**Scope control (RPC budget):** rank candidates by graph activity (tokens seen) ×
recency, walk top-N per run (config `WALLET_WALK_TOP_N`), watermark `oldest_sig` for
incremental continuation. First walk is expensive; steady-state is cheap.

## 1.2 New qualification rule — retire `rugs===0` for the value tier

**MEASURED THRESHOLDS (threshold-census.ts, 625,126 holder samples, 2026-08-16) —
not guessed:** holder-notional percentiles p50=$149, p75=$419, p90=$6.0k, p95=$30.4k,
p99=$7.7M (pool-scale noise). And the walk's first calibration finding: **the whales
are GRINDERS, not big-apers** — CRks3VHdjX (+$160k realized) has a median entry of
$52; EoWuwwUJpw (+$6.6k) is at $64. Median entry does NOT discriminate skill (it
measures style), so DUST_LINE only excludes the true micro-grinder floor (~p50),
not the high-value cohort. The discriminators that work are realizedPnlUsd + volumeUsd.

```
VALUE-WINNER (the Orangie class):  realizedPnlUsd ≥ VALUE_WIN_MIN  AND  volumeUsd ≥ VOLUME_MIN
                                   (net-positive AND actually trades at scale)
PROLIFIC-PRO:                       tokens ≥ 20 AND realizedPnlUsd > 0   (rugs forgiven —
                                   a pro who nets positive over 20+ tokens is signal, not noise)
DUST (excluded from copy-trigger):  realizedPnlUsd below floor OR volume too thin to matter
```

Config knobs (all in config.ts, no hardcode): `VALUE_WIN_MIN` (default $500 realized —
census-grounded, tuned on the value-edge harness), `VOLUME_MIN` (default $5k volume),
`WALLET_WALK_TOP_N`, `WALLET_WALK_INTERVAL_MS`. The value-edge harness
(packages/db/replays/wallet-value-edge.ts) sweeps these against labeled outcomes.

### 1.3 The harness gate (desk protocol — prove it before it earns weight)

`packages/db/replays/wallet-value-edge.ts`: bucket every labeled candidate by the best
wallet class in its holder set (value-winner / count-winner / known-other / all-fresh)
and price the separation (win%, rug%, avgPeak). **Ratification bar:** the value-winner
cohort must beat the count-winner cohort on win% / rug% with n ≥ MIN_N, era-split.
Caveat carried: wallet_value is reconstructed from today's chain (look-ahead) — the live
path computes the tier as-of arm time from incremental walks. A tier that wins even under
the caveat earns the as-of-time live build.

### 1.3 The harness gate (desk protocol — prove it before it earns weight)

`packages/db/replays/wallet-value-edge.ts`: after the first top-N walk, split the labeled
`candidate_outcomes` by whether the holder set contains a **VALUE-WINNER** (the new
definition) vs the old count-winner definition, and price the separation:

```
cohort                        n     win%    rug%    avgPeak
holder has VALUE-WINNER       ?     ?       ?       ?
holder has old count-winner   ?     ?       ?       ?
holder all-fresh              ?     ?       ?       ?
```

**Ratification bar:** VALUE-WINNER presence must show materially higher win% / lower rug%
than the old definition on the same tape, n ≥ MIN_N, era-split. Only then does it feed
conviction sizing. (The old `winnerHits` path stays live until the new one proves out.)

---

## 2. WORKSTREAM B — Smart-money copy-trigger (acts, not alerts)

**The feature:** when a **VALUE-WINNER** wallet enters a *new* mint with size ≥ a threshold,
that mint becomes a first-class candidate **immediately** — independent of the normal
scout/confirm funnel. This is the FOMO "follow + notify + one-tap" pillar, done
autonomously: we don't notify a human, we fire a candidate.

### 2.1 Detection (the trigger source)

- Sentinel already subscribes to pool accounts (`syncSlotWatch`) and sees swaps in near-real
  time. Extend the watch to **match the swap's signer/owner against the VALUE-WINNER set**
  (the in-memory set refreshed from `wallet_reputation` each cycle).
- On a match with `entryNotionalUsd ≥ COPY_MIN_ENTRY_USD`: emit a `smart_money_entry` event
  → insert a `signals` row with a new `source = 'smart_money'` and the triggering wallet(s)
  + their value stats in the evidence.

### 2.2 The action path

The `smart_money` signal enters the same candidate pipeline but tagged, so:
- It can be **fast-laned** (skip the slowest confirm bars — the smart-money entry IS the
  confirmation, per the canon's own "the crowd's track record IS the evidence" logic — but
  this is exactly the look-ahead the desk got burned on, so see §2.3).
- It carries a **conviction boost** sized by the triggering wallet's `realizedPnlUsd` tier
  and `medianEntryUsd` (bigger proven wallet, bigger boost) — sized, never vetoing.
- The trader treats it as a normal armed candidate from there (same exits, same rails —
  the −45% floor, depth collapse, all protective rails still apply).

Config: `COPY_TRIGGER_ENABLED` (default **false** until harnessed), `COPY_MIN_ENTRY_USD`,
`COPY_MAX_WALLETS_PER_MINT`, boost tier table.

### 2.3 The harness gate (non-negotiable — this is the overfit trap)

The danger: "smart money entered" is only knowable *after* the entry, and backtesting it
naively is look-ahead city. So the harness must be **point-in-time honest:**

`packages/db/replays/copy-trigger-harness.ts`: replay the tape, and for each candidate, ask
"would a VALUE-WINNER entry have fired *before* our actual entry, and what was the outcome?"
Compare the copy-triggered cohort's win%/rug%/EV vs the baseline funnel, era-split, MIN_N.

**Ship only if** the copy cohort beats the funnel baseline on EV/trade in both eras. This is
the same discipline that just falsified the deployer term — copy-trigger is a hypothesis
until the tape says otherwise.

---

## 3. WORKSTREAM C — Manual buy (manual sell already exists)

Manual **sell** already exists: RIDE/CUT intent (`management_intents`) + `live_close_request`
→ `user_cut`. The gap is manual **buy** — "I see this mint, get me in now, at this size."

### 3.1 The mechanism (mirror the trusted-queue pattern)

Manual buy must keep the trader as the **single money-mover** (the invariant that prevents
double-spend races). Same pattern as `live_close_request`:

- Dashboard action `requestManualBuy(mint, sizeUsd, lane)` → writes `config` key
  `manual_buy_request` = `{ mint, sizeUsd, lane, status: "pending", requestedAt }`.
- Trader, on its entry poll, consumes pending `manual_buy_request` (new
  `processManualBuyRequests()` alongside `processLiveCloseRequests()`):
  - Runs the **hard safety gates only** (honeypot trap, mint authority, depth floor,
    fee-viability) — NOT the score/confirm funnel (the operator IS the signal).
  - Executes through the same live execution path (`maybeLiveBuy` machinery) so the fill,
    the −45% floor, the audit row, and the position record are all identical to an auto
    entry. Tagged `source: "manual"` on the position + audit.
  - Writes status `done`/`failed` + reason back to the config row so the dashboard can show
    the verdict (the DIP-incident lesson: a silent failure looks like the click did nothing).

### 3.2 Dashboard surface

A manual-buy control: mint input + size (respecting the sizing floor / exposure cap) +
lane selector (paper default; live behind the same confirm the live close uses). Shows the
request's verdict on completion.

### 3.3 Rails (never loosened)

- Respects `kill_switch`, exposure cap, fee-viability floor — a manual buy does not override
  a rail.
- Hard safety gates always run (honeypot, mint authority, depth) — operator convenience never
  skips the adversarial filters.
- Lane separation: manual paper buy and manual live buy are distinct, live requires the
  explicit confirm, every action carries an audit row.

---

## 4. Sequencing & dependencies

```
A (value-weighted graph)
   └─> B (copy-trigger)  — B depends on A's VALUE-WINNER set; A's harness gates B's existence
C (manual buy)            — independent of A/B; only needs the existing execution path
```

**Recommended build order:**
1. **C first** — smallest, unblocks operator control immediately, no research risk. (A day.)
2. **A second** — the foundation; the top-N walk + new fields + value-edge harness. (The big one.)
3. **B last** — only after A's harness proves the VALUE-WINNER set separates winners, and B's
   own point-in-time harness proves the trigger beats the funnel. Both rails up the whole way.

Each ships paper-first, harness-gated, counterfactual watch from day one. No live execution
change without the tape saying it wins.

---

## 5. What I need from the operator (ratify before build)

1. **A's scope:** confirm the **top-N on-chain walk** approach (RPC-budgeted) vs a cheaper
   value-at-entry proxy for the first pass. (I recommend the walk — "build for where we're
   going" — but it costs RPC credits; the proxy is the fast-cheap option if you'd rather
   validate the thesis before spending on walks.)
2. **The value thresholds:** `VALUE_WIN_MIN` $5k, `DUST_LINE` $500, `COPY_MIN_ENTRY_USD` —
   are these the right orders of magnitude for "high value"? (Easy to tune; want your read.)
3. **C's rails:** confirm manual buy runs the hard safety gates but skips the score funnel
   (operator-as-signal), and whether live manual buy needs any extra confirm beyond the
   existing live-close pattern.
