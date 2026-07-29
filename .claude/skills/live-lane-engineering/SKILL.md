---
name: live-lane-engineering
description: The gold-standard doctrine for building frictionless live buy/sell lanes — load when touching live execution, exits, sizing floors, or lane plumbing. The mirror masterpiece spec.
---

# Live-Lane Engineering — the Gold Standard

**Mission (operator, 2026-07-29):** the paper thesis is REAL — 7/10 greens
validates the trend, no trade gives up more than 45% as a standard, moons
caught clean. The masterpiece is a live lane that MIRRORS it. Every rule here
came from a live receipt, not a theory.

## The structural truth

Paper exits at marks. Live exits at the pool's permission — and on unlocked-LP
pools that permission belongs to the adversary (97% of live's catastrophic
losses carried the scout's own "LP Unlocked" flag). The lane is engineered to
remove permissions, one dependency at a time.

## The laws (each with its receipt)

1. **The −45% standard.** Pre-bank catastrophic floor arms at −25% mark
   (`STANDARD_FLOOR_ARM_MULT=0.75`, both lanes, `floor_45` protective class);
   the 15–25pp protective-execution delta spends the rest of the budget.
   Realized ≤ −45% by arithmetic. Post-bank, the ladder owns the ride.
2. **Bank basis first on unlocked LP.** LP-state prices the trade: locked →
   normal seat; unlocked → the defensive tranche covers cost basis in the
   first minutes while the pool is provably deep. After basis banks, a pull
   costs profits, never principal. (Wallet Crucible law; LP data already in
   `safety_checks.evidence` rugcheck risks.)
3. **Sells never wait.** No preflight simulation on ANY sell (4 of 6 fails
   were our own sim; 25s avg fail→exit; a user_cut queued behind a sim).
   Protective classes: 3× priority fee, first tolerance ≥2000bps, rebroadcast
   every poll while the blockhash lives.
4. **Live seats are always watched.** ws pool subscriptions: live positions at
   absolute priority, never unsubscribed while open (CLARITY died unwatched).
   Drain guard fires on chain truth (ws ≥25% drop/30s), aggregator is fallback.
5. **Never sit down without a way out.** Sell-route probe at boarding for
   strand-class entries; depth floors; venue rug-tide stand-downs; clone-wave
   refusal (verify no door bypasses it — the retrial did).
6. **Landing is bid for, not hoped for.** Direct-build priority ≥0.0005 SOL,
   client rebroadcast, landMs + provider audited per fill (16 fails/day → 0).
7. **The band prices the size; the crowd prices the entry.** Strong ≥1.30×
   boosted; everything below sized ×0.6 regardless of crowd. Probe/explore
   budgets are information spend, never model P&L (book split).
8. **Every decline is audited; every metric knows its fence era.** Silent
   declines are defects; trailing stats that cross a fence-change timestamp
   are stale blends and must say so.

## The sniper build (durable-nonce pre-signed exits) — DESIGN, chain-test before arming

Goal: collapse the flee to a single `sendRawTransaction` — zero quote, zero
build, zero sign at fire time.

- One **durable nonce account** per live slot (rent ≈0.0015 SOL each), created
  lazily, pubkeys persisted in `config` key `presigned_nonces`.
- On every live fill: quote+build the FULL-EXIT sell (fraction 1) with
  `minOut ≈ 0.40 × cost basis` (the −45% standard embedded on-chain — a fill
  worse than the standard fails atomically and falls back), rebuild the
  message with `advanceNonce` as ix[0] and `recentBlockhash = nonce value`,
  sign, store `{positionId → signedTx}`.
- Refresh triggers: qtyRemaining changed (TP banked) · provider route changed ·
  every ~5 min housekeeping. Nonce makes expiry a non-issue between refreshes.
- Fire path: guard/stop/floor_45 → submit stored tx immediately (skipPreflight,
  3× fee versions pre-built) → on failure fall back to the live quote path.
- Versioned-tx caveat: decompile with address-lookup accounts fetched before
  prepending the nonce ix; legacy txs prepend directly.
- **Arming gate:** `LIVE_PRESIGNED_EXITS` env flag, default false. Chain-test
  on devnet-or-one-live-ticket with operator watching before default-on.

## Validation gates (operator spec)

- Rolling 10 live closes: **≥7 green**, every red **≥ −45% realized**, zero
  unsellables through the entry doors, moons captured by the late-arm ladder.
- Twin drag (pp vs paper, same mint) is THE lane metric — drive it to zero.
