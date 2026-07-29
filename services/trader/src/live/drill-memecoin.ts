/**
 * MEMECOIN SNIPER DRILL (operator watching, 2026-07-29). Exercises the
 * PRODUCTION presigned module — chamberExit + fireChambered, the exact code
 * that will guard real positions — on a real memecoin route (pump-venue tx
 * shapes, their ALTs, their providers), unlike the USDC mechanics test.
 *
 * Picks the deepest ACTIVE candidate pool ≥ $20k seen in the last 30 min,
 * buys one $2.50 ticket via the live router, chambers through the module,
 * waits 20s, fires through the module, and reports fire→settled ms.
 * Budget: one ticket + fees. A memecoin can move ±20% during the drill —
 * that variance is the drill's realism, bounded by the ticket size.
 *
 * Run: npx tsx services/trader/src/live/drill-memecoin.ts
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
loadEnv({ path: resolve(import.meta.dirname, "../../../../.env") });
process.env.LIVE_PRESIGNED_EXITS = "true"; // the module under test
import { Connection, VersionedTransaction } from "@solana/web3.js";
import { loadConfig } from "@hermes/core";
import { db } from "@hermes/db";
import { sql } from "drizzle-orm";
import { swapRouter } from "./swap/router.js";
import { liveWallet } from "./wallet.js";
import { chamberExit, fireChambered } from "./presigned.js";

const WSOL = "So11111111111111111111111111111111111111112";
const TICKET_USD = 2.5;
const DRILL_POSITION_ID = 990_001; // synthetic id — the module doesn't care

const step = (n: number, m: string) => console.log(`\n━━ DRILL ${n} ── ${m}`);
const ok = (m: string) => console.log(`   ✔ ${m}`);
const info = (m: string) => console.log(`   · ${m}`);

(async () => {
  const cfg = loadConfig();
  const wallet = liveWallet();
  if (!wallet) throw new Error("no wallet");
  const conn = new Connection(cfg.rpcUrls[0]!, "confirmed");
  console.log(`MEMECOIN SNIPER DRILL — production module under test`);

  step(1, "target selection — deepest active pool ≥ $20k, seen in the last 30 min");
  const [target] = (await db.execute(sql`
    SELECT ct.mint, coalesce(t.symbol,'?') sym, t.dex, ct.liquidity_usd::float liq
    FROM candidate_ticks ct JOIN tokens t USING (mint)
    WHERE ct.snapped_at > now() - interval '90 seconds' AND ct.liquidity_usd::float >= 20000
      AND t.first_seen_at > now() - interval '30 minutes'
    ORDER BY ct.liquidity_usd DESC LIMIT 1`)) as unknown as { mint: string; sym: string; dex: string; liq: number }[];
  if (!target) throw new Error("no active candidate ≥$20k in the last 30min — rerun when the tape offers one");
  ok(`target: ${target.sym} (${target.mint.slice(0, 8)}…) on ${target.dex}, pool $${Math.round(target.liq).toLocaleString()}`);

  step(2, `the ticket — buy $${TICKET_USD} via the live router`);
  const solQ = await swapRouter.quote(cfg, WSOL, target.mint, 1_000_000_000n, 300); // probe 1 SOL for route sanity
  info(`route: ${solQ.provider}`);
  const solUsd = 183; // approximation is fine for a drill ticket; ±10% only changes ticket size cents
  const lamports = BigInt(Math.floor((TICKET_USD / solUsd) * 1e9));
  const buyQ = await swapRouter.quote(cfg, WSOL, target.mint, lamports, cfg.LIVE_SLIPPAGE_BPS);
  const b64 = await swapRouter.buildSwapTx(cfg, buyQ, wallet.publicKey.toBase58());
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  tx.sign([wallet]);
  const t0 = Date.now();
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
  for (;;) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error(`buy failed: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") break;
    if (Date.now() - t0 > 60_000) throw new Error("buy unconfirmed 60s");
    await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1_000));
  }
  ok(`ticket filled via ${buyQ.provider} in ${Date.now() - t0}ms (tx ${sig.slice(0, 8)}…)`);

  step(3, "chamber through the PRODUCTION module (nonce pool, surgery, sign, store)");
  const tC = Date.now();
  const chambered = await chamberExit(cfg, DRILL_POSITION_ID, target.mint);
  if (!chambered) throw new Error("chamberExit returned false — see module warning above");
  ok(`round chambered in ${Date.now() - tC}ms — waiting 20s past blockhash death…`);
  await new Promise((r) => setTimeout(r, 20_000));

  step(4, "fire through the PRODUCTION module");
  const fired = await fireChambered(cfg, DRILL_POSITION_ID);
  if (!fired) throw new Error("fireChambered missed — fallback would engage in production; drill FAILS its bar");
  ok(`FIRED AND SETTLED in ${fired.landMs}ms via ${fired.provider} (tx ${fired.signature.slice(0, 8)}…)`);

  console.log(`\n━━ DRILL COMPLETE — the production sniper works on memecoin routes ━━`);
  process.exit(0);
})().catch((err) => {
  console.error(`\n✗ DRILL HALTED: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
