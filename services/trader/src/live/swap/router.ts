/**
 * SWAP ROUTER — ordered failover across swap providers with a per-provider
 * circuit breaker. `quote()` walks providers in priority order and returns the
 * first healthy provider's quote (tagged with its name); `buildSwapTx()` routes
 * back to that same provider. A provider that fails trips its breaker and is
 * skipped for a cooldown, then re-probed. The ONLY failure that propagates is
 * "every provider is down" — the true-outage case that should alarm + halt
 * entries. This is what makes a single vendor outage a non-event.
 *
 * Foundation state: one provider (Jupiter hosted). Self-hosted Jupiter and
 * direct-DEX providers slot in by appending to the priority list — no caller
 * change. Scaling: one router instance serves every wallet.
 */
import type { HermesConfig } from "@hermes/core";
import { NoRouteError, type QuoteOpts, type SwapProvider, type SwapQuote } from "./provider.js";
import { JupiterHostedProvider } from "./jupiterHosted.js";
import { JupiterSelfHostedProvider } from "./jupiterSelfHosted.js";
import { FluxbeamProvider } from "./fluxbeam.js";
import { PumpSwapProvider } from "./pumpswap.js";
import { PumpPortalProvider } from "./pumpportal.js";
import { MeteoraDbcProvider, MeteoraDammV2Provider } from "./meteora.js";
import { PumpFunCurveProvider } from "./pumpfunCurve.js";

const BREAKER_TRIP_AFTER = 3; // consecutive failures → open
const BREAKER_COOLDOWN_MS = 30_000; // skip an open provider this long, then re-probe
const WSOL = "So11111111111111111111111111111111111111112";

interface Breaker {
  fails: number;
  openUntil: number;
}

/** QTEA-007: breakers are scoped provider × side. Three buy-path failures must
 * never suppress a provider during a sell — the two paths hit different program
 * routes and fail for different reasons, and a sell-side outage is the one that
 * costs principal. Side is derived from the mints: selling = output is WSOL. */
type BreakerSide = "buy" | "sell";
const sideOf = (inputMint: string, outputMint: string): BreakerSide => (outputMint === WSOL ? "sell" : "buy");

export class SwapRouter {
  private readonly providers: SwapProvider[];
  private readonly breakers = new Map<string, Breaker>();
  private lastProvider: string | null = null;

  constructor(providers?: SwapProvider[]) {
    // Priority order: Jupiter hosted (fastest, best liquidity when up) →
    // self-hosted Jupiter (our uptime, dormant until URL set) → Fluxbeam
    // (independent, fluxbeam-venue tokens) → PumpPortal (independent, pump.fun /
    // pumpswap tokens — the dominant flow; last-resort, build-only).
    this.providers = providers ?? [
      // PumpSwap DIRECT is FIRST: for graduated pumpswap-pool tokens the SDK builds
      // a correct swap where JUPITER FAILS — Jupiter's PumpSwap route references the
      // coin-creator fee-vault ATA (and Token-2022 quote-mint accounts) without
      // creating them → on-chain "MissingAccount", confirmed on Meowshi/DOGGO
      // (both Token-2022). PumpSwap.quote throws instantly when there is no pumpswap
      // pool (bonding %pump, raydium, orca…), so every other token falls straight
      // through to Jupiter as before — it only intercepts the pools it builds right.
      new PumpSwapProvider(),
      new JupiterHostedProvider(),
      new JupiterSelfHostedProvider(),
      new FluxbeamProvider(),
      // Meteora DIRECT, ahead of the PumpPortal last resort: on 2026-07-21
      // every live buy on a Meteora venue fell through to PumpPortal and died
      // with `build 400` (48 fails, 0 fills) while meteora-damm-v2 carried the
      // entire paper session profit. Each throws instantly on "no pool of my
      // protocol", so non-Meteora tokens pass through at zero cost.
      new MeteoraDbcProvider(),
      new MeteoraDammV2Provider(),
      // PumpFun CURVE direct, ahead of the PumpPortal last resort (2026-07-26):
      // bonding-curve SELLS that PumpPortal 400s — the last write-off class.
      // Sell-only; everything else NoRoutes straight through.
      new PumpFunCurveProvider(),
      new PumpPortalProvider(),
    ];
    for (const p of this.providers)
      for (const side of ["buy", "sell"] as const)
        this.breakers.set(`${p.name}#${side}`, { fails: 0, openUntil: 0 });
  }

  private available(p: SwapProvider, cfg: HermesConfig): boolean {
    return p.available ? p.available(cfg) : true;
  }
  private healthy(name: string, side: BreakerSide): boolean {
    return Date.now() >= (this.breakers.get(`${name}#${side}`)?.openUntil ?? 0);
  }
  private trip(name: string, side: BreakerSide): void {
    const b = this.breakers.get(`${name}#${side}`);
    if (!b) return;
    b.fails += 1;
    if (b.fails >= BREAKER_TRIP_AFTER) {
      b.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
      b.fails = 0;
      console.warn(`⚠️  swap provider ${name} ${side}-side circuit OPEN (${BREAKER_COOLDOWN_MS / 1000}s cooldown)`);
    }
  }
  private restore(name: string, side: BreakerSide): void {
    const b = this.breakers.get(`${name}#${side}`);
    if (b) {
      b.fails = 0;
      b.openUntil = 0;
    }
  }

  /** First healthy provider's quote, in priority order. Throws only if ALL fail.
   *  `opts.protective` walks past OPEN breakers — the breaker becomes advisory
   *  for a flee, because a cooldown earned on the buy path (or an earlier sell)
   *  must never stand between a commanded exit and the only provider that can
   *  fill it. Trips are still recorded so ordinary flow keeps its protection. */
  async quote(
    cfg: HermesConfig,
    inputMint: string,
    outputMint: string,
    amountRaw: bigint,
    slippageBps: number,
    opts?: QuoteOpts,
  ): Promise<SwapQuote> {
    const side = sideOf(inputMint, outputMint);
    let lastErr: unknown;
    for (const p of this.providers) {
      if (opts?.exclude?.includes(p.name)) continue; // entry failover: venue just rejected the build
      if (!this.available(p, cfg)) continue;
      if (!opts?.protective && !this.healthy(p.name, side)) continue;
      try {
        const q = await p.quote(cfg, inputMint, outputMint, amountRaw, slippageBps, opts);
        this.restore(p.name, side);
        if (this.lastProvider !== p.name) console.log(`🔀 swap route via ${p.name}`);
        this.lastProvider = p.name;
        return q;
      } catch (err) {
        // A clean "not my protocol" refusal is FAILOVER, not failure — it must
        // never open the breaker, or a healthy provider goes dark for 30s
        // exactly when its venue's next candidate arrives.
        if (!(err instanceof NoRouteError)) this.trip(p.name, side);
        lastErr = err;
      }
    }
    throw new Error(`all swap providers down: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
  }

  /** QTEA-003 — the EXECUTABLE MARK: a read-only sell-valuation walk across the
   *  same provider universe that can actually build the exit. Jupiter stops
   *  being the only instrument that can value a position — a fresh PumpSwap or
   *  Meteora pool Jupiter hasn't indexed gets its mark from the direct provider.
   *  Read-only by contract: never mutates lastProvider (sell failover depends on
   *  it), never trips or restores a breaker (a valuation blip is not execution
   *  health), and skips build-only quotes (canValue === false). Throws when no
   *  provider can value — callers already treat a throw as "no executable mark". */
  async quoteValue(
    cfg: HermesConfig,
    mint: string,
    amountRaw: bigint,
    slippageBps: number,
  ): Promise<SwapQuote> {
    let lastErr: unknown;
    const candidates: SwapQuote[] = [];
    // PASS 1 — one-HTTP-call quoters (aggregators index most of the book).
    for (const p of this.providers) {
      if (!this.available(p, cfg)) continue;
      try {
        const q = await p.quote(cfg, mint, WSOL, amountRaw, slippageBps, { quoteOnly: true });
        if (q.canValue === false) continue; // build-only payload — not a mark
        if (Number(q.outAmount) > 0) { candidates.push(q); break; } // best aggregator answer
      } catch (err) {
        lastErr = err;
      }
    }
    // PASS 2 — direct providers pricing from their own pool reserves. NOT just
    // a fallback: BROKER #7319 (2026-08-02) — Jupiter ANSWERED, through a route
    // paying 0.27× while the real pumpswap pool priced ~1.0×; first-wins made
    // the guard decide protective exits off the worse instrument. The mark is
    // the BEST executable answer across both passes, always.
    for (const p of this.providers) {
      if (!p.quoteSellValue || !this.available(p, cfg)) continue;
      try {
        const q = await p.quoteSellValue(cfg, mint, amountRaw);
        if (Number(q.outAmount) > 0) candidates.push(q);
      } catch (err) {
        lastErr = err;
      }
    }
    if (candidates.length) return candidates.reduce((a, b) => (Number(b.outAmount) > Number(a.outAmount) ? b : a));
    throw new NoRouteError(
      `no provider can value ${mint}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    );
  }

  /** QTEA-008 — best executable route for NON-protective sells: quote the first
   *  two eligible providers in parallel and take the higher output. Profit
   *  routing optimizes proceeds; protective routing optimizes time-to-land and
   *  stays on quote() / the chamber. Falls back to the single-route walk when
   *  fewer than two providers answer. */
  async quoteBestSell(
    cfg: HermesConfig,
    mint: string,
    amountRaw: bigint,
    slippageBps: number,
    opts?: QuoteOpts,
  ): Promise<SwapQuote> {
    const side: BreakerSide = "sell";
    const eligible = this.providers.filter(
      (p) => !opts?.exclude?.includes(p.name) && this.available(p, cfg) && this.healthy(p.name, side),
    );
    const results = await Promise.allSettled(
      eligible.slice(0, 2).map((p) => p.quote(cfg, mint, WSOL, amountRaw, slippageBps, opts)),
    );
    const quotes = results
      .filter((r): r is PromiseFulfilledResult<SwapQuote> => r.status === "fulfilled")
      .map((r) => r.value)
      .filter((q) => Number(q.outAmount) > 0);
    if (quotes.length >= 1) {
      const best = quotes.reduce((a, b) => (Number(b.outAmount) > Number(a.outAmount) ? b : a));
      this.restore(best.provider, side);
      if (this.lastProvider !== best.provider) console.log(`🔀 swap route via ${best.provider} (best of ${quotes.length})`);
      this.lastProvider = best.provider;
      return best;
    }
    // Nobody in the parallel pair answered — the ordered walk still owns failover.
    return this.quote(cfg, mint, WSOL, amountRaw, slippageBps, opts);
  }

  /** The provider that served the most recent quote — sell-side failover
   * excludes it after a build reject. */
  lastRoute(): string | null {
    return this.lastProvider ?? null;
  }

  /** Build via the SAME provider that produced the quote. */
  async buildSwapTx(cfg: HermesConfig, quote: SwapQuote, userPublicKey: string): Promise<string> {
    const p = this.providers.find((x) => x.name === quote.provider);
    if (!p) throw new Error(`swap provider not registered: ${quote.provider}`);
    const side = sideOf(quote.inputMint, quote.outputMint);
    try {
      const tx = await p.buildSwapTx(cfg, quote, userPublicKey);
      this.restore(p.name, side);
      return tx;
    } catch (err) {
      this.trip(p.name, side);
      throw err;
    }
  }

  get activeProvider(): string | null {
    return this.lastProvider;
  }
  /** Per-provider health for the watchdog — the stack is "down" only if all false.
   *  A provider counts healthy if EITHER side can route (the sides trip apart). */
  providerHealth(): { name: string; healthy: boolean }[] {
    return this.providers.map((p) => ({
      name: p.name,
      healthy: this.healthy(p.name, "buy") || this.healthy(p.name, "sell"),
    }));
  }
}

/** Process-wide router shared by every wallet. Providers appended here as built. */
export const swapRouter = new SwapRouter();
