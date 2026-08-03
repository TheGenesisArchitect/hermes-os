# Live Wallet — End-to-End Audit Package

**Prepared 2026-08-03 for Sr. Engineering review · `main` @ `6e41e04`+**
Live lane is STOOD DOWN (operator kill, reason in config `live_kill`) — audit
proceeds against a flat book with chain-true accounting.

## Scope — the live wallet codebase
| Component | Path | Role |
|---|---|---|
| Live executor | `services/trader/src/live/executor.ts` | entry gates, sizing, buys, guard loop, sell path, sweeps |
| Presigned sniper | `services/trader/src/live/presigned.ts` | durable-nonce chambered exits |
| Swap router + providers | `services/trader/src/live/swap/` | side-scoped breakers, quoteValue (executable marks), best-sell, per-venue builders |
| Formula Manifest | `services/trader/src/live/manifest.ts` | ratified selection-as-data, pure verdict (v3 in config `formula_manifest`) |
| Optimizer (L1) | `services/trader/src/live/optimizer.ts` | hourly rug-adjusted recompute → proposals; PSI drift (proposal governance only) |
| Runtime state | `services/trader/src/live/state.ts` | chamber/latch/exclude/peak persistence (GTPED P3) |
| Invariants | `services/trader/src/live/invariants.ts` | pure predicates (latch, impact units, close verdict, failure classify) |
| Shared exit genome | `services/trader/src/paper.ts` (`decideExit`) | both lanes' exit brain; live drain cut fires first |
| Tick loop | `services/trader/src/index.ts` | cadence, kill polling, service wiring |
| Certification tool | `services/trader/src/tools/sell-certify.ts` | mark/quote/build proof vs live tape |
| Harnesses | `packages/db/replays/` (formula-manifest, formula-combo, manager-forecast, manager-crest-grid, lockin-replay, durability-harness, manifest-watch) | every ratified decision's evidence, reproducible |

## Governing documents
`docs/GTPED.md` (doctrine + §7 compliance) · `docs/QTEA-RESPONSE-2026-08-02.md`
(scorecard: 8 fixed / 4 partial / 3 open) · `docs/SPEC-INSTITUTIONAL-LIVE-LANE.md`
(v1.1 target architecture + autonomy ladder) · plan file: EV Allocation Engine.

## Verify before reading a line
```
pnpm --filter @hermes/trader typecheck && pnpm --filter @hermes/trader test   # 44/44
npx tsx packages/db/replays/formula-manifest.ts        # rug-adjusted promotion tables
npx tsx services/trader/src/tools/sell-certify.ts      # live-tape exit certification
```
Reconciliation first, always (QTEA): books vs chain queries in
`.claude/skills/qtea/SKILL.md`.

## Honest open items (do not let us grade our own homework)
QTEA-003 partial (meteora/curve reserve-math valuation absent) · QTEA-007/008
partial (urgency breaker dim, route scoring) · QTEA-012 (non-transactional
projection) · QTEA-015 (global state TTL) · `poolpeak` unwired ·
chamber-consulted-but-not-fired on fast drains (ZOO/Website, uninvestigated) ·
decision_packet/twin/attribution engine spec'd, not built · THE OPEN STRATEGY
QUESTION: 0-for-4 elite seats 2026-08-03 — entry-knowable selection is being
defeated by manufactured pools; execution stack proven, selection edge on this
week's pumpswap flow unproven. Live P&L all-time ≈ −$260; the system's claims
are about rails and instrumentation, not realized alpha. Audit accordingly.
