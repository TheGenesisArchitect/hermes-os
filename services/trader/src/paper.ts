import {
  canonicalVenue,
  classify,
  convexSlippagePct,
  DEFAULT_CLASSIFIER,
  fetchJupiterPrice,
  fetchJupiterPrices,
  fetchTokenMarket,
  fetchTokenMarkets,
  convictionOf,
  profileOf,
  sizeFraction,
  signatureExitOverrides,
  tickFrom,
  type HermesConfig,
  type LearnedProfile,
  type ManagementCall,
  type Signature,
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
  journalFill,
  safetyChecks,
} from "@hermes/db";
import { and, asc, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { maybeLiveBuy, mirrorLiveSell } from "./live/executor.js";
import { poolPulse, syncSlotWatch } from "./slotWatch.js";

// P2 FAST EXIT — fired by the ws watcher the moment a pool's SOL halves in
// 30s. Sells the open paper position at once (reason: depth_collapse_cut,
// same ratified rail, just event-speed) and mirrors live. In-flight guard
// prevents a double-sell against the concurrent manage poll; the fresh
// re-read means an already-closed position is a no-op.
const drainInFlight = new Set<string>();
export async function fastDrainExit(cfg: HermesConfig, mint: string): Promise<void> {
  if (drainInFlight.has(mint)) return;
  drainInFlight.add(mint);
  try {
    const open = await db
      .select()
      .from(positions)
      .where(and(eq(positions.status, "open"), eq(positions.lane, "paper"), eq(positions.mint, mint)));
    if (!open.length) return;
    const markets = await fetchTokenMarkets([mint]).catch(() => new Map<string, TokenMarket | null>());
    const market = markets.get(mint) ?? null;
    if (!market) return; // no priceable route this instant — the poll rail owns it
    for (const position of open) {
      console.log(`⚡ FAST DRAIN EXIT ${short(mint)} — pool SOL halved in 30s (ws event), cutting at event speed`);
      await audit("fast_drain_exit", {
        mint,
        positionId: position.id,
        reason: "ws pool drain ≥50%/30s — event-speed cut (measured cut tax 13-16% at poll speed)",
      });
      await sell(position, market, 1, "depth_collapse_cut");
      void mirrorLiveSell(cfg, mint, 1, "depth_collapse_cut");
    }
  } catch (err) {
    console.error(`fast drain exit failed (poll rail still armed): ${err instanceof Error ? err.message : err}`);
  } finally {
    drainInFlight.delete(mint);
  }
}

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

// ── COMPOUNDING BANKROLL (operator, 2026-07-23: "let the model compound") ────
// Sizing used the static PAPER_BANKROLL_USD constant while realized P&L grew
// past it — at $2,687 equity the sizer still saw $1,000, so 63% of the bankroll
// was invisible and every position was ~2.7× too small. Sizing capital is now
// base + REALIZED paper P&L (marks don't compound — only banked money does),
// floored at $100 so a drawdown shrinks the book instead of killing the engine.
// 30s cache: one cheap query per entry wave, not per candidate.
let bankrollCache = { v: 0, at: 0 };
async function paperBankrollNow(cfg: HermesConfig): Promise<number> {
  if (Date.now() - bankrollCache.at < 30_000 && bankrollCache.v > 0) return bankrollCache.v;
  try {
    const rows = (await db.execute(
      sql`select coalesce(sum(realized_pnl_usd),0)::float s from positions where lane='paper' and status='closed'`,
    )) as unknown as { s: number }[];
    bankrollCache = { v: Math.max(100, cfg.PAPER_BANKROLL_USD + Number(rows[0]?.s ?? 0)), at: Date.now() };
  } catch {
    // DB hiccup → last known value, or the static base on a cold start
    if (bankrollCache.v <= 0) bankrollCache = { v: cfg.PAPER_BANKROLL_USD, at: Date.now() };
  }
  return bankrollCache.v;
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
  // TRADE SIGNATURE routed by the recorder at the trigger tick, with the shape
  // that produced it. Governs size here and the entire exit profile later; a
  // position is managed under its own genome, not the global config.
  sig: {
    signature: Signature;
    dipDepth: number | null;
    snapPct: number | null;
    snapRate: number | null;
    stars: number | null;
    holders?: number | null;
    top10Pct?: number | null;
    largestHolderPct?: number | null;
    walletWinnerHits?: number | null;
    /** PRECISION subset (never-rugged wallets); null = pre-tier row, treat winner hits as strict. */
    walletStrictHits?: number | null;
    walletRugHits?: number | null;
    /** F6: which launch of this ticker (1-based, prior 24h). 2nd = the adversary's re-harvest. */
    launchOrder?: number | null;
    /** Pool inflow at trigger — F3 envelope check for the sensor tier. */
    liqGrowth?: number | null;
    /** Trigger multiple — the seat position; >CONVICTION_SEAT_MAX fires at sensor size. */
    triggerMultiple?: number | null;
  } | null = null,
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
  const risk = (signal.reasons as { risk?: { sizeMultiplier?: number; tier?: string; flags?: string[] } } | null)?.risk;
  const sizeMult = typeof risk?.sizeMultiplier === "number" ? risk.sizeMultiplier : 1;
  // TIER MULTIPLIER RETIRED FOR ROUTED ENTRIES (operator, 2026-07-23): the
  // soft-flag tiers predate the signature pipeline, and on the scrubbed 48h
  // tape they no longer discriminate — speculative won 72% vs clean's 73% —
  // yet cut every fresh launch to ×0.35 (soft flags are endemic at birth:
  // unlocked LP, concentration, low holders). The funnel now prices quality
  // (confirm bar, inflow bands, crowd gates, conviction stars); double-pricing
  // it was the penny-trade engine. ONE exception survives, because it is about
  // SELLABILITY not quality: an unverified honeypot probe keeps a 0.5 shrink.
  // Unrouted legacy entries keep the full tier system; hard traps still block.
  const routedRiskMult = risk?.flags?.includes("honeypot_unverified") ? 0.5 : 1;
  // Session sizing — survive the dead zone, grow in the moonshot window.
  const sessionMult = await hourSessionMult(cfg);
  // SIGNATURE SIZING — each genome carries its own conviction. RISER and BASE
  // confirmed on both sides of the split and size full; the moon grades and
  // CLIMBER are sample-limited (17-96 observations per side) and size down, so
  // they accumulate evidence under real conditions without betting the book on
  // an unconfirmed edge. RUG_RISK never opens.
  const sigProfile = sig ? profileOf(sig.signature) : null;
  if (sigProfile && !sigProfile.trade) {
    // RUG_RISK FORMULA ROUTE (ratified 2026-07-24 pipe census): the hard veto
    // predates F1/F3 and fired FIRST, so the better gates never saw the cell —
    // refused cohort ran 65% winners / 16% rugs (vs the 36.1% the veto was
    // built on). The formula arbitrates now: crowd-PASS + in-envelope trades
    // (78%-win cell, half clip via the genome); everything else falls through
    // to the sensor tier and probes instead of vanishing. Route off = old veto.
    const rrCrowd =
      sig?.walletWinnerHits != null && sig?.walletRugHits != null &&
      sig.walletWinnerHits >= 1 && sig.walletWinnerHits - sig.walletRugHits >= 1;
    const rrLg = sig?.liqGrowth != null && Number.isFinite(Number(sig.liqGrowth)) ? Number(sig.liqGrowth) : null;
    const rrInEnvelope = rrLg != null && rrLg >= cfg.INFLOW_FLOOR && rrLg <= cfg.INFLOW_CEILING;
    if (cfg.RUGRISK_FORMULA_ROUTE && sig?.signature === "RUG_RISK") {
      if (rrCrowd && rrInEnvelope) {
        await audit("entry_rugrisk_formula", {
          mint: signal.mint,
          walletWinnerHits: sig.walletWinnerHits,
          walletRugHits: sig.walletRugHits,
          inflow: rrLg,
          reason: "crowd-PASS + in-envelope RUG_RISK — formula overrides the stale veto (78% win / 1.70× offer cell), half clip",
        });
      }
      // fall through — qualified trades at the genome's half clip; the rest is
      // demoted to a sensor probe by the tier block below.
    } else {
      await audit("entry_filtered", { mint: signal.mint, reason: `signature ${sig?.signature} — ${sigProfile.note}` });
      await db.update(signals).set({ status: "dismissed" }).where(eq(signals.id, signal.id));
      console.log(`⛔ SKIP   ${token.symbol ?? "?"} ${short(signal.mint)} — ${sig?.signature}: ${sigProfile.note}`);
      return false;
    }
  }
  // PER-CLASS CONFIRMATION BAR — each genome must clear its OWN snap off the low
  // before capital is committed. The profiles have carried a minSnap since they
  // were written (RISER 0.15, BASE 0.20, MOON 0.35) but nothing enforced it: the
  // gate was still one global rule, so every class was admitted on the same
  // terms it was explicitly measured NOT to share.
  //
  // The cost of that shows in the tape — roughly 40% of entries never move at
  // all (peak < 1.10×), uniformly across every signature. Those are not exits
  // going wrong; no cover, trail or clock can rescue a position that never
  // rises. The snap is the one confirmation proven durable: positive EV in every
  // dip band (+8.4% to +30.6%), while the candidates that fell and merely crawled
  // back are the largest avoidable loss pool in the dataset.
  if (sigProfile && sigProfile.minSnap > 0 && sig) {
    const snap = sig.snapPct;
    if (snap == null || snap < sigProfile.minSnap) {
      await audit("entry_filtered", {
        mint: signal.mint,
        reason: `${sig.signature} snap ${snap == null ? "unknown" : `+${(snap * 100).toFixed(0)}%`} < required +${(sigProfile.minSnap * 100).toFixed(0)}%`,
      });
      // NOT dismissed — the candidate stays armed and may confirm on a later
      // tick. A weak snap now is a timing verdict, not a permanent one.
      console.log(
        `⏳ WAIT   ${token.symbol ?? "?"} ${short(signal.mint)} — ${sig.signature} needs +${(sigProfile.minSnap * 100).toFixed(0)}% off the low, has ${snap == null ? "n/a" : `+${(snap * 100).toFixed(0)}%`}`,
      );
      return false;
    }
  }
  // ── MOON ARM CONFIRMATION (operator-ratified 2026-07-26: "Don't enter a
  // Moon until it's confirmed Armed. Pre-Arm is too early and the trades
  // collapse and we keep donating... Wait for the Confirmation and then
  // Grab the Tail and ride it.") ─────────────────────────────────────────
  // F2's seat lower edge (1.20×) becomes a hard ENTRY FLOOR for MOON
  // classes — the move must have already confirmed the arm bar before real
  // capital boards. Every drag trade of the 5% test (Rex, Dat×2, USDP,
  // Thumbelina, realcoin) was a moon half-clip that died PRE-ARM. A WAIT,
  // not a dismissal: the candidate re-checks every tick and boards late
  // rather than never.
  if (sig && typeof sig.signature === "string" && sig.signature.startsWith("MOON")) {
    const mTm = sig.triggerMultiple != null ? Number(sig.triggerMultiple) : null;
    if (mTm == null || !Number.isFinite(mTm) || mTm < cfg.PROFIT_LOCK_ARM_MULT) {
      await audit("entry_filtered", {
        mint: signal.mint,
        reason: `${sig.signature} trigger ${mTm == null ? "unknown" : mTm.toFixed(2) + "×"} below the ${cfg.PROFIT_LOCK_ARM_MULT}× arm bar — moon boards CONFIRMED ARMED only (pre-arm collapses were the 5%-test drag)`,
      });
      console.log(
        `⏳ WAIT   ${token.symbol ?? "?"} ${short(signal.mint)} — ${sig.signature} not armed yet (${mTm == null ? "n/a" : mTm.toFixed(2) + "×"} < ${cfg.PROFIT_LOCK_ARM_MULT}×)`,
      );
      return false;
    }
  }
  // ── P4 DEPLOYER REP GATE (ordered 2026-07-26, "finish the wiring") ────────
  // A deployer with ≥2 fingerprinted launches whose rugs outnumber winners is
  // a MEASURED bad actor — refuse the launch outright, both lanes. Unknown
  // deployers pass untouched (absence is not evidence).
  try {
    const drep = (await db.execute(sql`
      SELECT d.deployer, count(co.mint)::int AS launches,
        count(*) FILTER (WHERE co.label = 'rug')::int AS rugs,
        count(*) FILTER (WHERE co.label = 'winner')::int AS wins
      FROM token_deployers d
      JOIN token_deployers d2 ON d2.deployer = d.deployer
      LEFT JOIN candidate_outcomes co ON co.mint = d2.mint
      WHERE d.mint = ${signal.mint} AND d.deployer IS NOT NULL
      GROUP BY d.deployer`)) as unknown as { deployer: string; launches: number; rugs: number; wins: number }[];
    const r = drep[0];
    if (r && r.launches >= 2 && r.rugs > r.wins) {
      await audit("entry_filtered", {
        mint: signal.mint,
        reason: `deployer ${r.deployer.slice(0, 8)}… rep: ${r.rugs} rugs vs ${r.wins} winners over ${r.launches} tracked launches — P4 rep gate refuses`,
      });
      console.log(`🚫 DEPLOYER ${short(signal.mint)} — known wallet, ${r.rugs}R/${r.wins}W over ${r.launches} launches, refused`);
      return false;
    }
  } catch {
    /* fingerprint table optional — gate fails open */
  }
  const sigMult = sigProfile?.size ?? 1;
  // ── SIZING: REGIME × SIGNATURE, not eight heuristics multiplied ────────────
  // PAPER_POSITION_USD is the regime's capital call (the adaptive policy's only
  // remaining job) and the signature supplies the precision on top: its class
  // multiplier, times conviction from the measured holder markers.
  //
  // The legacy chain — buyShare × rug × conviction × wallet × hot × liq × late ×
  // band — is bypassed for routed positions. Eight factors compounding produced
  // a 200× spread ($0.20 to $41.64 in six hours) and sized our best-evidenced
  // class at 21 cents: WIKICAT and NTFS both routed RISER, both cleared the
  // confirmation bar, both got $0.21. A position that clears its genome's bar
  // should be sized by how strongly the evidence backs it, not by a product of
  // heuristics that predate the signatures. Unrouted positions keep the chain.
  const conv = sig ? convictionOf(sig.signature, { holders: sig.holders, top10Pct: sig.top10Pct, largestHolderPct: sig.largestHolderPct }) : null;
  // A ROUTED position sizes as a PERCENT OF CAPITAL: the policy sets the range by
  // regime, the quality score picks the point inside it, and the signature's own
  // class multiplier scales it. Capital here is the paper bankroll; the live lane
  // runs the identical formula against the wallet balance, so the two lanes stay
  // on one risk model instead of drifting as the account moves.
  const frac = conv ? sizeFraction(conv.stars, cfg.POSITION_FRAC_MIN, cfg.POSITION_FRAC_MAX) : 0;
  // Capital = base + realized (the compounding bankroll), so the same frac that
  // sized a $1,000 day-one book scales with every banked dollar since.
  const bankrollNow = await paperBankrollNow(cfg);
  // PROBE = .35 OF THE SLOT (operator correction 2026-07-25: "Probes are .35
  // of 15, not 35 cents") — the sensor scales with the basket.
  const probeUsd = Number((bankrollNow * (cfg.MANDATE_AGG_FRAC / Math.max(1, cfg.MANDATE_SLOTS)) * cfg.PROBE_SLOT_FRAC).toFixed(2));
  const sizeUsd = Number(
    (conv
      ? bankrollNow * frac * routedRiskMult * sessionMult * sigMult
      : cfg.PAPER_POSITION_USD * sizeMult * qualityMult * sessionMult * sigMult
    ).toFixed(2),
  );
  // MOON_STEADY CONCENTRATED-PROBE RULE (Study 3, 2026-07-23): the class's
  // exits replay at their ceiling — its bleed is ENTRY selection. Concentrated
  // books (largest holder ≥30%) ran n=25 −$14.24 at 40% win vs dispersed n=50
  // +$33.69 at 54%; Bo's 53.52% whale is the archetype. Concentrated entries
  // drop to a $1.50 probe: the sensor keeps measuring, the bankroll stops
  // funding the cohort. Live inherits the shrunken fraction automatically.
  let sizedUsd = sizeUsd;
  // Any tier demotion below marks the entry non-PRECISION so the mandate clamp
  // never re-inflates a deliberately shrunken clip.
  let tierDemoted = false;
  // MOON SHOT eligibility, computed BEFORE the concentrated-probe clamp: the
  // ratified tier ("2★ moons fire at slot size") overrides the MOON_STEADY
  // concentration shrink — Cooper (10W, 2★) and FORMER (3W, 2★) were audited
  // as shots but clamped to $1.50 because this block ran first and set
  // tierDemoted, blocking the mandate band. Seat discipline still applies.
  const shotTm = sig?.triggerMultiple != null ? Number(sig.triggerMultiple) : null;
  const isMoonShot =
    cfg.MOONSHOT_TIER_ENABLED && sig?.stars === 2 &&
    typeof sig?.signature === "string" && sig.signature.startsWith("MOON") &&
    !(shotTm != null && Number.isFinite(shotTm) && shotTm > cfg.CONVICTION_SEAT_MAX);
  if (sig?.signature === "MOON_STEADY" && !isMoonShot && sizedUsd > probeUsd) {
    const [hc] = await db
      .select({ ev: safetyChecks.evidence })
      .from(safetyChecks)
      .where(and(eq(safetyChecks.mint, signal.mint), eq(safetyChecks.checkName, "holder_concentration")))
      .limit(1);
    const lg = Number((hc?.ev as { largestHolderPct?: number } | null)?.largestHolderPct);
    if (Number.isFinite(lg) && lg >= 30) {
      sizedUsd = probeUsd;
      tierDemoted = true;
    }
  }
  // ── FORMULA v2 SENSOR TIER (canon GCE-FORMULA-001, ratified 2026-07-24) ───
  // Crowd-fail (F1: needs wh ≥ 1 AND wh > rh) or a manufactured-spike inflow
  // (F3: above the envelope ceiling) demotes this entry to a sensor probe:
  // census crowd-fail ran $0.28/trade at 14% dead vs crowd-pass $1.29 at 5%.
  // The probe keeps the tape and the wallet graph fed at bounded tuition.
  {
    const crowdPass =
      sig?.walletWinnerHits != null && sig?.walletRugHits != null &&
      sig.walletWinnerHits >= 1 && sig.walletWinnerHits - sig.walletRugHits >= 1;
    const lgRaw = sig?.liqGrowth != null ? Number(sig.liqGrowth) : null;
    const lgNum = lgRaw != null && Number.isFinite(lgRaw) ? lgRaw : null;
    const spike = lgNum != null && (lgNum > cfg.INFLOW_CEILING || lgNum < cfg.INFLOW_FLOOR);
    // ARM SPEC (ratified 2026-07-24): the 1.65–2.05 slice armed but measured
    // −$1.01/t at conviction size — it fires as a sensor probe instead.
    const tmNum = sig?.triggerMultiple != null ? Number(sig.triggerMultiple) : null;
    const upperSlice = tmNum != null && Number.isFinite(tmNum) && tmNum > cfg.CONVICTION_SEAT_MAX;
    // MOON SHOT (ratified 2026-07-24): 2★ MOON-class fingerprint overrides the
    // crowd/envelope demotion — the shot is taken at slot size. Seat discipline
    // (upperSlice) still demotes; the alert cohort triggers inside the seat.
    // SUB-FLOOR CARVE-OUT (operator 2026-07-25, "stop throwing money at the
    // mild loser"): the override no longer covers a MEASURED inflow below the
    // floor — mild-band moons at slot size ran net negative (MOON_STEADY
    // −$8.44, MOON_SLOW −$7.47 / 72h) while the band's probe-scale cohort
    // stayed green. A sub-floor moon falls through to the deep-crowd nursery
    // or the sensor probe; the tail stays measured at tuition prices.
    const subFloorLg = lgNum != null && lgNum < cfg.INFLOW_FLOOR;
    const moonShot = isMoonShot && !upperSlice && !subFloorLg;
    if (moonShot && (!crowdPass || spike)) {
      await audit("entry_moonshot_tier", {
        mint: signal.mint,
        walletWinnerHits: sig?.walletWinnerHits ?? null,
        walletRugHits: sig?.walletRugHits ?? null,
        inflow: lgNum,
        reason: "2★ moon fingerprint — SHOT at slot size (alert cohort: 11/20 winners incl. 9.67×/7.82× were $1.50 probes)",
        sizedUsd,
      });
    } else if (
      // F6: SECOND-LAUNCH DEMOTION (ratified 2026-07-25) — the adversary's
      // re-harvest. Launch #2 of a ticker is the ONLY net-negative launch cell
      // on the full book (−2.3¢/$ vs 3rd-4th's +19.5¢/$): the opening launch
      // proves demand, the second harvests the players who "learned" from it.
      // Half-clip; every other launch order rides its normal tier.
      cfg.F6_SECOND_LAUNCH_DEMOTION && sig?.launchOrder === 2 && crowdPass && sizedUsd > probeUsd
    ) {
      tierDemoted = true;
      sizedUsd = Math.max(probeUsd, Number((sizedUsd * cfg.RECOVERED_TIER_SIZE_MULT).toFixed(2)));
      await audit("entry_second_launch", {
        mint: signal.mint,
        launchOrder: 2,
        reason: "F6: 2nd launch of ticker — the adversary's re-harvest cell (−2.3¢/$ full-book), half-clip",
        sizedUsd,
      });
    } else if (
      // DEEP-CROWD FLOOR EXCEPTION (ratified 2026-07-25): sub-floor inflow
      // with a deep clean crowd (wh≥5, zero rug-rep) is the moon nursery —
      // 67%/17% with 1-in-3 reaching ≥3× — and rides the HALF-CLIP under the
      // full ladder instead of a $1.50 probe. Mid/thin crowds fall through to
      // the sensor tier below; live keeps declining sub-floor until this
      // half-clip cell proves out.
      cfg.DEEPCROWD_FLOOR_ENABLED && crowdPass && !upperSlice &&
      lgNum != null && lgNum < cfg.INFLOW_FLOOR &&
      (sig?.walletWinnerHits ?? 0) >= cfg.DEEPCROWD_MIN_WH &&
      (sig?.walletRugHits ?? 0) === 0 &&
      sizedUsd > probeUsd
    ) {
      tierDemoted = true;
      const halfCap = Number(((bankrollNow * cfg.MANDATE_AGG_FRAC / Math.max(1, cfg.MANDATE_SLOTS)) * 0.5).toFixed(2));
      sizedUsd = Math.max(probeUsd, Math.min(halfCap, Number((sizedUsd * cfg.RECOVERED_TIER_SIZE_MULT).toFixed(2))));
      await audit("entry_deepcrowd_floor", {
        mint: signal.mint,
        walletWinnerHits: sig?.walletWinnerHits ?? null,
        walletRugHits: sig?.walletRugHits ?? null,
        inflow: lgNum,
        reason: `deep crowd ${sig?.walletWinnerHits}W/0R below the floor — half-clip moon-nursery ride (67%/17%, 1-in-3 ≥3×)`,
        sizedUsd,
      });
    } else if ((!crowdPass || spike || upperSlice) && sizedUsd > probeUsd) {
      tierDemoted = true;
      sizedUsd = Math.max(probeUsd, Number((sizedUsd * cfg.SENSOR_TIER_SIZE_MULT).toFixed(2)));
      await audit("entry_sensor_tier", {
        mint: signal.mint,
        walletWinnerHits: sig?.walletWinnerHits ?? null,
        walletRugHits: sig?.walletRugHits ?? null,
        inflow: lgNum,
        reason: !crowdPass ? "crowd-fail — F1 sensor probe" : spike ? "inflow outside the 1.20-2.05 envelope — F3 sensor probe" : "trigger in the 1.65-2.05 sensor slice — probe fire",
        sizedUsd,
      });
    } else if (
      crowdPass && sig?.walletStrictHits === 0 && sizedUsd > probeUsd &&
      // ENVELOPE PROMOTION (ratified 2026-07-25, good-band harness): crowd-pass
      // + MEASURED in-envelope inflow earns the full slot regardless of
      // strict-vs-recovered — the 1.20-1.30 cell is the system's best per-$
      // earner (+14.0¢/$; strong +7.7¢/$) and strict crowds barely exist in
      // this market. The recovered half-clip now applies only OUTSIDE the
      // measured envelope (or unmeasured); the slot ceiling bounds the rest.
      !(lgNum != null && lgNum >= cfg.INFLOW_FLOOR && lgNum <= cfg.INFLOW_CEILING)
    ) {
      // RECOVERED TIER (ratified 2026-07-24): the crowd is net-positive wallets
      // only — no never-rugged winner among holders. Leak-free verified 58%
      // winners / 28% rugs (vs strict 73%/4%), so it trades at a reduced clip
      // rather than full conviction. Null strictHits = pre-tier row, full size.
      tierDemoted = true;
      sizedUsd = Math.max(probeUsd, Number((sizedUsd * cfg.RECOVERED_TIER_SIZE_MULT).toFixed(2)));
      await audit("entry_recovered_tier", {
        mint: signal.mint,
        walletWinnerHits: sig?.walletWinnerHits ?? null,
        walletStrictHits: 0,
        walletRugHits: sig?.walletRugHits ?? null,
        reason: "net-positive crowd, no strict winner — RECOVERED tier clip",
        sizedUsd,
      });
    }
  }
  // ── MANDATE SIZING (operator vision, ratified 2026-07-24; per-slot
  // semantics clarified same night) ──────────────────────────────────────────
  // "1.5-2% measured across slots — $5.00 per slot, 6-10 trades at a time."
  // The mandate is AGGREGATE basket exposure; each PRECISION slot (strict
  // crowd + conviction seat + measured in-envelope inflow, no tier demotion)
  // clamps into 0.2-0.25% of the compounding bankroll. Consistency per slot ×
  // breadth across the basket is the compounding engine; defense lives in
  // tier demotion and the exit chain, not in shrinking or inflating clips.
  // RUG_RISK is excluded — its half clip stands until its counterfactual.
  if (cfg.MANDATE_SIZING_ENABLED && sig && !tierDemoted && sig.signature !== "RUG_RISK") {
    const mCrowd =
      sig.walletWinnerHits != null && sig.walletRugHits != null &&
      sig.walletWinnerHits >= 1 && sig.walletWinnerHits - sig.walletRugHits >= 1;
    const mStrict = sig.walletStrictHits !== 0; // null = pre-tier row, treated strict
    const mLg = sig.liqGrowth != null && Number.isFinite(Number(sig.liqGrowth)) ? Number(sig.liqGrowth) : null;
    const mEnvelope = mLg != null && mLg >= cfg.INFLOW_FLOOR && mLg <= cfg.INFLOW_CEILING;
    const mTm = sig.triggerMultiple != null ? Number(sig.triggerMultiple) : null;
    const mSeat = mTm != null && Number.isFinite(mTm) && mTm <= cfg.CONVICTION_SEAT_MAX;
    // MOON SHOT rides the same uniform slot band — sizing consistency is what
    // makes the winners pay for the basket (operator, 2026-07-24). A MEASURED
    // sub-floor inflow no longer qualifies for the lift (2026-07-25): the
    // clamp was raising mild-band moons to full slots through this door.
    const mMoonShot =
      cfg.MOONSHOT_TIER_ENABLED && sig.stars === 2 &&
      typeof sig.signature === "string" && sig.signature.startsWith("MOON") && mSeat &&
      !(mLg != null && mLg < cfg.INFLOW_FLOOR);
    // ENVELOPE PROMOTION (ratified 2026-07-25): strict no longer required —
    // crowd + measured envelope + seat is the full-slot qualification.
    void mStrict;
    if ((mCrowd && mEnvelope && mSeat) || mMoonShot) {
      // SESSION SEAM FIX (2026-07-25): the mandate band scales WITH the
      // session — the clamp was lifting off-hours entries back to full slots,
      // erasing the ratified ×0.5 survive-the-farm-window discount (FSR,
      // Trump, worm all died as full $6.70 slots at 06-07Z). The band is the
      // slot spec × the session's risk posture, never more.
      // REGIME-ADAPTIVE BASKET (ratified 2026-07-25 late): aggregate 1.5-5%
      // of balance by regime ÷ MANDATE_SLOTS, every ticket EVEN — one trade
      // can never destroy a basket.
      const lo = Number(((bankrollNow * cfg.MANDATE_AGG_FRAC / Math.max(1, cfg.MANDATE_SLOTS)) * sessionMult).toFixed(2));
      const hi = lo; // even tickets — the basket divides exactly
      const clamped = Math.min(hi, Math.max(lo, sizedUsd));
      if (clamped !== sizedUsd) {
        await audit("entry_mandate_size", {
          mint: signal.mint,
          from: sizedUsd,
          to: clamped,
          bankroll: Math.round(bankrollNow),
          reason: mMoonShot && !(mCrowd && mStrict && mEnvelope)
            ? "MOON SHOT — per-slot mandate band 0.2-0.25% of bankroll (uniform slots make winners pay for the basket)"
            : "PRECISION full-formula — per-slot mandate band 0.2-0.25% of bankroll (~$5/slot × 6-10 concurrent = 1.5-2% deployed)",
        });
        sizedUsd = clamped;
      }
    }
  }
  // ── SUB-FLOOR ABSOLUTE PROBE CAP (operator, 2026-07-25: "stop throwing
  // money at the Mild Loser all together — play the statistics") ────────────
  // The demotion tiers are RELATIVE multipliers off the conviction base, so
  // as the bankroll compounded a "probe" quietly became $5-6.70 of slot
  // money. Measured 24h, mild band (1.05-1.20×): probe scale +$16.42/155
  // trades, slot scale −$44.39/43 — same band, same tape, size was the whole
  // difference. Below the measured floor the book pays probe money only.
  // The ratified deep-crowd nursery (wh≥5/0R) keeps its half-clip, and an
  // unmeasured inflow stays neutral (absence is not evidence). Existing
  // probe/ticket sizes (≤$2) pass untouched.
  if (sig && sizedUsd > 2) {
    const pLgRaw = sig.liqGrowth != null ? Number(sig.liqGrowth) : null;
    const pLg = pLgRaw != null && Number.isFinite(pLgRaw) ? pLgRaw : null;
    const deepCrowdNursery =
      cfg.DEEPCROWD_FLOOR_ENABLED &&
      (sig.walletWinnerHits ?? 0) >= cfg.DEEPCROWD_MIN_WH &&
      (sig.walletRugHits ?? 0) === 0;
    if (pLg != null && pLg < cfg.INFLOW_FLOOR) {
      // Deep crowd keeps its ratified nursery ride — but BOUNDED at the
      // nursery's own slot/2 ceiling. SPR (6W/0R, lg 1.14) reached $5.55 via
      // the second-launch path: the 0.5× demotion has no absolute bound, and
      // a crowd-based exemption alone let it through above the ratified cap.
      const cap = deepCrowdNursery
        ? Number(((bankrollNow * cfg.MANDATE_AGG_FRAC / Math.max(1, cfg.MANDATE_SLOTS)) * 0.5).toFixed(2))
        : probeUsd;
      if (sizedUsd > cap) {
        const prior = sizedUsd;
        sizedUsd = cap;
        tierDemoted = true;
        await audit("entry_subfloor_probe_cap", {
          mint: signal.mint,
          inflow: pLg,
          from: prior,
          to: sizedUsd,
          reason: deepCrowdNursery
            ? `deep crowd below the floor — bounded at the nursery half-clip ceiling (slot/2)`
            : `inflow ${pLg.toFixed(2)}× below the ${cfg.INFLOW_FLOOR}× floor — absolute probe cap (mild at slot scale −$44/24h vs +$16 at probe scale)`,
        });
      }
    }
  }
  // ── CLONE-WAVE MIRROR (ratified 2026-07-25, improvement ledger) ───────────
  // The 8h rungless-death tax ran 92% of gross wins (bar ≤25%), concentrated
  // in same-ticker relaunch waves (MONA −$6.69 on paper vs −$0.15 live on the
  // IDENTICAL mint — live's clone-wave rule held it, paper had none). Mirror:
  // a same-ticker sibling that RUGGED inside 60 minutes demotes this entry to
  // probe scale — NOT a refusal: the probe keeps the wave measured so the
  // L3-4 golden re-entry stays visible once the drain has printed. Unlike
  // live's version, a still-open sibling does not demote (paper explores).
  if (sig && sizedUsd > probeUsd && token.symbol) {
    const [waveRug] = (await db.execute(sql`
      SELECT 1 FROM positions p2 JOIN tokens t2 ON t2.mint = p2.mint
      WHERE t2.symbol = ${token.symbol} AND p2.mint <> ${signal.mint}
        AND p2.status = 'closed' AND p2.closed_at > now() - interval '60 minutes'
        AND (p2.exit_reason IN ('dust_rug','live_unsellable','delisted','depth_collapse_cut')
             OR p2.realized_pnl_usd::float <= -0.8 * p2.size_usd::float)
      LIMIT 1`)) as unknown as unknown[];
    if (waveRug) {
      tierDemoted = true;
      const prior = sizedUsd;
      sizedUsd = probeUsd;
      await audit("entry_clone_wave_probe", {
        mint: signal.mint,
        symbol: token.symbol,
        from: prior,
        to: sizedUsd,
        reason: `clone wave: a ${token.symbol} sibling rugged <60m — probe scale until the wave proves its golden window (mirror of live's rule)`,
      });
    }
  }
  // ── EXIT-VIABILITY DEPTH SCALING (2026-07-25, collapse anatomy) ───────────
  // Every meteora-dbc drain death in 24h (−$47: all/in, Pumuckel, corncat…)
  // entered a ~$2k pool at slot size — a clip the pool could never pay back.
  // Live's depth floor refuses these; paper had no check, violating the
  // paper-mirrors-live-gates doctrine ("not hallucinating what's available").
  // The clip now scales to what the pool can exit: sized ≤ pool/25, floored
  // at probe scale so the sensor keeps measuring thin venues.
  if (sig && market.liquidityUsd != null && Number.isFinite(market.liquidityUsd) && sizedUsd > probeUsd) {
    const depthCap = Math.max(probeUsd, Number((market.liquidityUsd / 25).toFixed(2)));
    if (sizedUsd > depthCap) {
      await audit("entry_depth_scaled", {
        mint: signal.mint,
        from: sizedUsd,
        to: depthCap,
        poolUsd: Math.round(market.liquidityUsd),
        reason: `pool $${Math.round(market.liquidityUsd)} cannot exit a $${sizedUsd.toFixed(2)} clip — sized to pool/25 (collapse-anatomy: dbc $2k-pool cell −$47/24h)`,
      });
      sizedUsd = depthCap;
    }
  }
  // ── UNIVERSAL SLOT CEILING (operator, 2026-07-24: "why does capital keep
  // getting misapplied") ────────────────────────────────────────────────────
  // The per-slot mandate clamped the tiers named in its ratification and left
  // legacy conviction sizing alive underneath — recovered-tier clips reached
  // $18-31 (3-6× the slot spec) and three died pre-arm in 90 minutes for
  // −$47 (all/in, opensource, Pumuckel). The ladder is now absolute: NOTHING
  // on the book exceeds the slot cap, any tier, any path. Floors untouched —
  // probes stay probes; live inherits through the mirror fraction.
  if (cfg.MANDATE_SIZING_ENABLED && sig) {
    // Ceiling scales with the session too (same seam as the band).
    // DEMOTED = HALF CEILING (ladder audit, 2026-07-25 late): every demotion
    // tier is a RELATIVE multiplier (0.5×, 0.3×) off the conviction base, so
    // on a grown bankroll a "half-clip" reached $5.54 (Tiana, second-launch
    // 0.5× of an $11 base) — above the ratified half-clip meaning of slot/2.
    // A demoted entry now caps at HALF the universal ceiling, any path.
    const fullCap = Number(((bankrollNow * cfg.MANDATE_AGG_FRAC / Math.max(1, cfg.MANDATE_SLOTS)) * sessionMult).toFixed(2));
    const slotCap = tierDemoted ? Number((fullCap * 0.5).toFixed(2)) : fullCap;
    if (sizedUsd > slotCap) {
      await audit("entry_slot_cap", {
        mint: signal.mint,
        from: sizedUsd,
        to: slotCap,
        reason: tierDemoted
          ? "demoted tier — half the universal ceiling (half-clip means slot/2, any path)"
          : "universal slot ceiling — uniform slots, winners pay through volume (per-slot mandate, all tiers)",
      });
      sizedUsd = slotCap;
    }
  }
  const finalSizeUsd = sizedUsd;

  // LIVE FIRES HERE — the instant paper's size is known, before its own insert.
  // Live receives paper's REALISED fraction of capital rather than re-deriving it,
  // because paper's size passes through risk-tier and session multipliers on top
  // of the conviction fraction. Live applied only the fraction and so deployed
  // 1.82% of a $169 balance per trade against paper's 0.61% of $1,000 — three
  // times the relative risk on identical signals. Passing the realised fraction
  // makes drift impossible by construction: whatever share of capital paper
  // commits, live commits the same share of its own.
  if (sig) {
    // Mirror fraction against the SAME compounding bankroll the size came from —
  // a static denominator here would overstate paper's conviction as it grows.
  void maybeLiveBuy(cfg, signal.mint, token.symbol, sig, finalSizeUsd / Math.max(bankrollNow, 1));
  }
  const slip = slippagePct(finalSizeUsd, market.liquidityUsd);
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
  const feeUsd = (finalSizeUsd * FEE_PCT) / 100 + FIXED_FEE_USD;
  const qty = (finalSizeUsd - feeUsd) / entryPrice;

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
    sizeUsd: finalSizeUsd,
  });

  // ATOMIC OPEN CLAIM. The `held` check above is a read-then-write: two
  // consumers evaluating the same armed candidate both see "not held" and both
  // insert. Measured 2026-07-21: 15 signals opened TWICE in 24h — 30 positions,
  // −$17.55 combined, with MILF booking −$3.07 twice off one signal and FIM
  // deploying $28.80 against a $14.40 decision. The pairs land 5ms–1s apart, so
  // no amount of checking-first closes it.
  //
  // The invariant already existed in code; it now lives in the database, where
  // it cannot race: unique index positions_one_open_paper_per_mint on (mint)
  // WHERE status='open' AND lane='paper'. A loser of the race gets a unique
  // violation here and skips the entry rather than doubling the book.
  //
  // PAPER ONLY, deliberately. Live inserts its row AFTER the on-chain swap has
  // already executed, so a constraint failure there would leave real tokens
  // bought with no position row to manage them — strictly worse than the
  // duplicate. Live needs the claim taken BEFORE the swap, which is a real
  // refactor; it duplicated 1 signal in 24h against paper's 14, so this closes
  // the measured bleed without putting capital at risk.
  let position: typeof positions.$inferSelect | undefined;
  try {
    [position] = await db
      .insert(positions)
      .values({
      signalId: signal.id,
      mint: signal.mint,
      lane: "paper",
      tier: lane,
      triggerMult: triggerMult !== null && Number.isFinite(triggerMult) ? String(triggerMult) : null,
      sizeUsd: String(finalSizeUsd),
      qualityMult: String(qualityMult),
      // Pinned at open and never changed: the exit profile is looked up from
      // this, and the ledger compares the signal we acted on to what we got.
      signature: sig?.signature ?? null,
      dipDepth: sig?.dipDepth != null ? String(sig.dipDepth) : null,
      snapPct: sig?.snapPct != null ? String(sig.snapPct) : null,
      snapRate: sig?.snapRate != null ? String(sig.snapRate) : null,
      stars: sig?.stars ?? null,
      qtyTokens: String(qty),
      qtyRemaining: String(qty),
      entryPriceUsd: String(entryPrice),
      peakPriceUsd: String(entryPrice),
      realizedPnlUsd: "0",
      })
      .returning();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/positions_one_open_paper_per_mint|duplicate key/i.test(msg)) throw err;
    await audit("entry_filtered", { mint: signal.mint, reason: "duplicate open — lost the claim race" });
    console.log(`⛔ SKIP   ${token.symbol ?? "?"} ${short(signal.mint)} — already open in this lane (claim race)`);
    return false;
  }
  if (!position) return false;
  if (book) book[lane] += 1; // book the fill into the shared capacity ledger

  const [buyFill] = await db.insert(fills).values({
    positionId: position.id,
    side: "buy",
    qtyTokens: String(qty),
    priceUsd: String(entryPrice),
    slippagePct: String(slip),
    feeUsd: String(feeUsd),
    reason: note || "blind", // entry path: confirmed | blind
  }).returning({ id: fills.id });
  // Phase 4b: journal at the moment money moves; the sweep converges on the
  // same idempotency key and heals any missed emit.
  if (buyFill) void journalFill({ fillId: buyFill.id, book: "paper", side: "buy", filledAt: new Date(),
    positionId: position.id, mint: signal.mint, qty, priceUsd: entryPrice, feeUsd, entryPriceUsd: entryPrice,
    reason: note || "blind" });
  await db.update(signals).set({ status: "traded_paper" }).where(eq(signals.id, signal.id));

  console.log(
    `📈 OPEN   ${token.symbol ?? "?"} ${short(signal.mint)} ${finalSizeUsd} «${lane}» [${sig ? `${"★".repeat(conv?.stars ?? 0)}🧬${sig.signature}${sigMult !== 1 ? ` ×${sigMult}` : ""}${conv && conv.stars > 0 ? ` · ${conv.why}` : ""} · ` : ""}${risk?.tier ?? "clean"}${qualityMult < 1 ? ` · quality ×${qualityMult}` : ""}${sessionMult < 1 ? ` · offhrs ×${sessionMult}` : ""}] @ $${entryPrice.toPrecision(4)} (liq $${Math.round(market.liquidityUsd).toLocaleString()}, slip ${slip.toFixed(2)}%, score ${signal.score}${note ? ` · ${note}` : ""})`,
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
      walletWinnerHits: candidateOutcomes.walletWinnerHits,
      walletStrictHits: candidateOutcomes.walletStrictHits,
      walletRugHits: candidateOutcomes.walletRugHits,
      launchOrder: candidateOutcomes.launchOrder,
      walletKnown: candidateOutcomes.walletKnown,
      convictionScore: candidateOutcomes.convictionScore,
      liqGrowth: candidateOutcomes.liqGrowth,
      signature: candidateOutcomes.signature,
      dipDepth: candidateOutcomes.dipDepth,
      snapPct: candidateOutcomes.snapPct,
      snapRate: candidateOutcomes.snapRate,
      stars: candidateOutcomes.stars,
    })
    .from(candidateOutcomes)
    .innerJoin(signals, eq(signals.id, candidateOutcomes.signalId))
    .innerJoin(tokens, eq(tokens.mint, candidateOutcomes.mint))
    .where(
      and(
        // `armed` is the recorder's LIVE authority — it already encodes the
        // re-entry policy (no open position, entry cap, cooldown, gate
        // re-qualified). The old `entered=false` filter here made every entry
        // one-shot and forfeited the VICE-class re-runs (67 overnight).
        eq(candidateOutcomes.armed, true),
        // FRESHNESS measured against the CONFIRMING tick, not the last poll.
        // updatedAt is stamped every poll regardless of state, so the staleness
        // cap never actually bit — a candidate could sit armed while the trader
        // waited on a slot and then be bought on a confirmation minutes old.
        // confirmedAt moves only when the gate genuinely passes, so a signal
        // that stops qualifying expires immediately.
        gte(candidateOutcomes.confirmedAt, freshCutoff),
      ),
    )
    // CONVICTION-FIRST: when the book can't take everyone, the highest-conviction
    // confirmed candidates get the scarce slots (creme rises) — the fused
    // wallet-dominant model, not raw trigger multiple. Null conviction (pre-
    // migration/unscored) falls to the back via COALESCE, then trigger multiple
    // breaks ties.
    .orderBy(
      desc(sql`coalesce(${candidateOutcomes.convictionScore}::float, -1)`),
      desc(candidateOutcomes.triggerMultiple),
    );

  if (armed.length === 0) return;

  // POOL-INFLOW PRIORITY — the edge decides the queue too, not just the size.
  // When slots are scarce the inflow-confirmed candidate (81% win / 10% rug)
  // must take the slot ahead of a marginal flat-pool confirm. Sorted first so
  // the later stable sorts (hot family, prime venue) layer on top.
  if (cfg.LIQ_INFLOW_STRONG > 0) {
    // BAND-WEIGHTED SLOT PRIORITY (operator-ratified 2026-07-26: "ship the
    // slot priority if it holds" — it held: strong 9.4¢/$ vs winner-rep
    // sub-strong 1.3¢/$ over 3d, 6.1 vs 4.3 over 7d, 'other' negative both).
    // Tickets stay EVEN (the ratified basket geometry); what adapts is WHO
    // boards first when slots contend: strong inflow > winner-rep crowd >
    // rest. Allocation follows efficiency; geometry never moves.
    const tier = (x: (typeof armed)[number]): number => {
      const lg = x.liqGrowth == null ? null : Number(x.liqGrowth);
      if (lg != null && lg >= cfg.LIQ_INFLOW_STRONG) return 2;
      const wr =
        x.walletWinnerHits != null && x.walletRugHits != null &&
        Number(x.walletWinnerHits) - Number(x.walletRugHits) >= 1;
      return wr ? 1 : 0;
    };
    armed.sort((a, b) => tier(b) - tier(a));
  }

  // HOT-TICKER meta-momentum: refresh the family set, then stable-sort hot
  // families forward BEFORE the prime sort (final order: prime > hot > conviction).
  await refreshHotTickers(cfg);
  if (cfg.HOT_TICKER_ENABLED && hotTickers.families.size > 0) {
    armed.sort((a, b) => {
      const ah = isHotTicker(cfg, a.token.symbol) ? 1 : 0;
      const bh = isHotTicker(cfg, b.token.symbol) ? 1 : 0;
      return bh - ah; // stable: preserves conviction order within each group
    });
  }

  // PRIME PONDS jump the queue: a fluxbeam-class confirm (measured 15/15
  // winners, 0 rugs) takes a slot before any raw trigger-multiple ordering —
  // the rarest healthy flow must never wait behind mill relaunches. The set is
  // DYNAMIC: static config ∪ the Pond Radar's currently-promoted venues.
  const prime = await primeVenueSet(cfg);
  if (prime.size > 0) {
    armed.sort((a, b) => {
      const ap = prime.has((a.token.dex ?? "").toLowerCase()) ? 1 : 0;
      const bp = prime.has((b.token.dex ?? "").toLowerCase()) ? 1 : 0;
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

  for (const { signal, token, mint, triggerBuyShare, rugProb, triggerMultiple, walletWinnerHits, walletStrictHits, walletRugHits, walletKnown, liqGrowth, signature, dipDepth, snapPct, snapRate, stars, launchOrder } of armed) {
    if (total() >= cfg.PAPER_MAX_CONCURRENT) break; // global cap hit — leave the rest armed

    // WALLET ANTI-GATE, PAPER EDITION (band dissection 2026-07-23): rug-history
    // crowds (net rep ≤ −1) ran 29% win / 58% rug inside the 1.05–1.30 inflow
    // band (n=177 of 477 — a third of the flow carrying nearly all the rugs)
    // and 9.6% win / 49.3% rug across the whole tape. Candidate labels arrive
    // whether we trade or not, so refusing costs the sensor nothing but the
    // management tape of a cohort we never want to manage. Live has refused
    // this crowd since yesterday; paper now stops paying its tuition too.
    if (walletWinnerHits != null && walletRugHits != null && walletWinnerHits - walletRugHits <= -1) {
      await audit("entry_wallet_antigate", { mint, net: walletWinnerHits - walletRugHits });
      // Label the refusal so the boards show WHY this candidate ages out as a
      // disarm instead of a trade — 36 of these in the first 3h read as an
      // "unusual amount of disarms" until the reason was visible.
      await db.update(signals).set({ status: "crowd_refused" }).where(eq(signals.id, signal.id)).catch(() => {});
      continue;
    }

    // FORMULA v2 TIERS, PAPER EDITION (ratified 2026-07-24): the below-strong
    // crowd REFUSAL is superseded by canon two-tier routing. Crowd-fail and
    // manufactured-spike flow now trades on paper at SENSOR-probe size (the
    // sizing tier is applied in openFromSignal, where the compounding bankroll
    // math lives) instead of being refused — the tape stays fully measured
    // while live, which refuses this cohort outright, never mirrors it at
    // conviction size. No refusal here; the tier does the risk work.

    // Open-only duplicate guard — a CLOSED prior position no longer blocks
    // (re-entry policy lives in the recorder's armed flag: cap + cooldown).
    const [held] = await db
      .select({ id: positions.id })
      .from(positions)
      .where(and(eq(positions.mint, mint), eq(positions.status, "open")))
      .limit(1);
    if (held) continue; // already in it — recorder will disarm on its next poll
    // Skip only DISMISSED signals. `traded_paper` must NOT block: the recorder's
    // armed flag is the re-entry authority (cooldown + entry cap + gate
    // re-qualified per the VICE fix), but this status check silently made every
    // entry one-shot anyway — nice re-armed at 2.26x/0%dd/89% buys and was
    // refused here while running to 7.61x (2026-07-20).
    if (signal.status === "dismissed") continue;

    // WALLET-GRAPH GATE — SHRINK, don't veto (2026-07-20). The binary veto
    // ("serial-rugger holders, no smart-money") started blocking the tail itself
    // after the label backfill reddened the graph: 57 winners avg 6.68x peak
    // (incl. a 68x) vetoed in 24h alongside 335 losers. The rugger profile now
    // sizes down ×WALLET_GATE_SIZE_MULT; only an overwhelming rap sheet — a
    // large sampled holder set that is ALL rugger-rep with zero winner-rep —
    // still vetoes. Missing score = no data → full size, don't block.
    let walletMult = 1;
    if (cfg.PAPER_WALLET_GATE && (walletRugHits ?? 0) > 0 && (walletWinnerHits ?? 0) === 0) {
      if (
        (walletRugHits ?? 0) >= cfg.WALLET_VETO_MIN_RUG_HITS &&
        (walletKnown ?? 0) >= cfg.WALLET_VETO_MIN_KNOWN
      ) {
        await audit("entry_filtered", { mint, reason: `wallet: overwhelming rugger rap sheet (${walletRugHits} rug-rep / ${walletKnown} known, 0 winner-rep)` });
        continue;
      }
      walletMult = cfg.WALLET_GATE_SIZE_MULT;
    }

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
    const primeVenue = prime.has((token.dex ?? "").toLowerCase());
    const convictionMult =
      primeVenue || (tm !== null && Number.isFinite(tm) && tm >= cfg.CONVICTION_MULT_MIN)
        ? cfg.CONVICTION_SIZE_BOOST
        : 1;
    // HOT-TICKER boost: the family is printing right now (validated 1.5× win
    // lift) — lean in while it lasts; the rug-model shrink and cost-recoup
    // ladder price the elevated rug share that comes with the heat.
    const hotMult = isHotTicker(cfg, token.symbol) ? cfg.HOT_TICKER_SIZE_BOOST : 1;
    // POOL-INFLOW SIZING — THE EDGE. New capital arriving in the pool is the one
    // thing a wash-traded fake cannot manufacture, and it is the strongest
    // leak-free predictor we have measured: growth ≥1.3× at trigger ran 2.79×
    // after entry and rugged 6% (vs 1.78× / 26%); the ≥1.4×-mark + ≥+10%-pool
    // cohort wins 81% and rugs 10%. Conversely price-up-on-a-FLAT-pool is the
    // wash/ragoon signature and rugs 35% vs 22%. Lean in on inflow, shrink the
    // flat-pool case — sizing only, never a veto.
    const lg = liqGrowth === null ? null : Number(liqGrowth);
    // PAPER INFLOW GATE — same quality bar as live, minus the blindness. Weak
    // inflow is refused, EXCEPT a small random sample held back at probe size so
    // every band keeps producing realized P&L. Without that carve-out the Inflow
    // Edge panel would only ever see the band we already believe in, and a shift
    // in the edge (the 1.20-1.30 miscalibration was caught exactly this way)
    // would be invisible until it showed up as losses somewhere else.
    // WINNER-REP RECEIVER (operator, 2026-07-23: "un-probe the winners"):
    // below strong inflow the crowd gate above already admits ONLY winner-rep
    // crowds — 48h: 82–89% win / 47% capture. That cohort flows at full size,
    // not as a 15% explore sample at probe scale; the probe discount was built
    // for the pre-gate coin-flip band that no longer reaches this line.
    const winnerRepCrowd =
      walletWinnerHits != null && walletRugHits != null && walletWinnerHits - walletRugHits >= 1;
    let exploring = false;
    if (cfg.PAPER_REQUIRE_INFLOW && !winnerRepCrowd && lg !== null && Number.isFinite(lg) && lg < cfg.LIQ_INFLOW_STRONG) {
      if (Math.random() < cfg.PAPER_INFLOW_EXPLORE_RATE) {
        exploring = true; // keep the band measurable — at probe size
      } else {
        await audit("entry_filtered", { mint, reason: `weak inflow (pool ${lg.toFixed(2)}× < ${cfg.LIQ_INFLOW_STRONG}×)` });
        continue;
      }
    }
    const liqMult = exploring
      ? cfg.PAPER_INFLOW_EXPLORE_SIZE_MULT
      : lg === null || !Number.isFinite(lg)
        ? 1 // unmeasured → neutral; absence is not evidence
        : lg >= cfg.LIQ_INFLOW_STRONG
          ? cfg.LIQ_INFLOW_SIZE_BOOST // the band that pays: 72% win, 0% rug
          : winnerRepCrowd
            ? 1 // proven crowd below strong — full size, the gate replaced the probe
            : cfg.LIQ_FLAT_SIZE_MULT; // (only reachable with the gate disabled)
    // LATE-ENTRY SHRINK — a confirm in the buying-the-top band (2.0-2.5× already
    // run) was 27.5% dead-on-arrival at −13.3% on deployed. Half size; the
    // cost-recoup floor then banks the basis if it stalls, so a late entry that
    // still ticks up pays for itself instead of bleeding.
    const lateMult =
      tm !== null && Number.isFinite(tm) && tm >= cfg.LATE_ENTRY_LO && tm < cfg.LATE_ENTRY_HI
        ? cfg.LATE_ENTRY_SIZE_MULT
        : 1;
    // MOONSHOT BAND — put the capital where the tail is. Post-trigger runs of
    // 3.72x (1.6-2.0x band) and 3.53x with ZERO observed rugs (≥2.0x) versus
    // 1.44x and 29% rugs in the zone we used to fill.
    const bandMult =
      tm !== null && Number.isFinite(tm)
        ? tm >= cfg.BAND_ELITE_MULT
          ? cfg.BAND_ELITE_SIZE
          : tm >= cfg.BAND_STRONG_MULT
            ? cfg.BAND_STRONG_SIZE
            : 1
        : 1;
    const qualityMult = buyShareMult * rugMult * convictionMult * walletMult * hotMult * liqMult * lateMult * bandMult;

    // Consume ONLY on a real fill. A false return (lane reserved / market null /
    // venue / liquidity / slippage) leaves the candidate armed to re-attempt next
    // cycle — a transient miss or a momentarily-reserved lane never permanently
    // burns a token that then runs 3–24x.
    // Rows predating the signature rollout carry no routing — those enter under
    // the global config exactly as before rather than being blocked.
    const sigArg = signature
      ? {
          signature: signature as Signature,
          dipDepth: dipDepth === null ? null : Number(dipDepth),
          snapPct: snapPct === null ? null : Number(snapPct),
          snapRate: snapRate === null ? null : Number(snapRate),
          stars: stars ?? null,
          // Pool inflow at the trigger tick — live's probability-band gate
          // reads it (1.30×+ wins 71.2% vs 44.8% below; 2×+ ran 18-for-18).
          liqGrowth: liqGrowth === null ? null : Number(liqGrowth),
          // Seat position — the conviction/sensor slice boundary reads this.
          triggerMultiple: triggerMultiple === null ? null : Number(triggerMultiple),
          // Point-in-time wallet-graph reputation of the holder set — live's
          // smart-money gate and boost read these (7d study 2026-07-22).
          walletWinnerHits: walletWinnerHits ?? null,
          walletStrictHits: walletStrictHits ?? null,
          walletRugHits: walletRugHits ?? null,
          launchOrder: launchOrder ?? null,
        }
      : null;
    // LIVE FIRES ON THE SAME SIGNAL, INDEPENDENTLY — not as a shadow of paper.
    // Previously this was nested inside the paper-open success branch, so live
    // could only ever trade what paper had already filled, inheriting paper's
    // timing and its failures. Both lanes now act on the same armed candidate at
    // the same moment, each sizing off its own capital and managing under the
    // same genome. That makes the two lanes a genuine comparison — same signals,
    // same rules, different balances — instead of one lane echoing the other.
    // Fire-and-forget: an on-chain confirm must never stall the entry scan.
    if (await openFromSignal(cfg, signal, token, "confirmed", book, qualityMult, tm, sigArg)) {
      // (The live buy already fired above, on the same signal and at the same
      // moment — it is no longer mirrored off this branch.)
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

/**
 * Profiles promoted by the learning loop, cached briefly so the manage loop can
 * consult them every tick without hammering the config table. A promotion takes
 * effect within LEARNED_TTL_MS — no restart, no deploy. On any read failure the
 * compiled defaults stand, so a DB hiccup can never leave a position unmanaged.
 */
const LEARNED_TTL_MS = 60_000;
let learnedCache: { at: number; map: Record<string, LearnedProfile> } = { at: 0, map: {} };
async function learnedProfile(sig: Signature): Promise<LearnedProfile | null> {
  if (Date.now() - learnedCache.at > LEARNED_TTL_MS) {
    try {
      const [row] = await db.select().from(config).where(eq(config.key, "signature_profiles"));
      learnedCache = { at: Date.now(), map: (row?.value as Record<string, LearnedProfile> | undefined) ?? {} };
    } catch {
      learnedCache = { at: Date.now(), map: learnedCache.map };
    }
  }
  return learnedCache.map[sig] ?? null;
}

export function trailWidthPct(
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
  // Token age in minutes — the rug-vs-climber discriminator. Rugs peak at a
  // median 4.9min; climbers and moons at ~10min.
  tokenAgeMin: number | null = null,
): number {
  // ── ZONE BY TIME AND NEW HIGHS, NOT BY MULTIPLE ──────────────────────────
  // Measured pre-peak dip (the drawdown a token SURVIVES on its way up), across
  // 4,154 labelled tokens: RUG 0.9% · DUD 5.2% · RISER 7.5% · CLIMBER 22.3% ·
  // MOON 35.2% (medians). Dipping is the WINNER signature — rugs go straight up
  // and then the LP is pulled. The old zones keyed off entry-relative multiple
  // and clamped to a 5% leash the moment drawdown passed 8%, which made holding
  // a moon (35% median dip) arithmetically impossible: we survived only the two
  // classes that don't dip, rugs and duds.
  //
  // The move is over when it STOPS MAKING HIGHS, not when it dips. So:
  //   inside the rug window, or stalled  → tight
  //   established and still printing highs → room to breathe
  const stalled = call != null && call.ticksSinceNewHigh >= cfg.TRAIL_STALL_TICKS;
  const established = (tokenAgeMin ?? 0) >= cfg.TRAIL_RUG_WINDOW_MIN;
  let w: number;
  if (stalled || !established) {
    w = cfg.TRAIL_TIGHT_PCT;
  } else {
    w = peakMult >= RUNNER_MULT ? cfg.TRAIL_WIDE_PCT : cfg.TRAIL_MID_PCT;
  }
  // ── RUNNER RATCHET ────────────────────────────────────────────────────────
  // Above the top rung the position is pure upside, and the goal is to let it
  // run to a 20x or a 100x while a RISING floor follows it up. The floor already
  // ratchets — it is peak × (1 − w), and peak only ever increases — so what
  // matters here is how w scales with the size of the move.
  //
  // A fixed width is wrong at both ends. At 3x, 40% of give-back is the normal
  // breathing of a token still developing, and cutting tighter shakes us out of
  // the moves that become 20x. At 30x, that same 40% hands back twelve multiples
  // of realised gain to catch a top we have no evidence of reaching — Pumpman
  // peaked 27.63x and only kept it because a basket harvest happened to fire.
  //
  // So the width TIGHTENS as the multiple climbs: the trade keeps room to breathe
  // while it is young, and the floor closes in as the gain becomes worth
  // defending. The runner still runs; the floor just stops giving back a fortune.
  // ── PRE-LADDER TIGHTENING ─────────────────────────────────────────────────
  // The band the ratchet never covered. A 45% class trail on a position peaking
  // 1.98× puts the floor at 1.09× — the price drifts at ~1.34× and never
  // touches it, so the trail cannot fire and the clock sells the position at
  // market instead. These trades WALK rather than gap (verified: the last six
  // ticks before a runner_timeout sit flat within 1%), which is exactly the
  // population a reachable floor converts. min() only ever tightens, so a class
  // already trailing inside this width (CLIMBER 25%) is untouched.
  //
  // DELIBERATE STEP AT THE BOUNDARY: crossing RUNNER_RATCHET_START widens back
  // to 40%, so the floor briefly sits lower between 3.2× and ~3.84×. That is
  // the ratchet's existing "just past the ladder — full breathing room" intent
  // and it is left alone: a position breaking past the ladder has earned room,
  // and this change is aimed at the trades that never get there.
  if (peakMult >= cfg.RUNNER_RATCHET_PRE_START && peakMult < cfg.RUNNER_RATCHET_START) {
    w = Math.min(w, cfg.RUNNER_RATCHET_PRE_PCT);
  }
  if (peakMult >= cfg.RUNNER_RATCHET_START) {
    const bands: [number, number][] = [
      [cfg.RUNNER_RATCHET_START, cfg.RUNNER_RATCHET_WIDE_PCT], // just past the ladder — full breathing room
      [8, cfg.RUNNER_RATCHET_MID_PCT], // a proven runner — start defending
      [20, cfg.RUNNER_RATCHET_TIGHT_PCT], // a rare, large gain — defend it hard
    ];
    let ratchet = cfg.RUNNER_RATCHET_WIDE_PCT;
    for (const [mult, pct] of bands) if (peakMult >= mult) ratchet = pct;
    w = Math.min(w, ratchet);
  }
  if (banked) w = Math.max(w, cfg.POST_BANK_TRAIL_PCT);
  // TRAIL WIDEN (operator-ratified 2026-07-27, trail harness): 42 of 59 armed
  // profit_trail exits recovered ≥10% within 15m of our exit — kept upside
  // +$238.53 vs extra giveback −$8.71 at +10pp. Armed positions (the rung is
  // already banked; the floor still can't go red) get the extra room to let
  // winners finish working. Env TRAIL_WIDEN_PP=0 disables.
  if (cfg.TRAIL_WIDEN_PP > 0 && peakMult >= cfg.PROFIT_LOCK_ARM_MULT) w += cfg.TRAIL_WIDEN_PP;
  if (call?.action === "RIDE" && peakMult >= RIDE_MIN_MULT && drawdownPct < SNUG_DD) {
    w += cfg.TRAIL_RIDE_BONUS_PCT; // earned: a real runner still printing highs
  } else if (stalled || call?.regime === "BLOWOFF" || call?.action === "TRIM") {
    // Snug ONLY on a move that has actually ended — never merely because price
    // dipped. Drawdown was removed from this condition deliberately; it was the
    // single line that ejected every climber and moon.
    w = Math.min(w, banked ? cfg.POST_BANK_TRAIL_PCT : cfg.TRAIL_TIGHT_PCT);
  }
  return w;
}

// GAIN-BASED trail floor (bracketed): lock (1−giveback) of the gain in each zone
// slice. Monotonic in peak by construction — every slice only adds as the peak
// rises, so the floor never drops at a zone boundary (no wick-out on the seam).
// Locks far more of a small winner's rise than a %-of-price trail while still
// giving a parabolic runner room. Result is a PRICE floor, same units as the
// legacy trail, so the caller's ratchet/stop math is unchanged.
export function gainTrailFloor(cfg: HermesConfig, entry: number, peak: number): number {
  const mult = entry > 0 ? peak / entry : 1;
  if (mult <= 1) return entry;
  const spike = Math.min(mult - 1, RUNNER_MULT - 1); // 1 .. 2.5
  const runner = Math.max(0, Math.min(mult, PARABOLIC_MULT) - RUNNER_MULT); // 2.5 .. 6
  const para = Math.max(0, mult - PARABOLIC_MULT); // 6+
  const lockMult =
    1 +
    (1 - cfg.TRAIL_GAIN_GB_TIGHT) * spike +
    (1 - cfg.TRAIL_GAIN_GB_MID) * runner +
    (1 - cfg.TRAIL_GAIN_GB_WIDE) * para;
  return entry * lockMult;
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
  const ageSec = (Date.now() - position.openedAt.getTime()) / 1000;
  const ageHours = ageSec / 3600;
  const peakMult = entry > 0 ? peak / entry : 1;
  const peakProfitUsd = n(position.sizeUsd) * (peakMult - 1);

  // ── DEPTH-COLLAPSE CUT (F5 as a rail, 2026-07-24) ─────────────────────────
  // Pools die by DEPTH first; price teleports later. The unsellable forensics:
  // $12-27k entry pools drained to dust in ~90s while price still quoted
  // 0.94-1.23× — every price-based exit below fired minutes after the last
  // sellable tick. Below the absolute depth floor, sell everything into
  // whatever liquidity remains, ahead of every other consideration.
  if (
    cfg.DEPTH_COLLAPSE_USD > 0 &&
    market.liquidityUsd != null &&
    Number.isFinite(market.liquidityUsd) &&
    market.liquidityUsd < cfg.DEPTH_COLLAPSE_USD &&
    price > 0
  ) {
    return { reason: "depth_collapse_cut", fraction: 1 };
  }

  // ── RUNNER CLOSE — the model's final leg ──────────────────────────────────
  // After the TP ladder, 20% rides until it stalls or hits this cap. A memecoin
  // decides itself inside the first fifteen minutes; holding a runner past ~1000s
  // is exposure without a thesis. The stall exit fires earlier when the position
  // stops making highs — this only catches one that keeps drifting sideways.
  if (cfg.RUNNER_MAX_HOLD_SEC > 0 && ageSec >= cfg.RUNNER_MAX_HOLD_SEC) {
    return { reason: "runner_timeout", fraction: 1 };
  }

  // ── TIME-BASED FLOOR ──────────────────────────────────────────────────────
  // The operator's model: once a trade has been held ~90s (≈3.5min of watch time
  // after a 2-2.5min entry), a floor goes UNDER IT regardless of how far it has
  // moved. The price-triggered profit lock only arms at +3%, so a position that
  // drifts sideways at 1.01× has no floor and can still round-trip into a loss.
  // This closes that: after the trade has had its chance, we exit at breakeven
  // or better rather than give it back. It never touches a runner — a position
  // above the floor is governed by the trail, which is strictly higher once the
  // move is real.
  if (
    cfg.TIME_FLOOR_AT_SEC > 0 &&
    ageSec >= cfg.TIME_FLOOR_AT_SEC &&
    entry > 0 &&
    price / entry <= cfg.TIME_FLOOR_MULT
  ) {
    return { reason: "time_floor", fraction: 1 };
  }

  // ── FAST SCRATCH — the dud solution ──────────────────────────────────────
  // Duds are NOT separable at entry: across 414 closed trades every entry-time
  // feature (trigger multiple, pool growth, buy share, rug prob, conviction,
  // fill lag) is statistically identical between duds and movers. But they
  // separate violently the moment we own them —
  //     mark at 30s:  DUD 0.938×   MOVER 1.104×
  //     mark at 60s:  DUD 0.967×   MOVER 1.155×
  //     mark at 95s:  DUD 0.968×   MOVER 1.234×
  // A dud declares itself in half a minute and then flatlines around 0.97; we
  // nonetheless rode it to the −7% hard stop or a rug, which is why the dud band
  // averages −13.7% having never fallen more than ~6%. 167 duds cost −$162.94
  // over 12h — the single largest loss pool in the book, in BOTH lanes.
  // So: if a position has not established by the checkpoint, scratch it at the
  // small loss instead of paying full price to learn what we already know.
  // Deliberately narrow — it only fires on a position that has never printed a
  // green tick (peak below the arm floor), so a mover that dips is never cut.
  if (
    cfg.FAST_SCRATCH_ENABLED &&
    ageSec >= cfg.FAST_SCRATCH_AT_SEC &&
    peakMult < cfg.FAST_SCRATCH_MAX_PEAK &&
    entry > 0 &&
    price / entry < cfg.FAST_SCRATCH_MIN_MULT
  ) {
    return { reason: "fast_scratch", fraction: 1 };
  }

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
    // COST-RECOUP ladder (2026-07-20): 87% @TP0 recoups the full cost basis so
    // the runner is house money, 90% @TP1, 95% @TP2 — the cliff can only cost
    // unrealized profit, never principal, while the tail stays open (nice 7.61x
    // was fully dumped at 1.22x under the old 100%-out shape).
    const farm = isFarmDump(cfg, market);
    const tp0Cum = farm ? cfg.FARM_TP0_CUM_SELL : cfg.TP0_CUM_SELL;
    const tp1Cum = farm ? cfg.FARM_TP1_CUM_SELL : cfg.TP1_CUM_SELL;
    const tp2Cum = farm ? cfg.FARM_TP2_CUM_SELL : cfg.TP2_CUM_SELL;
    let targetSold = 0;
    let tpReason = "";
    // PEAK-TRIGGERED RUNGS (operator 2026-07-25 "fix the failures asap"):
    // the base ladder was mark-gated at poll time, so a spike through a rung
    // between 2s polls banked NOTHING — since the 5% pin, all four rungless
    // hard-stops peaked ≥1.22× and died full-ticket. Same mechanism as the
    // ratified micro-TP fix: the PEAK crosses the rung, the fill guard
    // (mark ≥ 0.7× rung) prices the bank at what's actually still there.
    const rungHit = (rung: number) => peakMult >= rung && mark >= rung * cfg.MOON_RUNNER_RATCHET;
    if (rungHit(cfg.TP2_MULT)) {
      targetSold = tp2Cum;
      tpReason = "take_profit_2";
    } else if (rungHit(cfg.TP1_MULT)) {
      targetSold = tp1Cum;
      tpReason = "take_profit_1";
    } else if (rungHit(cfg.TP0_MULT)) {
      // First tranche into the blow-off top. Organic tape banks 40% here and rides
      // the ~60% runner for winners' tail; FARM tape dumps 100% (tp0Cum=1.0) — the
      // escalator's "runner" is bait that rugs to $0, so first level = full exit.
      targetSold = tp0Cum;
      tpReason = "take_profit_0";
    }
    // MICRO-TP MILESTONES (ratified 2026-07-25, operator: "Micro TP all the
    // way up... from 2.5 and up"): above the ladder the position banks 5% of
    // the original at each milestone crossed {2.5, 3, 5, 8, 13, 21, 34, 55},
    // capped at 95% cumulative so a final tranche always rides the ratchet.
    // Harness (992 positions, liquidity-aware): +$39.72/10d vs the pure
    // ratchet with rug give-back IDENTICAL — banks the flight on the way up
    // without amputating the tail. RISER keeps its own trail programme.
    // SPEED FIX (2026-07-25, operator: "did we increase our speed to capture
    // Micro TPs?"): milestones are now crossed by the PEAK — the mechanism the
    // harness actually priced — so a spike through 2.5× between polls still
    // banks on the next tick. The fill guard is the ratchet's own tolerance:
    // a crossed milestone only banks while price holds ≥0.7× of it (below
    // that, the milestone ratchet exit owns the position anyway). Coverage
    // was 3 of 9 eligible under the old current-mark gate.
    if (position.signature !== "RISER" && peakMult >= 2.5) {
      const MICRO_MS = [2.5, 3, 5, 8, 13, 21, 34, 55];
      const crossed = MICRO_MS.filter((m) => peakMult >= m && mark >= m * cfg.MOON_RUNNER_RATCHET).length;
      const microTarget = Math.min(0.95, tp2Cum + 0.05 * crossed);
      if (microTarget > targetSold) {
        targetSold = microTarget;
        tpReason = "take_profit_micro";
      }
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
    // 'gain' locks a consistent fraction of the RISE (bracketed, monotonic — the
    // smooth-scaling trail); 'price' is the legacy %-below-peak. Both floored by
    // the never-red profit lock. Trail uses the entry-relative peak for the price
    // math; provenMult only picks the price-mode zone width.
    const trailFloor =
      cfg.TRAIL_MODE === "gain"
        ? gainTrailFloor(cfg, entry, peak)
        : peak * (1 - trailWidthPct(cfg, provenMult, drawdownPct, call, bankedRunner, market.pairAgeMinutes ?? null) / 100);
    // GAIN LOCK — the floor keeps a share of the move, not just breakeven.
    // A flat entry-relative floor lets a trade climb and still exit flat: at
    // 1.02 the binding stop stays 1.02 until peak×(1−w) overtakes it at 1.42×,
    // so the whole 1.20–1.42 band scratches out at zero and books a loss after
    // slippage. That is the same defect as arming at 1.03, moved up the chart.
    // Replayed over the real tapes of 30 scratched trades: floor 1.02 −$23.14,
    // lock 50% +$10.18, lock 65% +$16.50, lock 85% +$8.92 — every gain-locking
    // variant positive, every breakeven variant negative.
    const gainLock = entry * (1 + (peakMult - 1) * cfg.PROFIT_LOCK_GAIN_LOCK);
    // ── MOON RUNNER (ratified 2026-07-24, moon-ride harness +$1,248/9d) ──────
    // Once a rung has BANKED, the remainder is house money and the tight
    // percentage trail is what amputated every tail (the wave debrief: exits at
    // 1.3-1.8× on moves that ran 4.85-43× past them). The banked runner rides
    // a MULTIPLE-RATCHET leash instead: floor = 0.7 × the highest milestone
    // crossed. Below the first milestone the profit-lock floor is the only
    // leash — priced by the harness, rug give-back −$141 vs +$1,386 of tail.
    // Stale-take above stays live: it is the only defense that cashes against
    // pool-teleport rugs, and a tape still printing highs never triggers it.
    // RISER EXCLUDED (ratified 2026-07-24, per-class harness cut): its shape is
    // the fast single-leg spike and its tight trail + RIDE bonus beat the
    // ratchet on qualified flow (booked $113.60 vs $104.43, CODE $31.80 vs
    // $15.78) — confirmed live by HOLLY's first moon_ratchet close at 9%
    // capture vs the 49% class average. RISER keeps its championship trail.
    if (cfg.MOON_RUNNER_ENABLED && bankedRunner && position.signature !== "RISER") {
      const MILESTONES = [1.5, 2, 3, 5, 8, 13, 21, 34, 55];
      let msFloor = 0;
      for (const ms of MILESTONES) if (peakMult >= ms) msFloor = ms * cfg.MOON_RUNNER_RATCHET;
      // MOON FLOOR REMOVAL (ratified 2026-07-25): for MOON-class banked
      // runners the 1.02 profit-lock floor was the capture killer — moons
      // breathe 35% mid-flight and every breath tripped it at breakeven,
      // forfeiting the bounce. Same-universe replay on 49 routed moons:
      // booked $2.84 WITH the floor vs $89.96 riding the pure milestone
      // leash. The rung already banked the insurance; below the first
      // milestone the moon runner now has NO price floor — the ride ends at
      // the ratchet, stale-take (dead tape), the depth rail, or the clock.
      // Non-MOON classes keep the 1.02 floor; RISER keeps its trail.
      const isMoonClass = typeof position.signature === "string" && position.signature.startsWith("MOON");
      const stop = isMoonClass ? entry * msFloor : Math.max(entry * cfg.PROFIT_LOCK_FLOOR_MULT, entry * msFloor);
      if (stop > 0 && price <= stop) return { reason: msFloor > 0 ? "moon_ratchet" : "profit_trail", fraction: 1 };
    } else {
      const stop = Math.max(entry * cfg.PROFIT_LOCK_FLOOR_MULT, gainLock, trailFloor);
      if (price <= stop) return { reason: "profit_trail", fraction: 1 };
    }
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
    // INTERIM NEVER-ARMED STOP (operator, 2026-07-23 — "the replay confirms
    // tonight"): past the grace window, a position that never reached the arm
    // bar and sits ≥25% under entry is a slow bleeder wearing a deep class
    // stop (COW rode to 0.59× before the clock cut it). Cut it at bounded
    // cost; a trade that ever armed is handled by the trail above, never here.
    if (
      cfg.NEVER_ARM_STOP_ENABLED &&
      peakMult < cfg.NEVER_ARM_BAR &&
      ageHours * 60 >= cfg.NEVER_ARM_STOP_MIN &&
      price <= entry * (1 - cfg.NEVER_ARM_STOP_PCT / 100)
    )
      return { reason: "never_armed_stop", fraction: 1 };
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

  const [sellFill] = await db.insert(fills).values({
    positionId: position.id,
    side: "sell",
    qtyTokens: String(qtySold),
    priceUsd: String(exitPrice),
    slippagePct: String(slip),
    feeUsd: String(feeUsd),
    reason, // per-fill truth: WHICH rung/exit produced this fill
  }).returning({ id: fills.id });
  if (sellFill) void journalFill({ fillId: sellFill.id, book: "paper", side: "sell", filledAt: new Date(),
    positionId: position.id, mint: position.mint, qty: qtySold, priceUsd: exitPrice, feeUsd,
    entryPriceUsd: n(position.entryPriceUsd), reason });

  const newRealized = n(position.realizedPnlUsd) + pnl;
  // Selling AT a price is proof the position reached it — bump the peak so exit
  // paths that bypass the per-position peak-tracker (basket_harvest sweeps the
  // whole green book at once) still record the true high-water mark. Display
  // honesty only: realized P&L is unaffected, but a 53.9× close no longer reads
  // back as peak 1.0× on the scorecard.
  const newPeak = Math.max(n(position.peakPriceUsd), market.priceUsd);
  await db
    .update(positions)
    .set({
      qtyRemaining: String(Math.max(remaining, 0)),
      realizedPnlUsd: String(newRealized),
      peakPriceUsd: String(newPeak),
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

// ── AUTO-HARVEST (ratified 2026-07-25, golden study) ──────────────────────────
// The golden days' profit engine was the basket harvest: +$2,073.96 across 57
// sweep exits Jul 16-18 — sweeping accumulated green float into strength en
// masse. The current fast per-position exits starved the float (48h sim: zero
// windows with ≥4 concurrent greens), so this trigger ships ARMED BUT DORMANT:
// it reuses the certified harvest_now → basket sweep path and wakes the moment
// boarding volume rebuilds the float. Audited on every fire; 15m cooldown.
let lastAutoHarvestMs = 0;
export async function checkAutoHarvest(cfg: HermesConfig): Promise<void> {
  if (!cfg.AUTO_HARVEST_ENABLED) return;
  if (Date.now() - lastAutoHarvestMs < cfg.AUTO_HARVEST_COOLDOWN_MIN * 60_000) return;
  const greens = (await db.execute(sql`
    SELECT p.id, p.size_usd::float AS s, pt.mark_multiple::float AS mm
    FROM positions p
    CROSS JOIN LATERAL (
      SELECT mark_multiple FROM position_ticks WHERE position_id = p.id
      ORDER BY snapped_at DESC LIMIT 1) pt
    WHERE p.lane = 'paper' AND p.status = 'open' AND pt.mark_multiple::float >= 1.08`)) as unknown as {
    id: number; s: number; mm: number;
  }[];
  const unrealized = greens.reduce((t, g) => t + (Number(g.mm) - 1) * Number(g.s), 0);
  if (greens.length >= cfg.AUTO_HARVEST_MIN_GREEN && unrealized >= cfg.AUTO_HARVEST_MIN_USD) {
    lastAutoHarvestMs = Date.now();
    await db
      .insert(config)
      .values({ key: "harvest_now", value: { enabled: true }, updatedAt: new Date() })
      .onConflictDoUpdate({ target: config.key, set: { value: { enabled: true }, updatedAt: new Date() } });
    await audit("auto_harvest_triggered", {
      greens: greens.length,
      unrealizedUsd: Number(unrealized.toFixed(2)),
      reason: `float rebuilt: ${greens.length} green ≥1.08× carrying $${unrealized.toFixed(2)} — sweeping into strength (golden-study engine)`,
    });
    console.log(`🧺 AUTO-HARVEST — ${greens.length} greens, $${unrealized.toFixed(2)} unrealized → sweep requested`);
  }
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
// Consecutive sub-threshold DEPTH reads per position — the depth-collapse cut's
// wick confirmation (2026-07-25). The drain-onset forensic: 17 of 19 live
// insta-cuts fired 6-15s after entry into pools that were GROWING (slopes
// 107-142%) — and several cuts closed GREEN, which is impossible against a
// genuinely drained pool. The cuts were firing on single pool-flip/index-lag
// thin reads (the trusted-read class). A REAL drain persists across polls; a
// flip read does not. Same discipline as the pre-arm hard stop's wick confirm.
const depthConfirmCounts = new Map<number, number>();
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

// HOT-TICKER state — the auto-farm blacklist's MIRROR: symbol families that
// printed ≥HOT_TICKER_MIN_WINNERS winners in the rolling window (and aren't
// rug-dominated) run HOT — same-family confirms get a size boost + queue
// priority while the family is printing, and decay out with the window.
// Validated leak-free: prior-6h family winners ⇒ 19.6% vs 13.0% base win rate.
const hotTickers = { families: new Set<string>(), refreshedAt: 0 };
const tickerFamily = (symbol: string | null | undefined): string =>
  (symbol ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

async function refreshHotTickers(cfg: HermesConfig): Promise<void> {
  if (!cfg.HOT_TICKER_ENABLED) return;
  if (Date.now() - hotTickers.refreshedAt < cfg.HOT_TICKER_REFRESH_MS) return;
  hotTickers.refreshedAt = Date.now();
  try {
    const rows = await db.execute(sql`
      SELECT lower(regexp_replace(t.symbol, '[^a-zA-Z0-9]', '', 'g')) AS fam,
        count(*)::int AS n,
        count(*) FILTER (WHERE co.label='winner')::int AS wins,
        count(*) FILTER (WHERE co.label='rug')::int AS rugs
      FROM candidate_outcomes co JOIN tokens t ON t.mint = co.mint
      WHERE co.label IN ('winner','dud','rug')
        AND co.first_seen_at >= now() - make_interval(mins => ${cfg.HOT_TICKER_WINDOW_MIN})
        AND t.symbol IS NOT NULL AND length(t.symbol) > 1
      GROUP BY 1
    `);
    const fams = new Set<string>();
    for (const r of rows as unknown as Array<Record<string, unknown>>) {
      const n = Number(r.n) || 0;
      const wins = Number(r.wins) || 0;
      const rugs = Number(r.rugs) || 0;
      if (wins >= cfg.HOT_TICKER_MIN_WINNERS && n > 0 && rugs / n < cfg.HOT_TICKER_MAX_RUG_SHARE)
        fams.add(String(r.fam));
    }
    const changed =
      fams.size !== hotTickers.families.size || [...fams].some((f) => !hotTickers.families.has(f));
    hotTickers.families = fams;
    if (changed) {
      await audit("hot_ticker_update", { families: [...fams] });
      console.log(
        `🔥 HOT TICKERS refreshed — [${[...fams].join(", ") || "none"}] (≥${cfg.HOT_TICKER_MIN_WINNERS} family winners / ${cfg.HOT_TICKER_WINDOW_MIN}m, rug share < ${Math.round(cfg.HOT_TICKER_MAX_RUG_SHARE * 100)}%)`,
      );
    }
  } catch (err) {
    console.error(`hot-ticker refresh failed: ${err instanceof Error ? err.message : err}`);
  }
}

/** Hot-family check for a confirm: boosted only if the family is hot AND not farm-blacklisted. */
function isHotTicker(cfg: HermesConfig, symbol: string | null | undefined): boolean {
  if (!cfg.HOT_TICKER_ENABLED) return false;
  const fam = tickerFamily(symbol);
  if (!fam || !hotTickers.families.has(fam)) return false;
  return !autoFarm.symbols.has((symbol ?? "").toLowerCase());
}

// canonicalVenue now lives in @hermes/core (market/venue.ts) so the recorder's
// rug model and the trader resolve venues identically — see its doc for the
// dex-string-leak history (meteora+DYN2 → meteora-damm-v2).

// ── DYNAMIC PRIME SET — the Pond Radar's output, consumed live ───────────────
// The recorder's pond scanner walks venues through observed→watchlist→promoted
// on rolling 24h evidence; the trader's prime set (queue priority + conviction
// size boost) = static PRIME_VENUES ∪ currently-promoted. A cooling pond loses
// its boost automatically — allocation tracks the live pond map, which is the
// working answer to the 30-day edge half-life.
// ── HOUR-DRIVEN THROTTLE — the measured daily clock, made executive ─────────
// The recorder's hour-policy scan classifies each ET hour-of-day by its OWN
// realized economics (≥HOUR_POLICY_MIN_TRADES closes): prime → full size,
// probe → OFF_HOURS_SIZE_MULT, unmeasured → the static PRIME_HOURS_UTC
// declaration decides (exactly the old behavior). First reading: 6am ET
// banked +$169 at half stakes while declared-prime hours ran red — hours are
// now sized by what they earn, not by what we assumed.
const hourPolicy = { hours: {} as Record<string, string>, refreshedAt: 0 };
async function hourSessionMult(cfg: HermesConfig): Promise<number> {
  if (cfg.HOUR_POLICY_ENABLED && Date.now() - hourPolicy.refreshedAt > 120_000) {
    hourPolicy.refreshedAt = Date.now();
    try {
      const rows = (await db.execute(sql`select value from config where key = 'hour_policy'`)) as unknown as {
        value: { hours?: Record<string, string> };
      }[];
      hourPolicy.hours = rows[0]?.value?.hours ?? {};
    } catch {
      /* keep last-known policy on a read hiccup */
    }
  }
  // Policy is keyed by ET hour-of-day (the operator's clock).
  const etHour = Number(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: "America/New_York" }).format(new Date()),
  ) % 24;
  const cls = cfg.HOUR_POLICY_ENABLED ? hourPolicy.hours[String(etHour)] : undefined;
  if (cls === "prime") return 1;
  if (cls === "probe") return cfg.OFF_HOURS_SIZE_MULT;
  // unmeasured (or policy disabled/missing) → the static declaration decides
  return cfg.PRIME_HOURS_UTC.has(new Date().getUTCHours()) ? 1 : cfg.OFF_HOURS_SIZE_MULT;
}

const promotedVenues = { set: new Set<string>(), refreshedAt: 0 };
const PROMOTED_REFRESH_MS = 120_000;
async function primeVenueSet(cfg: HermesConfig): Promise<Set<string>> {
  if (Date.now() - promotedVenues.refreshedAt > PROMOTED_REFRESH_MS) {
    promotedVenues.refreshedAt = Date.now();
    try {
      const rows = (await db.execute(sql`select venue from venue_intel where state = 'promoted'`)) as unknown as {
        venue: string;
      }[];
      promotedVenues.set = new Set(rows.map((r) => r.venue.toLowerCase()));
    } catch {
      /* keep the last-known set on a read hiccup */
    }
  }
  const merged = new Set(cfg.PRIME_VENUES);
  for (const v of promotedVenues.set) merged.add(v);
  return merged;
}

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
  const [woFill] = await db.insert(fills).values({
    positionId: position.id,
    side: "sell",
    qtyTokens: position.qtyRemaining,
    priceUsd: "0",
    feeUsd: "0",
  }).returning({ id: fills.id });
  if (woFill) void journalFill({ fillId: woFill.id, book: "paper", side: "sell", filledAt: new Date(),
    positionId: position.id, mint: position.mint, qty: n(position.qtyRemaining), priceUsd: 0, feeUsd: 0,
    entryPriceUsd: n(position.entryPriceUsd), reason });
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

// FAST-FLOOR (config FAST_FLOOR_*) — sub-polled between the 5s manage cycles. Enforces the
// trailing floor on LIFTED positions at block-level Jupiter resolution so a rollover is caught
// NEAR the floor instead of gapping through it (the SX runner / 1.10 give-back). READ-ONLY on
// peak (never ratchets from the fast mark — that's the thin-pool mirage); divergence-guarded vs
// the last DexScreener read; last-good liquidity for an honest paper fill. Serial with the manage
// loop (same single loop), so no double-sell race; the flag guards overlapping fast sweeps.
let fastFlooring = false;
const floorLogged = new Set<number>(); // log-only dedup: armed would sell ONCE; don't re-log the same position every 1s
export async function fastFloorSweep(cfg: HermesConfig): Promise<void> {
  if (!cfg.FAST_FLOOR_ENABLED || fastFlooring) return;
  fastFlooring = true;
  try {
    const lifted = await db
      .select()
      .from(positions)
      .where(
        and(
          eq(positions.lane, "paper"),
          eq(positions.status, "open"),
          // A signature-routed position is governed ONLY by its own genome. This
          // sweep runs outside the per-position config merge, so the exclusion
          // has to happen in the query — otherwise the class's cover and trail
          // would be silently undercut by a global floor the learning loop never
          // simulated. Legacy positions (no signature) keep the sweep.
          sql`${positions.signature} is null`,
          sql`${positions.peakPriceUsd}::numeric >= ${positions.entryPriceUsd}::numeric * ${cfg.FAST_FLOOR_ARM_MULT}`,
        ),
      );
    if (lifted.length === 0) { floorLogged.clear(); return; }
    // prune the log-only dedup set to currently-lifted positions (bounded, and lets a re-entry re-log)
    const liftedIds = new Set(lifted.map((p) => p.id));
    for (const id of floorLogged) if (!liftedIds.has(id)) floorLogged.delete(id);
    // last-good DexScreener price + liquidity per position (divergence guard + honest fill)
    const idList = sql.join(lifted.map((p) => sql`${p.id}`), sql`, `);
    const lastRows = (await db.execute(sql`
      select distinct on (position_id) position_id, price_usd::float px, liquidity_usd::float liq
      from position_ticks where position_id in (${idList}) order by position_id, snapped_at desc
    `)) as unknown as { position_id: number; px: number; liq: number }[];
    const last = new Map(lastRows.map((r) => [Number(r.position_id), r]));
    const jup = await fetchJupiterPrices(cfg.JUPITER_PRICE_URL, lifted.map((p) => p.mint));
    for (const p of lifted) {
      const px = jup.get(p.mint);
      if (px == null || px <= 0) continue; // no Jupiter route (bonding-curve) → the 5s loop owns it
      const entry = n(p.entryPriceUsd), peak = n(p.peakPriceUsd);
      if (entry <= 0 || peak <= 0) continue;
      const lg = last.get(p.id);
      // divergence guard — never fire on a disputed price (SX read 2.8x on one feed vs 611x on the other)
      if (lg && lg.px > 0 && Math.max(px, lg.px) / Math.min(px, lg.px) > cfg.MARK_FEED_DIVERGENCE) continue;
      // Floor never sits below the profit lock. With the arm at 1.05 entry-rel,
      // a raw 8% trail off a 1.05 peak would put the floor at 0.966 — selling a
      // WINNER at a loss, the exact thing this mechanism exists to prevent. The
      // trail governs once the position has run far enough for it to sit above
      // breakeven; below that, the lock line is the floor.
      const floor = Math.max(peak * (1 - cfg.FAST_FLOOR_TRAIL_PCT / 100), entry * cfg.PROFIT_LOCK_FLOOR_MULT);
      if (px > floor) continue;
      const markMult = px / entry;
      if (cfg.FAST_FLOOR_LOG_ONLY) {
        if (floorLogged.has(p.id)) continue; // already logged the first cross — armed would have sold here
        floorLogged.add(p.id);
        console.log(
          `🛰️  FAST-FLOOR ${short(p.mint)} — would bank ${markMult >= 1 ? "+" : ""}${((markMult - 1) * 100).toFixed(1)}% at block-mark (floor ${(floor / entry).toFixed(2)}x, peak ${(peak / entry).toFixed(2)}x) [first cross — armed sells here, 5s loop rides it down]`,
        );
        continue;
      }
      console.log(
        `🛰️  FAST-FLOOR ${short(p.mint)} — banking ${markMult >= 1 ? "+" : ""}${((markMult - 1) * 100).toFixed(1)}% at block-mark (floor ${(floor / entry).toFixed(2)}x, peak ${(peak / entry).toFixed(2)}x)`,
      );
      if (!lg || !(lg.liq > 0)) continue; // no last-good liquidity → fall back to the 5s loop (no frictionless fill)
      // re-check status (belt+suspenders; the single loop is already serial with manage)
      const [fresh] = await db.select().from(positions).where(and(eq(positions.id, p.id), eq(positions.status, "open"))).limit(1);
      if (!fresh) continue;
      const market = { priceUsd: px, liquidityUsd: lg.liq } as TokenMarket;
      await sell(fresh, market, 1, "fast_floor");
      void mirrorLiveSell(cfg, p.mint, 1, "fast_floor");
    }
  } catch (err) {
    console.error(`fast-floor sweep: ${err instanceof Error ? err.message : err}`);
  } finally {
    fastFlooring = false;
  }
}

/** Mark open positions to market and execute the exit rules. */
export async function managePositions(cfg: HermesConfig): Promise<void> {
  await refreshAutoFarm(cfg); // keep the adaptive farm list current (no-op inside refresh window)
  const open = await db.select().from(positions).where(and(eq(positions.status, "open"), eq(positions.lane, "paper")));
  // P1: keep the ws pool watcher subscribed to exactly the open book (both
  // lanes — a live twin shares the paper mint). Fail-open: an empty pool
  // address just means no telemetry for that mint.
  try {
    // P3 (2026-07-26): armed QUALIFIED candidates subscribe too — entries get
    // pulse data BEFORE boarding (slot-aware entry evidence; also P4's pool-
    // creation observation point). Open positions take priority for the subs.
    const pools = (await db.execute(sql`
      SELECT mint, pool_address FROM (
        SELECT DISTINCT p.mint, t.pool_address, 0 AS prio FROM positions p
        JOIN tokens t ON t.mint = p.mint
        WHERE p.status = 'open' AND t.pool_address IS NOT NULL
        UNION ALL
        SELECT c.mint, t.pool_address, 1 AS prio FROM candidate_outcomes c
        JOIN tokens t ON t.mint = c.mint
        WHERE c.triggered_at > now() - interval '10 minutes' AND c.entered = false
          AND (c.stars = 2 OR (c.wallet_winner_hits >= 1 AND c.wallet_winner_hits - coalesce(c.wallet_rug_hits, 0) >= 1))
          AND t.pool_address IS NOT NULL
      ) u ORDER BY prio LIMIT 15`)) as unknown as {
      mint: string;
      pool_address: string;
    }[];
    const wanted = new Map<string, string>();
    for (const r of pools) if (!wanted.has(r.mint)) wanted.set(r.mint, r.pool_address);
    syncSlotWatch(wanted);
  } catch {
    /* telemetry is optional — the poll rail stands alone */
  }
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
      for (const g of green) {
        const hReason = manualHarvest ? "manual_harvest" : "basket_harvest";
        await sell(g.position, g.market, 1, hReason);
        // Direct-mirror the profit engine (129% of paper's P&L) in the SAME cycle
        // instead of leaning on sweepLiveBook's next-cycle backstop. The sweep still
        // covers a failed mirror; a closed live twin is skipped, so no double-sell.
        void mirrorLiveSell(cfg, g.position.mint, 1, hReason);
      }
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

    // TELEMETRY (measurement-only): ratchet the live twin's peak off THIS same
    // mark, so live_peakx is comparable to paper_peakx apples-to-apples (any gap
    // is then real entry-lag, not a price-source artifact). peak_price_usd is
    // write-only on the live path — this changes no live behavior. GREATEST keeps
    // the entry seed until the mark exceeds it. No extra fetch: paper already has
    // the price here; the live manage loop never marks (it mirrors paper).
    if (cfg.LIVE_TRADING_ENABLED) {
      await db
        .update(positions)
        .set({ peakPriceUsd: sql`greatest(${positions.peakPriceUsd}::numeric, ${market.priceUsd}::numeric)` })
        .where(and(eq(positions.lane, "live"), eq(positions.mint, position.mint), eq(positions.status, "open")));
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

    // DUD-TP — the divergence micro-take-profit (config DUD_CUT_*, validated 2026-07-19
    // +$85/48h). A position whose PEAK hasn't cleared DUD_CUT_MARK by DUD_CUT_AGE_MIN never
    // followed through (winners clear the divergence line by ~2.25m; stallers sit flat).
    // But the staller is still LIQUID and typically GREEN (~+6%) at 2.25m — so we BANK the
    // micro-gain before the stall round-trips it. This is a TP, not a loss cut: the cohort
    // nets POSITIVE (−$48 held → +$36 banked). Peak-based, so a proven lifter is NEVER
    // banked here (it rides the ladder); a user "ride" override still wins.
    // Also exempt for routed positions: this is a global time-and-lift rule, and
    // a class whose median run is 1.43-1.56× and whose clock is its OWN (MOON at
    // 4m, CLIMBER at 2.5m) must not be banked out early by a shared 2.25m stall
    // test the learning loop never modelled.
    if (cfg.DUD_CUT_ENABLED && intent !== "ride" && !position.signature) {
      const ageMin = (Date.now() - new Date(position.openedAt).getTime()) / 60_000;
      const peakMult = peak / n(position.entryPriceUsd);
      const markMult = market.priceUsd / n(position.entryPriceUsd);
      if (ageMin >= cfg.DUD_CUT_AGE_MIN && peakMult < cfg.DUD_CUT_MARK) {
        console.log(`💵 DUD-TP ${short(position.mint)} — banking ${markMult >= 1 ? "+" : ""}${((markMult - 1) * 100).toFixed(1)}% micro at ${ageMin.toFixed(1)}m (no lift past ${cfg.DUD_CUT_MARK}x, peak ${peakMult.toFixed(2)}x)`);
        await sell(position, market, 1, "dud_tp");
        void mirrorLiveSell(cfg, position.mint, 1, "dud_tp");
        continue;
      }
    }

    const armed =
      peak >= n(position.entryPriceUsd) * cfg.PROFIT_LOCK_ARM_MULT ||
      n(position.sizeUsd) * (peak / n(position.entryPriceUsd) - 1) >= cfg.PROFIT_FLOOR_USD;

    // 2. Classifier — recycle DEAD losers only (faded/underwater and never got
    //    into profit). A position that has shown green is NEVER cut here: the
    //    ratcheting profit-trail banks it instead, so a runner is never capped.
    //
    //    SIGNATURE-ROUTED POSITIONS ARE EXEMPT. The `armed` guard above keys off
    //    PROFIT_LOCK_ARM_MULT, which the genome disables — so leaving this active
    //    would invert its purpose and make the classifier cut MORE freely on
    //    exactly the classes built to sit through a drawdown (CLIMBER's cover is
    //    0.37×, and its worst London loss exited `classifier_stall` at −$2.06).
    //    The class's own cover and trail decide when a routed trade dies.
    if (cfg.CLASSIFIER_MODE === "active" && call && intent !== "ride" && !position.signature) {
      if (call.action === "CUT" && !armed) {
        await sell(position, market, 1, `classifier_${call.regime.toLowerCase()}`);
        void mirrorLiveSell(cfg, position.mint, 1, "live_mirror_classifier");
        continue;
      }
    }

    // 3. Ratcheting profit-trail (+ pre-profit hard stop). The classifier call
    //    shapes the trail width — RIDE widens the leash, blow-off/stall snugs it
    //    up. A RIDE intent suspends the stop for one tick to hold through a wick.
    // SIGNATURE EXITS — manage the position under its own genome. The cover,
    // trail width, ladder and clock all come from the class it was routed to at
    // entry, not from the global config: a climber's winners dip to 0.37× of
    // entry and give back 34.6% before their real high, while a riser's give
    // back 16% — one trail cannot serve both, and the global 5% served neither.
    // Positions opened before the rollout carry no signature and keep the old
    // behaviour exactly.
    const ecfg = position.signature
      ? { ...cfg, ...signatureExitOverrides(position.signature as Signature, await learnedProfile(position.signature as Signature)) }
      : cfg;
    let exit = decideExit(ecfg, position, market, peak, call);
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
    // DEPTH-CUT READ CONFIRMATION (2026-07-25): a sub-threshold depth read must
    // persist DEPTH_COLLAPSE_CONFIRM_TICKS consecutive polls before the cut
    // sells — one flip read was ejecting live from healthy, growing pools in
    // 6-15s (several "cuts" closed green, impossible against a real drain).
    // A genuine drain persists; the confirm costs one poll (~5s) against it.
    if (exit?.reason === "depth_collapse_cut" && cfg.DEPTH_COLLAPSE_CONFIRM_TICKS > 1) {
      // P1 (2026-07-25): the ws pool watcher is ground truth the aggregator
      // is not. A flip read shows a drain the chain never saw; a REAL drain
      // shows the pool's own SOL falling in the same 30s window. When the
      // watcher corroborates (≥50% of pool lamports gone), the drain TX
      // itself is the second read — cut now, don't donate another poll to
      // the exit window. No pulse / no drop → the poll confirm stands.
      const pulse = poolPulse(position.mint);
      const corroborated = pulse != null && pulse.drop30s >= 0.5;
      const c = (depthConfirmCounts.get(position.id) ?? 0) + 1;
      if (!corroborated && c < cfg.DEPTH_COLLAPSE_CONFIRM_TICKS) {
        depthConfirmCounts.set(position.id, c);
        console.log(
          `🛡️  HOLD  ${short(position.mint)} — depth sub-threshold, read-confirming ${c}/${cfg.DEPTH_COLLAPSE_CONFIRM_TICKS} before cut`,
        );
        exit = null;
      } else {
        if (corroborated && c < cfg.DEPTH_COLLAPSE_CONFIRM_TICKS) {
          console.log(
            `⚡ DRAIN CONFIRMED ${short(position.mint)} — ws pool −${Math.round((pulse?.drop30s ?? 0) * 100)}% in 30s, cutting on the event`,
          );
        }
        depthConfirmCounts.delete(position.id);
      }
    } else {
      depthConfirmCounts.delete(position.id); // any healthy-depth tick resets
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
