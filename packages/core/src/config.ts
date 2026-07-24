import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().default("postgres://hermes:hermes@localhost:5433/hermes"),
  HELIUS_API_KEY: z.string().optional().default(""),
  // Route RPC calls through Helius (headroom) vs the public fallback. Set false
  // to spare Helius credits — e.g. when the free-tier allowance is exhausted.
  HELIUS_RPC_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v === "true"),
  // Start the Helius WebSocket push stream. Disable to run poll-only (the
  // GeckoTerminal backstop still covers ingest) — the stream firehose is the
  // main Helius credit sink.
  STREAM_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v === "true"),
  SOLANA_RPC_URL: z.string().default("https://solana-rpc.publicnode.com"),
  // RPC FAILOVER — comma-separated additional endpoints. The primary (rpcUrl) is
  // tried first, then these, then keyless public fallbacks. Removes the RPC as a
  // single point of failure once Jupiter is no longer the dependency.
  RPC_URLS: z.string().default(""),
  // Self-hosted Jupiter Swap API base (e.g. http://localhost:8080/swap/v1). Empty
  // = provider dormant (router skips it). Set once the jupiter-swap-api container
  // is up (see docs/SWAP_ROUTE_RESILIENCE_SPEC.md) → live execution survives a
  // Jupiter hosted-API outage on our own uptime.
  JUPITER_SELFHOSTED_URL: z.string().default(""),
  // Fluxbeam swap API — an INDEPENDENT (non-Jupiter) swap route for Fluxbeam-
  // routable tokens (our 'fluxbeam' premium venue). Verified shapes:
  //   GET  /v1/quote?inputMint&outputMint&amount&slippageBps → { quote: {...} }
  //   POST /v1/swap  { quote, userPublicKey }                → { transaction }
  // Keyless. Gives real failover against a Jupiter outage for fluxbeam tokens.
  FLUXBEAM_API_URL: z.string().default("https://api.fluxbeam.xyz/v1"),
  FLUXBEAM_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  // PumpPortal trade-local — an INDEPENDENT (non-Jupiter) route for pump.fun /
  // pumpswap tokens (the dominant flow). Keyless, non-custodial: returns a
  // ready-to-sign transaction. Covers exactly the venues Jupiter's outage strands.
  PUMPPORTAL_URL: z.string().default("https://pumpportal.fun/api"),
  PUMPPORTAL_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  PUMPPORTAL_PRIORITY_FEE: z.coerce.number().default(0.00005), // SOL priority fee for the trade tx
  PUMPPORTAL_POOL: z.string().default("auto"), // auto | pump | pumpswap | raydium
  // Direct PumpSwap AMM route (via @pump-fun/pump-swap-sdk). The ONLY route that
  // reaches paper's actual winners — graduated PumpSwap pools for OTHER-origin
  // tokens (Meteora-DBC/bags), which Fluxbeam ("no pool") and PumpPortal (pump.fun
  // -only, 400) both miss. Built swaps against the pAMM program, keyless, works on
  // this DPI host through the curl-fallback RPC. Slots ahead of PumpPortal.
  PUMPSWAP_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  BIRDEYE_API_KEY: z.string().optional().default(""),
  JUPITER_BASE_URL: z.string().default("https://lite-api.jup.ag/swap/v1"),
  // Real-time (block-level) USD price feed — keyless, fresher than DexScreener's
  // aggregated price, which lags (Soly's peak "held" 40s on DS while the real
  // price was already falling). Used as the MANAGEMENT mark so exits fire on the
  // true price. Accepts comma-separated ids → one call prices every open position.
  // datapi.jup.ag reaches through the host's SNI-DPI filter (via GoodbyeDPI) where
  // lite-api/api/price.jup.ag do not; it exposes live baseAsset.usdPrice. See jupiter.ts.
  JUPITER_PRICE_URL: z.string().default("https://datapi.jup.ag/v1/pools"),
  ANTHROPIC_API_KEY: z.string().optional().default(""),

  SCOUT_POLL_MS: z.coerce.number().default(45_000),
  SCOUT_MIN_LIQUIDITY_USD: z.coerce.number().default(10_000),
  SAFETY_TOP10_MAX_PCT: z.coerce.number().default(25),
  SAFETY_SINGLE_HOLDER_MAX_PCT: z.coerce.number().default(5),
  SAFETY_MAX_PRICE_IMPACT_PCT: z.coerce.number().default(15),
  SAFETY_MIN_ROUNDTRIP_RATIO: z.coerce.number().default(0.6),

  SIGNAL_MIN_SCORE: z.coerce.number().default(55),
  SIGNAL_MAX_AGE_MIN: z.coerce.number().default(20),

  // Entry aperture. We used to hard-block bags-fm ("0-for-16") and cap
  // liquidity at $50k — but the 1c data showed bags-fm produced 11 of the 16
  // movers and McGwegor's 327x came from a $25k meteora-dbc pool: those weren't
  // bad sources, our EXIT round-tripped them (now fixed by the ratcheting
  // trail). So the blocklist is empty by default and the ceiling is generous
  // (excludes only untradeable mega-caps). Risk is carried by trap-only safety +
  // tier sizing + the trail, not by refusing proven opportunity. 0 disables each.
  ENTRY_BLOCK_DEXES: z
    .string()
    .default("")
    .transform((v) => new Set(v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))),
  ENTRY_MAX_LIQUIDITY_USD: z.coerce.number().default(1_000_000),
  // Risk-tier position sizing — a soft safety flag shrinks the bet instead of
  // vetoing it. clean = full size; caution (1 flag) and speculative (2+ flags)
  // take a smaller shot so the convex upside is still on the table with capped
  // downside. Fitted from Recorder outcomes later; sane priors for now.
  RISK_SIZE_CAUTION: z.coerce.number().default(0.6),
  RISK_SIZE_SPECULATIVE: z.coerce.number().default(0.35),
  PAPER_BANKROLL_USD: z.coerce.number().default(1_000),
  PAPER_POSITION_USD: z.coerce.number().default(100),
  // Cap on concurrent open paper positions. Run 1g opened 24 unbounded, deployed
  // into a book of confirmation-entries that mostly faded, and the aggregate
  // unrealized drawdown tripped the breaker in ~30 min. A cap deploys gradually,
  // bounds the drawdown, and lets a run survive long enough to be a real sample.
  // Raised 16→24 (2026-07-14): capacity_full was the #1 capture killer — 190
  // hits in 48h vs 16 lane_full; only 38% of ARMED winners got entered because
  // the book was full when they confirmed. 24 × $17.50 ≈ $420 max committed of
  // the $1k bankroll; every gated entry is +EV (sim +$3.97/pos), breaker guards
  // the drawdown. Works with slot displacement (DISPLACE_*) below.
  PAPER_MAX_CONCURRENT: z.coerce.number().default(24), // global backstop = sum of the lane caps
  // TIERED CAPACITY LANES. A single global cap let the abundant small movers
  // (1.25–2x) fill every slot, so a rare 10x+ candidate armed into a full book
  // and was deferred to death (0 of 4 entered in run 1h). Each opportunity CLASS
  // now gets its OWN reserved capacity so tiers never compete for a slot. The
  // class is assigned at entry from the observable convexity fingerprint
  // (liquidity band + source), which is the best proxy we have for the eventual
  // multiple — the peak itself is only knowable after the fact.
  // RESERVED-MINIMUM / SHARED-MAXIMUM. Hard per-lane caps would turn a high-flow
  // lane's candidates away while another lane sits idle — strictly FEWER trades.
  // Instead each lane is GUARANTEED a minimum (so the scarce thin fat-tail lane
  // is never crowded out), and all lanes SHARE the surplus up to the global cap
  // (so no slot ever sits idle). Reserves sum to 10; the other 6 float to
  // whichever lane has flow. A lane may open if total < PAPER_MAX_CONCURRENT and
  // taking the slot wouldn't starve another lane's still-unmet reserve.
  LANE_MOONSHOT_MIN: z.coerce.number().default(4), // guarantee the thin convex fat-tail (167x zone) always has room
  LANE_CORE_MIN: z.coerce.number().default(4), // mid pools — where most 3x+ land numerically
  LANE_BASE_MIN: z.coerce.number().default(2), // deep grinders — smallest guarantee
  LANE_MOON_LIQ_MAX: z.coerce.number().default(60_000), // moonshot = thin fat-tail zone (3x+ tier's liq p25 ≈ $28k); calibrated on trigger-window data
  LANE_CORE_LIQ_MAX: z.coerce.number().default(200_000), // core ceiling (3x+ median liq ≈ $128k lands here); above = base grind
  // Sources whose bonding-curve / graduation mechanics produce the convex 10x+
  // runs. Matched as a substring of the dexId, so "dbc" catches meteoradbc etc.
  LANE_MOON_SOURCES: z
    .string()
    .default("dbc,pump,bonding,bags,moonshot,dyn")
    .transform((v) => new Set(v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))),
  // 20s → 5s (2026-07-20). We were sampling a ~20s armed window with a 20s scan
  // and a 20s freshness cap — alignment was a coin flip, and short-armed
  // candidates were missed systematically. Short-armed is exactly what a fast
  // climber looks like: it spikes, dips past the DD gate, disarms. Ballerina
  // armed at 22:20:00, disarmed ~20s later, peaked 3.49× and was never traded.
  // The entry scan is three local Postgres queries — no external API — so 12/min
  // instead of 3/min is free. Matches the manage cadence.
  // 5s → 2s (operator, 2026-07-23: "the fastest horse out of the stable —
  // timing is everything"). The scan poll was the single largest controllable
  // slice of live's entry latency: up to 5s of a 12-second spike spent waiting
  // to even look. DRILLCAT's 11s lag = scan wait + serial gates + swap+confirm.
  TRADER_POLL_MS: z.coerce.number().default(2_000), // cadence for SCANNING/opening new entries
  // Cadence for MANAGING open positions — the exit is where gains are kept or
  // lost, so it runs far tighter than the scan loop. Soly gave back 68% of its
  // move because 20s between looks let it roll 1.78x→1.25x unseen; the deaths
  // that showed 1 tick died inside a single 20s gap. Keyless DexScreener, so we
  // can poll hard. (DexScreener's own aggregation lag is the deeper ceiling — a
  // real-time Jupiter mark is the next lever if this isn't tight enough.)
  // 5s → 2s (2026-07-21). The TP ladder can only fire on an OBSERVED tick, so
  // sampling rate is a hard ceiling on how much of a move we capture. ALIVE
  // [MOON_FAST] peaked 1.60×, cleared its 1.25× rung, and still banked nothing —
  // the entire run and collapse happened between two 5s looks, so 1.25 was never
  // seen in either direction. That class peaks ~1.6min after entry, which at 5s
  // is only ~20 observations for the whole life of the trade.
  // Batched fetch, so request volume does not scale with book size.
  MANAGE_POLL_MS: z.coerce.number().default(2_000),
  TP_MULTIPLIER: z.coerce.number().default(2),
  TP_SELL_FRACTION: z.coerce.number().default(0.5),
  // Ratcheting profit-trail — the core defender. Goal: MAXIMIZE every
  // opportunity, never cut a moonshot. We do NOT pre-sell. Instead, once a
  // position shows real green (peak >= ARM_MULT) the stop leaves the -HARD_STOP
  // zone and becomes a ratchet that only moves UP: the higher of a locked
  // profit floor (FLOOR_MULT above entry) and a trailing floor at (peak -
  // trail%). The trail is TIGHT at low multiples so a 1.3x that rolls over still
  // exits GREEN on the full position (the micro-win 1c never captured), and WIDE
  // once it proves a runner so a normal memecoin pullback can't shake us out of
  // a 100x. A confirmed RIDE from the classifier widens it further; blow-off /
  // stall exhaustion snugs it up to bank near the top — full size, no cap.
  // "Move the stop into profit, trail, let winners run, stalk the win."
  // AGGRESSIVE SCALP (2026-07-14): ignite the floor EARLY and never walk away red.
  // The moment a position is up +8% ("ignition") the stop ratchets to a breakeven+
  // floor (1.02x ≈ flat after fees) — an ignited trade can dip back to breakeven to
  // breathe/re-run toward a moonshot, but it NEVER returns to a loss. Below +8% it's
  // still a fresh entry on the pre-ignition hard stop.
  // ARM LOWERED 1.08 → 1.03 (2026-07-20). There was NO floor between 0% and +8%:
  // a position that rose from a 1.35× entry to 1.40× was green and completely
  // unprotected, defended only by the 5% hard stop BELOW entry. The downside is
  // already covered — the hard stop exists precisely for that — so the floor's
  // job is to make sure a trade that went green does not come back red. Arm it
  // the moment the move is real (+3%) and lock +2%. This does not cap runners:
  // the effective stop is the HIGHER of this floor and the trailing floor, so a
  // position making new highs is still governed by the trail, which widens as it
  // runs. It only closes the dead zone where we previously had nothing.
  PROFIT_LOCK_ARM_MULT: z.coerce.number().default(1.2), // the first rung — +3% is noise, not "green"
  PROFIT_LOCK_FLOOR_MULT: z.coerce.number().default(1.02),
  // Once armed, the floor locks THIS SHARE OF THE GAIN rather than sitting at
  // breakeven. A fixed 1.02 floor means a trade can climb 20% and still exit
  // flat — the stop is max(1.02, peak×(1−w)) and peak×0.72 doesn't clear 1.02
  // until peak 1.42×, so everything from 1.20 to 1.42 scratches out. Replayed
  // over the 30 real tapes of trades we scratched: floor 1.02 → −$23.14, lock
  // 50% → +$10.18, lock 65% → +$16.50, lock 85% → +$8.92 (too tight, hands the
  // exit back to the trail). All the gain-locking variants are positive and all
  // the breakeven variants negative, so this is a plateau, not a fitted point.
  PROFIT_LOCK_GAIN_LOCK: z.coerce.number().default(0.65),
  // TIME-BASED FLOOR — the operator's model: the floor goes under the trade at
  // ~3.5min of watch time, i.e. roughly 90s after a 2-2.5min entry, REGARDLESS
  // of how far price has moved. The price-triggered lock (above) only arms once
  // a position reaches +3%, so a trade that drifts sideways at 1.01× carries no
  // floor at all and can still round-trip into a loss. After this long the trade
  // has had its chance: protect breakeven and let the trail govern anything that
  // is actually running. Set 0 to disable.
  TIME_FLOOR_AT_SEC: z.coerce.number().default(90),
  TIME_FLOOR_MULT: z.coerce.number().default(1.0), // breakeven-or-better once armed
  // TAKE-PROFIT ON THE WAY UP — the missing mechanism. A trailing stop only fires
  // on a gradual PULLBACK; a token that pumps then rugs ATOMICALLY from the peak
  // (LP pulled in one block) never trades back through the stop with liquidity, so
  // the trail banks nothing and the whole position dies at $0. The fix is to SELL
  // INTO STRENGTH: bank the bulk at fixed profit targets while the pool is still
  // deep, and let a runner ride uncapped for the moonshot tail. Calibrated on the
  // 21/21-rug window: 17 ignited ≥1.15x and 9 crossed 1.5x on real liquidity — all
  // capturable on the way up, all booked $0 under trail-only. This does NOT cap the
  // moonshot: TP2_CUM_SELL leaves a runner that trails uncapped per [[maximize]].
  TAKE_PROFIT_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  // TP0 — first tranche BELOW TP1. Replay of 408 confirmed rugs vs 374 winners
  // (re-anchored at the ≥1.25x confirm tick where we enter): 62% of rugs reach
  // 1.15x on the blow-off top BEFORE the LP-pull (we bank $0 on them today),
  // while 98% of winners clear 1.15x and keep running to ~1.9x avg. So a 40%
  // tranche here converts the majority of the rug bucket from full loss to
  // partial and barely grazes winners — the 60% runner still rides the tail.
  TP0_MULT: z.coerce.number().default(1.15), // +15% — bank the first tranche into the blow-off
  TP0_CUM_SELL: z.coerce.number().default(0.4), // cumulative fraction of ORIGINAL size sold once TP0 is hit
  TP1_MULT: z.coerce.number().default(1.3), // +30% from our entry — bank half here
  TP1_CUM_SELL: z.coerce.number().default(0.5), // cumulative fraction of ORIGINAL size sold once TP1 is hit
  // LOWERED 1.70 → 1.58 (2026-07-20): the top rung sat ABOVE where the tape
  // actually turns. Movers peak at 1.62× on average, so most winners never
  // reached TP2 at all — they banked 50% at TP1 and rode the other half back
  // down. Measured capture of the peak move was −0.128 (avg exit 1.19× from an
  // avg peak of 1.62×): we were giving back 43% of every winner, and on 20
  // positions that peaked 1.61× and then rugged, all of it.
  TP2_MULT: z.coerce.number().default(1.58), // bank most of the rest, below the median turn
  TP2_CUM_SELL: z.coerce.number().default(0.8), // total 80% banked by TP2; the remaining 20% rides uncapped
  // DUD CUT — the divergence cull (validated 2026-07-19, +$85/48h fill-realistic). Winners
  // clear the divergence line by ~2.25min (win_p25 crosses above dud_p75); duds sit flat.
  // A position whose PEAK hasn't cleared DUD_CUT_MARK by DUD_CUT_AGE_MIN never followed
  // through — cut it while it's still liquid, before it bleeds to the hard-stop. Peak-based
  // so a proven lifter (peak already cleared the line) is NEVER cut. Tune both from live.
  DUD_CUT_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  DUD_CUT_AGE_MIN: z.coerce.number().default(2.25), // the divergence line — cut a no-lifter at/after this age
  DUD_CUT_MARK: z.coerce.number().default(1.09), // peak never cleared +9% by the cut age = dud
  // FAST-FLOOR — block-level Jupiter mark on LIFTED positions, SUB-POLLED between the 5s manage
  // cycles so a trailing floor is enforced at ~1s resolution instead of the price gapping through
  // it (the SX runner / 1.10-give-back problem). CRITICAL: it is READ-ONLY on peak — it never
  // ratchets peak from the fast mark (that re-introduces the thin-pool mirage); the manage loop
  // owns peak off DexScreener. It only reads the stored peak, divergence-guards the fast mark vs
  // the last DexScreener read, and fires the floor with last-good liquidity for an honest fill.
  // Ships DARK + LOG-ONLY. Jupiter-routable only (graduated/AMM/pumpswap); bonding-curve (dbc/bags,
  // e.g. SX) have no fast mark → fall back to the 5s loop, so this does NOT help those.
  FAST_FLOOR_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  // ARMED (2026-07-20). This was shadow-logging the exact loss we spent the day
  // chasing: it identifies the bank point at block resolution and then watches
  // the 5s loop ride the position down — its own log says so, "armed sells here,
  // 5s loop rides it down". Observed live: a position where it would have banked
  // +26.8% (floor 1.27x off a 1.38x peak) and instead gave it back. The whole
  // point of a sub-5s sweep is to catch a rollover NEAR the floor rather than
  // gapping through it, and in log-only mode it delivered none of that. Winners
  // are given back in the seconds between manage cycles; this closes that window.
  FAST_FLOOR_LOG_ONLY: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  FAST_FLOOR_MS: z.coerce.number().default(1000), // sub-poll cadence between the 5s manage cycles
  // 1.15 → 1.05 entry-relative (2026-07-20). ENTRY-RELATIVE, not recorder-frame:
  // this is "our position is up 5%", which for a 1.35R entry is ~1.42R — far
  // above the 1.05-1.10R dud zone, since a dud never reaches our fill at all.
  // At 1.15 the sweep sat idle through the population the book actually lives
  // in: positions peak 5-15% above entry, roll over, and gap through the 5s
  // loop. Arming at 1.05 puts the 1-second sweep on them.
  FAST_FLOOR_ARM_MULT: z.coerce.number().default(1.05), // only watch positions lifted past this (in profit)
  FAST_FLOOR_TRAIL_PCT: z.coerce.number().default(8), // fire when the fast mark <= peak * (1 - this/100)
  // FARM-VENUE LADDER — the escalator counter-play. DNA study (2026-07-15, 101
  // dust rugs dissected): 99/101 lived on meteora-damm-v2, pumped a machine-
  // linear ramp (buy-share pinned ~0.78, liquidity growing in lockstep) with
  // 84%/68%/30% reaching 1.15/1.3/1.7x, then died ATOMICALLY at the peak (84/84
  // last-read = 0.99x of peak — no trail can ever catch the cliff). Policy sim
  // on the real cohort: ladder+runner −$522, all-out@1.3 −$63, all-out@1.5
  // −$168, graduated 40/75/100% by 1.7 = +$9.51 — POSITIVE on the rugs
  // themselves. So farm venues get a NO-RUNNER ladder (sell 100% by TP2) and
  // the escalator becomes our paying machine; real-moonshot venues (pumpswap,
  // dbc, fluxbeam…) keep the uncapped runner.
  FARM_VENUES: z
    .string()
    .default("meteora-damm-v2")
    .transform((s) => new Set(s.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean))),
  // FARM take = DUMP-AND-DONE. The atomic-cliff escalator is a trap that rugs even
  // the "winners" (CASHCAT was a 2.91x runner and still went to $0), so on farm
  // tape we sell 100% at the FIRST TP level touched (>=1.15x, ~150s into the ramp)
  // and never ride. Per-position counterfactual over one overnight: dump-100%-at-
  // 1.15 nets −$576 across the farm cohort vs −$1,063 for the old 40%-and-ride
  // (+$487). It caps the fake farm moonshot but NEVER touches real organic runners
  // — this ladder is gated behind isFarmTape; green-cell venues keep the uncapped
  // tail. This is the "150 seconds, in and out, don't investigate a loser twice"
  // doctrine, quantified.
  // FARM LADDER → COST-RECOUP FLOOR (2026-07-20). The 100%-out-at-1.15x dump
  // was earned on the escalator dust-rugs, but it also sold nice (7.61x) in 12
  // seconds for +$1.44 — 7 of the last 20 ≥3x moonshots were farm-classified
  // damm-v2. New shape per the Wallet Crucible's proven insurance floor: TP0
  // banks the COST BASIS (0.87 × 1.15x ≈ 1.0× cost — the position is house
  // money), and the ~13% runner rides the ratchet/trail/stale-take uncapped.
  // Worst case (runner rugs to $0) is breakeven instead of +15%; a 5x final
  // banks ~1.65× instead of 1.15×. TP1/TP2 bank a bit more into strength but
  // never fully cap the tail per [[maximize]].
  FARM_TP0_CUM_SELL: z.coerce.number().default(0.87), // farm: recoup full cost at 1.15x — runner is house money
  FARM_TP1_CUM_SELL: z.coerce.number().default(0.9), // small extra bank into 1.3x strength
  FARM_TP2_CUM_SELL: z.coerce.number().default(0.95), // 5% of tokens always rides uncapped
  // AUTO-FARM — the adaptive layer. The static FARM_VENUES list is a snapshot;
  // the operation can hop venues or rotate new tickers tomorrow. So the farm
  // set also SELF-MAINTAINS from the recorder's own outcomes: any venue or
  // ticker whose last-24h rug share crosses AUTO_RUG_RATE (with ≥ AUTO_MIN_N
  // labeled outcomes) gets the no-runner ladder automatically, and drops off
  // when it cleans up. NOTE: a trajectory-signature detector (ramp linearity +
  // pinned buy-share) was calibrated and FAILED validation (flagged 28
  // non-rugs, 0 rugs) — outcome-rate adaptation is the honest, working layer.
  // 0.5 calibrated against the ~45% base rug rate: catches the full known farm
  // family (W26 58%, USOH 56%, NTFS 51%, USWR 60%, GDWR 62%, CASHCAT 62% + the
  // bags-fm venue at 72%) while dbc/pumpswap/orca (35-43%, moonshot territory)
  // stay clean. Recorder-wide rates run diluted vs our position-level outcomes.
  FARM_AUTO_RUG_RATE: z.coerce.number().default(0.5), // ≥50% of labeled outcomes are rugs
  // FARM BOOK CAP — Law 1 of the winning formula: the pond decides. The EV cell
  // matrix shows meteora-damm-v2 NET-NEGATIVE in every session (prime −$1.33,
  // off −$1.62/trade) yet it was 92% of our volume — the confirm funnel fills
  // with the adversary's product because escalators are BUILT to confirm. Cap
  // farm-tape positions to a minority of the book; the held-open slots wait for
  // organic-venue confirms (pump-amm/dbc/fluxbeam/pumpswap — the only cells
  // that ever paid). Dry powder waiting for the real pond IS the edge.
  FARM_MAX_SLOTS: z.coerce.number().default(8),
  FARM_AUTO_MIN_N: z.coerce.number().default(20), // sample floor — no small-n paranoia
  FARM_AUTO_REFRESH_MS: z.coerce.number().default(300_000), // recompute every 5min
  // BASKET HARVEST — portfolio-level profit capture. Waiting for each position to
  // hit its own target lets rugs pick the book off one by one; harvesting the
  // whole green book at once banks the collective gain BEFORE a rug round-trips
  // it. The moment open positions are collectively up ≥ BASKET_HARVEST_USD on
  // SELLABLE marks, sweep every GREEN position at market, lock the gain, recycle.
  // Reds are excluded (their mark is fiction) and left to the death-exit. This is
  // the automation of the user's manual green-cutting (which banked +$52 on 9
  // cuts while the machine's per-trade TP sat idle). A manual "harvest all green
  // now" fires the same sweep on demand via the harvest_now config flag.
  BASKET_HARVEST_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  BASKET_HARVEST_USD: z.coerce.number().default(30), // net unrealized gain across the open book that triggers a full green sweep
  // Absolute-dollar profit arm. On small positions a +15% arm is slow — a $17.50
  // bet has to move +15% before anything is protected. This arms the "never
  // close red" floor the moment a position has been up this many DOLLARS, so the
  // many small green moves get locked in as base hits (they add up over a 24h of
  // volume) — while the ratcheting trail still rides the real runners uncapped.
  PROFIT_FLOOR_USD: z.coerce.number().default(0.1), // arm the "never close red" lock at +$0.10 (was $1 — never armed on ~$1.75 probe size); lock every trade's floor early, trail still rides highs uncapped
  // Trails TIGHTENED (2026-07-14): "we don't have to lose 35% before we cut — cut
  // at 5%." Give back only 5% from the peak in the 1–2.5x spike zone where most
  // tokens live and rug; the leash only widens for a PROVEN multi-x runner so a
  // real moonshot still isn't shaken out. Aggressive markets → lock profit fast.
  TRAIL_TIGHT_PCT: z.coerce.number().default(5), // < 2.5x spike zone — bank tight, give back only 5%
  // WIDENED on the pre-peak dip signature (2026-07-20). Measured over 4,154
  // labelled tokens, the drawdown a token SURVIVES on its way up:
  //     RUG 0.9% · DUD 5.2% · RISER 7.5% · CLIMBER 22.3% · MOON 35.2% (medians)
  // A 10-18% trail cannot hold a climber, let alone a moon — it survives only
  // rugs and duds, which is precisely backwards. Mid now covers the climber
  // median with room; wide covers the moon median at roughly its p75 (48.5%).
  TRAIL_MID_PCT: z.coerce.number().default(25), // established + still climbing (climber zone)
  TRAIL_WIDE_PCT: z.coerce.number().default(45), // proven runner still printing highs (moon zone)
  // Rugs peak at a median 4.9 minutes; climbers and moons at ~10. Inside this
  // window a token has not distinguished itself, so the leash stays short.
  TRAIL_RUG_WINDOW_MIN: z.coerce.number().default(5),
  // Manage ticks without a NEW HIGH before the trail snugs back to tight. This
  // replaces drawdown as the snug trigger: a dip is the WINNER signature, but a
  // stall is the move ending. ~60s at the 5s manage cadence.
  TRAIL_STALL_TICKS: z.coerce.number().default(12),
  TRAIL_RIDE_BONUS_PCT: z.coerce.number().default(6), // classifier RIDE widens slightly (was 15 — the giveback source)
  // BANK-FIRST-THEN-LEASH: once any TP tranche has banked, the runner is house
  // money — its trail floors here instead of the tight wick-noise width, and a
  // rollover snug clamps to this (not to TRAIL_TIGHT). Unpaid positions are
  // untouched. Rationale: the 5-6.8% tight trail fires inside normal 5s wick
  // noise, exiting 9-90s after entry at breakeven while the token runs 1.3-2.3x.
  POST_BANK_TRAIL_PCT: z.coerce.number().default(12),
  // GAIN-BASED TRAIL — locks a consistent fraction of the RISE instead of a fixed
  // % below price. The %-of-price trail is harshest exactly where most winners
  // live: a 12% price trail on a 1.4× peak gives back 42% of the GAIN, but only
  // ~18% on an 8×. This gives back the SAME fraction of gain at every scale, and
  // does it as BRACKETED slices (like tax brackets) so the floor is monotonic —
  // it never drops at a zone boundary and can't be wicked out below a prior tick.
  // 'price' = the legacy behavior (unchanged); 'gain' = the new smooth trail.
  // Ships only after the replay proves it net-positive over winners AND rugs.
  TRAIL_MODE: z.enum(["price", "gain"]).default("price"),
  TRAIL_GAIN_GB_TIGHT: z.coerce.number().default(0.15), // give back 15% of the gain in the 1–2.5× spike slice
  TRAIL_GAIN_GB_MID: z.coerce.number().default(0.3), // 30% in the 2.5–6× runner slice
  TRAIL_GAIN_GB_WIDE: z.coerce.number().default(0.45), // 45% above 6× — room to ride the parabola
  HARD_STOP_PCT: z.coerce.number().default(5), // pre-ignition: a confirmed entry that reverses 5% failed — cut it cheap (~-$0.9 not -$17)
  // INTERIM NEVER-ARMED STOP (operator-approved 2026-07-23; the overnight
  // replay prices it properly). Four never-armed full-size losses in one day
  // (CA −$21.36, COW −$15.98, VLAD −$5.21, looong −$4.90 ≈ −$47) once the
  // compounding sizes landed: a position that has NEVER reached the arm bar
  // and is down NEVER_ARM_STOP_PCT after NEVER_ARM_STOP_MIN minutes is cut,
  // instead of riding a class-deep stop to −40..100%. Conservative interim
  // params: the 8-minute grace clears dbc ignition chop (BULLDOG: −50% for
  // 2.5m then 153×) and the wick-moon anatomy; atomic rugs are unsavable by
  // ANY stop and stay the crowd gate's job. Only ever shortens losses — a
  // trade that armed is untouched.
  NEVER_ARM_STOP_ENABLED: z.coerce.boolean().default(true),
  NEVER_ARM_BAR: z.coerce.number().default(1.2), // the trail-arm level — "armed" means reached this
  NEVER_ARM_STOP_MIN: z.coerce.number().default(8), // grace minutes before the stop is live
  NEVER_ARM_STOP_PCT: z.coerce.number().default(25), // cut at −25% instead of the deep class stop
  // VENUE-SPLIT pre-ignition stop (user-ruled 2026-07-15, the BULLDOG 153x
  // autopsy): on THIN bonding-curve tape a tight stop is a lie twice over — it
  // gap-fills far below its line ($10.50 "5% stop" filled at −52%) AND ejects
  // the monsters during their violent pre-ignition retrace (BULLDOG chopped at
  // −50% for 2.5 REAL minutes, then ran 153x; 63% of historical hard-stops
  // recovered past TP0). 45% sits below the ignition-retrace zone but above
  // rug-to-zero; genuine rugs still exit via dust/no-pair/timebox. Deep pools
  // keep the tight HARD_STOP_PCT — their fills actually land near the line.
  HARD_STOP_PCT_THIN: z.coerce.number().default(45),
  // Thin = bonding-curve venue (meteora-dbc) OR live liquidity under this floor.
  THIN_STOP_LIQ_USD: z.coerce.number().default(10000),
  MAX_HOLD_HOURS: z.coerce.number().default(6),
  // RUNNER CLOSE — the last leg of the model: 20% rides after TP2 until it
  // stalls OR this hard cap, then closes. Six hours was never the intent for a
  // memecoin runner; the move is decided inside the first fifteen minutes and
  // holding past that is exposure without thesis. The stall exit still fires
  // earlier when a position stops making highs; this is the backstop for one
  // that keeps drifting. Set 0 to disable.
  RUNNER_MAX_HOLD_SEC: z.coerce.number().default(1000),
  // Flat-position time-box — capital rotation. A position that never established
  // (never cleared FLAT_MULT) after FLAT_MIN minutes is dead weight occupying a
  // slot a live mover could use. Cut it at market to recycle the capital. Any
  // position that DID clear FLAT_MULT is owned by the ratcheting trail instead
  // (it either trails out green or is a proven runner), so this never caps a
  // winner — it only sweeps the stuck 1.0x deadweight that clogged the book.
  // SECONDS-SCALE dud cut (2026-07-15, temporal-DNA study). Rugs/duds peak at 77s
  // at a nothing 1.06x, then we sat on them 567s under a 20-MINUTE flat timebox —
  // dead weight clogging slots while the −5% hard stop or the rug slowly arrived.
  // Cut at 3min instead: the gate is PEAK<FLAT_MULT, so anything that poked even
  // 1.1x in its first 3min is spared and owned by the trail — this only sweeps the
  // never-established flatliner. FLAT_MULT 1.2→1.1 protects slow organic climbers
  // (they show >=10% life early; a real winner isn't still sub-1.1x at 3min).
  // NOTE: winners take 5–20min to develop (moonshots peak at ~1009s), so this is a
  // LOSER cut only — never a blanket 300s max hold, which would murder every
  // moonshot mid-climb. Timing is asymmetric: seconds to cut a dud, minutes to let
  // a winner breathe. See [[feedback_maximize_dont_minimize]].
  TIMEBOX_FLAT_MULT: z.coerce.number().default(1.1), // "established" = peak reached at least this
  TIMEBOX_FLAT_MIN: z.coerce.number().default(3), // minutes before a still-flat (never cleared 1.1x) position is recycled
  // 300s→60s (2026-07-14): the 5-min snapshot froze the Equity KPI between
  // writes and made the curve look pinned at break-even while the book moved.
  // The headline KPI now computes LIVE on the dashboard; snapshots feed the
  // chart, and 60s keeps that curve honest without hammering DexScreener.
  PNL_SNAPSHOT_MS: z.coerce.number().default(60_000),

  // Feed-coherence guard on the management mark. The mark comes from TWO
  // independent same-tick feeds — Jupiter (block-level price) and DexScreener
  // (price + liquidity) — and either can return garbage for a live pool. Acting
  // on one bad read sold healthy, climbing winners at a fake $0 for -$17 each.
  // Two layers:
  //  (1) Jupiter-vs-DexScreener divergence — liquidity is DexScreener-only, so if
  //      DexScreener shows a healthy pool its price is trustworthy; reject a
  //      Jupiter override that disagrees by >DIVERGENCE x (pos 29: Jupiter glitched
  //      to $9e-9 while DexScreener read ~$5.70 / liq $183k — the override took the
  //      bad price). This is the cheap upstream catch, no history needed.
  //  (2) Liquidity-coherence backstop — source-agnostic. In one pool a price move
  //      and its liquidity move together; if exactly ONE feed makes an
  //      order-of-magnitude move while the other stays flat, the moving feed is
  //      garbage — HOLD the last-good mark (never act), no matter how many polls it
  //      persists (temporal alone failed: pos 29's garbage held for 2 polls and the
  //      2-tick confirm honored it). A COHERENT order-of-magnitude drop (both feeds
  //      low = a real rug) still exits, after CONFIRM_TICKS to rule out a rare
  //      simultaneous double-feed flip.
  MARK_FEED_DIVERGENCE: z.coerce.number().default(5), // reject Jupiter override if >Nx from DexScreener price
  MARK_OOM_FACTOR: z.coerce.number().default(10), // a feed "moved orders of magnitude" if >Nx or <1/N
  MARK_LIQ_FLAT: z.coerce.number().default(2), // a feed "barely moved" if within [1/N, N]
  MARK_MIN_LIQ_USD: z.coerce.number().default(1000), // below this the pool is dust — no real fill; hold last-good, never book an exit off it
  MARK_CONFIRM_TICKS: z.coerce.number().default(2), // consecutive coherent-crash polls to confirm a real exit
  // Persistent-dust death exit. A dust-liquidity read (pool below MARK_MIN_LIQ)
  // is HELD as a suspect (never booked off its fake price) — but if the pool
  // STAYS dust for this many consecutive polls, the token's tradeable liquidity
  // is genuinely gone (migrated/pulled), the held mark is fiction, and the
  // position is a corpse clogging a slot. Book it as a rug and free the slot.
  // Persistence is the discriminator: a transient aggregator flip recovers in a
  // tick or two and never reaches this count (guards the old fake-crash bug).
  PERSISTENT_DUST_TICKS: z.coerce.number().default(6), // ~30s at a 5s manage cadence
  OUTAGE_MIN_POSITIONS: z.coerce.number().default(3), // only apply the mass-no-pair outage guard once the book is at least this big
  OUTAGE_NULL_FRACTION: z.coerce.number().default(0.5), // if ≥ this share of the book returns no-pair in ONE cycle it's a feed outage, not mass delisting — hold all
  DUST_OUTAGE_MIN_COUNT: z.coerce.number().default(4), // the dust-breadth guard also needs this many ABSOLUTE dust reads — stops a fraction-only false-positive freezing a tiny book (2 deaths in a 4-book = 50%)

  // Management-time ride-vs-cut classifier. "advisory" persists every call
  // beside the mechanical rules so we can compare them on real 1d data without
  // risk; "active" lets its calls (BLOWOFF→trim, STALL/FADE→cut) drive exits.
  CLASSIFIER_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v === "true"),
  CLASSIFIER_MODE: z.enum(["advisory", "active"]).default("advisory"),

  // Capital-protection circuit breaker: if paper equity falls this far from its
  // running peak, auto-engage the kill switch (halt new entries — open positions
  // still exit). The mechanical floor so a bad regime can't bleed the bankroll
  // unattended. 0 disables. A daily-loss cap gives a second, faster trip.
  PAPER_MAX_DRAWDOWN_PCT: z.coerce.number().default(15),
  PAPER_DAILY_LOSS_CAP_USD: z.coerce.number().default(150),
  // Auto-resume: a breaker trip halts for this cooldown, then releases itself with
  // a FRESH baseline (drawdown/loss re-anchored to the resume equity) so the system
  // gets back in the game instead of sitting dark for hours missing the winning
  // cohort. Recorder data showed indefinite manual-only halts = ~75% downtime =
  // the real reason high multiples weren't traded. 0 disables auto-resume.
  BREAKER_COOLDOWN_MIN: z.coerce.number().default(20),

  // The Recorder — the data flywheel. Watches EVERY candidate that clears
  // safety (entered or not) for its first RECORDER_WINDOW_MIN minutes via
  // keyless DexScreener (no RPC, no capital), building the labeled dataset we've
  // never had. WIN_MULT is the provisional "winner" threshold on peak multiple;
  // raw magnitudes are stored so the label can be recomputed against the convex
  // slippage model later. Poll faster than SCOUT to resolve the early trajectory.
  RECORDER_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v === "true"),
  // 30s → 10s (2026-07-20). The 30s interval was a leftover from the per-mint
  // polling era that self-inflicted DexScreener throttling; batching (one request
  // per 30 mints) fixed that and the whole platform now runs ~20 req/min against
  // a ~300 req/min ceiling — 7% of budget. At 10s we sit near 20%, still ample
  // headroom, and gain three things: confirmations land inside the 20s entry
  // freshness window instead of expiring, continuation is measured on a finer
  // grid, and a dud reveals itself in 10s instead of 30. The continuation gate
  // is sampling-rate independent (continuationLookback) so this does not
  // silently re-tune it.
  // 10s → 6s (2026-07-21). Entry resolution is bounded by this: Hieromojis
  // printed its ONLY qualifying tick 2.9 seconds inside the window floor and
  // peaked 4.12× untraded. Faster sampling both narrows that gap and shrinks the
  // poll-tolerance slack the trigger now carries (pollToleranceMin is derived
  // from this value, so it scales automatically and nothing re-tunes silently).
  // The continuation gate is likewise sampling-rate independent by construction.
  // 6s → 2s (2026-07-21), matching MANAGE_POLL_MS so the signal a candidate is
  // judged on is as fresh as the mark an open position is managed on. Entry
  // resolution is bounded by this: Hieromojis printed its ONLY qualifying tick
  // 2.9s inside the window floor and peaked 4.12× untraded, and the 2-3m gate is
  // just 30 samples wide at 6s. Finer sampling means a candidate is evaluated
  // closer to the state it is actually in, which is what "qualified" is supposed
  // to mean. Batched fetch, keyless source — request volume does not scale with
  // the number of candidates watched, only the tick-write rate does (~3× more
  // rows in candidate_ticks, the cost of the resolution).
  // pollToleranceMin and continuationLookback both derive from this value and
  // rescale automatically, so no gate silently re-tunes.
  RECORDER_POLL_MS: z.coerce.number().default(2_000),
  RECORDER_WINDOW_MIN: z.coerce.number().default(15),
  RECORDER_WIN_MULT: z.coerce.number().default(2),
  // A candidate is a RUG if it terminally collapsed to <= this multiple of the
  // reference (or delisted), regardless of how high it pumped first. Labeling by
  // terminal outcome — not by peak — is what stops pump-then-rug tokens hiding in
  // the "dud" class (see recorder closeOutcome + the 2026-07-14 relabel backfill).
  RECORDER_RUG_FINAL_MULT: z.coerce.number().default(0.5),

  // Recorder-as-scout: the confirmation entry trigger. Instead of committing
  // capital blind at t=0 (where run-1c proved winners and duds are
  // indistinguishable — early continuation score saturates ~99 for BOTH), the
  // recorder watches each candidate's real trajectory and fires an entry trigger
  // only once demand is CONFIRMED. Calibrated on 2,484 recorded ticks / 24
  // winners / 60 duds: the microstructure that actually separates them is being
  // green-and-holding-near-highs, NOT the saturated score. Chosen knee
  // (mult≥1.25, dd≤10%, buys≥60%, t∈[2,12]m) fired on 88% of winners and 40% of
  // duds — a 2.2:1 separation; triggered winners then ran ~2x AFTER entry while
  // duds popped +25% and round-tripped (the trail banks those small). These are
  // calibration priors on a modest sample (n=24 winners, 0 rugs), not a fit —
  // knobs so the recorder can re-validate them as the dataset grows.
  CONFIRM_ENTRY_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v === "true"),
  CONFIRM_MIN_WATCH_MIN: z.coerce.number().default(2), // past the t=0 noise floor
  // 12 → 3 (2026-07-20). The 2-2.5min mark is where duds, rugs and real movers
  // separate — that IS the sort, and it is the whole premise of the entry model.
  // A 12-minute tail let entries drift far past it: the same trade that qualified
  // at 2.3m/1.51x was instead filled at 6.1m/1.95x, turning a +44% opportunity
  // into +11%. Enter inside the sort window or do not enter — a candidate that
  // only qualifies at minute 8 has already made its move without us.
  // 3.0 → 2.5 (Formula v2 model run, ratified 2026-07-24): triggers later than
  // 2.7m ran −$0.65/trade at 15% dead on the signature-era census — the canon
  // seat is the 2.0–2.5m window and the tape agrees.
  CONFIRM_MAX_WATCH_MIN: z.coerce.number().default(2.5),
  // ── FORMULA v2 TIER KNOBS (canon GCE-FORMULA-001, ratified 2026-07-24) ────
  // SENSOR tier: crowd-fail / manufactured-spike entries probe on paper at
  // this multiple (census: crowd-fail $0.28/trade at 14% dead vs crowd-pass
  // $1.29 at 5%) and are refused on live. Inflow above the ceiling is the
  // manufactured-spike envelope violation (F3).
  SENSOR_TIER_SIZE_MULT: z.coerce.number().default(0.3),
  // RECOVERED tier (ratified 2026-07-24): crowd is net-positive wallets only
  // (wins > rugs, no never-rugged winner present) — leak-free 58% win / 28%
  // rug (~333/day recovered vs the rugs===0 attrition). Half clip, both lanes.
  RECOVERED_TIER_SIZE_MULT: z.coerce.number().default(0.5),
  INFLOW_CEILING: z.coerce.number().default(2.05),
  // F3 FLOOR ratified 2026-07-24 ("our floor has to be 1.20 — the data prove
  // it"): crowd-pass below 1.20 inflow won 73% but ran −$0.81/t at conviction
  // size (deaths eat the winners: BIO); demoted to probes the same trades pay
  // +$25.59. Conviction size requires the envelope; below floor = sensor
  // (paper probes, live declines). Unmeasured inflow is not vetoed.
  INFLOW_FLOOR: z.coerce.number().default(1.2),
  CONFIRM_MIN_TICKS: z.coerce.number().default(2), // need a trajectory, not one snap
  // RAISED 1.25 → 1.35 (2026-07-20). Realized P&L by the multiple a token had
  // ALREADY run at confirm exposed the barely-qualified band as the system's
  // single largest loss pool: 1.25-1.35× was 45% of all trades (n=342) and lost
  // −$75.04 (−3.1% on deployed) INCLUDING its winners, while 1.6-2.0× returned
  // +5.0%. Dead-on-arrival trades are invisible to every quality signal we have
  // (same pool growth, rug prob, buy share, conviction as winners) — they are a
  // TIMING artifact, not a quality one, so the fix is a higher proof-of-move bar
  // rather than another filter. Tokens clearing 1.35× have shown real follow-through,
  // and the cost-recoup floor banks the basis on the ones that stall.
  // 1.35 → 1.20 (ARM SPEC ratified 2026-07-24): the arm bar IS the signal —
  // armed trades convert at 87% regardless of crowd; crowd+seat 1.2–1.65 ran
  // 83% win / $2.51/t / 47% capture on the harness.
  CONFIRM_MIN_MULT: z.coerce.number().default(1.2),
  // THE ADMISSION CEILING (ARM SPEC ratified 2026-07-24): triggers arm up to
  // 2.05× — but the CONVICTION seat is 1.2–1.65 (83%/$2.51/t/47% capture);
  // the 1.65–2.05 slice measured −$1.01/t and fires at SENSOR probe size on
  // paper only (live declines it). Above 2.05 = manufactured-spike territory,
  // refused outright. Admission and sizing tiers are deliberately decoupled:
  // the sweetspot finder's band informs tiers and the radar, never admission.
  CONFIRM_MAX_MULT: z.coerce.number().default(2.05),
  CONVICTION_SEAT_MAX: z.coerce.number().default(1.65), // full-size fire zone ceiling
  // SWEETSPOT FINDER — the boarding band as a rolling measurement, not a
  // constant (operator: "sweetspot finder at any moment in the day"). Every
  // refresh the recorder re-fits [minMult, maxMult] from trailing realized
  // expectancy per trigger-multiple bucket; static CONFIRM_MIN/MAX_MULT is the
  // thin-sample fallback and the hard rails are 1.30–2.20.
  SWEETSPOT_ENABLED: z.coerce.boolean().default(true),
  SWEETSPOT_REFRESH_MS: z.coerce.number().default(600_000), // re-measure every 10 min
  SWEETSPOT_MIN_N: z.coerce.number().default(8), // per-bucket sample floor
  SWEETSPOT_WINDOW_H: z.coerce.number().default(24), // trailing tape it learns from
  // 10 → 40 (2026-07-20). A 10% ceiling could only admit a winner at its highs,
  // because winners DIP: measured pre-peak drawdown is 22.3% median for climbers
  // and 35.2% for moons, versus 0.9% for rugs — dipping is the winner signature,
  // and this gate was selecting for the classes that don't dip.
  // The larger gain is CONTINUITY of the armed state. At 10% a climber flickered
  // in and out of armed exactly while it was breathing, and a flicker can be
  // missed by any scan (Ballerina: armed 22:20:00, disarmed ~20s later at 20% DD,
  // peaked 3.49×, never traded). At 40% a qualifying candidate stays armed
  // through its normal dip so the 5s scan can actually reach it.
  // Measured in the 2-3min entry window, rug rate FALLS as entry drawdown rises
  // (19.4% at 0-5% DD → 0% above 20%), so dips are not rug signals here. Stopped
  // at 40 rather than 60: the bands above 20% carry only n=10/5/3, so the
  // direction is established but the magnitude is not.
  CONFIRM_MAX_DD_PCT: z.coerce.number().default(40), // winners dip — stay armed through it
  // Buy-share VETO floor. Was 0.60 — that arm-time veto cost 6.5% of all
  // microstructure-qualified winners (62 of 959, incl. MOOBULL 33x whose heavy
  // two-way bot tape sat 0.45-0.52 its whole run) while only 31% of duds fell
  // below it. Per the shrink-don't-veto doctrine the 0.45-0.60 band now ARMS and
  // the trader's CONFIRM_QUALITY_SIZE_MULT (×0.6 under 0.8 buys) prices the risk;
  // below the floor the tape is genuinely sell-dominated — still a veto.
  // 0.45→0.40 (2026-07-15): PITBULL ran 1.73x holding 0% dd but its buy-share
  // sat 0.38-0.46 the whole window — the same two-way bot tape as MOOBULL.
  // Calibration: winners/duds both pass ~99% at 0.45, so the band between 0.40
  // and 0.45 costs <1% in dud admits; quality-sizing prices the risk.
  CONFIRM_MIN_BUYSHARE: z.coerce.number().default(0.4),
  // Neutral-churn DEAD ZONE (recalibrated 2026-07-19 on clean labels, n=5988
  // triggers): confirm-tick buy share in [0.50, 0.55) = symmetric wash flow —
  // 7.9% winners / 76.6% duds vs 31-43% win in every neighboring band. The
  // ragoon bait signature. An exclusion band, NOT a floor: 0.45-0.50 wins 33%.
  CONFIRM_DEAD_BUYSHARE_LO: z.coerce.number().default(0.50),
  CONFIRM_DEAD_BUYSHARE_HI: z.coerce.number().default(0.55),
  // POOL-GROWTH EXEMPTION (2026-07-20) — the dead-zone veto's release valve, and
  // the strongest leak-free signal measured so far. Over 1,826 triggers (48h),
  // candidates whose pool grew ≥1.3× between first read and trigger ran 2.79×
  // AFTER entry vs 1.78×, reached ≥1.5× post-entry 51.1% vs 25.4%, and rugged
  // 6.0% vs 26.2%. Buy-share is a ratio — it cannot distinguish wash churn from
  // a deep bid; pool growth measures capital actually arriving.
  CONFIRM_LIQ_GROWTH_EXEMPT: z.coerce.number().default(1.3),

  // CONTINUATION CONFIRMATION (2026-07-20) — clear the bar, then keep going.
  // Nothing at entry separates duds from movers; continuation does, monotonically:
  //   FADED −$28.98 · 0-2% −$5.78 · +2-5% +$2.74 · +5-10% +$5.74 · ≥+10% +$20.96
  // Requiring +2% turns −$5.32 into +$29.44 and refuses 248 losing trades with
  // zero capital committed. Inverse warning: momentum INTO the gate is the
  // opposite signal (rising ≥10% at the trigger tick = −$29.00/282 trades).
  // REPLACED the minimum-continuation floor, which was backwards (2026-07-20).
  // By rise between the prior qualifying tick and the confirming one, over 540
  // closed trades: <+2% +$9.16 (+0.167/trade, the best band) · +2-10% −$6.80 ·
  // +10-25% −$28.37 · +25-50% −$14.81 · +50-100% +$12.56 · ≥+100% −$12.79
  // (−0.983/trade, 6× worse than any other). The old floor excluded the only
  // reliably positive band and admitted verticals without limit — it blocked a
  // 1.26× entry at 2.1m and permitted a 14.42× entry at 3.7m on a token that
  // peaked 41.64× and was worthless 90 seconds later. Now a ceiling only.
  CONFIRM_MAX_RISE_INTO_GATE: z.coerce.number().default(1.0), // reject ≥+100% in one window
  // SNAP OFF THE LOW — see docs/signature-trigger-spec.md. DEFAULT 0 = INERT.
  // The gate re-anchors entry from watch-zero to the candidate's own trough. It
  // stays off until the sweep + holdout in replayTrigger.ts says which threshold
  // sits on a plateau rather than a spike — a peak found by searching is how the
  // ×2.0 band boost passed review and then went 0-for-4 with real money.
  // ── POSITION SIZE AS A FRACTION OF CAPITAL ────────────────────────────────
  // One formula for both lanes: size = capital × frac, where the POLICY sets the
  // range by regime and the QUALITY SCORE (conviction stars) picks the point
  // inside it. Paper's capital is the bankroll, live's is the wallet balance, so
  // both scale as the account moves — a fixed dollar size silently becomes a
  // different risk as the balance changes, and the two lanes drift apart.
  // The range is deliberately narrow: the old eight-factor chain spread sizes
  // 200× in six hours ($0.20 to $41.64) and put twenty-one cents on our
  // best-evidenced class. A bounded range cannot do that.
  // ── RUNNER RATCHET ────────────────────────────────────────────────────────
  // Above the top rung the remainder is pure upside. The floor already ratchets
  // (peak × (1−w), and peak only rises); these control how the WIDTH scales with
  // the size of the move, so the runner keeps room to breathe while young and
  // the floor closes in as the gain becomes worth defending.
  //
  // Measured 2026-07-21: of trades reaching 2.35×, 46.7% go on to 3.2× but only
  // 22.2% reach 4.25× and 13.3% reach 6×. So beyond ~3× every further multiple
  // is progressively rarer, and a fixed give-back becomes progressively more
  // expensive — Pumpman peaked 27.63× and survived only because a basket harvest
  // happened to fire; Spam banked 45% off a 3.90× peak and still finished red
  // because the 55% runner rode a full-width trail into the rug.
  // Below the ratchet the class trail (25–45%) was the only width, and at 45% a
  // position peaking 1.98× floors at 1.09× — never reached, so it rode to the
  // clock and was market-dumped at 1.24×. That is the `runner_timeout` bucket:
  // 23 trades since 2026-07-21T13:48, +$36.12 at 28% capture, and unlike the
  // gap victims these WALK (last six ticks flat at ~1.34×), so a tighter floor
  // is actually reachable. Static replay: 28% → +$58.09, 20% → +$77.95.
  RUNNER_RATCHET_PRE_START: z.coerce.number().default(1.5), // green enough to defend
  RUNNER_RATCHET_PRE_PCT: z.coerce.number().default(28), // caps the class trail below the ladder
  RUNNER_RATCHET_START: z.coerce.number().default(3.2), // engages just past the top rung
  RUNNER_RATCHET_WIDE_PCT: z.coerce.number().default(40), // 3.2–8×: still developing, let it breathe
  RUNNER_RATCHET_MID_PCT: z.coerce.number().default(28), // 8–20×: proven runner, start defending
  RUNNER_RATCHET_TIGHT_PCT: z.coerce.number().default(18), // 20×+: a rare gain, defend it hard
  POSITION_FRAC_MIN: z.coerce.number().default(0.01), // 0★ residual — floor of the range
  POSITION_FRAC_MAX: z.coerce.number().default(0.05), // 2★ conviction — ceiling, policy may lower it
  CONFIRM_MIN_SNAP: z.coerce.number().default(0),
  // Drawdown ceiling once snapped (the dip is the signal). Only consulted when
  // CONFIRM_MIN_SNAP > 0 and the candidate cleared it.
  CONFIRM_MAX_DD_SNAPPED: z.coerce.number().default(70),

  // ── POOL-INFLOW SIZING — the edge, applied to capital ──────────────────────
  // Pool growth is the one signal a fake move cannot manufacture: wash trading
  // recycles the same capital and leaves liquidity flat, while a real move pulls
  // new capital in. Measured leak-free on the run AFTER entry (n=1,826 triggers)
  // and on early trajectories (n=4,072 candidates, 72h):
  //   growth ≥1.3× at trigger → 2.79× post-entry run · 6.0% rug
  //   growth <1.3×            → 1.78× post-entry run · 26.2% rug
  //   ≥1.4× mark + ≥1.10 pool by 1.0–1.5min → 80.9% win · 10.1% rug · 4.10× peak
  //   price up on a FLAT pool (the wash signature) → 35.1% rug vs 22.5%
  // So: lean into inflow, shrink the price-up-on-flat-pool case. Sizing, never a
  // veto — the shrink-don't-veto doctrine holds.
  // RAISED 1.20 → 1.30 (2026-07-20) on the live Inflow Edge readout: the boost
  // was landing on a LOSING band. Measured over 24h —
  //   ≥1.30×      : 72.0% win · 0.0% rug · 4.00× peak · +$27.09 realized
  //   1.20-1.30×  : 35.7% win · 28.6% rug · 2.35× peak · −$7.32 realized
  // Only ≥1.30 is the edge; 1.20-1.30 was being sized UP while it bled. The
  // panel that caught this is exactly why the edge is monitored continuously.
  LIQ_INFLOW_STRONG: z.coerce.number().default(1.30), // ≥ this = strong inflow
  LIQ_INFLOW_SIZE_BOOST: z.coerce.number().default(1.5),
  // RAISED 1.02 → 1.30 (2026-07-20). The shrink used to catch only DEAD-flat
  // pools, leaving the whole 1.02-1.30 middle at full size — and that middle is
  // where the losses live. Measured 24h: ≥1.30× → 72.0% win / 0% rug / +$27.09;
  // 1.20-1.30× → 35.7% win / 28.6% rug / −$7.32; 1.05-1.20× → 15.8% win /
  // −$6.15. Confirmed on the live book: 7 of the 8 worst live trades had pool
  // growth 1.14-1.25 while clearing the price bar at 1.35-1.73×. Price says the
  // token moved; the pool says somebody actually paid for it. Anything short of
  // strong inflow now sizes down.
  LIQ_FLAT_MAX: z.coerce.number().default(1.30), // < STRONG = not enough real inflow
  LIQ_FLAT_SIZE_MULT: z.coerce.number().default(0.6),

  // LIVE INFLOW REQUIREMENT — real capital only mirrors the band that pays.
  // Live has no frictionless forgiveness: it eats slippage, gas and confirm
  // latency, so the marginal-inflow trades paper survives are pure bleed live.
  // Only the ≥LIQ_INFLOW_STRONG band (72% win / 0% rug) clears. FAIL-SAFE: an
  // unstamped candidate is refused too — if stamping ever breaks, live stops
  // trading rather than reverting to blind entries. Paper still explores it all.
  // REVERTED TO SIZING-ONLY (2026-07-20). Pool inflow was designed as a SIZE
  // input and was correct as one; converting it into an entry VETO systematically
  // DELAYED good trades instead of filtering bad ones, because pool growth LAGS
  // price. Worked example: a steady climber qualified at 2.3m at 1.51× with 84%
  // buys, 0% drawdown and rising liquidity — the veto refused it for 3.8 minutes
  // until the pool reached 1.30× growth, by which time price was 1.95×. We paid
  // 29% more for the entry and captured +0.8% of a move that ran +44% from where
  // it first qualified. The veto protected nothing; it just made us late.
  LIVE_REQUIRE_INFLOW: z
    .string()
    .default("false")
    .transform((v) => v === "true"),

  // PAPER INFLOW GATE — the same quality bar on the paper book, with one
  // deliberate exception. Paper is the SENSOR: the realized-P&L-by-band figures
  // that caught the 1.20-1.30 boost miscalibration come from paper positions,
  // so a hard gate would blind us to the edge shifting and we would end up
  // optimising against a belief we could no longer test. Weak-inflow candidates
  // are therefore skipped EXCEPT for a small random sample kept at minimum size
  // — enough to keep every band measurable, cheap enough to stop the donation.
  PAPER_REQUIRE_INFLOW: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  PAPER_INFLOW_EXPLORE_RATE: z.coerce.number().default(0.15), // sample of weak-inflow kept for measurement
  PAPER_INFLOW_EXPLORE_SIZE_MULT: z.coerce.number().default(0.25), // exploration is priced as a probe, not a bet

  // ── FAST SCRATCH — the dud solution ────────────────────────────────────────
  // Duds cannot be filtered at entry (every entry-time feature is identical
  // between duds and movers across 414 trades) but they identify themselves in
  // ~30 seconds of ownership: mark at 30s is 0.938× for duds vs 1.104× for
  // movers, and duds then flatline near 0.97 forever. Riding them to the −7%
  // hard stop turned a 6% fade into a −13.7% average loss; 167 duds cost
  // −$162.94 in 12h, the largest loss pool in either lane. Scratch a position
  // that has not established by the checkpoint. Narrow by construction: it only
  // fires when the position has NEVER printed a green tick above the arm floor,
  // so a real mover that dips is never cut.
  // DISABLED (2026-07-20). Not part of the model and measurably negative: 19
  // fires for −$26.24, the second-largest loss pool on the board. It also did
  // not do what its name implies — on gapping tokens the 30s check fired and
  // FILLED far below entry (SPEED: peak 1.00×, exit 0.58×), so it behaved as a
  // delayed stop rather than a scratch. The model already covers this case
  // twice: the 5% hard stop takes a trade that goes wrong immediately, and the
  // 90s time floor takes one that drifts. This was a third mechanism competing
  // with both.
  FAST_SCRATCH_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  FAST_SCRATCH_AT_SEC: z.coerce.number().default(30), // checkpoint age
  FAST_SCRATCH_MIN_MULT: z.coerce.number().default(1.0), // below this at the checkpoint = scratch
  FAST_SCRATCH_MAX_PEAK: z.coerce.number().default(1.05), // ...and it never established

  // LATE-ENTRY (BUYING-THE-TOP) SHRINK — the second loss pool. Confirms in the
  // 2.0-2.5× band ran 27.5% dead-on-arrival and −13.3% on deployed (n=40): the
  // move had largely finished before we confirmed, so our fill IS the top tick.
  // Shrink rather than veto — ≥2.5× is positive (+2.0%, the genuine runners that
  // keep going), so a hard cut there would be over-fitting a small sample.
  LATE_ENTRY_LO: z.coerce.number().default(2.0),
  LATE_ENTRY_HI: z.coerce.number().default(2.5),
  LATE_ENTRY_SIZE_MULT: z.coerce.number().default(0.5),

  // ── MOONSHOT BAND SIZING — where the fat tail actually lives ───────────────
  // Leak-free, measured on what happens AFTER the trigger (n=1,827, 48h):
  //   1.20-1.35x : run 1.44x · doubled 6.2%  · 5x+ 0.5% · RUG 28.8%
  //   1.35-1.6x  : run 1.84x · doubled 22.7% · 5x+ 2.9% · rug 21.6%
  //   1.6-2.0x   : run 3.72x · doubled 29.3% · 5x+ 4.8% · rug 16.0%
  //   >=2.0x     : run 3.53x · doubled 33.9% · 5x+ 7.1% · RUG 0.0%
  // The moonshots are in the HIGH bands and they get SAFER going up — the
  // opposite of the intuition that chasing a runner is risky. A confirm above
  // 1.6x runs nearly 4x further and rugs at a third the rate of the zone we
  // used to fill. These bands previously got no preferential allocation at all;
  // now they get the capital, in BOTH lanes, so live concentrates on the trades
  // that actually produce the tail.
  // REVERTED TO NEUTRAL (2026-07-20, same day as shipped). The boost was built
  // on recorder-frame POTENTIAL (peak ÷ trigger) and on a "0% rug rate" that was
  // TAUTOLOGICAL — the labeller assigns winner first, so a candidate triggering
  // ≥2.0× already has peak ≥2.0× and can never be labelled a rug. Realized
  // result: band-boosted positions averaged $31.79 (2.5× a normal bet) and went
  // 0-for-4 for −$7.96, the worst cohort on the board, while the biggest single
  // loss of the session (−$16.34) was an inflated position.
  // LESSON: size on REALIZED P&L per band, never on recorder-frame potential —
  // the recorder measures the opportunity, not what we capture. Re-enable only
  // when realized P&L by band supports it out-of-sample.
  BAND_STRONG_MULT: z.coerce.number().default(1.6),
  BAND_STRONG_SIZE: z.coerce.number().default(1.0), // was 1.5 — neutral until realized P&L earns it
  BAND_ELITE_MULT: z.coerce.number().default(2.0),
  BAND_ELITE_SIZE: z.coerce.number().default(1.0), // was 2.0 — 0-for-4, −$7.96

  // Consecutive failed sells that prove a position is unsellable. With the
  // exponential backoff this is ~5 minutes of real attempts — far better than an
  // age fuse, which parked capital and a concurrency slot on a corpse for 24min.
  LIVE_SELL_MAX_FAILS: z.coerce.number().default(6),
  // Volume acceleration = vol_m5 / vol_h1, the fraction of the trailing hour's
  // volume packed into the last 5 minutes — a genuine demand BURST. This is the
  // one clean positive edge in the separation study: winner median 0.234 vs rug
  // 0.148. A 0.15 floor cut 52% of rugs while keeping 77% of winners, lifting the
  // winner-share of confirmed entries from 0.478 → 0.595. Skipped when vol_h1<=0
  // (young token, ratio degenerate) so a real t=4min igniter is never punished.
  CONFIRM_MIN_VOLACCEL: z.coerce.number().default(0.15),
  // CONFIRM-QUALITY SIZING — size by confirm quality instead of gating on it.
  // The instant-death (hard_stop) class confirms with FADING buy-share (median
  // 0.765 vs 0.925 for green exits), but a hard ≥0.80 gate costs ~30% of total
  // EV for +5.5pp win rate — a bad trade per [[maximize]]. So: keep every
  // EV-positive entry, shrink the bet when the confirm tick's demand is fading.
  // buyShare < MIN_BUYSHARE at the freshest armed read → size × SIZE_MULT.
  CONFIRM_QUALITY_MIN_BUYSHARE: z.coerce.number().default(0.8),
  CONFIRM_QUALITY_SIZE_MULT: z.coerce.number().default(0.6),
  // RUG-MODEL SIZING (fitted logistic, core rugModel.ts, held-out AUC 0.70 —
  // quintile rug rates 7.9%→44.3%). Thresholds = the top two held-out quintile
  // boundaries. Shrink, never veto: even the dirtiest quintile is 56% not-rug.
  // Refit 2026-07-19 (AUC 0.710, clean liquidity-collapse labels, n=5988):
  // held-out Q4 (29.5% rug) begins at 0.30, Q5 (46.4% rug) at 0.43.
  RUG_PROB_CAUTION: z.coerce.number().default(0.30), // held-out Q4 boundary → ×RUG_SIZE_CAUTION
  RUG_PROB_HIGH: z.coerce.number().default(0.43), // held-out Q5 boundary → ×RUG_SIZE_HIGH
  RUG_SIZE_CAUTION: z.coerce.number().default(0.6),
  // 0.35 → 0.20 (2026-07-20): the ≥RUG_PROB_HIGH band is the only rug-model band
  // measured reliably NEGATIVE on live paper tape — clean(<0.30) +$5.79/199 and
  // caution +$4.46/30 vs high −$7.90 over 28 trades (avg −$0.28). The model's
  // ranking is validated, so shrink harder rather than veto: the band still buys
  // tail exposure, at ~half the bleed rate. Shrink-don't-veto doctrine intact.
  RUG_SIZE_HIGH: z.coerce.number().default(0.2),
  // CONVICTION SIZING — a candidate that confirmed at ≥ this market-proven
  // multiple (ARGENTINU armed at 4.94x, ran 11.4x) earns a boosted bet; a
  // 1.26x mill relaunch does not. Quality gets the capital, mills get scraps.
  CONVICTION_MULT_MIN: z.coerce.number().default(2.5),
  CONVICTION_SIZE_BOOST: z.coerce.number().default(1.4),
  // RE-ENTRY — a candidate whose position closed may re-arm if it re-qualifies
  // the full live gate (the VICE 8.4x lesson: one-shot entry burned 67
  // entered-then-closed candidates that went on to peak ≥2x overnight).
  // Bounded: at most this many total entries per mint, and a cooldown after a
  // close so a whipsaw can't thrash open/stop/reopen on the same wiggle.
  REENTRY_MAX_ENTRIES: z.coerce.number().default(2),
  REENTRY_COOLDOWN_MIN: z.coerce.number().default(3),
  // POND SCANNER — the venue lifecycle engine (recorder pondScanner.ts).
  // Rolling-24h evidence walks each venue observed→watchlist→promoted with
  // decay demotion; the trader's prime set follows automatically. Promote
  // gate is strictly harder than the demote gate (hysteresis, no flapping).
  POND_SCAN_MS: z.coerce.number().default(600_000), // 10 min
  POND_WATCH_MIN_N: z.coerce.number().default(8),
  POND_PROMOTE_MIN_N: z.coerce.number().default(15),
  POND_PROMOTE_WIN: z.coerce.number().default(0.35),
  POND_PROMOTE_MAX_RUG: z.coerce.number().default(0.25),
  POND_DEMOTE_WIN: z.coerce.number().default(0.2),
  POND_DEMOTE_RUG: z.coerce.number().default(0.4),
  // HOUR POLICY — the measured daily clock (Pond Radar's hourly windows made
  // executive). Each ET hour-of-day with enough closed trades is classified
  // prime (full size) or probe (OFF_HOURS_SIZE_MULT) by its own realized P&L;
  // unmeasured hours fall back to the static PRIME_HOURS_UTC declaration.
  // First reading already contradicted the declaration: 6am ET banked +$169
  // at half stakes while some declared-prime hours ran red.
  HOUR_POLICY_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  HOUR_POLICY_MIN_TRADES: z.coerce.number().default(15),
  HOUR_POLICY_MIN_PNL_USD: z.coerce.number().default(2),
  // PRIME VENUES — the measured healthy ponds (recorder pond map 2026-07-15:
  // fluxbeam 15/15 winners, 0 rugs, 14 hit 3x+). Armed candidates from these
  // venues jump the entry queue ahead of raw trigger-multiple ordering, and
  // they earn the conviction size boost regardless of trigger multiple.
  // Comma-separated canonical venue strings; re-derive from the pond map as
  // the dataset grows.
  PRIME_VENUES: z
    .string()
    .default("fluxbeam")
    .transform((s) => new Set(s.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean))),
  // SLOT DISPLACEMENT — never let deadweight block a confirmed banger. When the
  // book is full and a FULL-CONVICTION candidate is armed (buys ≥ quality floor),
  // evict the weakest open position: never established (peak below MAX_PEAK_MULT,
  // i.e. under the profit-lock arm threshold so it's provably unarmed deadweight)
  // after MIN_AGE minutes of chances. The cut goes through the intent queue (the
  // 5s manage loop executes it), the slot frees, and the still-armed candidate
  // enters on the next scan. Max one eviction per scan cycle.
  DISPLACE_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  DISPLACE_MAX_PEAK_MULT: z.coerce.number().default(1.05), // below every arm threshold = true deadweight
  DISPLACE_MIN_AGE_MIN: z.coerce.number().default(3), // winners ignite fast (median 5.4m) — 3m flat = stale
  // HARD-STOP WICK CONFIRMATION — the pre-arm stop was a wick-eater: ALL 30
  // hard-stops across runs fired on exactly ONE below-stop tick, and 63% of
  // those tokens then recovered past TP0 (57% past TP1, 20% ran ≥2x — SJM ran
  // 2.7x from our entry 15s after stopping us out at −6%). We buy confirmed
  // strength; its first pullback wick routinely dips >5% for a single 5s poll.
  // Require this many CONSECUTIVE below-stop ticks before the pre-arm stop
  // sells (same discipline as the crash-confirm hold). A real dump prints the
  // second tick and exits ~5s lower; a wick resets and the position lives to
  // reach the ladder. Atomic rugs are unaffected (the money is gone either way).
  HARD_STOP_CONFIRM_TICKS: z.coerce.number().default(3),
  // STALE-TAKE — sell the remainder INTO LIVE LIQUIDITY when the move stops.
  // A position with no NEW HIGH for STALE_LOCK_TICKS management polls (~3min at
  // 5s) while meaningfully green gets its remainder sold at market. Originally
  // a ratcheted stop (lock 80% of the move), but the GDWR autopsy proved stops
  // are worthless against the deployer-wave loss class: $222k pool pulled to $1
  // between two 5s polls — price teleports past any floor. Only exiting into
  // strength while the pool exists actually cashes. A running tape (new highs)
  // never triggers; a 3-minutes-flat memecoin is done running.
  STALE_LOCK_TICKS: z.coerce.number().default(36),
  STALE_LOCK_MIN_MULT: z.coerce.number().default(1.1), // need a real move before taking it
  // SESSION SIZING — "grow and survive until optimal trading hours." The
  // moonshot window is empirically 18:00–23:00 UTC (39 of the ≥3x movers and
  // 3-5x the launch flow land there; recorder history), while the dead zone is
  // where the deployer farm-waves hit us (the 01-03 UTC die-off) and our own
  // ledger runs −$1.60/trade vs −$1.00 in prime. Off-hours entries get
  // OFF_HOURS_SIZE_MULT × size: half stakes to survive, full size to grow when
  // the window opens. Composes with risk-tier × confirm-quality sizing.
  PRIME_HOURS_UTC: z
    .string()
    .default("18,19,20,21,22,23")
    .transform((s) => new Set(s.split(",").map((x) => Number.parseInt(x.trim(), 10)).filter((n) => Number.isFinite(n)))),
  // PROBE STAKES — off-hours is a PAID DATA LAB, not a profit strategy. The
  // ×0.5 scalp experiment failed its falsifier (−$25.49/26 closes: the farm
  // pulls earlier than its own history when hot), but going fully dark for 12h
  // buys zero live data on the new mechanisms in exactly the regime we must
  // learn to beat ("collect through all 12 windows — that's what builds the
  // winning formula"). At ×0.1 ($1.75/entry) the same window costs ~$5 —
  // tuition, not bleed — while every close keeps labeling the farm-ladder,
  // wick-confirm, and quality-tier experiments. Breaker remains the hard floor.
  OFF_HOURS_SIZE_MULT: z.coerce.number().default(0.1),
  // Off-hours ENTRY switch — ON at PROBE stakes (see OFF_HOURS_SIZE_MULT). The
  // ×0.5 scalp experiment failed its falsifier (2026-07-15 05:51Z: −$25.49/26
  // closes, farm pulls earlier than its own 24h history when hot — they adapt
  // intra-night). But dark hours = no live data on the new mechanisms in the
  // hardest regime, so off-hours runs as a paid data lab at ×0.1 instead of
  // standing down. Profit posture stays reserved for PRIME_HOURS_UTC.
  OFF_HOURS_ENTRIES: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  // Book-wide dust is an ANOMALY for this many minutes, then a DIE-OFF: meme-wave
  // entries cluster in time so their rugs cluster too; an eternal anomaly-hold
  // deadlocks slots on corpses (the frozen-book incident). Past the cap the
  // per-position persistent-dust death counters resume and the book clears.
  DUST_OUTAGE_MAX_MIN: z.coerce.number().default(5),
  // CONCENTRATION CAP — one deployer's clone wave must never own the book. The
  // 2026-07-15 die-off: 24/24 slots were W26/USOH-wave clones from the same
  // deployer; the wave rugged together and wiped the whole book at once (−$230).
  // Same-symbol clones are the cheap, reliable wave fingerprint (ticker spam is
  // exactly how these deploy). Cap open positions per symbol.
  MAX_PER_SYMBOL: z.coerce.number().default(3),
  // A confirmation decays: by the time we consume a trigger older than this the
  // demand it saw may be gone (a backlog or a fast rug can leave a trigger stale).
  // The live 1e backlog opened 3 already-dead W26 pools at 99% slip this way.
  // TIGHTENED 90 → 45 (2026-07-20) on the loss dissection: the whole night's
  // damage lives in an "instant death" cohort (39 of 257 trades = −$61.38, price
  // never ticks above entry, dead in ~36s). Its tell is ARRIVAL LATENESS — those
  // fills landed 140s after their trigger vs 87s for profitable ones. By fill lag:
  // <15s → 14.2% instant-death, 15–30s → 6.8% (and the best P&L, +$7.50), >60s →
  // 23.9%. Nothing good happens past a minute, so the stale tail is cut.
  // TIGHTENED 45 → 20 (2026-07-20) and re-pointed at confirmedAt. The cap was
  // measured against updatedAt, which the recorder stamps on EVERY poll whether
  // the candidate qualifies or not — so it never bit, and positions were bought
  // on confirmations minutes old while they waited on a slot. Now it measures
  // time since the gate actually passed. NOTE the recorder polls every ~30s, so
  // a 20s window deliberately lets some confirmations expire rather than be
  // filled stale: fewer entries, each on a signal that is genuinely current.
  CONFIRM_MAX_TRIGGER_AGE_SEC: z.coerce.number().default(20),
  // Refuse to open into a collapsed/near-empty pool: at $17.50 size a 30% convex
  // slip means liquidity < ~$82 (rugged), while a legit thin-pool entry is <1%.
  // This never blocks a real convex candidate — it blocks buying a corpse.
  ENTRY_MAX_SLIPPAGE_PCT: z.coerce.number().default(30),

  // PAPER WALLET-GRAPH GATE — apply the wallet graph to PAPER entries, but as a
  // SHRINK, not a veto (2026-07-20). The 2026-07-19 label backfill turned the
  // graph much redder: on farm-ecosystem venues the same wallets hold everything,
  // so "serial-rugger holders, no smart-money" started vetoing the tail itself —
  // 24h blocked cohort was 217 duds + 118 rugs + 57 WINNERS avg 6.68x peak
  // (football 68x, TEAM 27.8x, Wukong 11.2x). Convex math: the 57 tails dwarf
  // 335 shrunk losses. So the rugger profile now sizes down (×WALLET_GATE_SIZE_MULT)
  // per the shrink-don't-veto doctrine; only an OVERWHELMING rap sheet still
  // vetoes (≥VETO_MIN_RUG_HITS rug-rep holders, zero winner-rep, on a
  // ≥VETO_MIN_KNOWN sample — a book held almost entirely by proven ruggers).
  WALLET_GATE_SIZE_MULT: z.coerce.number().default(0.4), // rugger-profile size multiplier
  WALLET_VETO_MIN_RUG_HITS: z.coerce.number().default(5),
  WALLET_VETO_MIN_KNOWN: z.coerce.number().default(8),
  PAPER_WALLET_GATE: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),

  // CONVICTION MODEL — the fused high-performance score ∈ [0,1] driving entry
  // PRIORITY (creme rises) and live conviction-scaled sizing. WALLET-DOMINANT by
  // design: the wallet graph is the only factor with a strong leak-free lift; the
  // gate/venue/honeypot are already binary pre-conditions, so within the armed
  // pool the wallet edge is what still separates. Weights FROZEN for the window
  // (no live fitting — that overfits noise). rugSafe = 1−rugProb; gate = trigger
  // strength × buy-share.
  CONVICTION_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  // Live-lane conviction TILT only (faithful mirror = flat balance-fraction live
  // sizing → set false). Distinct from CONVICTION_ENABLED, which also drives
  // recorder score-stamping and paper's conviction-first entry queue — turning
  // THAT off to flatten live sizing silently degraded paper entry priority.
  LIVE_CONVICTION_SIZING: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  CONVICTION_W_WALLET: z.coerce.number().default(0.5),
  CONVICTION_W_RUGSAFE: z.coerce.number().default(0.25),
  CONVICTION_W_GATE: z.coerce.number().default(0.25),
  // Sizing band: conviction ∈ [0,1] maps to a size multiplier on the base. High
  // conviction sizes toward the 14%-of-balance cap (~2.2× base), low to 0.6×.
  CONVICTION_SIZE_MIN_BAND: z.coerce.number().default(0.6),
  CONVICTION_SIZE_MAX_BAND: z.coerce.number().default(2.2),

  // HOT-TICKER META-MOMENTUM — the auto-farm blacklist's MIRROR (2026-07-20).
  // Symbol-family momentum is real and was unexploited: 4 distinct "nice" mints
  // mooned in ~70min, Cola ×3, TEAM ×2. VALIDATED leak-free on 96h (n=2,093):
  // a candidate whose family printed ≥2 winners in the PRIOR 6h wins 19.6% vs
  // 13.0% base (1.5× lift) — higher rug share too (46.9% vs 38.3%), the convex
  // profile the cost-recoup ladder + rug-model sizing already price. Hot-family
  // candidates get a size boost + queue priority; farm-blacklisted tickers are
  // never boosted. Key by mint (W26 collision lesson), signal by family.
  HOT_TICKER_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  HOT_TICKER_WINDOW_MIN: z.coerce.number().default(360), // rolling family window (6h)
  HOT_TICKER_MIN_WINNERS: z.coerce.number().default(2), // family winners in window to run hot
  HOT_TICKER_MAX_RUG_SHARE: z.coerce.number().default(0.5), // family rug share that disqualifies
  HOT_TICKER_SIZE_BOOST: z.coerce.number().default(1.35), // × size for hot-family confirms
  HOT_TICKER_REFRESH_MS: z.coerce.number().default(120_000),

  // SENTINEL — the alert layer (services/sentinel). Pushes kill/breaker
  // transitions, high-conviction arms, runner banks, live fills, and stale
  // heartbeats to the operator's phone via ntfy.sh. Topic empty = idle.
  SENTINEL_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  SENTINEL_NTFY_TOPIC: z.string().default(""),
  SENTINEL_POLL_MS: z.coerce.number().default(30_000),
  SENTINEL_CONV_MIN: z.coerce.number().default(0.75), // ⚡ arm push threshold
  SENTINEL_RUNNER_MULT: z.coerce.number().default(1.5), // runner-bank push threshold
  // Scheduled progress report: TREND every 15 min (priority 2) + RECAP with
  // next-hour forecast on the hour (priority 3). Lane-separated — paper is the
  // simulated sensor, live is real capital, never summed together.
  SENTINEL_DIGEST_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),

  // SELL-ROUTE PROBE (the KIMI lesson institutionalized, 2026-07-20): before a
  // live BUY, quote the SELL (mint → WSOL) through the swap router. Exitability
  // becomes a real-time CHECK, not a venue-list assumption — a token we cannot
  // route an exit for right now is not entered, whatever its venue label says.
  LIVE_SELL_ROUTE_PROBE: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),

  // SWEEP GRACE (2026-07-20) — how long the reconciliation backstop waits after
  // a paper twin closes before force-closing the live position. The mirror sell
  // needs 5–10s on-chain (balance read → quote → build → sign → confirm) and the
  // twin is already gone the whole time, so a 5s sweep was RACING the mirror and
  // winning: 6 of 13 live exits closed as live_sweep_close/desync instead of the
  // intended profit_trail. The sweep must only fire when a mirror genuinely
  // failed — not while one is still in the air.
  LIVE_SWEEP_GRACE_SEC: z.coerce.number().default(25),

  LIVE_TRADING_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  // LIVE SIZER — the live lane manages by REGIME + WALLET BALANCE, not a flat
  // ceiling. Small positions (~$3.50–8.50 at a ~$60 balance) so the wallet holds
  // MANY concurrent (not 2×$25), and sizes scale as the balance compounds. More
  // small shots = more lottery tickets on the convex runners. Quality (walletEdge,
  // premium venue) GATES entry; magnitude is balance×regime only for night one
  // (quality-magnitude modulation deferred until validated).
  LIVE_MIN_POSITION_USD: z.coerce.number().default(3.5), // floor — below this the tx fee drag is too high
  // LIVE-ONLY SIZE FLOOR, as a fraction of the live balance. Paper's realised
  // fraction still drives the size and conviction still scales ABOVE this; the
  // floor exists because paper pays no transaction cost and live does. Measured
  // 2026-07-21: live averaged $2.33 on a ~$168 wallet against paper's $5.53 on
  // $1,000, and at those sizes a round trip surrendered ~14% to fees alone (pow).
  // This is a DELIBERATE departure from strict 1:1 with paper — the parity that
  // matters is relative risk, and a position too small to clear its own fee is
  // not the same trade paper took.
  LIVE_MIN_POSITION_FRAC: z.coerce.number().default(0.02),
  // ── THE AGGRESSIVE CONCENTRATION (operator directive 2026-07-22) ──────────
  // Side-by-side audit since routing went live: live was negative in EVERY
  // class but MOON_SLOW, while paper's engines ran +16.8% on deployed (RISER
  // +$135.92 at 69% win, MOON_STEADY +$35.53). The strategy: live trades ONLY
  // the proven lanes, ONLY with evidence, at sizes that clear the measured
  // 18.3pp/$2 drag. Fewer trades × better class × bigger clip.
  //
  // BASE is blocked by direct order ("it's a dead lane"): paper −10.6% on
  // deployed, live −58.2% at 20% win. CLIMBER (−29.8%/−75.8%) and
  // MOON_VIOLENT (−29.3%/−81.7%) join it on the same evidence. Paper keeps
  // trading all three as the zero-cost sensor so the loop can detect a
  // revival — live capital never touches them until the data turns.
  // Hard block = operator order (BASE: "it's a dead lane"). Everything else is
  // REGIME-GATED below — the market is regime-centric, and a static blocklist
  // lags the turn: CLIMBER went green in the very window after the audit
  // blocked it. A class earns live capital from its own recent paper tape and
  // loses it the same way.
  LIVE_CLASS_BLOCKLIST: z.string().default("BASE"),
  LIVE_REGIME_CLASS_GATE: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  LIVE_REGIME_CLASS_WINDOW_H: z.coerce.number().default(24), // trailing paper window judged
  LIVE_REGIME_CLASS_MIN_N: z.coerce.number().default(5), // below this, fall back to the audit core
  // HYSTERESIS (2026-07-23 replay: RISER gate flips 6→2 over 48h). The bench
  // engages only on a decisive negative read and releases only on a decisive
  // positive one — a ±1% flutter around zero no longer flips real capital.
  LIVE_REGIME_BENCH_PCT: z.coerce.number().default(-5), // bench at or below this ret%
  LIVE_REGIME_READMIT_PCT: z.coerce.number().default(3), // re-admit at or above this ret%
  LIVE_REGIME_HYST_MIN_N: z.coerce.number().default(10), // judgment needs this many closes
  // THE INFLOW BAND (operator: "concentrate trades in the bands with the
  // highest probability"). Pool growth at the trigger tick, measured over 7d:
  // 1.05-1.30x wins 44.8% (rugs 35.7%) · 1.30x+ wins 71.2% (rugs 11.1%) ·
  // 2.0x+ went 18-for-18. Live requires the strong band; paper keeps trading
  // every band as the sensor that re-measures this table.
  LIVE_MIN_INFLOW: z.coerce.number().default(1.3),
  // Pool-depth floor at live entry. BBC 616f (2026-07-22): a $3k dust pool
  // passed every SIGNAL gate mid-rug — live filled at the collapsed price and
  // never had a real way back out. Signals grade the trajectory; this grades
  // the EXIT: a pool must be deep enough to sell the floor position into.
  LIVE_MIN_ENTRY_LIQ_USD: z.coerce.number().default(8_000),
  // Smart-money-warm candidates (wh≥2, net≥1: 4.2% rug cohort) get a lower
  // depth floor — the floor is a RUG proxy, not exit physics at $4-6 size
  // (0.3% impact on a $2k pool), and the wallet graph discriminates rugs
  // better than depth does. Chillmothy (2★, w3/r0, 2.47× at 86% capture)
  // was refused at $1,972 by the flat floor while paper banked +$37.97.
  LIVE_MIN_ENTRY_LIQ_SM_USD: z.coerce.number().default(2_500),
  // ── DBC MOON TICKETS (operator, 2026-07-23: "open the moon factory") ──────
  // Blindspot audit: meteora-dbc birthed 114/145 witnessed 10x+ moons (79%),
  // 7-minute flights, pools $2.5–8k at trigger — 76/77 UNDER the $8k depth
  // floor, so live was locked out of the moon factory while paper realized
  // +$331 on 47 boarded dbc moons. Tickets are the bounded exception: dbc +
  // admissible signal (strong inflow OR winner-rep) + MOON/RISER class boards
  // at micro size (≤$2.50, ≤0.1% of pool → exit-at-size stays honest), max 3
  // concurrent, ≤$10/day. Worst case is four bad tickets, not a bleed; the
  // 10x tail is the payer. All kill switches ride on top.
  LIVE_DBC_TICKET_ENABLED: z.coerce.boolean().default(true),
  LIVE_DBC_TICKET_USD: z.coerce.number().default(2.5),
  LIVE_DBC_TICKET_MIN_LIQ_USD: z.coerce.number().default(2_500),
  LIVE_DBC_TICKET_POOL_FRAC: z.coerce.number().default(0.001),
  LIVE_DBC_TICKET_MAX_CONCURRENT: z.coerce.number().default(3),
  LIVE_DBC_TICKET_DAILY_BUDGET_USD: z.coerce.number().default(10),
  // 0★ live setups ran −55.3% on deployed — no evidence edge, full drag.
  // Live requires at least one conviction mark; paper still takes 0★.
  LIVE_MIN_STARS: z.coerce.number().default(1),
  // 2★ = the fingerprint plus independent evidence (50% live win rate even
  // through the drag era). The boost concentrates capital where the edge is
  // proven: paper's fraction × this, still capped by LIVE_MAX_POSITION_FRAC.
  LIVE_STAR2_BOOST: z.coerce.number().default(1.5),
  LIVE_SIZE_FRAC: z.coerce.number().default(0.1), // base position = 10% of balance
  LIVE_MAX_POSITION_FRAC: z.coerce.number().default(0.14), // ≤14% of balance in any one position
  LIVE_MAX_EXPOSURE_FRAC: z.coerce.number().default(0.75), // deploy ≤75% of balance (reserve for fees/rent)
  LIVE_MIN_FREE_SOL: z.coerce.number().default(0.03), // keep ≥0.03 SOL free for fees/ATA rent so buys don't fail
  LIVE_PROBE_SIZE_MULT: z.coerce.number().default(0.6), // off-hours/probe regime shrink
  // Absolute per-position backstop (frac governs in practice); balance-scaled kill.
  LIVE_MAX_POSITION_USD: z.coerce.number().default(40),
  LIVE_MAX_CONCURRENT: z.coerce.number().default(15), // count backstop; real limit is exposure fraction
  LIVE_DAILY_LOSS_CAP_USD: z.coerce.number().default(24), // ~40% of a $60 start — actually fires, unlike a stale $50
  LIVE_KILL_LOSS_USD: z.coerce.number().default(36), // ~60% of a $60 start — the permanent halt
  LIVE_WALLET_GATE: z
    .string()
    .default("true")
    .transform((v) => v !== "false"), // block a serial-rugger holder set with no smart-money offset
  // SMART-MONEY RESCUE: a token with ≥ this many winner-wallet holders and ZERO
  // rug-wallets is the proven-winning slice even on a bleeder venue, so it
  // overrides the premium-venue gate (the BRIBE +2× had 9 winner-wallets and was
  // wrongly excluded as meteora-damm-v2). 0 disables the rescue.
  LIVE_WALLET_RESCUE_MIN_WINNERS: z.coerce.number().default(2),
  // BLEEDING-REGIME GATE — don't follow the paper book into a hostile regime.
  // Paper is the regime sensor (high trade volume); if its realized over the
  // recent window is deeply negative, live stands down on NEW entries (open
  // positions still manage/exit normally) until the regime recovers.
  LIVE_REGIME_GATE: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  LIVE_REGIME_WINDOW_MIN: z.coerce.number().default(45),
  LIVE_REGIME_MAX_LOSS_USD: z.coerce.number().default(5), // paper realized over the window ≤ −this = bleeding
  // MIRROR-MODE regime signal — a PERCENTAGE, not a dollar amount. A fixed dollar
  // threshold does not scale: as paper's volume grows, normal 45-min swings grow
  // with it, so any dollar figure eventually pauses live constantly. The scale-
  // invariant signal is the venue EDGE over the window = net P&L ÷ gross capital
  // deployed. Measured windows swing −10% to +179% edge — the negative ones are
  // convex noise between winners — so only a CATASTROPHIC edge (a rug wave that
  // loses most of everything deployed) should preempt live. The live daily cap
  // (−$24) and kill (−$36) remain the real dollar backstops on live capital.
  LIVE_MIRROR_REGIME_MAX_LOSS_PCT: z.coerce.number().default(0.5), // edge ≤ −50% (lost half of deployed) = hostile
  LIVE_MIRROR_REGIME_MIN_GROSS_USD: z.coerce.number().default(100), // need this much deployed in the window for a signal; below it, don't gate
  // LIVE PROTECTIVE GUARD — the live lane's OWN downside exit, independent of the
  // paper twin. The −100% sweep loss (token dumped to ~zero before its paper twin
  // closed) is a RUG, detectable by POOL COLLAPSE, not price whipsaw. Each cycle,
  // probe every open live position's real sellability: catastrophic sell impact
  // (pool draining) or a mark past the WIDE catastrophe backstop → cut NOW while
  // liquidity remains. A tight price stop is deliberately AVOIDED — it would
  // forfeit the convex runners; this only kills the zero-bound tail.
  LIVE_GUARD_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  // Guard cadence. 15s was calibrated as a Jupiter-probe throttle when live
  // merely shadowed paper; as an independent lane it is the exit loop, and the
  // gap is where runners die: AFTER (MOON_FAST) peaked 7.84x live and closed
  // -$1.88 because the pool collapsed through the trail floor (~5.4x) inside a
  // single 15s window, while paper's 2s loop banked +$27.93 on the same signal.
  // 5s triples the quote load on a book of 0-3 positions — trivial — and cuts
  // the worst-case blind window by two-thirds. True 2s parity would need a
  // price feed instead of sell-route quotes; this is the cheap 80%.
  LIVE_GUARD_MS: z.coerce.number().default(5000),
  LIVE_RUG_IMPACT_PCT: z.coerce.number().default(40), // sell price-impact above this = pool collapse → cut
  LIVE_CATASTROPHE_STOP_PCT: z.coerce.number().default(55), // mark down past this = cut (wide, rides whipsaw)
  // LIVE LANE HARD RULE (pre-committed while paper-only, per advisor): an
  // INCONCLUSIVE honeypot probe (Jupiter unreachable / token unroutable) is a
  // paper-only soft flag — with real capital, unverifiable sellability is a
  // HARD block. The live lane must refuse any entry whose honeypot check did
  // not affirmatively verify a sell route. Default true; do not relax.
  LIVE_REQUIRE_HONEYPOT_VERIFIED: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  // Live swap slippage tolerance (basis points). 300 = 3%: tight enough that a
  // draining pool rejects, loose enough that a normal thin-pool fill lands. This
  // is the ENTRY tolerance — keep it tight so a bad-priced buy is refused.
  LIVE_SLIPPAGE_BPS: z.coerce.number().default(300),
  // EXIT slippage tolerance — deliberately WIDER than entry. In a convex book the
  // winners are the whole P&L, so banking a trail on a fast-pulling-back runner
  // must PRIORITIZE LANDING over price: a min-out computed on pool state that
  // moved a moment ago reverts (the DOW live sell sim-failed twice at 3% before a
  // retry landed), and repeatedly failing to exit a winner round-trips it. 10%
  // ensures the exit fills; the guard's catastrophe/rug stops backstop the worst.
  LIVE_SELL_SLIPPAGE_BPS: z.coerce.number().default(1000),
  // Smallest sell a venue reliably fills — rung fractions below this are bumped
  // up at dispatch (pumpportal rejects sub-$1 builds with 400; the rung then
  // never banks and the position rides unbanked).
  LIVE_MIN_SELL_NOTIONAL_USD: z.coerce.number().default(1.5),
  // TAKE-PROFIT tolerance — the rungs bank INTO STRENGTH, so unlike a trail they
  // have no urgency and must not pay the trail's 10% to land. Measured 2026-07-20:
  // live TP0 filled at a 1.018× median against paper's 1.136× over the same tape,
  // with 3 of 9 fills landing BELOW ENTRY (PURPLE 0.806×, Rigby 0.863×) while paper
  // went 0-for-72 below entry. The ~10.4% gap is the sell tolerance being consumed
  // by adverse movement between quote and confirm — a rung labelled "take profit"
  // was realizing −19%. At 3% an adverse move that large REVERTS instead of filling,
  // and we retry a moment later; if price is genuinely collapsing that fast it is
  // the trail and the guard's job to exit, not the profit ladder's.
  // 300 → 1000 (2026-07-21). The tight tolerance was introduced on a theory —
  // that live TP0 was donating ~10% to slippage — which the data then DISPROVED:
  // there were zero slippage refusals and the gap was upstream of execution. The
  // tolerance was never reverted, and at 3% every take-profit rung began
  // REVERTING ON-CHAIN (InstructionError Custom:1, a min-out violation). The
  // consequence was worse than the imagined problem: seven live positions sat
  // open past their clocks with qty_remaining at 100% — not one tranche sold —
  // while paper cycled 103 closes in the same window. A rung that cannot land is
  // strictly worse than a rung that lands a few percent low, because the position
  // then has no exit at all. Paper applies no slippage constraint whatsoever;
  // matching its behaviour means prioritising the fill.
  LIVE_TP_SLIPPAGE_BPS: z.coerce.number().default(1000),
  // LIVE PREMIUM-VENUE GATE — real capital only enters venues the recorder has
  // proven premium by MEASURED performance, never by volume/'core' label
  // (volume ≠ quality: the highest-volume venue can be the biggest bleeder).
  // A venue qualifies for live capital when it is NOT blocked, has enough sample
  // (watched ≥ LIVE_VENUE_MIN_N), keeps drawdown down (rug ≤ LIVE_VENUE_MAX_RUG),
  // AND is proven to make money (realized_24h > 0) OR has earned 'promoted'.
  // Note we do NOT gate on win RATE — these are convex venues where the hit rate
  // is low but winners are huge, so a win-rate floor would wrongly cut the best
  // venue. Rug rate (drawdown) + realized P&L (upside proven) are the real
  // discriminators. Paper explores the whole universe so venues can earn their
  // numbers; live exploits only the measured-premium map. Skip reason surfaces
  // in the paper-vs-live funnel. ∪ static PRIME_VENUES always.
  LIVE_PREMIUM_ONLY: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  LIVE_VENUE_MAX_RUG: z.coerce.number().default(0.25), // drawdown gate — cleanly separates pumpswap(.16) from toxic core(.37+)
  LIVE_VENUE_MIN_N: z.coerce.number().default(15), // sample floor before a venue can hold real capital
  // MIRROR MODE — the live lane copies the PAPER lane's entries (which it already
  // mirror-sells on paper's exits) instead of applying its own stricter selection
  // gate. Rationale (validated 2026-07-17 morning session): paper netted +$1,066
  // with ~94% of it on pumpswap (BRIBE 111×/+$750, all the top winners), while the
  // live lane's premium+honeypot gate skipped those exact tokens — 61 blocked on
  // "honeypot not affirmatively verified" (a Jupiter-OUTAGE artifact: the swap-sim
  // probe is inconclusive, route=none, for every one of the winners) and 100+ on
  // "venue not premium". Mirror mode keeps EVERY capital-protection check (kill,
  // daily cap, exposure, concurrency, regime, rug-wallet trap) but (a) swaps the
  // premium-venue filter for an EXECUTABLE-venue filter and (b) makes the honeypot
  // check trap-only. Safe because the executable venues are standard-program
  // curve/AMM tokens (sells structurally symmetric with buys — no buy-yes/sell-no
  // construct), paper already cleared the keyless RugCheck trap gate on each, and
  // positions stay small + exposure-capped.
  LIVE_MIRROR_PAPER: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  // Venues the live lane can actually route+exit WITHOUT Jupiter (PumpPortal covers
  // pump.fun/pumpswap/pump-amm/bonding; Fluxbeam covers its own pools). This is the
  // mirror-mode entry filter: it captures paper's entire winning set (pumpswap,
  // fluxbeam, pump-amm, meteora-dbc) and naturally drops the unroutable net-negative
  // bleeder (meteora-damm-v2: 140 trades, +$4 in FRICTIONLESS paper, negative live).
  // Widen when Jupiter recovers (then all venues become routable).
  LIVE_MIRROR_VENUES: z.string().default("pumpswap,pump-amm,fluxbeam,meteora-dbc,pumpfun,bags-fm"),
  // EXIT PRE-CHECK — "never enter what we can't currently sell." Before every live
  // buy, verify a REAL sell route exists for the token right now; a token we can
  // buy but not sell is a guaranteed strand (KIMI). pump.fun-origin tokens are
  // inherently sellable (symmetric curve/pool) and skip the network probe; the
  // graduated non-pump class — the actual strand risk — is verified via PumpSwap
  // pool then Jupiter. This is what makes selective all-venue trading safe.
  LIVE_EXIT_PRECHECK: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  // Stranded-position write-off. A live position whose token has NO exit route on
  // any provider (pool dumped to dust, all routes exhausted) is a total loss, not
  // an open position — but the sweep would otherwise retry the doomed sell every
  // 5s forever (KIMI spammed for 57min). After this many minutes of a route-
  // exhausted sell failure, book the honest loss and close the row.
  LIVE_STRAND_WRITEOFF_MIN: z.coerce.number().default(8),
  // ANTICIPATION-DRIVEN SIZING — the forward forecast as a control input, not just
  // a dashboard readout. Lean size IN when the token's venue is HEATING (paper
  // realized rising, last 3h vs prior) and the window's TAIL ODDS are elevated;
  // throttle when cold. Bounded so it TILTS the sizer within its clamps, never
  // dominates — a heating venue in a hot window sizes toward the 14% cap, a cold
  // one toward the floor. This is how the overnight-bleed lesson becomes action.
  LIVE_ANTICIPATION_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  LIVE_ANTICIPATION_MIN: z.coerce.number().default(0.6), // floor on the combined tilt
  LIVE_ANTICIPATION_MAX: z.coerce.number().default(1.5), // ceiling on the combined tilt
  LIVE_ANTI_MOMENTUM_USD: z.coerce.number().default(3), // |recent−prior| paper P&L to call a venue heating/cooling
  // ANTICIPATION GATE — the forecast as a STAND-DOWN, not just a size tilt. The
  // kill autopsy (2026-07-18): live burned its runway taking shots in COLD windows
  // (probe hours run a 4.58% tail rate vs 7.82% in prime — tails cluster 1.7× in
  // prime) and hit 0 tails before the −$36 kill. A thin wallet cannot afford
  // low-tail-probability shots. So when the combined anticipation signal (venue
  // momentum × tail odds) is below this floor, live STANDS DOWN entirely and
  // preserves runway for the warm windows where tails actually fire. This converts
  // a few cheap shots into few HIGH-QUALITY shots — the real fix for "died dry".
  LIVE_ANTICIPATION_GATE: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  LIVE_ANTICIPATION_GATE_MIN: z.coerce.number().default(0.85), // skip entry when anticipation mult < this (cold)
  // FAST LIVE PROTECTIVE STOP — live's own executable stop, independent of the
  // paper mirror. The kill autopsy (2026-07-18): live lost FULL positions to
  // `live_sweep_close` because (a) the guard was blind to graduated-pumpswap
  // tokens (swap quote canValue=false → it skipped them) so no stop fired, and
  // (b) it only cut at the −55% catastrophe line, by which point the route is
  // dead. Fix: value EVERY position by its price mark, cut at this tighter
  // drawdown while liquidity still exists, and DUMP at market (wide slippage) so
  // the exit actually fills instead of reverting into the −100% sweep. Paper's
  // stop is a fiction (instant fill at the stop price); this is live's real one.
  LIVE_STOP_PCT: z.coerce.number().default(28), // mark drawdown that triggers the fast protective cut
  LIVE_STOP_SLIPPAGE_BPS: z.coerce.number().default(3500), // 35% — a stop must FILL; any fill beats the −100% sweep
  // DAILY-CAP THROTTLE (not halt). A daily cap that STOPS trading locks in the
  // loss and forfeits the recovery tail — the single most losing behavior for a
  // tail strategy (24h autopsy: live daily-capped → sat out EVERY mover → the
  // −$47 was guaranteed). Instead, as the day's loss grows toward the cap, SHRINK
  // position size toward this floor but KEEP taking shots — stay present for the
  // tail. Only the hard cumulative KILL (−$KILL) truly halts, protecting the wallet.
  LIVE_DAILY_THROTTLE_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  LIVE_DAILY_THROTTLE_MIN: z.coerce.number().default(0.4), // size multiplier at/beyond the daily cap
  // EARLY-FILL FLOOR — the insurance leg (docs/live-early-fill-floor.md). Paper's TP0
  // floor fills at a mark; live's must fill into a real pool that can vanish, which is
  // why live's rugs went −100% while paper banked 40%. The guard loop already values
  // each open position via a REAL SELL QUOTE every ~5s; when that value is ≥ arm mult
  // AND nothing's banked yet, bank the first defensive tranche NOW — the sell-quote
  // itself is the liquidity gate (no quote → can't fire → no false bank). Wallet
  // crucible on the real Wed–Sat sequence: this flips the $60/6% death (17%/$2) to
  // 100%/$2,936. Ships DARK: enable + observe in LOG-ONLY before any capital moves.
  LIVE_FLOOR_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  LIVE_FLOOR_LOG_ONLY: z
    .string()
    .default("true")
    .transform((v) => v !== "false"), // shadow: log the 🩹 intent, don't sell — flip to false to arm
  // ── LIVE PROFIT FLOOR (with latency LEAD) ─────────────────────────────────
  // Paper protects 68.2% of the positions that reach its arm threshold; live
  // protects 46.7% on identical rules. The 21-point gap is not logic, it is
  // execution: paper's floor sells at 1.02x instantly, live's identical order
  // confirms ~5s later and lands THROUGH the line. So live defends a HIGHER
  // line — the lead — and its late fill arrives at roughly where paper's
  // exited. The guard values by a REAL sell quote, so this only fires when a
  // live exit genuinely exists. Independent of the paper mirror: live owns its
  // own profit protection rather than waiting to be told.
  LIVE_PROFIT_FLOOR_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  // Live arms and floors ABOVE paper's (paper 1.03/1.02) — the lead that pays
  // for confirm latency, since live's identical order lands ~5s later and lower
  // (Jimhood: paper's TP0 filled 1.102×, live's 1.008×). The lead cannot fully
  // cover a violent gap; its job is to catch the ordinary fades, which are the
  // majority. Arm must stay above floor or the lock fires on entry.
  LIVE_PROFIT_ARM_MULT: z.coerce.number().default(1.05),
  LIVE_PROFIT_FLOOR_MULT: z.coerce.number().default(1.03),
  LIVE_FLOOR_ARM_MULT: z.coerce.number().default(1.15), // = TP0_MULT; bank the first tranche into the blow-off
  LIVE_FLOOR_FRACTION: z.coerce.number().default(0.4), // = TP0_CUM_SELL; farm tape uses FARM_TP0_CUM_SELL (cost-recoup 0.87)
  LIVE_FLOOR_SLIPPAGE_BPS: z.coerce.number().default(900), // banking into strength — wide enough to fill a fast mover, not a panic dump
});

export type HermesConfig = z.infer<typeof envSchema> & { rpcUrl: string; rpcUrls: string[] };

// Keyless public fallbacks — genuinely keyless + reachable. NOTE: rpc.ankr.com
// (403) and solana.drpc.org (400) require API keys and were removed — they were
// dead weight. For real redundancy configure a working second RPC via RPC_URLS
// (Helius/Triton/paid). On a DPI-filtered host, mainnet-beta may only answer via
// curl, not Node's fetch — so on such hosts the pool is effectively the primary.
const PUBLIC_RPC_FALLBACKS = [
  "https://solana-rpc.publicnode.com",
  "https://api.mainnet-beta.solana.com",
];

let cached: HermesConfig | null = null;

export function loadConfig(): HermesConfig {
  if (cached) return cached;
  const env = envSchema.parse(process.env);
  const rpcUrl =
    env.HELIUS_API_KEY && env.HELIUS_RPC_ENABLED
      ? `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`
      : env.SOLANA_RPC_URL;
  const extra = env.RPC_URLS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const rpcUrls = [...new Set([rpcUrl, ...extra, ...PUBLIC_RPC_FALLBACKS])]; // primary first, deduped
  cached = { ...env, rpcUrl, rpcUrls };
  return cached;
}
