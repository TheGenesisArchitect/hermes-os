/**
 * M5 LIVE EXECUTION — built while the paper window qualifies, inert until
 * LIVE_TRADING_ENABLED=true AND a wallet key exists AND the go-live gate
 * (docs/GO_LIVE_GATE.md) has passed.
 *
 * Architecture: MIRROR LANE. The paper book remains the strategy brain — the
 * live lane shadows its confirmed entries and exits at its own hard caps,
 * writing real fills into the SAME positions/fills tables with lane='live'.
 * One brain, two books; the live book can never take a trade the paper brain
 * didn't, and it can take far fewer (caps below).
 *
 * Hard caps — enforced HERE in code, not in the operator's discipline:
 *   LIVE_MAX_POSITION_USD   per-position notional ceiling
 *   LIVE_MAX_CONCURRENT     max open live positions
 *   LIVE_DAILY_LOSS_CAP_USD realized loss today → no new buys until tomorrow
 *   KILL CRITERION          cumulative live realized ≤ −$50 OR ≥20 closes with
 *                           negative cumulative P&L → config live_kill set,
 *                           live lane refuses ALL buys until a human clears it
 *                           after a fresh paper re-qualification (gate doc).
 *   LIVE_REQUIRE_HONEYPOT_VERIFIED  entry requires an AFFIRMATIVE honeypot
 *                           pass (verified sell route) — inconclusive = block.
 *
 * Failure containment: a failed/unconfirmed sell can strand a live position
 * open while its paper twin closed. sweepLiveBook() runs every manage cycle
 * and force-closes any live position whose paper twin is gone — the book
 * self-heals instead of relying on every mirror call succeeding.
 */
import { Transaction, VersionedTransaction } from "@solana/web3.js";
import {
  convictionBand,
  fetchJupiterPrice,
  fetchTokenMarket,
  profileOf,
  resilientFetch,
  signatureExitOverrides,
  sizeFraction,
  type HermesConfig,
  type Signature,
} from "@hermes/core";
import { auditLog, candidateOutcomes, candidateTicks, db, fills, journalFill, pnlSnapshots, positionTicks, positions, safetyChecks, tokens } from "@hermes/db";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { rpcPool } from "./rpc/pool.js";
import { WSOL_MINT } from "./swap/jupiterHosted.js";
import { swapRouter } from "./swap/router.js";
import { liveWallet } from "./wallet.js";
import { chamberExit, fireChambered, releaseChamber, chamberAgeMs, rehydrateChambers } from "./presigned.js";
import { persist as persistState, forget as forgetState, rehydrate as rehydrateState } from "./state.js";
import { loadManifest, manifestVerdict } from "./manifest.js";
import {
  LATCHING_EXIT, shouldPersistLatch, impactFraction, impliedLiquidityUsd, closeVerdict,
  classifySwapFailure,
} from "./invariants.js";

// Exit probes now ride swapRouter.quoteValue (QTEA-003) — a READ-ONLY walk that
// skips build-only payloads (canValue:false), so PumpPortal can never
// optimistically "pass" an unsellable token. The dedicated instances are gone.

/**
 * Is there a REAL sell route for this token right now? Prevents entering a token
 * we can't exit (KIMI). Ordered fast→slow: pump.fun-origin is inherently sellable
 * (symmetric curve/graduated pool) and needs no network probe; the graduated
 * NON-pump class — the actual strand risk — is verified via the PumpSwap pool,
 * then Jupiter as the universal liquidity oracle. Only skips when NOTHING can sell it.
 */
async function canExitLive(cfg: HermesConfig, mint: string, tokenAmt: bigint): Promise<boolean> {
  if (mint.endsWith("pump")) return true; // pump.fun-origin — always sellable, no probe
  // QTEA-003: the probe walks the WHOLE provider universe (PumpSwap first, then
  // Jupiter, Fluxbeam, Meteora, the curve) — the same set that would build the
  // exit. Only skips when NOTHING can sell it.
  try {
    const q = await swapRouter.quoteValue(cfg, mint, tokenAmt, cfg.LIVE_SELL_SLIPPAGE_BPS);
    return Number(q.outAmount) > 0;
  } catch {
    return false;
  }
}

const n = (v: string | number | null | undefined): number => Number(v ?? 0);
const short = (m: string) => `${m.slice(0, 4)}…${m.slice(-4)}`;

async function audit(action: string, details: Record<string, unknown>): Promise<void> {
  await db.insert(auditLog).values({ actor: "trader-live", action, details });
}

/** CLOSE-ON-EXIT rent reclaim — close empty token accounts after a full sell
 *  or a desync heal. Best-effort: a failure (dust remainder, race with a
 *  landing sell) logs and leaves the shell for a later pass; never blocks. */
async function closeEmptyAtas(
  cfg: HermesConfig,
  accounts: { toBase58(): string }[],
  mint: string,
): Promise<void> {
  const wallet = liveWallet();
  if (!wallet || !accounts.length) return;
  try {
    const { PublicKey, Transaction, TransactionInstruction } = await import("@solana/web3.js");
    const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    const rpc = rpcPool(cfg);
    const tx = new Transaction();
    for (const a of accounts)
      tx.add(
        new TransactionInstruction({
          programId: TOKEN_PROGRAM,
          keys: [
            { pubkey: new PublicKey(a.toBase58()), isSigner: false, isWritable: true },
            { pubkey: wallet.publicKey, isSigner: false, isWritable: true },
            { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
          ],
          data: Buffer.from([9]), // CloseAccount
        }),
      );
    const { blockhash } = await rpc.read((c) => c.getLatestBlockhash("confirmed"));
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;
    tx.sign(wallet);
    const sig = await rpc.send(tx, { skipPreflight: true, maxRetries: 2 });
    console.log(`🧹 rent reclaimed ${mint.slice(0, 4)}… (${accounts.length} acct) ${String(sig).slice(0, 10)}…`);
    await audit("ata_closed_on_exit", { mint, accounts: accounts.length });
  } catch (err) {
    console.warn(`rent-close deferred ${mint.slice(0, 4)}…: ${err instanceof Error ? err.message.slice(0, 80) : err}`);
  }
}

// ── gates ────────────────────────────────────────────────────────────────────

interface LiveGate {
  ok: boolean;
  reason?: string;
}

// LIVE PREMIUM-VENUE SET — proven by MEASURED performance, not volume/label.
// A venue holds real capital only if it clears the quality bar: enough sample,
// rug rate under the drawdown gate, AND either proven-profitable (realized > 0)
// or 'promoted' (earned). NOT gated on win rate — convex venues have low hit
// rates with huge winners, so a win floor would cut the best venue (pumpswap:
// win .13 but +$713). ∪ static PRIME_VENUES. Cached 60s; a read hiccup keeps the
// last-known set rather than opening the gate wide.
const premiumVenues = { set: new Set<string>(), at: 0 };
async function livePremiumSet(cfg: HermesConfig): Promise<Set<string>> {
  if (Date.now() - premiumVenues.at > 60_000) {
    premiumVenues.at = Date.now();
    try {
      const rows = (await db.execute(sql`
        select venue from venue_intel
        where state <> 'blocked'
          and watched_24h >= ${cfg.LIVE_VENUE_MIN_N}
          and rug_rate_24h <= ${cfg.LIVE_VENUE_MAX_RUG}
          and (state = 'promoted' or realized_24h > 0)
      `)) as unknown as { venue: string }[];
      premiumVenues.set = new Set(rows.map((r) => r.venue.toLowerCase()));
    } catch {
      /* keep last-known set */
    }
  }
  const merged = new Set(premiumVenues.set);
  for (const v of cfg.PRIME_VENUES) merged.add(v.toLowerCase());
  return merged;
}

/** The candidate's venue, keyed the same way venue_intel is (lower(tokens.dex)). */
async function venueForMint(mint: string): Promise<string | null> {
  const [t] = await db.select({ dex: tokens.dex }).from(tokens).where(eq(tokens.mint, mint)).limit(1);
  return t?.dex ? t.dex.toLowerCase() : null;
}

async function liveKillState(): Promise<{ enabled: boolean; clearedAt: Date | null }> {
  const rows = (await db.execute(sql`select value from config where key = 'live_kill'`)) as unknown as {
    value: { enabled?: boolean; clearedAt?: string };
  }[];
  const v = rows[0]?.value ?? {};
  return { enabled: v.enabled === true, clearedAt: v.clearedAt ? new Date(v.clearedAt) : null };
}
async function liveKillEngaged(): Promise<boolean> {
  return (await liveKillState()).enabled;
}

async function engageLiveKill(reason: string, stats: Record<string, unknown>): Promise<void> {
  await db.execute(
    sql`insert into config (key, value) values ('live_kill', ${JSON.stringify({ enabled: true, reason, at: new Date().toISOString(), ...stats })}::jsonb)
        on conflict (key) do update set value = excluded.value, updated_at = now()`,
  );
  await audit("live_kill_engaged", { reason, ...stats });
  console.error(`🛑 LIVE KILL ENGAGED — ${reason}. Live lane refuses all buys until a human clears config live_kill after paper re-qualification.`);
}

/** Every precondition for a live BUY, checked in cheap→expensive order. */
// `routed` = this buy carries a trade signature, i.e. it is the SAME decision
// paper just made. Paper has none of the strategy gates below — no venue
// restriction, no regime stand-down, no wallet veto, no anticipation gate — and
// paper is the book proving the model. Every one of these silently removes
// trades from live that paper is winning on, which is precisely what kept the
// live wallet unproductive. Only the SOLVENCY checks (kill switch, daily cap,
// sell-route) apply to a routed buy; those protect the wallet rather than
// express a strategy opinion.
async function liveBuyGate(cfg: HermesConfig, mint: string, routed = false): Promise<LiveGate> {
  if (!cfg.LIVE_TRADING_ENABLED) return { ok: false, reason: "disabled" };
  if (!liveWallet()) return { ok: false, reason: "no wallet key" };
  const killState = await liveKillState();
  if (killState.enabled) return { ok: false, reason: "live_kill engaged" };

  // Kill criterion: cumulative realized ≤ −$KILL → engage permanently.
  // MEASURED FROM THE MISSION EPOCH (live_kill.clearedAt), not from inception:
  // an all-time window made every future cap a landmine — re-sizing the kill to
  // −$25 for the $128 comeback run tripped it INSTANTLY against week-old
  // history (−$97.62 ≤ −$25) and halted the mission at the gate. "Cleared by
  // the operator" is the natural zero point for "how much have we lost since."
  // The secondary "≥20 closes with negative cumulative P&L" clause is DISABLED in
  // mirror mode: mirroring a convex book (low hit-rate, huge winners — BRIBE was 1
  // of 47 pumpswap trades) means the first 20 closes are routinely net-negative
  // BEFORE the moonshot lands, so that clause would lock us out exactly when the
  // winner comes. The dollar drawdown (−$KILL, a hard % stop on the throwaway
  // wallet) is the real backstop; the close-count heuristic only fits a
  // non-convex book, so it applies only outside mirror mode.
  const [cum] = (await db
    .select({
      pnl: sql<number>`coalesce(sum(${positions.realizedPnlUsd}::float), 0)`,
      closes: sql<number>`count(*) filter (where ${positions.status} = 'closed')`,
    })
    .from(positions)
    .where(and(eq(positions.lane, "live"),
      killState.clearedAt ? gte(positions.closedAt, killState.clearedAt) : undefined))) as { pnl: number; closes: number }[];
  const cumPnl = n(cum?.pnl);
  const closes = n(cum?.closes);
  const closeCountKill = !cfg.LIVE_MIRROR_PAPER && closes >= 20 && cumPnl < 0;
  if (cumPnl <= -cfg.LIVE_KILL_LOSS_USD || closeCountKill) {
    await engageLiveKill(
      cumPnl <= -cfg.LIVE_KILL_LOSS_USD ? `cumulative realized ≤ −$${cfg.LIVE_KILL_LOSS_USD}` : "20 closes with negative cumulative P&L",
      { cumPnl, closes },
    );
    return { ok: false, reason: "kill criterion met" };
  }

  // Daily loss cap: realized today ≤ −cap → stand down until tomorrow (UTC).
  const [today] = (await db
    .select({ pnl: sql<number>`coalesce(sum(${positions.realizedPnlUsd}::float), 0)` })
    .from(positions)
    .where(and(eq(positions.lane, "live"), gte(positions.closedAt, sql`date_trunc('day', now())`)))) as {
    pnl: number;
  }[];
  // THROTTLE, don't halt: at/beyond the daily cap the sizer shrinks toward the
  // floor (see maybeLiveBuy) but live stays present for the tail. Only if the
  // throttle is disabled does the cap hard-halt. The cumulative KILL is the floor.
  if (!cfg.LIVE_DAILY_THROTTLE_ENABLED && n(today?.pnl) <= -cfg.LIVE_DAILY_LOSS_CAP_USD)
    return { ok: false, reason: `daily loss cap (${n(today?.pnl).toFixed(2)})` };

  // BLEEDING-REGIME GATE: paper is the regime sensor (high trade volume). If its
  // realized over the recent window is deeply negative, the environment is
  // hostile — live refuses NEW entries so real capital doesn't follow the paper
  // book into the bleed. Open live positions still manage/exit normally.
  if (cfg.LIVE_REGIME_GATE && !routed) {
    // In mirror mode, measure the bleed signal on ONLY the venues we mirror. The
    // whole-book signal is dominated by the high-churn bleeder (meteora-damm-v2,
    // 140 trades) which we deliberately exclude — letting it drag the window
    // negative would wrongly stand live down while the venues we actually trade
    // (pumpswap/fluxbeam) are printing winners. So the regime is judged on the
    // book live is really shadowing.
    const mirrorVenues = cfg.LIVE_MIRROR_PAPER
      ? cfg.LIVE_MIRROR_VENUES.split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const base = db
      .select({
        pnl: sql<number>`coalesce(sum(${positions.realizedPnlUsd}::float), 0)`,
        gross: sql<number>`coalesce(sum(${positions.sizeUsd}::float), 0)`,
      })
      .from(positions);
    // BOOK SPLIT (2026-07-28): the regime signal reads the CORE book only —
    // probe churn (net ~$0 by design, 70% of paper's at-bats) must never
    // stand live down or up; live models the live-shape wallet.
    const scoped =
      mirrorVenues.length > 0
        ? base
            .innerJoin(tokens, eq(tokens.mint, positions.mint))
            .where(
              and(
                eq(positions.lane, "paper"),
                eq(positions.book, "core"),
                eq(positions.status, "closed"),
                gte(positions.closedAt, sql`now() - make_interval(mins => ${cfg.LIVE_REGIME_WINDOW_MIN})`),
                inArray(tokens.dex, mirrorVenues),
              ),
            )
        : base.where(
            and(
              eq(positions.lane, "paper"),
              eq(positions.book, "core"),
              eq(positions.status, "closed"),
              gte(positions.closedAt, sql`now() - make_interval(mins => ${cfg.LIVE_REGIME_WINDOW_MIN})`),
            ),
          );
    const [rg] = (await scoped) as { pnl: number; gross: number }[];
    const scope = mirrorVenues.length > 0 ? "mirror-venues" : "paper";
    const net = n(rg?.pnl);
    if (cfg.LIVE_MIRROR_PAPER) {
      // PERCENTAGE (scale-invariant): the venue EDGE over the window = net ÷ gross
      // deployed. Only a catastrophic edge (a rug wave losing most of everything
      // put to work) stands live down — convex-noise losing windows (−10% edge)
      // do not. Below the min-gross floor there isn't enough deployed to trust the
      // ratio, so we don't gate. Daily cap + kill are the real dollar backstops.
      const gross = n(rg?.gross);
      if (gross >= cfg.LIVE_MIRROR_REGIME_MIN_GROSS_USD) {
        const edge = net / gross;
        if (edge <= -cfg.LIVE_MIRROR_REGIME_MAX_LOSS_PCT)
          return {
            ok: false,
            reason: `regime bleeding (${scope} edge ${(edge * 100).toFixed(0)}% on $${gross.toFixed(0)} deployed / ${cfg.LIVE_REGIME_WINDOW_MIN}m, thr −${(cfg.LIVE_MIRROR_REGIME_MAX_LOSS_PCT * 100).toFixed(0)}%)`,
          };
      }
    } else if (net <= -cfg.LIVE_REGIME_MAX_LOSS_USD) {
      return { ok: false, reason: `regime bleeding (${scope} ${net.toFixed(2)}/${cfg.LIVE_REGIME_WINDOW_MIN}m, thr −$${cfg.LIVE_REGIME_MAX_LOSS_USD})` };
    }
  }

  // Concurrency cap.
  const [open] = (await db
    .select({ c: sql<number>`count(*)` })
    .from(positions)
    .where(and(eq(positions.lane, "live"), eq(positions.status, "open")))) as { c: number }[];
  if (n(open?.c) >= cfg.LIVE_MAX_CONCURRENT) return { ok: false, reason: "concurrency cap" };

  // ── TEST-WINDOW TRADE CAP (operator: "10 trade max so we can test the
  // changes we made") ──────────────────────────────────────────────────────
  // Counted from the kill epoch, so arming opens a fresh window. New entries
  // stop at the cap; open positions keep managing and exiting normally, which
  // is what makes the window a clean measurement rather than a hard stop.
  if (cfg.LIVE_SESSION_TRADE_CAP > 0 && killState.clearedAt) {
    const [sess] = (await db
      .select({ c: sql<number>`count(*)` })
      .from(positions)
      .where(and(eq(positions.lane, "live"), gte(positions.openedAt, killState.clearedAt)))) as { c: number }[];
    const taken = n(sess?.c);
    if (taken >= cfg.LIVE_SESSION_TRADE_CAP)
      return { ok: false, reason: `test-window cap reached (${taken}/${cfg.LIVE_SESSION_TRADE_CAP} since arming) — measure before extending` };
  }

  // Already hold it live?
  const [held] = await db
    .select({ id: positions.id })
    .from(positions)
    .where(and(eq(positions.lane, "live"), eq(positions.mint, mint), eq(positions.status, "open")))
    .limit(1);
  if (held) return { ok: false, reason: "already held" };

  // Wallet-graph signal for this candidate (scored by the recorder at arm) —
  // used by BOTH the venue gate (smart-money rescue) and the rug-wallet gate.
  const [w] = await db
    .select({ win: candidateOutcomes.walletWinnerHits, rug: candidateOutcomes.walletRugHits })
    .from(candidateOutcomes)
    .where(eq(candidateOutcomes.mint, mint))
    .limit(1);
  const winnerHits = n(w?.win);
  const rugHits = n(w?.rug);
  // SMART-MONEY RESCUE: strong winner-wallet backing with zero rug-wallets is the
  // proven-winning slice even on a bleeder venue (meteora-damm-v2 winner-wallet
  // tokens win 44% / 0% rug vs the 13% venue baseline — e.g. the BRIBE +2× had 9
  // winner-wallets). It overrides the venue gate so we stop discarding these.
  const smartMoneyRescue =
    cfg.LIVE_WALLET_RESCUE_MIN_WINNERS > 0 && winnerHits >= cfg.LIVE_WALLET_RESCUE_MIN_WINNERS && rugHits === 0;

  // VENUE GATE.
  //  • MIRROR MODE: the executable-venue set is a HARD exit-safety requirement —
  //    if we cannot reliably ROUTE AN EXIT, we do not enter, smart-money or not.
  //    (KIMI, a smart-money-rescued meteora-damm-v2 token, became UNSELLABLE when
  //    its pool dumped to $6 liquidity and stranded real capital: damm-v2 routes an
  //    exit only via Jupiter, which vanishes on the atomic cliff.) Smart-money
  //    rescue may override venue QUALITY, but it must NEVER override venue
  //    EXITABILITY — a token we can buy but not sell is worse than one we skip.
  //  • EXPLOIT MODE: proven-premium venues only; there, smart-money rescue bypasses.
  const venue = await venueForMint(mint);
  if (cfg.LIVE_MIRROR_PAPER) {
    const executable = new Set(
      cfg.LIVE_MIRROR_VENUES.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    if (!venue || !executable.has(venue)) return { ok: false, reason: `venue not live-executable (${venue ?? "unknown"})` };
  } else if (cfg.LIVE_PREMIUM_ONLY && !routed && !smartMoneyRescue) {
    const premium = await livePremiumSet(cfg);
    if (!venue || !premium.has(venue)) return { ok: false, reason: `venue not premium (${venue ?? "unknown"})` };
  }

  // WALLET-GRAPH GATE: keep real capital out of a serial-rugger holder set that
  // has NO smart-money offset. VALIDATED — rug-rep holders suppress winners
  // (7.7% vs 12.4% base). Missing score = no data → we do not block on absence.
  if (cfg.LIVE_WALLET_GATE && !routed && rugHits > 0 && winnerHits === 0) {
    return { ok: false, reason: "wallet: serial-rugger holders, no smart-money" };
  }

  // HARD RULE: affirmative honeypot verification. Inconclusive (no Jupiter
  // route / probe unreachable) is a paper-only soft flag — with real capital
  // an unverifiable sell route is a block. We require the latest honeypot
  // safety check for this mint to be a real PASS.
  if (cfg.LIVE_REQUIRE_HONEYPOT_VERIFIED) {
    const [hp] = await db
      .select({ passed: safetyChecks.passed, evidence: safetyChecks.evidence })
      .from(safetyChecks)
      .where(and(eq(safetyChecks.mint, mint), eq(safetyChecks.checkName, "honeypot_probe")))
      .orderBy(desc(safetyChecks.id))
      .limit(1);
    const inconclusive =
      hp?.evidence && typeof hp.evidence === "object" && (hp.evidence as Record<string, unknown>).inconclusive === true;
    if (cfg.LIVE_MIRROR_PAPER) {
      // TRAP-ONLY (mirror mode): block real capital only on an AFFIRMATIVE honeypot
      // detection (probe ran, was conclusive, and FAILED). Inconclusive is a
      // Jupiter-outage artifact — during the outage the swap-sim can't reach a
      // route for pump/pumpswap tokens, so requiring a pass would reject every
      // winner (BRIBE +$750 et al. were all inconclusive). The executable-venue
      // gate above already confines this to standard-program curve/AMM venues
      // where a buy-yes/sell-no honeypot can't structurally exist, and paper's
      // keyless RugCheck trap gate (mint/freeze/rug) already cleared the mint.
      if (hp && hp.passed === false && !inconclusive) return { ok: false, reason: "honeypot confirmed" };
    } else if (!hp?.passed || inconclusive) {
      return { ok: false, reason: "honeypot not affirmatively verified" };
    }
  }

  // LIVE INFLOW REQUIREMENT — real capital mirrors only the band that pays.
  // Paper survives marginal-inflow trades because its fills are frictionless;
  // live eats slippage, gas and confirm latency, so the same trades are pure
  // bleed. Evidence (24h): pool ≥1.30× at arm → 72.0% win / 0.0% rug / +$27.09
  // realized, while 1.20-1.30× → 28.6% rug / −$7.32 and 1.05-1.20× → −$6.15.
  // Confirmed on the live book: 7 of the 8 worst live trades had pool growth
  // 1.14-1.25 despite clearing the 1.35-1.73× price bar. FAIL-SAFE: unstamped
  // candidates are refused as well — if stamping breaks, live stands down
  // rather than falling back to blind entries. Paper keeps exploring everything.
  if (cfg.LIVE_REQUIRE_INFLOW) {
    const [io] = await db
      .select({ lg: candidateOutcomes.liqGrowth })
      .from(candidateOutcomes)
      .where(eq(candidateOutcomes.mint, mint))
      .limit(1);
    const lg = io?.lg == null ? null : Number(io.lg);
    if (lg === null || !Number.isFinite(lg))
      return { ok: false, reason: "inflow unmeasured — live requires a stamped pool read" };
    if (lg < cfg.LIQ_INFLOW_STRONG)
      return { ok: false, reason: `weak inflow (pool ${lg.toFixed(2)}× < ${cfg.LIQ_INFLOW_STRONG}×)` };
  }

  // SELL-ROUTE PROBE (the KIMI lesson institutionalized): quote the EXIT before
  // committing capital to the entry. A token whose sell (mint → WSOL) cannot be
  // routed RIGHT NOW — across every provider in the failover stack — is a
  // stranding risk, whatever its venue label says. The probe amount is nominal
  // (route existence is what's tested, not depth); a probe failure defers the
  // entry, it does not consume the candidate — the recorder re-arms and the
  // next cycle re-probes, so a transient Jupiter blip costs one cycle, not the
  // trade.
  if (cfg.LIVE_SELL_ROUTE_PROBE) {
    try {
      const WSOL = "So11111111111111111111111111111111111111112";
      await swapRouter.quote(cfg, mint, WSOL, 100_000_000n, cfg.LIVE_SELL_SLIPPAGE_BPS);
    } catch (err) {
      return {
        ok: false,
        reason: `no sell route (probe: ${err instanceof Error ? err.message.slice(0, 120) : "failed"})`,
      };
    }
  }

  return { ok: true };
}

// ── execution primitives ─────────────────────────────────────────────────────

interface SwapResult {
  signature: string;
  /** UI amount of the OUTPUT token that actually arrived (from tx meta). */
  outUi: number;
  feeSol: number;
  /** ms from first broadcast to confirmed — the landing-rate scoreboard. */
  landMs: number;
}

/** Sign, simulate, send, confirm, and read the real fill from the tx meta. */
async function executeSwap(
  cfg: HermesConfig,
  base64Tx: string,
  outputMint: string,
  opts?: { skipSim?: boolean },
): Promise<SwapResult> {
  const wallet = liveWallet();
  if (!wallet) throw new Error("no wallet");
  const rpc = rpcPool(cfg);
  // Providers return either a versioned (Jupiter) or legacy (Fluxbeam) tx — sign
  // whichever we got. Legacy comes with the fee payer already set by the API.
  const buf = Buffer.from(base64Tx, "base64");
  let tx: VersionedTransaction | Transaction;
  try {
    tx = VersionedTransaction.deserialize(buf);
    tx.sign([wallet]);
  } catch {
    tx = Transaction.from(buf);
    tx.sign(wallet);
  }

  // Simulate first — a sim failure costs nothing; a sent failure costs fees.
  // EXCEPT protective flees (operator "gold standard" directive, 2026-07-29):
  // 4 of the last 6 sell-fails were OUR OWN preflight rejecting the exit
  // during fast movement, costing 25s avg (45s worst) from first fail to
  // landed exit — in a drain that is the whole capture (trustmebro −87.9pp
  // vs twin). On a flee, a wasted $0.04 fee is two orders of magnitude
  // cheaper than 25 seconds; the caller opts out and sends immediately.
  if (!opts?.skipSim) {
    const sim = await rpc.read((c) =>
      tx instanceof VersionedTransaction ? c.simulateTransaction(tx, { commitment: "confirmed" }) : c.simulateTransaction(tx),
    );
    if (sim.value.err) throw new Error(`simulation failed: ${JSON.stringify(sim.value.err)}`);
  }

  const sendStart = Date.now();
  const signature = await rpc.send(tx, { skipPreflight: true, maxRetries: 3 });

  // Confirm by polling signature status (bounded ~45s), REBROADCASTING the
  // signed tx every iteration while the blockhash lives. Shipped 2026-07-27:
  // 16 of 17 buy-fails since the Helius lane were "tx unconfirmed after 45s"
  // that never landed — a single broadcast fighting peak blocks. Re-sending
  // the same signature is idempotent; "already processed" noise is swallowed.
  const deadline = Date.now() + 45_000;
  let confirmed = false;
  while (Date.now() < deadline) {
    const st = (await rpc.read((c) => c.getSignatureStatuses([signature]))).value[0];
    if (st?.err) throw new Error(`tx failed on-chain: ${JSON.stringify(st.err)} (${signature})`);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
      confirmed = true;
      break;
    }
    await rpc.send(tx, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2_000));
  }
  if (!confirmed) throw new Error(`tx unconfirmed after 45s: ${signature}`);
  const landMs = Date.now() - sendStart;

  // Real fill from meta: output-token balance delta on our owner account
  // (works for SOL too via wrapped-SOL account when wrapAndUnwrapSol).
  const info = await rpc.read((c) => c.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }));
  const owner = wallet.publicKey.toBase58();
  let outUi = 0;
  if (info?.meta) {
    const post = info.meta.postTokenBalances?.filter((b) => b.mint === outputMint && b.owner === owner) ?? [];
    const pre = info.meta.preTokenBalances?.filter((b) => b.mint === outputMint && b.owner === owner) ?? [];
    const postAmt = post.reduce((s, b) => s + (b.uiTokenAmount.uiAmount ?? 0), 0);
    const preAmt = pre.reduce((s, b) => s + (b.uiTokenAmount.uiAmount ?? 0), 0);
    outUi = postAmt - preAmt;
    // Native SOL output (unwrapped): fall back to lamport delta.
    if (outputMint === WSOL_MINT && outUi <= 0 && info.meta.postBalances && info.meta.preBalances) {
      // version-agnostic account keys (versioned: staticAccountKeys; legacy: accountKeys)
      const msg = info.transaction.message as unknown as { staticAccountKeys?: { toBase58(): string }[]; accountKeys?: { toBase58(): string }[] };
      const keys = (msg.staticAccountKeys ?? msg.accountKeys ?? []).map((k) => k.toBase58());
      const idx = keys.indexOf(owner);
      if (idx >= 0)
        outUi = (n(info.meta.postBalances[idx]) - n(info.meta.preBalances[idx]) + n(info.meta.fee)) / 1e9;
    }
  }
  // A swap can never produce NEGATIVE output — on a ~$0 rug sell the SOL-delta
  // fallback can go slightly negative (priority fee > proceeds), which would book
  // a negative fill price. Floor at 0: proceeds are gross-of-fee (fee is expensed
  // separately in the caller's pnl), so a rug sell books proceeds $0, not −$fee.
  return { signature, outUi: Math.max(0, outUi), feeSol: n(info?.meta?.fee) / 1e9, landMs };
}

/** Read a SETTLED swap's real fill from its tx meta — mirrors executeSwap's
 *  tail for transactions we didn't build at send time (the sniper's rounds). */
async function parseSettledSwap(
  cfg: HermesConfig,
  signature: string,
  outputMint: string,
  landMs: number,
): Promise<{ signature: string; outUi: number; feeSol: number; landMs: number }> {
  const wallet = liveWallet();
  const rpc = rpcPool(cfg);
  const info = await rpc.read((c) => c.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }));
  const owner = wallet!.publicKey.toBase58();
  let outUi = 0;
  if (info?.meta) {
    const post = info.meta.postTokenBalances?.filter((b) => b.mint === outputMint && b.owner === owner) ?? [];
    const pre = info.meta.preTokenBalances?.filter((b) => b.mint === outputMint && b.owner === owner) ?? [];
    outUi = post.reduce((s, b) => s + (b.uiTokenAmount.uiAmount ?? 0), 0) - pre.reduce((s, b) => s + (b.uiTokenAmount.uiAmount ?? 0), 0);
    if (outputMint === WSOL_MINT && outUi <= 0 && info.meta.postBalances && info.meta.preBalances) {
      const msg = info.transaction.message as unknown as { staticAccountKeys?: { toBase58(): string }[]; accountKeys?: { toBase58(): string }[] };
      const keys = (msg.staticAccountKeys ?? msg.accountKeys ?? []).map((k) => k.toBase58());
      const idx = keys.indexOf(owner);
      if (idx >= 0) outUi = (n(info.meta.postBalances[idx]) - n(info.meta.preBalances[idx]) + n(info.meta.fee)) / 1e9;
    }
  }
  return { signature, outUi: Math.max(0, outUi), feeSol: n(info?.meta?.fee) / 1e9, landMs };
}

// SOL-PRICE FALLBACK CHAIN (operator 2026-08-04: "every minute we are down is
// an opportunity lost"). The 08-04 Jupiter outage proved a single-source SOL
// price blocks EVERY entry while exits keep working. Chain: Jupiter → the
// deepest DexScreener WSOL pair → last-known (≤10 min). Entries stay open
// through an aggregator outage; a triple failure still refuses cleanly.
let solPxCache: { px: number; at: number } | null = null;
async function solPriceUsd(cfg: HermesConfig): Promise<number | null> {
  const j = await fetchJupiterPrice(cfg.JUPITER_PRICE_URL, WSOL_MINT).catch(() => null);
  if (j != null && j > 0) { solPxCache = { px: j, at: Date.now() }; return j; }
  try {
    const res = await resilientFetch(`https://api.dexscreener.com/latest/dex/tokens/${WSOL_MINT}`, { timeoutMs: 5_000 });
    if (res.ok) {
      const b = (await res.json()) as { pairs?: { priceUsd?: string; liquidity?: { usd?: number } }[] };
      const best = (b.pairs ?? [])
        .filter((p) => Number(p.priceUsd) > 0)
        .sort((a, c) => (c.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      const px = Number(best?.priceUsd ?? 0);
      if (px > 0) { solPxCache = { px, at: Date.now() }; return px; }
    }
  } catch { /* fall through to last-known */ }
  if (solPxCache && Date.now() - solPxCache.at < 10 * 60_000) return solPxCache.px;
  return null;
}

// ── the Sizer: regime + wallet-balance aware ──────────────────────────────────

/** Live SOL balance → USD. Cached ~12s; falls back to last-known on an RPC blip
 *  so sizing never hard-fails on a transient read. */
const balCache = { at: 0, val: null as { sol: number; usd: number; price: number } | null };
async function liveBalance(cfg: HermesConfig): Promise<{ sol: number; usd: number; price: number } | null> {
  if (Date.now() - balCache.at < 12_000 && balCache.val) return balCache.val;
  const wallet = liveWallet();
  if (!wallet) return balCache.val;
  try {
    const lamports = await rpcPool(cfg).read((c) => c.getBalance(wallet.publicKey, "confirmed"));
    const price = await solPriceUsd(cfg);
    if (!price || price <= 0) return balCache.val;
    const sol = lamports / 1e9;
    balCache.at = Date.now();
    balCache.val = { sol, usd: sol * price, price };
    return balCache.val;
  } catch {
    return balCache.val; // last-known
  }
}

/** Regime multiplier from the recorder's measured hour policy (ET). prime → full,
 *  probe → shrink, unmeasured → slightly cautious. Cached 2min. */
const hpCache = { at: 0, hours: {} as Record<string, string> };
async function hourRegimeMult(cfg: HermesConfig): Promise<number> {
  if (Date.now() - hpCache.at > 120_000) {
    hpCache.at = Date.now();
    try {
      const rows = (await db.execute(sql`select value from config where key = 'hour_policy'`)) as unknown as {
        value: { hours?: Record<string, string> };
      }[];
      hpCache.hours = rows[0]?.value?.hours ?? {};
    } catch {
      /* keep last-known */
    }
  }
  const et =
    Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date())) % 24;
  const cls = hpCache.hours[String(et)] ?? "unmeasured";
  return cls === "prime" ? 1.0 : cls === "probe" ? cfg.LIVE_PROBE_SIZE_MULT : 0.85;
}

// ── Anticipation sizing — the forward forecast as a control input ─────────────
// Combines VENUE MOMENTUM (the token's venue heating/cooling, paper realized last
// 3h vs prior — the freshest signal) with the current window's TAIL ODDS (this ET
// hour's share of 3×+ candidates vs a flat expectation). Cached 2min; paper is the
// sensor (live has too few trades to read momentum from). Bounded [MIN, MAX].
const antiCache = { at: 0, venue: new Map<string, number>(), tail: 1 };
async function refreshAnticipation(cfg: HermesConfig): Promise<void> {
  if (Date.now() - antiCache.at < 120_000) return;
  antiCache.at = Date.now();
  try {
    const vrows = (await db.execute(sql`
      select t.dex as venue,
        coalesce(sum(p.realized_pnl_usd::float) filter (where p.closed_at > now()-interval '3 hours'),0) as recent,
        coalesce(sum(p.realized_pnl_usd::float) filter (where p.closed_at between now()-interval '6 hours' and now()-interval '3 hours'),0) as prior
      from positions p join tokens t on t.mint=p.mint
      where p.lane='paper' and p.status='closed' and t.dex is not null and p.closed_at > now()-interval '6 hours'
      group by 1
    `)) as unknown as { venue: string; recent: number; prior: number }[];
    const m = new Map<string, number>();
    for (const v of vrows) {
      const delta = Number(v.recent) - Number(v.prior);
      m.set(v.venue, delta > cfg.LIVE_ANTI_MOMENTUM_USD ? 1.2 : delta < -cfg.LIVE_ANTI_MOMENTUM_USD ? 0.8 : 1.0);
    }
    antiCache.venue = m;
    const et = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date())) % 24;
    const trows = (await db.execute(sql`
      select extract(hour from first_seen_at at time zone 'America/New_York')::int as h, count(*) filter (where peak_multiple >= 3)::int as tails
      from candidate_outcomes where label in ('winner','dud','rug') group by 1
    `)) as unknown as { h: number; tails: number }[];
    const total = trows.reduce((s, r) => s + Number(r.tails), 0) || 1;
    const thisHr = Number(trows.find((r) => Number(r.h) === et)?.tails ?? 0);
    const share = thisHr / total;
    antiCache.tail = share >= 1.5 / 24 ? 1.15 : share <= 0.5 / 24 ? 0.85 : 1.0;
  } catch {
    /* keep last-known */
  }
}
async function anticipationMult(cfg: HermesConfig, mint: string): Promise<number> {
  if (!cfg.LIVE_ANTICIPATION_ENABLED) return 1;
  await refreshAnticipation(cfg);
  const venue = await venueForMint(mint);
  const vFactor = venue ? (antiCache.venue.get(venue) ?? 1) : 1;
  return Math.max(cfg.LIVE_ANTICIPATION_MIN, Math.min(cfg.LIVE_ANTICIPATION_MAX, vFactor * antiCache.tail));
}

/** Target position size (USD): base = balance × SIZE_FRAC × regime × conviction ×
 *  anticipation, clamped to the min floor, the per-position balance fraction, and
 *  the absolute backstop. Conviction + anticipation let the best setups in the
 *  hottest venues/windows size toward the 14% cap while the floor preserves
 *  breadth — "maximize don't minimize" within bounded caps. */
export function livePositionUsd(
  cfg: HermesConfig,
  balanceUsd: number,
  regimeMult: number,
  convictionMult: number,
  anticipationMult: number,
  sig?: { signature: Signature; stars: number | null; walletWinnerHits?: number | null; walletRugHits?: number | null } | null,
  paperFrac?: number | null,
): number {
  // SIGNATURE SIZING — identical formula to paper, against the WALLET BALANCE
  // instead of the bankroll: the policy sets the range by regime, the quality
  // score picks the point inside it, and the class multiplier scales it. Both
  // lanes therefore share one risk model and stay on it as the account moves;
  // a flat LIVE_SIZE_FRAC would give a 2-star MOON_FAST and a 0-star residual
  // the same size, which is exactly the divergence we just removed from paper.
  // A routed position sizes on EXACTLY what paper uses: the conviction fraction
  // of capital times the class multiplier. Nothing else. The regime, conviction-
  // band and anticipation tilts are live-only inputs paper has never applied —
  // layering them on top means the two lanes deploy different capital against
  // identical signals, and the lane that is proving the model is the one without
  // them.
  // Paper's realised fraction wins when we have it — it already carries the
  // conviction fraction, the class multiplier AND paper's risk-tier and session
  // tilts. Re-deriving only part of that is what put the lanes 3x apart.
  // …but floored at LIVE_MIN_POSITION_FRAC. Paper pays no transaction cost and
  // live does, so beneath a certain fraction the two lanes are not running the
  // same trade: live's version hands a double-digit share of the move to fees
  // before the genome gets to manage anything. Conviction still scales freely
  // ABOVE the floor, so the range compresses rather than collapsing the way a
  // flat dollar floor would.
  // 2★ AGGRESSION: full-conviction setups (the fingerprint plus independent
  // evidence) size UP — paper's fraction × LIVE_STAR2_BOOST, still capped by
  // LIVE_MAX_POSITION_FRAC below. A deliberate, documented departure from
  // strict 1:1: at small balances only concentration clears the fee drag.
  // SMART-MONEY BOOST (7d wallet-graph study, 2026-07-22): ≥2 winner-rep
  // holders + positive net rep + ≥1★ ran 79.2% win / 4.2% rug / 58.3% moon-3×
  // (n=24) against a 16.3%-win base. That cohort earns the same sizing as a 2★
  // conviction call. Small n — the boost reuses the proven 2★ multiplier
  // rather than inventing a larger one; the study re-runs as the sample grows.
  const wh = sig?.walletWinnerHits ?? 0;
  const netRep = wh - (sig?.walletRugHits ?? 0);
  const smartMoney = wh >= 2 && netRep >= 1 && (sig?.stars ?? 0) >= 1;
  const starBoost = (sig?.stars ?? 0) >= 2 || smartMoney ? cfg.LIVE_STAR2_BOOST : 1;
  const routedFrac = Math.max(
    cfg.LIVE_MIN_POSITION_FRAC,
    (paperFrac != null && paperFrac > 0
      ? paperFrac
      : sizeFraction(sig?.stars ?? 0, cfg.POSITION_FRAC_MIN, cfg.POSITION_FRAC_MAX) *
        (sig ? profileOf(sig.signature).size : 1)) * starBoost,
  );
  // GENOME WEIGHT — the winning formula's allocation term (ratified
  // 2026-07-29). Selection decides WHETHER we board; this decides HOW MUCH,
  // from each genome's own measured EV. Applied to routed positions only;
  // unweighted genomes and unrouted rows pass through at 1.0. The caps below
  // still bound everything, so a weight can tilt allocation but never breach
  // the exposure rails.
  const genomeWeight = (() => {
    if (!sig) return 1;
    for (const pair of cfg.LIVE_GENOME_WEIGHTS.split(",")) {
      const [name, w] = pair.split(":");
      if (name?.trim() === sig.signature) {
        const parsed = Number(w);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
      }
    }
    return 1;
  })();
  const base = sig
    ? balanceUsd * routedFrac * genomeWeight
    : balanceUsd * cfg.LIVE_SIZE_FRAC * regimeMult * convictionMult * anticipationMult;
  // CAPS SCALE WITH THE BALANCE, FLOORS DO NOT.
  // LIVE_MIN_POSITION_USD is a fee-viability floor, not a strategy knob — below
  // it the transaction cost eats the trade. But applied to a small balance it
  // swallows the whole conviction range: at $60, a 0★ residual computes to $0.60
  // and a 2★ to $3.00, and the $3.50 floor makes them IDENTICAL. Conviction then
  // does nothing, which breaks the 1:1 with paper silently.
  //
  // So a routed position is NOT floored. If its fraction of the balance is too
  // small to be worth the fee, the honest answer is to skip the trade rather than
  // inflate it to a size the conviction never asked for — an inflated 0★ is
  // exactly the capital misallocation the whole signature system exists to stop.
  // The caller drops anything under the fee floor.
  const capped = Math.min(base, balanceUsd * cfg.LIVE_MAX_POSITION_FRAC, cfg.LIVE_MAX_POSITION_USD);
  return sig ? capped : Math.max(cfg.LIVE_MIN_POSITION_USD, capped);
}

// ── public API (mirror hooks) ────────────────────────────────────────────────

/**
 * Mirror a confirmed PAPER entry into the live lane, if every gate passes.
 * Called after a successful paper open; never throws into the caller.
 */
export async function maybeLiveBuy(
  cfg: HermesConfig,
  mint: string,
  symbol: string | null,
  // The routed signature and its conviction. Live sizes and exits from this the
  // same way paper does, so the lanes run one system on two balances rather
  // than one lane shadowing the other.
  sig: {
    signature: Signature;
    stars: number | null;
    dipDepth?: number | null;
    snapPct?: number | null;
    snapRate?: number | null;
    /** Pool inflow multiple at the trigger tick — the probability-band gate. */
    liqGrowth?: number | null;
    /** Trigger multiple — live fires the conviction seat only (1.2–1.65). */
    triggerMultiple?: number | null;
    /** Point-in-time wallet-graph reputation of the holder set (7d study
     * 2026-07-22, n=9,771 armed+labeled): winner-rep holders lift everything
     * monotonically, negative net rep is a rug tell. */
    walletWinnerHits?: number | null;
    /** PRECISION subset (never-rugged). 0 with winners present = RECOVERED
     * crowd (net-positive wallets, ratified 2026-07-24) — passes F1, trades at
     * the reduced clip live inherits via paperFrac. Null = pre-tier row. */
    walletStrictHits?: number | null;
    walletRugHits?: number | null;
    /** F6: which launch of this ticker (1-based). Sizing flows via paperFrac; carried for audit visibility. */
    launchOrder?: number | null;
    /** Buy share at the trigger tick — THE selection separator (operator
     *  2026-07-29: "Buy Shares must be in our favor when qualifying").
     *  7d live-eligible cohort: <55% buys died 30% vs 13% for the rest, at an
     *  identical 3×-run rate — deaths removed with no upside cost. */
    triggerBuyShare?: number | null;
  } | null = null,
  /**
   * The fraction of ITS capital paper just committed to this same signal. Live
   * applies the identical share to its own balance, so relative risk matches by
   * construction rather than by two code paths agreeing — which they did not:
   * live was deploying 1.82% per trade against paper's 0.61%.
   */
  paperFrac: number | null = null,
): Promise<void> {
  // STAGE CLOCK (operator, 2026-07-23: "the fastest horse — timing is
  // everything"). Every live open records where its milliseconds went, so
  // entry-latency optimization targets the measured slice, not a guess.
  const t0 = Date.now();
  let tGates = 0;
  let tQuote = 0;
  // IN-FLIGHT CLAIM, taken before ANY async work. The gate's "already held"
  // check is read-then-write: two concurrent calls for the same signal both
  // pass it before either has inserted a row, and unlike paper the DB cannot
  // arbitrate — live's row is written AFTER the on-chain swap, so a unique
  // index would strand real tokens. grimace opened TWICE at $2.00 (real
  // capital, one decision) exactly this way. The claim is process-local, which
  // is sufficient: every live buy flows through this one function in this one
  // daemon — and the single-daemon invariant is now actively enforced at
  // startup after the duplicate-daemon incident.
  if (liveBuyInFlight.has(mint)) {
    await audit("live_buy_skipped", { mint, reason: "buy already in flight (claim race)" }).catch(() => {});
    return;
  }
  liveBuyInFlight.add(mint);
  try {
    // LATENCY: live trailed paper's entry by a measured 6–8s, and that lag
    // propagates straight to the exit (THUNDERCAT: paper out at 1.018×, live 7s
    // later at $0.00). The SOL price and balance reads are independent of the
    // gate, so warm them CONCURRENTLY with it instead of serially afterwards —
    // the gate's own sell-route probe is a network round trip we no longer wait
    // to finish before the other two have even started.
    const solP = solPriceUsd(cfg).catch(() => null);
    const balP = liveBalance(cfg).catch(() => null);
    // SUB-FLOOR TICKET (ratified 2026-07-25): when a sub-floor candidate
    // carries a deep clean crowd, live enters at ticket size instead of
    // refusing — set by either door below, applied at sizing.
    let subFloorTicket = false;
    // BUILD-BACK TICKET (ratified 2026-07-27): build-back mode caps size at
    // the ticket instead of refusing in-envelope flow — set below, applied at
    // sizing alongside subFloorTicket.
    let buildBackTicket = false;
    // RECOVERED-tier flag (2026-07-27): read by the strand-class exit
    // pre-check — 10 of the 14 live_unsellable write-offs (−$33.82/48h)
    // entered through this tier.
    let recoveredTier = false;
    // GOLDEN LANE (operator 2026-07-27: "Yes we open the Golden Lane, the
    // moons are there" — the 4162× AFTER card): an L3+ relaunch pierces the
    // strong-only build-back floor at TICKET size. L2 and unknowns still
    // refuse; everything else still needs measured strong while building back.
    let goldenWindow = false;
    // REFUSED CLASSES. Paper will not open RUG_RISK at all — 36.1% rug, and it
    // reaches 5× exactly 0% of the time — but the live path never consulted the
    // profile, so live was trading the single class paper refuses. A 1:1 lane
    // cannot take trades the reference lane declines.
    if (sig && !profileOf(sig.signature).trade) {
      // RUG_RISK FORMULA ROUTE (ratified 2026-07-24 pipe census): crowd-PASS +
      // in-envelope RUG_RISK ran 78% win / 1.70× avg offer — the formula
      // arbitrates the cell, not the stale 36.1%-era veto. Only the qualified
      // cell proceeds on live (the F1/F3 gates below re-verify); size inherits
      // paper's half clip via the mirror fraction.
      const rrCrowd =
        sig.walletWinnerHits != null && sig.walletRugHits != null &&
        sig.walletWinnerHits >= 1 && sig.walletWinnerHits - sig.walletRugHits >= 1;
      const rrLg = sig.liqGrowth != null && Number.isFinite(Number(sig.liqGrowth)) ? Number(sig.liqGrowth) : null;
      const rrInEnvelope = rrLg != null && rrLg >= cfg.INFLOW_FLOOR && rrLg <= cfg.INFLOW_CEILING;
      const rrSubfloorCrowd =
        cfg.SUBFLOOR_TICKET_ENABLED && rrCrowd && rrLg != null && rrLg < cfg.INFLOW_FLOOR &&
        (sig.walletWinnerHits ?? 0) >= cfg.SUBFLOOR_TICKET_MIN_WH && (sig.walletRugHits ?? 0) === 0;
      if (cfg.RUGRISK_FORMULA_ROUTE && sig.signature === "RUG_RISK" && rrCrowd && rrInEnvelope) {
        await audit("live_rugrisk_formula", {
          mint,
          walletWinnerHits: sig.walletWinnerHits,
          walletRugHits: sig.walletRugHits,
          inflow: rrLg,
          reason: "crowd-PASS + in-envelope RUG_RISK — formula overrides the stale veto, half clip via mirror fraction",
        });
      } else if (cfg.LIVE_SUBFLOOR_DOOR && cfg.RUGRISK_FORMULA_ROUTE && sig.signature === "RUG_RISK" && rrSubfloorCrowd) {
        // Door 2 of 2, closed by the same switch. This one needs no explicit
        // refusal branch — a closed door falls through to the `else` below,
        // which already audits live_buy_skipped and returns.
        // SUB-FLOOR TICKET, door 2 (ratified 2026-07-25): the session's home
        // band — paper's half-clips ran the richest lane of the night here.
        subFloorTicket = true;
        await audit("live_subfloor_ticket", {
          mint,
          door: "RUG_RISK",
          walletWinnerHits: sig.walletWinnerHits,
          walletRugHits: sig.walletRugHits,
          inflow: rrLg,
          reason: `sub-floor RUG_RISK with ${sig.walletWinnerHits}W/0R crowd — ticket-size confirmation entry`,
        });
      } else {
        await audit("live_buy_skipped", { mint, reason: `${sig.signature} — class is not traded${cfg.RUGRISK_FORMULA_ROUTE && sig.signature === "RUG_RISK" ? " (RUG_RISK not formula-qualified: needs crowd-PASS + in-envelope)" : ""}` });
        return;
      }
    }
    // ── THE CONCENTRATION GATES (operator directive 2026-07-22) ─────────────
    // Live deploys real capital only into the audit-proven lanes, only with
    // evidence. Paper keeps trading everything as the zero-cost sensor.
    const blocked = new Set(cfg.LIVE_CLASS_BLOCKLIST.split(",").map((s) => s.trim()).filter(Boolean));
    if (sig && blocked.has(sig.signature)) {
      // FUNNEL OVERRIDES THE BLANKET (operator, 2026-07-23: "we should only
      // ever take the trades that now qualify"). The class ban predates the
      // scrubbed pipeline; Barney (BASE, strong inflow 1.36×, in-sweetspot
      // 1.82× trigger) rode 6.61× for +$31.22 on paper while the ban ate the
      // live seat — and today's ADMISSIBLE BASE cohort ran 12-for-12 +$43.33.
      // A blocklisted class now passes when the candidate qualifies on the
      // funnel's own terms (strong inflow OR winner-rep crowd); every waiver
      // is audited so the blanket-vs-funnel question stays measurable.
      const admissible =
        (sig.walletWinnerHits != null && sig.walletRugHits != null && sig.walletWinnerHits - sig.walletRugHits >= 1) ||
        (sig.liqGrowth != null && sig.liqGrowth >= cfg.LIQ_INFLOW_STRONG);
      if (!admissible) {
        await audit("live_buy_skipped", { mint, reason: `${sig.signature} — dead lane, live-blocked by operator order (not funnel-admissible)` });
        return;
      }
      await audit("live_class_block_waived", {
        mint,
        signature: sig.signature,
        inflow: sig.liqGrowth ?? null,
        walletWinnerHits: sig.walletWinnerHits ?? null,
        walletRugHits: sig.walletRugHits ?? null,
        reason: "funnel-admissible (strong inflow or winner-rep) — class blanket waived per operator principle",
      });
    }
    // ── THE WINNER-REP RECEIVER (operator, 2026-07-23: "open the live
    // receiver") ─────────────────────────────────────────────────────────────
    // A winner-rep crowd (net rep ≥ +1) IS the evidence the other gates exist
    // to approximate: 48h paper 82–89% win / 47% capture, and the wallet graph
    // out-discriminates stars, class regime, and the inflow floor on this
    // cohort. So winner-rep clears at the same bar paper does — it bypasses
    // the regime bench, the inflow floor, and the stars bar below. Every hard
    // safety rail still applies: kill switches, exposure caps, depth floor,
    // clone-wave, anti-gate, crowd gate, honeypot.
    // ── 1:1 MIRROR (operator 2026-07-31): paper already decided this trade ────
    // This flag already waives exactly the three gates paper has no equivalent
    // of — the regime class gate, the inflow band, and the stars bar — and it
    // was already firing on 61% of live entries via a net-of-one-wallet test.
    // That made the bands SELECTIVELY non-binding, which is the worst of both:
    // they refused enough to distort the traded distribution (the skipped
    // cohort measured BETTER than the funded one) while admitting 70% of
    // entries below our own 1.25 bar anyway.
    //
    // Under mirror they stop binding UNIFORMLY. Solvency, executability,
    // routed-only and the plug-in allowlist (which keeps MOON_STEADY out) all
    // still apply. Every waived gate still writes its audit row so acceptance
    // stays measurable against paper.
    const mirrorEntry = cfg.LIVE_MIRROR_PAPER_ENTRY && sig != null;
    const winnerRepCrowd =
      mirrorEntry ||
      (sig?.walletWinnerHits != null && sig?.walletRugHits != null && sig.walletWinnerHits - sig.walletRugHits >= 1);
    // ══ STRATEGY GATE LAYER, REGION 1 of 2 (see LIVE_STRATEGY_GATES) ═════════
    // Everything inside this block is a SELECTION opinion — the layer measured
    // at +$1,205 refused vs −$173 taken. Skipped wholesale when the flag is off;
    // the executability and solvency rails below are deliberately OUTSIDE it.
    if (cfg.LIVE_STRATEGY_GATES) {
    // ── REGIME CLASS GATE ────────────────────────────────────────────────────
    // The market is regime-centric (operator, 2026-07-22): CLIMBER went green
    // in the very window after the static audit blocked it. So live capital
    // follows the REGIME with evidence: a class is admitted when its trailing
    // paper tape (the free 24/7 sensor) is profitable at real sample size, and
    // benched when it is not. Below min sample, the audit's proven core
    // (RISER / MOON_FAST / MOON_STEADY / MOON_SLOW) trades on its priors and
    // everything else waits for paper to prove the turn. A benched class was
    // mostly the unknown-crowd rugs now refused upstream — winner-rep rides.
    if (sig && cfg.LIVE_REGIME_CLASS_GATE && !winnerRepCrowd) {
      const health = await classRegimeHealth(cfg, sig.signature);
      if (!health.allowed) {
        await audit("live_buy_skipped", { mint, reason: `${sig.signature} — regime gate: ${health.why}` });
        return;
      }
    }
    // ── INFLOW BAND GATE ─────────────────────────────────────────────────────
    // Concentrate live capital in the measured high-probability band: pool
    // inflow ≥1.30× at trigger wins 71.2% vs 44.8% below (rugs 11% vs 36%),
    // and the 2×+ surge band ran 18-for-18 this week. A missing reading does
    // not veto — absence of measurement is not evidence of weakness — but a
    // MEASURED weak inflow is exactly the coin-flip cohort live cannot afford.
    // (Winner-rep crowds exempt: inside 1.05–1.30 they ran 70%/12% vs the
    // band's 29%/58% fakes — the crowd is the finer instrument.)
    if (sig && !winnerRepCrowd && sig.liqGrowth != null && sig.liqGrowth < cfg.LIVE_MIN_INFLOW) {
      await audit("live_buy_skipped", {
        mint,
        reason: `inflow ${sig.liqGrowth.toFixed(2)}× below the ${cfg.LIVE_MIN_INFLOW}× band (71% vs 45% win)`,
      });
      return;
    }
    } // ══ end strategy region 1 ═══════════════════════════════════════════════

    // ── POOL-DEPTH FLOOR ── KEPT: EXECUTABILITY, NOT STRATEGY ────────────────
    // This is the one question paper never has to answer: can we get OUT at
    // size? A pool below the floor has no exit, whatever the signals say.
    // BBC 616f: a $3k dust pool cleared every signal gate mid-rug; live filled
    // at the collapsed price and the position never had an exit at size. The
    // freshest tick's liquidity is the exit-side question the signals don't ask.
    let dbcTicket = false;
    let dbcPoolLiq: number | null = null;
    {
      const [lt] = await db
        .select({ liq: candidateTicks.liquidityUsd })
        .from(candidateTicks)
        .where(eq(candidateTicks.mint, mint))
        .orderBy(desc(candidateTicks.id))
        .limit(1);
      const liqNow = lt?.liq != null ? Number(lt.liq) : null;
      // Smart-money-warm crowds (4.2% rug cohort) earn the lower floor: at $4-6
      // size the impact math clears a $2.5k pool easily, and the wallet graph
      // out-discriminates depth as a rug tell (Chillmothy, 2026-07-22).
      const smWarm =
        sig?.walletWinnerHits != null && sig.walletWinnerHits >= 2 && sig.walletWinnerHits - (sig.walletRugHits ?? 0) >= 1;
      const depthFloor = smWarm ? cfg.LIVE_MIN_ENTRY_LIQ_SM_USD : cfg.LIVE_MIN_ENTRY_LIQ_USD;
      if (liqNow != null && liqNow < depthFloor) {
        // ── DBC MOON TICKET — the bounded door into the moon factory ─────────
        // 79% of witnessed 10x+ moons launch on meteora-dbc with pools the
        // depth floor refuses. An ADMISSIBLE dbc candidate (strong inflow or
        // winner-rep, MOON/RISER routed) boards at micro-ticket size instead
        // of being turned away; everything else still hits the floor.
        const admissible =
          winnerRepCrowd || (sig?.liqGrowth != null && sig.liqGrowth >= cfg.LIQ_INFLOW_STRONG);
        const classOk = sig != null && (sig.signature === "RISER" || sig.signature.startsWith("MOON"));
        if (
          cfg.LIVE_DBC_TICKET_ENABLED &&
          admissible &&
          classOk &&
          liqNow >= cfg.LIVE_DBC_TICKET_MIN_LIQ_USD
        ) {
          const [t] = (await db.execute(sql`
            SELECT tk.dex,
              (SELECT count(*)::int FROM positions p JOIN tokens t2 ON t2.mint = p.mint
                WHERE p.lane = 'live' AND p.status = 'open' AND t2.dex = 'meteora-dbc') AS opencnt,
              (SELECT coalesce(sum(p.size_usd::float), 0) FROM positions p JOIN tokens t2 ON t2.mint = p.mint
                WHERE p.lane = 'live' AND t2.dex = 'meteora-dbc'
                  AND p.opened_at >= date_trunc('day', now())) AS spenttoday,
              (SELECT count(*)::int FROM candidate_outcomes co JOIN tokens t3 ON t3.mint = co.mint
                WHERE lower(t3.dex) = 'meteora-dbc' AND co.label IN ('winner','dud','rug')
                  AND co.updated_at >= now() - interval '24 hours') AS tide_n,
              (SELECT count(*)::int FROM candidate_outcomes co JOIN tokens t3 ON t3.mint = co.mint
                WHERE lower(t3.dex) = 'meteora-dbc' AND co.label = 'rug'
                  AND co.updated_at >= now() - interval '24 hours') AS tide_rugs
            FROM tokens tk WHERE tk.mint = ${mint}`)) as unknown as
            { dex: string | null; opencnt: number; spenttoday: number; tide_n: number; tide_rugs: number }[];
          if (t?.dex === "meteora-dbc") {
            // RUG-TIDE STAND-DOWN (operator "plug the gaps", 2026-07-27): when
            // the venue itself is running at auto-farm rug share (24h paper:
            // dbc rugs −$69.96 vs winners +$30.09, n=27 rugs), the moon door
            // waits out the tide. Same thresholds the auto-farm blacklist uses;
            // clears itself the day the venue's rug share drops.
            const tideN = Number(t.tide_n) || 0;
            const tideRugs = Number(t.tide_rugs) || 0;
            if (tideN >= cfg.FARM_AUTO_MIN_N && tideRugs / tideN >= cfg.FARM_AUTO_RUG_RATE) {
              await audit("live_buy_skipped", {
                mint,
                reason: `dbc ticket: venue rug tide ${tideRugs}/${tideN} (${Math.round((100 * tideRugs) / tideN)}% ≥ ${Math.round(cfg.FARM_AUTO_RUG_RATE * 100)}%) — moon door waits out the tide`,
              });
              return;
            }
            if (Number(t.opencnt) >= cfg.LIVE_DBC_TICKET_MAX_CONCURRENT) {
              await audit("live_buy_skipped", { mint, reason: `dbc ticket: ${t.opencnt} already riding (cap ${cfg.LIVE_DBC_TICKET_MAX_CONCURRENT})` });
              return;
            }
            if (Number(t.spenttoday) + cfg.LIVE_DBC_TICKET_USD > cfg.LIVE_DBC_TICKET_DAILY_BUDGET_USD) {
              await audit("live_buy_skipped", { mint, reason: `dbc ticket: daily budget spent ($${Number(t.spenttoday).toFixed(2)}/$${cfg.LIVE_DBC_TICKET_DAILY_BUDGET_USD})` });
              return;
            }
            dbcTicket = true;
            dbcPoolLiq = liqNow;
            await audit("live_dbc_ticket", {
              mint,
              pool: Math.round(liqNow),
              via: winnerRepCrowd ? "winner-rep" : "strong-inflow",
              signature: sig?.signature ?? null,
            });
          }
        }
        if (!dbcTicket) {
          await audit("live_buy_skipped", {
            mint,
            reason: `pool ${Math.round(liqNow)} below the ${depthFloor} depth floor${smWarm ? " (smart-money floor)" : ""} — no exit at size`,
          });
          return;
        }
      }
    }
    // ── THE FORMULA MANIFEST (operator-ratified 2026-08-02) ──────────────────
    // Paper is the laboratory; live inherits the ratified winning architecture.
    // Two tiers from the rug-adjusted combination sweep (formula-combo.ts):
    // ELITE (+$5.89/t adj, canon-era replicated) and canon FILLER (5% dead
    // cohort). Venue verdicts carry the 2026-08-02 architecture fence — the
    // pre-fix unsellable tape does not convict the fixed lane, so damm-v2
    // re-qualifies through the filler tier under clean fills. Every refusal
    // audits with both tiers' reasons; the counterfactual watch reads them.
    let manifestTier: "elite" | "filler" | null = null;
    let manifestWeight = 1;
    if (cfg.FORMULA_MANIFEST_ENABLED) {
      const manifest = await loadManifest();
      if (manifest) {
        const [tk] = await db.select({ dex: tokens.dex }).from(tokens).where(eq(tokens.mint, mint)).limit(1);
        const v = manifestVerdict(manifest, {
          signature: sig?.signature ?? null,
          secondLaunch: (sig?.launchOrder ?? 1) >= 2,
          // R2 (admission court) — P1-2 REWRITE (QA, 2026-08-06).
          // The previous read took the newest candidate_tick whose liquidity
          // merely FELL INSIDE a plausible band: no age bound, no pair binding,
          // no quote verification. A stale tick from a different pool could
          // satisfy today's admission floor, and a plausible-looking fake
          // ($10k) passed as easily as a real one. That is a numeric filter,
          // not a trust boundary.
          //
          // Admission now consumes THE SAME observation that selected the pool:
          // fetchTokenMarket applies quote-depth selection, so `liquidityUsd`
          // is the chosen pool's, and `depthTrusted` says whether any pool for
          // this mint held a credible quote reserve at all. Fetch failure →
          // null → the floor abstains (absence of measurement is not evidence).
          ...(await (async () => {
            const m = await fetchTokenMarket(mint).catch(() => null);
            return m == null
              ? { poolUsd: null }
              : { poolUsd: m.liquidityUsd, poolDepthTrusted: m.depthTrusted };
          })()),
          inflow: sig?.liqGrowth != null && Number.isFinite(Number(sig.liqGrowth)) ? Number(sig.liqGrowth) : null,
          buyShare: sig?.triggerBuyShare != null && Number.isFinite(Number(sig.triggerBuyShare)) ? Number(sig.triggerBuyShare) : null,
          winnerHits: sig?.walletWinnerHits ?? null,
          rugHits: sig?.walletRugHits ?? null,
          venue: tk?.dex ?? null,
        });
        if (v.kind === "refuse") {
          await audit("live_buy_skipped", { mint, reason: v.reason });
          return;
        }
        if (v.kind === "seat") {
          manifestTier = v.tier;
          manifestWeight = v.weight;
          await audit("live_manifest_seat", {
            mint,
            tier: v.tier,
            weight: v.weight,
            manifestVersion: v.version,
            signature: sig?.signature ?? null,
            reason: `manifest v${v.version} ${v.tier} seat — genome weight ×${v.weight.toFixed(2)}`,
          });
        }
        // kind === "no-manifest" cannot reach here (manifest was non-null)
      }
    }
    // ══ STRATEGY GATE LAYER, REGION 2 of 2 (see LIVE_STRATEGY_GATES) ═════════
    // Clone-wave, wallet-graph anti-gate, F1 formula/crowd, RECOVERED tier and
    // its cliff-safe door, sub-floor doors, build-back, golden window, trigger
    // and sensor seats, buy-share floor, signature allowlist, stars bar. Every
    // one is a selection opinion; none of them asks whether the trade can be
    // executed or afforded. All seven exception doors live in here too, and go
    // with the gates — a door exists only to punch back through a gate.
    if (cfg.LIVE_STRATEGY_GATES) {
    // ── CLONE-WAVE GATE (live only) ──────────────────────────────────────────
    // Bear Ripper ×2 (2026-07-22): same ticker relaunched minutes after its
    // sibling rugged; both live entries died −$4 unsellable while the paper
    // clone-wave cohort ran net POSITIVE (+$68, 68% win, 48h) — paper can mark-
    // sell, real capital cannot exit a drained pool. So live refuses a ticker
    // whose sibling rugged in the last hour or is still open live; paper keeps
    // exploring the wave and earns the sensor data.
    if (symbol) {
      const [wave] = (await db.execute(sql`
        SELECT 1 FROM positions p JOIN tokens t ON t.mint = p.mint
        WHERE t.symbol = ${symbol} AND p.mint <> ${mint}
          AND ((p.status = 'closed' AND p.closed_at > now() - interval '60 minutes'
                AND (p.exit_reason IN ('dust_rug','live_unsellable','delisted')
                     OR p.realized_pnl_usd::float <= -0.8 * p.size_usd::float))
               OR (p.status = 'open' AND p.lane = 'live'))
        LIMIT 1`)) as unknown as unknown[];
      if (wave) {
        // GOLDEN WINDOW (operator 2026-07-26: "Open the golden window door"):
        // launches 3-4+ of a ticker are the measured golden cell (+19.5¢/$;
        // paper's relaunch probes ran 75% win / +$4.27 over the last 24h while
        // live refused them all). A relaunch with F6 launch order ≥3 now
        // boards at TICKET size; launch #2 (the adversary's re-harvest,
        // −2.3¢/$) and unknown orders stay refused.
        const lo = sig?.launchOrder ?? null;
        if (lo != null && lo >= 3) {
          subFloorTicket = true;
          goldenWindow = true;
          await audit("live_golden_window", {
            mint,
            symbol,
            launchOrder: lo,
            reason: `golden window: launch #${lo} of ${symbol} — relaunch boards at ticket size (L3-4 +19.5¢/$; paper relaunch probes 75% win/24h)`,
          });
        } else {
          await audit("live_buy_skipped", {
            mint,
            reason: `clone wave: ${symbol} rugged or still open on another mint <60m, launch order ${lo ?? "unknown"} — live refuses (golden window opens at L3+)`,
          });
          return;
        }
      }
    }
    // ── WALLET-GRAPH ANTI-GATE ───────────────────────────────────────────────
    // 7d study (n=9,771 armed+labeled): holder sets whose known wallets net out
    // NEGATIVE (more rug history than winner history) ran 9.6% win / 49.3% rug /
    // 4.1% moon-3× — the worst measured cohort, half the tape. A MEASURED bad
    // crowd is exactly what real capital refuses; an unknown crowd passes.
    if (sig && sig.walletWinnerHits != null && sig.walletRugHits != null && sig.walletWinnerHits - sig.walletRugHits <= -1) {
      await audit("live_buy_skipped", {
        mint,
        reason: `wallet graph: net rep ${sig.walletWinnerHits - sig.walletRugHits} — rug-history crowd (49% rug vs 10% win cohort)`,
      });
      return;
    }
    // ── FORMULA v2 GATE — F1 CROWD, ALL BANDS (ratified 2026-07-24) ─────────
    // Canon GCE-FORMULA-001 + model run: crowd-pass (wh ≥ 1 AND wh > rh) ran
    // $1.29/trade at 5% dead in the signature era vs crowd-fail's $0.28 at
    // 14% — and live's ENTIRE loss history (168 trades, −$128.82, 21% dead)
    // is the crowd-fail cohort. Live is the exploit lane: SENSOR-tier flow
    // (crowd-fail) trades as paper probes only, never real capital. Also F3:
    // inflow above the ceiling is the manufactured-spike envelope — the 07-23
    // atomic wave's costume.
    if (sig) {
      // STRONG-ONLY BUILD-BACK (operator 2026-07-27, wallet at $109): while
      // LIVE_INFLOW_FLOOR > INFLOW_FLOOR, live boards MEASURED strong inflow
      // only — the 94-100%-win / 0-12%-rug band (9.4¢/$ 3d) — and every
      // exception (sub-floor tickets, moonshots, golden-window relaunches)
      // waits. Unmeasured inflow refuses too: strong must be measured.
      // Exit the mode by lowering LIVE_INFLOW_FLOOR once the balance rebuilds.
      if (cfg.LIVE_INFLOW_FLOOR > cfg.INFLOW_FLOOR && !goldenWindow) {
        const lgBB = sig.liqGrowth != null ? Number(sig.liqGrowth) : null;
        if (lgBB == null || !Number.isFinite(lgBB)) {
          await audit("live_buy_skipped", {
            mint,
            reason: `build-back mode: inflow unmeasured — measured flow only until the balance rebuilds`,
          });
          return;
        }
        if (lgBB < cfg.LIVE_INFLOW_FLOOR && lgBB >= cfg.INFLOW_FLOOR) {
          // BUILD-BACK TICKET (ratified 2026-07-27): the binary refusal below
          // the strong floor skipped 68 mints at 76% would-have-won (+$21.40
          // CF/48h at ticket size) — procyclical: losses tightened the gate
          // that skips the winners that rebuild the balance. In-envelope
          // measured flow now pays TICKET money instead of refusing; every
          // downstream gate (crowd, seat, depth, mirror) still applies.
          // Sub-envelope (<INFLOW_FLOOR) falls through to the sub-floor doors,
          // which already ticket-or-refuse on crowd depth.
          buildBackTicket = true;
          await audit("live_buildback_ticket", {
            mint,
            inflow: lgBB,
            reason: `build-back mode: in-envelope inflow ${lgBB.toFixed(2)}× below the strong ${cfg.LIVE_INFLOW_FLOOR}× floor — ticket size instead of refusal (68-skip/76%-win counterfactual, ratified 2026-07-27)`,
          });
        }
      }
      const wh = sig.walletWinnerHits;
      const rh = sig.walletRugHits;
      const crowdPass = wh != null && rh != null && wh >= 1 && wh - rh >= 1;
      // MOON SHOT (ratified 2026-07-24: "these are the shots we should be
      // taking... the Math outweighs a pass"): a 2★ MOON-class candidate
      // fires in BOTH lanes at slot size even with an unproven crowd — the
      // fingerprint + conviction is the qualification, the slot cap and exit
      // chain bound the rug. Seat discipline below still declines >1.65.
      const moonShot =
        cfg.MOONSHOT_TIER_ENABLED && sig.stars === 2 &&
        typeof sig.signature === "string" && sig.signature.startsWith("MOON") &&
        !(sig.triggerMultiple != null && Number(sig.triggerMultiple) > cfg.CONVICTION_SEAT_MAX);
      if (moonShot && !crowdPass) {
        await audit("live_moonshot_tier", {
          mint,
          walletWinnerHits: wh ?? null,
          walletRugHits: rh ?? null,
          inflow: sig.liqGrowth ?? null,
          reason: "2★ moon fingerprint — SHOT fires live at slot size (crowd unproven; alert cohort 11/20 winners)",
        });
      } else if (!crowdPass) {
        await audit("entry_crowd_unknown_refused", {
          mint,
          lane: "live",
          inflow: sig.liqGrowth ?? null,
          walletWinnerHits: wh ?? null,
          walletRugHits: rh ?? null,
          reason: `crowd ${wh ?? "?"}W/${rh ?? "?"}R — F1 requires winners aboard and outnumbering (crowd-fail: $0.28/t, 14% dead; live fail-cohort −$128.82 all-time)`,
        });
        return;
      }
      // RECOVERED TIER (ratified 2026-07-24): winner hits are now net-positive
      // wallets — a crowd with NO never-rugged winner passes F1 but at the
      // reduced clip (inherited from paper via paperFrac). Audited so the
      // counterfactual watch can split PRECISION vs RECOVERED cohorts.
      if (sig.walletStrictHits === 0) {
        recoveredTier = true;
        // RECOVERED-TIER DEMOTION (2026-07-27/28, venue-wide) with SUPERVISED
        // RETRIAL (operator "Re-admit and unbench", 2026-07-28 hunt window):
        // the cohort was convicted on drains that predate the full armor
        // stack. When RECOVERED_READMIT_TICKETS > 0, up to that many boardings
        // per day re-enter at TICKET size under strand probe + drain guard +
        // ws live-first + 3× flee + late-arm ladder; every boarding audited
        // as live_recovered_readmit so the retrial scores cleanly. At 0 (the
        // default) the demotion is fully closed.
        if (cfg.RECOVERED_READMIT_TICKETS > 0) {
          const [rc] = (await db.execute(sql`
            SELECT count(*)::int n FROM audit_log
            WHERE action = 'live_recovered_readmit' AND created_at >= date_trunc('day', now())`)) as unknown as { n: number }[];
          if ((rc?.n ?? 0) >= cfg.RECOVERED_READMIT_TICKETS) {
            await audit("live_buy_skipped", {
              mint,
              reason: `RECOVERED retrial cap reached (${cfg.RECOVERED_READMIT_TICKETS}/night) — demotion holds for the rest of the day`,
            });
            return;
          }
          subFloorTicket = true; // ticket size, never the sizer's full clip
          await audit("live_recovered_readmit", {
            mint,
            walletWinnerHits: wh ?? null,
            walletRugHits: rh ?? null,
            reason: `RECOVERED supervised retrial ${(rc?.n ?? 0) + 1}/${cfg.RECOVERED_READMIT_TICKETS} — ticket size under full armor (operator word 2026-07-28)`,
          });
        } else {
          // ── THE CLIFF-SAFE DOOR (operator 2026-07-29: "Lets open the cliff
          // safe pools now. Live wallet needs attempts at bat.") ────────────
          // The demotion convicted this tier on drains — but the recovery-
          // cliff study (130 protective exits) says the drain only wins BELOW
          // the cliff: fire with the pool over $12k and we keep 95%. So the
          // tier reopens exactly where the physics protect us: entry pool ≥
          // LIVE_UNLOCKED_LP_MIN_POOL_USD ($16k → the −25% drain alarm still
          // rings above the $12k/95% line), at TICKET size, under the full
          // armor (sniper chambered, strand probe, drain guard on chain
          // truth, basis-first, floor_45, late-arm ladder). Sub-cliff
          // RECOVERED stays paper-only — that is where the farm actually ate
          // us. Audited as live_cliffsafe_readmit so the cohort scores on its
          // own line.
          const [ct] = (await db.execute(sql`
            SELECT liquidity_usd::float liq FROM candidate_ticks WHERE mint = ${mint}
            ORDER BY snapped_at DESC LIMIT 1`)) as unknown as { liq: number | null }[];
          const poolNow = ct?.liq != null && Number.isFinite(Number(ct.liq)) ? Number(ct.liq) : null;
          // ── DOOR CLOSED (operator 2026-08-02: "close the cliff-safe door") ──
          // The premise above was that entry pool depth predicts survivability:
          // fire above the cliff and the physics protect us. Live receipts say
          // it does not. JORDAN #7110 entered through this door at pool $19,991
          // — a quarter above the $16k bar — and the route stopped quoting it
          // 12 SECONDS later; feed liquidity reached $0 within two minutes.
          // Depth at entry was a quarter-million dollars of reassurance that
          // bought twelve seconds.
          //
          // The tier's own record, per the comment at the RECOVERED flag above:
          // 10 of 14 live_unsellable write-offs (−$33.82/48h) came through here.
          // JORDAN makes it 11 of 15.
          //
          // An explicit branch rather than gating the `if` below: that `else`
          // reports "below the cliff", which would be a false reason for a
          // candidate refused while sitting ABOVE it.
          if (!cfg.LIVE_CLIFFSAFE_DOOR) {
            await audit("live_buy_skipped", {
              mint,
              poolUsd: poolNow == null ? null : Math.round(poolNow),
              walletWinnerHits: wh ?? null,
              walletRugHits: rh ?? null,
              reason: `cliff-safe door CLOSED — RECOVERED tier is paper-only regardless of entry pool (${poolNow == null ? "unknown" : "$" + Math.round(poolNow).toLocaleString()}); entry depth did not predict survivability (11 of 15 unsellable write-offs entered here)`,
            });
            return;
          }
          if (poolNow != null && poolNow >= cfg.LIVE_UNLOCKED_LP_MIN_POOL_USD) {
            subFloorTicket = true; // ticket size, never the sizer's full clip
            await audit("live_cliffsafe_readmit", {
              mint,
              poolUsd: Math.round(poolNow),
              walletWinnerHits: wh ?? null,
              walletRugHits: rh ?? null,
              reason: `RECOVERED tier admitted through the CLIFF-SAFE door — pool $${Math.round(poolNow).toLocaleString()} ≥ $${cfg.LIVE_UNLOCKED_LP_MIN_POOL_USD.toLocaleString()} keeps the drain alarm above the 95%-recovery line (operator word 2026-07-29)`,
            });
          } else {
            await audit("live_buy_skipped", {
              mint,
              reason: `RECOVERED tier below the cliff (pool ${poolNow == null ? "unknown" : "$" + Math.round(poolNow).toLocaleString()} < $${cfg.LIVE_UNLOCKED_LP_MIN_POOL_USD.toLocaleString()}) — paper-only where the drain farm actually wins`,
            });
            return;
          }
        }
      }
      // Sub-floor MOON SHOT (operator 2026-07-25): the shot still fires, but a
      // MEASURED inflow below the floor pays ticket money, not slot money —
      // paper's mild band ran −$44/24h at slot scale vs +$16 at probe scale,
      // and this door was lifting sub-floor 2★ moons to full slots unchecked.
      if (moonShot && sig.liqGrowth != null && sig.liqGrowth < cfg.INFLOW_FLOOR) {
        // DOOR CLOSED (operator 2026-08-01, "close the sub-floor door"). The
        // first live attempt after arming came through here at inflow 1.198×,
        // below the 1.2× floor and well below the 1.25× admission bar — and the
        // door cohorts measured P&L-negative across the board in 697a8d7.
        //
        // It REFUSES, it does not merely drop the ticket flag: without the flag
        // the candidate would fall through to NORMAL sizing and enter a
        // sub-floor moon at FULL SLOT, which is strictly worse than the door we
        // are closing. Refusals stay audited so the counterfactual is measurable.
        if (!cfg.LIVE_SUBFLOOR_DOOR) {
          await audit("live_buy_skipped", {
            mint, door: "MOONSHOT", inflow: sig.liqGrowth, floor: cfg.INFLOW_FLOOR,
            walletWinnerHits: sig.walletWinnerHits, walletRugHits: sig.walletRugHits,
            reason: `sub-floor door CLOSED — 2★ moon inflow ${sig.liqGrowth.toFixed(2)}× below the ${cfg.INFLOW_FLOOR}× floor; refused rather than ticket-sized`,
          });
          return;
        }
        subFloorTicket = true;
        await audit("live_subfloor_ticket", {
          mint,
          door: "MOONSHOT",
          walletWinnerHits: sig.walletWinnerHits ?? null,
          walletRugHits: sig.walletRugHits ?? null,
          inflow: sig.liqGrowth,
          reason: `2★ moon with inflow ${sig.liqGrowth.toFixed(2)}× below the ${cfg.INFLOW_FLOOR}× floor — shot fires at ticket size (mild slot-scale bleed)`,
        });
      }
      if (!moonShot && sig.liqGrowth != null && (sig.liqGrowth > cfg.INFLOW_CEILING || sig.liqGrowth < cfg.INFLOW_FLOOR)) {
        // SUB-FLOOR TICKET, door 1 (ratified 2026-07-25): below the floor
        // with a deep clean crowd aboard, live takes a ticket instead of
        // refusing — 22 of 31 refusals in the copy-gap window were this cell.
        // Above the ceiling (manufactured spike) still refuses outright.
        const subfloorCrowd =
          cfg.SUBFLOOR_TICKET_ENABLED && sig.liqGrowth < cfg.INFLOW_FLOOR &&
          (sig.walletWinnerHits ?? 0) >= cfg.SUBFLOOR_TICKET_MIN_WH && (sig.walletRugHits ?? 0) === 0;
        if (subfloorCrowd) {
          subFloorTicket = true;
          await audit("live_subfloor_ticket", {
            mint,
            door: "F3",
            walletWinnerHits: sig.walletWinnerHits,
            walletRugHits: sig.walletRugHits,
            inflow: sig.liqGrowth,
            reason: `sub-floor inflow ${sig.liqGrowth.toFixed(2)}× with ${sig.walletWinnerHits}W/0R crowd — ticket-size confirmation entry`,
          });
        } else {
          await audit("live_buy_skipped", {
            mint,
            reason:
              sig.liqGrowth > cfg.INFLOW_CEILING
                ? `inflow ${sig.liqGrowth.toFixed(2)}× above the ${cfg.INFLOW_CEILING}× envelope — manufactured-spike territory (F3)`
                : `inflow ${sig.liqGrowth.toFixed(2)}× below the ${cfg.INFLOW_FLOOR}× floor — sub-envelope crowd-pass ran −$0.81/t at size (F3 floor, ratified; paper probes it)`,
          });
          return;
        }
      }
      // ARM SPEC (ratified 2026-07-24): live fires the CONVICTION seat only
      // (1.2–1.65 — 83% win / $2.51/t). The 1.65–2.05 sensor slice measured
      // −$1.01/t at size; paper probes it, real capital declines it.
      //
      // STRONG-SEAT EXTENSION (ratified 2026-07-27, strong-seat-study.ts 7d):
      // inside MEASURED-strong inflow (lg ≥ 1.30) the late trigger is not a
      // chase — the strong pool is still filling. The 1.66–1.95 slice ran
      // n=489 · 74% win / 13% rug · avg peak 6.19× · paper +$148.59 (5.4¢/$),
      // the band's volume pipe (~2.9/h) live's ceiling was declining wholesale.
      // Sub-strong keeps the 1.65 ceiling. Scoreboard: live must hold ≥4¢/$
      // over the first 30 extended-slice fills.
      // STRONG-SEAT EXTENSION CLOSED (operator 2026-07-27, scoreboard read at
      // fill 1 of 30): 7 admissions in 7h → all 5 paper-winners skipped
      // (sub-viable sizer) or buy-failed; the only FILL was a MOON_VIOLENT rug,
      // −100% in 20s via the dbc-ticket sizing seam. Adverse execution
      // selection: this cell fills only in the hot moments that are rugs.
      // Paper's crowd-net read agreed (−1.6¢/$, n=166). The 1.66–1.95×@strong
      // slice returns to DECLINE; the 1.96–2.05×@strong sensor seat below is a
      // different, 98%-win cell and stands on its own study.
      // REOPENED (operator "Ship both", 2026-07-30) — the CONVEXITY harness
      // reverses the closure. Formula-qualified cohort, 10d, "ran ≥2×":
      //   trigger ≥1.65×   n=323 · 94% ran 2×
      //   trigger 1.4-1.65 n=430 · 70%
      // This is the most convex cohort we own, and live was refusing it
      // wholesale while trapped at 80% flat-band. The closure was correct on
      // its evidence — adverse execution selection — but that evidence
      // predates the landing fix (rebroadcast + 10× priority), the buy-share
      // floor, the pool floor, and the chambered sniper. The execution
      // problems that convicted this slice no longer exist; it also cost
      // +$3.64 in last night's refusal counterfactual. Scoreboard: live must
      // hold ≥4¢/$ over the first 30 fills, and the band mix must move off
      // 80% flat — if neither happens, it closes again on that evidence.
      // THE STRONG LINE FOLLOWS THE ADMISSION LINE (operator 2026-07-31: "set
      // live entries to 1.25 ... we should also be admitting the 1.30-2.05 band
      // as well"). This was hardcoded 1.30 in three places while the admission
      // band lived in LIVE_MIN_INFLOW — so lowering the band alone would have
      // let the 1.25-1.30 shoulder past the gate and then denied it a seat,
      // silently demoting the whole cohort to ticket size. The seat definition
      // now tracks the operator's line.
      const strongSeat =
        sig.liqGrowth != null && Number(sig.liqGrowth) >= cfg.LIVE_MIN_INFLOW &&
        sig.triggerMultiple != null && sig.triggerMultiple <= 1.95;
      // SENSOR-SLICE OPENING (ratified 2026-07-27, sensor-slice-study.ts 7d/14d):
      // the "−$1.01/t" that closed the slice predates the F1 crowd gate — this
      // code path only sees crowd-net flow now, and crowd-net flips the cells:
      //   SEAT  1.96–2.05 @ strong (lg≥1.30):    n=47 · 98% win · 2% rug · 17.0c/$
      //   TICKET 1.66–2.05 @ sub-strong (1.20–1.29): n=17 · 88% win · 6% rug —
      //   thin sample ⇒ ticket-size only until ~30 fills prove the cell.
      // Without crowd-net the same cells run −10.2c/$ / 35% rug — the F1 gate
      // above is what makes this admission safe. Trigger >2.05 still declines.
      const sensorSeat =
        sig.liqGrowth != null && Number(sig.liqGrowth) >= cfg.LIVE_MIN_INFLOW &&
        sig.triggerMultiple != null && sig.triggerMultiple > 1.95 && sig.triggerMultiple <= 2.05;
      const sensorTicket =
        sig.liqGrowth != null && Number(sig.liqGrowth) >= cfg.INFLOW_FLOOR && Number(sig.liqGrowth) < cfg.LIVE_MIN_INFLOW &&
        sig.triggerMultiple != null && sig.triggerMultiple > cfg.CONVICTION_SEAT_MAX && sig.triggerMultiple <= 2.05;
      if (sig.triggerMultiple != null && sig.triggerMultiple > cfg.CONVICTION_SEAT_MAX && !strongSeat && !sensorSeat && !sensorTicket) {
        await audit("live_buy_skipped", {
          mint,
          reason: `trigger ${sig.triggerMultiple.toFixed(2)}× declined — 1.66-1.95×@strong (extension closed 2026-07-27, rug-fill scoreboard), >2.05×, or unmeasured inflow`,
        });
        return;
      }
      if (sensorSeat) {
        await audit("live_sensor_seat", {
          mint,
          trigger: sig.triggerMultiple,
          inflow: sig.liqGrowth,
          reason: `sensor-seat opening: trigger ${sig.triggerMultiple!.toFixed(2)}× admitted on measured-strong inflow ${Number(sig.liqGrowth).toFixed(2)}× (98%/2% crowd-net cell n=47, 14d study 2026-07-27)`,
        });
      }
      if (sensorTicket) {
        subFloorTicket = true;
        await audit("live_subfloor_ticket", {
          mint,
          door: "SENSOR",
          walletWinnerHits: sig.walletWinnerHits ?? null,
          walletRugHits: sig.walletRugHits ?? null,
          inflow: sig.liqGrowth,
          reason: `sensor ticket: trigger ${sig.triggerMultiple!.toFixed(2)}× on sub-strong inflow ${Number(sig.liqGrowth).toFixed(2)}× — ticket-size until ~30 fills prove the cell (88%/6% crowd-net n=17, thin)`,
        });
      }
    }
    if (!sig) {
      // Unrouted flow ran −$22.95 on live since routing went live. A trade
      // without a genome has no exit profile and no evidence — paper-only.
      await audit("live_buy_skipped", { mint, reason: "unrouted — live takes signature-routed trades only" });
      return;
    }
    // ── THE BUY-SHARE FLOOR (operator RATIFIED 2026-07-29) ──────────────────
    // "Buy Shares must be in our favor when qualifying." The strongest
    // entry-knowable separator we own: <55% buys at the trigger tick died 30%
    // vs 13% (n=66 / 508, 7d) at an identical 3×-run rate — deaths removed
    // with no upside forfeited. Universal: every path (strict-winner,
    // RECOVERED cliff-safe, L1, L3+) passes through it, and an UNMEASURED buy
    // share refuses too — a blind read is not a favorable one.
    {
      const bs = sig.triggerBuyShare == null ? null : Number(sig.triggerBuyShare);
      if (bs == null || !Number.isFinite(bs) || bs < cfg.LIVE_MIN_BUY_SHARE) {
        await audit("live_buy_skipped", {
          mint,
          buyShare: bs,
          reason: `buy share ${bs == null || !Number.isFinite(bs) ? "unmeasured" : (bs * 100).toFixed(0) + "%"} below the ${(cfg.LIVE_MIN_BUY_SHARE * 100).toFixed(0)}% floor — sellers at the trigger tick (30% death cohort vs 13%)`,
        });
        return;
      }
    }
    // SIGNATURE PLUG-IN (operator 2026-07-29): live trades only signatures
    // whose MANAGEMENT prints. The others aren't routing problems — they're
    // genome problems, and the paper workshop owns them until re-harnessed.
    {
      const allow = cfg.LIVE_SIGNATURE_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean);
      if (allow.length && !allow.includes(sig.signature)) {
        await audit("live_buy_skipped", {
          mint,
          reason: `${sig.signature} not on the live plug-in list (${cfg.LIVE_SIGNATURE_ALLOWLIST}) — management genome unproven or drain-class; paper workshop owns it`,
        });
        return;
      }
    }
    // THE RECOVERY CLIFF (measured 2026-07-29): on unlocked-LP pools the
    // drain alarm must ring above $12k for the exit to keep ~95%. Entry
    // pools below LIVE_UNLOCKED_LP_MIN_POOL_USD put the −25% trigger under
    // the cliff — refuse the seat. Locked/burned LP is exempt: no pull race.
    {
      const [lp] = (await db.execute(sql`
        SELECT bool_or(evidence::text ILIKE '%LP Unlocked%') unlocked
        FROM safety_checks WHERE mint = ${mint} AND check_name = 'rugcheck'`)) as unknown as { unlocked: boolean | null }[];
      if (lp?.unlocked) {
        const [lt] = (await db.execute(sql`
          SELECT liquidity_usd::float liq FROM candidate_ticks WHERE mint = ${mint}
          ORDER BY snapped_at DESC LIMIT 1`)) as unknown as { liq: number | null }[];
        const liqNow = lt?.liq != null && Number.isFinite(Number(lt.liq)) ? Number(lt.liq) : null;
        if (liqNow != null && liqNow < cfg.LIVE_UNLOCKED_LP_MIN_POOL_USD) {
          await audit("live_buy_skipped", {
            mint,
            reason: `unlocked LP with pool $${Math.round(liqNow).toLocaleString()} < $${cfg.LIVE_UNLOCKED_LP_MIN_POOL_USD.toLocaleString()} recovery-cliff floor — the −25% alarm would ring below the $12k/95% line`,
          });
          return;
        }
      }
    }
    if ((sig.stars ?? 0) < cfg.LIVE_MIN_STARS && !winnerRepCrowd) {
      // winner-rep exempt: the crowd's track record IS the evidence bar
      await audit("live_buy_skipped", { mint, reason: `${sig.stars ?? 0}★ — below live evidence bar (0★ ran −55.3% on deployed)` });
      return;
    }
    } // ══ end strategy region 2 ═══════════════════════════════════════════════

    // ── SOLVENCY + EXECUTABILITY GATE — NEVER STRATEGY-GATED ─────────────────
    // Kill switch, daily cap, concurrency/session caps, already-held, venue
    // executability, honeypot block, sell-route probe. A selection flag must not
    // be able to disarm these: 2026-08-02 the call sat inside the region above
    // and live bought through an ENGAGED kill — RABBIT #7280 entered on a FAILED
    // honeypot probe and was unsellable in 19 minutes.
    const gate = await liveBuyGate(cfg, mint, sig != null);
    if (!gate.ok) {
      if (cfg.LIVE_TRADING_ENABLED && gate.reason !== "disabled")
        await audit("live_buy_skipped", { mint, reason: gate.reason });
      return;
    }

    // ── FROM HERE DOWN: EXECUTABILITY + SOLVENCY ONLY ────────────────────────
    // SOL price, balance read, SOL reserve floor, exposure headroom, slot size,
    // fee viability, session trade cap. These are the rails real capital needs
    // and paper does not; they are never gated by LIVE_STRATEGY_GATES.
    const sol = await solP;
    if (!sol || sol <= 0) {
      await audit("live_buy_skipped", { mint, reason: "no SOL price" });
      return;
    }

    // THE SIZER — regime + balance aware. Target a small slice of the live
    // balance, then clamp to what's actually deployable: exposure headroom (leave
    // room for more positions) and the free-SOL reserve (leave fees/rent so buys
    // don't fail mid-session). Many small positions, scaling as the balance grows.
    const bal = await balP;
    if (!bal || bal.usd <= 0) {
      await audit("live_buy_skipped", { mint, reason: "no balance read" });
      return;
    }
    if (bal.sol <= cfg.LIVE_MIN_FREE_SOL) {
      await audit("live_buy_skipped", { mint, reason: "SOL reserve floor" });
      return;
    }
    const [expoRow] = (await db
      .select({ e: sql<number>`coalesce(sum(${positions.sizeUsd}::float), 0)` })
      .from(positions)
      .where(and(eq(positions.lane, "live"), eq(positions.status, "open")))) as { e: number }[];
    const openExposure = n(expoRow?.e);
    const exposureRoom = bal.usd * cfg.LIVE_MAX_EXPOSURE_FRAC - openExposure;
    const solRoom = (bal.sol - cfg.LIVE_MIN_FREE_SOL) * bal.price; // keep fee reserve
    const affordable = Math.min(exposureRoom, solRoom);
    if (affordable < cfg.LIVE_MIN_POSITION_USD) {
      await audit("live_buy_skipped", { mint, reason: `no room (exposure ${openExposure.toFixed(2)}/${(bal.usd * cfg.LIVE_MAX_EXPOSURE_FRAC).toFixed(2)}, reserve)` });
      return;
    }
    const regime = await hourRegimeMult(cfg);
    // Conviction-scaled sizing: the fused model (stored at arm) sends more capital
    // to the best setups. Missing/disabled = neutral 1× band. Gated on
    // LIVE_CONVICTION_SIZING, not CONVICTION_ENABLED — the faithful mirror wants
    // FLAT live sizing, but killing CONVICTION_ENABLED globally also stopped the
    // recorder stamping scores and gutted paper's conviction-first queue (the
    // 2026-07-19 −$46/24-trade bleed). Live flatness is a live-only concern.
    let convictionMult = 1;
    if (cfg.LIVE_CONVICTION_SIZING) {
      const [cv] = await db
        .select({ score: candidateOutcomes.convictionScore })
        .from(candidateOutcomes)
        .where(eq(candidateOutcomes.mint, mint))
        .limit(1);
      if (cv?.score != null) convictionMult = convictionBand(Number(cv.score), cfg.CONVICTION_SIZE_MIN_BAND, cfg.CONVICTION_SIZE_MAX_BAND);
    }
    // POOL-INFLOW SIZING — the same edge the paper lane sizes by, so live
    // mirrors paper's ALLOCATION and not just its entries. Growth ≥1.3× at
    // trigger: 2.79× post-entry run, 6% rug. Flat pool with price up: 35% rug.
    let inflowMult = 1;
    {
      const [lgRow] = await db
        .select({ lg: candidateOutcomes.liqGrowth, tm: candidateOutcomes.triggerMultiple })
        .from(candidateOutcomes)
        .where(eq(candidateOutcomes.mint, mint))
        .limit(1);
      const lg = lgRow?.lg == null ? null : Number(lgRow.lg);
      const tm = lgRow?.tm == null ? null : Number(lgRow.tm);
      if (lg !== null && Number.isFinite(lg)) {
        if (lg >= cfg.LIQ_INFLOW_STRONG) inflowMult = cfg.LIQ_INFLOW_SIZE_BOOST;
        // UN-PROBED (operator, 2026-07-23): below strong, only winner-rep
        // crowds are admitted now — 82–89% win / 47% capture earns full size,
        // not the 0.3× probe built for the pre-gate coin-flip cohort.
        else if (!winnerRepCrowd && lg <= cfg.LIQ_FLAT_MAX && tm !== null && tm >= 1.2)
          inflowMult = cfg.LIQ_FLAT_SIZE_MULT;
      }
      // Late-entry (buying-the-top) shrink — mirror paper's allocation.
      if (tm !== null && Number.isFinite(tm) && tm >= cfg.LATE_ENTRY_LO && tm < cfg.LATE_ENTRY_HI)
        inflowMult *= cfg.LATE_ENTRY_SIZE_MULT;
      // MOONSHOT BAND — the live wallet is the one that matters, so it gets the
      // same concentration paper does. Post-trigger: 1.6-2.0x runs 3.72x at 16%
      // rug; ≥2.0x runs 3.53x at ZERO observed rugs (n=112) — versus 1.44x and
      // 28.8% rugs in the low zone. Capital belongs on the bands that produce
      // the tail, not spread evenly across everything that clears the floor.
      if (tm !== null && Number.isFinite(tm)) {
        if (tm >= cfg.BAND_ELITE_MULT) inflowMult *= cfg.BAND_ELITE_SIZE;
        else if (tm >= cfg.BAND_STRONG_MULT) inflowMult *= cfg.BAND_STRONG_SIZE;
      }
    }
    convictionMult *= inflowMult;
    // ANTICIPATION — the forecast as a control input: lean in on heating venues in
    // hot windows, throttle on cold. Bounded; biases within the sizer's clamps.
    const antiMult = await anticipationMult(cfg, mint);
    // ANTICIPATION GATE — when the forecast is genuinely cold (venue cooling AND/OR
    // tail odds low), STAND DOWN and preserve runway. A thin wallet cannot afford
    // low-tail-probability shots (the kill autopsy: died dry on cold-window shots).
    if (cfg.LIVE_ANTICIPATION_GATE && !sig && antiMult < cfg.LIVE_ANTICIPATION_GATE_MIN) {
      await audit("live_buy_skipped", { mint, reason: `anticipation cold (×${antiMult.toFixed(2)} < ${cfg.LIVE_ANTICIPATION_GATE_MIN}) — preserving runway` });
      return;
    }
    // DAILY THROTTLE — shrink toward the floor as the day's loss approaches the
    // cap, but never halt (presence > halting for a tail strategy). Linear from 1×
    // (flat) to LIVE_DAILY_THROTTLE_MIN at/beyond the cap; the floor still applies.
    let dailyThrottle = 1;
    if (cfg.LIVE_DAILY_THROTTLE_ENABLED && cfg.LIVE_DAILY_LOSS_CAP_USD > 0) {
      const [td] = (await db
        .select({ pnl: sql<number>`coalesce(sum(${positions.realizedPnlUsd}::float), 0)` })
        .from(positions)
        .where(and(eq(positions.lane, "live"), gte(positions.closedAt, sql`date_trunc('day', now())`)))) as { pnl: number }[];
      const lossToday = Math.max(0, -n(td?.pnl));
      const frac = Math.min(1, lossToday / cfg.LIVE_DAILY_LOSS_CAP_USD);
      dailyThrottle = 1 - frac * (1 - cfg.LIVE_DAILY_THROTTLE_MIN);
    }
    // MIRROR PAPER EXACTLY. Paper takes every routed signal at whatever size the
    // conviction produces — it never refuses a trade for being small, and that
    // book is the one proving the model. A fee-floor SKIP is a guardrail paper
    // does not have, and guardrails of exactly this kind are what kept the live
    // wallet unproductive: each one silently removes trades from the sample that
    // paper is winning on. So a routed position is floored to a fee-viable size
    // and TAKEN, never skipped.
    const sized = Math.min(livePositionUsd(cfg, bal.usd, regime, convictionMult, antiMult, sig, paperFrac) * dailyThrottle, affordable);
    // SIZER-RESPONSIVE (operator, 2026-07-24: "scale using sizer"). The fee
    // floor used to round every small clip UP to a flat $4 — live paid MORE
    // than paper on exactly the trades paper trusted least, and the adaptive
    // policy never expressed at small balance. Now the Sizer's number STANDS:
    // below the fee-viable floor live SKIPS (probe-intent stays paper — fees
    // measured 18.3pp drag at $2 clips), at/above it the regime-scaled value
    // flows through un-inflated. Tickets scale with the Sizer too, capped by
    // the ticket ceiling and the pool-fraction bound.
    // ── ONE PROTOCOL, TWO BALANCES (operator 2026-07-31: "Live should use the
    // same protocol sized according to its own balance") ─────────────────────
    // Paper clamps a PRECISION entry to an EVEN mandate slot —
    // bankroll × MANDATE_AGG_FRAC ÷ MANDATE_SLOTS — so one trade can never
    // destroy a basket. Live was sizing off the raw conviction fraction and
    // only meeting the mandate at the fee floor, so the lanes were running two
    // different position-sizing models against identical signals. Live now
    // computes the same even slot against the WALLET BALANCE. Everything after
    // this (fee-viable floor, ticket caps, exposure rails) is unchanged.
    const mPrecision =
      cfg.MANDATE_SIZING_ENABLED &&
      sig != null &&
      ((sig.signature !== "RUG_RISK" &&
        sig.liqGrowth != null && Number.isFinite(Number(sig.liqGrowth)) &&
        Number(sig.liqGrowth) >= cfg.INFLOW_FLOOR && Number(sig.liqGrowth) <= cfg.INFLOW_CEILING) ||
        (cfg.MOONSHOT_TIER_ENABLED && sig.stars === 2 &&
          typeof sig.signature === "string" && sig.signature.startsWith("MOON") &&
          !(sig.triggerMultiple != null && Number(sig.triggerMultiple) > cfg.CONVICTION_SEAT_MAX)));
    // LIVE'S OWN SLOT SPEC — same protocol, live's balance AND live's basket.
    // Sharing paper's 8-slot divisor gave 0.625%/slot ($1.25 on $200), under
    // the fee floor; live runs 4 slots at 5% each so the slot is fee-viable and
    // basket_harvest finally has more than one position to sweep.
    // FLOOR-AWARE SLOT: below ~$200 equity the arithmetic fell under the
    // fee-viable floor and non-PRECISION entries skipped silently, which
    // selected against us — the skipped cohort measured better than the funded
    // one. The ticket is the $2.50 the spec calls for; aggregate outlay floats.
    const rawSlotUsd = (bal.usd * cfg.LIVE_MANDATE_AGG_FRAC) / Math.max(1, cfg.LIVE_MANDATE_SLOTS);
    const mandateSlotUsd = cfg.LIVE_SLOT_FLOOR_AWARE
      ? Math.max(rawSlotUsd, cfg.LIVE_MIN_POSITION_USD)
      : rawSlotUsd;
    let usd = sized;
    if (mPrecision && mandateSlotUsd > 0) {
      // Even tickets, as paper — the mandate slot REPLACES the sizer's number,
      // but never past the exposure/reserve room already computed above (the
      // old Math.min(m, Math.max(m, sized)) identity skipped that clamp, so a
      // floor-aware slot could breach LIVE_MAX_EXPOSURE_FRAC on a tight book).
      // The manifest's ALLOCATE term rides the slot: genome weight scales the
      // even ticket. Sub-floor products fall to the mandate-ticket branch
      // below, so at fee-floor balances the weights stay dormant — they
      // express as the balance grows, exactly as the doctrine specifies.
      const slotted = Math.min(mandateSlotUsd * manifestWeight, affordable);
      if (Math.abs(slotted - usd) > 0.005) {
        await audit("live_mandate_size", {
          mint,
          from: Number(usd.toFixed(2)),
          to: Number(slotted.toFixed(2)),
          balanceUsd: Number(bal.usd.toFixed(2)),
          // QTEA-010: this printed the PAPER mandate config (MANDATE_*) while the
          // slot above is computed from the LIVE one (LIVE_MANDATE_*). Telemetry
          // reported one configuration while a different one spent the money —
          // straight through the "every dollar explainable" doctrine. The
          // effective aggregate is stated too, because the $2.50 floor can widen
          // it past LIVE_MANDATE_AGG_FRAC and that must be visible, not hidden.
          reason: `even mandate slot — ${(cfg.LIVE_MANDATE_AGG_FRAC * 100).toFixed(1)}% of $${bal.usd.toFixed(2)} balance ÷ ${cfg.LIVE_MANDATE_SLOTS} slots = $${mandateSlotUsd.toFixed(2)}/slot (effective aggregate ${((mandateSlotUsd * cfg.LIVE_MANDATE_SLOTS / Math.max(1e-9, bal.usd)) * 100).toFixed(1)}%, floor-aware; same protocol as paper, live's own balance)`,
        });
      }
      usd = slotted;
    }
    if (dbcTicket) {
      // FLOOR CLAMP (operator 2026-07-27): Math.max(1.0, sized) let a $1.70
      // sub-viable ticket through this door while the same afternoon three
      // winners were skipped at $1.69-1.73 elsewhere — the universal fee-viable
      // floor applies to EVERY door. Too-thin pool-fraction bound = skip, not
      // a discount ticket.
      usd = Math.min(
        cfg.LIVE_DBC_TICKET_USD,
        (dbcPoolLiq ?? cfg.LIVE_DBC_TICKET_MIN_LIQ_USD) * cfg.LIVE_DBC_TICKET_POOL_FRAC,
      );
      if (usd < cfg.LIVE_MIN_POSITION_USD) {
        await audit("live_buy_skipped", {
          mint,
          reason: `dbc ticket $${usd.toFixed(2)} below fee-viable floor $${cfg.LIVE_MIN_POSITION_USD.toFixed(2)} (pool-fraction bound) — no sub-viable tickets on any door`,
        });
        return;
      }
    } else if (usd < cfg.LIVE_MIN_POSITION_USD) {
      // MANDATE TICKETS (operator, 2026-07-24: "This also includes the Live
      // Wallet Sizing — buy multiple tickets in qualified windows and harvest
      // the winning lots"). The per-slot mandate fraction (0.2-0.25%) lands
      // below fee-viability on a small live balance, and the plain skip was
      // silently benching live from exactly the PRECISION flow that proves the
      // model. A FULL-formula slot (strict crowd, measured in-envelope inflow,
      // conviction seat — all re-verified by the gates above) buys a fee-viable
      // ticket instead; everything else (recovered / RUG_RISK / unmeasured)
      // still skips — probe-class stays paper. (mPrecision is computed above,
      // where the even mandate slot is applied — same predicate, one source.)
      if (mPrecision || subFloorTicket) {
        await audit("live_mandate_ticket", {
          mint,
          sizedUsd: usd,
          ticketUsd: cfg.LIVE_MIN_POSITION_USD,
          reason: `PRECISION slot — mandate ticket at the fee-viable floor $${cfg.LIVE_MIN_POSITION_USD.toFixed(2)} (sizer $${usd.toFixed(2)} sub-viable; basket harvest, multiple concurrent lots)`,
        });
        usd = cfg.LIVE_MIN_POSITION_USD;
      } else {
        await audit("live_buy_skipped", {
          mint,
          reason: `sizer $${usd.toFixed(2)} below fee-viable floor $${cfg.LIVE_MIN_POSITION_USD.toFixed(2)} — probe-class stays paper (sizer-responsive; mandate tickets are PRECISION-only)`,
        });
        return;
      }
    }
    // SUB-FLOOR cell entries are capped AT the ticket — confirmation-size real
    // capital until the live cohort proves the half-clip promotion (≥55% over
    // its first ~30 fills).
    if (subFloorTicket || buildBackTicket) usd = Math.min(usd, cfg.LIVE_MIN_POSITION_USD);
    const lamports = BigInt(Math.floor((usd / sol) * 1e9));

    // ── MIRROR-FRESHNESS GATE (DRILLCAT, 2026-07-23) ─────────────────────────
    // 11 seconds of mirror latency on a 12-second spike: paper opened, banked
    // TP0 and trailed out while live's buy was still in flight — live bought
    // the exact top paper was selling into (−$4 vs paper's +$4.77). If the
    // paper twin has already STARTED EXITING, the move this entry mirrors is
    // over; there is no trade left to copy. Refuse, don't chase.
    {
      const [twinExiting] = (await db.execute(sql`
        SELECT 1 FROM positions p JOIN fills f ON f.position_id = p.id AND f.side = 'sell'
        WHERE p.mint = ${mint} AND p.lane = 'paper' AND p.opened_at > now() - interval '30 minutes'
        LIMIT 1`)) as unknown as unknown[];
      if (twinExiting) {
        await audit("live_buy_skipped", { mint, reason: "mirror stale — paper twin already exiting; the move is over, not chasing" });
        return;
      }
    }

    const wallet = liveWallet();
    if (!wallet) {
      await audit("live_buy_skipped", { mint, reason: "no wallet key at swap stage" });
      return;
    }
    // ── ENTRY FRICTION LOOP (2026-07-23): 81 buy failures/48h, 69% of those
    // mints won. Two failure classes, two answers: a venue BUILD REJECT (400 /
    // no pool / migrated) fails over to the next provider's quote; a SLIPPAGE
    // fail retries once with a bumped-but-capped tolerance and a hard chase
    // guard — a fresh quote offering >10% fewer tokens means the move ran, and
    // we refuse to chase the top. Max three attempts, every retry audited.
    const excludedProviders: string[] = [];
    let firstOut: number | null = null;
    tGates = Date.now(); // every admission gate cleared — swap pipeline starts here
    let quote = await swapRouter.quote(cfg, WSOL_MINT, mint, lamports, cfg.LIVE_SLIPPAGE_BPS);
    tQuote = Date.now();
    // QTEA-004 canonical conversion: priceImpactPct is a FRACTION, so ×100 gives
    // percentage points to compare against ENTRY_MAX_SLIPPAGE_PCT. This site was
    // always right — it is the proof the field is a fraction, since reading it as
    // percent here would reject every entry ever offered. Deliberately NOT routed
    // through impactPct(): that returns null for ≥100% impact, which would turn a
    // total-impact quote from "reject" into "zero impact".
    const impactRaw = Math.abs(Number(quote.priceImpactPct ?? 0));
    const impact = Number.isFinite(impactRaw) ? impactRaw * 100 : Number.POSITIVE_INFINITY;
    if (impact > cfg.ENTRY_MAX_SLIPPAGE_PCT) {
      await audit("live_buy_skipped", { mint, reason: `price impact ${impact.toFixed(1)}%` });
      return;
    }
    // EXIT PRE-CHECK — never enter what we can't currently sell (KIMI guard). The
    // expected buy output is the sell probe amount (nominal fallback when the buy
    // provider doesn't quote an out amount, e.g. PumpSwap/PumpPortal build-only).
    // EXIT PRE-CHECK — skipped for routed buys. It blocked 6 entries in 60
    // minutes and took live's moon count to ZERO while paper opened four, because
    // it asks an aggregator for an exit quote on a 2-minute-old thin pool, which
    // is exactly when the aggregator has not indexed it yet. It was not filtering
    // unsellable tokens, it was filtering NEW ones — and new thin pools are the
    // MOON classes, the tail that pays for everything else.
    // Sellability is already established upstream: the scout's honeypot probe is
    // an actual Jupiter round-trip (roundtripRatio ≈ 0.99 on these), and a
    // genuinely unsellable position is still caught by the strand write-off.
    // STRAND-CLASS PRE-CHECK (ratified 2026-07-27): the narrowing above stands
    // for routed flow generally — new thin pools ARE the moon tail. But the 14
    // live_unsellable write-offs (−$33.82/48h) were all meteora-damm-v2 pools
    // $11–16k deep, entered via RECOVERED tier (10) / ticket doors (11) — old
    // enough to be indexed, so a failed sell probe there means one-way pool,
    // not un-indexed pool. Probe exactly that intersection; moon flow untouched.
    const strandClass =
      (subFloorTicket || buildBackTicket || recoveredTier) &&
      (await venueForMint(mint)) === "meteora-damm-v2";
    if (cfg.LIVE_EXIT_PRECHECK && (!sig || strandClass)) {
      const probeAmt = Number(quote.outAmount) > 1 ? BigInt(quote.outAmount) : 1_000_000_000n;
      if (!(await canExitLive(cfg, mint, probeAmt))) {
        await audit("live_buy_skipped", {
          mint,
          reason: strandClass
            ? "no sell route at entry (strand-class damm-v2 ticket/RECOVERED) — one-way pool, would strand"
            : "no exit route — would strand",
        });
        return;
      }
    }
    let res!: Awaited<ReturnType<typeof executeSwap>>;
    for (let attempt = 1; ; attempt++) {
      try {
        const b64 = await swapRouter.buildSwapTx(cfg, quote, wallet.publicKey.toBase58());
        res = await executeSwap(cfg, b64, mint);
        if (res.outUi <= 0) throw new Error("fill parse: zero output");
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // QTEA-014 (2026-08-01): was `/6001|ExceededSlippage|simulation failed/`,
        // which missed every real slippage code AND matched 6001 — ZeroBaseAmount
        // on pumpswap, a permanent condition we answered by widening tolerance.
        // The first live buy after arming died Custom:6004 (pump_amm
        // ExceededSlippage), matched neither branch, and threw on attempt ONE.
        // Classification is now keyed on the program; see invariants.ts for the
        // IDL-sourced tables. A thin pool is a venue problem, not a price
        // problem — retrying wider cannot help, failing over might.
        const failKind = classifySwapFailure(msg, quote.provider);
        const venueReject = failKind === "venue_reject" || failKind === "thin_pool";
        const slipFail = failKind === "slippage";
        // Tag the terminal error with the provider that built the tx so
        // live_buy_failed rows attribute landing failures per build path
        // (suffix only — downstream regex classifiers keep matching).
        if (attempt >= 3 || (!venueReject && !slipFail))
          throw new Error(`${msg} [via ${quote.provider}]`);
        if (venueReject) excludedProviders.push(quote.provider);
        const out0 = Number(quote.outAmount);
        if (firstOut == null && out0 > 0) firstOut = out0;
        await audit("live_buy_retry", {
          mint, attempt,
          reason: venueReject ? `venue reject (${quote.provider}) — failing over` : "slippage — bumped tolerance",
          error: msg.slice(0, 120),
        });
        const slip = venueReject ? cfg.LIVE_SLIPPAGE_BPS : Math.min(cfg.LIVE_SLIPPAGE_BPS + 1_500, 4_000);
        quote = await swapRouter.quote(cfg, WSOL_MINT, mint, lamports, slip, { exclude: excludedProviders });
        const freshOut = Number(quote.outAmount);
        if (firstOut != null && freshOut > 0 && freshOut < firstOut * 0.9) {
          await audit("live_buy_skipped", { mint, reason: "entry retry refused — price ran >10% since first quote (chase guard)" });
          return;
        }
      }
    }

    const entryPrice = usd / res.outUi;
    const [position] = await db
      .insert(positions)
      .values({
        signalId: null,
        mint,
        lane: "live",
        tier: "base",
        // The genome this live position is managed under, pinned at open exactly
        // as paper does. It drives the exit profile and lets the Matrix and the
        // scorecards compare the two lanes signal-for-signal.
        signature: sig?.signature ?? null,
        stars: sig?.stars ?? null,
        // Cache-completeness (stage-grading audit 2026-07-29): live rows never
        // stored the trigger multiple, leaving the SEAT stage ungradable on
        // the live funnel. Same field paper persists.
        triggerMult: sig?.triggerMultiple != null && Number.isFinite(sig.triggerMultiple) ? String(sig.triggerMultiple) : null,
        // The routing EVIDENCE, same as paper persists. Without it the Matrix's
        // signal-vs-execution card is blank for live and a signature cannot be
        // audited after the fact — which is the whole point of recording it.
        dipDepth: sig?.dipDepth != null ? String(sig.dipDepth) : null,
        snapPct: sig?.snapPct != null ? String(sig.snapPct) : null,
        snapRate: sig?.snapRate != null ? String(sig.snapRate) : null,
        sizeUsd: String(usd),
        qtyTokens: String(res.outUi),
        qtyRemaining: String(res.outUi),
        entryPriceUsd: String(entryPrice),
        peakPriceUsd: String(entryPrice),
        realizedPnlUsd: "0",
      })
      .returning();
    if (position) {
      const [lbFill] = await db.insert(fills).values({
        positionId: position.id,
        side: "buy",
        qtyTokens: String(res.outUi),
        priceUsd: String(entryPrice),
        feeUsd: String(res.feeSol * sol),
        txSignature: res.signature,
        reason: "live_confirmed",
      }).returning({ id: fills.id });
      if (lbFill) void journalFill({ fillId: lbFill.id, book: "live", side: "buy", filledAt: new Date(),
        positionId: position.id, mint, qty: res.outUi, priceUsd: entryPrice, feeUsd: res.feeSol * sol,
        entryPriceUsd: entryPrice, reason: "live_confirmed", txSignature: res.signature });
    }
    requeueUntil.delete(mint); // a landed fill closes any retry window
    await audit("live_open", {
      mint, usd, regime, convictionMult, anticipationMult: antiMult, qty: res.outUi, signature: res.signature, feeSol: res.feeSol,
      // the manifest seat that admitted this entry — the counterfactual watch
      // attributes every outcome by tier (null = manifest off / fail-open)
      manifestTier, manifestWeight,
      // land-rate scoreboard (2026-07-27): which build path filled and how fast
      provider: quote.provider, landMs: res.landMs,
      // the stage clock — where this entry's milliseconds went
      latencyMs: { gates: tGates - t0, quote: tQuote - tGates, swapAndConfirm: Date.now() - tQuote, total: Date.now() - t0 },
    });
    console.log(`💰 LIVE OPEN ${symbol ?? "?"} ${short(mint)} $${usd.toFixed(2)} (conv ×${convictionMult.toFixed(2)}, anti ×${antiMult.toFixed(2)}, ${res.outUi} tokens, tx ${res.signature.slice(0, 8)}…)`);
    // CHAMBER-ON-FILL (the sniper): pre-sign this position's escape while
    // nothing is burning. Non-blocking; a chamber failure just means the
    // fallback flee path stands alone as before.
    if (cfg.LIVE_PRESIGNED_EXITS && position) {
      void chamberExit(cfg, position.id, mint).then((okc) => {
        if (okc) void audit("live_presigned_chambered", { mint, positionId: position.id });
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await audit("live_buy_failed", { mint, error: msg }).catch(() => {});
    console.error(`live buy failed ${short(mint)}: ${msg}`);
    // ── REQUEUE ON UNROUTABLE (BIO, ratified 2026-07-24) ────────────────────
    // Aggregators lag 1–3 minutes behind brand-new pools — exactly the age of
    // the conviction seat. An unroutable formula-pass fill retries every ~15s
    // for up to 90s; each retry re-runs the FULL gate stack (mirror-freshness
    // kills it the moment the paper twin exits; seat/crowd re-validate), so
    // the requeue can only ever produce a fill the gates would bless live.
    if (sig && /all swap providers down|liquidity must be greater than 0|NO_ROUTES|no route/i.test(msg)) {
      const until = requeueUntil.get(mint) ?? Date.now() + 90_000;
      requeueUntil.set(mint, until);
      if (Date.now() < until) {
        liveRequeue.set(mint, { next: Date.now() + 15_000, symbol, sig, paperFrac });
        await audit("live_buy_requeued", { mint, retryInMs: 15_000, windowEndsMs: until - Date.now() }).catch(() => {});
      } else {
        requeueUntil.delete(mint);
        await audit("live_requeue_expired", { mint }).catch(() => {});
      }
    }
  } finally {
    liveBuyInFlight.delete(mint);
  }
}

// ── the requeue machinery ────────────────────────────────────────────────────
const liveRequeue = new Map<string, { next: number; symbol: string | null; sig: NonNullable<Parameters<typeof maybeLiveBuy>[3]>; paperFrac: number | null }>();
const requeueUntil = new Map<string, number>();

/** Retry unroutable formula-pass buys while their 90s window lives. Called
 *  every trader tick; each retry goes back through maybeLiveBuy's full gate
 *  stack, so success, gate-refusal, or twin-exit all end the queue naturally
 *  (only a repeat unroutable failure re-queues, and only inside the window). */
// ── THE INDEPENDENT LIVE SCAN (operator 2026-07-29: "the Live wallet needs
// access to the most profitable opportunities that we have flowing through the
// pipes") ───────────────────────────────────────────────────────────────────
// Live's entry hook fired only from inside PAPER's armed-candidate loop, so
// paper's PORTFOLIO rules — family caps, slot caps, per-lane reserves, sized
// for a 300-position book — silently decided what a one-to-two-position wallet
// was allowed to even SEE. Measured in the 20:00-24:00Z window: 10 formula-
// qualified candidates, 8 of which ran ≥2×; live evaluated 4 (all in the flat
// 1.00-1.34× band) and NEVER SAW the 4.9×, the 4.2×, or three more ≥1.8×.
//
// Live now scans for itself. Every fresh armed candidate is handed to
// maybeLiveBuy on live's own cadence, whatever paper decided. NO risk gate is
// loosened: maybeLiveBuy still runs the full stack (buy-share floor, pool
// floor, inflow band, genome allowlist, crowd F1, cliff-safe door, exposure,
// concurrency, kills) and carries its own in-flight claim + already-held guard,
// so a paper-driven call and a scan-driven call for the same mint can never
// double-fire. paperFrac is null here — live derives its own size from the
// signature, exactly as the sizer's fallback path was built to do.
const liveScanSeen = new Map<string, number>(); // mint → last evaluated (ms)
let lastLiveScanMs = 0;
export async function scanLiveIndependent(cfg: HermesConfig): Promise<void> {
  if (!cfg.LIVE_TRADING_ENABLED || !cfg.LIVE_INDEPENDENT_SCAN || !liveWallet()) return;
  if (Date.now() - lastLiveScanMs < cfg.LIVE_SCAN_INTERVAL_MS) return;
  lastLiveScanMs = Date.now();
  try {
    // Re-evaluation cooldown: a candidate refused for a transient reason gets
    // another look, but we don't re-run the gate stack every tick.
    const now = Date.now();
    for (const [m, t] of liveScanSeen) if (now - t > 10 * 60_000) liveScanSeen.delete(m);

    const freshSec = cfg.CONFIRM_MAX_TRIGGER_AGE_SEC > 0 ? cfg.CONFIRM_MAX_TRIGGER_AGE_SEC : 3600;
    const rows = (await db.execute(sql`
      SELECT co.mint, t.symbol, co.signature, co.stars, co.dip_depth, co.snap_pct, co.snap_rate,
        co.liq_growth, co.trigger_multiple, co.wallet_winner_hits, co.wallet_strict_hits,
        co.wallet_rug_hits, co.launch_order, co.trigger_buy_share
      FROM candidate_outcomes co JOIN tokens t ON t.mint = co.mint
      WHERE co.armed = true AND co.signature IS NOT NULL
        AND co.confirmed_at >= now() - make_interval(secs => ${freshSec})
        AND NOT EXISTS (SELECT 1 FROM positions p WHERE p.mint = co.mint AND p.lane='live' AND p.status='open')
      ORDER BY co.conviction_score DESC NULLS LAST, co.trigger_multiple DESC
      LIMIT 12`)) as unknown as Record<string, unknown>[];

    for (const r of rows) {
      const mint = String(r.mint);
      if (liveScanSeen.has(mint)) continue;
      liveScanSeen.set(mint, now);
      const num = (v: unknown): number | null => (v == null ? null : Number(v));
      await maybeLiveBuy(
        cfg,
        mint,
        r.symbol == null ? null : String(r.symbol),
        {
          signature: String(r.signature) as Signature,
          stars: num(r.stars),
          dipDepth: num(r.dip_depth),
          snapPct: num(r.snap_pct),
          snapRate: num(r.snap_rate),
          liqGrowth: num(r.liq_growth),
          triggerMultiple: num(r.trigger_multiple),
          walletWinnerHits: num(r.wallet_winner_hits),
          walletStrictHits: num(r.wallet_strict_hits),
          walletRugHits: num(r.wallet_rug_hits),
          launchOrder: num(r.launch_order),
          triggerBuyShare: num(r.trigger_buy_share),
        },
        null, // live sizes itself — no paper fraction to inherit
      );
    }
  } catch (err) {
    console.warn(`live independent scan failed: ${err instanceof Error ? err.message.slice(0, 90) : err}`);
  }
}

export async function processLiveRequeues(cfg: HermesConfig): Promise<void> {
  const now = Date.now();
  for (const [mint, r] of liveRequeue) {
    if (now < r.next) continue;
    liveRequeue.delete(mint);
    const until = requeueUntil.get(mint);
    if (until == null || now > until) { requeueUntil.delete(mint); continue; }
    void maybeLiveBuy(cfg, mint, r.symbol, r.sig, r.paperFrac);
  }
  // hygiene: drop stale windows so the map never grows unbounded
  for (const [mint, until] of requeueUntil) if (now > until + 300_000) requeueUntil.delete(mint);
}
// Mints with a live buy currently executing — the claim behind the race guard
// at the top of maybeLiveBuy. Cleared in its finally, so a failed buy frees the
// mint for the next legitimate attempt.
const liveBuyInFlight = new Set<string>();

// ── regime class health, cached 5 min per class ──────────────────────────────
// The audit's proven core trades on priors when the recent sample is thin;
// every other class must show a profitable trailing paper window to touch
// real capital. Paper is the free sensor — it keeps trading everything.
const REGIME_CORE = new Set(["RISER", "MOON_FAST", "MOON_STEADY", "MOON_SLOW"]);
const regimeCache = new Map<string, { at: number; allowed: boolean; why: string }>();
// Hysteresis state: the bench's current verdict per class, held between the
// decisive thresholds. Restart re-seeds from core priors — conservative.
const regimeState = new Map<string, boolean>();
async function classRegimeHealth(cfg: HermesConfig, signature: string): Promise<{ allowed: boolean; why: string }> {
  const hit = regimeCache.get(signature);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit;
  let out: { allowed: boolean; why: string };
  try {
    const rows = (await db.execute(sql`
      SELECT count(*)::int AS n,
        coalesce(sum(realized_pnl_usd), 0)::float8 AS pnl,
        coalesce(sum(size_usd), 0)::float8 AS deployed
      FROM positions
      WHERE lane = 'paper' AND status = 'closed' AND signature = ${signature}
        AND closed_at > now() - make_interval(hours => ${cfg.LIVE_REGIME_CLASS_WINDOW_H})`)) as unknown as {
      n: number; pnl: number; deployed: number;
    }[];
    const r = rows[0] ?? { n: 0, pnl: 0, deployed: 0 };
    const ret = r.deployed > 0 ? (100 * r.pnl) / r.deployed : 0;
    // HYSTERESIS (2026-07-23): the zero-line flutter benched winners and admitted
    // losers three times in one day. Bench only at ≤ BENCH_PCT with a real
    // sample; re-admit only at ≥ READMIT_PCT; in between, HOLD the prior state.
    // Thin samples fall back to the core priors exactly as before.
    if (r.n >= cfg.LIVE_REGIME_HYST_MIN_N) {
      const prior = regimeState.get(signature) ?? REGIME_CORE.has(signature);
      let allowed = prior;
      if (ret <= cfg.LIVE_REGIME_BENCH_PCT) allowed = false;
      else if (ret >= cfg.LIVE_REGIME_READMIT_PCT) allowed = true;
      regimeState.set(signature, allowed);
      out = allowed
        ? { allowed: true, why: `${cfg.LIVE_REGIME_CLASS_WINDOW_H}h paper ${ret >= 0 ? "+" : ""}${ret.toFixed(1)}% on ${r.n}${ret < cfg.LIVE_REGIME_READMIT_PCT ? " — holding prior (hysteresis)" : ""}` }
        : { allowed: false, why: `${cfg.LIVE_REGIME_CLASS_WINDOW_H}h paper ${ret.toFixed(1)}% on ${r.n} — benched${ret > cfg.LIVE_REGIME_BENCH_PCT ? " (hysteresis holds)" : ""}` };
    } else {
      out = REGIME_CORE.has(signature)
        ? { allowed: true, why: `thin sample (${r.n}) — proven core trades on priors` }
        : { allowed: false, why: `thin sample (${r.n}) — waiting for paper to prove the turn` };
    }
  } catch {
    // A DB hiccup must never veto the proven core nor admit the unproven.
    out = REGIME_CORE.has(signature)
      ? { allowed: true, why: "health check unavailable — core priors" }
      : { allowed: false, why: "health check unavailable" };
  }
  regimeCache.set(signature, { at: Date.now(), ...out });
  return out;
}

/**
 * Sell a fraction of an open live position (token → SOL). The sell amount is
 * anchored on the REAL on-chain balance, not the DB row — any drift between
 * ledger and chain self-corrects at the next sell instead of compounding.
 */
/**
 * Per-position sell-retry backoff. A position whose sell keeps failing was being
 * retried on EVERY 5s manage cycle: 43 failed sells in 13 minutes, each costing
 * an RPC balance read + router quote + simulation. That starved the BUY path and
 * blew live entry lag out from 6-8s to 72s — live stopped mirroring paper's
 * entry price and started chasing it. The network was never the problem (RPC
 * ~500ms, Jupiter ~500ms); our own retry storm was. Failures now back off
 * exponentially (5s → 10s → 20s … capped) so a stuck position degrades itself
 * instead of the whole lane. Any success clears the counter immediately.
 */
const sellBackoff = new Map<number, { fails: number; holdouts?: number; nextAttemptMs: number }>();
// SELL-SIDE VENUE FAILOVER (CCM −$4, 2026-07-23): a build 400 on the sell path
// used to bind the position to the rejecting venue until write-off. Providers
// that reject a position's sell build are excluded on subsequent attempts, so
// the retry machinery reaches the venues that CAN exit it. Cleared on success.
const sellExclude = new Map<number, string[]>();
// ── THE EXIT LATCH (FLAPDOGE −$2.50 → −$118.66/10d write-offs, 2026-07-31) ──
// A commanded protective exit used to get exactly ONE attempt. The manage loop
// re-derives the exit from decideExit every tick, so when a floor_45 sell failed
// on a venue reject the position went DORMANT: price ticked back above the floor,
// decideExit stopped returning a reason, and nothing retried. FLAPDOGE sat 12
// minutes between its failed floor_45 and the runner_timeout that finally wrote
// it off at a FULL −$2.50 — the floor fired correctly and the book still took a
// −100%. A protective exit is a DECISION, not a suggestion: once commanded, the
// position stays commanded until it sells or writes off, and decideExit's opinion
// on later ticks cannot cancel it. This is what makes the −45% standard a rail.
interface ExitLatch { reason: string; fraction: number; slippageBps?: number; since: number }
const exitLatch = new Map<number, ExitLatch>();
/** Last time a position's sell was refused by the cost-basis floor. A refused
 *  exit stays latched and retries every cycle, so the audit row is throttled to
 *  once a minute — the signal is "this position cannot pay the standard", not
 *  one row per retry. */
const floorBlockAt = new Map<number, { at: number; count: number; since: number }>();
/** Terminal exits that must complete once commanded. Opportunistic exits
 *  (profit_trail, liquid_window, take_profit) are deliberately NOT latched — if
 *  one fails and price recovers, continuing to ride is the correct outcome. */
// LATCHING_EXIT, shouldPersistLatch, impactFraction, impliedLiquidityUsd and
// closeVerdict now live in ./invariants.ts — pure, so invariants.test.ts can pin
// them. See that file's header for the four QTEA defects this split exists to
// prevent recurring.
const SELL_BACKOFF_BASE_MS = 5_000;
const SELL_BACKOFF_MAX_MS = 300_000;
// A take-profit that reverts on tight tolerance retries on a FLAT short fuse, not
// the exponential one: the position is a winner we simply refused to sell cheap,
// so backing off exponentially would walk us away from the bank we wanted.
const TP_RETRY_MS = 3_000;

async function liveSellPosition(
  cfg: HermesConfig,
  position: typeof positions.$inferSelect,
  fraction: number,
  reason: string,
  slippageBps?: number, // protective cuts pass a WIDE slippage — a stop must fill
): Promise<boolean> {
  const wallet = liveWallet();
  if (!wallet) return false;
  const bo = sellBackoff.get(position.id);
  if (bo && Date.now() < bo.nextAttemptMs) return false; // cooling off — don't burn RPC
  // COST-BASIS-FLOOR COOLDOWN — gates the ATTEMPT, not just its audit row.
  // A refused sell stays latched, so without this the position re-attempts every
  // 2s management cycle and each pass costs a balance read, a chambered fire
  // (which reverts on its own minOut, at 3× priority fee, then sits in a 30s
  // confirm loop stalling every other position) and a quote. That would trade
  // "donate the inventory once" for "bleed priority fees forever". One attempt a
  // minute is enough to catch a pool that recovers — the receipts show recovery
  // happening over ~30 minutes, not seconds.
  const fb = floorBlockAt.get(position.id);
  if (fb && Date.now() - fb.at < 60_000) return false;
  // ── SELL-PATH STAGE CLOCK (GTPED §8 gap 2) ────────────────────────────────
  // The buy path has carried latencyMs since 2026-07-27; the sell path — where
  // the money is actually kept or lost — had NONE, and an 8s mark age had to be
  // found by inference. Every live_sell row now carries where its milliseconds
  // went: decide→quote, quote→confirm, total, plus the tolerance and class that
  // priced it.
  const tSell0 = Date.now();
  let tQuote = 0;
  // The provider THIS attempt actually quoted through — the failover exclusion
  // must name it exactly; router.lastRoute() is global state that the guard's
  // valuation quotes overwrite between a failure and its exclusion.
  let usedProvider: string | null = null;
  // Classify the exit's URGENCY up front — the catch needs it too, to tell a
  // take-profit that refused a bad price from a position that genuinely can't sell.
  // Protective exits (stop / catastrophe / rug / sweep / mirror-cut) DUMP at the wide
  // stop slippage so they fill at the crashed price instead of reverting into a −100%
  // sweep. Take-profits bank into strength and get the tight tolerance. Trails sit
  // between: they fire while price pulls away, so landing beats price.
  // ── user_cut / runner_timeout ARE PROTECTIVE (BingBing −$2.50, 2026-07-31) ──
  // These are COMMANDED TERMINAL exits — the operator pressing close, or the
  // clock expiring — and they were excluded from this classification, which
  // cost two things at once on the first live positions after arming:
  //   1. the SNIPER never fired. The fire-hook is gated on isProtective, so a
  //      chambered round sat unused (BingBing chambered 12:01:33) while three
  //      sells reverted and the position was written off at −$2.50.
  //   2. they got ORDINARY-sell tolerance. Protective exits start hot at
  //      2000bps and escalate toward 9000; these were capped at the plain sell
  //      slippage, so every attempt died Custom:6001 ExceededSlippage into a
  //      collapsing pool.
  // BingBing was still at 1.81× when it was written off. It was never
  // unsellable — we asked politely, three times, and then booked a full loss.
  // A commanded terminal exit must fill, not negotiate.
  const isProtective =
    /stop|catastrophe|rug|sweep|mirror_cut|unsellable|depth_collapse|drain_guard|floor_45|user_cut|runner_timeout/i.test(reason);
  const isTakeProfit = !isProtective && /take_profit/i.test(reason);
  // Latch the intent BEFORE the attempt, not in the catch: a throw anywhere in
  // the body (RPC read, quote, build, send) must leave the exit still commanded.
  // Full exits only — a partial rung that misses is not a position in trouble.
  // QTEA-001 (2026-08-01): the braces were MISSING. Only `exitLatch.set` was
  // governed by the `if`; `persistState` ran on EVERY sell — partial TP rungs,
  // profit_trail, liquid_window, and every retry of an already-latched exit.
  // Those rows rehydrate on restart into a map the live manager consults BEFORE
  // decideExit, so a partial bank could come back from a deploy as commanded
  // terminal intent with a stale reason and a stale `since`. Caught by external
  // audit; it had not yet fired only because there were no open live positions.
  //
  // Persistence is now AWAITED, not fire-and-forget: a commanded exit that the
  // process forgets across a restart is the failure this state exists to prevent.
  if (shouldPersistLatch({ fraction, reason, alreadyLatched: exitLatch.has(position.id) })) {
    const latch = { reason, fraction, slippageBps, since: Date.now() };
    exitLatch.set(position.id, latch);
    await persistState("latch", position.id, latch);
  }
  try {
    const { PublicKey } = await import("@solana/web3.js");
    const resp = await rpcPool(cfg).read((c) =>
      c.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(position.mint) }),
    );
    let raw = 0n;
    let decimals = 0;
    for (const { account } of resp.value) {
      const data = account.data as { parsed?: { info?: { tokenAmount?: { amount: string; decimals: number } } } };
      const amt = data.parsed?.info?.tokenAmount;
      if (amt) {
        raw += BigInt(amt.amount);
        decimals = amt.decimals;
      }
    }
    if (raw <= 0n) {
      // Nothing on-chain (dust-swept, rugged to zero, or external move): close
      // the ledger row honestly rather than retrying a sell forever.
      //
      // CONDITIONAL on the row still being open. The sweep and the guard run
      // concurrently off rows loaded at cycle start: DEXBULL's trail sell
      // closed the position as profit_trail, then the sweep — holding the
      // stale row — read the now-empty wallet and stamped live_desync_empty
      // OVER the true exit reason. P&L was right, the label wrong, and the
      // Trade Performance Analyzer scores by label. The status='open' clause
      // makes the race a no-op for the loser.
      // MONEY-HONEST CLOSE (finn, 2026-07-23): the sweep can also win a 2-second
      // race against the mirror sell's own bookkeeping — finn's sell FILLED
      // on-chain at +12.9% but the row closed pnl $0.00 with the fill already
      // journaled. The journal is authoritative: recompute realized from fills
      // at close time (sells − buys − fees; with zero sells that is honestly
      // −cost), and let a recorded sell name the exit instead of the desync label.
      const [fp] = (await db.execute(sql`
        select
          coalesce(sum(case when side = 'sell' then qty_tokens::float * price_usd::float
                            else -(qty_tokens::float * price_usd::float) end)
                   - sum(coalesce(fee_usd::float, 0)), 0)::float as pnl,
          count(*) filter (where side = 'sell')::int as sells,
          (select f2.reason from fills f2 where f2.position_id = ${position.id} and f2.side = 'sell'
           order by f2.id desc limit 1) as last_reason
        from fills where position_id = ${position.id}`)) as unknown as
        { pnl: number; sells: number; last_reason: string | null }[];
      const hasFills = fp != null && (fp.sells > 0 || fp.pnl !== 0);
      // Stamp the exit price too — the Analyzer scores exitX from it, and a
      // null here used to render green desync closes at the scatter floor.
      const [lastSell] = fp && fp.sells > 0
        ? ((await db.execute(sql`
            select price_usd::float px from fills
            where position_id = ${position.id} and side = 'sell'
            order by id desc limit 1`)) as unknown as { px: number }[])
        : [];
      const closed = await db
        .update(positions)
        .set({
          status: "closed",
          closedAt: new Date(),
          exitReason: fp && fp.sells > 0 && fp.last_reason ? fp.last_reason : "live_desync_empty",
          qtyRemaining: "0",
          ...(hasFills ? { realizedPnlUsd: fp.pnl.toFixed(6) } : {}),
          ...(lastSell?.px ? { exitPriceUsd: String(lastSell.px) } : {}),
        })
        .where(and(eq(positions.id, position.id), eq(positions.status, "open")))
        .returning({ id: positions.id });
      if (closed.length > 0)
        await audit("live_desync_empty", {
          positionId: position.id,
          mint: position.mint,
          realizedFromFills: hasFills ? fp.pnl : null,
          sells: fp?.sells ?? 0,
        });
      // The wallet reads zero tokens here — the account is already an empty
      // rent shell (this exact path minted the 45 shells Sweep A recovered).
      void closeEmptyAtas(cfg, resp.value.map((v) => v.pubkey), position.mint);
      return true;
    }
    const f = Math.min(1, Math.max(0, fraction));
    const rawSell = f >= 0.999 ? raw : (raw * BigInt(Math.floor(f * 10_000))) / 10_000n;
    if (rawSell <= 0n) return false;

    // Kicked off HERE, not where it is consumed: the cost-basis floor below sits
    // on the flee path, and this fetch is an uncached HTTP round-trip. Starting
    // it now means the floor check costs ~0ms of added latency, and the same
    // promise settles the P&L conversion after the fill.
    const solPxP = solPriceUsd(cfg).catch(() => null);

    // ── THE SNIPER FIRES FIRST (execution leak, 2026-07-31) ──────────────────
    // The chambered round was submitted AFTER swapRouter.quote(). A pre-signed
    // durable-nonce exit needs no quote — the bytes are already signed — but the
    // quote sat in front of it and can THROW ("all swap providers down"), which
    // routes straight to the catch and the round is never fired. That is the
    // exact atomic-rug case: the pool collapses, every provider stops quoting,
    // and the one exit that would still have landed is skipped because we asked
    // permission first. 124 of 195 floor breaches (64%) never reached 1.15x and
    // booked -69% of size against a -45% standard; the gap anatomy put 45% of
    // breaches in the "survivable with speed" class. This is that speed.
    //
    // Quoting now happens ONLY on the fallback path, so detect->fill for a
    // protective full exit is one sendRawTransaction with no network round-trip
    // in front of it.
    let res: Awaited<ReturnType<typeof executeSwap>> | null = null;
    // QTEA-002: the quantity actually EMBEDDED in the settled transaction. The
    // chamber signs for 99.5% of the balance (a dust margin against oversized-swap
    // failures), so on every chambered fire this differs from `rawSell`. Booking
    // `rawSell` recorded a 100% sale, allocated 100% of cost basis, understated
    // the fill price by the same 0.5%, and closed a position that still held
    // tokens. Defaults to the requested amount, which is exact on the fallback path.
    let executedRaw = rawSell;
    if (cfg.LIVE_PRESIGNED_EXITS && isProtective && rawSell === raw) {
      // `raw` is the balance just read from chain — the guard needs it to
      // reject a round signed against a pre-bank quantity.
      const fired = await fireChambered(cfg, position.id, raw);
      if (fired) {
        executedRaw = fired.qtyRaw; // QTEA-002 — settled quantity, not requested
        usedProvider = `sniper:${fired.provider}`;
        tQuote = Date.now(); // chambered: zero quote time by design — the round was pre-signed
        res = await parseSettledSwap(cfg, fired.signature, WSOL_MINT, fired.landMs);
        await audit("live_presigned_fired", {
          mint: position.mint, positionId: position.id, landMs: fired.landMs, provider: fired.provider, reason,
        });
      } else {
        await audit("live_presigned_fallback", { mint: position.mint, positionId: position.id, reason });
      }
    }
    // Explicit slippageBps (the guard) always wins over the classification above.
    const base =
      slippageBps ??
      (isProtective
        ? cfg.LIVE_STOP_SLIPPAGE_BPS
        : isTakeProfit
          ? cfg.LIVE_TP_SLIPPAGE_BPS
          : cfg.LIVE_SELL_SLIPPAGE_BPS);
    // FIRE-SALE ESCALATION (72h tape, 2026-07-22): 7 write-offs at −$15.81 all
    // died retrying the SAME tolerance into a draining pool (21× ExceededSlippage
    // 6001), and AFTER peaked 7.84× yet filled at 0.52× because the TP held out
    // at 10% the whole way down. A repeated revert IS the measurement that the
    // pool is collapsing faster than the cap — so the cap must widen with each
    // attempt, not stand still: trails double per fail, protective stops grow
    // 1.5× per fail toward a 90% get-me-out ceiling, and a TP that has held out
    // adds its base back per holdout until it hits stop tolerance. Banking a
    // rung 20% under mark beats riding the position to zero.
    const attempts = sellBackoff.get(position.id);
    const escFails = attempts?.fails ?? 0;
    const escHold = attempts?.holdouts ?? 0;
    // Protective attempt one starts HOT (floor 2000bps): the cold first rung
    // was exactly what the preflight rejected during drains — the ladder now
    // begins where the fight actually is instead of climbing to it.
    const slip = isProtective
      ? Math.min(9_000, Math.max(Math.round(base * 1.5 ** escFails), 2_000))
      : isTakeProfit
        ? Math.min(cfg.LIVE_STOP_SLIPPAGE_BPS, base * (1 + escHold))
        : Math.min(cfg.LIVE_STOP_SLIPPAGE_BPS, base * 2 ** escFails);
    if (!res) {
      // FALLBACK PATH ONLY — the chamber either had no round or missed. Quoting
      // lives here now so a provider outage can never block the pre-signed exit.
      // QTEA-007: protective sells walk past OPEN breakers — a cooldown earned
      // on the buy path never suppresses a flee provider. QTEA-008: profit
      // exits (TP/trail/ordinary) take the best of two parallel quotes —
      // proceeds-optimal; protective stays on the ordered walk — time-optimal.
      let quote = isProtective
        ? await swapRouter.quote(cfg, position.mint, WSOL_MINT, rawSell, slip, {
            exclude: sellExclude.get(position.id),
            protective: true,
          })
        : await swapRouter.quoteBestSell(cfg, position.mint, rawSell, slip, {
            exclude: sellExclude.get(position.id),
          });
      usedProvider = quote.provider;
      tQuote = Date.now();

      // ── THE −45% STANDARD, ENFORCED (operator "let's fix now", 2026-07-31) ──
      // floor_45 fired as a DECISION and then handed execution a tolerance
      // measured off a MOVING quote — escalating to 9000bps on protective exits
      // — so an already-collapsed pool filled it at whatever price existed. The
      // standard said "never give up more than 45%" while the machinery
      // permitted −100%. zuckbot #6910: decision at 0.75×, fill near zero,
      // −106% of a traded dollar.
      //
      // The floor is anchored to COST BASIS, which does not move with the
      // collapse. Two enforcement steps, in order of what they cost us:
      if (cfg.LIVE_FILL_FLOOR_ENABLED && isProtective) {
        const solPx = (await solPxP) ?? 0;
        const qtyUi = Number(rawSell) / 10 ** decimals;
        const totQty = n(position.qtyTokens);
        const basisUsd = totQty > 0 ? n(position.sizeUsd) * (qtyUi / totQty) : 0;
        const floorUsd = basisUsd * cfg.LIVE_FILL_FLOOR_FRAC;
        // ── BROKER #7319 (2026-08-02): a BUILD-ONLY execution quote carries
        // outAmount 0 — reading it as the offer priced a $15k LIVE pool at $0,
        // blocked six payable sells a minute apart and wrote off a position
        // that printed +41% mid-freeze. When the build quote cannot value,
        // the offer comes from the executable mark (reserve math included);
        // if NOTHING can value it, the floor is unpriceable and fails OPEN —
        // the build's own on-chain minOut still protects the fill, and
        // freezing the exit is the failure mode that just cost the ticket.
        let offerRaw = Number(quote.outAmount);
        if (!(offerRaw > 0) || quote.canValue === false) {
          const val = await swapRouter.quoteValue(cfg, position.mint, rawSell, slip).catch(() => null);
          offerRaw = val ? Number(val.outAmount) : 0;
        }
        const offeredUsd = (offerRaw / 1e9) * solPx;
        // FAIL-OPEN on a price-fetch failure (solPx = 0) — deliberate. A floor
        // that blocks every sell when Jupiter's price endpoint blips would trap
        // the book, which is strictly worse than the leak it prevents.
        if (solPx > 0 && basisUsd > 0 && offerRaw > 0 && offeredUsd < floorUsd) {
          // (1) The pool CANNOT pay the standard. Refuse rather than donate.
          // The position stays latched and retries; if it never recovers it is
          // written off at the SAME dollar cost we would have booked by selling
          // — but we stop handing inventory over at 8 picodollars, and every
          // fill that does land is compliant with the standard by construction.
          // Backoff is deliberately NOT bumped: escalating tolerance is exactly
          // the mechanism that broke the floor.
          // ── A FLOOR BLOCK IS UNSELLABILITY EVIDENCE (operator 2026-08-02) ──
          // JORDAN #7110 sat open 11.9h and PIZZA #7127 10.1h, each blocked once
          // a minute, because the write-off lives in the CATCH block and a floor
          // block returns false instead of throwing: `fails` never incremented,
          // deadByEvidence never became true, and nothing ever closed. Two of
          // four slots frozen for half a day. The code already warned about this
          // class ("ANY persistently unsellable position must eventually be
          // written off") — the floor invented a new way to be unsellable that
          // walked around the counter.
          //
          // Writing off is NOT selling: no tokens are handed over at a bad
          // price, so the floor's purpose is intact. We simply stop calling a
          // worthless bag an open position, and the SLOT comes back — which in a
          // presence strategy is the asset actually being stolen.
          const prevFb = floorBlockAt.get(position.id);
          const fbCount = (prevFb?.count ?? 0) + 1;
          floorBlockAt.set(position.id, { at: Date.now(), count: fbCount, since: prevFb?.since ?? Date.now() });
          const blockedMin = (Date.now() - (prevFb?.since ?? Date.now())) / 60_000;
          if (fbCount >= cfg.LIVE_SELL_MAX_FAILS) {
            const remCost = n(position.sizeUsd) * (n(position.qtyRemaining) / Math.max(n(position.qtyTokens), 1e-9));
            await db.update(positions)
              .set({ status: "closed", closedAt: new Date(), exitReason: "live_unsellable",
                     realizedPnlUsd: String(n(position.realizedPnlUsd) - remCost), qtyRemaining: "0" })
              .where(and(eq(positions.id, position.id), eq(positions.status, "open")));
            await audit("live_unsellable_writeoff", {
              positionId: position.id, mint: position.mint, via: "cost_basis_floor",
              blocks: fbCount, blockedMin: Math.round(blockedMin), bookedLoss: -remCost,
              offeredFrac: +(offeredUsd / basisUsd).toFixed(4),
              reason: "route could not pay the −45% floor across consecutive attempts — slot reclaimed",
            });
            releaseChamber(position.id);
            exitLatch.delete(position.id); void forgetState("latch", position.id);
            floorBlockAt.delete(position.id);
            sellBackoff.delete(position.id);
            console.error(`🪦 LIVE WRITE-OFF ${short(position.mint)} — floor unpayable ${fbCount}× over ${blockedMin.toFixed(0)}min, booked −$${remCost.toFixed(2)}`);
            return true; // terminal
          }
          await audit("live_fill_floor_block", {
            positionId: position.id, mint: position.mint, reason,
            basisUsd: +basisUsd.toFixed(4), floorUsd: +floorUsd.toFixed(4),
            offeredUsd: +offeredUsd.toFixed(4),
            offeredFrac: +(offeredUsd / basisUsd).toFixed(4),
            provider: quote.provider,
          });
          return false;
        }
        // (2) The pool CAN pay it. Cap the tolerance so slippage between quote
        // and land cannot carry the fill below the floor. This re-quote only
        // fires when the escalated tolerance actually reaches past the standard
        // — i.e. precisely the case that produced −106% — so the flee path pays
        // an extra round-trip only when it is about to violate the rail.
        if (solPx > 0 && basisUsd > 0 && offeredUsd > 0) {
          const capBps = Math.floor((1 - floorUsd / offeredUsd) * 10_000);
          if (Number.isFinite(capBps) && capBps >= 0 && capBps < slip) {
            // Guarded: swapRouter.quote THROWS on a provider outage — that is the
            // documented reason the sniper was moved in front of it. This sits
            // inside the outer try, so an unguarded throw here would route to the
            // catch and kill a sell we had already proven the pool can pay. On
            // failure we keep the original quote: a fill at the wider tolerance
            // beats no fill, and the refusal branch above already established
            // that this route clears the floor.
            try {
              quote = await swapRouter.quote(cfg, position.mint, WSOL_MINT, rawSell, capBps, {
                exclude: sellExclude.get(position.id),
                protective: true, // this path only exists for protective exits
              });
              usedProvider = quote.provider;
              await audit("live_fill_floor_capped", {
                positionId: position.id, mint: position.mint, reason,
                slipWas: slip, slipNow: capBps, floorUsd: +floorUsd.toFixed(4),
                offeredUsd: +offeredUsd.toFixed(4),
              });
            } catch {
              /* keep the original quote — see above */
            }
          }
        }
      }
      // PROTECTIVE PRIORITY ESCALATION (operator "fix the bleeding", 2026-07-27):
      // hard stops booked −65% avg depth vs the −28% design — the flee tx was
      // losing the block race while the pool drained. A protective exit bids 3×
      // the standing priority fee (~$0.12): pennies against the 37pp of stop
      // slippage it races. Direct-build providers read the fee off cfg at build
      // time, so an overlay cfg scopes the bump to exactly this tx.
      const buildCfg = isProtective
        ? { ...cfg, PUMPPORTAL_PRIORITY_FEE: cfg.PUMPPORTAL_PRIORITY_FEE * 3 }
        : cfg;
      const b64 = await swapRouter.buildSwapTx(buildCfg, quote, wallet.publicKey.toBase58());
      // ALL sells skip our own preflight sim (widened from protective-only,
      // 2026-07-29): Wanjan died with a user_cut and two runner_timeouts queued
      // behind 6001 sim-fails — a commanded cut must never wait on a simulation,
      // and every sell is time-sensitive by nature. Buys keep the preflight.
      res = await executeSwap(cfg, b64, WSOL_MINT, { skipSim: true });
    }
    const sol = (await solPxP) ?? 0; // same in-flight fetch the floor used
    const proceedsUsd = res.outUi * sol;
    // QTEA-002 — SETTLED quantity, not requested. On a chambered fire these differ
    // by the sniper's 0.5% dust margin; everywhere else they are identical.
    const qtyUiSold = Number(executedRaw) / 10 ** decimals;
    const totalQty = n(position.qtyTokens);
    const costBasis = totalQty > 0 ? n(position.sizeUsd) * (qtyUiSold / totalQty) : 0;
    const feeUsd = res.feeSol * sol;
    const pnl = proceedsUsd - costBasis - feeUsd;
    const fillPxUsd = qtyUiSold > 0 ? proceedsUsd / qtyUiSold : 0;

    // ── QTEA-011: CLOSE FROM CHAIN TRUTH, NOT FROM PRE-SEND INTENT ───────────
    // `rawSell === raw` tested what we ASKED to sell. Combined with the sniper's
    // dust margin it closed positions that still held tokens, zeroed
    // qtyRemaining, and fired an ATA close at a non-empty account. Re-read the
    // balance after settlement and let the verdict decide. This read is OFF the
    // flee path — the sell has already landed — so it costs the exit nothing.
    let postRaw: bigint | null = null;
    try {
      const { PublicKey: PK } = await import("@solana/web3.js");
      const after = await rpcPool(cfg).read((c) =>
        c.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: new PK(position.mint) }),
      );
      let sum = 0n;
      for (const { account } of after.value) {
        const amt = (account.data as { parsed?: { info?: { tokenAmount?: { amount: string } } } }).parsed?.info?.tokenAmount;
        if (amt) sum += BigInt(amt.amount);
      }
      postRaw = sum;
    } catch {
      /* read failed — closeVerdict falls back to the settlement expectation */
    }
    const verdict = closeVerdict({
      preRaw: raw, executedRaw, postRaw, decimals,
      priceUsd: fillPxUsd, dustUsd: cfg.LIVE_DUST_CLOSE_USD,
    });
    if (verdict.kind === "mismatch") {
      // ── THE TOKENS DID NOT MOVE: BOOK THE FEE, NOT THE SALE ────────────────
      // My first cut audited the divergence, refused to close, and then fell
      // through and journalled the fill anyway — reasoning "the transaction
      // landed, so it really happened". JORDAN #7110 showed those are not the
      // same thing: the chambered round CONFIRMED on-chain at 03:37:42 for
      // 36,465 tokens at $0, and the wallet still held all 36,648. The book
      // ended up carrying the −$2.60 loss AND the inventory — a double count
      // waiting to happen the moment those tokens actually sell.
      //
      // `fills` means INVENTORY MOVED. A confirmed transaction that transferred
      // no tokens is an expense, not a fill. So: record the fee against the
      // position (it was genuinely paid), keep the chain-truth remainder, write
      // no fill row, and leave cost basis untouched.
      await audit("live_close_reconcile_mismatch", {
        positionId: position.id, mint: position.mint, reason,
        preRaw: raw.toString(), executedRaw: executedRaw.toString(),
        expectedRaw: verdict.expectedRaw.toString(), actualRaw: verdict.actualRaw.toString(),
        remainingUi: verdict.remainingUi,
        feeUsdBooked: +feeUsd.toFixed(6), signature: res.signature,
        note: "fill NOT journalled — settlement moved no tokens; fee only",
      });
      await db.update(positions).set({
        qtyRemaining: String(Math.max(0, verdict.remainingUi)),
        realizedPnlUsd: String(n(position.realizedPnlUsd) - feeUsd),
      }).where(eq(positions.id, position.id));
      // Still holding, still commanded: re-chamber for the real remaining size.
      // With the fail-closed anchor in presigned.ts, that re-chamber now REFUSES
      // when the pool cannot price the floor, instead of signing a $0 round.
      if (cfg.LIVE_PRESIGNED_EXITS) void chamberExit(cfg, position.id, position.mint);
      return false; // the exit did not achieve anything — stay latched, retry
    }
    if (verdict.kind === "dust_close") {
      await audit("live_close_dust", {
        positionId: position.id, mint: position.mint, reason,
        remainingUi: verdict.remainingUi, dustUsd: verdict.dustUsd,
      });
    }
    const closing = verdict.kind === "closed" || verdict.kind === "dust_close";
    const remainingUi = verdict.kind === "closed" ? 0 : verdict.remainingUi;
    // Sniper bookkeeping: a closed position frees its nonce; a partial sell
    // (TP banked) re-chambers for the new remaining quantity.
    if (cfg.LIVE_PRESIGNED_EXITS) {
      if (closing) releaseChamber(position.id);
      else void chamberExit(cfg, position.id, position.mint);
    }
    if (closing) floorBlockAt.delete(position.id);

    const [lsFill] = await db.insert(fills).values({
      positionId: position.id,
      side: "sell",
      qtyTokens: String(qtyUiSold),
      priceUsd: String(fillPxUsd),
      feeUsd: String(feeUsd),
      txSignature: res.signature,
      reason,
    }).returning({ id: fills.id });
    if (lsFill) void journalFill({ fillId: lsFill.id, book: "live", side: "sell", filledAt: new Date(),
      positionId: position.id, mint: position.mint, qty: qtyUiSold,
      priceUsd: fillPxUsd, feeUsd,
      entryPriceUsd: n(position.entryPriceUsd), reason, txSignature: res.signature });
    const closePatch = {
      qtyRemaining: String(Math.max(0, remainingUi)),
      realizedPnlUsd: String(n(position.realizedPnlUsd) + pnl),
      // Persist the realized exit price (proceeds per token) so the paired ledger
      // reads exit apples-to-apples without reconstructing from fills.
      ...(closing
        ? { status: "closed" as const, closedAt: new Date(), exitReason: reason, exitPriceUsd: String(fillPxUsd) }
        : {}),
    };
    try {
      await db.update(positions).set(closePatch).where(eq(positions.id, position.id));
    } catch (err) {
      // THE SELL IS DONE ON-CHAIN (fill row + tx signature recorded above).
      // A bookkeeping write failure must NEVER surface as a failed sell — the
      // caller's retry would re-sell an already-sold position (BullPad #5131
      // and CALLOUT both booked phantom losses this way; on re-read the row
      // was often already correct — DPI ack-loss, not a real write failure).
      // Verify-then-retry the WRITE only; if all else fails, log loudly and
      // let the chain-truth recon heal the row.
      let healed = false;
      for (let i = 0; i < 3 && !healed; i++) {
        await new Promise((r) => setTimeout(r, 500 * (i + 1)));
        try {
          const [row] = await db
            .select({ q: positions.qtyRemaining })
            .from(positions)
            .where(eq(positions.id, position.id));
          if (row && Math.abs(Number(row.q) - Math.max(0, remainingUi)) < 1e-6) {
            healed = true; // the "failed" write actually landed
            break;
          }
          await db.update(positions).set(closePatch).where(eq(positions.id, position.id));
          healed = true;
        } catch {
          /* next attempt */
        }
      }
      if (!healed) {
        console.error(
          `⚠️ book-write failed after CONFIRMED sell ${res.signature} (pos #${position.id}) — chain recon heals: ${err instanceof Error ? err.message.slice(0, 100) : err}`,
        );
        await audit("live_bookwrite_failed", {
          positionId: position.id,
          mint: position.mint,
          signature: res.signature,
          intended: closePatch,
        }).catch(() => {});
      }
    }
    await audit("live_sell", {
      positionId: position.id,
      mint: position.mint,
      fraction: f,
      proceedsUsd,
      pnl,
      reason,
      signature: res.signature,
      // GTPED §8 gap 2 — the sell-path stage clock. quote=0 on a chambered
      // fire (the round was pre-signed; that IS the design working).
      class: isProtective ? "protective" : isTakeProfit ? "take_profit" : "ordinary",
      toleranceBps: slip,
      provider: usedProvider,
      landMs: res.landMs,
      chambered: usedProvider?.startsWith("sniper:") ?? false,
      escalation: { fails: escFails, holdouts: escHold },
      latencyMs: {
        quote: tQuote > 0 ? tQuote - tSell0 : null,
        swapAndConfirm: tQuote > 0 ? Date.now() - tQuote : null,
        total: Date.now() - tSell0,
      },
    });
    console.log(
      `💸 LIVE SELL ${short(position.mint)} ${(f * 100).toFixed(0)}% → $${proceedsUsd.toFixed(2)} (pnl ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}, ${reason})`,
    );
    // CLOSE-ON-EXIT (operator-ratified 2026-07-24): a full sell leaves an empty
    // $0.15 rent shell — reclaim it immediately so the leak never rebuilds
    // (Sweeps A+B recovered $16.11 of exactly this). Fire-and-forget; a race
    // with a partial remainder just logs and the account catches the next pass.
    if (closing) void closeEmptyAtas(cfg, resp.value.map((v) => v.pubkey), position.mint);
    sellBackoff.delete(position.id); // it sold — clear any accumulated penalty
    sellExclude.delete(position.id);
    void forgetState("exclude", position.id);
    if (closing) { exitLatch.delete(position.id); void forgetState("latch", position.id); } // the commanded exit completed
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Venue build-rejects poison this position's route — exclude the provider
    // so the NEXT retry quotes elsewhere instead of dying on the same 400.
    let routePoisoned = false;
    if (/build 400|no .*pool|Virtual pool|not tradable|NO_ROUTES/i.test(msg)) {
      const ex = sellExclude.get(position.id) ?? [];
      // Exclude the provider this attempt actually used; fall back to the
      // router's last route only if the failure predated the quote.
      const prov = usedProvider ?? swapRouter.lastRoute();
      if (prov && !ex.includes(prov)) {
        ex.push(prov);
        sellExclude.set(position.id, ex);
        void persistState("exclude", position.id, ex);
        routePoisoned = true; // a NEW venue is now reachable — don't make it wait
      }
    }
    // A take-profit that reverts on tolerance is the tolerance DOING ITS JOB — the
    // rung refused a bad price on a position that is winning. It must never feed
    // the strand-writeoff counter: LIVE_SELL_MAX_FAILS would otherwise book a live
    // WINNER as "unsellable" and realize a total loss after six tight-slippage
    // reverts. Retry on the flat fuse and leave the failure count untouched; if the
    // token really is unsellable, the trail and guard exits reach this catch with a
    // protective reason and the write-off fires from there.
    if (isTakeProfit) {
      const prev = sellBackoff.get(position.id);
      const holdouts = (prev?.holdouts ?? 0) + 1;
      sellBackoff.set(position.id, { fails: prev?.fails ?? 0, holdouts, nextAttemptMs: Date.now() + TP_RETRY_MS });
      console.warn(`live TP held out ${short(position.mint)} (${reason}) #${holdouts} — escalating tolerance next try, retry ${TP_RETRY_MS / 1000}s: ${msg}`);
      return false;
    }
    // Back off before anything else — a failing sell must not be free to retry.
    // The first two retries are FAST (2s): in a collapse the escalated slippage
    // needs its shot while there is still a pool to hit — the old 5s→10s→20s
    // walk-away gave the rug the whole window. The exponential fuse takes over
    // from the third fail so a truly stuck position still degrades itself.
    const prevEntry = sellBackoff.get(position.id);
    const fails = (prevEntry?.fails ?? 0) + 1;
    // A poisoned route is not a busy venue — the exclusion means the NEXT attempt
    // quotes somewhere else entirely, so backing off just donates the window to
    // the drain. Retry on the very next tick; the exponential fuse still governs
    // repeated failures once every venue has had its turn.
    const waitMs = routePoisoned ? 0 : fails <= 2 ? 2_000 : Math.min(SELL_BACKOFF_MAX_MS, SELL_BACKOFF_BASE_MS * 2 ** (fails - 3));
    sellBackoff.set(position.id, { fails, holdouts: prevEntry?.holdouts, nextAttemptMs: Date.now() + waitMs });
    // Audit only the first few failures; a stuck position must not spam the log.
    if (fails <= 3)
      await audit("live_sell_failed", { positionId: position.id, mint: position.mint, reason, error: msg, fails, backoffMs: waitMs }).catch(() => {});
    console.error(`live sell failed ${short(position.mint)} (#${fails}, backoff ${Math.round(waitMs / 1000)}s): ${msg}`);
    // Stranded write-off: if EVERY route is exhausted (no exit exists) and the
    // position is old enough to rule out a transient blip, stop retrying forever
    // and book the honest loss on the remaining tokens. A token we can't sell is a
    // total loss, not an open position.
    const ageMin = (Date.now() - new Date(position.openedAt).getTime()) / 60_000;
    const noRoute = /no route|build 400|no pool|NO_ROUTES|routes found|all providers|all RPCs/i.test(msg);
    // ANY persistently unsellable position must eventually be written off, not
    // just route-exhausted ones. REBECA (2026-07-20) retried a `simulation
    // failed: InstructionError` sell every ~7s for 112 MINUTES — the error never
    // matched the no-route regex, so the write-off never fired and the retry
    // loop burned RPC budget and cycle time indefinitely. A token we cannot sell
    // after this long is a total loss whatever the error says; book it honestly
    // and stop spamming. The no-route fast path keeps its shorter fuse.
    // EVIDENCE, not a clock: N consecutive failed sells IS the proof the position
    // is dead — waiting out an age fuse just parks capital and a concurrency slot
    // on a corpse. With exponential backoff, LIVE_SELL_MAX_FAILS=6 is ~5 minutes
    // of genuine attempts rather than an arbitrary 24-minute wait.
    const deadByEvidence = fails >= cfg.LIVE_SELL_MAX_FAILS;
    if ((noRoute && ageMin > cfg.LIVE_STRAND_WRITEOFF_MIN) || deadByEvidence) {
      const remCost = n(position.sizeUsd) * (n(position.qtyRemaining) / Math.max(n(position.qtyTokens), 1e-9));
      await db
        .update(positions)
        .set({ status: "closed", closedAt: new Date(), exitReason: "live_unsellable", realizedPnlUsd: String(n(position.realizedPnlUsd) - remCost), qtyRemaining: "0" })
        .where(and(eq(positions.id, position.id), eq(positions.status, "open")));
      await audit("live_unsellable_writeoff", { positionId: position.id, mint: position.mint, ageMin: Math.round(ageMin), bookedLoss: -remCost, error: msg });
      releaseChamber(position.id); // writeoff frees the nonce too
      exitLatch.delete(position.id); void forgetState("latch", position.id); // terminal — the position is closed
      console.error(`🪦 LIVE WRITE-OFF ${short(position.mint)} — unsellable after ${ageMin.toFixed(0)}min, booked −$${remCost.toFixed(2)}`);
      sellBackoff.delete(position.id); // terminal — nothing left to retry
    }
    return false;
  }
}

/**
 * Mints whose mirror sell is IN FLIGHT. The sweep must never race these.
 *
 * The race (diagnosed 2026-07-20 from a live-vs-paper trade audit): paper calls
 * mirrorLiveSell fire-and-forget then closes its own row immediately, so for the
 * 5–10s the mirror spends on-chain (balance read → quote → build → sign →
 * confirm) the live position has NO paper twin. The 5s sweep saw exactly that
 * and fired its own sell — 6 of 13 live exits came out as live_sweep_close /
 * live_desync_empty instead of the intended profit_trail, at the WORST possible
 * moment. THUNDERCAT: paper exited at 1.018× (+$0.05), live's contested exit
 * landed 7s later at $0.00 (−$2.93, a full stake). Mirroring paper's P&L means
 * mirroring paper's EXIT TIMING; the sweep is a backstop, never the primary path.
 */
const mirrorSellInFlight = new Set<string>();

/**
 * Mirror a paper exit onto the live twin (same mint, open, lane='live').
 * Failures are contained — sweepLiveBook() closes any stragglers, but only
 * after the grace window proves the mirror really did fail.
 */
export async function mirrorLiveSell(cfg: HermesConfig, mint: string, fraction: number, reason: string): Promise<void> {
  if (!cfg.LIVE_TRADING_ENABLED || !liveWallet()) return;
  // THE TP0 SKIP IS GONE (2026-07-20). It deferred the first defensive tranche to
  // the early-fill floor — but the floor never fires: 50 live sells over 6h
  // produced ZERO take_profit_0 and ZERO floor fills, so live banked nothing
  // until TP1 at 1.3x while paper banked 40-87% at 1.15x. Every live winner rode
  // naked through the latency gap and gave the move back. Live now mirrors TP0
  // like every other tranche; if the floor is ever proven to fire, the cumulative
  // sold-fraction logic in decideExit already prevents double-banking.
  const [pos] = await db
    .select()
    .from(positions)
    .where(and(eq(positions.lane, "live"), eq(positions.mint, mint), eq(positions.status, "open")))
    .limit(1);
  if (!pos) return;
  // Claim this mint for the duration of the on-chain round trip.
  if (mirrorSellInFlight.has(mint)) return; // a mirror is already selling it
  mirrorSellInFlight.add(mint);
  try {
    await liveSellPosition(cfg, pos, fraction, reason);
  } finally {
    mirrorSellInFlight.delete(mint);
  }
}

/**
 * Self-healing reconciliation, run once per manage cycle: any live position
 * whose paper twin is gone (mirror sell failed, restart raced, etc.) gets
 * force-closed — the live book can trail the brain by one cycle, never drift.
 */
let sweeping = false;
/**
 * WALLET COMMAND QUEUE — operator sends queued by the dashboard, executed here.
 *
 * The dashboard validates and writes a `wallet_send_request` row; this loop is
 * the only thing that moves the money. Two reasons it lives in the trader and
 * not the dashboard: the trader's rpcPool is the connection that provably works
 * on this host (fresh Node processes get ECONNRESET from the public RPCs), and
 * a single money-mover process means every SOL movement — trade or transfer —
 * goes through one pipeline with one audit trail. The claim is an atomic
 * UPDATE … WHERE status='pending', so a duplicate daemon can never double-send.
 */
/** Operator's manual close queue — the dashboard writes `live_close_request`,
 *  this consumes it: full-fraction sell through the fire-sale machinery as
 *  `user_cut`. Atomic claim via jsonb status flip; every outcome audited. */
export async function processLiveCloseRequests(cfg: HermesConfig): Promise<void> {
  const rows = (await db.execute(sql`
    SELECT value FROM config WHERE key = 'live_close_request' AND value->>'status' = 'pending'`)) as unknown as
    { value: { positionId?: number } }[];
  if (!rows.length) return;
  const claimed = (await db.execute(sql`
    UPDATE config SET value = value || '{"status":"claimed"}'::jsonb, updated_at = now()
    WHERE key = 'live_close_request' AND value->>'status' = 'pending'
    RETURNING value`)) as unknown as { value: { positionId?: number } }[];
  if (!claimed.length) return;
  const pid = Number(claimed[0]!.value.positionId);
  const [pos] = await db.select().from(positions).where(and(eq(positions.id, pid), eq(positions.lane, "live"), eq(positions.status, "open"))).limit(1);
  if (!pos) {
    await db.execute(sql`UPDATE config SET value = value || '{"status":"done","note":"position not open"}'::jsonb WHERE key = 'live_close_request'`);
    await audit("live_close_request_done", { positionId: pid, note: "position not open (already closed?)" });
    return;
  }
  const ok = await liveSellPosition(cfg, pos, 1, "user_cut");
  await db.execute(sql`UPDATE config SET value = value || ${JSON.stringify({ status: ok ? "done" : "failed" })}::jsonb WHERE key = 'live_close_request'`);
  await audit("live_close_request_done", { positionId: pid, sold: ok });
  console.log(`🖐 operator close ${short(pos.mint)} → ${ok ? "SOLD" : "FAILED (fire-sale escalation continues next cycles)"}`);
}

export async function processWalletSends(cfg: HermesConfig): Promise<void> {
  const claimed = (await db.execute(sql`
    UPDATE config SET value = value || '{"status":"processing"}'::jsonb, updated_at = now()
    WHERE key = 'wallet_send_request' AND value->>'status' = 'pending'
    RETURNING value`)) as unknown as {
    value: { id?: string; to?: string; amountSol?: number; memo?: string };
  }[];
  const req = claimed[0]?.value;
  if (!req) return;
  const patch = (p: Record<string, unknown>) =>
    db
      .execute(sql`UPDATE config SET value = value || ${JSON.stringify(p)}::jsonb, updated_at = now() WHERE key = 'wallet_send_request'`)
      .catch(() => {});
  const wallet = liveWallet();
  const amt = Number(req.amountSol);
  try {
    if (!wallet) throw new Error("no wallet key");
    if (!Number.isFinite(amt) || amt <= 0) throw new Error("invalid amount");
    const { PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } = await import("@solana/web3.js");
    const dest = new PublicKey(String(req.to ?? ""));
    const rpc = rpcPool(cfg);
    const lamports = await rpc.read((c) => c.getBalance(wallet.publicKey, "confirmed"));
    const reserve = 0.01;
    if (amt > lamports / LAMPORTS_PER_SOL - reserve)
      throw new Error(`amount exceeds sendable balance (${Math.max(0, lamports / LAMPORTS_PER_SOL - reserve).toFixed(6)} SOL after the ${reserve} SOL fee reserve)`);
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: dest, lamports: Math.round(amt * LAMPORTS_PER_SOL) }),
    );
    const { blockhash } = await rpc.read((c) => c.getLatestBlockhash("confirmed"));
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;
    tx.sign(wallet);
    const signature = await rpc.send(tx, { skipPreflight: false, maxRetries: 3 });
    const deadline = Date.now() + 45_000;
    let landed = false;
    while (Date.now() < deadline) {
      const st = (await rpc.read((c) => c.getSignatureStatuses([signature]))).value[0];
      if (st?.err) throw new Error(`tx failed on-chain: ${JSON.stringify(st.err)} (${signature})`);
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
        landed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1_500));
    }
    if (!landed) throw new Error(`confirmation timed out (${signature})`);
    // Book it: cash out, external transfer, network fee. Σ legs = 0; the tx
    // signature is the idempotency key so a replay can never double-book.
    const recon = (await db.execute(sql`SELECT value FROM config WHERE key = 'ledger_recon_status'`)) as unknown as {
      value: { solUsd?: number };
    }[];
    const solUsd = recon[0]?.value?.solUsd ?? 0;
    const feeSol = 0.000005;
    const key = `tx:${signature}`;
    const memoText = (req.memo ?? "").trim() || `withdrawal — operator send to ${dest.toBase58().slice(0, 4)}…${dest.toBase58().slice(-4)}`;
    await db.transaction(async (txdb) => {
      await txdb.execute(sql`
        INSERT INTO ledger_events (book, event_type, occurred_at, idempotency_key, tx_signature, memo, evidence)
        VALUES ('live', 'transfer.out', now(), ${key}, ${signature}, ${memoText},
                ${JSON.stringify({ to: dest.toBase58(), amountSol: amt, solUsd })}::jsonb)
        ON CONFLICT (idempotency_key) DO NOTHING`);
      await txdb.execute(sql`
        INSERT INTO ledger_legs (event_id, account, amount_usd, amount_native, mint)
        SELECT e.id, l.acct, l.usd, l.sol, NULL::text FROM ledger_events e,
        LATERAL (VALUES
          ('cash:sol', ${String(-(amt + feeSol) * solUsd)}::numeric, ${String(-(amt + feeSol))}::numeric),
          ('transfer:external', ${String(amt * solUsd)}::numeric, ${String(amt)}::numeric),
          ('expense:fee:network', ${String(feeSol * solUsd)}::numeric, ${String(feeSol)}::numeric)
        ) l(acct, usd, sol)
        WHERE e.idempotency_key = ${key}
          AND NOT EXISTS (SELECT 1 FROM ledger_legs ll WHERE ll.event_id = e.id)`);
    });
    await patch({ status: "sent", signature, usd: solUsd ? amt * solUsd : null, sentAt: new Date().toISOString() });
    await audit("wallet_send", { to: dest.toBase58(), amountSol: amt, usd: amt * (solUsd || 0), signature });
    console.log(`💸 WALLET SEND ${amt} SOL → ${dest.toBase58().slice(0, 4)}…${dest.toBase58().slice(-4)} (tx ${signature.slice(0, 8)}…)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await patch({ status: "failed", error: msg, failedAt: new Date().toISOString() });
    await audit("wallet_send_failed", { to: req.to, amountSol: amt, error: msg }).catch(() => {});
    console.error(`💸 WALLET SEND FAILED: ${msg}`);
  }
}

export async function sweepLiveBook(cfg: HermesConfig): Promise<void> {
  if (!cfg.LIVE_TRADING_ENABLED || !liveWallet()) return;
  if (sweeping) return; // a chain confirm can outlast a 5s tick — never overlap
  sweeping = true;
  try {
    await sweepLiveBookInner(cfg);
  } finally {
    sweeping = false;
  }
}

async function sweepLiveBookInner(cfg: HermesConfig): Promise<void> {
  const rows = await db
    .select()
    .from(positions)
    .where(and(eq(positions.lane, "live"), eq(positions.status, "open")));
  for (const lp of rows) {
    // GUARD 0 — INDEPENDENT LIVE POSITIONS ARE NOT SWEPT.
    // This backstop exists for the MIRROR era, when every live position was the
    // shadow of a paper one and a live row with no paper twin meant a failed
    // mirror sell had stranded it. Live now trades its OWN signals, so a live
    // position frequently has no paper twin by design — paper may have been
    // blocked by its lane book, a venue filter or slippage while live filled.
    // Without this guard the sweep would force-close every independent live
    // trade within one manage cycle, which is the opposite of a backstop.
    // A signature-routed live position is governed by its genome and the guard;
    // only legacy mirror rows fall through to the twin check.
    if (lp.signature) continue;
    // GUARD 1 — a mirror sell owns this mint right now. Racing it produces a
    // contested exit at a worse price (and mislabels the fill).
    if (mirrorSellInFlight.has(lp.mint)) continue;
    const [twin] = await db
      .select({ id: positions.id })
      .from(positions)
      .where(and(eq(positions.lane, "paper"), eq(positions.mint, lp.mint), eq(positions.status, "open")))
      .limit(1);
    if (twin) continue;
    // GUARD 2 — the twin closed only moments ago, so the mirror is in flight or
    // about to be. Give it the grace window before the backstop takes over; only
    // a mirror that genuinely failed should ever exit as live_sweep_close.
    const [lastTwin] = await db
      .select({ closedAt: positions.closedAt })
      .from(positions)
      .where(and(eq(positions.lane, "paper"), eq(positions.mint, lp.mint), eq(positions.status, "closed")))
      .orderBy(desc(positions.closedAt))
      .limit(1);
    const closedMsAgo = lastTwin?.closedAt ? Date.now() - new Date(lastTwin.closedAt).getTime() : Infinity;
    if (closedMsAgo < cfg.LIVE_SWEEP_GRACE_SEC * 1000) continue;
    await liveSellPosition(cfg, lp, 1, "live_sweep_close");
  }
}

/**
 * LIVE PROTECTIVE GUARD — the live lane's OWN downside exit, independent of the
 * paper twin. Probes each open live position's real sellability every cycle: if
 * the sell would move the pool past LIVE_RUG_IMPACT_PCT (draining) or the mark is
 * down past the wide catastrophe backstop, it cuts NOW — turning the −100% sweep
 * into a −60% exit while liquidity remains. Deliberately NOT a tight price stop
 * (that forfeits convex runners); it only kills the zero-bound tail. A no-route
 * probe (already rugged, unsellable) is left for the sweep/desync path — the loss
 * is already taken; we don't write off on a possibly-transient Jupiter blip.
 */
let guarding = false;
let lastGuard = 0;
export async function guardLiveBook(cfg: HermesConfig): Promise<void> {
  if (!cfg.LIVE_TRADING_ENABLED || !cfg.LIVE_GUARD_ENABLED || !liveWallet()) return;
  if (Date.now() - lastGuard < cfg.LIVE_GUARD_MS) return;
  lastGuard = Date.now();
  if (guarding) return;
  guarding = true;
  try {
    await guardLiveBookInner(cfg);
  } finally {
    guarding = false;
  }
}

// Consecutive guard cycles a live position has read below the stop threshold, so a
// single glitched quote never cuts a winner paper is still riding (2× = confirmed).
const guardHits = new Map<number, number>();
// Native-book sensory caches. (Small duplicates of paper.ts helpers — a
// direct import would be circular: paper.ts already imports this module.)
const liveEntryLiqCache = new Map<number, number | null>();
async function liveEntryLiq(lp: { id: number; mint: string; openedAt: Date }): Promise<number | null> {
  if (liveEntryLiqCache.has(lp.id)) return liveEntryLiqCache.get(lp.id)!;
  try {
    const openedIso = lp.openedAt.toISOString(); // toISOString — the wedge lesson
    const [t] = (await db.execute(sql`
      SELECT liquidity_usd::float AS liq FROM candidate_ticks
      WHERE mint = ${lp.mint}
        AND snapped_at BETWEEN ${openedIso}::timestamptz - interval '20 seconds' AND ${openedIso}::timestamptz + interval '5 seconds'
      ORDER BY snapped_at DESC LIMIT 1`)) as unknown as { liq: number | null }[];
    const liq = t?.liq != null && Number.isFinite(Number(t.liq)) && Number(t.liq) > 0 ? Number(t.liq) : null;
    liveEntryLiqCache.set(lp.id, liq);
    return liq;
  } catch {
    liveEntryLiqCache.set(lp.id, null);
    return null;
  }
}
const liveLpUnlockedCache = new Map<string, boolean>();
async function liveLpUnlocked(mint: string): Promise<boolean> {
  const hit = liveLpUnlockedCache.get(mint);
  if (hit !== undefined) return hit;
  try {
    const [row] = (await db.execute(sql`
      SELECT bool_or(evidence::text ILIKE '%LP Unlocked%') unlocked
      FROM safety_checks WHERE mint = ${mint} AND check_name = 'rugcheck'`)) as unknown as { unlocked: boolean | null }[];
    const unlocked = row?.unlocked ?? true; // missing data → insure by default
    liveLpUnlockedCache.set(mint, unlocked);
    return unlocked;
  } catch {
    return true;
  }
}
// ── PARITY: LIVE'S POOL FEED MUST BE AS FRESH AS PAPER'S (2026-07-31) ───────
// decideExit is shared, so live and paper run the SAME capture genome — but a
// shared rule fed different data is not the same rule. Paper hands it a live
// market read every tick; live hands it the newest candidate_tick, which had
// no freshness guard at all. Measured over 6h of closes: median staleness 2s,
// but a real tail — 7% over 60s and 4% over FIVE MINUTES, because ticks stop
// when a mint leaves the candidate window while we still hold it.
//
// Acting on five-minute-old depth is worse than not acting: pool ownership
// would either hold a position with no live capture rule or release it on a
// phantom turn, and poolPeak would anchor to a stale high. Past the cutoff we
// return null, which sets poolOwns=false and hands the position back to the
// legacy stack — where the profit lock and the milestone ratchet still govern.
// That is exactly the fail-safe the ownership design was built around.
const LIVE_LIQ_MAX_AGE_SEC = 90;
async function liveLatestLiq(mint: string): Promise<number | null> {
  try {
    const [t] = (await db.execute(sql`
      SELECT liquidity_usd::float AS liq,
             extract(epoch from (now() - snapped_at)) AS age
      FROM candidate_ticks WHERE mint = ${mint}
      ORDER BY snapped_at DESC LIMIT 1`)) as unknown as { liq: number | null; age: number }[];
    if (t?.liq == null || !Number.isFinite(Number(t.liq))) return null;
    if (Number(t.age) > LIVE_LIQ_MAX_AGE_SEC) return null; // stale → legacy stack owns it
    return Number(t.liq);
  } catch {
    return null;
  }
}
// Highest REAL sell-quote value / cost seen per live position — the live lane's
// own peak, used to arm the profit floor without waiting on the paper mirror.
const livePeakMark = new Map<number, number>();
let lastNoSolPriceAudit = 0;
async function guardLiveBookInner(cfg: HermesConfig): Promise<void> {
  const wallet = liveWallet();
  if (!wallet) return;
  const rows = await db
    .select()
    .from(positions)
    .where(and(eq(positions.lane, "live"), eq(positions.status, "open")));
  // Drop latches for positions that left the open book by any other path (mirror
  // sell, close request, recon) so the map tracks the book instead of growing.
  const openIds = new Set(rows.map((r) => r.id));
  for (const id of exitLatch.keys()) if (!openIds.has(id)) { exitLatch.delete(id); void forgetState("latch", id); }
  for (const id of livePeakMark.keys()) if (!openIds.has(id)) { livePeakMark.delete(id); void forgetState("peak", id); }
  if (rows.length === 0) return;
  const sol = (await solPriceUsd(cfg)) ?? 0;
  if (sol <= 0) {
    // No SOL price → can't value; skip rather than risk a false read. But a
    // skipped guard pass leaves the WHOLE live book unwatched, so it must leave
    // a trace (law 8: a silent decline is a defect). Throttled — feed outages
    // last minutes and the guard retries every LIVE_GUARD_MS.
    if (Date.now() - lastNoSolPriceAudit > 5 * 60_000) {
      lastNoSolPriceAudit = Date.now();
      await audit("live_guard_skipped", { reason: "no SOL price — whole-book guard pass skipped", openPositions: rows.length });
    }
    return;
  }
  const { PublicKey } = await import("@solana/web3.js");
  // Greens collected across the pass for the basket harvest below.
  const liveGreens: { lp: (typeof rows)[number]; upl: number }[] = [];
  // ── PHASE 1: VALUE THE WHOLE BOOK IN PARALLEL (2026-07-31) ────────────────
  // This loop was fully serial: every position awaited an RPC balance read
  // (~400ms) and then a Jupiter sell quote (~500ms) before the next one began.
  // At four positions that is ~4s per pass on top of the 2s tick, and it is
  // exactly what the tape showed — live decided on marks averaging EIGHT
  // seconds old while paper, which batches one fetchTokenMarkets call for its
  // whole book, decided on two. Eight seconds of staleness, then another
  // 2.5-13.5s to land, on tokens that round-trip in twenty-five.
  //
  // Valuation is read-only and independent per position, so it parallelises
  // safely. The DECISION loop below stays strictly serial — nonce contention,
  // the in-flight claim and the double-sell guards all depend on that.
  const valued = new Map<number, { raw: bigint; value: number | null; impliedLiq: number | null }>();
  await Promise.all(
    rows.map(async (lp) => {
      try {
        const r = await rpcPool(cfg).read((c) =>
          c.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(lp.mint) }),
        );
        let raw0 = 0n;
        for (const { account } of r.value) {
          const amt = (account.data as { parsed?: { info?: { tokenAmount?: { amount: string } } } }).parsed?.info?.tokenAmount;
          if (amt) raw0 += BigInt(amt.amount);
        }
        let value0: number | null = null;
        let liq0: number | null = null;
        if (raw0 > 0n) {
          try {
            // QTEA-003: the mark comes from the whole provider universe, not
            // Jupiter alone — a fresh direct-DEX pool Jupiter hasn't indexed
            // no longer leaves the seat valued off the recorder feed.
            const j = await swapRouter.quoteValue(cfg, lp.mint, raw0, cfg.LIVE_STOP_SLIPPAGE_BPS);
            const outSol = Number(j.outAmount) / 1e9;
            if (outSol > 0) value0 = outSol * sol;
            // QTEA-004: priceImpactPct is a FRACTION. This read it as percentage
            // points, inflating implied depth ~100× and standing down every
            // depth-based protection against a phantom-deep pool.
            if (value0 != null) liq0 = impliedLiquidityUsd(value0, impactFraction(j.priceImpactPct));
          } catch {
            /* no live sell route — handled below exactly as before */
          }
        }
        valued.set(lp.id, { raw: raw0, value: value0, impliedLiq: liq0 });
      } catch {
        /* leave unset — the serial pass re-reads this one on its own */
      }
    }),
  );

  for (const lp of rows) {
    try {
      const pre = valued.get(lp.id);
      let raw = pre?.raw ?? 0n;
      if (!pre) {
        // Pre-pass missed this row (RPC hiccup) — fall back to the original
        // serial read so a transient failure never silently skips a position.
        const resp = await rpcPool(cfg).read((c) =>
          c.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(lp.mint) }),
        );
        raw = 0n;
        for (const { account } of resp.value) {
          const amt = (account.data as { parsed?: { info?: { tokenAmount?: { amount: string } } } }).parsed?.info?.tokenAmount;
          if (amt) raw += BigInt(amt.amount);
        }
      }
      if (raw <= 0n) {
        await liveSellPosition(cfg, lp, 1, "live_guard_empty"); // closes the ledger honestly
        continue;
      }
      // Value by a REAL SELL QUOTE — what we'd ACTUALLY get selling right now — not
      // the price-API mark. The mark can glitch stale/low and fire a FALSE stop on a
      // healthy position (SIGNAL: the mark read −28% but the real sell was breakeven,
      // and paper rode it to 1.43×). No quote (no route) → can't value → leave it for
      // the sweep; never false-cut on missing/bad data.
      let value: number | null = null;
      // ── REAL-TIME DEPTH FROM THE QUOTE WE ALREADY MAKE (2026-07-31) ───────
      // Operator: "how can Lag be better than Live Liquidity Depth visibility…
      // the wallet should be faster at identifying the condition of the pool."
      // Exactly right, and we were doing the opposite. Live valued positions
      // from a REAL sell quote (no lag) but fed the depth-driven rules —
      // pool ownership, the liquid window, the drain guard — from
      // candidate_ticks, the DexScreener tape, which trails an LP pull by
      // seconds. So the wallet holding the token had worse depth vision than
      // the aggregator, while owning the one instrument that cannot lag: the
      // route itself.
      //
      // priceImpactPct on a full-position sell IS a depth measurement, taken
      // against the pool as it exists this instant. Inverting our own
      // convexSlippagePct model recovers implied liquidity:
      //     impact = trade / (liq/2 + trade) * 100
      //  ⇒  liq    = 2 · trade · (100/impact − 1)
      // A pulled pool prices as enormous impact (or refuses to quote at all),
      // so the drain shows up here the moment it happens rather than whenever
      // the aggregator notices.
      let impliedLiq: number | null = null;
      if (pre) {
        // Taken from the parallel pre-pass — same quote, ~2s old instead of ~8s.
        value = pre.value;
        impliedLiq = pre.impliedLiq;
      } else {
        try {
          // QTEA-003 — router-wide executable mark, not Jupiter-only.
          const j = await swapRouter.quoteValue(cfg, lp.mint, raw, cfg.LIVE_STOP_SLIPPAGE_BPS);
          const outSol = Number(j.outAmount) / 1e9;
          if (outSol > 0) value = outSol * sol;
          // QTEA-004 — see the parallel pre-pass above. Fraction, not percent.
          if (value != null) impliedLiq = impliedLiquidityUsd(value, impactFraction(j.priceImpactPct));
        } catch {
          /* no live sell route — the sweep/mirror handles it, don't false-cut here */
        }
      }
      // FEED-MARK FALLBACK, routed rows only. The valuation walk now reaches
      // the direct providers' own pool state (QTEA-003), so this fallback owns
      // a much narrower window: venues with no reserve-math valuation yet
      // (meteora, curve) in their pre-index minutes — so a
      // just-opened live position had no mark at all: no tick telemetry, no
      // genome exits, nothing but the clock, in exactly the minutes where these
      // tokens live and die. But the recorder is already watching this mint
      // every 2s. Its latest trusted read is the SAME feed paper marks from, so
      // managing on it is 1:1 by construction. The sell, if decided, still goes
      // through the router — PumpSwap builds fine for the pools Jupiter can't
      // quote. Trusted = fresh (≤60s) and real liquidity (≥$1k, the flicker
      // guard). Legacy unrouted rows keep quote-only marks: their tight
      // hard-stop is exactly what a glitched feed read could false-fire.
      let markSource: "sell-quote" | "feed" = "sell-quote";
      let tickRecorded = false;
      if (value == null && lp.signature) {
        const entry0 = n(lp.entryPriceUsd);
        if (entry0 > 0) {
          const [ct] = await db
            .select({ priceUsd: candidateTicks.priceUsd, liq: candidateTicks.liquidityUsd, at: candidateTicks.snappedAt })
            .from(candidateTicks)
            .where(eq(candidateTicks.mint, lp.mint))
            .orderBy(desc(candidateTicks.id))
            .limit(1);
          if (ct && Date.now() - ct.at.getTime() <= 60_000 && Number(ct.priceUsd) > 0) {
            // TELEMETRY on any fresh price — recording is not acting. POOL's
            // pool drained to liq 0 and the flicker guard silently swallowed
            // the whole trajectory: the live card read "awaiting first
            // observation" while the token sat at 0.10×. The card must tell
            // that story; only DECISIONS demand a trusted read.
            const feedMark = Number(ct.priceUsd) / entry0;
            // PEAK SANITY (BBC 616f, 2026-07-22): a $3k dust pool printed a
            // phantom 16,913× while the recorder's own tape peaked 2.7× — one
            // corrupt print then owns the gain-lock floor and explodes the
            // capture denominator. Telemetry may narrate ANY read, but only a
            // plausible one — liquid pool, sub-3× single-tick jump — may raise
            // the peak that decisions and statistics are built on.
            const prevPeak = livePeakMark.get(lp.id) ?? 1;
            const plausible = Number(ct.liq ?? 0) >= 1_000 && feedMark <= Math.max(prevPeak, 1) * 3;
            const feedPeak = plausible ? Math.max(prevPeak, feedMark) : prevPeak;
            livePeakMark.set(lp.id, feedPeak);
            if (feedPeak > prevPeak) void persistState("peak", lp.id, feedPeak);
            void db
              .insert(positionTicks)
              .values({
                positionId: lp.id,
                priceUsd: String(entry0 * feedMark),
                markMultiple: String(feedMark),
                peakMultiple: String(feedPeak),
                drawdownFromPeakPct: String(feedPeak > 0 ? ((feedPeak - feedMark) / feedPeak) * 100 : 0),
                ageMinutes: String((Date.now() - lp.openedAt.getTime()) / 60_000),
              })
              .catch(() => {});
            tickRecorded = true;
            // ACTION only on real liquidity (≥$1k — the flicker guard): the
            // genome may manage on this mark because paper manages on the same
            // feed. A drained pool stays on the clock-force path — there is
            // nothing to sell into, and pretending otherwise books fantasy.
            if (ct.liq != null && Number(ct.liq) >= 1_000) {
              value = n(lp.sizeUsd) * feedMark;
              markSource = "feed";
            }
          }
        }
      }
      if (value == null) {
        guardHits.delete(lp.id);
        // NO SELL QUOTE. Transiently this is fine — a 504 or a momentary route gap
        // should not cut a position. But for a token that has genuinely LOST its
        // route this is true on every cycle, forever, and the loop skipped the
        // genome exit before it was ever consulted. That stranded seven live
        // positions tonight: all rugged, all quoteless, all sitting open 20-73
        // minutes past a 12.7-minute clock with qty_remaining at 100%, while the
        // ledger showed them as live exposure.
        //
        // So once a routed position is past its OWN clock, stop skipping and
        // attempt the exit regardless. Either the sell lands, or it fails and
        // liveSellPosition's strand write-off accumulates evidence until it books
        // the loss honestly. Both outcomes close the position; skipping never does.
        if (lp.signature) {
          const ageSec = (Date.now() - new Date(lp.openedAt).getTime()) / 1000;
          const clockSec = signatureExitOverrides(lp.signature as Signature).RUNNER_MAX_HOLD_SEC;
          if (clockSec > 0 && ageSec >= clockSec) {
            console.log(
              `🧬 LIVE ${lp.signature} ${short(lp.mint)} — past its ${Math.round(clockSec / 60)}m clock with no sell quote, forcing the exit`,
            );
            await liveSellPosition(cfg, lp, 1, "runner_timeout", cfg.LIVE_STOP_SLIPPAGE_BPS);
          }
        }
        continue;
      }
      const cost = n(lp.sizeUsd);
      // EARLY-FILL FLOOR (docs/live-early-fill-floor.md) — the insurance leg. Bank the
      // first defensive tranche the instant the position is up ≥ arm mult AND sellable.
      // `value` came from a REAL sell quote, so a non-null value ≥ arm PROVES a live
      // sell route exists right now — the quote itself is the liquidity gate, so this
      // fills BEFORE the pool can vanish (what live's −100% rugs needed). Independent of
      // the paper mirror; idempotent via soldFrac (survives restart, never double-banks;
      // the mirror skips take_profit_0 so the floor owns that rung). value/cost == mark
      // while nothing is sold, which is exactly the soldFrac<0.01 gate below.
      // TODO(farm): bank 100% on meteora-damm-v2 rug tape — needs the tokens.dex join.
      // ── 1:1 WITH PAPER ────────────────────────────────────────────────────
      // A signature-routed position is governed by its GENOME alone. Every
      // live-only rule below — the early floor, the never-close-red ratchet, the
      // fast protective stop — predates signature routing and would override the
      // class cover with a decision paper never makes. RISER covers at 0.40×, a
      // 60% drawdown; LIVE_STOP_PCT cuts at 28%, so the lanes would diverge on
      // the first dip and it would read as execution slippage rather than the
      // rules conflict it actually is. Legacy live rows keep all of it.
      const genomeOwned = lp.signature != null;
      // BASKET HARVEST, 1:1. Paper sweeps its whole green book when the aggregate
      // unrealised gain clears a threshold — it banked six positions for +$37 in a
      // single cycle tonight. Paper's version mirrors to live by MINT, which only
      // worked while live was a shadow; independent live holds different mints, so
      // it needs the same rule evaluated over its OWN book. Collected here from the
      // real sell-route value (more accurate than a price API) and executed after
      // the loop, so a harvest never races the per-position exits above.
      // Harvest only on a REAL sell quote — a feed-marked green has no proven
      // route, and the harvest's whole point is selling into live liquidity NOW.
      if (genomeOwned && markSource === "sell-quote" && cost > 0 && value > cost) liveGreens.push({ lp, upl: value - cost });
      if (cfg.LIVE_FLOOR_ENABLED && !genomeOwned) {
        const soldFrac = 1 - n(lp.qtyRemaining) / Math.max(n(lp.qtyTokens), 1e-9);
        if (soldFrac < 0.01 && cost > 0 && value / cost >= cfg.LIVE_FLOOR_ARM_MULT) {
          console.log(
            `🩹 FLOOR ${short(lp.mint)} — ${cfg.LIVE_FLOOR_LOG_ONLY ? "would bank" : "banking"} ${(cfg.LIVE_FLOOR_FRACTION * 100).toFixed(0)}% @ ${(value / cost).toFixed(2)}x (sellable now — early insurance)`,
          );
          if (!cfg.LIVE_FLOOR_LOG_ONLY) {
            await liveSellPosition(cfg, lp, cfg.LIVE_FLOOR_FRACTION, "live_floor", cfg.LIVE_FLOOR_SLIPPAGE_BPS);
            guardHits.delete(lp.id);
            continue; // banked this cycle; the downside check resumes next cycle on fresh state
          }
        }
      }
      // ── LIVE PROFIT FLOOR — never hand back a trade that was green ─────────
      // Measured: paper protects 68.2% of positions reaching its arm, live only
      // 46.7% on identical rules. The gap is confirm latency — paper's floor
      // sells at 1.02x instantly, live's same order lands ~5s later THROUGH the
      // line. So live defends a higher line (LIVE_PROFIT_FLOOR_MULT, default
      // 1.05 vs paper's 1.02) and its late fill arrives near where paper's got
      // out. Peak is tracked from the REAL sell-quote value, so both the arm and
      // the trigger reflect what we could actually have realised. Fires
      // independently of the mirror: live owns its own profit protection.
      const markNow = cost > 0 ? value / cost : 1;
      const prevPeakMark = livePeakMark.get(lp.id) ?? 1;
      const peakMark = Math.max(prevPeakMark, markNow);
      livePeakMark.set(lp.id, peakMark);
      if (peakMark > prevPeakMark) void persistState("peak", lp.id, peakMark);
      // TELEMETRY, 1:1 WITH PAPER. Paper persists a position_tick every manage
      // poll; live never did — 27 live positions, 0 ticks — so the Trade Matrix
      // silently dropped every live bar (`if (!points.length) continue`) and a
      // live Position Command card was impossible (DNA, spark and factors are
      // all computed from ticks). The mark here is the REAL sell-route value,
      // so live's trajectory is better-grounded than paper's price-feed marks.
      // Best-effort: telemetry must never break the guard. Skipped when the
      // feed fallback already recorded this cycle's tick (no double-write).
      if (!tickRecorded) {
        void db
          .insert(positionTicks)
          .values({
            positionId: lp.id,
            priceUsd: String(n(lp.entryPriceUsd) * markNow),
            markMultiple: String(markNow),
            peakMultiple: String(peakMark),
            drawdownFromPeakPct: String(peakMark > 0 ? ((peakMark - markNow) / peakMark) * 100 : 0),
            ageMinutes: String((Date.now() - lp.openedAt.getTime()) / 60_000),
          })
          .catch(() => {});
      }
      if (
        cfg.LIVE_PROFIT_FLOOR_ENABLED &&
        !genomeOwned &&
        peakMark >= cfg.LIVE_PROFIT_ARM_MULT &&
        markNow <= cfg.LIVE_PROFIT_FLOOR_MULT &&
        markNow > 0
      ) {
        console.log(
          `🛟 LIVE PROFIT FLOOR ${short(lp.mint)} — peaked ${peakMark.toFixed(2)}x, now ${markNow.toFixed(2)}x → banking the win`,
        );
        await liveSellPosition(cfg, lp, 1, "live_profit_floor", cfg.LIVE_STOP_SLIPPAGE_BPS);
        guardHits.delete(lp.id);
        livePeakMark.delete(lp.id);
        continue;
      }
      // ── THE SAME FORMULA, STEP FOR STEP ───────────────────────────────────
      // A signature-routed live position runs the IDENTICAL decideExit paper
      // runs, under the IDENTICAL genome config. Live differs only in how the
      // sell executes, never in what it decides — paper has proven these
      // mechanics healthy, so reimplementing a second ladder here would
      // guarantee the lanes drift apart exactly where we need them comparable.
      //
      // The mark is derived from the real sell-route value rather than a price
      // API, so decideExit is fed a BETTER price than paper gets, not a worse
      // one. Imported lazily because paper.ts imports this module — a top-level
      // import would close the cycle.
      // ── THE LATCH HOLDS (2026-07-31) ────────────────────────────────────
      // A protective exit already commanded on this position outranks anything
      // decideExit has to say now. Retry it until it sells or writes off — the
      // sell self-throttles on its own backoff, so this is free when cooling.
      const latched = exitLatch.get(lp.id);
      if (latched) {
        console.log(
          `🔒 LIVE LATCH ${short(lp.mint)} — ${latched.reason} still commanded (${Math.round((Date.now() - latched.since) / 1000)}s), retrying the exit`,
        );
        await liveSellPosition(cfg, lp, latched.fraction, latched.reason, latched.slippageBps);
        continue;
      }
      if (lp.signature) {
        const { decideExit } = await import("../paper.js");
        const entry = Number(lp.entryPriceUsd) || 0;
        const ecfg = { ...cfg, ...signatureExitOverrides(lp.signature as Signature) };
        // liquidityUsd must be NULL, not 0: this synthetic predates the depth
        // rail, and the stubbed 0 read as "pool is dust" — every live position
        // depth-cut within seconds of its fill (6-for-6 on 2026-07-26 re-arm)
        // while paper twins rode 1.15-1.69×. Unknown depth skips the depth
        // rail here; real depth protection stays with the ws drain rail and
        // the paper mirror, which read actual pools.
        // THE NATIVE BOOK, FULL SENSES (operator 2026-07-29: "Shouldn't the
        // Live run its own book built on the best of the paper lane
        // strategy?"). This loop IS live's own manager — real sell-quote
        // marks, real balances, its own peak clock, its own basket harvest —
        // but it fed the genome a blind market (liquidityUsd null, no entry
        // depth, no LP state), so the drain guard ran ws-only and basis-first
        // ran on defaults. Now the genome gets everything paper's manager
        // gets: live depends on the mirror for NOTHING.
        // DEPTH PRECEDENCE: the live route first, the aggregator only as a
        // fallback. impliedLiq is measured against the pool as it exists right
        // now; liveLatestLiq is a DexScreener read that trails a pull. Feeding
        // the genome the stale one is what let positions ride into a vanished
        // pool and sell for $0.00 while the tape still showed a price.
        const liqNow = impliedLiq ?? (await liveLatestLiq(lp.mint));
        const synthetic = { priceUsd: entry * markNow, liquidityUsd: liqNow, fdvUsd: 0, pairAddress: "", dexId: "" } as never;
        const dec = decideExit(ecfg, lp, synthetic, entry * peakMark, null, await liveEntryLiq(lp), await liveLpUnlocked(lp.mint));
        if (dec) {
          // DUST-AWARE RUNGS: a partial rung on a micro position produces a sub-$1
          // sell that venues reject (pumpportal build 400 ×4 on the $2-era tape) —
          // the sweep never banks and the position rides unbanked into whatever
          // comes next. Bump the fraction up until the rung clears the minimum
          // sellable notional; the remainder still rides the trail, so runners
          // stay uncapped — this banks the green instead of donating it.
          let frac = dec.fraction;
          if (frac < 0.999) {
            const valueUsd = Number(lp.qtyRemaining) * entry * markNow;
            if (valueUsd > 0 && frac * valueUsd < cfg.LIVE_MIN_SELL_NOTIONAL_USD)
              frac = Math.min(1, cfg.LIVE_MIN_SELL_NOTIONAL_USD / valueUsd);
          }
          console.log(
            `🧬 LIVE ${lp.signature} ${short(lp.mint)} — ${dec.reason} at ${markNow.toFixed(2)}x (peak ${peakMark.toFixed(2)}x), selling ${(frac * 100).toFixed(0)}%${frac !== dec.fraction ? " (dust-bumped)" : ""}`,
          );
          await liveSellPosition(cfg, lp, frac, dec.reason);
          if (frac >= 0.999) {
            guardHits.delete(lp.id);
            livePeakMark.delete(lp.id);
          }
          continue;
        }
      }
      const drawdownPct = cost > 0 ? ((value - cost) / cost) * 100 : 0;
      // Require the real drawdown to PERSIST across 2 guard cycles (~10s) before
      // cutting — a single bad quote can NEVER cut a winner paper is still riding;
      // a genuine collapse trips it and DUMPS at market. Recovery resets the count.
      if (drawdownPct <= -cfg.LIVE_STOP_PCT && !genomeOwned) {
        const hits = (guardHits.get(lp.id) ?? 0) + 1;
        guardHits.set(lp.id, hits);
        if (hits >= 2) {
          const reason = drawdownPct <= -cfg.LIVE_CATASTROPHE_STOP_PCT ? "live_catastrophe_stop" : "live_stop";
          console.log(`🛟 GUARD CUT ${short(lp.mint)} — ${reason} (real ${drawdownPct.toFixed(0)}%, confirmed ${hits}×, dumping @ ${(cfg.LIVE_STOP_SLIPPAGE_BPS / 100).toFixed(0)}%)`);
          await liveSellPosition(cfg, lp, 1, reason, cfg.LIVE_STOP_SLIPPAGE_BPS);
          guardHits.delete(lp.id);
        }
      } else {
        guardHits.delete(lp.id); // recovered — reset
      }
    } catch (err) {
      console.error(`live guard ${short(lp.mint)}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── BASKET HARVEST, over live's OWN book ───────────────────────────────────
  // Paper sweeps its entire green book when the aggregate unrealised gain clears
  // BASKET_HARVEST_USD, and that mechanism has been one of its largest earners.
  // Paper's version mirrors to live by mint, which only worked while live was a
  // shadow of it; an independent live book holds different mints and would simply
  // never harvest, so the lanes would diverge on the single rule that banks the
  // most. Runs AFTER the per-position pass so a harvest can never race an exit
  // that already fired, and only over genome-owned rows.
  if (cfg.BASKET_HARVEST_ENABLED && liveGreens.length > 0) {
    const total = liveGreens.reduce((s, g) => s + g.upl, 0);
    // SCALED BAR (2026-07-31): the absolute $30 made this rule mathematically
    // DEAD on live — six $2.50 tickets is $15 of exposure, which can never show
    // $30 of green. The best-capturing mechanism in the book (97% of peak on
    // paper) had therefore never once fired here. The bar is now a fraction of
    // live's own open cost basis, so it scales with the wallet.
    // ORIGINAL deployed basis, not remaining — see the paper-lane note. Using
    // the remainder made every banked rung lower the bar that governs the
    // runner, so the rule swept hardest exactly where it had already won.
    const liveBasis = rows.reduce((s, lp) => s + n(lp.sizeUsd), 0);
    const bar = Math.max(cfg.BASKET_HARVEST_MIN_USD, liveBasis * cfg.BASKET_HARVEST_FRAC);
    if (total >= bar || total >= cfg.BASKET_HARVEST_USD) {
      await audit("live_basket_harvest", { positions: liveGreens.length, greenUpl: total, bar, liveBasis });
      console.log(
        `💰 LIVE BASKET HARVEST — ${liveGreens.length} green positions net +$${total.toFixed(2)} → banking all`,
      );
      for (const g of liveGreens) {
        await liveSellPosition(cfg, g.lp, 1, "basket_harvest");
        guardHits.delete(g.lp.id);
        livePeakMark.delete(g.lp.id);
      }
    }
  }
}

/**
 * LIVE EQUITY TELEMETRY — snapshot the REAL wallet value (on-chain SOL + marked
 * open positions) into pnl_snapshots(lane='live'). This is the raw material of
 * the investor equity curve: the actual account value over time, not a modeled
 * number. Never throws into the caller.
 */
let lastLiveSnap = 0;
export async function snapshotLiveEquity(cfg: HermesConfig): Promise<void> {
  if (!cfg.LIVE_TRADING_ENABLED || !liveWallet()) return;
  if (Date.now() - lastLiveSnap < 30_000) return; // ≥30s between live snapshots
  lastLiveSnap = Date.now();
  try {
    const bal = await liveBalance(cfg);
    if (!bal) return;
    const open = await db
      .select({ mint: positions.mint, qty: positions.qtyRemaining })
      .from(positions)
      .where(and(eq(positions.lane, "live"), eq(positions.status, "open")));
    let openMark = 0;
    for (const p of open) {
      const px = await fetchJupiterPrice(cfg.JUPITER_PRICE_URL, p.mint).catch(() => null);
      if (px && px > 0) openMark += n(p.qty) * px;
    }
    const equity = bal.usd + openMark;
    await db.insert(pnlSnapshots).values({ lane: "live", equityUsd: String(equity), openPositions: open.length });
  } catch (err) {
    console.error(`live equity snapshot: ${err instanceof Error ? err.message : err}`);
  }
}

// SNIPER REFRESH LOOP: re-chamber stale rounds (>4min) and chamber any open
// live position that lost its round (restart wipes the in-memory chambers —
// this loop re-arms them within 90s of boot). Guarded by the flag; never
// throws into the tick.
let sniperLoopStarted = false;
export function startSniperRefresh(cfg: HermesConfig): void {
  if (sniperLoopStarted) return;
  sniperLoopStarted = true;
  // ── REHYDRATE TACTICAL STATE BEFORE THE FIRST TICK (QTES Phase A #1) ──────
  // A restart used to erase every chamber, latch and poisoned route. Measured
  // cost: 13 fired of 39 chambers across a day with ~8 deploys. Rounds are
  // durable-nonce signed and stay valid indefinitely, so there was never a
  // reason to throw them away — and a latched protective exit that a deploy
  // forgets is a position left un-commanded.
  // Runs regardless of LIVE_PRESIGNED_EXITS: latches, exclusions and peaks are
  // guard-loop state, not sniper state — turning the sniper off must not make
  // commanded protective exits forget across restarts.
  void (async () => {
    try {
      const n = cfg.LIVE_PRESIGNED_EXITS ? await rehydrateChambers() : 0;
      for (const [pid, v] of await rehydrateState<{ reason: string; fraction: number; slippageBps?: number; since: number }>("latch")) {
        exitLatch.set(Number(pid), v);
      }
      for (const [pid, v] of await rehydrateState<string[]>("exclude")) {
        sellExclude.set(Number(pid), v);
      }
      for (const [pid, v] of await rehydrateState<number>("peak")) {
        const p = Number(v);
        if (Number.isFinite(p) && p > 1) livePeakMark.set(Number(pid), p);
      }
      if (n > 0 || exitLatch.size > 0 || sellExclude.size > 0 || livePeakMark.size > 0) {
        await audit("live_state_rehydrated", {
          chambers: n, latches: exitLatch.size, excludes: sellExclude.size, peaks: livePeakMark.size,
          reason: "tactical state restored across restart (GTPED P3 — deterministic decisions)",
        });
        console.log(`♻️  live state rehydrated — ${n} chamber(s), ${exitLatch.size} latch(es), ${sellExclude.size} exclusion(s), ${livePeakMark.size} peak(s)`);
      }
    } catch (err) {
      console.warn(`live state rehydrate failed (in-memory only): ${err instanceof Error ? err.message.slice(0, 60) : err}`);
    }
  })();
  if (!cfg.LIVE_PRESIGNED_EXITS) return; // the 90s re-chamber loop is sniper-only
  setInterval(() => {
    void (async () => {
      try {
        const open = (await db.execute(sql`
          SELECT id, mint FROM positions WHERE lane='live' AND status='open'`)) as unknown as { id: number; mint: string }[];
        for (const p of open) {
          const age = chamberAgeMs(p.id);
          if (age == null || age > 4 * 60_000) await chamberExit(cfg, p.id, p.mint);
        }
      } catch (err) {
        console.warn(`sniper refresh tick failed: ${err instanceof Error ? err.message.slice(0, 60) : err}`);
      }
    })();
  }, 90_000);
  console.log("🎯 sniper refresh loop armed (90s cadence, re-chambers stale/lost rounds)");
}

/** One-line status for the boot banner. */
export function liveLaneStatus(cfg: HermesConfig): string {
  if (!cfg.LIVE_TRADING_ENABLED) return "live lane: DISABLED (LIVE_TRADING_ENABLED=false)";
  const w = liveWallet();
  if (!w) return "live lane: enabled but NO WALLET KEY — dormant";
  // The venue selection still applies; the MIRROR wording does not. Live fires on
  // the same armed candidate as paper, independently — it is not shadowing a
  // paper fill any more, and a banner that says otherwise misleads whoever reads
  // the log at 3am (including the author of this line).
  const selection = cfg.LIVE_MIRROR_PAPER
    ? `, venues [${cfg.LIVE_MIRROR_VENUES}] (∪ smart-money rescue ≥${cfg.LIVE_WALLET_RESCUE_MIN_WINNERS} winner-wallets); honeypot trap-only`
    : `${cfg.LIVE_PREMIUM_ONLY ? `, PREMIUM venues (∪ smart-money rescue ≥${cfg.LIVE_WALLET_RESCUE_MIN_WINNERS} winner-wallets)` : ""}`;
  return `live lane: ARMED — wallet ${w.publicKey.toBase58()}, 🧬 SIGNATURE ROUTED (independent of paper, same signals): size ${(cfg.LIVE_MIN_POSITION_FRAC * 100).toFixed(1)}–${(cfg.POSITION_FRAC_MAX * 100).toFixed(1)}% of balance (paper's realised fraction, floored at ${(cfg.LIVE_MIN_POSITION_FRAC * 100).toFixed(1)}% so fees don't eat the trade), exits owned by the class genome (cover/trail/ladder/clock), min $${cfg.LIVE_MIN_POSITION_USD.toFixed(2)}/position; caps ≤${(cfg.LIVE_MAX_POSITION_FRAC * 100).toFixed(0)}%/pos, exposure ≤${(cfg.LIVE_MAX_EXPOSURE_FRAC * 100).toFixed(0)}%, daily −$${cfg.LIVE_DAILY_LOSS_CAP_USD}, kill −$${cfg.LIVE_KILL_LOSS_USD}${selection}${cfg.LIVE_WALLET_GATE ? " + wallet-graph rug gate" : ""}${cfg.LIVE_REGIME_GATE ? ` + regime gate (${cfg.LIVE_MIRROR_PAPER ? `venue edge ≤−${(cfg.LIVE_MIRROR_REGIME_MAX_LOSS_PCT * 100).toFixed(0)}%` : `paper ≤−$${cfg.LIVE_REGIME_MAX_LOSS_USD}`}/${cfg.LIVE_REGIME_WINDOW_MIN}m stands down)` : ""}${cfg.LIVE_GUARD_ENABLED ? ` + legacy guard (unrouted rows only: cut at −${cfg.LIVE_STOP_PCT}% / dump @ ${(cfg.LIVE_STOP_SLIPPAGE_BPS / 100).toFixed(0)}%)` : ""}${cfg.LIVE_ANTICIPATION_ENABLED ? ` + anticipation tilt (venue-momentum × tail-odds, ${cfg.LIVE_ANTICIPATION_MIN}–${cfg.LIVE_ANTICIPATION_MAX}×)` : ""}${cfg.LIVE_ANTICIPATION_GATE ? ` + anticipation GATE (stand down when cold, <${cfg.LIVE_ANTICIPATION_GATE_MIN}×)` : ""}`;
}
