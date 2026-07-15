import type { StreamCandidate } from "./heliusStream.js";

/**
 * PumpPortal push ingest (keyless) — a second, network-independent fresh-token
 * source so scout never goes dark if a single host is filtered. We subscribe to
 * `subscribeMigration`: pump.fun tokens whose bonding curve completed and just
 * graduated onto pump-amm/Raydium. That's the deliberate cohort — demonstrated
 * demand (~$69k raised to graduate), real liquidity the instant they land (so
 * DexScreener can price them immediately), and low enough volume (~1.5/min) that
 * it never floods the recorder the way the raw new-token firehose would.
 *
 * We ALSO subscribe to `subscribeNewToken` — but purely as a HEARTBEAT. Those
 * events fire ~1-2/sec, so any silence past QUIET_MS means the socket has died
 * silently (the exact failure mode that stalled the pipeline before: a filtered
 * host drops packets with no close event). The watchdog force-cycles on that.
 * New-token events are counted for liveness and dropped — never ingested.
 */

const WS_URL = "wss://pumpportal.fun/api/data";
// New-token events arrive ~1-2/sec; 25s of total silence = dead socket.
const QUIET_MS = 25_000;
const WATCHDOG_MS = 10_000;

export interface PumpPortalHealth {
  connected: boolean;
  lastMessageAt: number | null; // any frame (heartbeat)
  lastMigrationAt: number | null; // last acted-on migration
  migrationsSeen: number;
  reconnects: number;
}

export class PumpPortalStream {
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoffMs = 2_000;
  private lastMessageAt: number | null = null;
  private lastMigrationAt: number | null = null;
  private migrationsSeen = 0;
  private reconnects = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private seenMints = new Set<string>();

  constructor(private readonly onCandidate: (c: StreamCandidate) => void) {}

  start(): void {
    this.stopped = false;
    this.connect();
    this.startWatchdog();
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.ws?.close();
  }

  health(): PumpPortalHealth {
    return {
      connected: this.ws?.readyState === 1,
      lastMessageAt: this.lastMessageAt,
      lastMigrationAt: this.lastMigrationAt,
      migrationsSeen: this.migrationsSeen,
      reconnects: this.reconnects,
    };
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.backoffMs = 2_000;
      this.lastMessageAt = Date.now();
      ws.send(JSON.stringify({ method: "subscribeMigration" }));
      ws.send(JSON.stringify({ method: "subscribeNewToken" })); // heartbeat only — dropped
      console.log("📡 PumpPortal connected — watching pump.fun graduations (migration cohort)");
    });

    ws.addEventListener("message", (event) => {
      this.lastMessageAt = Date.now(); // every frame is a heartbeat
      this.handle(String(event.data));
    });

    ws.addEventListener("close", () => {
      if (this.stopped) return;
      console.log(`PumpPortal disconnected — reconnecting in ${this.backoffMs / 1000}s`);
      setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
    });

    ws.addEventListener("error", () => {
      // close handler drives the reconnect
    });
  }

  private handle(raw: string): void {
    // Cheap pre-filter: only migrations are acted on. New-token frames
    // (txType "create", pool "pump") and ACKs are heartbeat-only — skip the parse.
    if (!raw.includes('"migrate"') && !raw.includes("pump-amm")) return;

    let msg: { txType?: string; pool?: string; mint?: string; signature?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.txType !== "migrate" && msg.pool !== "pump-amm") return;

    const mint = msg.mint;
    if (!mint || this.seenMints.has(mint)) return;
    this.seenMints.add(mint);
    if (this.seenMints.size > 5_000) {
      this.seenMints = new Set([...this.seenMints].slice(-1_000));
    }

    this.migrationsSeen++;
    this.lastMigrationAt = Date.now();
    const dex = typeof msg.pool === "string" ? msg.pool : "pumpswap";
    this.onCandidate({ mint, dex, signature: msg.signature ?? "", detectedAt: Date.now() });
  }

  private startWatchdog(): void {
    this.watchdog = setInterval(() => {
      if (this.stopped || this.lastMessageAt === null) return;
      const quietMs = Date.now() - this.lastMessageAt;
      // Socket claims OPEN but the heartbeat stream went quiet → silently dead.
      if (quietMs > QUIET_MS && this.ws && this.ws.readyState === 1) {
        console.log(
          `PumpPortal silent ${Math.round(quietMs / 1000)}s (watchdog) — forcing reconnect`,
        );
        this.reconnects++;
        try {
          this.ws.close(); // close handler schedules the reconnect
        } catch {
          // ignore
        }
      }
    }, WATCHDOG_MS);
  }
}
