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

interface Breaker {
  fails: number;
  openUntil: number;
}

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
    for (const p of this.providers) this.breakers.set(p.name, { fails: 0, openUntil: 0 });
  }

  private available(p: SwapProvider, cfg: HermesConfig): boolean {
    return p.available ? p.available(cfg) : true;
  }
  private healthy(name: string): boolean {
    return Date.now() >= (this.breakers.get(name)?.openUntil ?? 0);
  }
  private trip(name: string): void {
    const b = this.breakers.get(name);
    if (!b) return;
    b.fails += 1;
    if (b.fails >= BREAKER_TRIP_AFTER) {
      b.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
      b.fails = 0;
      console.warn(`⚠️  swap provider ${name} circuit OPEN (${BREAKER_COOLDOWN_MS / 1000}s cooldown)`);
    }
  }
  private restore(name: string): void {
    const b = this.breakers.get(name);
    if (b) {
      b.fails = 0;
      b.openUntil = 0;
    }
  }

  /** First healthy provider's quote, in priority order. Throws only if ALL fail. */
  async quote(
    cfg: HermesConfig,
    inputMint: string,
    outputMint: string,
    amountRaw: bigint,
    slippageBps: number,
    opts?: QuoteOpts,
  ): Promise<SwapQuote> {
    let lastErr: unknown;
    for (const p of this.providers) {
      if (opts?.exclude?.includes(p.name)) continue; // entry failover: venue just rejected the build
      if (!this.available(p, cfg) || !this.healthy(p.name)) continue;
      try {
        const q = await p.quote(cfg, inputMint, outputMint, amountRaw, slippageBps, opts);
        this.restore(p.name);
        if (this.lastProvider !== p.name) console.log(`🔀 swap route via ${p.name}`);
        this.lastProvider = p.name;
        return q;
      } catch (err) {
        // A clean "not my protocol" refusal is FAILOVER, not failure — it must
        // never open the breaker, or a healthy provider goes dark for 30s
        // exactly when its venue's next candidate arrives.
        if (!(err instanceof NoRouteError)) this.trip(p.name);
        lastErr = err;
      }
    }
    throw new Error(`all swap providers down: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
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
    try {
      const tx = await p.buildSwapTx(cfg, quote, userPublicKey);
      this.restore(p.name);
      return tx;
    } catch (err) {
      this.trip(p.name);
      throw err;
    }
  }

  get activeProvider(): string | null {
    return this.lastProvider;
  }
  /** Per-provider health for the watchdog — the stack is "down" only if all false. */
  providerHealth(): { name: string; healthy: boolean }[] {
    return this.providers.map((p) => ({ name: p.name, healthy: this.healthy(p.name) }));
  }
}

/** Process-wide router shared by every wallet. Providers appended here as built. */
export const swapRouter = new SwapRouter();
