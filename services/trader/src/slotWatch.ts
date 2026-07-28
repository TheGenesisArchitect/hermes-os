/**
 * P1: SLOT TELEMETRY — the trader's ear on the chain (ratified 2026-07-25).
 *
 * One websocket to the RPC, an accountSubscribe per OPEN position's pool
 * (capped). Every notification carries the pool account's lamport balance —
 * on the bonding-curve venues where every drain death happened (meteora-dbc,
 * pump), that balance IS the quote side of the curve, so a drain is visible
 * as the TX executes (~0.4-0.8s) instead of at the next aggregator read.
 *
 * Consumers:
 *  - poolPulse(mint): in-memory drain signal for the depth rail — the rail's
 *    2-read confirm can treat a ws-corroborated drain as its second read.
 *  - chain_ticks: throttled hot stream (≤1 row/s/mint) for the card's flow
 *    tape and the diagnosis agent (C3).
 *
 * Fail-open by design: no ws, no subs, or a dead connection degrades to
 * exactly the pre-P1 poll behavior. Nothing here can block the manage loop.
 */
import { db } from "@hermes/db";
import { sql } from "drizzle-orm";

interface PoolState {
  pool: string;
  subId: number | null;
  reqId: number;
  lastSlot: number;
  lamports: number | null;
  /** ring of [ms, lamports] samples for the 30s drain window */
  samples: [number, number][];
  eventsMin: number[];
  lastInsertMs: number;
  lastDrainFireMs: number;
}

// P2 FAST EXIT (operator 2026-07-26: "kill the drain-cut tail"): when the
// pool's own SOL halves inside 30s, the drain is executing NOW — waiting for
// the next manage poll pays the measured 13-16% cut tax. The handler fires
// the exit the moment the event lands; 30s re-fire guard per pool.
let drainHandler: ((mint: string) => void) | null = null;
export function setDrainHandler(fn: (mint: string) => void): void {
  drainHandler = fn;
}

const WS_URLS = ["wss://solana-rpc.publicnode.com", "wss://api.mainnet-beta.solana.com"];
// 15 → 40 (operator 2026-07-28: "we should never sit down if we can't get our
// money out"). At 15, open positions shared the budget with armed candidates
// and a big paper book could leave a LIVE seat with no real-time feed at all —
// CLARITY died with the ws watcher potentially blind. Account subscriptions
// are cheap; 40 covers the whole open book plus the armed queue.
const MAX_SUBS = 40;
const state = new Map<string, PoolState>(); // mint → state
let ws: WebSocket | null = null;
let wsUrlIdx = 0;
let nextReqId = 1;
let reconnectDelay = 1_000;
const pendingSub = new Map<number, string>(); // reqId → mint

function connect(): void {
  try {
    ws = new WebSocket(WS_URLS[wsUrlIdx % WS_URLS.length]!);
  } catch {
    ws = null;
    return;
  }
  ws.onopen = () => {
    reconnectDelay = 1_000;
    // (Re)subscribe everything we're supposed to be watching.
    for (const [mint, st] of state) {
      st.subId = null;
      sendSub(mint, st);
    }
  };
  ws.onmessage = (ev) => {
    try {
      const m = JSON.parse(String(ev.data));
      if (m.id != null && typeof m.result === "number" && pendingSub.has(m.id)) {
        const mint = pendingSub.get(m.id)!;
        pendingSub.delete(m.id);
        const st = state.get(mint);
        if (st) st.subId = m.result;
        else send({ jsonrpc: "2.0", id: nextReqId++, method: "accountUnsubscribe", params: [m.result] });
        return;
      }
      if (m.method === "accountNotification") {
        const subId = m.params?.subscription as number;
        const slot = Number(m.params?.result?.context?.slot ?? 0);
        const lamports = Number(m.params?.result?.value?.lamports ?? NaN);
        for (const [mint, st] of state) {
          if (st.subId !== subId) continue;
          const now = Date.now();
          st.lastSlot = slot;
          if (Number.isFinite(lamports)) {
            st.lamports = lamports;
            st.samples.push([now, lamports]);
            while (st.samples.length && now - st.samples[0]![0] > 60_000) st.samples.shift();
          }
          st.eventsMin.push(now);
          while (st.eventsMin.length && now - st.eventsMin[0]! > 60_000) st.eventsMin.shift();
          // Drain detection on the event itself: ≥50% of pool SOL gone in 30s.
          if (drainHandler && now - st.lastDrainFireMs > 30_000) {
            const windowStart = now - 30_000;
            const inWindow = st.samples.filter(([t]) => t >= windowStart);
            if (inWindow.length >= 2) {
              const first = inWindow[0]![1];
              const last = inWindow[inWindow.length - 1]![1];
              if (first > 0.05e9 && last < first * 0.5) {
                st.lastDrainFireMs = now;
                drainHandler(mint);
              }
            }
          }
          if (now - st.lastInsertMs >= 1_000) {
            st.lastInsertMs = now;
            void db
              .execute(
                sql`INSERT INTO chain_ticks (mint, pool, slot, lamports)
                    VALUES (${mint}, ${st.pool}, ${slot}, ${Number.isFinite(lamports) ? lamports : null})`,
              )
              .catch(() => {});
          }
          break;
        }
      }
    } catch {
      /* malformed frame — ignore */
    }
  };
  ws.onclose = () => {
    ws = null;
    wsUrlIdx++;
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(30_000, reconnectDelay * 2);
  };
  ws.onerror = () => {
    try {
      ws?.close();
    } catch {
      /* already closing */
    }
  };
}

function send(msg: unknown): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* dropped frame — resub on reconnect */
    }
  }
}

function sendSub(mint: string, st: PoolState): void {
  st.reqId = nextReqId++;
  pendingSub.set(st.reqId, mint);
  send({
    jsonrpc: "2.0",
    id: st.reqId,
    method: "accountSubscribe",
    params: [st.pool, { encoding: "base64", commitment: "processed" }],
  });
}

/**
 * Reconcile subscriptions with the open book. Called from the manage loop —
 * cheap when nothing changed. `wanted` is mint → poolAddress for open
 * positions (both lanes), first MAX_SUBS kept.
 */
export function syncSlotWatch(wanted: Map<string, string>): void {
  if (!ws) connect();
  let kept = 0;
  for (const [mint, pool] of wanted) {
    if (kept >= MAX_SUBS) break;
    kept++;
    const st = state.get(mint);
    if (st) continue;
    const fresh: PoolState = {
      pool,
      subId: null,
      reqId: 0,
      lastSlot: 0,
      lamports: null,
      samples: [],
      eventsMin: [],
      lastInsertMs: 0,
      lastDrainFireMs: 0,
    };
    state.set(mint, fresh);
    sendSub(mint, fresh);
  }
  for (const [mint, st] of state) {
    if (wanted.has(mint)) continue;
    if (st.subId != null) send({ jsonrpc: "2.0", id: nextReqId++, method: "accountUnsubscribe", params: [st.subId] });
    state.delete(mint);
  }
}

export interface PoolPulse {
  lastSlot: number;
  ageMs: number;
  lamports: number | null;
  /** fraction of pool SOL LOST over the trailing 30s of ws samples (0..1) */
  drop30s: number;
  eventsPerMin: number;
}

/** The rail's ground-truth read. Null when we have no live telemetry. */
export function poolPulse(mint: string): PoolPulse | null {
  const st = state.get(mint);
  if (!st || st.lastSlot === 0) return null;
  const now = Date.now();
  let drop30s = 0;
  const windowStart = now - 30_000;
  const inWindow = st.samples.filter(([t]) => t >= windowStart);
  if (inWindow.length >= 2) {
    const first = inWindow[0]![1];
    const last = inWindow[inWindow.length - 1]![1];
    if (first > 0 && last < first) drop30s = (first - last) / first;
  }
  return {
    lastSlot: st.lastSlot,
    ageMs: st.eventsMin.length ? now - st.eventsMin[st.eventsMin.length - 1]! : Number.POSITIVE_INFINITY,
    lamports: st.lamports,
    drop30s,
    eventsPerMin: st.eventsMin.length,
  };
}
