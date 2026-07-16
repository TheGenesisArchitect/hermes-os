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
import {
  Connection,
  VersionedTransaction,
} from "@solana/web3.js";
import { fetchJupiterPrice, type HermesConfig } from "@hermes/core";
import { auditLog, db, fills, positions, safetyChecks } from "@hermes/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { jupQuote, jupSwapTx, WSOL_MINT } from "./jupiter.js";
import { liveWallet } from "./wallet.js";

const n = (v: string | number | null | undefined): number => Number(v ?? 0);
const short = (m: string) => `${m.slice(0, 4)}…${m.slice(-4)}`;

async function audit(action: string, details: Record<string, unknown>): Promise<void> {
  await db.insert(auditLog).values({ actor: "trader-live", action, details });
}

let conn: Connection | null = null;
function connection(cfg: HermesConfig): Connection {
  if (!conn) conn = new Connection(cfg.rpcUrl, "confirmed");
  return conn;
}

// ── gates ────────────────────────────────────────────────────────────────────

interface LiveGate {
  ok: boolean;
  reason?: string;
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

  // Kill criterion (gate doc): cumulative realized ≤ −$50, or ≥20 closes with
  // negative cumulative P&L → engage the kill switch permanently.
  const [cum] = (await db
    .select({
      pnl: sql<number>`coalesce(sum(${positions.realizedPnlUsd}::float), 0)`,
      closes: sql<number>`count(*) filter (where ${positions.status} = 'closed')`,
    })
    .from(positions)
    .where(eq(positions.lane, "live"))) as { pnl: number; closes: number }[];
  const cumPnl = n(cum?.pnl);
  const closes = n(cum?.closes);
  if (cumPnl <= -50 || (closes >= 20 && cumPnl < 0)) {
    await engageLiveKill(cumPnl <= -50 ? "cumulative realized ≤ −$50" : "20 closes with negative cumulative P&L", {
      cumPnl,
      closes,
    });
    return { ok: false, reason: "kill criterion met" };
  }

  // Daily loss cap: realized today ≤ −cap → stand down until tomorrow (UTC).
  const [today] = (await db
    .select({ pnl: sql<number>`coalesce(sum(${positions.realizedPnlUsd}::float), 0)` })
    .from(positions)
    .where(and(eq(positions.lane, "live"), gte(positions.closedAt, sql`date_trunc('day', now())`)))) as {
    pnl: number;
  }[];
  if (n(today?.pnl) <= -cfg.LIVE_DAILY_LOSS_CAP_USD)
    return { ok: false, reason: `daily loss cap (${n(today?.pnl).toFixed(2)})` };

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

  // HARD RULE: affirmative honeypot verification. Inconclusive (no Jupiter
  // route / probe unreachable) is a paper-only soft flag — with real capital
  // an unverifiable sell route is a block. We require the latest honeypot
  // safety check for this mint to be a real PASS.
  if (cfg.LIVE_REQUIRE_HONEYPOT_VERIFIED) {
    const [hp] = await db
      .select({ passed: safetyChecks.passed, evidence: safetyChecks.evidence })
      .from(safetyChecks)
      .where(and(eq(safetyChecks.mint, mint), eq(safetyChecks.checkName, "honeypot")))
      .orderBy(desc(safetyChecks.id))
      .limit(1);
    const inconclusive =
      hp?.evidence && typeof hp.evidence === "object" && (hp.evidence as Record<string, unknown>).inconclusive === true;
    if (!hp?.passed || inconclusive) return { ok: false, reason: "honeypot not affirmatively verified" };
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
  const c = connection(cfg);
  const tx = VersionedTransaction.deserialize(Buffer.from(base64Tx, "base64"));
  tx.sign([wallet]);

  // Simulate first — a sim failure costs nothing; a sent failure costs fees.
  const sim = await c.simulateTransaction(tx, { commitment: "confirmed" });
  if (sim.value.err) throw new Error(`simulation failed: ${JSON.stringify(sim.value.err)}`);

  const signature = await c.sendTransaction(tx, { skipPreflight: true, maxRetries: 3 });

  // Confirm by polling signature status (bounded ~45s).
  const deadline = Date.now() + 45_000;
  let confirmed = false;
  while (Date.now() < deadline) {
    const st = (await c.getSignatureStatuses([signature])).value[0];
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
  const info = await c.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
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
      const keys = info.transaction.message.staticAccountKeys.map((k) => k.toBase58());
      const idx = keys.indexOf(owner);
      if (idx >= 0)
        outUi = (n(info.meta.postBalances[idx]) - n(info.meta.preBalances[idx]) + n(info.meta.fee)) / 1e9;
    }
  }
  return { signature, outUi, feeSol: n(info?.meta?.fee) / 1e9 };
}

async function solPriceUsd(cfg: HermesConfig): Promise<number | null> {
  return fetchJupiterPrice(cfg.JUPITER_PRICE_URL, WSOL_MINT).catch(() => null);
}

// ── public API (mirror hooks) ────────────────────────────────────────────────

/**
 * Mirror a confirmed PAPER entry into the live lane, if every gate passes.
 * Called after a successful paper open; never throws into the caller.
 */
export async function maybeLiveBuy(cfg: HermesConfig, mint: string, symbol: string | null): Promise<void> {
  try {
    const gate = await liveBuyGate(cfg, mint);
    if (!gate.ok) {
      if (cfg.LIVE_TRADING_ENABLED && gate.reason !== "disabled")
        await audit("live_buy_skipped", { mint, reason: gate.reason });
      return;
    }
    const sol = await solPriceUsd(cfg);
    if (!sol || sol <= 0) {
      await audit("live_buy_skipped", { mint, reason: "no SOL price" });
      return;
    }
    const usd = cfg.LIVE_MAX_POSITION_USD; // the ceiling IS the size — pocket-change lane, no scaling games
    const lamports = BigInt(Math.floor((usd / sol) * 1e9));

    const wallet = liveWallet();
    if (!wallet) return;
    const quote = await jupQuote(cfg, WSOL_MINT, mint, lamports, cfg.LIVE_SLIPPAGE_BPS);
    const impact = Math.abs(Number(quote.priceImpactPct ?? 0)) * 100;
    if (impact > cfg.ENTRY_MAX_SLIPPAGE_PCT) {
      await audit("live_buy_skipped", { mint, reason: `price impact ${impact.toFixed(1)}%` });
      return;
    }
    const b64 = await jupSwapTx(cfg, quote, wallet.publicKey.toBase58());
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
    await audit("live_open", { mint, usd, qty: res.outUi, signature: res.signature, feeSol: res.feeSol });
    console.log(`💰 LIVE OPEN ${symbol ?? "?"} ${short(mint)} $${usd} (${res.outUi} tokens, tx ${res.signature.slice(0, 8)}…)`);
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
async function liveSellPosition(
  cfg: HermesConfig,
  position: typeof positions.$inferSelect,
  fraction: number,
  reason: string,
): Promise<boolean> {
  const wallet = liveWallet();
  if (!wallet) return false;
  try {
    const c = connection(cfg);
    const { PublicKey } = await import("@solana/web3.js");
    const resp = await c.getParsedTokenAccountsByOwner(wallet.publicKey, {
      mint: new PublicKey(position.mint),
    });
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

    const quote = await jupQuote(cfg, position.mint, WSOL_MINT, rawSell, cfg.LIVE_SLIPPAGE_BPS);
    const b64 = await jupSwapTx(cfg, quote, wallet.publicKey.toBase58());
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
        ...(closing ? { status: "closed", closedAt: new Date(), exitReason: reason } : {}),
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
    return true;
  } catch (err) {
    await audit("live_sell_failed", {
      positionId: position.id,
      mint: position.mint,
      reason,
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => {});
    console.error(`live sell failed ${short(position.mint)}: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

/**
 * Mirror a paper exit onto the live twin (same mint, open, lane='live').
 * Failures are contained — sweepLiveBook() closes any stragglers.
 */
export async function mirrorLiveSell(cfg: HermesConfig, mint: string, fraction: number, reason: string): Promise<void> {
  if (!cfg.LIVE_TRADING_ENABLED || !liveWallet()) return;
  const [pos] = await db
    .select()
    .from(positions)
    .where(and(eq(positions.lane, "live"), eq(positions.mint, mint), eq(positions.status, "open")))
    .limit(1);
  if (!pos) return;
  await liveSellPosition(cfg, pos, fraction, reason);
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
    const [twin] = await db
      .select({ id: positions.id })
      .from(positions)
      .where(and(eq(positions.lane, "paper"), eq(positions.mint, lp.mint), eq(positions.status, "open")))
      .limit(1);
    if (!twin) await liveSellPosition(cfg, lp, 1, "live_sweep_close");
  }
}

/** One-line status for the boot banner. */
export function liveLaneStatus(cfg: HermesConfig): string {
  if (!cfg.LIVE_TRADING_ENABLED) return "live lane: DISABLED (LIVE_TRADING_ENABLED=false)";
  const w = liveWallet();
  if (!w) return "live lane: enabled but NO WALLET KEY — dormant";
  return `live lane: ARMED — wallet ${w.publicKey.toBase58()}, caps $${cfg.LIVE_MAX_POSITION_USD}/pos ×${cfg.LIVE_MAX_CONCURRENT}, daily −$${cfg.LIVE_DAILY_LOSS_CAP_USD}`;
}
