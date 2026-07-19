# Live Early-Fill Floor — Spec

## Goal
Put a floor under every live trade that **actually fills**. Live's losses were full-size rugs
(`live_unsellable`, −100%) because the defensive tranche only sold when the *paper twin* mirrored
its TP0 — which can arrive after the pool is already gone. The wallet crucible (rode paper's real
Wed–Sat sequence) proved the fix: modeling rug-type exits as unsellable reproduces the real −$56
death ($60/6% → 17% survival, $2), and adding an early-filling floor flips the **same config** to
100% survival / $2,936 median. The floor is worth more than moon capture. This spec makes it
executable.

**Principle:** this is NOT a new exit *rule* (the trail replay proved rule/velocity tuning does
nothing). It is independent, early **execution** of the ladder's existing first tranche, so it
fills before the rug — and it never caps the moonshot (only 40% banks; the 60% runner still rides
the mirror uncapped).

## Mechanism
Extend `guardLiveBookInner` (services/trader/src/live/executor.ts) — the fast ~5s loop that
already, per open position: reads the on-chain token balance, and **values it via a real sell
quote** (`exitJup.quote → outSol → value`). Add the upside-defensive twin of the existing
downside stop, reusing that same quote:

```
// inside the per-position loop, AFTER `value` is computed and BEFORE the downside-stop block
if (cfg.LIVE_FLOOR_ENABLED && value != null) {
  const cost = n(lp.sizeUsd);
  const soldFrac = 1 - n(lp.qtyRemaining) / Math.max(n(lp.qtyTokens), 1e-9);
  const floorFrac = lp.dex === "meteora-damm-v2" ? cfg.FARM_TP0_CUM_SELL : cfg.LIVE_FLOOR_FRACTION;
  // arm ONLY when nothing has banked yet (soldFrac ~ 0) and the REAL sell value is >= arm mult.
  // value/cost == mark multiple while nothing is sold; a non-null value means it's sellable NOW.
  if (soldFrac < 0.01 && cost > 0 && value / cost >= cfg.LIVE_FLOOR_ARM_MULT) {
    console.log(`🩹 FLOOR ${short(lp.mint)} — banking ${(floorFrac*100).toFixed(0)}% @ ${(value/cost).toFixed(2)}x (sellable, early insurance)`);
    if (cfg.LIVE_FLOOR_LOG_ONLY) { /* shadow: log intent, do not sell */ }
    else await liveSellPosition(cfg, lp, floorFrac, "live_floor", cfg.LIVE_FLOOR_SLIPPAGE_BPS);
    continue; // banked this cycle; downside-stop check resumes next cycle
  }
}
```

### Why the sell-quote arm is the whole trick
`value` comes from `exitJup.quote(...)`. If the pool is drained/unsellable, the quote throws →
`value == null` → the floor **cannot fire** (it leaves the position for the sweep). So the floor
only ever fires when the token is *both* up ≥ arm mult *and* actually sellable right now. That is
exactly "bank while the pool is deep, before the rug" — enforced by construction, not by a timer.
The anatomy window (rugs peak ~3.7 min; the guard runs every ~5s) means it fires within seconds of
crossing the arm.

## Coordination with the paper mirror (the key design decision)
The floor and paper's TP0 mirror both target the same first ~40% tranche. To avoid double-banking
under the current fraction-of-remaining sell model, use **Floor-owns-TP0**:

1. The floor banks the first tranche at `LIVE_FLOOR_FRACTION` (= `TP0_CUM_SELL` = 0.40), matching
   paper's TP0 cumulative exactly.
2. `mirrorLiveSell` **skips** paper sells whose reason is `take_profit_0` when `LIVE_FLOOR_ENABLED`
   (the floor owns that rung). One-line guard at the top of `mirrorLiveSell`.
3. All higher rungs (TP1 50% cum, TP2 80% cum, trail, `basket_harvest`) mirror **unchanged** — the
   fraction-of-remaining accounting stays aligned because after the floor banks 40%, live's
   remaining (60%) equals paper's remaining after its own TP0, so paper's TP1 increment applied to
   live's remaining is correct.
4. Whoever would have hit TP0 first no longer matters — the floor always owns the 40%, the mirror
   never does. No race, no double-bank.

Idempotency across restarts is durable via `soldFrac < 0.01` (read from `qtyRemaining/qtyTokens`),
not an in-memory flag — a restart mid-position won't re-bank.

## Config (packages/core/src/config.ts)
| knob | default | note |
|---|---|---|
| `LIVE_FLOOR_ENABLED` | `false` | ship dark; enable after log-shadow |
| `LIVE_FLOOR_LOG_ONLY` | `true` | shadow mode: log intent, don't sell |
| `LIVE_FLOOR_ARM_MULT` | `1.15` | = `TP0_MULT`; bank the first tranche into the blow-off |
| `LIVE_FLOOR_FRACTION` | `0.40` | = `TP0_CUM_SELL`; farm tape uses `FARM_TP0_CUM_SELL` (1.0) |
| `LIVE_FLOOR_SLIPPAGE_BPS` | `900` | banking into strength; wide enough to fill a fast mover, not a panic dump |

## Safety
- **Only ever sells** (reduces exposure) — cannot increase risk.
- **Quote-gated** — never fires on a stale/bad read; if it can't get a real sell value, it does
  nothing (same discipline as the downside stop's null-value skip).
- **Never caps the moonshot** — banks 40%, the 60% runner rides the mirror uncapped. Consistent
  with "maximize, don't minimize."
- **No new dependency / no extra RPC** — reuses the balance read + sell quote the guard already does.

## Rollout / validation
1. **Ship dark**: `LIVE_FLOOR_ENABLED=false`. Land code + config.
2. **Log-shadow**: `LIVE_FLOOR_ENABLED=true, LIVE_FLOOR_LOG_ONLY=true` for one live session — confirm
   the 🩹 FLOOR line fires early (seconds after crossing 1.15×) on real positions and that the
   arm/sellability logic behaves. No capital moves.
3. **Enable**: `LIVE_FLOOR_LOG_ONLY=false` once shadow looks right, alongside the funded-wallet
   go-live (fund ~$165, clear `live_kill`).
4. **Measure**: post-enable, live rug-type exits should recover ~0.46+ instead of 0.00 — verify via
   the paired ledger (live `exitReason='live_floor'` fills present; rug losses shrink from −100%).

## Edge cases
- **Straight-down rug** (peakx < 1.15, never arms): floor gives no cover — the −28% downside guard
  handles it. Rare per the anatomy (rugs median peak 1.66×), and the crucible modeled this as the
  0.72 fast-cut branch.
- **Farm tape** (meteora-damm-v2): floor banks 100% (`FARM_TP0_CUM_SELL`) at 1.15× — strongest
  insurance on the rug-heaviest venue.
- **Paper faster than the floor**: mirror skips TP0, floor still owns it → same outcome.
- **Position already partially closed**: `soldFrac ≥ 0.01` → floor skips (tranche already banked).

## What this does NOT do
It does not change any exit rule, does not touch paper, does not alter sizing, and does not chase
the tail. It makes the *first defensive tranche* fill early and independently in live execution —
the one thing the wallet crucible showed flips the small wallet from ruin to compounding.
