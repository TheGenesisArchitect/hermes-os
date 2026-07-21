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
  profileOf,
  signatureExitOverrides,
  sizeFraction,
  type HermesConfig,
  type Signature,
} from "@hermes/core";
import { auditLog, candidateOutcomes, db, fills, pnlSnapshots, positions, safetyChecks, tokens } from "@hermes/db";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { rpcPool } from "./rpc/pool.js";
import { JupiterHostedProvider, WSOL_MINT } from "./swap/jupiterHosted.js";
import { PumpSwapProvider } from "./swap/pumpswap.js";
import { swapRouter } from "./swap/router.js";
import { liveWallet } from "./wallet.js";

// Exit pre-check probes — dedicated verifying providers (NOT the full router,
// whose build-only PumpPortal would optimistically "pass" an unsellable token).
const exitJup = new JupiterHostedProvider();
const exitPs = new PumpSwapProvider();

/**
 * Is there a REAL sell route for this token right now? Prevents entering a token
 * we can't exit (KIMI). Ordered fast→slow: pump.fun-origin is inherently sellable
 * (symmetric curve/graduated pool) and needs no network probe; the graduated
 * NON-pump class — the actual strand risk — is verified via the PumpSwap pool,
 * then Jupiter as the universal liquidity oracle. Only skips when NOTHING can sell it.
 */
async function canExitLive(cfg: HermesConfig, mint: string, tokenAmt: bigint): Promise<boolean> {
  if (mint.endsWith("pump")) return true; // pump.fun-origin — always sellable, no probe
  try {
    await exitPs.quote(cfg, mint, WSOL_MINT, tokenAmt, cfg.LIVE_SELL_SLIPPAGE_BPS);
    return true; // a live PumpSwap pool exists
  } catch {
    /* no pumpswap pool — try the aggregator */
  }
  try {
    const j = await exitJup.quote(cfg, mint, WSOL_MINT, tokenAmt, cfg.LIVE_SELL_SLIPPAGE_BPS);
    if (Number(j.outAmount) > 0) return true; // Jupiter routes a sell somewhere
  } catch {
    /* Jupiter no-route or unreachable */
  }
  return false;
}

const n = (v: string | number | null | undefined): number => Number(v ?? 0);
const short = (m: string) => `${m.slice(0, 4)}…${m.slice(-4)}`;

async function audit(action: string, details: Record<string, unknown>): Promise<void> {
  await db.insert(auditLog).values({ actor: "trader-live", action, details });
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

async function liveKillEngaged(): Promise<boolean> {
  const rows = (await db.execute(sql`select value from config where key = 'live_kill'`)) as unknown as {
    value: { enabled?: boolean };
  }[];
  return rows[0]?.value?.enabled === true;
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
async function liveBuyGate(cfg: HermesConfig, mint: string): Promise<LiveGate> {
  if (!cfg.LIVE_TRADING_ENABLED) return { ok: false, reason: "disabled" };
  if (!liveWallet()) return { ok: false, reason: "no wallet key" };
  if (await liveKillEngaged()) return { ok: false, reason: "live_kill engaged" };

  // Kill criterion (gate doc): cumulative realized ≤ −$KILL → engage permanently.
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
    .where(eq(positions.lane, "live"))) as { pnl: number; closes: number }[];
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
  if (cfg.LIVE_REGIME_GATE) {
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
    const scoped =
      mirrorVenues.length > 0
        ? base
            .innerJoin(tokens, eq(tokens.mint, positions.mint))
            .where(
              and(
                eq(positions.lane, "paper"),
                eq(positions.status, "closed"),
                gte(positions.closedAt, sql`now() - make_interval(mins => ${cfg.LIVE_REGIME_WINDOW_MIN})`),
                inArray(tokens.dex, mirrorVenues),
              ),
            )
        : base.where(
            and(
              eq(positions.lane, "paper"),
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
  } else if (cfg.LIVE_PREMIUM_ONLY && !smartMoneyRescue) {
    const premium = await livePremiumSet(cfg);
    if (!venue || !premium.has(venue)) return { ok: false, reason: `venue not premium (${venue ?? "unknown"})` };
  }

  // WALLET-GRAPH GATE: keep real capital out of a serial-rugger holder set that
  // has NO smart-money offset. VALIDATED — rug-rep holders suppress winners
  // (7.7% vs 12.4% base). Missing score = no data → we do not block on absence.
  if (cfg.LIVE_WALLET_GATE && rugHits > 0 && winnerHits === 0) {
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
}

/** Sign, simulate, send, confirm, and read the real fill from the tx meta. */
async function executeSwap(
  cfg: HermesConfig,
  base64Tx: string,
  outputMint: string,
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
  const sim = await rpc.read((c) =>
    tx instanceof VersionedTransaction ? c.simulateTransaction(tx, { commitment: "confirmed" }) : c.simulateTransaction(tx),
  );
  if (sim.value.err) throw new Error(`simulation failed: ${JSON.stringify(sim.value.err)}`);

  const signature = await rpc.send(tx, { skipPreflight: true, maxRetries: 3 });

  // Confirm by polling signature status (bounded ~45s).
  const deadline = Date.now() + 45_000;
  let confirmed = false;
  while (Date.now() < deadline) {
    const st = (await rpc.read((c) => c.getSignatureStatuses([signature]))).value[0];
    if (st?.err) throw new Error(`tx failed on-chain: ${JSON.stringify(st.err)} (${signature})`);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
      confirmed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  if (!confirmed) throw new Error(`tx unconfirmed after 45s: ${signature}`);

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
  return { signature, outUi: Math.max(0, outUi), feeSol: n(info?.meta?.fee) / 1e9 };
}

async function solPriceUsd(cfg: HermesConfig): Promise<number | null> {
  return fetchJupiterPrice(cfg.JUPITER_PRICE_URL, WSOL_MINT).catch(() => null);
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
function livePositionUsd(
  cfg: HermesConfig,
  balanceUsd: number,
  regimeMult: number,
  convictionMult: number,
  anticipationMult: number,
  sig?: { signature: Signature; stars: number | null } | null,
): number {
  // SIGNATURE SIZING — identical formula to paper, against the WALLET BALANCE
  // instead of the bankroll: the policy sets the range by regime, the quality
  // score picks the point inside it, and the class multiplier scales it. Both
  // lanes therefore share one risk model and stay on it as the account moves;
  // a flat LIVE_SIZE_FRAC would give a 2-star MOON_FAST and a 0-star residual
  // the same size, which is exactly the divergence we just removed from paper.
  const base = sig
    ? balanceUsd *
      sizeFraction(sig.stars ?? 0, cfg.POSITION_FRAC_MIN, cfg.POSITION_FRAC_MAX) *
      profileOf(sig.signature).size *
      regimeMult *
      anticipationMult
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
  sig: { signature: Signature; stars: number | null } | null = null,
): Promise<void> {
  try {
    // LATENCY: live trailed paper's entry by a measured 6–8s, and that lag
    // propagates straight to the exit (THUNDERCAT: paper out at 1.018×, live 7s
    // later at $0.00). The SOL price and balance reads are independent of the
    // gate, so warm them CONCURRENTLY with it instead of serially afterwards —
    // the gate's own sell-route probe is a network round trip we no longer wait
    // to finish before the other two have even started.
    const solP = solPriceUsd(cfg).catch(() => null);
    const balP = liveBalance(cfg).catch(() => null);
    const gate = await liveBuyGate(cfg, mint);
    if (!gate.ok) {
      if (cfg.LIVE_TRADING_ENABLED && gate.reason !== "disabled")
        await audit("live_buy_skipped", { mint, reason: gate.reason });
      return;
    }
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
        else if (lg <= cfg.LIQ_FLAT_MAX && tm !== null && tm >= 1.2) inflowMult = cfg.LIQ_FLAT_SIZE_MULT;
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
    if (cfg.LIVE_ANTICIPATION_GATE && antiMult < cfg.LIVE_ANTICIPATION_GATE_MIN) {
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
    const sized = Math.min(livePositionUsd(cfg, bal.usd, regime, convictionMult, antiMult, sig) * dailyThrottle, affordable);
    // A routed position is never inflated to the fee floor — if its own conviction
    // does not justify a fee-viable size, we SKIP rather than take a trade at a
    // size the signature never asked for. Legacy (unrouted) live buys keep the
    // old floor-up behaviour.
    if (sig && sized < cfg.LIVE_MIN_POSITION_USD) {
      await audit("live_buy_skipped", {
        mint,
        reason: `${sig.signature} ${sig.stars ?? 0}★ sizes to $${sized.toFixed(2)}, under the $${cfg.LIVE_MIN_POSITION_USD} fee floor — balance too small to express this conviction`,
      });
      return;
    }
    const usd = sig ? sized : Math.max(cfg.LIVE_MIN_POSITION_USD, sized);
    const lamports = BigInt(Math.floor((usd / sol) * 1e9));

    const wallet = liveWallet();
    if (!wallet) return;
    const quote = await swapRouter.quote(cfg, WSOL_MINT, mint, lamports, cfg.LIVE_SLIPPAGE_BPS);
    const impact = Math.abs(Number(quote.priceImpactPct ?? 0)) * 100;
    if (impact > cfg.ENTRY_MAX_SLIPPAGE_PCT) {
      await audit("live_buy_skipped", { mint, reason: `price impact ${impact.toFixed(1)}%` });
      return;
    }
    // EXIT PRE-CHECK — never enter what we can't currently sell (KIMI guard). The
    // expected buy output is the sell probe amount (nominal fallback when the buy
    // provider doesn't quote an out amount, e.g. PumpSwap/PumpPortal build-only).
    if (cfg.LIVE_EXIT_PRECHECK) {
      const probeAmt = Number(quote.outAmount) > 1 ? BigInt(quote.outAmount) : 1_000_000_000n;
      if (!(await canExitLive(cfg, mint, probeAmt))) {
        await audit("live_buy_skipped", { mint, reason: "no exit route — would strand" });
        return;
      }
    }
    const b64 = await swapRouter.buildSwapTx(cfg, quote, wallet.publicKey.toBase58());
    const res = await executeSwap(cfg, b64, mint);
    if (res.outUi <= 0) throw new Error("fill parse: zero output");

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
        sizeUsd: String(usd),
        qtyTokens: String(res.outUi),
        qtyRemaining: String(res.outUi),
        entryPriceUsd: String(entryPrice),
        peakPriceUsd: String(entryPrice),
        realizedPnlUsd: "0",
      })
      .returning();
    if (position)
      await db.insert(fills).values({
        positionId: position.id,
        side: "buy",
        qtyTokens: String(res.outUi),
        priceUsd: String(entryPrice),
        feeUsd: String(res.feeSol * sol),
        txSignature: res.signature,
        reason: "live_confirmed",
      });
    await audit("live_open", { mint, usd, regime, convictionMult, anticipationMult: antiMult, qty: res.outUi, signature: res.signature, feeSol: res.feeSol });
    console.log(`💰 LIVE OPEN ${symbol ?? "?"} ${short(mint)} $${usd.toFixed(2)} (conv ×${convictionMult.toFixed(2)}, anti ×${antiMult.toFixed(2)}, ${res.outUi} tokens, tx ${res.signature.slice(0, 8)}…)`);
  } catch (err) {
    await audit("live_buy_failed", { mint, error: err instanceof Error ? err.message : String(err) }).catch(() => {});
    console.error(`live buy failed ${short(mint)}: ${err instanceof Error ? err.message : err}`);
  }
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
const sellBackoff = new Map<number, { fails: number; nextAttemptMs: number }>();
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
  // Classify the exit's URGENCY up front — the catch needs it too, to tell a
  // take-profit that refused a bad price from a position that genuinely can't sell.
  // Protective exits (stop / catastrophe / rug / sweep / mirror-cut) DUMP at the wide
  // stop slippage so they fill at the crashed price instead of reverting into a −100%
  // sweep. Take-profits bank into strength and get the tight tolerance. Trails sit
  // between: they fire while price pulls away, so landing beats price.
  const isProtective = /stop|catastrophe|rug|sweep|mirror_cut|unsellable/i.test(reason);
  const isTakeProfit = !isProtective && /take_profit/i.test(reason);
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
      await db
        .update(positions)
        .set({ status: "closed", closedAt: new Date(), exitReason: "live_desync_empty", qtyRemaining: "0" })
        .where(eq(positions.id, position.id));
      await audit("live_desync_empty", { positionId: position.id, mint: position.mint });
      return true;
    }
    const f = Math.min(1, Math.max(0, fraction));
    const rawSell = f >= 0.999 ? raw : (raw * BigInt(Math.floor(f * 10_000))) / 10_000n;
    if (rawSell <= 0n) return false;

    // Explicit slippageBps (the guard) always wins over the classification above.
    const slip =
      slippageBps ??
      (isProtective
        ? cfg.LIVE_STOP_SLIPPAGE_BPS
        : isTakeProfit
          ? cfg.LIVE_TP_SLIPPAGE_BPS
          : cfg.LIVE_SELL_SLIPPAGE_BPS);
    const quote = await swapRouter.quote(cfg, position.mint, WSOL_MINT, rawSell, slip);
    const b64 = await swapRouter.buildSwapTx(cfg, quote, wallet.publicKey.toBase58());
    const res = await executeSwap(cfg, b64, WSOL_MINT);
    const sol = (await solPriceUsd(cfg)) ?? 0;
    const proceedsUsd = res.outUi * sol;
    const qtyUiSold = Number(rawSell) / 10 ** decimals;
    const totalQty = n(position.qtyTokens);
    const costBasis = totalQty > 0 ? n(position.sizeUsd) * (qtyUiSold / totalQty) : 0;
    const feeUsd = res.feeSol * sol;
    const pnl = proceedsUsd - costBasis - feeUsd;
    const closing = rawSell === raw;
    const remainingUi = Number(raw - rawSell) / 10 ** decimals;

    await db.insert(fills).values({
      positionId: position.id,
      side: "sell",
      qtyTokens: String(qtyUiSold),
      priceUsd: String(qtyUiSold > 0 ? proceedsUsd / qtyUiSold : 0),
      feeUsd: String(feeUsd),
      txSignature: res.signature,
      reason,
    });
    await db
      .update(positions)
      .set({
        qtyRemaining: String(Math.max(0, remainingUi)),
        realizedPnlUsd: String(n(position.realizedPnlUsd) + pnl),
        // Persist the realized exit price (proceeds per token) so the paired ledger
        // reads exit apples-to-apples without reconstructing from fills.
        ...(closing
          ? { status: "closed", closedAt: new Date(), exitReason: reason, exitPriceUsd: String(qtyUiSold > 0 ? proceedsUsd / qtyUiSold : 0) }
          : {}),
      })
      .where(eq(positions.id, position.id));
    await audit("live_sell", {
      positionId: position.id,
      mint: position.mint,
      fraction: f,
      proceedsUsd,
      pnl,
      reason,
      signature: res.signature,
    });
    console.log(
      `💸 LIVE SELL ${short(position.mint)} ${(f * 100).toFixed(0)}% → $${proceedsUsd.toFixed(2)} (pnl ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}, ${reason})`,
    );
    sellBackoff.delete(position.id); // it sold — clear any accumulated penalty
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A take-profit that reverts on tolerance is the tolerance DOING ITS JOB — the
    // rung refused a bad price on a position that is winning. It must never feed
    // the strand-writeoff counter: LIVE_SELL_MAX_FAILS would otherwise book a live
    // WINNER as "unsellable" and realize a total loss after six tight-slippage
    // reverts. Retry on the flat fuse and leave the failure count untouched; if the
    // token really is unsellable, the trail and guard exits reach this catch with a
    // protective reason and the write-off fires from there.
    if (isTakeProfit) {
      const keep = sellBackoff.get(position.id)?.fails ?? 0;
      sellBackoff.set(position.id, { fails: keep, nextAttemptMs: Date.now() + TP_RETRY_MS });
      console.warn(`live TP held out ${short(position.mint)} (${reason}) — refused a fill worse than ${(cfg.LIVE_TP_SLIPPAGE_BPS / 100).toFixed(1)}%, retry ${TP_RETRY_MS / 1000}s: ${msg}`);
      return false;
    }
    // Back off before anything else — a failing sell must not be free to retry.
    const prev = sellBackoff.get(position.id)?.fails ?? 0;
    const fails = prev + 1;
    const waitMs = Math.min(SELL_BACKOFF_MAX_MS, SELL_BACKOFF_BASE_MS * 2 ** (fails - 1));
    sellBackoff.set(position.id, { fails, nextAttemptMs: Date.now() + waitMs });
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
// Highest REAL sell-quote value / cost seen per live position — the live lane's
// own peak, used to arm the profit floor without waiting on the paper mirror.
const livePeakMark = new Map<number, number>();
async function guardLiveBookInner(cfg: HermesConfig): Promise<void> {
  const wallet = liveWallet();
  if (!wallet) return;
  const rows = await db
    .select()
    .from(positions)
    .where(and(eq(positions.lane, "live"), eq(positions.status, "open")));
  if (rows.length === 0) return;
  const sol = (await solPriceUsd(cfg)) ?? 0;
  if (sol <= 0) return; // no SOL price → can't value; skip rather than risk a false read
  const { PublicKey } = await import("@solana/web3.js");
  // Greens collected across the pass for the basket harvest below.
  const liveGreens: { lp: (typeof rows)[number]; upl: number }[] = [];
  for (const lp of rows) {
    try {
      const resp = await rpcPool(cfg).read((c) =>
        c.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(lp.mint) }),
      );
      let raw = 0n;
      for (const { account } of resp.value) {
        const amt = (account.data as { parsed?: { info?: { tokenAmount?: { amount: string } } } }).parsed?.info?.tokenAmount;
        if (amt) raw += BigInt(amt.amount);
      }
      let decimals = 0;
      for (const { account } of resp.value) {
        const d = (account.data as { parsed?: { info?: { tokenAmount?: { decimals?: number } } } }).parsed?.info?.tokenAmount?.decimals;
        if (typeof d === "number") decimals = d;
      }
      if (raw <= 0n) {
        await liveSellPosition(cfg, lp, 1, "live_guard_empty"); // closes the ledger honestly
        continue;
      }
      void decimals;
      // Value by a REAL SELL QUOTE — what we'd ACTUALLY get selling right now — not
      // the price-API mark. The mark can glitch stale/low and fire a FALSE stop on a
      // healthy position (SIGNAL: the mark read −28% but the real sell was breakeven,
      // and paper rode it to 1.43×). No quote (no route) → can't value → leave it for
      // the sweep; never false-cut on missing/bad data.
      let value: number | null = null;
      try {
        const j = await exitJup.quote(cfg, lp.mint, WSOL_MINT, raw, cfg.LIVE_STOP_SLIPPAGE_BPS);
        const outSol = Number(j.outAmount) / 1e9;
        if (outSol > 0) value = outSol * sol;
      } catch {
        /* no live sell route — the sweep/mirror handles it, don't false-cut here */
      }
      if (value == null) {
        guardHits.delete(lp.id);
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
      if (genomeOwned && cost > 0 && value > cost) liveGreens.push({ lp, upl: value - cost });
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
      const peakMark = Math.max(livePeakMark.get(lp.id) ?? 1, markNow);
      livePeakMark.set(lp.id, peakMark);
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
      if (lp.signature) {
        const { decideExit } = await import("../paper.js");
        const entry = Number(lp.entryPriceUsd) || 0;
        const ecfg = { ...cfg, ...signatureExitOverrides(lp.signature as Signature) };
        const synthetic = { priceUsd: entry * markNow, liquidityUsd: 0, fdvUsd: 0, pairAddress: "", dexId: "" } as never;
        const dec = decideExit(ecfg, lp, synthetic, entry * peakMark, null);
        if (dec) {
          console.log(
            `🧬 LIVE ${lp.signature} ${short(lp.mint)} — ${dec.reason} at ${markNow.toFixed(2)}x (peak ${peakMark.toFixed(2)}x), selling ${(dec.fraction * 100).toFixed(0)}%`,
          );
          await liveSellPosition(cfg, lp, dec.fraction, dec.reason);
          if (dec.fraction >= 0.999) {
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
    if (total >= cfg.BASKET_HARVEST_USD) {
      await audit("live_basket_harvest", { positions: liveGreens.length, greenUpl: total });
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
  return `live lane: ARMED — wallet ${w.publicKey.toBase58()}, 🧬 SIGNATURE ROUTED (independent of paper, same signals): size ${(cfg.POSITION_FRAC_MIN * 100).toFixed(1)}–${(cfg.POSITION_FRAC_MAX * 100).toFixed(1)}% of balance by conviction ★, exits owned by the class genome (cover/trail/ladder/clock), skips under the $${cfg.LIVE_MIN_POSITION_USD} fee floor rather than inflating; caps ≤${(cfg.LIVE_MAX_POSITION_FRAC * 100).toFixed(0)}%/pos, exposure ≤${(cfg.LIVE_MAX_EXPOSURE_FRAC * 100).toFixed(0)}%, daily −$${cfg.LIVE_DAILY_LOSS_CAP_USD}, kill −$${cfg.LIVE_KILL_LOSS_USD}${selection}${cfg.LIVE_WALLET_GATE ? " + wallet-graph rug gate" : ""}${cfg.LIVE_REGIME_GATE ? ` + regime gate (${cfg.LIVE_MIRROR_PAPER ? `venue edge ≤−${(cfg.LIVE_MIRROR_REGIME_MAX_LOSS_PCT * 100).toFixed(0)}%` : `paper ≤−$${cfg.LIVE_REGIME_MAX_LOSS_USD}`}/${cfg.LIVE_REGIME_WINDOW_MIN}m stands down)` : ""}${cfg.LIVE_GUARD_ENABLED ? ` + legacy guard (unrouted rows only: cut at −${cfg.LIVE_STOP_PCT}% / dump @ ${(cfg.LIVE_STOP_SLIPPAGE_BPS / 100).toFixed(0)}%)` : ""}${cfg.LIVE_ANTICIPATION_ENABLED ? ` + anticipation tilt (venue-momentum × tail-odds, ${cfg.LIVE_ANTICIPATION_MIN}–${cfg.LIVE_ANTICIPATION_MAX}×)` : ""}${cfg.LIVE_ANTICIPATION_GATE ? ` + anticipation GATE (stand down when cold, <${cfg.LIVE_ANTICIPATION_GATE_MIN}×)` : ""}`;
}
