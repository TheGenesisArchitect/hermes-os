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
  TRADER_POLL_MS: z.coerce.number().default(20_000), // cadence for SCANNING/opening new entries
  // Cadence for MANAGING open positions — the exit is where gains are kept or
  // lost, so it runs far tighter than the scan loop. Soly gave back 68% of its
  // move because 20s between looks let it roll 1.78x→1.25x unseen; the deaths
  // that showed 1 tick died inside a single 20s gap. Keyless DexScreener, so we
  // can poll hard. (DexScreener's own aggregation lag is the deeper ceiling — a
  // real-time Jupiter mark is the next lever if this isn't tight enough.)
  MANAGE_POLL_MS: z.coerce.number().default(5_000),
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
  PROFIT_LOCK_ARM_MULT: z.coerce.number().default(1.08),
  PROFIT_LOCK_FLOOR_MULT: z.coerce.number().default(1.02),
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
  TP2_MULT: z.coerce.number().default(1.7), // +70% — bank most of the rest
  TP2_CUM_SELL: z.coerce.number().default(0.8), // total 80% banked by TP2; the remaining 20% rides uncapped
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
  FARM_TP0_CUM_SELL: z.coerce.number().default(1.0), // farm: 100% out at the first level (1.15x)
  FARM_TP1_CUM_SELL: z.coerce.number().default(1.0), // gap-up past 1.15 still dumps 100%
  FARM_TP2_CUM_SELL: z.coerce.number().default(1.0), // nothing ever rides into the cliff
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
  TRAIL_MID_PCT: z.coerce.number().default(10), // 2.5x .. 6x — proven runner, a little room
  TRAIL_WIDE_PCT: z.coerce.number().default(18), // >= 6x — parabolic, don't get shaken out
  TRAIL_RIDE_BONUS_PCT: z.coerce.number().default(6), // classifier RIDE widens slightly (was 15 — the giveback source)
  // BANK-FIRST-THEN-LEASH: once any TP tranche has banked, the runner is house
  // money — its trail floors here instead of the tight wick-noise width, and a
  // rollover snug clamps to this (not to TRAIL_TIGHT). Unpaid positions are
  // untouched. Rationale: the 5-6.8% tight trail fires inside normal 5s wick
  // noise, exiting 9-90s after entry at breakeven while the token runs 1.3-2.3x.
  POST_BANK_TRAIL_PCT: z.coerce.number().default(12),
  HARD_STOP_PCT: z.coerce.number().default(5), // pre-ignition: a confirmed entry that reverses 5% failed — cut it cheap (~-$0.9 not -$17)
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
  RECORDER_POLL_MS: z.coerce.number().default(30_000),
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
  CONFIRM_MAX_WATCH_MIN: z.coerce.number().default(12), // still inside the watch window
  CONFIRM_MIN_TICKS: z.coerce.number().default(2), // need a trajectory, not one snap
  CONFIRM_MIN_MULT: z.coerce.number().default(1.25), // green and established vs ref
  CONFIRM_MAX_DD_PCT: z.coerce.number().default(10), // near the highs, not rolling over
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
  RUG_PROB_CAUTION: z.coerce.number().default(0.39), // held-out Q4 boundary → ×RUG_SIZE_CAUTION
  RUG_PROB_HIGH: z.coerce.number().default(0.45), // held-out Q5 boundary → ×RUG_SIZE_HIGH
  RUG_SIZE_CAUTION: z.coerce.number().default(0.6),
  RUG_SIZE_HIGH: z.coerce.number().default(0.35),
  // CONVICTION SIZING — a candidate that confirmed at ≥ this market-proven
  // multiple (ARGENTINU armed at 4.94x, ran 11.4x) earns a boosted bet; a
  // 1.26x mill relaunch does not. Quality gets the capital, mills get scraps.
  CONVICTION_MULT_MIN: z.coerce.number().default(2.5),
  CONVICTION_SIZE_BOOST: z.coerce.number().default(1.4),
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
  CONFIRM_MAX_TRIGGER_AGE_SEC: z.coerce.number().default(90),
  // Refuse to open into a collapsed/near-empty pool: at $17.50 size a 30% convex
  // slip means liquidity < ~$82 (rugged), while a legit thin-pool entry is <1%.
  // This never blocks a real convex candidate — it blocks buying a corpse.
  ENTRY_MAX_SLIPPAGE_PCT: z.coerce.number().default(30),

  LIVE_TRADING_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  LIVE_MAX_POSITION_USD: z.coerce.number().default(25),
  LIVE_MAX_CONCURRENT: z.coerce.number().default(2),
  LIVE_DAILY_LOSS_CAP_USD: z.coerce.number().default(50),
  // LIVE LANE HARD RULE (pre-committed while paper-only, per advisor): an
  // INCONCLUSIVE honeypot probe (Jupiter unreachable / token unroutable) is a
  // paper-only soft flag — with real capital, unverifiable sellability is a
  // HARD block. The live lane must refuse any entry whose honeypot check did
  // not affirmatively verify a sell route. Default true; do not relax.
  LIVE_REQUIRE_HONEYPOT_VERIFIED: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
});

export type HermesConfig = z.infer<typeof envSchema> & { rpcUrl: string };

let cached: HermesConfig | null = null;

export function loadConfig(): HermesConfig {
  if (cached) return cached;
  const env = envSchema.parse(process.env);
  const rpcUrl =
    env.HELIUS_API_KEY && env.HELIUS_RPC_ENABLED
      ? `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`
      : env.SOLANA_RPC_URL;
  cached = { ...env, rpcUrl };
  return cached;
}
