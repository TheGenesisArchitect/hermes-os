# GO-LIVE GATE — pre-committed before any real capital

Written 2026-07-15 while the system is paper-only, so the criteria cannot be
bent in the excitement of a green afternoon. The live lane does not open until
**every** gate below reads PASS, and it closes automatically on the kill
criterion. Edits to this file after go-live require a full paper re-qualification.

## The gate (all must pass, measured on the CURRENT code)

| # | Criterion | Threshold | Why |
|---|---|---|---|
| G1 | Paper expectancy | Realized P&L **> 0 over a rolling 24h window** containing **≥ 150 closed positions**, net of convex slippage + fees | One green hour is variance; a full day-night cycle spans both regimes |
| G2 | Rug tax covered | Banked profit (TP + trails + harvests) **≥ 2× dust-rug losses** in the same window | The rug tax is the irreducible cost; edge must pay it twice over |
| G3 | Breaker quiet | **0 circuit-breaker trips** in the window | A tripping breaker means variance still exceeds the bankroll's tolerance |
| G4 | No unexplained artifacts | 0 phantom P&L events (feed-artifact class) in the window | Every prior release surfaced one; a clean window is the burn-in proof |
| G5 | Sell-route verification | Honeypot probe affirmatively verifying (Jupiter reachable, `LIVE_REQUIRE_HONEYPOT_VERIFIED=true` honored in the live path) | Paper soft-flags inconclusive; live capital must never buy what it cannot provably sell |
| G6 | Wallet hygiene | Throwaway wallet via `ops/live/generate-wallet.mjs`, funded ≤ $60, key exists ONLY in gitignored `.env` | Hot key on a desktop — pocket change only |

## Live-lane hard caps (code-enforced, already in config)

- `LIVE_MAX_POSITION_USD = 25`
- `LIVE_MAX_CONCURRENT = 2` (max exposure $50)
- `LIVE_DAILY_LOSS_CAP_USD = 50`
- Live entries restricted to the confirmed-recorder path (no blind lane),
  rug-model sizing active, `bags-fm` blocked, honeypot hard-verified.

## The kill criterion (pre-committed, non-negotiable)

If the live lane's cumulative realized P&L reaches **−$50** (one daily cap) OR
**20 live closes** complete with negative cumulative expectancy, the live lane
**halts itself and reverts to paper-only**. Re-opening requires a fresh pass of
G1–G4 on the paper book. No mid-drawdown threshold edits; no "one more day."

## Current status (2026-07-16)

- G1–G4: **measuring** — the current management stack (TP ladder, post-bank
  leash, venue-split stop, rug-model sizing, prime ponds) went fully live
  ~22:45Z 2026-07-15; the qualifying window continues.
- G5: **PASS.** GoodbyeDPI service reconfigured to `-9` (max evasion) and
  running as Auto-start — this defeated the DPI filter that `-5` could not,
  and cleared BOTH the Jupiter swap hosts AND the public Solana RPC class.
  Full M5 dry-run ran clean 2026-07-16: quote (0.05 SOL → 3.76 USDC) → build
  (672B tx) → sign (fee payer matches) → real-RPC simulate returned the
  expected `AccountNotFound` for the unfunded ephemeral wallet — the proof
  that everything up to funding works. Boot persistence confirmed (service
  Auto-start, survives reboot).
- G5 watchdog: a **sell-route watchdog** now probes the real live-exit path
  (Jupiter swap quote + RPC getLatestBlockhash) every 20s in the System Health
  drawer. Down while PAPER → amber "go-live blocked"; down while LIVE → critical
  "SELL ROUTE DARK WHILE LIVE" and the overall roll-up flips to `down`. This is
  the mid-session DPI-regression alarm — it fires before a position needs to exit.
- G6: generator script ready; **not yet run** — run it at go-live time, not before.
- M5 live execution code (Jupiter swap build+sign+send): **BUILT** —
  `services/trader/src/live/{wallet,jupiter,executor,dryRun}.ts`, mirror lane
  behind `LIVE_TRADING_ENABLED=false`, hard caps + kill criterion enforced.
