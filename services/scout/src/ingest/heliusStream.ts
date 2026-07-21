import { rpc } from "@hermes/core";

/**
 * Push ingest: subscribe to pool-creation logs on the major Solana AMMs via
 * Helius WebSocket (outbound connection — no public endpoint needed). Each
 * matching transaction is fetched and parsed for the newly launched mint.
 */

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const ANCHOR_MINTS = new Set([
  WSOL_MINT,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

interface WatchedProgram {
  address: string;
  dex: string;
  /** substring that must appear in the tx logs for it to count as a pool creation */
  createMarker: RegExp;
}

// Narrowed to the two lower-volume creation streams to limit Helius credit
// burn. PumpSwap (the highest-volume firehose) is intentionally dropped — the
// GeckoTerminal poll still catches those pools, just at poll latency.
const WATCHED_PROGRAMS: WatchedProgram[] = [
  {
    address: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    dex: "raydium-v4",
    createMarker: /initialize2/i,
  },
  {
    address: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
    dex: "meteora-damm-v2",
    createMarker: /Instruction: InitializePool/i,
  },
  // RAYDIUM — pre-wired 2026-07-21 while the stream is credit-blocked, so the
  // flip back to STREAM_ENABLED=true carries the venue automatically. The 7-day
  // census showed ~20 Raydium-family discoveries a WEEK against one of the
  // largest launch flows on Solana, and a raw 60-pool GT sample held ZERO
  // Raydium entries — GT does not index LaunchLab creations at launch speed, so
  // polling cannot deliver this venue; only the push stream can. Program IDs
  // validated against the chain (owner of known pools), not from memory. The
  // /initialize/i markers are deliberately broad — refine to the exact
  // instruction names from the first live events after re-enable.
  {
    address: "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj",
    dex: "raydium-launchlab",
    createMarker: /initialize/i,
  },
  {
    address: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
    dex: "raydium-cpmm",
    createMarker: /initialize/i,
  },
];

export interface StreamCandidate {
  mint: string;
  dex: string;
  signature: string;
  detectedAt: number;
}

interface LogsNotification {
  method?: string;
  params?: {
    subscription: number;
    result: {
      value: { signature: string; err: unknown; logs: string[] };
    };
  };
  result?: number; // subscription confirmation
  id?: number;
}

/** Extract the newly launched mint from a pool-creation transaction. */
async function extractMint(rpcUrl: string, signature: string): Promise<string | null> {
  const tx = await rpc.rpcCall<{
    meta?: { postTokenBalances?: Array<{ mint: string }> };
  } | null>(rpcUrl, "getTransaction", [
    signature,
    { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
  ]);
  const mints = [
    ...new Set((tx?.meta?.postTokenBalances ?? []).map((b) => b.mint)),
  ].filter((m) => !ANCHOR_MINTS.has(m));
  // pool-creation txs reference the new token; LP mints rarely appear in
  // postTokenBalances at creation. If several remain, take the first.
  return mints[0] ?? null;
}

export class HeliusStream {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private subToProgram = new Map<number, WatchedProgram>();
  private pendingSubs = new Map<number, WatchedProgram>(); // request id → program
  private seenSignatures = new Set<string>();
  private stopped = false;
  private backoffMs = 2_000;

  constructor(
    private readonly apiKey: string,
    private readonly rpcUrl: string,
    private readonly onCandidate: (c: StreamCandidate) => void,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }

  private connect(): void {
    if (this.stopped) return;
    const url = `wss://mainnet.helius-rpc.com/?api-key=${this.apiKey}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    this.subToProgram.clear();
    this.pendingSubs.clear();

    ws.addEventListener("open", () => {
      this.backoffMs = 2_000;
      for (const program of WATCHED_PROGRAMS) {
        const id = this.nextId++;
        this.pendingSubs.set(id, program);
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "logsSubscribe",
            params: [{ mentions: [program.address] }, { commitment: "confirmed" }],
          }),
        );
      }
      console.log(`📡 stream connected — watching ${WATCHED_PROGRAMS.map((p) => p.dex).join(", ")}`);
    });

    ws.addEventListener("message", (event) => {
      void this.handleMessage(String(event.data));
    });

    ws.addEventListener("close", () => {
      if (this.stopped) return;
      console.log(`stream disconnected — reconnecting in ${this.backoffMs / 1000}s`);
      setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
    });

    ws.addEventListener("error", () => {
      // close handler drives the reconnect
    });
  }

  private async handleMessage(raw: string): Promise<void> {
    let msg: LogsNotification;
    try {
      msg = JSON.parse(raw) as LogsNotification;
    } catch {
      return;
    }

    // subscription confirmation: {id, result: subscriptionNumber}
    if (msg.id !== undefined && typeof msg.result === "number") {
      const program = this.pendingSubs.get(msg.id);
      if (program) {
        this.subToProgram.set(msg.result, program);
        this.pendingSubs.delete(msg.id);
      }
      return;
    }

    if (msg.method !== "logsNotification" || !msg.params) return;
    const program = this.subToProgram.get(msg.params.subscription);
    if (!program) return;

    const { signature, err, logs } = msg.params.result.value;
    if (err) return; // failed tx
    if (!logs.some((line) => program.createMarker.test(line))) return;
    if (this.seenSignatures.has(signature)) return;
    this.seenSignatures.add(signature);
    if (this.seenSignatures.size > 5_000) {
      this.seenSignatures = new Set([...this.seenSignatures].slice(-1_000));
    }

    try {
      const mint = await extractMint(this.rpcUrl, signature);
      if (!mint) return;
      this.onCandidate({ mint, dex: program.dex, signature, detectedAt: Date.now() });
    } catch (error) {
      console.error(
        `stream: failed to parse tx ${signature.slice(0, 8)}…: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}
