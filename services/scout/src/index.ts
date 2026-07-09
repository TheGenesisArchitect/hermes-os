import "dotenv/config";
import { loadConfig, runSafetyPipeline, type TokenCandidate } from "@hermes/core";
import { auditLog, db, safetyChecks, signals, tokens } from "@hermes/db";
import { inArray } from "drizzle-orm";
import { fetchNewPools } from "./ingest/geckoterminal.js";

const cfg = loadConfig();

function short(mint: string): string {
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
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

  if (verdict.passed) {
    await db.insert(signals).values({
      mint: candidate.mint,
      // M1 placeholder score = count of passed checks; real scoring lands in M2
      score: String(verdict.checks.filter((c) => c.passed).length),
      reasons: { checks: summary, liquidityUsd: candidate.liquidityUsd },
    });
    console.log(`🚨 SIGNAL  ${label}\n          ${summary}`);
  } else {
    console.log(`   reject  ${label}\n          ${summary}`);
  }
}

async function tick(): Promise<void> {
  const candidates = await fetchNewPools(cfg.SCOUT_MIN_LIQUIDITY_USD);
  if (candidates.length === 0) return;

  const known = await db
    .select({ mint: tokens.mint })
    .from(tokens)
    .where(inArray(tokens.mint, candidates.map((c) => c.mint)));
  const knownSet = new Set(known.map((k) => k.mint));
  const fresh = candidates.filter((c) => !knownSet.has(c.mint));

  if (fresh.length > 0) {
    console.log(`\n[${new Date().toISOString()}] ${fresh.length} new candidate(s) (of ${candidates.length} pools above $${cfg.SCOUT_MIN_LIQUIDITY_USD.toLocaleString()} liq)`);
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
console.log(`RPC: ${cfg.HELIUS_API_KEY ? "Helius" : "public mainnet-beta (set HELIUS_API_KEY for headroom)"}\n`);

// simple resilient loop — one failed tick never kills the daemon
// eslint-disable-next-line no-constant-condition
while (true) {
  try {
    await tick();
  } catch (err) {
    console.error(`tick failed: ${err instanceof Error ? err.message : err}`);
  }
  await new Promise((r) => setTimeout(r, cfg.SCOUT_POLL_MS));
}
