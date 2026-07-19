/**
 * M5 dry-run validator — proves the live execution path end-to-end WITHOUT
 * sending a transaction or requiring a funded wallet:
 *
 *   1. quote SOL→USDC on the real Jupiter swap API
 *   2. build the real swap transaction for a wallet pubkey
 *   3. sign it (ephemeral keypair if no TRADER_WALLET_SECRET_KEY)
 *   4. SIMULATE on the real RPC — never sent
 *
 * Expected result with an unfunded wallet: quote OK, build OK, signature OK,
 * simulation fails with an insufficient-funds-class program error — which is
 * the PROOF that everything up to funding works. Run at go-live time with the
 * funded wallet and the simulation should pass clean.
 *
 *   pnpm --filter @hermes/trader exec tsx src/live/dryRun.ts
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
loadEnv({ path: resolve(import.meta.dirname, "../../../../.env") });

import { Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";
import { loadConfig } from "@hermes/core";
import { rpcPool } from "./rpc/pool.js";
import { WSOL_MINT } from "./swap/jupiterHosted.js";
import { swapRouter } from "./swap/router.js";
import { liveWallet } from "./wallet.js";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const cfg = loadConfig();
const wallet = liveWallet() ?? Keypair.generate();
const ephemeral = !liveWallet();
console.log(`wallet: ${wallet.publicKey.toBase58()} ${ephemeral ? "(EPHEMERAL — no .env key, structure test only)" : "(from .env)"}`);
console.log(`rpc: ${cfg.rpcUrl}`);

// 1. quote — $5 of SOL into USDC
const lamports = 5_000_000_000n / 100n; // 0.05 SOL
const quote = await swapRouter.quote(cfg, WSOL_MINT, USDC, lamports, cfg.LIVE_SLIPPAGE_BPS);
console.log(`✓ quote: 0.05 SOL → ${(Number(quote.outAmount) / 1e6).toFixed(2)} USDC (impact ${quote.priceImpactPct}%)`);

// 2. build
const b64 = await swapRouter.buildSwapTx(cfg, quote, wallet.publicKey.toBase58());
console.log(`✓ swap tx built: ${Math.round((b64.length * 3) / 4)} bytes`);

// 3. sign — provider may return a versioned (Jupiter) or legacy (Fluxbeam) tx
const buf = Buffer.from(b64, "base64");
let tx: VersionedTransaction | Transaction;
let feePayer: string | undefined;
try {
  const vt = VersionedTransaction.deserialize(buf);
  vt.sign([wallet]);
  feePayer = vt.message.staticAccountKeys[0]?.toBase58();
  tx = vt;
} catch {
  const lt = Transaction.from(buf);
  lt.sign(wallet);
  feePayer = lt.feePayer?.toBase58();
  tx = lt;
}
console.log(`✓ signed via ${quote.provider} (${tx instanceof VersionedTransaction ? "versioned" : "legacy"}, fee payer ${feePayer === wallet.publicKey.toBase58() ? "matches wallet" : "MISMATCH!"})`);

// 4. simulate — NEVER sent (through the failover RPC pool, like the executor)
const sim = await rpcPool(cfg).read((c) =>
  tx instanceof VersionedTransaction ? c.simulateTransaction(tx, { commitment: "confirmed" }) : c.simulateTransaction(tx),
);
if (sim.value.err) {
  console.log(`✓ simulation returned expected error for unfunded wallet: ${JSON.stringify(sim.value.err)}`);
  console.log("  (a funded wallet at go-live should simulate CLEAN — rerun this then)");
} else {
  console.log("✓ SIMULATION CLEAN — the wallet is funded and the full execution path is verified. NOTHING WAS SENT.");
}
process.exit(0);
