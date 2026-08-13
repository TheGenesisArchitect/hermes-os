import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
// repo-root .env — services run with cwd at their own package dir
loadEnv({ path: resolve(import.meta.dirname, "../../../.env") });
// ONE SCOUT ONLY — discovery starving silently is the worst failure mode
// (roster audit 2026-07-23: scout was the last lock-less trading-path service).
import { acquireSingletonLock } from "@hermes/core";
acquireSingletonLock(resolve(import.meta.dirname, "../../../.hermes-scout.pid"), "scout");
import {
  computeScore,
  fetchTokenMarket,
  loadConfig,
  runSafetyPipeline,
  scoreNarrative,
  type ScoreBreakdown,
  type TokenCandidate,
} from "@hermes/core";
import { auditLog, config, db, safetyChecks, signals, tokens } from "@hermes/db";
import { eq, inArray } from "drizzle-orm";
import { fetchNewPools } from "./ingest/geckoterminal.js";
import { fetchNewPoolsDexscreener } from "./ingest/dexscreener.js";
import { HeliusStream, type StreamCandidate } from "./ingest/heliusStream.js";
import { PumpPortalStream, type PumpPortalHealth } from "./ingest/pumpportal.js";

const cfg = loadConfig();

function short(mint: string): string {
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

// Mints seen via the push stream, awaiting enough liquidity to enter the
// pipeline. Retried each tick; dropped after STREAM_QUEUE_TTL_MS.
const STREAM_QUEUE_TTL_MS = 15 * 60_000;
const streamQueue = new Map<string, StreamCandidate>();

async function scoreCandidate(candidate: TokenCandidate): Promise<ScoreBreakdown | null> {
  try {
    const market = await fetchTokenMarket(candidate.mint);
    if (!market) return null;
    const narrative = await scoreNarrative(cfg.NARRATIVE_API_URL, {
      name: candidate.name,
      symbol: candidate.symbol,
      dex: candidate.dex,
      liquidityUsd: candidate.liquidityUsd,
    }, cfg.NARRATIVE_API_KEY).catch((err) => {
      console.error(`   narrative scoring failed: ${err instanceof Error ? err.message : err}`);
      return null;
    });
    return computeScore(market, narrative);
  } catch (err) {
    console.error(`   scoring failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function processCandidate(candidate: TokenCandidate): Promise<void> {
  await db
    .insert(tokens)
    .values({
      mint: candidate.mint,
      chain: candidate.chain,
      name: candidate.name,
      symbol: candidate.symbol,
      poolAddress: candidate.poolAddress,
      dex: candidate.dex,
      baseTokenMint: candidate.baseTokenMint,
      liquidityUsd: candidate.liquidityUsd?.toString(),
      fdvUsd: candidate.fdvUsd?.toString(),
      poolCreatedAt: candidate.poolCreatedAt,
      raw: candidate.raw,
    })
    .onConflictDoNothing();

  await db.insert(auditLog).values({
    actor: "scout",
    action: "safety_pipeline_start",
    details: { mint: candidate.mint, symbol: candidate.symbol, dex: candidate.dex },
  });

  const verdict = await runSafetyPipeline(cfg, candidate);

  await db.insert(safetyChecks).values(
    verdict.checks.map((c) => ({
      mint: candidate.mint,
      checkName: c.checkName,
      passed: c.passed,
      evidence: c.evidence,
    })),
  );

  const summary = verdict.checks
    .map((c) => `${c.passed ? "✓" : "✗"} ${c.checkName}`)
    .join("  ");
  const label = `${candidate.symbol ?? "?"} ${short(candidate.mint)} [${candidate.dex}] liq $${Math.round(candidate.liquidityUsd ?? 0).toLocaleString()}`;

  if (verdict.tradeable) {
    const breakdown = await scoreCandidate(candidate);
    await db.insert(signals).values({
      mint: candidate.mint,
      score: String(breakdown?.score ?? 0),
      reasons: {
        checks: summary,
        scoring: breakdown ?? "market data unavailable",
        risk: {
          tier: verdict.riskTier,
          sizeMultiplier: verdict.sizeMultiplier,
          flags: verdict.riskFlags,
        },
      },
    });
    const scoreLabel = breakdown
      ? `score ${breakdown.score} (mom ${breakdown.components.momentum} / buy ${breakdown.components.buyPressure} / cvx ${breakdown.components.convexity} / src ${breakdown.components.source} / narr ${breakdown.components.narrative})`
      : "score 0 (no market data yet)";
    const riskLabel =
      verdict.riskTier === "clean"
        ? "risk: clean · full size"
        : `risk: ${verdict.riskTier} [${verdict.riskFlags.join(", ")}] · size ×${verdict.sizeMultiplier}`;
    console.log(`🚨 SIGNAL  ${label}\n          ${summary}\n          ${scoreLabel}\n          ${riskLabel}`);
  } else {
    console.log(`   reject  ${label}  ⛔ trap: ${verdict.traps.join(", ") || "n/a"}\n          ${summary}`);
  }
}

/** Filter a set of mints down to those not already in the tokens table. */
async function unknownMints(mints: string[]): Promise<Set<string>> {
  if (mints.length === 0) return new Set();
  const known = await db
    .select({ mint: tokens.mint })
    .from(tokens)
    .where(inArray(tokens.mint, mints));
  const knownSet = new Set(known.map((k) => k.mint));
  return new Set(mints.filter((m) => !knownSet.has(m)));
}

/** Enrich stream-detected mints via DexScreener; process those that now clear the liquidity gate. */
async function drainStreamQueue(): Promise<void> {
  if (streamQueue.size === 0) return;
  const now = Date.now();
  const unknown = await unknownMints([...streamQueue.keys()]);
  let processed = 0;

  for (const [mint, entry] of [...streamQueue.entries()]) {
    if (now - entry.detectedAt > STREAM_QUEUE_TTL_MS) {
      streamQueue.delete(mint);
      continue;
    }
    if (!unknown.has(mint)) {
      streamQueue.delete(mint); // already processed via poll or a prior tick
      continue;
    }
    const market = await fetchTokenMarket(mint).catch(() => null);
    if (!market || market.liquidityUsd < cfg.SCOUT_MIN_LIQUIDITY_USD) continue; // not ready yet — retry next tick

    streamQueue.delete(mint);
    const ageSec = Math.round((now - entry.detectedAt) / 1000);
    console.log(
      `\n[${new Date().toISOString()}] ⚡ stream candidate ${short(mint)} [${entry.dex}] liq $${Math.round(market.liquidityUsd).toLocaleString()} (${ageSec}s after creation)`,
    );
    try {
      await processCandidate({
        mint,
        chain: "solana",
        // Recover identity from the enriched market — PumpPortal migration events
        // carry no symbol/name, so without this graduated tokens are unidentifiable
        // ("?") in signals, fills, positions and the recorder board.
        symbol: market.symbol ?? undefined,
        name: market.name ?? undefined,
        dex: entry.dex,
        poolAddress: market.pairAddress,
        liquidityUsd: market.liquidityUsd,
        fdvUsd: market.fdvUsd,
      });
      processed++;
    } catch (err) {
      console.error(`   error   ${short(mint)}: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (processed > 0) console.log(`   (${streamQueue.size} still maturing in stream queue)`);
}

/**
 * Pull fresh candidates from GeckoTerminal's new-pools firehose; if it's
 * unreachable (network filtering, outage), fall back to the keyless DexScreener
 * fresh-token feed so ingest never goes dark on a single source.
 */
async function fetchCandidates(): Promise<TokenCandidate[]> {
  try {
    return await fetchNewPools(cfg.SCOUT_MIN_LIQUIDITY_USD);
  } catch (err) {
    const gt = err instanceof Error ? err.message : String(err);
    try {
      const ds = await fetchNewPoolsDexscreener(cfg.SCOUT_MIN_LIQUIDITY_USD);
      console.log(`   (GeckoTerminal unreachable: ${gt} — using DexScreener fallback, ${ds.length} candidate(s))`);
      return ds;
    } catch (err2) {
      throw new Error(`both ingests failed — GT: ${gt}; DS: ${err2 instanceof Error ? err2.message : err2}`);
    }
  }
}

async function tick(): Promise<void> {
  await drainStreamQueue();

  const candidates = await fetchCandidates();
  if (candidates.length === 0) return;

  const unknown = await unknownMints(candidates.map((c) => c.mint));
  // one mint can surface via multiple pools in the same poll — keep the most liquid
  const byMint = new Map<string, TokenCandidate>();
  for (const c of candidates) {
    if (!unknown.has(c.mint)) continue;
    const existing = byMint.get(c.mint);
    if (!existing || (c.liquidityUsd ?? 0) > (existing.liquidityUsd ?? 0)) byMint.set(c.mint, c);
  }
  const fresh = [...byMint.values()];

  if (fresh.length > 0) {
    console.log(`\n[${new Date().toISOString()}] ${fresh.length} new poll candidate(s) (of ${candidates.length} pools above $${cfg.SCOUT_MIN_LIQUIDITY_USD.toLocaleString()} liq)`);
  }
  for (const candidate of fresh) {
    try {
      await processCandidate(candidate);
    } catch (err) {
      console.error(`   error   ${short(candidate.mint)}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

console.log(`SCOUT online — polling GeckoTerminal every ${cfg.SCOUT_POLL_MS / 1000}s, min liquidity $${cfg.SCOUT_MIN_LIQUIDITY_USD.toLocaleString()}`);
const rpcLabel =
  cfg.HELIUS_API_KEY && cfg.HELIUS_RPC_ENABLED
    ? "Helius"
    : `${cfg.rpcUrl}${cfg.HELIUS_API_KEY ? " (Helius RPC disabled — sparing credits)" : ""}`;
console.log(`RPC: ${rpcLabel}`);

// PumpPortal push ingest — keyless, no gate. A second network-independent
// source (pump.fun graduations) so ingest survives any single host being
// filtered. Migrated tokens land in the same stream queue the drain enriches.
const pumpportal = new PumpPortalStream((c) => {
  if (!streamQueue.has(c.mint)) {
    streamQueue.set(c.mint, c);
    console.log(`   🎓 graduation ${short(c.mint)} [${c.dex}] — queued for enrichment`);
  }
});
pumpportal.start();

/** Surface scout + PumpPortal liveness to the dashboard (separate process) via config. */
async function writeScoutHealth(): Promise<void> {
  const pp: PumpPortalHealth = pumpportal.health();
  const value = {
    ts: Date.now(),
    streamQueue: streamQueue.size,
    pumpportal: pp,
  };
  await db
    .insert(config)
    .values({ key: "scout_health", value })
    .onConflictDoUpdate({ target: config.key, set: { value, updatedAt: new Date() } });
}

// Flush health on a fast, tick-independent cadence so the PumpPortal WS heartbeat
// age the dashboard sees reflects real liveness (not the 45s poll quantum).
setInterval(() => {
  void writeScoutHealth().catch((err) =>
    console.error(`health flush failed: ${err instanceof Error ? err.message : err}`),
  );
}, 10_000);

// Push ingest requires a Helius key (WebSocket logsSubscribe). Without one we
// fall back to poll-only.
if (cfg.HELIUS_API_KEY && cfg.STREAM_ENABLED) {
  const stream = new HeliusStream(cfg.HELIUS_API_KEY, cfg.rpcUrl, (c) => {
    if (!streamQueue.has(c.mint)) {
      streamQueue.set(c.mint, c);
      console.log(`   ⚡ pool created ${short(c.mint)} [${c.dex}] — queued for enrichment`);
    }
  });
  stream.start();
} else {
  console.log(
    cfg.STREAM_ENABLED
      ? "(no Helius key — poll-only mode; set HELIUS_API_KEY for real-time push ingest)"
      : "(STREAM_ENABLED=false — poll-only mode; GeckoTerminal backstop covers ingest)",
  );
}
console.log("");

// simple resilient loop — one failed tick never kills the daemon
// eslint-disable-next-line no-constant-condition
while (true) {
  try {
    await tick();
  } catch (err) {
    console.error(`tick failed: ${err instanceof Error ? err.message : err}`);
  }
  await writeScoutHealth().catch((err) =>
    console.error(`health write failed: ${err instanceof Error ? err.message : err}`),
  );
  await new Promise((r) => setTimeout(r, cfg.SCOUT_POLL_MS));
}
