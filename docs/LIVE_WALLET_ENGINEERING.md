# LIVE WALLET — ENGINEERING SPECIFICATION FOR AUDIT

**Generated 2026-07-31 · commit `604ce4e` · wallet `rEPAt2uXrLHpN3J7By4PaAjbdi21V7rXozDipw5X1Q5`**

This document maps every decision the live wallet makes, with `file:line`
references so each claim can be verified against source rather than taken on
trust. Where behaviour is known-defective it is listed as such in §8.

Auditor's note: this system runs **two lanes**. `paper` is a simulation that
never touches capital; `live` is real. They share one exit engine
(`decideExit`) and diverge in execution. Every dollar figure attributed to
`paper` is modelled; every dollar attributed to `live` is on-chain and carries
a transaction signature.

---

## 1. TOPOLOGY

| service | path | role |
|---|---|---|
| scout | `services/scout` | discovers mints, runs the safety pipeline |
| recorder | `services/recorder` | records candidate ticks, labels outcomes, learning loop |
| trader | `services/trader` | both lanes; owns all capital decisions |
| dashboard | `apps/dashboard` | read-only surfaces, plus operator kill/close controls |

Live capital logic is confined to `services/trader/src/live/`:

| file | responsibility |
|---|---|
| `executor.ts` | entry gates, sizing, the guard loop, all selling |
| `presigned.ts` | durable-nonce pre-signed exits ("the sniper") |
| `swap/router.ts` | provider failover + circuit breakers |
| `swap/*.ts` | Jupiter, PumpSwap, Meteora, Fluxbeam, PumpPortal providers |
| `rpc/pool.ts` | RPC pooling and failover |

The shared exit engine lives in `services/trader/src/paper.ts` →
`decideExit()`. Live imports it (`executor.ts:~3006`) so both lanes exit on
identical logic.

---

## 2. ENTRY PATH — `maybeLiveBuy()`, `executor.ts:193` onward

Gates fire in cheap→expensive order. Each refusal writes an `audit_log` row
(`action='live_buy_skipped'`). **A silent decline is a defect** — see §8.

### 2.1 Solvency rails (protect the wallet; never a strategy opinion)

| # | gate | source | refusal reason |
|---|---|---|---|
| 1 | trading disabled | `liveBuyGate` | `disabled` |
| 2 | no wallet key | | `no wallet key` |
| 3 | **kill switch engaged** | `config.live_kill` | `live_kill engaged` |
| 4 | **kill criterion** cum. realized ≤ −$32 since epoch | `executor.ts:~212` | `kill criterion met` |
| 5 | daily loss cap −$35 (throttles, does not halt) | `executor.ts:~232` | `daily loss cap (…)` |
| 6 | regime bleeding (paper is the sensor) | | `regime bleeding (…)` |
| 7 | concurrency cap = 4 | `executor.ts:~314` | `concurrency cap` |
| 8 | already held (one position per mint) | `executor.ts:~321` | `already held` |

### 2.2 Strategy gates

| gate | notes |
|---|---|
| venue executable / premium | venue allowlist |
| wallet-graph anti-gate | refuses holder sets with net-negative rug history |
| honeypot | requires an **affirmative** verified sell route; inconclusive = block |
| inflow measured | live requires a stamped pool read; unmeasured = refuse |
| **class allowlist** | `LIVE_SIGNATURE_ALLOWLIST` — 7 genomes |
| `profileOf(sig).trade` | `RUG_RISK` is `trade:false`; reaches live only via `RUGRISK_FORMULA_ROUTE` (crowd-PASS + in-envelope) |
| regime gate per class | class stands down on measured negative venue edge |
| star bar | 0★ refused (ran −55.3%) |
| **inflow band** | `LIVE_MIN_INFLOW = 1.25` |
| **envelope** | `INFLOW_FLOOR 1.20` … `INFLOW_CEILING 2.05`; above ceiling = manufactured spike, refuse |
| **seat** | `CONVICTION_SEAT_MAX = 2.05` (raised from 1.65 today) |
| buy-share floor | 55% at the trigger tick |
| pool depth floor | cliff-safe door, ≥$13,000 (see §8.3) |
| exposure / SOL reserve | `LIVE_MAX_EXPOSURE_FRAC = 0.05` |
| mirror freshness | refuses if the paper twin has already started exiting |
| price impact | final pre-trade check |

**Sub-floor doors** (deliberate exceptions, each audited):
`live_subfloor_ticket`, `live_buildback_ticket`, `live_golden_window`,
`live_cliffsafe_readmit`, `live_rugrisk_formula`, `live_sensor_seat`.
These admit at **ticket size only**, never full slot.

---

## 3. SIZING — `livePositionUsd()`, `executor.ts:668`

```
routedFrac = max(LIVE_MIN_POSITION_FRAC,
                 (paperFrac ?? sizeFraction(stars, POSITION_FRAC_MIN, POSITION_FRAC_MAX)
                    × profileOf(sig).size) × starBoost)
base       = balanceUsd × routedFrac × genomeWeight
capped     = min(base, balanceUsd × LIVE_MAX_POSITION_FRAC, LIVE_MAX_POSITION_USD)
```

Then the **mandate slot clamp** (`executor.ts:~1560`), which mirrors paper:

```
mandateSlot = balanceUsd × LIVE_MANDATE_AGG_FRAC ÷ LIVE_MANDATE_SLOTS
            = balance × 0.05 ÷ 4        (= 1.25% of balance)
PRECISION entries clamp to exactly this slot (even tickets).
```

Then the **fee-viability floor**: if the sized value `< LIVE_MIN_POSITION_USD`
($2.50), a PRECISION or sub-floor entry is rescued *to* $2.50
(`live_mandate_ticket`); **anything else SKIPS**.

Then the **daily throttle** multiplies size down as the day's loss approaches
the cap (`LIVE_DAILY_THROTTLE_MIN = 0.4`).

> ⚠️ **See §8.1 — at current equity this arithmetic produces a slot below its
> own floor, causing silent skips.**

---

## 4. EXIT ENGINE — `decideExit()`, shared by both lanes

Rules evaluated in this order; **first match wins**. `paper.ts` line numbers:

| line | rule | fraction |
|---|---|---|
| 1652 | `depth_collapse_cut` | 1.0 |
| 1693 | `basis_first` — recover cost basis | `min(entry/price, 0.92)` |
| 1702 | **`floor_45`** — the −45% standard, arms at 0.75× | 1.0 |
| 1747 | **`liquid_window`** — pool ≤ 70% of its running peak | 1.0 |
| 1767 | `ripe_sweep` | 1.0 |
| 1795 | `drain_guard_cut` | 1.0 |
| 1804 | `runner_timeout` | 1.0 |
| 1823 | `time_floor` | 1.0 |
| 1849 | `fast_scratch` — never-green dud cut | 1.0 |
| ~1900 | **TP ladder** TP0 1.15×/40% · TP1 1.30×/50% · TP2 1.58×/**55%** | partial |
| 1960 | `stale_take` | 1.0 |
| 2066 | `hard_stop` | 1.0 |
| 2078+ | `never_armed_stop`, `stop_time`, `stop_flat`, `stop_volume` | 1.0 |

**Pool ownership**: when a trusted pool reading exists *and* a peak is
established, the pool rule owns the ride and the CAPTURE exits are suppressed
(`ripe_sweep`, `runner_timeout`, `time_floor`, `stale_take`, `moon_ratchet`,
`profit_trail`). Every PROTECTIVE rail still fires. Missing/zero/first-sight
liquidity hands the position back to the legacy stack.

**Live-only exits** (`guardLiveBook`) are gated `!genomeOwned` — they apply to
*unrouted legacy rows only* and cannot touch a routed position:
`live_floor`, `live_profit_floor`, `live_stop`, `live_catastrophe_stop`.

---

## 5. EXECUTION — `liveSellPosition()`, `executor.ts:~2005`

Order of operations on a sell:

1. **Backoff check** — a failing sell is not free to retry.
2. **Classify** — `isProtective` matches
   `stop|catastrophe|rug|sweep|mirror_cut|unsellable|depth_collapse|drain_guard|floor_45|user_cut|runner_timeout`.
3. **Latch** — a terminal exit is recorded *before* the attempt, so a throw
   anywhere still leaves the exit commanded (`exitLatch`).
4. **SNIPER FIRES FIRST** — for a protective full exit with a chambered round,
   `fireChambered()` submits pre-signed bytes with **no quote in front of it**.
   A stale-quantity guard refuses a round signed against a pre-bank balance.
5. **Fallback** — only if the chamber missed: quote → build → `executeSwap`,
   with escalating slippage (protective starts at 2000bps → 9000bps ceiling)
   and 3× priority fee.
6. **On failure** — poison the provider (`sellExclude`), retry immediately if a
   new venue is now reachable, else exponential backoff.
7. **Write-off** — only when every route is exhausted *and* the position is old
   enough: books the honest loss as `live_unsellable`.

**Provider order** (`swap/router.ts:42`): PumpSwap → Jupiter hosted → Jupiter
self-hosted → Fluxbeam → Meteora DBC → Meteora DAMM v2 → PumpFun curve →
PumpPortal. Each throws `NoRouteError` on "not my protocol", which is failover,
not failure, and does not trip the breaker.

---

## 6. THE GUARD LOOP — `guardLiveBook()`, `executor.ts:~2735`

- **Phase 1 (parallel)** — values the entire open book with `Promise.all`:
  RPC balance read + Jupiter sell quote per position. Read-only, independent.
- **Phase 2 (serial)** — decisions and sells, strictly one at a time. Nonce
  contention, the in-flight claim and double-sell guards depend on this.

**Depth precedence**: pool depth is derived from the live sell quote's
`priceImpactPct` by inverting the slippage model —

```
impact = trade / (liq/2 + trade) × 100   ⇒   liq = 2·trade·(100/impact − 1)
```

falling back to `candidate_ticks` (DexScreener, ≤90s old) only when the route
gives nothing.

---

## 7. EFFECTIVE CONFIGURATION

⚠️ **Precedence is `.env` > zod default.** Reading the default alone is
misleading and has caused two production no-ops. Verified values:

| knob | code default | `.env` pin | **effective** |
|---|---|---|---|
| `LIVE_TRADING_ENABLED` | — | `true` | **true** |
| `LIVE_SIGNATURE_ALLOWLIST` | 7 genomes | — | BASE, RISER, MOON_FAST, MOON_VIOLENT, MOON_STEADY, MOON_SLOW, RUG_RISK |
| `LIVE_MIN_INFLOW` | 1.25 | 1.25 | **1.25** |
| `LIVE_INFLOW_FLOOR` | 1.20 | **1.30** | **1.30** ⚠️ above the admission band — see §8.4 |
| `INFLOW_FLOOR` / `CEILING` | 1.20 / 2.05 | — | 1.20 / 2.05 |
| `CONVICTION_SEAT_MAX` | 2.05 | — | **2.05** |
| `LIVE_MANDATE_SLOTS` | 4 | 4 | **4** |
| `LIVE_MANDATE_AGG_FRAC` | 0.05 | 0.05 | **5% aggregate** |
| `LIVE_MIN_POSITION_USD` | 3.50 | **2.50** | **$2.50 floor** |
| `LIVE_MIN/MAX_POSITION_FRAC` | 0.02 / 0.0125 | 0.0125 / 0.0125 | **1.25% both** |
| `LIVE_MAX_EXPOSURE_FRAC` | 0.75 | **0.05** | **5%** |
| `LIVE_MAX_CONCURRENT` | 15 | **4** | **4** |
| `LIVE_DAILY_LOSS_CAP_USD` | 24 | **35** | **−$35** |
| `LIVE_KILL_LOSS_USD` | 36 | **32** | **−$32** |
| `LIVE_STOP_SLIPPAGE_BPS` | 3500 | — | 3500 (protective escalates 2000→9000) |
| `LIVE_PRESIGNED_EXITS` | **false** | **true** | **true** ⚠️ default is misleading |
| `LIQUID_WINDOW_POOL_FRAC` | 0.70 | — | 0.70 |
| `TP0_MULT` / `TP0_CUM_SELL` | 1.15 / 0.40 | — | bank 40% at +15% |
| `TP2_CUM_SELL` | 0.55 | — | 45% rides |
| `STANDARD_FLOOR_ARM_MULT` | 0.75 | — | floor arms at −25% |
| `MARK_FEED_DIVERGENCE` | 5 | — | reject Jupiter if >5× from DexScreener |

---

## 8. KNOWN DEFECTS AND OPEN RISKS

Listed because an audit is worthless without them.

### 8.1 The slot no longer clears its own fee floor — **ACTIVE**
At equity $183.82: `183.82 × 5% ÷ 4 = $2.30`, **below the $2.50 floor**. With
the daily throttle at −$22.98/−$35 it computes to **$1.39**. Only PRECISION and
sub-floor entries are rescued to $2.50; everything else **skips silently by
design**. The spec ("4 positions at $2.50 = 5% outlay") only self-consistent at
equity ≥ $200. **Recommended fix:** `slot = max(feeFloor, balance × agg ÷ slots)`
so ticket size is floor-aware and the aggregate floats.

### 8.2 Quote-to-fill gap — **UNRESOLVED, UNDER-SAMPLED**
Measured 6h: live fills at **0.484** of its own quote (n=7) vs paper 0.948
(n=108). **Three of those seven were LP pulls where $0.00 was the true market
price**, so the ratio is not established. Mark age at decision was 8s (now ~2s
after §6). Requires a larger sample before any conclusion.

### 8.3 Depth floors gate the largest tail — **DELIBERATELY LEFT CLOSED**
The two pool-depth floors refuse the most upside in the ledger (2,676 and 1,083
tail mass, 27.9% / 31.0% moon rate). They are retained because they guard the
exact failure in §8.2. They should be revisited **only after** exits are proven.

### 8.4 `LIVE_INFLOW_FLOOR` (1.30) sits above `LIVE_MIN_INFLOW` (1.25)
Candidates in [1.25, 1.30) are admitted by the band gate but land in
**build-back mode** and receive ticket size rather than a full slot. This is
coherent but non-obvious; flagged so it is not read as a bug.

### 8.5 In-memory state lost on restart
`exitLatch`, `sellExclude`, `chambers`, `poolPeak`, `livePeakMark` are all
in-process. A deploy wipes them; a 90s refresh loop re-chambers. Sniper hit
rate measured 12 fired / 20 fallback (37%) across a day with ~8 restarts.

### 8.6 Paper's fill model is optimistic on the death cohort
`convexSlippagePct` is depth-aware (`liq ≤ 0 ⇒ 99%`) but reads liquidity from
DexScreener, which lags an LP pull. Paper therefore books orderly exits on
positions live cannot exit at all. **Paper's P&L is a valid model of selection
and management, not of rug-class outcomes.**

### 8.7 Basket harvest has never fired on a true basket
It is a portfolio rule; the live book has never exceeded 2 positions. Its
headline "100% capture" is partly an artifact of sweeping post-ladder
remainders near the current mark.

---

## 9. CHANGE LOG — 2026-07-31

| commit | change |
|---|---|
| `ae3c428` | liquid window — release on pool turn, both lanes |
| `d999546` | exit latch — a commanded protective exit retries until it closes |
| `c4bbed1` | MOON_STEADY + MOON_SLOW admitted; moon sweep (band optimum 0.70) |
| `088b72b` | ownership harness — the price trail costs −$3,781 |
| `3d2e41d` | pool ownership both lanes; PumpPortal routability pre-check |
| `53c1b98` | profit-lock regression fix; capture harness |
| `0700c1d` | scaled ratchet REFUTED; gap anatomy (55% atomic / 45% survivable) |
| `e93e906` | ladder E — runner 20% → 45% |
| `7933b1e` | basket harvest bar scaled to the book |
| `a9bcdd8` | live admission 1.30 → 1.25; seat line follows the config |
| `5676fbe` | **sniper fires before the quote** — the atomic-rug leak |
| `4c958cb` | basket anchor = deployed capital; sniper stale-quantity guard |
| `c1cf66f` | **`user_cut`/`runner_timeout` classified protective** |
| `3e5cd1a` | RUG_RISK admitted (plug-in list was the binding constraint) |
| `51ee3bd` | **depth read from the route, not the aggregator** |
| `28eb13b` | seat ceiling 1.65 → 2.05 |
| `604ce4e` | **guard loop valued in parallel** — 8s marks → ~2s |

---

## 10. INDEPENDENT VERIFICATION

Nothing here requires trusting the operator or the assistant:

- **Every live fill carries an on-chain signature.** `SELECT tx_signature FROM
  fills WHERE position_id = …` → verify on any Solana explorer.
- **Every live decision carries an audit row.** `audit_log` is append-only.
- **The journal is append-only with Σ legs = 0 enforced** (dashboard shows the
  count and enforcement state).
- **The live book is reconciled against chain every 5 minutes.**
- **`pnl_snapshots`** records real wallet equity independently of position
  bookkeeping — reconciling the two is the check that caught a −$11.14 equity
  move against −$9.06 recorded P&L (difference = fees + open mark).

**Suggested first audit query** — does recorded P&L reconcile to real equity?

```sql
SELECT (SELECT equity_usd FROM pnl_snapshots WHERE lane='live'
          ORDER BY snapped_at DESC LIMIT 1) AS equity_now,
       (SELECT sum(realized_pnl_usd) FROM positions WHERE lane='live') AS recorded_all_time;
```
