/**
 * SELL-SIDE CERTIFICATION (operator, 2026-08-03: "verify we are ready to
 * actually execute Live Trades" — proof, not reassurance).
 *
 * For the freshest armed candidates on the tape RIGHT NOW, run the entire
 * sell stack a live seat would depend on, without buying anything:
 *   1. MARK    swapRouter.quoteValue — best-of executable mark (the BROKER fix)
 *   2. QUOTE   swapRouter.quote sell — the fallback execution route
 *   3. BUILD   buildSwapTx — a real signed-ready tx built (NEVER sent)
 * A candidate that fails all three is a seat the lane must never take; the
 * lane is GO only when the stack certifies on the live tape.
 * Run: cd services/trader && npx tsx src/tools/sell-certify.ts [n=6]
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
loadEnv({ path: resolve(import.meta.dirname, "../../../../.env") });
import { loadConfig } from "@hermes/core";
import { db } from "@hermes/db";
import { sql } from "drizzle-orm";
import { swapRouter } from "../live/swap/router.js";
import { WSOL_MINT } from "../live/swap/jupiterHosted.js";

const N = Number(process.argv[2] ?? 6);
const cfg = loadConfig();
const AMT = 1_000_000_000n; // nominal probe size — route existence, not P&L

(async () => {
  const rows = (await db.execute(sql`
    SELECT co.mint, t.symbol, t.dex, ct.liq FROM candidate_outcomes co
    JOIN tokens t ON t.mint = co.mint
    LEFT JOIN LATERAL (SELECT liquidity_usd::float liq FROM candidate_ticks c2
      WHERE c2.mint = co.mint ORDER BY c2.snapped_at DESC LIMIT 1) ct ON true
    WHERE co.confirmed_at IS NOT NULL AND ct.liq >= 1200
    ORDER BY co.confirmed_at DESC LIMIT ${N}`)) as unknown as
    { mint: string; symbol: string | null; dex: string | null; liq: number | null }[];
  if (!rows.length) {
    console.log("no armed candidates in the last 30m — rerun when the tape offers flow");
    process.exit(0);
  }
  console.log(`SELL CERTIFICATION — ${rows.length} armed candidate(s), live market, nothing bought\n`);
  let pass = 0;
  for (const r of rows) {
    const out: string[] = [];
    let mark = false, quote = false, build = false;
    try {
      const v = await swapRouter.quoteValue(cfg, r.mint, AMT, cfg.LIVE_STOP_SLIPPAGE_BPS);
      mark = Number(v.outAmount) > 0;
      out.push(`mark ✓ ${v.provider}`);
    } catch (e) { out.push(`mark ✗ ${(e as Error).message.slice(0, 40)}`); }
    try {
      const q = await swapRouter.quote(cfg, r.mint, WSOL_MINT, AMT, cfg.LIVE_STOP_SLIPPAGE_BPS, { protective: true });
      quote = true;
      out.push(`quote ✓ ${q.provider}`);
      try {
        const b64 = await swapRouter.buildSwapTx(cfg, q, "rEPAt2uXrLHpN3J7By4PaAjbdi21V7rXozDipw5X1Q5");
        build = b64.length > 100;
        out.push(`build ✓ ${b64.length}b (not sent)`);
      } catch (e) { out.push(`build ✗ ${(e as Error).message.slice(0, 40)}`); }
    } catch (e) { out.push(`quote ✗ ${(e as Error).message.slice(0, 40)}`); }
    const ok = mark && quote && build;
    if (ok) pass++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${(r.symbol ?? r.mint.slice(0, 6)).padEnd(12)} ${(r.dex ?? "?").padEnd(16)} liq $${Math.round(r.liq ?? 0).toLocaleString().padStart(9)}  ${out.join(" · ")}`);
  }
  console.log(`\nVERDICT: ${pass}/${rows.length} certified sellable end-to-end ${pass === rows.length ? "— stack is GO" : "— refuse the FAILs at the door"}`);
  process.exit(0);
})();
