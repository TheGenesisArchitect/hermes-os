/**
 * TRAIL REPLAY — validate the gain-based trail against the LEGACY %-of-price trail
 * over the REAL tick paths (position_ticks), across the FULL population (winners
 * AND rugs), before it touches live. Same TP ladder in both modes, so this isolates
 * exactly one lever: how the remainder rides. Reports net P&L old vs new, split by
 * outcome so we see the effect on winners and the rug tape separately.
 *   pnpm --filter @hermes/trader exec tsx src/trail-replay.ts [hours]
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
loadEnv({ path: resolve(import.meta.dirname, "../../../.env") });
import { loadConfig, convexSlippagePct, type TokenMarket } from "@hermes/core";
import { db, positions, positionTicks, tokens } from "@hermes/db";
import { and, asc, eq, gte, sql } from "drizzle-orm";
import { decideExit } from "./paper.js";

const FEE_PCT = 0.25;
const FIXED_FEE_USD = 0.02;
const cfg = loadConfig();
const HOURS = Number(process.argv[2] ?? 48);
const n = (v: unknown) => Number(v ?? 0);

interface Tick {
  price: number; liq: number; volM5: number; volH1: number; buys: number; sells: number;
  ageMin: number; regime: string | null; action: string | null;
}

function marketFrom(t: Tick, dex: string | null): TokenMarket {
  return {
    priceUsd: t.price, liquidityUsd: t.liq, fdvUsd: 0, pairAddress: "", dexId: dex ?? "",
    labels: [], symbol: null, name: null, pairAgeMinutes: t.ageMin,
    volUsd: { m5: t.volM5, h1: t.volH1, h24: 0 },
    txns: { m5: { buys: t.buys, sells: t.sells }, h1: { buys: 0, sells: 0 }, h24: { buys: 0, sells: 0 } },
    priceChangePct: { m5: 0, h1: 0, h24: 0 },
  };
}

/** Simulate the full exit engine over one position's tick path in the given mode. */
function simulate(
  mode: "price" | "gain",
  pos: { entry: number; sizeUsd: number; qtyTokens: number; openedAt: Date; triggerMult: number; dex: string | null },
  ticks: Tick[],
): number {
  cfg.TRAIL_MODE = mode;
  let qtyRemaining = pos.qtyTokens;
  let proceeds = 0;
  let peakPrice = pos.entry;
  let lastHighIdx = 0;
  const posRow = {
    entryPriceUsd: String(pos.entry), sizeUsd: String(pos.sizeUsd), qtyTokens: String(pos.qtyTokens),
    qtyRemaining: String(qtyRemaining), openedAt: pos.openedAt, triggerMult: String(pos.triggerMult),
  } as unknown as Parameters<typeof decideExit>[1];
  let lastPrice = pos.entry;
  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i]!;
    lastPrice = t.price;
    if (t.price > peakPrice) { peakPrice = t.price; lastHighIdx = i; }
    const market = marketFrom(t, pos.dex);
    const call = { action: t.action, regime: t.regime, ticksSinceNewHigh: i - lastHighIdx } as unknown as Parameters<typeof decideExit>[4];
    (posRow as unknown as { qtyRemaining: string }).qtyRemaining = String(qtyRemaining);
    const decision = decideExit(cfg, posRow, market, peakPrice, call);
    if (!decision) continue;
    const sellQty = qtyRemaining * decision.fraction;
    if (sellQty <= 0) continue;
    const gross = sellQty * t.price;
    const slip = convexSlippagePct(gross, t.liq);
    const exitPrice = t.price * (1 - slip / 100);
    proceeds += sellQty * exitPrice - ((sellQty * exitPrice * FEE_PCT) / 100 + FIXED_FEE_USD);
    qtyRemaining -= sellQty;
    if (decision.fraction >= 0.999 || qtyRemaining <= pos.qtyTokens * 1e-4) { qtyRemaining = 0; break; }
  }
  // Anything still held at the end of the recorded path closes at the last mark.
  if (qtyRemaining > 0) {
    const gross = qtyRemaining * lastPrice;
    const slip = convexSlippagePct(gross, ticks[ticks.length - 1]?.liq ?? 0);
    proceeds += qtyRemaining * lastPrice * (1 - slip / 100) - ((gross * FEE_PCT) / 100 + FIXED_FEE_USD);
  }
  return proceeds - pos.sizeUsd; // realized P&L
}

async function main() {
  // SANITY: does the mode actually change the trail stop? (synthetic armed pos, peak 1.4×)
  const synthPos = { entryPriceUsd: "1", sizeUsd: "5", qtyTokens: "100", qtyRemaining: "100", openedAt: new Date(Date.now() - 600000), triggerMult: "1" } as unknown as Parameters<typeof decideExit>[1];
  const synthMkt = marketFrom({ price: 1.25, liq: 30000, volM5: 100, volH1: 500, buys: 5, sells: 3, ageMin: 10, regime: "RUNNER", action: "HOLD" }, "pumpswap");
  const synthCall = { action: "HOLD", regime: "RUNNER", ticksSinceNewHigh: 1 } as unknown as Parameters<typeof decideExit>[4];
  for (const m of ["price", "gain"] as const) {
    cfg.TRAIL_MODE = m;
    const d = decideExit(cfg, synthPos, synthMkt, 1.4, synthCall);
    console.log(`  sanity[${m}]: at price 1.25 peak 1.4× → ${d ? d.reason + " frac " + d.fraction.toFixed(2) : "HOLD"}  (gain floor ${(1 + (1 - cfg.TRAIL_GAIN_GB_TIGHT) * 0.4).toFixed(3)})`);
  }

  const posRows = await db
    .select({
      id: positions.id, entry: positions.entryPriceUsd, sizeUsd: positions.sizeUsd,
      qtyTokens: positions.qtyTokens, openedAt: positions.openedAt, triggerMult: positions.triggerMult,
      peak: positions.peakPriceUsd, dex: tokens.dex,
    })
    .from(positions)
    .leftJoin(tokens, eq(tokens.mint, positions.mint))
    .where(and(eq(positions.lane, "paper"), eq(positions.status, "closed"), gte(positions.closedAt, sql`now() - make_interval(hours => ${HOURS})`)));

  let nPos = 0, oldTot = 0, newTot = 0;
  const bucket = { winOld: 0, winNew: 0, winN: 0, rugOld: 0, rugNew: 0, rugN: 0, flatOld: 0, flatNew: 0, flatN: 0 };
  for (const p of posRows) {
    const entry = n(p.entry);
    if (entry <= 0 || n(p.qtyTokens) <= 0) continue;
    const rawTicks = await db
      .select().from(positionTicks).where(eq(positionTicks.positionId, p.id)).orderBy(asc(positionTicks.ageMinutes), asc(positionTicks.id));
    if (rawTicks.length < 2) continue;
    const ticks: Tick[] = rawTicks.map((r) => ({
      price: n(r.priceUsd), liq: n(r.liquidityUsd), volM5: n(r.volM5), volH1: n(r.volH1),
      buys: n(r.buysM5), sells: n(r.sellsM5), ageMin: n(r.ageMinutes), regime: r.regime, action: r.action,
    }));
    const pos = { entry, sizeUsd: n(p.sizeUsd), qtyTokens: n(p.qtyTokens), openedAt: p.openedAt, triggerMult: n(p.triggerMult), dex: p.dex };
    const oldPnl = simulate("price", pos, ticks);
    const newPnl = simulate("gain", pos, ticks);
    nPos++; oldTot += oldPnl; newTot += newPnl;
    const peakMult = entry > 0 ? n(p.peak) / entry : 1;
    if (peakMult >= 1.5) { bucket.winOld += oldPnl; bucket.winNew += newPnl; bucket.winN++; }
    else if (peakMult < 1.1) { bucket.rugOld += oldPnl; bucket.rugNew += newPnl; bucket.rugN++; }
    else { bucket.flatOld += oldPnl; bucket.flatNew += newPnl; bucket.flatN++; }
  }

  const f = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(2);
  console.log(`\n═══ TRAIL REPLAY — ${nPos} positions, last ${HOURS}h ═══`);
  console.log(`ALL          old $${f(oldTot)}   →  gain $${f(newTot)}   Δ ${f(newTot - oldTot)}`);
  console.log(`winners ≥1.5× (${bucket.winN})  old $${f(bucket.winOld)}  →  gain $${f(bucket.winNew)}  Δ ${f(bucket.winNew - bucket.winOld)}`);
  console.log(`rugs <1.1×    (${bucket.rugN})  old $${f(bucket.rugOld)}  →  gain $${f(bucket.rugNew)}  Δ ${f(bucket.rugNew - bucket.rugOld)}`);
  console.log(`flat 1.1-1.5× (${bucket.flatN})  old $${f(bucket.flatOld)}  →  gain $${f(bucket.flatNew)}  Δ ${f(bucket.flatNew - bucket.flatOld)}`);
  console.log(`\nVERDICT: gain trail is ${newTot > oldTot ? "NET POSITIVE ✅" : "NET NEGATIVE ❌"} (Δ ${f(newTot - oldTot)} over ${nPos} positions)`);
  process.exit(0);
}
main();
