/**
 * RPC POOL — endpoint failover for the live lane, so the RPC isn't the next
 * single point of failure once Jupiter is no longer the dependency.
 *
 * READS fail over freely (idempotent). SENDS also fail over: a signed
 * transaction has a fixed signature, so re-submitting it to another endpoint is
 * network-deduped (it lands once or is rejected as already-processed) — never a
 * double-spend. Each endpoint has a circuit breaker: N consecutive failures →
 * skipped for a cooldown → re-probed. Throws only when EVERY endpoint is down.
 */
import { Connection, VersionedTransaction, type Transaction } from "@solana/web3.js";
import { resilientFetch, type HermesConfig } from "@hermes/core";

// web3.js calls fetch(url, init); resilientFetch(url, opts) reads method/headers/
// body from init and, on this host's DPI-reset of undici, falls back to curl
// (which GoodbyeDPI handles). Routing every RPC call through it makes publicnode
// et al. reachable when Node's own fetch is being mangled.
const rpcFetch = resilientFetch as unknown as typeof fetch;

const TRIP_AFTER = 3;
const COOLDOWN_MS = 20_000;

const host = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

interface Endpoint {
  url: string;
  conn: Connection;
  fails: number;
  openUntil: number;
}

export class RpcPool {
  private readonly eps: Endpoint[];
  private idx = 0; // sticky "current best"

  constructor(urls: string[]) {
    this.eps = urls.map((url) => ({
      url,
      conn: new Connection(url, { commitment: "confirmed", fetch: rpcFetch }),
      fails: 0,
      openUntil: 0,
    }));
  }

  private healthy(e: Endpoint): boolean {
    return Date.now() >= e.openUntil;
  }
  private trip(e: Endpoint): void {
    e.fails += 1;
    if (e.fails >= TRIP_AFTER) {
      e.openUntil = Date.now() + COOLDOWN_MS;
      e.fails = 0;
      console.warn(`⚠️  RPC ${host(e.url)} circuit OPEN (${COOLDOWN_MS / 1000}s cooldown)`);
    }
  }
  private restore(e: Endpoint): void {
    e.fails = 0;
    e.openUntil = 0;
  }

  /** Run a read against endpoints in priority order; fail over on any error.
   *  Retries the whole rotation a few times — a transient undici blip on this
   *  host's DPI filter (the primary momentarily "fetch failed" while the backup
   *  is unreachable) must not fail the operation. A single blip trips fails=1,
   *  well under the breaker threshold, so the endpoint is still retried. */
  async read<T>(fn: (c: Connection) => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      for (let i = 0; i < this.eps.length; i++) {
        const e = this.eps[(this.idx + i) % this.eps.length]!;
        if (!this.healthy(e)) continue;
        try {
          const r = await fn(e.conn);
          this.restore(e);
          this.idx = this.eps.indexOf(e);
          return r;
        } catch (err) {
          this.trip(e);
          lastErr = err;
        }
      }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
    throw new Error(`all RPCs down: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
  }

  /** Submit a signed tx; fail over across endpoints (signature-idempotent). */
  async send(tx: VersionedTransaction | Transaction, opts?: { skipPreflight?: boolean; maxRetries?: number }): Promise<string> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      for (let i = 0; i < this.eps.length; i++) {
        const e = this.eps[(this.idx + i) % this.eps.length]!;
        if (!this.healthy(e)) continue;
        try {
          const sig =
            tx instanceof VersionedTransaction
              ? await e.conn.sendTransaction(tx, { skipPreflight: opts?.skipPreflight ?? true, maxRetries: opts?.maxRetries ?? 3 })
              : await e.conn.sendRawTransaction(tx.serialize(), { skipPreflight: opts?.skipPreflight ?? true, maxRetries: opts?.maxRetries ?? 3 });
          this.restore(e);
          this.idx = this.eps.indexOf(e);
          return sig;
        } catch (err) {
          this.trip(e);
          lastErr = err;
        }
      }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
    throw new Error(`send failed on all RPCs: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
  }

  /** Per-endpoint health for the watchdog — the RPC is "down" only if all false. */
  endpoints(): { host: string; healthy: boolean }[] {
    return this.eps.map((e) => ({ host: host(e.url), healthy: this.healthy(e) }));
  }
}

let pool: RpcPool | null = null;
export function rpcPool(cfg: HermesConfig): RpcPool {
  if (!pool) pool = new RpcPool(cfg.rpcUrls);
  return pool;
}

// A primary Connection wired with the curl-fallback transport — for libraries
// (e.g. the PumpSwap SDK) that take a Connection directly and would otherwise get
// DPI-reset on this host. Its account reads ride resilientFetch just like the pool.
let sdkConn: Connection | null = null;
export function rpcConnection(cfg: HermesConfig): Connection {
  if (!sdkConn) sdkConn = new Connection(cfg.rpcUrls[0]!, { commitment: "confirmed", fetch: rpcFetch });
  return sdkConn;
}
