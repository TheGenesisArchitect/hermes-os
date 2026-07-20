import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
// repo-root .env — services run with cwd at their own package dir
loadEnv({ path: resolve(import.meta.dirname, "../../../.env") });
import {
  canonicalVenue,
  classify,
  entryTriggerConfigFrom,
  evaluateEntryTrigger,
  fetchTokenMarket,
  fetchTokenMarkets,
  loadConfig,
  scoreConviction,
  scoreRugProb,
  tickFrom,
  type Tick,
} from "@hermes/core";
import {
  auditLog,
  candidateOutcomes,
  candidateTicks,
  config,
  db,
  positions,
  signals,
} from "@hermes/db";
import { asc, desc, eq, gte, sql } from "drizzle-orm";
import { scanPonds } from "./pondScanner.js";
import { refreshWalletReputation, scoreCandidateWalletEdge } from "./walletReputation.js";

const cfg = loadConfig();
const triggerCfg = entryTriggerConfigFrom(cfg);

const num = (v: string | null | undefined): number => (v == null ? 0 : Number(v));
const short = (mint: string) => `${mint.slice(0, 4)}…${mint.slice(-4)}`;

// Transient DexScreener nulls happen; only a sustained disappearance counts as
// a delisting. Track consecutive misses per mint in memory.
const missStreak = new Map<string, number>();
const DELIST_MISSES = 2;

// A brand-new mint often surfaces a $0-liquidity garbage pool before its real
// pool exists; DexScreener flips between them and the price "jumps" by orders of
// magnitude. Anchoring the reference on such a read (and letting it set the
// peak) fabricated a 56,000x "winner". So we only trust a read with real
// liquidity for the baseline and for new highs — deaths are still recorded.
const REF_MIN_LIQ = 1_000;

function rowToTick(r: typeof candidateTicks.$inferSelect): Tick {
  return {
    markMultiple: num(r.markMultiple),
    drawdownFromPeakPct: num(r.drawdownFromPeakPct),
    buyShareM5: r.buyShareM5 == null ? 0.5 : num(r.buyShareM5),
    volM5: num(r.volM5),
    volH1: num(r.volH1),
    priceChangeM5Pct: num(r.priceChangeM5Pct),
    ageMinutes: num(r.ageMinutes),
  };
}

/** Register every recent signal as an open candidate to watch (idempotent). */
async function seedNewCandidates(): Promise<void> {
  const cutoff = new Date(Date.now() - cfg.RECORDER_WINDOW_MIN * 60_000);
  const recent = await db
    .select({ id: signals.id, mint: signals.mint })
    .from(signals)
    .where(gte(signals.createdAt, cutoff));
  for (const s of recent) {
    await db
      .insert(candidateOutcomes)
      .values({
        mint: s.mint,
        signalId: s.id,
        refPriceUsd: "0", // filled on first successful observation
        firstSeenAt: new Date(),
        label: "open",
      })
      .onConflictDoNothing(); // primary key = mint → one watch per token
  }
}

/** Finalize a candidate's label once its window closes (or it delists). */
async function closeOutcome(mint: string, delisted: boolean): Promise<void> {
  const [o] = await db.select().from(candidateOutcomes).where(eq(candidateOutcomes.mint, mint));
  if (!o || o.label !== "open") return;
  const peak = num(o.peakMultiple);
  const finalMult = num(o.finalMultiple);
  const won = peak >= cfg.RECORDER_WIN_MULT;
  const [pos] = await db
    .select({ id: positions.id })
    .from(positions)
    .where(eq(positions.mint, mint))
    .limit(1);
  const entered = !!pos;
  // Liquidity-collapse override (the ragoon lesson, 2026-07-19): an LP yank can
  // leave the pool at ~$15 with the DexScreener price still pinned green. The
  // mark-freeze guard (correct — a drained pool cannot pump) then holds
  // finalMult at last-good, so the corpse graded "dud at 1.25x" — 1,830 of
  // 7,367 duds (25%) were rugs wearing that coat. A window that ENDS with the
  // pool drained (last 3 reads < REF_MIN_LIQ) after having had a real pool is a
  // rug no matter what the frozen mark says. Three reads, not one, so a single
  // pool-flip flicker at close can't mislabel a live token.
  const lastTicks = await db
    .select({ liquidityUsd: candidateTicks.liquidityUsd })
    .from(candidateTicks)
    .where(eq(candidateTicks.mint, mint))
    .orderBy(desc(candidateTicks.snappedAt))
    .limit(3);
  const liqCollapsed =
    lastTicks.length > 0 &&
    lastTicks.every((r) => num(r.liquidityUsd) < REF_MIN_LIQ) &&
    num(o.peakLiquidityUsd) >= REF_MIN_LIQ;
  // Label by TERMINAL OUTCOME, not by peak — raw magnitudes are stored, so this is
  // re-derivable. The old `delisted && peak < 1.2` rule labeled a rug only if it
  // never pumped, so every pump-then-rug (peak 1.35x → final 0.001x, the -$17
  // killers) fell through to "dud" — 726 real rugs hid in the dud class and the
  // classifier could learn nothing about them. Now: winner takes precedence (a 2x+
  // move existed → the TP ladder banks it before any rug), else a terminal collapse
  // to <= RUG_FINAL (or a delisting, or a drained pool) is a rug, else a dud. This
  // CASE matches the 2026-07-14 and 2026-07-19 SQL backfills that relabeled all
  // history — keep them in lockstep.
  let label: string;
  if (won) label = "winner";
  else if (
    delisted ||
    liqCollapsed ||
    (o.ticks > 0 && finalMult > 0 && finalMult <= cfg.RECORDER_RUG_FINAL_MULT)
  )
    label = "rug";
  else label = "dud";

  await db
    .update(candidateOutcomes)
    .set({
      label,
      won,
      delisted,
      entered,
      armed: false, // window closed — no longer a live entry candidate
      windowClosedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(candidateOutcomes.mint, mint));

  await db.insert(auditLog).values({
    actor: "recorder",
    action: "candidate_labeled",
    details: { mint, label, peakMultiple: peak, finalMultiple: num(o.finalMultiple), entered, delisted, liqCollapsed },
  });
  missStreak.delete(mint);
  const tag = label === "winner" ? "🏆" : label === "rug" ? "☠️ " : "· ";
  console.log(
    `${tag} ${short(mint)} closed: ${label} — peak ${peak.toFixed(2)}x, final ${num(o.finalMultiple).toFixed(2)}x, ${o.ticks} ticks${entered ? " (entered)" : ""}`,
  );
}

/** One observation of a single open candidate (market read supplied by the batched caller). */
async function observe(
  o: typeof candidateOutcomes.$inferSelect,
  market: Awaited<ReturnType<typeof fetchTokenMarket>> | null,
): Promise<void> {
  const watchMin = (Date.now() - o.firstSeenAt.getTime()) / 60_000;

  if (!market) {
    const priorRef = num(o.refPriceUsd);
    if (priorRef > 0) {
      const streak = (missStreak.get(o.mint) ?? 0) + 1;
      missStreak.set(o.mint, streak);
      if (streak >= DELIST_MISSES) {
        await closeOutcome(o.mint, true); // sustained disappearance = delisted
        return;
      }
    }
    // no data yet (or a transient blip) — close as dud only if the window is up
    if (watchMin >= cfg.RECORDER_WINDOW_MIN) await closeOutcome(o.mint, priorRef === 0);
    return;
  }
  missStreak.delete(o.mint);

  // Reference price = first REAL-liquidity observation ("if we'd entered at
  // signal"). Never anchor on a $0/garbage-pool read — that's the 56,000x bug.
  let ref = num(o.refPriceUsd);
  if (ref <= 0) {
    if (market.liquidityUsd < REF_MIN_LIQ || market.priceUsd <= 0) {
      if (watchMin >= cfg.RECORDER_WINDOW_MIN) await closeOutcome(o.mint, false);
      return; // not anchored yet — wait for a real pool
    }
    ref = market.priceUsd;
  }
  if (ref <= 0) return;

  const priorPeakMult = num(o.peakMultiple) || 1;
  const priorPeakPrice = priorPeakMult * ref;
  // Read trust: only a real-liquidity tick can set a NEW high or raise the mark.
  // An untrusted (sub-liquidity) read may only report a DEATH — a drained pool
  // can crash but it cannot pump, so an UPWARD move on garbage liquidity is a
  // pool-flip artifact (the live 38,087x Cyclospora read: three pools
  // disagreeing by 8 orders of magnitude, all $0 liq). Hold the mark at
  // last-good on those; real rug decays (mark falling) still record.
  const trusted = market.liquidityUsd >= REF_MIN_LIQ;
  const rawMark = ref > 0 ? market.priceUsd / ref : 1;
  const lastMark = num(o.finalMultiple) || 1;
  const effMark = trusted || rawMark <= lastMark ? rawMark : lastMark;
  const effPrice = effMark * ref;
  const peakPrice = trusted ? Math.max(priorPeakPrice, effPrice) : priorPeakPrice;

  const t = tickFrom({
    priceUsd: effPrice,
    entryPriceUsd: ref,
    peakPriceUsd: peakPrice,
    buysM5: market.txns.m5.buys,
    sellsM5: market.txns.m5.sells,
    volM5: market.volUsd.m5,
    volH1: market.volUsd.h1,
    priceChangeM5Pct: market.priceChangePct.m5,
    ageMinutes: market.pairAgeMinutes ?? watchMin,
  });

  // classify over this candidate's trajectory so far — the confirmation trigger.
  // TRUSTED ROWS ONLY: a garbage-pool tick already persisted (pre-guard history,
  // or a death record) must never feed the gate/classifier — a fake 38,087x row
  // in the series could fake-ARM a corpse for the trader.
  const priorRows = await db
    .select()
    .from(candidateTicks)
    .where(eq(candidateTicks.mint, o.mint))
    .orderBy(asc(candidateTicks.snappedAt))
    .limit(60);
  const trustedRows = priorRows.filter((r) => num(r.liquidityUsd) >= REF_MIN_LIQ);
  const series: Tick[] = [...trustedRows.map(rowToTick), t];
  const call = classify(series);

  const mark = effMark;
  const newPeakMult = peakPrice / ref;
  const isNewPeak = newPeakMult > priorPeakMult + 1e-9;

  await db.insert(candidateTicks).values({
    mint: o.mint,
    signalId: o.signalId,
    refPriceUsd: String(ref),
    priceUsd: String(market.priceUsd),
    markMultiple: String(mark),
    peakMultiple: String(newPeakMult),
    drawdownFromPeakPct: String(t.drawdownFromPeakPct),
    liquidityUsd: String(market.liquidityUsd),
    fdvUsd: String(market.fdvUsd),
    volM5: String(market.volUsd.m5),
    volH1: String(market.volUsd.h1),
    buysM5: market.txns.m5.buys,
    sellsM5: market.txns.m5.sells,
    buyShareM5: String(t.buyShareM5),
    priceChangeM5Pct: String(market.priceChangePct.m5),
    ageMinutes: String(market.pairAgeMinutes ?? watchMin),
    watchMinutes: String(watchMin),
    regime: call.regime,
    action: call.action,
    continuationScore: String(call.continuationScore),
  });

  await db
    .update(candidateOutcomes)
    .set({
      refPriceUsd: String(ref),
      ticks: o.ticks + 1,
      peakMultiple: String(newPeakMult),
      finalMultiple: String(mark),
      maxDrawdownFromPeakPct: String(Math.max(num(o.maxDrawdownFromPeakPct), t.drawdownFromPeakPct)),
      minutesToPeak: isNewPeak ? String(watchMin) : o.minutesToPeak,
      peakLiquidityUsd: String(Math.max(num(o.peakLiquidityUsd), market.liquidityUsd)),
      updatedAt: new Date(),
    })
    .where(eq(candidateOutcomes.mint, o.mint));

  // Recorder-as-scout, LIVE armed-state model: re-evaluate the entry gate EVERY
  // poll and hold `armed` in sync with live demand. armed = the candidate
  // qualifies right now (in-window, green, near-highs, buy-side winning) AND we
  // don't already hold/own it. This re-arms and disarms as the trajectory moves,
  // so a candidate that qualifies AFTER a breaker halt or a transient miss is
  // still catchable, and one whose move died is dropped — nothing is burned
  // one-shot. The trader enters any armed + un-entered candidate it sees fresh.
  if (triggerCfg.enabled) {
    // NEVER confirm on an untrusted read — a sub-liquidity poll can only be a
    // death or a pool-flip, neither is enterable. Disarm for this poll; the
    // live armed-state model re-arms on the next trusted read if it qualifies.
    // POOL GROWTH — current liquidity ÷ the first trusted read. The dead-zone
    // exemption's input and (measured 2026-07-20) the strongest leak-free
    // predictor we have: a pool that GREW by trigger ran 2.79× after entry and
    // rugged 6% vs 26%. Wash churn recycles the same capital and leaves the
    // pool flat; a real move pulls new capital in.
    const firstTrustedLiq = trustedRows.length > 0 ? num(trustedRows[0]?.liquidityUsd) : market.liquidityUsd;
    const liqGrowth = firstTrustedLiq > 0 ? market.liquidityUsd / firstTrustedLiq : null;
    const trig = trusted
      ? evaluateEntryTrigger(
          series,
          { watchMinutes: watchMin, observationCount: o.ticks + 1, action: call.action, liqGrowth },
          triggerCfg,
        )
      : {
          triggered: false,
          reason: `untrusted read (liq $${Math.round(market.liquidityUsd)} < $${REF_MIN_LIQ})`,
          markMultiple: effMark,
          drawdownPct: t.drawdownFromPeakPct,
          buyShare: t.buyShareM5,
        };
    // RE-ENTRY (the VICE 8.4x lesson, 2026-07-16): one-shot `!o.entered`
    // permanently burned any candidate we ever touched — overnight, 67
    // entered-then-closed-flat candidates went on to peak ≥2x (avg 3.1x)
    // with no way back in. A candidate now re-arms after its position closes
    // IF it re-qualifies the full live gate, bounded by an entry cap and a
    // cooldown so a whipsaw can't thrash open/stop/reopen.
    const [book] = await db
      .select({
        openCount: sql<number>`count(*) filter (where ${positions.status} = 'open')::int`,
        totalCount: sql<number>`count(*)::int`,
        lastClosedAt: sql<Date | null>`max(${positions.closedAt})`,
      })
      .from(positions)
      .where(eq(positions.mint, o.mint));
    const cooledDown =
      !book?.lastClosedAt ||
      Date.now() - new Date(book.lastClosedAt).getTime() >= cfg.REENTRY_COOLDOWN_MIN * 60_000;
    const armed =
      trig.triggered &&
      (book?.openCount ?? 0) === 0 &&
      (book?.totalCount ?? 0) < cfg.REENTRY_MAX_ENTRIES &&
      cooledDown;

    // Fitted rug probability at the freshest armed read (core rugModel.ts,
    // held-out AUC 0.70). The trader sizes by this — shrink, never veto.
    const rugProb = armed
      ? scoreRugProb({
          venue: canonicalVenue(market),
          liquidityUsd: market.liquidityUsd,
          fdvUsd: market.fdvUsd,
          volM5: market.volUsd.m5,
          volH1: market.volUsd.h1,
          markMultiple: trig.markMultiple,
          drawdownPct: trig.drawdownPct,
          watchMinutes: watchMin,
        })
      : null;

    // Wallet-reputation edge: score this candidate's holder set against the graph
    // (VALIDATED — winner-rep wallet in holders = 2.2× winner lift). Scored while
    // ARMED (refreshed each poll for the entry decision) AND once early for every
    // WATCHING candidate (walletEdge still null) — that early score is the
    // smart-money DISCOVERY signal, surfaced before a candidate ever arms.
    const wallet = armed || o.walletEdge == null ? await scoreCandidateWalletEdge(o.mint) : null;

    // CONVICTION — fuse the high-performance factors into one score (wallet-
    // dominant) that drives entry priority + live sizing. Point-in-time at arm.
    const convScore =
      armed && cfg.CONVICTION_ENABLED
        ? scoreConviction(
            {
              walletEdge: wallet ? wallet.edge : o.walletEdge != null ? Number(o.walletEdge) : null,
              rugProb,
              triggerMultiple: trig.markMultiple,
              buyShare: trig.buyShare,
            },
            { wallet: cfg.CONVICTION_W_WALLET, rugSafe: cfg.CONVICTION_W_RUGSAFE, gate: cfg.CONVICTION_W_GATE },
          )
        : null;

    // First time it arms: stamp the trigger context (for news/analytics) and
    // announce. Re-arms after a disarm keep the original triggeredAt as the
    // "first confirmed demand" mark.
    const firstArm = armed && !o.triggeredAt;
    await db
      .update(candidateOutcomes)
      .set({
        armed,
        // Freshest demand read while armed — the trader sizes off THIS (quality
        // sizing), so it must reflect the tick it will actually enter into, not
        // the first-arm snapshot from minutes ago.
        ...(armed
          ? {
              triggerBuyShare: String(trig.buyShare),
              rugProb: String(rugProb),
              // THE EDGE — pool growth at arm. Persisted on every armed read so
              // the trader sizes by it and so it stays continuously measurable.
              ...(liqGrowth !== null && Number.isFinite(liqGrowth) ? { liqGrowth: String(liqGrowth) } : {}),
            }
          : {}),
        ...(wallet
          ? {
              walletEdge: String(wallet.edge),
              walletWinnerHits: wallet.winnerHits,
              walletRugHits: wallet.rugHits,
              walletKnown: wallet.known,
            }
          : {}),
        ...(convScore !== null ? { convictionScore: String(convScore) } : {}),
        ...(firstArm
          ? {
              triggeredAt: new Date(),
              triggerScore: String(call.continuationScore),
              triggerMultiple: String(trig.markMultiple),
              triggerReason: trig.reason,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(candidateOutcomes.mint, o.mint));

    if (firstArm) {
      await db.insert(auditLog).values({
        actor: "recorder",
        action: "entry_trigger",
        details: {
          mint: o.mint,
          watchMinutes: watchMin,
          markMultiple: trig.markMultiple,
          drawdownPct: trig.drawdownPct,
          buyShare: trig.buyShare,
          continuationScore: call.continuationScore,
          rugProb,
          reason: trig.reason,
        },
      });
      const wsig = wallet
        ? ` · wallet ${wallet.winnerHits > 0 ? `🟢${wallet.winnerHits}w` : ""}${wallet.rugHits > 0 ? ` 🔴${wallet.rugHits}r` : ""}${wallet.known === 0 ? "fresh" : ""} (edge ${(wallet.edge * 100).toFixed(0)})`
        : "";
      console.log(`⚡ ARMED ${short(o.mint)} — ${trig.reason} · rug ${rugProb === null ? "n/a" : (rugProb * 100).toFixed(0) + "%"}${wsig}${convScore !== null ? ` · conviction ${(convScore * 100).toFixed(0)}` : ""}`);
    }
  }

  if (watchMin >= cfg.RECORDER_WINDOW_MIN) await closeOutcome(o.mint, false);
}

async function tick(): Promise<void> {
  await seedNewCandidates();
  // Pond Radar: venue lifecycle from rolling 24h evidence (self-throttled to
  // POND_SCAN_MS; own try/catch — R&D must never stall the recording loop).
  void scanPonds(cfg);
  // Wallet reputation: recompute the behavioral graph from holders × outcomes
  // (self-throttled; own try/catch — must never stall the recording loop).
  void refreshWalletReputation(cfg);
  const open = await db
    .select()
    .from(candidateOutcomes)
    .where(eq(candidateOutcomes.label, "open"));
  if (open.length === 0) return;
  // BATCHED reads — one request per 30 candidates instead of one per candidate.
  // Per-mint polling (60 candidates / 30s) plus the trader's book was blowing
  // DexScreener's rate ceiling and manufacturing the book-wide "outage" storms.
  const markets = await fetchTokenMarkets(open.map((o) => o.mint)).catch(
    () => new Map<string, Awaited<ReturnType<typeof fetchTokenMarket>> | null>(),
  );
  for (const o of open) {
    try {
      await observe(o, markets.get(o.mint) ?? null);
    } catch (err) {
      console.error(`   observe ${short(o.mint)}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(
    `[${new Date().toISOString()}] recorder tick — ${open.length} candidate(s) in window`,
  );
}

if (!cfg.RECORDER_ENABLED) {
  console.log("RECORDER_ENABLED=false — recorder idle. Set it true to build the dataset.");
  process.exit(0);
}

console.log(
  `RECORDER online — watching every safety-passed candidate for ${cfg.RECORDER_WINDOW_MIN}m via DexScreener (keyless), polling every ${cfg.RECORDER_POLL_MS / 1000}s. Win threshold: ${cfg.RECORDER_WIN_MULT}x peak. No RPC, no capital.\n`,
);

// Liveness heartbeat for the dashboard health panel. candidate_ticks are only
// written when candidates are in-window, so during idle the recorder can look
// dead by that measure — this proves the loop is turning regardless.
async function writeRecorderHealth(watching: number): Promise<void> {
  const value = { ts: Date.now(), watching };
  await db
    .insert(config)
    .values({ key: "recorder_health", value })
    .onConflictDoUpdate({ target: config.key, set: { value, updatedAt: new Date() } })
    .catch((err) => console.error(`recorder heartbeat failed: ${err instanceof Error ? err.message : err}`));
}

// resilient loop — one failed tick never kills the daemon
// eslint-disable-next-line no-constant-condition
while (true) {
  let watching = 0;
  try {
    await tick();
    const [c] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(candidateOutcomes)
      .where(eq(candidateOutcomes.label, "open"));
    watching = c?.n ?? 0;
  } catch (err) {
    console.error(`tick failed: ${err instanceof Error ? err.message : err}`);
  }
  await writeRecorderHealth(watching);
  await new Promise((r) => setTimeout(r, cfg.RECORDER_POLL_MS));
}
