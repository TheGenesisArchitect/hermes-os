# Live Wallet — Full Autopsy Since Launch

**Prepared 2026-08-03 · companion to AUDIT-PACKAGE-2026-08-03.md**
Every number reproducible from `positions` (lane='live') + `audit_log`;
pre-relaunch era preserved in `positions_live_archive_20260720`.

## Headline
| Era | n | P&L | Green |
|---|---:|---:|---:|
| Pre-relaunch archive (→07-20) | 72 | −$56.06 | — |
| Current book since 2026-07-20 | 452 | **−$273.67** | 169 (37%) |
| **All-time total** | **524** | **−$329.73** | — |

## Where every dollar went (current book, by exit class)
| Exit | n | P&L | Reading |
|---|---:|---:|---|
| **live_unsellable** | 62 | **−$168.60** | THE loss engine: 62% of all losses. Pools drained before any exit could fill — adversarial LP pulls, mostly meteora-damm-v2 (37) + pumpswap (21). Root causes fixed in sequence: no live drain cut (fixed 08-02), zero-quote exit freeze (fixed 08-02), frozen-slot floor blocks (fixed 08-02). Post-fix unsellables cost fees-to-ticket, not frozen days. |
| hard_stop | 66 | −$62.47 | Ordinary losers pre-floor-era; −$0.95 avg — bounded, working. |
| floor_45 | 17 | −$21.68 | The −45% standard: binds drawdowns; the −100% outliers here were removals (no bid at floor), the standard's stated limit. |
| runner_timeout / sweeps / misc | ~90 | −$40 | Management closes, small avg. |
| depth_collapse_cut | 75 | −$1.33 | The best defensive rail in the book: 75 cuts, near-zero cost. |
| profit_trail + winners | 142+ | +$17 → | The winner engine exists but banked ~25% of offered moves (capture gap). |

## The three eras (weekly cut)
| Week | n | P&L | Unsellables | What was true |
|---|---:|---:|---:|---|
| 07-20 | 351 | −$177.64 | 44 | Mirror-era: every paper class traded live, no QUALIFY gates, exits unproven. Tuition era. |
| 07-27 | 98 | −$88.36 | 18 | Gates accreted (some miscalibrated: strategy-region regression, drift veto); exit machinery defects found and fixed live (zuckbot, JORDAN, BROKER). |
| 08-03 | 3 | −$7.67 | **0** | Current stack: certified exits, manifest v3, all drains floor-bounded ($0.67–3.90). Losses now cost 4–6× less than identical paper trades. |

## The verdict engineering must own
1. **Execution is solved and provable**: sub-2s chambered exits, floors that
   refuse donation, chain-true books, zero frozen slots, certification tool
   green 6/6 against the live tape. Late-era drains cost ticket-bounded fees.
2. **Selection is not solved**: entry-knowable features (crowd, class, venue,
   envelope, durability-by-shape — the last tested and rejected) have been
   defeated 4-for-4 by manufactured pools in the final session. The rug-
   adjusted edge measured on paper's tape has not yet survived contact live.
3. **Every loss is attributed** — no unexplained dollars. The counterfactual
   ledger (refusals judged by paper twins) and 12+ replay harnesses turned
   every hypothesis this week into a same-day verdict, including three of the
   engine's own designs (lock-in, C3, coverage gap — all killed by evidence).
4. **Open strategy question for the auditors**: what adversary-side signal
   (deployer funding graphs, LP-provision fingerprints, bundle patterns)
   separates manufactured pools from real ones BEFORE entry? That is the
   entire remaining distance between these rails and a positive equity curve.
