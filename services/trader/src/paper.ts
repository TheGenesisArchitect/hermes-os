import {
  canonicalVenue,
  classify,
  convexSlippagePct,
  DEFAULT_CLASSIFIER,
  fetchJupiterPrice,
  fetchJupiterPrices,
  fetchTokenMarket,
  fetchTokenMarkets,
  tickFrom,
  type HermesConfig,
  type ManagementCall,
  type TokenMarket,
} from "@hermes/core";
import {
  auditLog,
  candidateOutcomes,
  config,
  db,
  fills,
  managementIntents,
  pnlSnapshots,
  positionTicks,
  positions,
  signals,
  tokens,
} from "@hermes/db";
import { and, asc, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { maybeLiveBuy, mirrorLiveSell } from "./live/executor.js";

/** How many recent ticks the classifier reads to judge continuation. */
const TICK_WINDOW = 12;

const FEE_PCT = 0.25; // per-side swap fee estimate
const FIXED_FEE_USD = 0.02; // priority fee / network cost per fill

// Convex constant-product price impact — the shared @hermes/core model, so the
// trader's fills and the dashboard's realizable-P&L float box compute slippage
// identically (one source of truth, no drift).
const slippagePct = convexSlippagePct;

function n(v: string | null): number {
  return v === null ? 0 : Number(v);
}

type Position = typeof positions.$inferSelect;

async function audit(action: string, details: Record<string, unknown>): Promise<void> {
  await db.insert(auditLog).values({ actor: "trader", action, details });
}

function short(mint: string): string {
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

type SignalRow = typeof signals.$inferSelect;
type TokenRow = typeof tokens.$inferSelect;

/**
 * Open a single paper position from a signal that has cleared its entry gate
 * (blind-fresh, or recorder-confirmed). Handles the venue/liquidity defenses,
 * risk-tier sizing, Jupiter-mark entry and fill ledger; updates signal status.
 * Returns true if a position opened. Shared by both entry paths so entry
 * mechanics stay identical no matter what fired the entry.
 */
/**
 * Assign a capacity lane from the entry-time convexity fingerprint. The eventual
 * multiple is unknowable at entry (the early classifier score is saturated), so
 * we bucket on the best observable proxy: a thin pool on a bonding-curve /
 * graduation source is the McGwegor-327x shape (moonshot); a mid pool is a core
 * mover; a deep pool is too heavy to convex-move (base grind). Reserving capacity
 * per lane is what stops the abundant small movers from crowding out the rare
 * monster — the 0-of-4 failure.
 */
export function classifyLane(cfg: HermesConfig, liquidityUsd: number, dex: string): "moonshot" | "core" | "base" {
  const d = (dex || "").toLowerCase();
  const convexSource = [...cfg.LANE_MOON_SOURCES].some((m) => d.includes(m));
  // Moonshot = the thin, convex fat-tail zone. Calibrated on real trigger-window
  // data: the 3x+ tier's liquidity p25 is ~$28k and the 167x class lives in thin
  // pools, so a thin pool (regardless of source) earns a reserved slot. A
  // bonding-curve / dbc source (highest 3x+ hit-rate in the data) also qualifies
  // up to the core ceiling. Everything mid → core; deep pools too heavy to
  // convex-move → base grind.
  if (liquidityUsd <= cfg.LANE_MOON_LIQ_MAX) return "moonshot";
  if (convexSource && liquidityUsd <= cfg.LANE_CORE_LIQ_MAX) return "moonshot";
  if (liquidityUsd <= cfg.LANE_CORE_LIQ_MAX) return "core";
  return "base";
}

/** Live count of open positions per lane — the shared book capacity acts on. */
export type LaneBook = { moonshot: number; core: number; base: number };

/**
 * RESERVED-MINIMUM / SHARED-MAXIMUM admission. A lane may take a slot when the
 * book is below the global cap AND doing so wouldn't dip into another lane's
 * still-unmet reserved minimum. This guarantees the scarce thin fat-tail lane
 * always has room (it's never crowded out by abundant base movers) while letting
 * any lane spend the surplus above the reserves — so no slot ever sits idle.
 * Hard per-lane caps would have turned a hot lane's candidates away while other
 * slots sat empty, which is strictly FEWER trades — the opposite of the goal.
 */
export function laneHasRoom(cfg: HermesConfig, lane: keyof LaneBook, open: LaneBook): boolean {
  const total = open.moonshot + open.core + open.base;
  if (total >= cfg.PAPER_MAX_CONCURRENT) return false;
  const reserve: LaneBook = {
    moonshot: cfg.LANE_MOONSHOT_MIN,
    core: cfg.LANE_CORE_MIN,
    base: cfg.LANE_BASE_MIN,
  };
  let reservedElsewhere = 0;
  for (const m of ["moonshot", "core", "base"] as (keyof LaneBook)[]) {
    if (m !== lane) reservedElsewhere += Math.max(0, reserve[m] - open[m]);
  }
  return cfg.PAPER_MAX_CONCURRENT - total - reservedElsewhere > 0;
}

// Divergence forensics per mint: the last disputed (jup, dex) pair we refused to
// enter on. A Jupiter datapi read that stays FROZEN across attempts while the
// DexScreener price keeps moving is a stale/wrong-pool index entry, not a fresher
// truth — the recorded skips show byte-identical jup values across minutes while
// dex climbed (SOLenoids 124x→212x→243x divergence as it ran to 3.6x unentered).
const divergenceSeen = new Map<string, { jup: number; dex: number; at: number }>();
const DIVERGENCE_SEEN_TTL_MS = 15 * 60_000;

async function openFromSignal(
  cfg: HermesConfig,
  signal: SignalRow,
  token: TokenRow,
  note = "",
  book?: LaneBook,
  // Combined confirm-quality multiplier (buy-share × rug-model × conviction):
  // 1 = full conviction; <1 shrinks the bet; >1 boosts a proven mover (sizing,
  // never a veto — see config).
  qualityMult = 1,
  // Market-proven multiple at the confirm (recorder ref-relative). Persisted so
  // exit-zone selection knows the token already proved e.g. 4.9x — an entry-
  // relative 1.2x on such a token is a RUNNER, not a spike (ARGENTINU lesson).
  triggerMult: number | null = null,
): Promise<boolean> {
  const market = await fetchTokenMarket(signal.mint).catch(() => null);
  if (!market) {
    await db.update(signals).set({ status: "expired" }).where(eq(signals.id, signal.id));
    return false;
  }
  // Enter on the same real-time mark management uses, so the multiple baseline is
  // coherent between entry and every exit decision that follows. When Jupiter and
  // DexScreener AGREE, adopt the Jupiter (block-level) price. When they DIVERGE at
  // entry, DO NOT enter — the price is disputed and we cannot know which is real.
  //
  // The old code kept DexScreener on divergence and entered anyway. That booked
  // real phantom LOSSES: DexScreener aggregates with lag, Jupiter is block-level
  // and often FRESHER, so "keep DexScreener" can mean entering at a STALE HIGH
  // quote the token has already fallen from — a fill we could never have gotten —
  // then the first real mark lands and hard-stops instantly (pos 28 Mbappe: entered
  // at a stale DexScreener $0.0001754 after Jupiter already showed $0.0000307, −$14.41
  // in ONE second; pos 25 MAGABOB identical, −$14.05). It is the mirror of the
  // phantom-WIN case (a bad LOW read fabricating a gain). The only safe move on a
  // disputed entry price is to refuse the entry. This DEFERS (no signal-status
  // change, candidate stays armed): if the feeds reconcile HIGH we enter next cycle;
  // if they reconcile LOW the recorder disarms the dead move — either way no phantom.
  const jpEntry = await fetchJupiterPrice(cfg.JUPITER_PRICE_URL, signal.mint).catch(() => null);
  if (jpEntry && jpEntry > 0 && market.priceUsd > 0) {
    const diverges =
      jpEntry > market.priceUsd * cfg.MARK_FEED_DIVERGENCE ||
      jpEntry < market.priceUsd / cfg.MARK_FEED_DIVERGENCE;
    if (diverges) {
      const ratio = Math.max(jpEntry, market.priceUsd) / Math.min(jpEntry, market.priceUsd);
      const now = Date.now();
      // Prune stale forensics so the map never grows unbounded.
      for (const [m, v] of divergenceSeen) if (now - v.at > DIVERGENCE_SEEN_TTL_MS) divergenceSeen.delete(m);
      const prev = divergenceSeen.get(signal.mint);
      // Frozen-Jupiter discriminator: a SECOND divergent attempt ≥15s later where
      // Jupiter is unchanged (±2%) but DexScreener moved (>3%) means Jupiter is a
      // stale index read — a genuinely fresher Jupiter tracking a real dump would
      // itself be MOVING (Mbappe), and a stale-high DexScreener would be the frozen
      // one. Only this signature trusts DexScreener and enters; everything else
      // still defers exactly as before.
      const jupFrozen = prev !== undefined && now - prev.at >= 15_000 && prev.jup > 0 && Math.abs(jpEntry - prev.jup) / prev.jup < 0.02;
      const dexMoved = prev !== undefined && prev.dex > 0 && Math.abs(market.priceUsd - prev.dex) / prev.dex > 0.03;
      divergenceSeen.set(signal.mint, { jup: jpEntry, dex: market.priceUsd, at: now });
      if (jupFrozen && dexMoved) {
        await audit("entry_jupiter_stale_override", {
          mint: signal.mint,
          jup: jpEntry,
          dex: market.priceUsd,
          ratio: Number(ratio.toFixed(2)),
          sinceFirstSkipSec: Number(((now - prev.at) / 1000).toFixed(0)),
        });
        console.log(
          `🔓 UNSKIP ${token.symbol ?? "?"} ${short(signal.mint)} — Jupiter frozen at $${jpEntry} while dex moved $${prev.dex}→$${market.priceUsd}; stale index, entering on DexScreener`,
        );
        // Fall through on the DexScreener price — do NOT adopt the frozen read.
      } else {
        await audit("entry_feed_divergence_skip", {
          mint: signal.mint,
          jup: jpEntry,
          dex: market.priceUsd,
          ratio: Number(ratio.toFixed(2)),
        });
        console.log(
          `⛔ SKIP   ${token.symbol ?? "?"} ${short(signal.mint)} — feed divergence ${ratio.toFixed(1)}× (dex $${market.priceUsd} vs jup $${jpEntry}); price disputed, deferring`,
        );
        return false;
      }
    } else {
      divergenceSeen.delete(signal.mint);
      market.priceUsd = jpEntry;
    }
  }

  // Entry defense: refuse the cohorts that only bleed. A blocked venue or a
  // pool too deep to convex-move is capital we simply don't put at risk.
  // tokens.dex (ingest canonical) FIRST, live feed resolved through
  // canonicalVenue as fallback — raw dexId reads "meteora" for bags-fm/damm-v2
  // and would silently never match the blocklist (the dex-string leak).
  const dex = (token.dex || canonicalVenue(market) || "").toLowerCase();
  if (cfg.ENTRY_BLOCK_DEXES.has(dex)) {
    await audit("entry_filtered", { mint: signal.mint, reason: `blocked venue ${dex}` });
    await db.update(signals).set({ status: "dismissed" }).where(eq(signals.id, signal.id));
    console.log(`⛔ SKIP   ${token.symbol ?? "?"} ${short(signal.mint)} — venue ${dex} blocked (0-win cohort)`);
    return false;
  }
  if (cfg.ENTRY_MAX_LIQUIDITY_USD > 0 && market.liquidityUsd > cfg.ENTRY_MAX_LIQUIDITY_USD) {
    await audit("entry_filtered", {
      mint: signal.mint,
      reason: `liquidity $${Math.round(market.liquidityUsd)} > ceiling $${cfg.ENTRY_MAX_LIQUIDITY_USD}`,
    });
    await db.update(signals).set({ status: "dismissed" }).where(eq(signals.id, signal.id));
    console.log(
      `⛔ SKIP   ${token.symbol ?? "?"} ${short(signal.mint)} — liquidity $${Math.round(market.liquidityUsd).toLocaleString()} too deep to move`,
    );
    return false;
  }

  // FARM BOOK CAP (Law 1: the pond decides) — farm-tape positions may occupy at
  // most FARM_MAX_SLOTS of the book. meteora-damm-v2 has been net-negative in
  // EVERY session yet filled 92% of our volume; the slots this cap holds open
  // are reserved for organic-venue confirms, the only cells that ever paid.
  if (cfg.FARM_MAX_SLOTS > 0 && isFarmTape(cfg, market)) {
    // Count open farm-tape positions via inArray (raw ANY(${array}) interpolation
    // expanded to scalar params and threw on every tick — the 06:25Z wedge).
    const farmVenueList = [...cfg.FARM_VENUES, ...autoFarm.venues];
    const farmSymbolList = [...autoFarm.symbols];
    const farmConds = [
      ...(farmVenueList.length ? [inArray(sql`lower(coalesce(${tokens.dex},''))`, farmVenueList)] : []),
      ...(farmSymbolList.length ? [inArray(sql`lower(coalesce(${tokens.symbol},''))`, farmSymbolList)] : []),
    ];
    const [farmOpen] = farmConds.length
      ? await db
          .select({ n: sql<number>`count(*)::int` })
          .from(positions)
          .innerJoin(tokens, eq(tokens.mint, positions.mint))
          .where(and(eq(positions.status, "open"), eq(positions.lane, "paper"), or(...farmConds)))
      : [{ n: 0 }];
    if ((farmOpen?.n ?? 0) >= cfg.FARM_MAX_SLOTS) {
      await audit("entry_farm_cap_defer", { mint: signal.mint, dex: market.dexId, farmOpen: farmOpen?.n ?? 0 });
      console.log(`⛔ DEFER  ${token.symbol ?? "?"} ${short(signal.mint)} — farm book full (${farmOpen?.n}/${cfg.FARM_MAX_SLOTS}); slots reserved for organic venues`);
      return false;
    }
  }

  // CONCENTRATION CAP — never let one deployer's clone wave own the book. The
  // 24/24 W26/USOH die-off proved same-symbol clones rug together; cap open
  // positions per symbol so a wave can take AT MOST MAX_PER_SYMBOL slots.
  // DEFER (false, no status change) — a slot frees when a sibling closes.
  if (cfg.MAX_PER_SYMBOL > 0 && token.symbol) {
    const [sameSymbol] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(positions)
      .innerJoin(tokens, eq(tokens.mint, positions.mint))
      .where(and(eq(positions.status, "open"), eq(positions.lane, "paper"), eq(tokens.symbol, token.symbol)));
    if ((sameSymbol?.n ?? 0) >= cfg.MAX_PER_SYMBOL) {
      await audit("entry_concentration_defer", { mint: signal.mint, symbol: token.symbol, open: sameSymbol?.n ?? 0 });
      console.log(`⛔ DEFER  ${token.symbol} ${short(signal.mint)} — already ${sameSymbol?.n} open positions on this ticker (wave cap ${cfg.MAX_PER_SYMBOL})`);
      return false;
    }
  }

  // Risk-tier sizing — a soft safety flag shrinks the bet, it doesn't veto it.
  const risk = (signal.reasons as { risk?: { sizeMultiplier?: number; tier?: string } } | null)?.risk;
  const sizeMult = typeof risk?.sizeMultiplier === "number" ? risk.sizeMultiplier : 1;
  // Session sizing — survive the dead zone, grow in the moonshot window.
  const sessionMult = cfg.PRIME_HOURS_UTC.has(new Date().getUTCHours()) ? 1 : cfg.OFF_HOURS_SIZE_MULT;
  const sizeUsd = Number((cfg.PAPER_POSITION_USD * sizeMult * qualityMult * sessionMult).toFixed(2));
  const slip = slippagePct(sizeUsd, market.liquidityUsd);
  // Never buy a corpse: a slip past the cap means the pool has drained since the
  // trigger fired (the 99%-slip dead-pool entries the 1e backlog produced).
  if (cfg.ENTRY_MAX_SLIPPAGE_PCT > 0 && slip > cfg.ENTRY_MAX_SLIPPAGE_PCT) {
    await audit("entry_filtered", {
      mint: signal.mint,
      reason: `entry slippage ${slip.toFixed(0)}% > cap ${cfg.ENTRY_MAX_SLIPPAGE_PCT}% — pool collapsed`,
    });
    await db.update(signals).set({ status: "dismissed" }).where(eq(signals.id, signal.id));
    console.log(`⛔ SKIP   ${token.symbol ?? "?"} ${short(signal.mint)} — entry slip ${slip.toFixed(0)}% (pool drained, would buy a corpse)`);
    return false;
  }
  // Capacity lane: assign from the convexity fingerprint, then enforce the lane's
  // reserved cap. A full lane DEFERS (return false, no signal-status change) so
  // the candidate stays armed and enters when a slot in ITS lane frees — a
  // moonshot is never crowded out by a book full of base movers, and vice-versa.
  const lane = classifyLane(cfg, market.liquidityUsd, dex);
  if (book && !laneHasRoom(cfg, lane, book)) {
    // Instrument the one number that says whether lanes help or starve: a defer
    // while the book still had a free slot globally means this candidate was
    // turned away purely by reservation policy (another lane's reserve protected
    // it). If this stays ~0 the lanes are harmless; if it climbs they're biting.
    const globalRoom = book.moonshot + book.core + book.base < cfg.PAPER_MAX_CONCURRENT;
    await audit("lane_full", { mint: signal.mint, lane, symbol: token.symbol ?? "?", globalRoom });
    return false;
  }

  const entryPrice = market.priceUsd * (1 + slip / 100);
  const feeUsd = (sizeUsd * FEE_PCT) / 100 + FIXED_FEE_USD;
  const qty = (sizeUsd - feeUsd) / entryPrice;

  await audit("paper_open", {
    mint: signal.mint,
    signalId: signal.id,
    score: signal.score,
    entryPath: note || "blind",
    lane,
    riskTier: risk?.tier ?? "clean",
    sizeMultiplier: sizeMult,
    qualityMult,
    sessionMult,
    markPrice: market.priceUsd,
    entryPrice,
    slippagePct: slip,
    sizeUsd,
  });

  const [position] = await db
    .insert(positions)
    .values({
      signalId: signal.id,
      mint: signal.mint,
      lane: "paper",
      tier: lane,
      triggerMult: triggerMult !== null && Number.isFinite(triggerMult) ? String(triggerMult) : null,
      sizeUsd: String(sizeUsd),
      qualityMult: String(qualityMult),
      qtyTokens: String(qty),
      qtyRemaining: String(qty),
      entryPriceUsd: String(entryPrice),
      peakPriceUsd: String(entryPrice),
      realizedPnlUsd: "0",
    })
    .returning();
  if (!position) return false;
  if (book) book[lane] += 1; // book the fill into the shared capacity ledger

  await db.insert(fills).values({
    positionId: position.id,
    side: "buy",
    qtyTokens: String(qty),
    priceUsd: String(entryPrice),
    slippagePct: String(slip),
    feeUsd: String(feeUsd),
    reason: note || "blind", // entry path: confirmed | blind
  });
  await db.update(signals).set({ status: "traded_paper" }).where(eq(signals.id, signal.id));

  console.log(
    `📈 OPEN   ${token.symbol ?? "?"} ${short(signal.mint)} $${sizeUsd} «${lane}» [${risk?.tier ?? "clean"}${qualityMult < 1 ? ` · quality ×${qualityMult}` : ""}${sessionMult < 1 ? ` · offhrs ×${sessionMult}` : ""}] @ $${entryPrice.toPrecision(4)} (liq $${Math.round(market.liquidityUsd).toLocaleString()}, slip ${slip.toFixed(2)}%, score ${signal.score}${note ? ` · ${note}` : ""})`,
  );
  return true;
}

/**
 * Blind entry (fallback): open on any fresh, high-scoring signal at t=0. Left in
 * place and used only when CONFIRM_ENTRY_ENABLED is off — run-1c/1d showed t=0
 * winners and duds are indistinguishable, which is exactly why the confirmed
 * path below is the default.
 */
export async function openNewPositions(cfg: HermesConfig): Promise<void> {
  const cutoff = new Date(Date.now() - cfg.SIGNAL_MAX_AGE_MIN * 60_000);
  const candidates = await db
    .select({ signal: signals, token: tokens })
    .from(signals)
    .innerJoin(tokens, eq(tokens.mint, signals.mint))
    .where(
      and(
        eq(signals.status, "new"),
        gte(signals.createdAt, cutoff),
        gte(signals.score, String(cfg.SIGNAL_MIN_SCORE)),
      ),
    );

  for (const { signal, token } of candidates) {
    await openFromSignal(cfg, signal, token);
  }
}

/**
 * Cold-start / halt-release: NO drain.
 *
 * The old model burned a one-shot `triggeredAt` and, on any restart or
 * kill-switch release, blanket-consumed the whole pending queue as "stale" —
 * which is exactly what dropped the 07-14 lightning: ANSEM (24x left), brain
 * (10x), NECKY (7.5x) and four others armed WHILE the breaker had us halted, then
 * were drained the instant we came back online. In the live `armed` model the
 * drain is not just unnecessary but wrong: on release we WANT to pick up anything
 * still qualifying. Staleness is handled correctly and per-candidate by the
 * trader's updatedAt freshness guard (a candidate the recorder hasn't re-armed
 * recently is simply skipped, not entered) and the burst is bounded by
 * PAPER_MAX_CONCURRENT — so there is nothing left to drain. Kept as a no-op so
 * the boot/release call sites read intentionally rather than being silently
 * deleted.
 */
export async function drainStartupTriggers(): Promise<void> {
  // intentionally does nothing — see doc comment above.
}

/**
 * Confirmed entry (default): the recorder is the scout. It maintains a LIVE
 * `armed` flag per candidate — true while the token currently qualifies the entry
 * gate (in-window, green, near-highs, buy-side winning) and we don't already hold
 * it — re-evaluated on every recorder poll. We enter any armed + un-entered
 * candidate the recorder confirmed RECENTLY (freshness guard on updatedAt, so a
 * dead recorder can't feed a stale arm). Crucially we DO NOT burn a candidate on
 * a miss: capacity, a transient market null, a venue/liquidity/slippage reject —
 * none of these consume it. It stays armed and re-attempts next cycle until it
 * either enters or the recorder disarms it (window closed / move died). This is
 * what stops us dropping the lightning that arms during a breaker halt — on
 * release we simply pick up whatever is STILL armed, no blanket drain.
 */
export async function openConfirmedPositions(cfg: HermesConfig): Promise<void> {
  // Freshness: only act on an arm the recorder refreshed within the window. This
  // replaces the old triggeredAt age gate — it measures "is this confirmation
  // still live?" not "how long ago did it first fire?".
  const freshCutoff =
    cfg.CONFIRM_MAX_TRIGGER_AGE_SEC > 0
      ? new Date(Date.now() - cfg.CONFIRM_MAX_TRIGGER_AGE_SEC * 1000)
      : new Date(0);

  const armed = await db
    .select({
      signal: signals,
      token: tokens,
      mint: candidateOutcomes.mint,
      updatedAt: candidateOutcomes.updatedAt,
      triggerBuyShare: candidateOutcomes.triggerBuyShare,
      rugProb: candidateOutcomes.rugProb,
      triggerMultiple: candidateOutcomes.triggerMultiple,
    })
    .from(candidateOutcomes)
    .innerJoin(signals, eq(signals.id, candidateOutcomes.signalId))
    .innerJoin(tokens, eq(tokens.mint, candidateOutcomes.mint))
    .where(
      and(
        eq(candidateOutcomes.armed, true),
        eq(candidateOutcomes.entered, false),
        gte(candidateOutcomes.updatedAt, freshCutoff),
      ),
    )
    // Highest-conviction first: when the book can't take everyone, the biggest
    // confirmed movers get the slots, not whichever row sorted first.
    .orderBy(desc(candidateOutcomes.triggerMultiple));

  if (armed.length === 0) return;

  // PRIME PONDS jump the queue: a fluxbeam-class confirm (measured 15/15
  // winners, 0 rugs) takes a slot before any raw trigger-multiple ordering —
  // the rarest healthy flow must never wait behind mill relaunches.
  if (cfg.PRIME_VENUES.size > 0) {
    armed.sort((a, b) => {
      const ap = cfg.PRIME_VENUES.has((a.token.dex ?? "").toLowerCase()) ? 1 : 0;
      const bp = cfg.PRIME_VENUES.has((b.token.dex ?? "").toLowerCase()) ? 1 : 0;
      return bp - ap; // stable: preserves triggerMultiple order within each group
    });
  }

  // SHARED-CAPACITY book with reserved minimums. Each opportunity class is
  // guaranteed a floor of slots so the abundant small movers can't crowd out a
  // rare monster (the 0-of-4 failure), but every lane shares the surplus above the
  // reserves so no slot ever sits idle. A candidate whose lane can't take a slot
  // right now DEFERS (never consumes) — it stays armed and enters when its lane
  // frees, IF still qualifying. openFromSignal assigns the lane from the live
  // market and books each real fill into this ledger.
  const openNow = await db.select({ tier: positions.tier }).from(positions).where(and(eq(positions.status, "open"), eq(positions.lane, "paper")));
  const book: LaneBook = { moonshot: 0, core: 0, base: 0 };
  for (const p of openNow) {
    const t: keyof LaneBook = p.tier === "moonshot" || p.tier === "core" ? p.tier : "base";
    book[t] += 1;
  }
  const total = () => book.moonshot + book.core + book.base;
  if (total() >= cfg.PAPER_MAX_CONCURRENT) {
    // SLOT DISPLACEMENT — the capture-gap fix. capacity_full was the #1 reason
    // armed winners died waiting (190 hits/48h; only 38% of armed winners ever
    // entered). If a FULL-CONVICTION candidate is armed right now, evict the
    // weakest deadweight: a position that never established (peak below every
    // arm threshold) after DISPLACE_MIN_AGE_MIN minutes of chances. The cut goes
    // through the intent queue → the 5s manage loop sells it as slot_displaced →
    // the slot frees and the still-armed candidate enters on the next scan.
    if (cfg.DISPLACE_ENABLED) {
      const hotWaiting = armed.some((a) => {
        const bs = a.triggerBuyShare === null ? null : Number(a.triggerBuyShare);
        return bs !== null && Number.isFinite(bs) && bs >= cfg.CONFIRM_QUALITY_MIN_BUYSHARE;
      });
      if (hotWaiting) {
        const ageCutoff = new Date(Date.now() - cfg.DISPLACE_MIN_AGE_MIN * 60_000);
        const [victim] = await db
          .select({ id: positions.id, mint: positions.mint, openedAt: positions.openedAt })
          .from(positions)
          .where(
            and(
              eq(positions.status, "open"),
              eq(positions.lane, "paper"),
              lte(positions.openedAt, ageCutoff),
              sql`${positions.peakPriceUsd}::numeric <= ${positions.entryPriceUsd}::numeric * ${cfg.DISPLACE_MAX_PEAK_MULT}`,
              sql`not exists (select 1 from ${managementIntents} mi where mi.position_id = ${positions.id} and mi.applied = false)`,
            ),
          )
          // Weakest first: lowest peak-vs-entry ratio = the most lifeless slot.
          .orderBy(asc(sql`${positions.peakPriceUsd}::numeric / ${positions.entryPriceUsd}::numeric`))
          .limit(1);
        if (victim) {
          await db.insert(managementIntents).values({ positionId: victim.id, intent: "cut", source: "displace" });
          await audit("slot_displaced", {
            positionId: victim.id,
            mint: victim.mint,
            heldMin: Number(((Date.now() - victim.openedAt.getTime()) / 60_000).toFixed(1)),
            armedWaiting: armed.length,
          });
          console.log(`♻️  DISPLACE ${short(victim.mint)} — deadweight slot recycled for a full-conviction armed candidate`);
        }
      }
    }
    await audit("capacity_full", { laneOpen: book, armedWaiting: armed.length });
    return;
  }

  for (const { signal, token, mint, triggerBuyShare, rugProb, triggerMultiple } of armed) {
    if (total() >= cfg.PAPER_MAX_CONCURRENT) break; // global cap hit — leave the rest armed

    const [held] = await db.select({ id: positions.id }).from(positions).where(eq(positions.mint, mint)).limit(1);
    if (held) continue; // already in it — recorder will disarm on its next poll
    if (signal.status === "traded_paper" || signal.status === "dismissed") continue;

    // Confirm-quality sizing: fading buy-share at the freshest armed read = the
    // instant-death signature (hard_stops confirm at median 0.765 buys vs 0.925
    // for green exits) — shrink the bet, never veto it. A hard gate here costs
    // ~30% of total EV for +5.5pp win rate; sizing keeps the EV and cuts the
    // variance. Missing read (pre-migration rows) = full size.
    const bs = triggerBuyShare === null ? null : Number(triggerBuyShare);
    const buyShareMult =
      bs !== null && Number.isFinite(bs) && bs < cfg.CONFIRM_QUALITY_MIN_BUYSHARE
        ? cfg.CONFIRM_QUALITY_SIZE_MULT
        : 1;
    // RUG-MODEL sizing (fitted, held-out AUC 0.70): the dirty quintiles rug
    // ~5.6x more often than the clean one — shrink them, never veto (even the
    // dirtiest quintile is 56% not-rug). Missing score = neutral.
    const rp = rugProb === null ? null : Number(rugProb);
    const rugMult =
      rp !== null && Number.isFinite(rp)
        ? rp >= cfg.RUG_PROB_HIGH
          ? cfg.RUG_SIZE_HIGH
          : rp >= cfg.RUG_PROB_CAUTION
            ? cfg.RUG_SIZE_CAUTION
            : 1
        : 1;
    // CONVICTION sizing: a candidate that confirmed at ≥2.5x market-proven
    // multiple (ARGENTINU armed at 4.94x → ran 11.4x) earns a bigger bet than
    // a 1.26x mill relaunch. Quality gets the capital, mills get scraps.
    const tm = triggerMultiple === null ? null : Number(triggerMultiple);
    const primeVenue = cfg.PRIME_VENUES.has((token.dex ?? "").toLowerCase());
    const convictionMult =
      primeVenue || (tm !== null && Number.isFinite(tm) && tm >= cfg.CONVICTION_MULT_MIN)
        ? cfg.CONVICTION_SIZE_BOOST
        : 1;
    const qualityMult = buyShareMult * rugMult * convictionMult;

    // Consume ONLY on a real fill. A false return (lane reserved / market null /
    // venue / liquidity / slippage) leaves the candidate armed to re-attempt next
    // cycle — a transient miss or a momentarily-reserved lane never permanently
    // burns a token that then runs 3–24x.
    if (await openFromSignal(cfg, signal, token, "confirmed", book, qualityMult, tm)) {
      // MIRROR the confirmed entry into the live lane (M5). Fire-and-forget:
      // a 45s on-chain confirm must never stall the entry scan; the executor
      // audits its own outcome and sweepLiveBook reconciles any miss.
      void maybeLiveBuy(cfg, mint, token.symbol);
      await db.update(candidateOutcomes).set({ entered: true, armed: false, updatedAt: new Date() }).where(eq(candidateOutcomes.mint, mint));
    }
  }
}

interface ExitDecision {
  reason: string;
  fraction: number; // fraction of remaining qty to sell
}

// The wide leash is EARNED by how far a position has actually RUN, not handed
// to a spike by the classifier's momentum read. Soly rode "IGNITION/RIDE" to a
// 1.78x spike and the +15% bonus held a 37% trail through the entire round-trip,
// banking 1.25x after a 68% give-back. So the 1–2.5x spike zone (where most
// tokens round-trip) trails TIGHT; the wider leash + RIDE bonus is reserved for
// a proven runner still near its highs; and any real roll-over snugs the stop up.
const RUNNER_MULT = 2.5; // above this it's an establishing runner, not a spike
const PARABOLIC_MULT = 6; // above this, a proven parabolic runner — give it room
const RIDE_MIN_MULT = 3; // RIDE only widens the leash once the move is this real
const SNUG_DD = 8; // drawdown % that flips us from "let it run" to "lock it in"

function trailWidthPct(
  cfg: HermesConfig,
  peakMult: number,
  drawdownPct: number,
  call: ManagementCall | null,
  // BANK-FIRST-THEN-LEASH: once a TP tranche has banked, the remainder is house
  // money and earns room to breathe. The 5-6.8% tight trail lives INSIDE the 5s
  // wick noise of fresh tokens (11 prime-window entries exited in 9-90s at
  // ~breakeven, then ran 1.3-2.3x without us — ETC banked $0.09 and peaked 2.27x
  // nine seconds after our exit). An UNPAID position keeps the tight leash.
  banked = false,
): number {
  let w =
    peakMult >= PARABOLIC_MULT
      ? cfg.TRAIL_WIDE_PCT
      : peakMult >= RUNNER_MULT
        ? cfg.TRAIL_MID_PCT
        : cfg.TRAIL_TIGHT_PCT; // 1–2.5x spike zone — bank it
  if (banked) w = Math.max(w, cfg.POST_BANK_TRAIL_PCT);
  if (call?.action === "RIDE" && peakMult >= RIDE_MIN_MULT && drawdownPct < SNUG_DD) {
    w += cfg.TRAIL_RIDE_BONUS_PCT; // earned: a real runner still printing highs
  } else if (
    drawdownPct >= SNUG_DD ||
    call?.regime === "BLOWOFF" ||
    call?.regime === "STALL" ||
    call?.action === "TRIM"
  ) {
    // Rolling over — lock it. A PAID runner clamps only to its post-bank leash
    // (never back to the wick-noise width); an unpaid one snugs fully tight.
    w = Math.min(w, banked ? cfg.POST_BANK_TRAIL_PCT : cfg.TRAIL_TIGHT_PCT);
  }
  return w;
}

export function decideExit(
  cfg: HermesConfig,
  position: Position,
  market: TokenMarket,
  peak: number,
  call: ManagementCall | null = null,
): ExitDecision | null {
  const entry = n(position.entryPriceUsd);
  const price = market.priceUsd;
  const ageHours = (Date.now() - position.openedAt.getTime()) / 3_600_000;
  const peakMult = entry > 0 ? peak / entry : 1;
  const peakProfitUsd = n(position.sizeUsd) * (peakMult - 1);

  // TAKE-PROFIT ON THE WAY UP — checked FIRST, before any trailing/stall logic.
  // This is the only mechanism that captures a token that pumps then rugs
  // atomically from the peak: a trailing stop needs a gradual pullback the LP-pull
  // never gives (price teleports to dust, held at last-good, never a real read at
  // the stop), so trail-only booked all 21 rugs at $0 despite 9 crossing 1.5x on a
  // deep pool. Here we SELL INTO STRENGTH at fixed targets while the pool is still
  // liquid, banking the bulk and leaving a runner to ride uncapped for the tail.
  if (cfg.TAKE_PROFIT_ENABLED && entry > 0) {
    const mark = price / entry;
    const original = n(position.qtyTokens);
    const soldFrac = original > 0 ? Math.max(0, 1 - n(position.qtyRemaining) / original) : 0;
    // Farm-tape detection — the escalator DNA (99/101 dust rugs on meteora-
    // damm-v2, atomic cliff at peak). Static venue list ∪ ADAPTIVE sets (venues/
    // tickers whose 24h rug share crossed the threshold). Farm tape gets the
    // NO-RUNNER ladder: 40% @TP0 → 75% @TP1 → 100% out @TP2 — nothing is ever
    // held into the cliff; real-moonshot venues keep the uncapped runner.
    const farm = isFarmDump(cfg, market);
    const tp0Cum = farm ? cfg.FARM_TP0_CUM_SELL : cfg.TP0_CUM_SELL;
    const tp1Cum = farm ? cfg.FARM_TP1_CUM_SELL : cfg.TP1_CUM_SELL;
    const tp2Cum = farm ? cfg.FARM_TP2_CUM_SELL : cfg.TP2_CUM_SELL;
    let targetSold = 0;
    let tpReason = "";
    if (mark >= cfg.TP2_MULT) {
      targetSold = tp2Cum;
      tpReason = "take_profit_2";
    } else if (mark >= cfg.TP1_MULT) {
      targetSold = tp1Cum;
      tpReason = "take_profit_1";
    } else if (mark >= cfg.TP0_MULT) {
      // First tranche into the blow-off top. Organic tape banks 40% here and rides
      // the ~60% runner for winners' tail; FARM tape dumps 100% (tp0Cum=1.0) — the
      // escalator's "runner" is bait that rugs to $0, so first level = full exit.
      targetSold = tp0Cum;
      tpReason = "take_profit_0";
    }
    // Only sell the INCREMENT needed to reach the target cumulative sold — a level
    // already banked never re-fires. Expressed as a fraction of what REMAINS.
    if (targetSold > soldFrac + 1e-6) {
      const remainFrac = Math.min(1, (targetSold - soldFrac) / (1 - soldFrac));
      return { reason: tpReason, fraction: remainFrac };
    }
  }
  // Armed once it's shown real green — by % OR by an absolute dollar gain, so a
  // small bet locks its base hit ("never close red once up $1") without waiting
  // for a +15% move. The ratcheting trail still rides real runners uncapped.
  // INVARIANT: arming is only legal once the peak is ABOVE the lock floor —
  // otherwise the floor stop (entry × PROFIT_LOCK_FLOOR_MULT) sits above the
  // live price and executes on the next tick, harvesting every position at
  // ~breakeven. Exactly that happened at prime sizes: $0.10 on a $14 position
  // arms at +0.7%, floor at +2% > price → deterministic 11-16s penny exits
  // (positions 1019-1024, all peak 1.01x). The dollar floor was calibrated on
  // $1.75 probes where $0.10 = +5.7% and the inversion couldn't occur.
  const armed =
    (peakMult >= cfg.PROFIT_LOCK_ARM_MULT || peakProfitUsd >= cfg.PROFIT_FLOOR_USD) &&
    peakMult > cfg.PROFIT_LOCK_FLOOR_MULT;

  if (armed) {
    // The stop is now a ratchet that only moves UP — the higher of a locked
    // profit floor and a trailing floor below the peak. No upper cap: a position
    // making higher highs rides untouched, so the moonshot is never sold short.
    // STALE-TAKE: no new high for STALE_LOCK_TICKS polls (~3min) while
    // meaningfully green → SELL THE REMAINDER INTO LIVE LIQUIDITY NOW. This was
    // originally a ratcheted stop, but the GDWR autopsy proved a stop is
    // worthless against this loss class: the deployer-wave rugs pull a $222k
    // pool to $1 between two polls — the price teleports past any floor. The
    // only protection that cashes is exiting into strength while the pool
    // still exists. A running tape (new highs) never triggers this, so the
    // moonshot runner keeps its leash; a 3-minutes-flat memecoin is done.
    if (
      call &&
      cfg.STALE_LOCK_TICKS > 0 &&
      call.ticksSinceNewHigh >= cfg.STALE_LOCK_TICKS &&
      peakMult >= cfg.STALE_LOCK_MIN_MULT &&
      price > entry * cfg.PROFIT_LOCK_FLOOR_MULT
    ) {
      return { reason: "stale_take", fraction: 1 };
    }
    const drawdownPct = peak > 0 ? Math.max(0, ((peak - price) / peak) * 100) : 0;
    // House-money check: any banked TP tranche means the position already paid.
    const originalQty = n(position.qtyTokens);
    const bankedRunner =
      originalQty > 0 && 1 - n(position.qtyRemaining) / originalQty > 1e-6;
    // MARKET-PROVEN zone selection: the trail zones exist to give proven
    // runners room, but entry-relative peakMult is blind to what the token
    // proved BEFORE we entered. ARGENTINU armed at 4.94x market-proven; from
    // our fill it read 1.1-2.3x, so it stayed in the tight spike-zone trail
    // the whole ride to 11.4x and banked +15%. Zone selection (and the RIDE
    // gate inside trailWidthPct) now uses entryRel × triggerMult; the stop
    // PRICE math stays on the real entry-relative peak.
    const provenMult = peakMult * Math.max(1, n(position.triggerMult) || 1);
    const trailPct = trailWidthPct(cfg, provenMult, drawdownPct, call, bankedRunner);
    const stop = Math.max(entry * cfg.PROFIT_LOCK_FLOOR_MULT, peak * (1 - trailPct / 100));
    if (price <= stop) return { reason: "profit_trail", fraction: 1 };
  } else {
    // Not yet in profit — the pre-profit hard stop is the only floor.
    // VENUE-SPLIT: thin bonding-curve tape (meteora-dbc, or any pool under
    // THIN_STOP_LIQ_USD) gets the deep stop — its "tight" stop gap-fills tens
    // of points below the line anyway, and its winners routinely retrace 30-50%
    // for minutes before igniting (BULLDOG: −50% chop for 2.5m, then 153x).
    // Deep pools keep the tight stop, where fills actually land near it.
    // dbc reads "meteoradbc" on the live DexScreener feed and "meteora-dbc" in
    // GeckoTerminal-ingested rows — accept both (the dex-string leak lesson).
    const venue = canonicalVenue(market);
    const thin =
      venue === "meteoradbc" || venue === "meteora-dbc" || market.liquidityUsd < cfg.THIN_STOP_LIQ_USD;
    const stopPct = thin ? cfg.HARD_STOP_PCT_THIN : cfg.HARD_STOP_PCT;
    if (price <= entry * (1 - stopPct / 100)) return { reason: "hard_stop", fraction: 1 };
  }

  if (ageHours >= cfg.MAX_HOLD_HOURS) return { reason: "stop_time", fraction: 1 };
  // Flat-position time-box — capital rotation. Never established (peak never
  // cleared FLAT_MULT) after FLAT_MIN minutes → recycle the slot at market. A
  // position that DID clear FLAT_MULT is handled by the ratcheting trail above
  // (armed → trails out green, or rides as a proven runner), so this only sweeps
  // the stuck ~1.0x deadweight — it never caps a winner.
  if (peakMult < cfg.TIMEBOX_FLAT_MULT && ageHours * 60 >= cfg.TIMEBOX_FLAT_MIN) {
    return { reason: "stop_flat", fraction: 1 };
  }
  // volume collapse: current 5-min pace under 20% of the last hour's pace,
  // only meaningful once the position has had time to breathe
  if (ageHours > 0.5 && market.volUsd.h1 > 0 && market.volUsd.m5 * 12 < 0.2 * market.volUsd.h1) {
    return { reason: "stop_volume", fraction: 1 };
  }
  return null;
}

async function sell(
  position: Position,
  market: TokenMarket,
  fraction: number,
  reason: string,
): Promise<void> {
  const qtySold = n(position.qtyRemaining) * fraction;
  const grossUsd = qtySold * market.priceUsd;
  const slip = slippagePct(grossUsd, market.liquidityUsd);
  const exitPrice = market.priceUsd * (1 - slip / 100);
  const feeUsd = (qtySold * exitPrice * FEE_PCT) / 100 + FIXED_FEE_USD;
  const proceeds = qtySold * exitPrice - feeUsd;
  // Cost basis = the CASH we paid for this slice (size × fraction sold), which
  // includes the entry fee. The old qty×entryPrice basis silently dropped the
  // buy fee from realized P&L (~$0.05/position — the growing recon gap the
  // fills≡positions identity caught): fees are real cash and must be expensed.
  const qtyTotal = n(position.qtyTokens);
  const costBasis = qtyTotal > 0 ? n(position.sizeUsd) * (qtySold / qtyTotal) : qtySold * n(position.entryPriceUsd);
  const pnl = proceeds - costBasis;

  const remaining = n(position.qtyRemaining) - qtySold;
  const closing = remaining <= 1e-9 || fraction >= 1;

  await audit("paper_sell", {
    positionId: position.id,
    mint: position.mint,
    reason,
    qtySold,
    exitPrice,
    slippagePct: slip,
    pnlUsd: pnl,
    closing,
  });

  await db.insert(fills).values({
    positionId: position.id,
    side: "sell",
    qtyTokens: String(qtySold),
    priceUsd: String(exitPrice),
    slippagePct: String(slip),
    feeUsd: String(feeUsd),
    reason, // per-fill truth: WHICH rung/exit produced this fill
  });

  const newRealized = n(position.realizedPnlUsd) + pnl;
  await db
    .update(positions)
    .set({
      qtyRemaining: String(Math.max(remaining, 0)),
      realizedPnlUsd: String(newRealized),
      ...(closing
        ? {
            status: "closed",
            exitPriceUsd: String(exitPrice),
            exitReason: reason,
            closedAt: new Date(),
          }
        : {}),
    })
    .where(eq(positions.id, position.id));

  const tag = closing ? "CLOSE" : "TRIM ";
  const emoji = newRealized >= 0 ? "🟢" : "🔴";
  console.log(
    `${emoji} ${tag}  ${short(position.mint)} ${reason} @ $${exitPrice.toPrecision(4)} — pnl $${pnl.toFixed(2)} (total $${newRealized.toFixed(2)})`,
  );
}

/**
 * Record this poll as a trajectory tick and run the ride-vs-cut classifier over
 * the recent window. The call is persisted inline so the dashboard reads it
 * directly and every decision is auditable. Never throws — management must not
 * break if the classifier or a DB write hiccups.
 */
async function recordTickAndClassify(
  position: Position,
  market: TokenMarket,
  peak: number,
): Promise<ManagementCall | null> {
  try {
    const entry = n(position.entryPriceUsd);
    const ageMinutes = (Date.now() - position.openedAt.getTime()) / 60_000;
    const current = tickFrom({
      priceUsd: market.priceUsd,
      entryPriceUsd: entry,
      peakPriceUsd: peak,
      buysM5: market.txns.m5.buys,
      sellsM5: market.txns.m5.sells,
      volM5: market.volUsd.m5,
      volH1: market.volUsd.h1,
      priceChangeM5Pct: market.priceChangePct.m5,
      ageMinutes,
    });

    // Fetch WIDE for staleness, classify NARROW. The classifier judges momentum
    // over TICK_WINDOW (12 ticks ≈ 60s) — but ticksSinceNewHigh computed on that
    // window caps at 12, which made STALE_LOCK_TICKS=36 mathematically
    // unreachable (the "missing floor": flat positions were never stale-managed).
    // Staleness is measured over the full fetched history instead.
    const priorWide = await db
      .select()
      .from(positionTicks)
      .where(eq(positionTicks.positionId, position.id))
      .orderBy(desc(positionTicks.snappedAt))
      .limit(100);
    const prior = priorWide.slice(0, TICK_WINDOW - 1);
    const history = prior.reverse().map((r) => ({
      markMultiple: n(r.markMultiple),
      drawdownFromPeakPct: n(r.drawdownFromPeakPct),
      buyShareM5: r.buyShareM5 === null ? 0.5 : n(r.buyShareM5),
      volM5: n(r.volM5),
      volH1: n(r.volH1),
      priceChangeM5Pct: n(r.priceChangeM5Pct),
      ageMinutes: n(r.ageMinutes),
    }));
    const call = classify([...history, current], DEFAULT_CLASSIFIER);
    // Full-range staleness: ticks since the running peakMultiple last ROSE.
    // priorWide is newest-first; count trailing ticks already AT the current
    // peak. A new high printed THIS tick → no prior tick matches → stale = 0.
    let stale = 0;
    for (const r of priorWide) {
      if (n(r.peakMultiple) >= current.peakMultiple - 1e-9) stale++;
      else break;
    }
    call.ticksSinceNewHigh = Math.max(call.ticksSinceNewHigh, stale);

    await db.insert(positionTicks).values({
      positionId: position.id,
      priceUsd: String(market.priceUsd),
      markMultiple: String(current.markMultiple),
      peakMultiple: String(current.peakMultiple),
      drawdownFromPeakPct: String(current.drawdownFromPeakPct),
      liquidityUsd: String(market.liquidityUsd),
      volM5: String(market.volUsd.m5),
      volH1: String(market.volUsd.h1),
      buysM5: market.txns.m5.buys,
      sellsM5: market.txns.m5.sells,
      buyShareM5: String(current.buyShareM5),
      priceChangeM5Pct: String(market.priceChangePct.m5),
      ageMinutes: String(ageMinutes),
      regime: call.regime,
      action: call.action,
      continuationScore: String(call.continuationScore),
      reason: call.reason,
    });
    return call;
  } catch (err) {
    console.error(`classifier tick failed for #${position.id}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** Consume a pending RIDE/CUT override for a position; returns it (with its source) if present. */
async function takeIntent(positionId: number): Promise<{ intent: "ride" | "cut"; source: string } | null> {
  const [row] = await db
    .select()
    .from(managementIntents)
    .where(and(eq(managementIntents.positionId, positionId), eq(managementIntents.applied, false)))
    .orderBy(desc(managementIntents.createdAt))
    .limit(1);
  if (!row) return null;
  await db
    .update(managementIntents)
    .set({ applied: true, appliedAt: new Date() })
    .where(eq(managementIntents.positionId, positionId));
  return { intent: row.intent === "cut" ? "cut" : "ride", source: row.source };
}

/** Manual "harvest all green now" flag — set by the dashboard/user, consumed here. */
async function harvestRequested(): Promise<boolean> {
  const [row] = await db.select().from(config).where(eq(config.key, "harvest_now"));
  return (row?.value as { enabled?: boolean } | undefined)?.enabled === true;
}
async function clearHarvestRequest(): Promise<void> {
  await db
    .insert(config)
    .values({ key: "harvest_now", value: { enabled: false }, updatedAt: new Date() })
    .onConflictDoUpdate({ target: config.key, set: { value: { enabled: false }, updatedAt: new Date() } });
}

// Per-position count of consecutive suspect (garbage) reads. In-memory: a
// restart resets it, which is safe — a position mid-crash at restart simply
// re-confirms over the next couple polls before we act.
const suspectCounts = new Map<number, number>();
// Consecutive below-hard-stop reads per position — wick confirmation for the
// pre-arm stop. All 30 historical hard-stops fired on a SINGLE below-stop tick
// and 63% of those tokens recovered past TP0 after ejecting us (SJM ran 2.7x
// from entry 15s after a one-tick −6% wick stopped us out). A restart resets
// the count; the stop simply re-confirms over the next polls before acting.
const stopConfirmCounts = new Map<number, number>();
// Consecutive dust-pool reads per position. A dust read is HELD (never booked off
// its fake price), but once the pool stays dust for PERSISTENT_DUST_TICKS polls
// the tradeable liquidity is genuinely gone and the position is a corpse — book
// it as a rug and free the slot. Reset the instant any non-dust read arrives.
const dustCounts = new Map<number, number>();
// When the BOOK-WIDE dust state began (null = not currently broad). Broad dust
// is treated as a feed anomaly only up to DUST_OUTAGE_MAX_MIN — past that it's
// a real correlated die-off and the per-position death counters resume.
let dustOutageSince: number | null = null;

// AUTO-FARM state — the adaptive farm list, self-maintained from the recorder's
// last-24h labeled outcomes. Venues/tickers whose rug share crosses the config
// threshold get the no-runner ladder without a code change; they drop off when
// they clean up. Refreshed every FARM_AUTO_REFRESH_MS inside managePositions.
const autoFarm = { venues: new Set<string>(), symbols: new Set<string>(), refreshedAt: 0 };

async function refreshAutoFarm(cfg: HermesConfig): Promise<void> {
  if (Date.now() - autoFarm.refreshedAt < cfg.FARM_AUTO_REFRESH_MS) return;
  autoFarm.refreshedAt = Date.now();
  try {
    const rows = await db.execute(sql`
      SELECT lower(t.dex) AS k, 'venue' AS kind,
        count(*)::int n, count(*) FILTER (WHERE co.label='rug')::int rugs
      FROM candidate_outcomes co JOIN tokens t ON t.mint = co.mint
      WHERE co.label IN ('winner','dud','rug') AND co.updated_at >= now() - interval '24 hours'
        AND t.dex IS NOT NULL
      GROUP BY 1
      UNION ALL
      SELECT lower(t.symbol), 'symbol', count(*)::int, count(*) FILTER (WHERE co.label='rug')::int
      FROM candidate_outcomes co JOIN tokens t ON t.mint = co.mint
      WHERE co.label IN ('winner','dud','rug') AND co.updated_at >= now() - interval '24 hours'
        AND t.symbol IS NOT NULL
      GROUP BY 1, 2
    `);
    const venues = new Set<string>();
    const symbols = new Set<string>();
    for (const r of rows as unknown as Array<Record<string, unknown>>) {
      const n = Number(r.n) || 0;
      const rugs = Number(r.rugs) || 0;
      if (n < cfg.FARM_AUTO_MIN_N || rugs / n < cfg.FARM_AUTO_RUG_RATE) continue;
      if (r.kind === "venue") venues.add(String(r.k));
      else symbols.add(String(r.k));
    }
    const changed =
      venues.size !== autoFarm.venues.size ||
      symbols.size !== autoFarm.symbols.size ||
      [...venues].some((v) => !autoFarm.venues.has(v)) ||
      [...symbols].some((s) => !autoFarm.symbols.has(s));
    autoFarm.venues = venues;
    autoFarm.symbols = symbols;
    if (changed) {
      await audit("auto_farm_update", { venues: [...venues], symbols: [...symbols] });
      console.log(
        `🎰 AUTO-FARM refreshed — venues: [${[...venues].join(", ") || "none"}] · tickers: [${[...symbols].join(", ") || "none"}] (≥${Math.round(cfg.FARM_AUTO_RUG_RATE * 100)}% rug share, n≥${cfg.FARM_AUTO_MIN_N}, 24h window)`,
      );
    }
  } catch (err) {
    console.error(`auto-farm refresh failed: ${err instanceof Error ? err.message : err}`);
  }
}

// canonicalVenue now lives in @hermes/core (market/venue.ts) so the recorder's
// rug model and the trader resolve venues identically — see its doc for the
// dex-string-leak history (meteora+DYN2 → meteora-damm-v2).

/** Farm classification for a position's live market read: static venue list ∪ adaptive sets. */
function isFarmTape(cfg: HermesConfig, market: TokenMarket): boolean {
  const dex = canonicalVenue(market);
  const sym = (market.symbol ?? "").toLowerCase();
  return cfg.FARM_VENUES.has(dex) || autoFarm.venues.has(dex) || (sym !== "" && autoFarm.symbols.has(sym));
}

/**
 * The NO-RUNNER dump ladder (100% out at the first TP level) is reserved for
 * tape the system has MEASURED as serial-rug bait: the adaptive farm TICKERS
 * (the uswr/w26/vorf relaunch mills) and adaptive rug-rate venues. The static
 * FARM_VENUES blanket deliberately does NOT qualify here: damm-v2 carries ~92%
 * of flow, and in a favorable regime it hosts real runners — blanket-dumping
 * the venue capped ENGLAND (ran 4.19x) and sadcat (3.79x) at +13% while the
 * ticker list alone would have correctly dumped USOH and W26 (both rugged to
 * $0 minutes after our TP0). Static-venue farm tape with a CLEAN ticker keeps
 * the organic ladder: bank 40% at TP0, runner rides the post-bank leash.
 * isFarmTape (venue-wide) still governs book slots — this only picks the ladder.
 */
function isFarmDump(cfg: HermesConfig, market: TokenMarket): boolean {
  const dex = canonicalVenue(market);
  const sym = (market.symbol ?? "").toLowerCase();
  return autoFarm.venues.has(dex) || (sym !== "" && autoFarm.symbols.has(sym));
}

export type MarkVerdict =
  | { kind: "ok" } // trustworthy read — process normally
  | { kind: "dust"; why: string } // pool itself is near-empty — hold, but a PERSISTENT dust state is a death
  | { kind: "garbage"; why: string } // incoherent feeds (one glitched) — hold last-good, NEVER act, transient
  | { kind: "crash" }; // coherent order-of-magnitude drop — confirm, then exit

/**
 * Cross-check the two same-tick feeds (Jupiter/DexScreener price + DexScreener
 * liquidity) against the last good mark. In one pool, a price move and its
 * liquidity move together; the discriminator is physical, not temporal:
 *   - garbage: exactly ONE feed made an order-of-magnitude move while the other
 *     stayed flat. Impossible in a real pool — the moving feed glitched (pos 29:
 *     price ×1.6e-9 while liquidity held ×1.0). HELD at last-good no matter how
 *     many polls it persists; the temporal confirm can't fix a persistent glitch.
 *   - crash: a COHERENT order-of-magnitude drop (BOTH feeds low) — a real rug.
 *     Still exits, but confirmed across a poll to rule out a rare double-feed flip
 *     that recovers.
 *   - ok: everything else (normal moves, and large moves corroborated by
 *     liquidity — a genuine pump rides untouched).
 * Venue-agnostic: uses "orders of magnitude vs flat", not the constant-product
 * exponent, so it holds for bonding curves (meteora-dbc/bags-fm) too.
 */
export function classifyMark(
  cfg: HermesConfig,
  price: number,
  liq: number,
  lastGood: number,
  lastGoodLiq: number,
): MarkVerdict {
  // Dust floor FIRST, independent of any baseline. A read from a near-empty pool
  // is not a real market — you cannot get a fill out of $5 of liquidity — so its
  // price is fiction. This is the hole the pure-coherence check missed: an
  // empty-pool flip craters BOTH price AND liquidity together, so neither
  // "one feed jumped, the other flat" branch fires and it slips through as a
  // "coherent crash" and books at ~$0 (C2i9r9: liq $5, sold −100%). The recorder
  // learned the same lesson (REF_MIN_LIQ). Hold last-good; a genuine dust-rug is
  // booked by the no-pair writeoff or the max-hold backstop, not off this price.
  if (liq < cfg.MARK_MIN_LIQ_USD) return { kind: "dust", why: `dust pool liq $${liq.toFixed(0)} < $${cfg.MARK_MIN_LIQ_USD}` };
  if (lastGood <= 0 || lastGoodLiq <= 0) return { kind: "ok" }; // no baseline yet — trust it
  const pr = price / lastGood; // price ratio vs last good
  const lr = liq / lastGoodLiq; // liquidity ratio vs last good
  const oom = cfg.MARK_OOM_FACTOR;
  const flat = cfg.MARK_LIQ_FLAT;
  const priceOOM = pr < 1 / oom || pr > oom;
  const liqOOM = lr < 1 / oom || lr > oom;
  const priceFlat = pr >= 1 / flat && pr <= flat;
  const liqFlat = lr >= 1 / flat && lr <= flat;
  // One feed jumped orders of magnitude while the other barely moved → that feed
  // is garbage (price-glitch, or Mode-B liquidity-feed dropout).
  if (priceOOM && liqFlat) return { kind: "garbage", why: `price x${pr.toExponential(1)} but liq x${lr.toFixed(2)} flat` };
  if (liqOOM && priceFlat) return { kind: "garbage", why: `liq x${lr.toExponential(1)} but price x${pr.toFixed(2)} flat` };
  // Coherent order-of-magnitude drop (both feeds low) → real rug: exit after confirm.
  if (pr < 1 / oom) return { kind: "crash" };
  return { kind: "ok" };
}

/**
 * Record a suspect poll as a HOLD tick at the held (last-good) price AND
 * liquidity — the raw garbage values are preserved in the reason for the
 * drill-down, but the recorded mark stays flat so the NEXT poll compares against
 * a stable baseline via either feed (recording the garbage read would make a
 * recovery look like a fresh spike and never settle). Forensics without
 * authority. Never throws.
 */
async function recordSuspectHold(
  position: Position,
  market: TokenMarket,
  heldPrice: number,
  heldLiq: number,
  reason: string,
): Promise<void> {
  try {
    const entry = n(position.entryPriceUsd);
    const peak = Math.max(n(position.peakPriceUsd), heldPrice);
    await db.insert(positionTicks).values({
      positionId: position.id,
      priceUsd: String(heldPrice),
      markMultiple: String(entry > 0 ? heldPrice / entry : 1),
      peakMultiple: String(entry > 0 ? peak / entry : 1),
      drawdownFromPeakPct: String(peak > 0 ? Math.max(0, ((peak - heldPrice) / peak) * 100) : 0),
      liquidityUsd: String(heldLiq),
      volM5: String(market.volUsd.m5),
      volH1: String(market.volUsd.h1),
      buysM5: market.txns.m5.buys,
      sellsM5: market.txns.m5.sells,
      buyShareM5: "0.5",
      priceChangeM5Pct: String(market.priceChangePct.m5),
      ageMinutes: String((Date.now() - position.openedAt.getTime()) / 60_000),
      regime: "HOLD",
      action: "HOLD",
      continuationScore: "0",
      reason: `suspect_${reason} raw=$${market.priceUsd}/liq$${market.liquidityUsd.toFixed(0)}`,
    });
  } catch (err) {
    console.error(`suspect-hold tick failed for #${position.id}: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Book a total loss at $0. The only honest close for a token whose pool has
 * vanished (no pair) or decayed to untradeable dust and never recovered — there
 * is no real price to sell into, so we write off the full position rather than
 * bank a fiction off a $5 pool. Shared by the no-pair path and the dust-rug
 * max-hold backstop.
 */
async function writeOffAtZero(position: Position, reason: string): Promise<void> {
  await audit("paper_writeoff", { positionId: position.id, mint: position.mint, reason });
  await db.insert(fills).values({
    positionId: position.id,
    side: "sell",
    qtyTokens: position.qtyRemaining,
    priceUsd: "0",
    feeUsd: "0",
  });
  const loss = -n(position.qtyRemaining) * n(position.entryPriceUsd);
  await db
    .update(positions)
    .set({
      status: "closed",
      qtyRemaining: "0",
      exitPriceUsd: "0",
      exitReason: reason,
      realizedPnlUsd: String(n(position.realizedPnlUsd) + loss),
      closedAt: new Date(),
    })
    .where(eq(positions.id, position.id));
  console.log(`🔴 CLOSE  ${short(position.mint)} ${reason} — wrote off $${(-loss).toFixed(2)}`);
}

/** Mark open positions to market and execute the exit rules. */
export async function managePositions(cfg: HermesConfig): Promise<void> {
  await refreshAutoFarm(cfg); // keep the adaptive farm list current (no-op inside refresh window)
  const open = await db.select().from(positions).where(and(eq(positions.status, "open"), eq(positions.lane, "paper")));
  if (open.length === 0) return;

  // Real-time marks for every open position in ONE keyless call — block-level
  // price, fresher than DexScreener's aggregation, so exits fire on the true
  // sellable price. Falls back to the DexScreener price per position on miss.
  const jupPrices = await fetchJupiterPrices(
    cfg.JUPITER_PRICE_URL,
    open.map((p) => p.mint),
  ).catch(() => new Map<string, number>());

  // Fetch the WHOLE book first so breadth is visible before any single write-off.
  // A real delist hits ONE token; an upstream feed blip nulls the entire book in
  // the same cycle. Without this, a DexScreener hiccup wrote off 24 positions as
  // "delisted" in a 2-second burst for −$418. BATCHED (30 mints/request): the
  // old per-mint loop was 24 req per 5s cycle ≈ 288/min — past DexScreener's
  // ceiling — and the throttled responses read as recurring book-wide "outages".
  const markets = await fetchTokenMarkets(open.map((p) => p.mint)).catch(
    () => new Map<string, TokenMarket | null>(open.map((p) => [p.mint, null])),
  );
  const nullCount = [...markets.values()].filter((m) => m === null).length;
  const feedOutage =
    open.length >= cfg.OUTAGE_MIN_POSITIONS &&
    nullCount >= Math.ceil(open.length * cfg.OUTAGE_NULL_FRACTION);
  if (feedOutage) {
    // Hold the entire book, touch nothing — never write off a whole book at once.
    // The next cycle re-checks; positions resume the moment the feed recovers.
    await audit("feed_outage", { openPositions: open.length, nullCount });
    console.log(
      `🌐 HOLD ALL — ${nullCount}/${open.length} positions returned no pair this cycle → feed outage, not mass delist; skipping management`,
    );
    return;
  }

  // Same breadth logic for DUST as for nulls. The dust-death exit accrues a
  // per-position counter, but an aggregator pool-flip (the 56,000x / −$418 class)
  // flips the WHOLE book to a near-empty pool at once — persistence alone can't
  // tell that from many real rugs. If dust is book-wide this cycle, treat it as a
  // feed anomaly: hold the dust reads WITHOUT accruing the death counter, so a
  // correlated flip can never mass-write-off the book. A single genuinely-dead
  // pool still accrues normally (the book isn't broadly dust around it).
  const dustCount = [...markets.values()].filter(
    (m) => m !== null && m.liquidityUsd < cfg.MARK_MIN_LIQ_USD,
  ).length;
  const dustBroad =
    open.length >= cfg.OUTAGE_MIN_POSITIONS &&
    dustCount >= cfg.DUST_OUTAGE_MIN_COUNT &&
    dustCount >= Math.ceil(open.length * cfg.OUTAGE_NULL_FRACTION);
  // TIME-CAPPED: broad dust is an anomaly for minutes, a DIE-OFF after that. A
  // meme wave's entries cluster in time, so their rugs cluster too — a book
  // that stays broadly dust past DUST_OUTAGE_MAX_MIN is genuinely dead, and
  // holding it "safe" forever deadlocks the slots on fictional float (the
  // frozen-book report: 10+ corpses held as an eternal 'anomaly'). Past the
  // cap, per-position persistent-dust accrual resumes and corpses clear.
  if (dustBroad) {
    if (dustOutageSince === null) dustOutageSince = Date.now();
  } else {
    dustOutageSince = null;
  }
  const outageAgeMin = dustOutageSince === null ? 0 : (Date.now() - dustOutageSince) / 60_000;
  const dustOutage = dustBroad && outageAgeMin < cfg.DUST_OUTAGE_MAX_MIN;
  if (dustBroad) {
    await audit("dust_outage", { openPositions: open.length, dustCount, outageAgeMin: Number(outageAgeMin.toFixed(1)), treatingAsDieOff: !dustOutage });
    console.log(
      dustOutage
        ? `🌐 ${dustCount}/${open.length} positions read dust this cycle → correlated pool-flip, not mass rug; holding dust reads without accrual (${outageAgeMin.toFixed(1)}/${cfg.DUST_OUTAGE_MAX_MIN}m)`
        : `💀 ${dustCount}/${open.length} positions STILL dust after ${outageAgeMin.toFixed(0)}m → real die-off, not an anomaly; death counters accruing`,
    );
  }

  // BASKET HARVEST — bank the whole green book at once, BEFORE per-position
  // management. Waiting for each position to hit its own target lets rugs pick the
  // book off one by one; sweeping every green position the moment they're
  // collectively up ≥ BASKET_HARVEST_USD locks the gain before a rug round-trips
  // it. A manual harvest fires the same sweep on demand. Only SELLABLE, GREEN
  // positions are swept (healthy pool + coherent Jupiter/DexScreener mark, unreal
  // gain > 0); reds/dust are left to the death-exit. This is the automation of the
  // hand-cutting that banked +$52 while the per-trade TP sat idle.
  const manualHarvest = await harvestRequested();
  if (cfg.BASKET_HARVEST_ENABLED || manualHarvest) {
    const green: { position: (typeof open)[number]; market: TokenMarket; upl: number }[] = [];
    const skipped: string[] = []; // unsellable THIS cycle (dust/no-pair read) — visible, not silent
    for (const position of open) {
      const m = markets.get(position.mint);
      if (!m || m.liquidityUsd < cfg.MARK_MIN_LIQ_USD) {
        skipped.push(position.mint);
        continue; // dust/no-pair → not sellable, skip
      }
      const jp = jupPrices.get(position.mint);
      const px = jp && jp > 0 ? jp : m.priceUsd; // sell at the real-time mark
      const upl = n(position.qtyRemaining) * (px - n(position.entryPriceUsd));
      if (upl > 0) green.push({ position, market: { ...m, priceUsd: px }, upl });
    }
    const greenUpl = green.reduce((s, g) => s + g.upl, 0);
    if (green.length > 0 && (manualHarvest || greenUpl >= cfg.BASKET_HARVEST_USD)) {
      await audit("basket_harvest", {
        positions: green.length,
        greenUpl,
        manual: manualHarvest,
        skippedUnsellable: skipped.length,
        skippedMints: skipped.slice(0, 10),
      });
      console.log(
        `💰 ${manualHarvest ? "MANUAL" : "BASKET"} HARVEST — ${green.length} green positions net +$${greenUpl.toFixed(2)} → banking all, recycling${skipped.length > 0 ? ` (${skipped.length} skipped: pool read dust/no-pair this cycle — they re-qualify next poll)` : ""}`,
      );
      for (const g of green) await sell(g.position, g.market, 1, manualHarvest ? "manual_harvest" : "basket_harvest");
      if (manualHarvest) await clearHarvestRequest();
      return; // book swept; the rest recycles on the next scan
    }
    if (manualHarvest) {
      // Asked to harvest but nothing green/sellable RIGHT NOW — say why instead
      // of silently eating the click (the "I harvested but nothing converted"
      // report: 19 showed green on the board, the sweep found 2 sellable).
      await audit("harvest_noop", { openPositions: open.length, skippedUnsellable: skipped.length });
      if (skipped.length > 0)
        console.log(`💰 MANUAL HARVEST — nothing sellable-green this cycle (${skipped.length} skipped on dust/no-pair reads); flag cleared, click again when pools read real`);
      await clearHarvestRequest();
    }
  }

  for (const position of open) {
    const market = markets.get(position.mint) ?? null;
    if (!market) {
      // "No pair" can be a momentary aggregator flip, not a real delist — hold
      // until it persists MARK_CONFIRM_TICKS polls before writing off at zero.
      const c = (suspectCounts.get(position.id) ?? 0) + 1;
      if (c < cfg.MARK_CONFIRM_TICKS) {
        suspectCounts.set(position.id, c);
        await audit("suspect_hold", { positionId: position.id, mint: position.mint, reason: "no_pair", count: c });
        console.log(`🛡️  HOLD  ${short(position.mint)} — no pair returned (${c}/${cfg.MARK_CONFIRM_TICKS}), not writing off yet`);
        continue;
      }
      suspectCounts.set(position.id, 0);
      // no pair left for MARK_CONFIRM_TICKS polls — token pulled/rugged; write off
      await writeOffAtZero(position, "delisted");
      continue;
    }

    // LAYER 1 — Jupiter override with a same-tick divergence sanity check. The
    // real-time Jupiter mark is fresher than DexScreener's aggregation, but
    // liquidity is DexScreener-only: if DexScreener shows a healthy pool its price
    // is trustworthy, so a Jupiter mark that disagrees by >DIVERGENCE x is the
    // glitch (pos 29: Jupiter $9e-9 vs DexScreener ~$5.70 / liq $183k). Reject it
    // and keep DexScreener; otherwise take the fresher Jupiter price.
    const dexPrice = market.priceUsd; // DexScreener price, before any override
    const jp = jupPrices.get(position.mint);
    if (jp && jp > 0) {
      if (dexPrice > 0 && (jp > dexPrice * cfg.MARK_FEED_DIVERGENCE || jp < dexPrice / cfg.MARK_FEED_DIVERGENCE)) {
        await audit("jupiter_reject", { positionId: position.id, mint: position.mint, jup: jp, dex: dexPrice, liq: market.liquidityUsd });
        console.log(`⚠️  ${short(position.mint)} — Jupiter mark $${jp} diverges >${cfg.MARK_FEED_DIVERGENCE}x from DexScreener $${dexPrice}; keeping DexScreener`);
      } else {
        market.priceUsd = jp;
      }
    }

    // LAYER 2 — feed-coherence backstop, BEFORE the mark touches peak, the
    // classifier, or the exit rules. An incoherent read (one feed jumps orders of
    // magnitude while the other stays flat) is HELD at the last-good mark and
    // NEVER acted on, however long it persists — this is what the pure-temporal
    // guard got wrong (pos 29's garbage held 2 polls and the confirm honored it).
    // A COHERENT order-of-magnitude drop (both feeds low = a real rug) still
    // exits, after CONFIRM_TICKS to rule out a rare double-feed flip.
    const [lastTick] = await db
      .select({ priceUsd: positionTicks.priceUsd, liquidityUsd: positionTicks.liquidityUsd })
      .from(positionTicks)
      .where(eq(positionTicks.positionId, position.id))
      .orderBy(desc(positionTicks.snappedAt))
      .limit(1);
    const lastGood = lastTick ? n(lastTick.priceUsd) : n(position.entryPriceUsd);
    const lastGoodLiq = lastTick ? n(lastTick.liquidityUsd) : market.liquidityUsd;
    const verdict = classifyMark(cfg, market.priceUsd, market.liquidityUsd, lastGood, lastGoodLiq);
    if (verdict.kind === "dust") {
      suspectCounts.set(position.id, 0); // dust never accrues toward a price-based crash exit
      if (dustOutage) {
        // Book-wide dust = feed anomaly, not a real death. Hold at the last-good
        // mark and DON'T touch the death counter — a correlated flip must never
        // mass-write-off. The pool resumes accruing once dust isn't book-wide.
        await recordSuspectHold(position, market, lastGood, lastGoodLiq, verdict.why);
        console.log(`🛡️  HOLD  ${short(position.mint)} — dust (book-wide anomaly, no accrual) ${verdict.why}`);
        continue;
      }
      // Persistent-dust death exit: the pool is near-empty. Hold at first, but a
      // pool that STAYS dust for PERSISTENT_DUST_TICKS polls has genuinely lost
      // its tradeable liquidity — the held mark is fiction (you cannot get a fill
      // out of $2), the position is a corpse clogging a slot. Book it as a rug.
      // Persistence is the discriminator, so a transient aggregator flip (which
      // recovers in a tick or two) never reaches the count — the old fake-crash
      // protection is intact. This is what unclogs the book and stops corpses
      // from occupying slots a live mover needs.
      const dc = (dustCounts.get(position.id) ?? 0) + 1;
      if (dc >= cfg.PERSISTENT_DUST_TICKS) {
        dustCounts.set(position.id, 0);
        await audit("dust_death", { positionId: position.id, mint: position.mint, ticks: dc, why: verdict.why });
        await writeOffAtZero(position, "dust_rug");
        continue;
      }
      dustCounts.set(position.id, dc);
      await recordSuspectHold(position, market, lastGood, lastGoodLiq, verdict.why);
      console.log(`🛡️  HOLD  ${short(position.mint)} — dust pool (${dc}/${cfg.PERSISTENT_DUST_TICKS} → rug) ${verdict.why}`);
      continue;
    }
    dustCounts.set(position.id, 0); // any non-dust read resets the death counter
    if (verdict.kind === "garbage") {
      suspectCounts.set(position.id, 0); // incoherent-feed garbage never accrues toward a price-based exit
      // A single glitched feed (price jumped while liquidity flat, or vice-versa)
      // is transient — hold the last-good mark and never act, however long it
      // persists. This is NOT a dust pool (the pool is healthy), so it must never
      // trip the death exit; only a genuinely near-empty pool does.
      await recordSuspectHold(position, market, lastGood, lastGoodLiq, verdict.why);
      console.log(`🛡️  HOLD  ${short(position.mint)} — incoherent read (${verdict.why}); mark held $${lastGood}`);
      continue;
    }
    if (verdict.kind === "crash") {
      const c = (suspectCounts.get(position.id) ?? 0) + 1;
      if (c < cfg.MARK_CONFIRM_TICKS) {
        suspectCounts.set(position.id, c);
        await recordSuspectHold(position, market, lastGood, lastGoodLiq, `crash_confirm ${c}/${cfg.MARK_CONFIRM_TICKS}`);
        console.log(`🛡️  HOLD  ${short(position.mint)} — coherent crash, confirming ${c}/${cfg.MARK_CONFIRM_TICKS} before exit`);
        continue;
      }
      await audit("suspect_confirmed", { positionId: position.id, mint: position.mint, price: market.priceUsd, liquidity: market.liquidityUsd });
    }
    suspectCounts.set(position.id, 0);

    const peak = Math.max(n(position.peakPriceUsd), market.priceUsd);
    if (peak > n(position.peakPriceUsd)) {
      await db
        .update(positions)
        .set({ peakPriceUsd: String(peak) })
        .where(eq(positions.id, position.id));
    }

    // Trajectory + classifier call (persisted for the dashboard and audit).
    const call = cfg.CLASSIFIER_ENABLED ? await recordTickAndClassify(position, market, peak) : null;

    // 1. User override (the "engage" channel) always wins. A displacement cut
    //    (source "displace") is labeled honestly in the ledger — it's a slot
    //    recycled toward a confirmed banger, not a user decision.
    const taken = await takeIntent(position.id);
    const intent = taken?.intent ?? null;
    if (intent === "cut") {
      await sell(position, market, 1, taken?.source === "displace" ? "slot_displaced" : "user_cut");
      void mirrorLiveSell(cfg, position.mint, 1, "live_mirror_cut");
      continue;
    }

    const armed =
      peak >= n(position.entryPriceUsd) * cfg.PROFIT_LOCK_ARM_MULT ||
      n(position.sizeUsd) * (peak / n(position.entryPriceUsd) - 1) >= cfg.PROFIT_FLOOR_USD;

    // 2. Classifier — recycle DEAD losers only (faded/underwater and never got
    //    into profit). A position that has shown green is NEVER cut here: the
    //    ratcheting profit-trail banks it instead, so a runner is never capped.
    if (cfg.CLASSIFIER_MODE === "active" && call && intent !== "ride") {
      if (call.action === "CUT" && !armed) {
        await sell(position, market, 1, `classifier_${call.regime.toLowerCase()}`);
        void mirrorLiveSell(cfg, position.mint, 1, "live_mirror_classifier");
        continue;
      }
    }

    // 3. Ratcheting profit-trail (+ pre-profit hard stop). The classifier call
    //    shapes the trail width — RIDE widens the leash, blow-off/stall snugs it
    //    up. A RIDE intent suspends the stop for one tick to hold through a wick.
    let exit = decideExit(cfg, position, market, peak, call);
    // Pre-arm hard-stop WICK CONFIRMATION: sell only after the read stays below
    // the stop for HARD_STOP_CONFIRM_TICKS consecutive polls. Every historical
    // hard-stop fired on a single below-stop tick and 63% recovered past TP0
    // after ejecting us — one 5s wick must not eat a confirmed-strength entry.
    if (exit?.reason === "hard_stop" && cfg.HARD_STOP_CONFIRM_TICKS > 1) {
      const c = (stopConfirmCounts.get(position.id) ?? 0) + 1;
      if (c < cfg.HARD_STOP_CONFIRM_TICKS) {
        stopConfirmCounts.set(position.id, c);
        console.log(
          `🛡️  HOLD  ${short(position.mint)} — below stop, wick-confirming ${c}/${cfg.HARD_STOP_CONFIRM_TICKS} before exit`,
        );
        exit = null;
      } else {
        stopConfirmCounts.delete(position.id);
      }
    } else {
      stopConfirmCounts.delete(position.id); // any non-stop tick resets the count
    }
    if (exit && !(intent === "ride" && (exit.reason === "profit_trail" || exit.reason === "hard_stop"))) {
      await sell(position, market, exit.fraction, exit.reason);
      // Mirror the exit onto the live twin (M5): same fraction, same reason.
      // Fire-and-forget — the 5s manage loop never waits on chain confirms;
      // sweepLiveBook() force-closes anything a failed mirror leaves behind.
      void mirrorLiveSell(cfg, position.mint, exit.fraction, exit.reason);
    }
  }
}

/**
 * Record an equity snapshot: bankroll + realized + unrealized (marked to market).
 * TRUSTED MARKS ONLY — a dust/no-pair read here fabricated the $905 equity
 * craters: during a book-wide pool-flip the raw read valued 20 positions at ~$0,
 * the chart cratered, and (worse) the fake equity fed enforceCircuitBreaker,
 * which can trip the breaker on a phantom drawdown. When the live read is
 * untrusted, value the position at its LAST persisted management mark (the
 * manage loop's last-good discipline), falling back to entry (flat).
 */
export async function snapshotEquity(cfg: HermesConfig): Promise<void> {
  const [realizedRow] = await db
    .select({ total: sql<string>`coalesce(sum(${positions.realizedPnlUsd}), 0)` })
    .from(positions)
    .where(eq(positions.lane, "paper"));
  const open = await db
    .select()
    .from(positions)
    .where(and(eq(positions.status, "open"), eq(positions.lane, "paper")));

  let unrealized = 0;
  const snapMarkets = await fetchTokenMarkets(open.map((p) => p.mint)).catch(
    () => new Map<string, TokenMarket | null>(),
  );
  for (const position of open) {
    const market = snapMarkets.get(position.mint) ?? null;
    let mark: number;
    if (market && market.priceUsd > 0 && market.liquidityUsd >= cfg.MARK_MIN_LIQ_USD) {
      mark = market.priceUsd;
    } else {
      // Untrusted read — hold at the last management mark, never $0.
      const [lastTick] = await db
        .select({ mm: positionTicks.markMultiple })
        .from(positionTicks)
        .where(eq(positionTicks.positionId, position.id))
        .orderBy(desc(positionTicks.snappedAt))
        .limit(1);
      mark = lastTick ? n(lastTick.mm) * n(position.entryPriceUsd) : n(position.entryPriceUsd);
    }
    unrealized += n(position.qtyRemaining) * (mark - n(position.entryPriceUsd));
  }

  const realized = n(realizedRow?.total ?? "0");
  const equity = cfg.PAPER_BANKROLL_USD + realized + unrealized;
  await db.insert(pnlSnapshots).values({
    lane: "paper",
    equityUsd: String(equity),
    openPositions: open.length,
  });
  console.log(
    `💰 EQUITY $${equity.toFixed(2)} (realized $${realized.toFixed(2)}, unrealized $${unrealized.toFixed(2)}, ${open.length} open)`,
  );

  await enforceCircuitBreaker(cfg, equity);
}

interface BreakerState {
  baselineAt: number | null; // ms epoch; reference point for drawdown/loss since (re)start
  baselineEquity: number;
  trippedAt: number | null; // ms epoch of the last BREAKER trip; null = not breaker-halted
}

async function setKillSwitch(enabled: boolean): Promise<void> {
  await db
    .insert(config)
    .values({ key: "kill_switch", value: { enabled }, updatedAt: new Date() })
    .onConflictDoUpdate({ target: config.key, set: { value: { enabled }, updatedAt: new Date() } });
}
async function writeBreakerState(bs: BreakerState): Promise<void> {
  await db
    .insert(config)
    .values({ key: "breaker_state", value: bs, updatedAt: new Date() })
    .onConflictDoUpdate({ target: config.key, set: { value: bs, updatedAt: new Date() } });
}

/**
 * Capital-protection floor with AUTO-RESUME. If equity falls past the max drawdown
 * from its baseline peak, or the loss since baseline breaches the cap, engage the
 * kill switch so no new positions open (open positions still exit). Then, after
 * BREAKER_COOLDOWN_MIN, the breaker RELEASES ITSELF and re-anchors the baseline to
 * the resume equity — so it gets back in the game instead of sitting dark for hours
 * missing the winning cohort (the recorder still arms winners while halted). The
 * fresh baseline means it won't instantly re-trip on the same old drawdown.
 * A MANUAL kill switch (trippedAt null) is never auto-resumed — the operator owns it.
 */
export async function enforceCircuitBreaker(cfg: HermesConfig, equity: number): Promise<void> {
  const now = Date.now();
  const [ksRow] = await db.select().from(config).where(eq(config.key, "kill_switch"));
  const halted = (ksRow?.value as { enabled?: boolean } | undefined)?.enabled === true;
  const [bsRow] = await db.select().from(config).where(eq(config.key, "breaker_state"));
  let bs = (bsRow?.value as BreakerState | undefined) ?? null;

  if (halted) {
    // Auto-resume ONLY a breaker halt (trippedAt set), never a manual one.
    const cooldownMs = cfg.BREAKER_COOLDOWN_MIN * 60_000;
    if (cfg.BREAKER_COOLDOWN_MIN > 0 && bs?.trippedAt && now - bs.trippedAt >= cooldownMs) {
      await setKillSwitch(false);
      await writeBreakerState({ baselineAt: now, baselineEquity: equity, trippedAt: null });
      await audit("breaker_resumed", { equity, cooldownMin: cfg.BREAKER_COOLDOWN_MIN });
      console.log(
        `▶️  CIRCUIT BREAKER auto-resumed after ${cfg.BREAKER_COOLDOWN_MIN}m — fresh baseline $${equity.toFixed(0)}, entries live again`,
      );
    }
    return;
  }

  // Not halted. Anchor a fresh baseline on first run or after a manual release
  // that followed a breaker trip (stale trippedAt) — no trip on the anchoring cycle.
  if (!bs || bs.baselineAt == null || bs.trippedAt != null) {
    await writeBreakerState({ baselineAt: now, baselineEquity: equity, trippedAt: null });
    return;
  }

  const baselineAt = new Date(bs.baselineAt);
  const [peakRow] = await db
    .select({ peak: sql<string>`coalesce(max(${pnlSnapshots.equityUsd}), 0)` })
    .from(pnlSnapshots)
    .where(and(eq(pnlSnapshots.lane, "paper"), gte(pnlSnapshots.snappedAt, baselineAt)));
  const peak = Math.max(n(peakRow?.peak ?? "0"), bs.baselineEquity);

  const [lossRow] = await db
    .select({ loss: sql<string>`coalesce(sum(${positions.realizedPnlUsd}), 0)` })
    .from(positions)
    .where(and(eq(positions.lane, "paper"), eq(positions.status, "closed"), gte(positions.closedAt, baselineAt)));
  const segLoss = n(lossRow?.loss ?? "0");

  const drawdownPct = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
  const ddBreached = cfg.PAPER_MAX_DRAWDOWN_PCT > 0 && drawdownPct >= cfg.PAPER_MAX_DRAWDOWN_PCT;
  const lossBreached = cfg.PAPER_DAILY_LOSS_CAP_USD > 0 && segLoss <= -cfg.PAPER_DAILY_LOSS_CAP_USD;
  if (!ddBreached && !lossBreached) return;

  const reason = ddBreached
    ? `drawdown ${drawdownPct.toFixed(1)}% from baseline peak $${peak.toFixed(0)} (limit ${cfg.PAPER_MAX_DRAWDOWN_PCT}%)`
    : `loss $${segLoss.toFixed(0)} since baseline (cap $${cfg.PAPER_DAILY_LOSS_CAP_USD})`;
  await setKillSwitch(true);
  await writeBreakerState({ ...bs, trippedAt: now });
  await audit("circuit_breaker", { reason, equity, peak, segLoss, autoResumeMin: cfg.BREAKER_COOLDOWN_MIN });
  console.warn(
    `🛑 CIRCUIT BREAKER — ${reason}. New entries halted; open positions still exit. Auto-resume in ${cfg.BREAKER_COOLDOWN_MIN}m.`,
  );
}
