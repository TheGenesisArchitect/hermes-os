# Trade Management System — end to end

Read from the code on 2026-07-21, not from memory. Every exit below is a real
branch in `decideExit` (`services/trader/src/paper.ts`) or in the live guard
(`services/trader/src/live/executor.ts`). **Precedence is top-to-bottom and the
first match wins** — that ordering is where tonight's defects lived.

---

## 1. Entry

```mermaid
flowchart TD
  A[Scout: new pool] --> B[Safety checks<br/>mint auth · rugcheck · holders · honeypot]
  B --> C[Recorder watches<br/>poll every 6s, 15m window]
  C --> D{Entry window<br/>2.0-3.0m<br/>+1 poll slack}
  D -- no --> C
  D -- yes --> E{Gate<br/>mark >= 1.35x ref<br/>dd <= 40%<br/>buys >= 40%<br/>vol accelerating<br/>not a vertical}
  E -- fail --> C
  E -- pass --> F[ROUTE by ownership + trajectory]
  F --> G{Signature}
  G -- draining pool<br/>or >= $30k liq --> RUG[RUG_RISK<br/>REFUSED, never opens]
  G -- pool +50% AND >= $5k --> CL[CLIMBER]
  G -- thin/low-buyshare/dipped --> M[MOON graded by snap RATE<br/>violent 400+/min · fast 150-400 · steady 50-150 · slow under 50]
  G -- buy share >= 80% --> RI[RISER]
  G -- else --> BA[BASE]
  CL --> H[CONVICTION 0-2 stars<br/>holders 100-250 · top10 under 5% · crowd-held · winner-rep wallets]
  M --> H
  RI --> H
  BA --> H
  H --> I[SIZE = capital x frac<br/>frac = 1%..5% by stars x class multiplier<br/>paper: bankroll · live: wallet balance]
  I --> J{Class snap bar<br/>RISER +15% · BASE +20% · MOON +35%}
  J -- fail --> C
  J -- pass --> K[OPEN both lanes<br/>same signal, same instant]
```

**Both lanes fire from the same point.** Live is called from inside
`openFromSignal` the moment paper's size is known, and receives paper's
**realised fraction of capital** so relative risk matches by construction.

---

## 2. Management — the exit ladder, in precedence order

Evaluated every **2 seconds** per open position. First match wins.

```mermaid
flowchart TD
  S[Every 2s: mark position] --> R1{1 · CLOCK<br/>age >= class horizon<br/>762s · moons 420s}
  R1 -- yes --> X1[runner_timeout · sell 100%]
  R1 -- no --> R2{2 · time_floor<br/>DISABLED for routed}
  R2 --> R3{3 · fast_scratch<br/>DISABLED globally}
  R3 --> R4{4 · TP LADDER<br/>peak crossed a rung?}
  R4 -- yes --> X2[take_profit_0/1/2<br/>sell to cumulative target]
  R4 -- no --> ARM{5 · ARMED?<br/>peak >= ARM_MULT}
  ARM -- yes --> R5{5a · STALE TAKE<br/>no new high 3m<br/>AND price > floor}
  R5 -- yes --> X3[stale_take · sell 100%]
  R5 -- no --> R6{5b · TRAIL<br/>price <= max of<br/>entry x FLOOR_MULT<br/>and peak x 1-w}
  R6 -- yes --> X4[profit_trail · sell 100%]
  ARM -- no --> R7{5c · COVER<br/>price <= entry x 1-cover}
  R7 -- yes --> X5[hard_stop · sell 100%]
  R6 -- no --> R8{6 · stop_time 6h}
  R7 -- no --> R8
  R8 --> R9{7 · stop_flat<br/>DISABLED for routed}
  R9 --> R10{8 · stop_volume<br/>5m pace under 20% of hourly}
  R10 -- yes --> X6[stop_volume · sell 100%]
  R10 -- no --> S
```

### The trail width — a ratchet that tightens as the move grows

| peak (entry-relative) | trail width | rationale |
| --- | --- | --- |
| below top rung | class trail (25–45%) | normal breathing |
| 3.2–8× | 40% | still developing, don't shake out |
| 8–20× | 28% | proven runner, start defending |
| 20×+ | 18% | rare gain, defend hard |

The floor itself always ratchets — it is `peak × (1 − w)` and peak only rises.

---

## 3. The precedence traps — where tonight's losses came from

**`ARMED` is a switch, not a threshold.** Once `peak >= ARM_MULT`, the class
**cover stops applying entirely** — branch 5c is the `else` of 5. From that
moment the only downside protection is `max(entry × FLOOR_MULT, trailFloor)`.
Setting `FLOOR_MULT` to the cover looked equivalent and is not: it let the trail
walk a green position to −30%.

**A percentage trail guarantees a loss below `1 ÷ (1 − w)`.** At w = 45% that
threshold is **1.82×**. Any position peaking under it and trailing out closes
red *by construction*. Audited: 12 `profit_trail` exits, avg peak 1.28×, avg
exit 0.66×, **−$15.47** — the largest loss pool in the book.

**`stale_take` outranks the trail** and is gated on `price > entry × FLOOR_MULT`.
With `FLOOR_MULT` at the cover, "take" could fire at 0.41× — a 59% loss labelled
as a profit-take.

**Disabling one knob can disable a mechanism sharing its branch.** Setting the
profit-lock arm to Infinity to remove the never-close-red ratchet also removed
**the entire trailing stop** — they live in the same `if (armed)` block. Result:
no trail at all, every exit fell through to the clock, runners gave back 68–78%.

---

## 4. Live lane — same genome, different execution

```mermaid
flowchart TD
  G0[Guard, every 15s] --> G1[Read token balance on-chain]
  G1 -- RPC error --> SKIP[skip this cycle]
  G1 --> G2{balance = 0?}
  G2 -- yes --> E1[live_desync_empty · close ledger row]
  G2 -- no --> G3[Sell-route quote = the real mark]
  G3 -- no quote --> G4{past its clock?}
  G4 -- yes --> E2[FORCE exit · strand write-off if it fails]
  G4 -- no --> SKIP
  G3 -- quote ok --> G5[decideExit · IDENTICAL function, class config]
  G5 -- decision --> E3[liveSellPosition]
  G5 -- none --> G6[legacy guard · unrouted rows only]
  G0 --> H[Basket harvest over live's OWN book]
```

Live differs from paper in exactly three ways, all deliberate: it marks from a
**real sell-route quote** (better than a price feed), it carries **solvency
caps** paper has no need for (kill switch, daily loss cap), and its fills face
real slippage.

**The `no quote → skip` path was the worst bug of the session.** For a rugged
token the quote fails *every* cycle, so `decideExit` was never reached and the
position could not exit by any route — seven positions stranded 20–73 minutes
past their clocks and were written off by hand for $19.88.

---

## 5. Open items

- **The profit-lock restoration (arm 1.03 / floor 1.02) is written but NOT
  committed.** Until it ships, the trail can still exit a winner red.
- `stale_take` inherits `PROFIT_LOCK_FLOOR_MULT`; it is fixed by the same change
  but has never been audited on its own.
- `basket_harvest` and `stop_volume` are book-level rules that have never been
  measured per signature.
- The learning loop simulates **four** mechanisms (cover, trail, ladder, clock).
  Everything else on this page is unmodelled, so promotions are fitted to a
  simpler system than the one that runs.
