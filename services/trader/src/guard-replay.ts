/**
 * Validation of the two-layer feed-coherence guard, using the REAL classifyMark()
 * and the exact managePositions state machine (counter + last-good baseline that
 * a HOLD tick carries forward). Gates before restart:
 *   A. Layer 1 — Jupiter-vs-DexScreener divergence rejects the bad feed.
 *   B. The REAL pos-29 trajectory (all 35 ticks incl. the TWO-poll $9e-9 garbage
 *      that defeated the old temporal fix) → must HOLD and NEVER sell.
 *   C. A SYNTHETIC real rug (price AND liquidity crater ≥2 polls) → must EXIT by
 *      the confirm window. Synthetic because no real rug exists in our data.
 * Run: pnpm --filter @hermes/trader exec tsx src/guard-replay.ts
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
loadEnv({ path: resolve(import.meta.dirname, "../../../.env") });
import { loadConfig } from "@hermes/core";
import { classifyMark } from "./paper.js";

const cfg = loadConfig();
let failures = 0;
const assert = (cond: boolean, msg: string) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures++;
};

// --- A. Layer 1: Jupiter override divergence ---
console.log("\nA. Jupiter-vs-DexScreener divergence (Layer 1):");
const rejects = (jp: number, dex: number) =>
  dex > 0 && (jp > dex * cfg.MARK_FEED_DIVERGENCE || jp < dex / cfg.MARK_FEED_DIVERGENCE);
assert(rejects(9.067e-9, 5.7066), "pos-29 tick: Jupiter $9e-9 vs DexScreener $5.70 → REJECT Jupiter");
assert(!rejects(5.75, 5.7066), "normal: Jupiter $5.75 vs DexScreener $5.70 → accept (fresher mark)");
assert(!rejects(6.5, 5.7066), "fast move: Jupiter $6.50 vs DexScreener $5.70 (1.14x) → accept");

/**
 * Replay a raw [price, liquidity] stream through the exact guard state machine.
 * Returns whether an EXIT (honored crash) ever fired.
 */
function replay(name: string, entry: number, stream: Array<[number, number]>): boolean {
  let count = 0;
  let lastGood = entry;
  let lastGoodLiq = stream[0]?.[1] ?? 0;
  let exited = false;
  const log: string[] = [];
  for (let i = 0; i < stream.length && !exited; i++) {
    const row = stream[i];
    if (!row) continue;
    const [price, liq] = row;
    const v = classifyMark(cfg, price, liq, lastGood, lastGoodLiq);
    if (v.kind === "garbage") {
      count = 0; // never accrues; baseline held
      log.push(`  t${i}: $${price} liq $${liq} → HOLD garbage (${v.why}); baseline $${lastGood}`);
      continue;
    }
    if (v.kind === "crash") {
      count += 1;
      if (count < cfg.MARK_CONFIRM_TICKS) {
        log.push(`  t${i}: $${price} liq $${liq} → HOLD crash-confirm ${count}/${cfg.MARK_CONFIRM_TICKS}`);
        continue; // baseline held
      }
      log.push(`  t${i}: $${price} liq $${liq} → HONOR crash → EXIT`);
      exited = true;
      break;
    }
    // ok → process, baseline advances, counter resets
    count = 0;
    lastGood = price;
    lastGoodLiq = liq;
  }
  console.log(`\n${name}:`);
  console.log(log.join("\n"));
  console.log(`  → exited=${exited}, final baseline $${lastGood}`);
  return exited;
}

// --- B. REAL pos-29 trajectory (35 ticks; ticks 34-35 are the raw garbage) ---
const pos29: Array<[number, number]> = [
  [5.002649271467829, 171208], [5.0223256409505606, 171208], [5.037455247670791, 172615],
  [5.056543622367707, 172615], [5.0702133122420765, 172615], [5.099501880371838, 172615],
  [5.1143203012502525, 172615], [5.1349705039562705, 172615], [5.150592833188512, 174260],
  [5.172279103142169, 174260], [5.198351268379533, 174260], [5.213227977469989, 174260],
  [5.268322882004053, 174260], [5.282959627071195, 174260], [5.3173173653090835, 176310],
  [5.328189510234931, 176310], [5.342688723560214, 176310], [5.362604901795384, 176310],
  [5.3786046885239545, 176310], [5.4111887896383895, 176310], [5.424781553357954, 178399],
  [5.442919496995565, 178399], [5.462314365701543, 178399], [5.535235620220378, 178399],
  [5.562065772039818, 178399], [5.5875452726751424, 180505], [5.5875452726751424, 180505],
  [5.6186273713893815, 180505], [5.624906375748693, 180505], [5.640195710797532, 180505],
  [5.678746834885941, 180505], [5.692666991614175, 183024], [5.706635356617944, 183024],
  [2.337239910882156e-8, 183024], // tick 34 — raw garbage #1 (liq intact)
  [9.066850449026005e-9, 183024], // tick 35 — raw garbage #2 (liq STILL intact) — killed the old fix
];
const pos29Exited = replay("B. REAL pos-29 — price craters, liq INTACT (must NEVER exit)", 5.004, pos29);

// --- B2. REAL C2i9r9 dust-flip: price AND liquidity both crater to a $5 pool.
// This is the hole the pure-coherence guard missed — both feeds drop together so
// it looked like a "coherent crash" and sold at ~$0 for −$17.46. The dust floor
// must now HOLD it (liq $5 << $1000 = untradeable, price is fiction). ---
const c2i9r9: Array<[number, number]> = [
  [8.381, 220785], [8.394, 222663], [8.283, 222663], [8.280, 222663], [8.280, 222663],
  [2.981e-7, 5], // dust flip #1 — empty pool
  [2.981e-7, 5], // dust flip #2 — persists (defeated the old 2-tick confirm)
  [3.0e-7, 5], // dust flip #3
];
const c2Exited = replay("B2. REAL C2i9r9 dust-flip liq $5 (must NEVER exit)", 5.107, c2i9r9);

// --- C. SYNTHETIC real dump WITH tradeable liquidity: price and liq both fall
// ~25x but the pool stays above the dust floor ($1200-1600). There is real
// liquidity to sell into, so this IS a crash we should honor after confirm. ---
const dump: Array<[number, number]> = [
  [5.0, 40000], [5.1, 40500], [5.05, 40200],
  [0.20, 1600], // coherent drop, liq still tradeable → crash confirm 1/2
  [0.15, 1400], // still down → honor → exit
  [0.10, 1200],
];
const dumpExited = replay("C. SYNTHETIC real dump, liq stays >$1k (must EXIT by confirm window)", 5.0, dump);

// --- D. SYNTHETIC dust-crater rug: liq collapses below the floor. At the
// classifyMark layer this HOLDS (untradeable) — the loss is booked by the no-pair
// writeoff or the max-hold backstop, both outside classifyMark's scope. ---
const dustRug: Array<[number, number]> = [
  [5.0, 40000], [5.1, 40500],
  [0.02, 15], [0.015, 12], [0.01, 10], // all dust → HOLD every tick
];
const dustRugExited = replay("D. SYNTHETIC dust-rug liq <$1k (HOLD here; booked by no-pair/max-hold)", 5.0, dustRug);

console.log("\n=== GATES ===");
assert(!pos29Exited, "B. pos-29 (price craters, liq intact) held, never sold");
assert(!c2Exited, "B2. C2i9r9 dust-flip (liq $5) held, never sold — the bug that cost -$260");
assert(dumpExited, "C. real dump WITH tradeable liquidity still exits by the confirm window");
assert(!dustRugExited, "D. dust-crater rug holds at classifyMark (booked by no-pair/max-hold instead)");
console.log(`\n${failures === 0 ? "ALL GATES PASS" : failures + " GATE(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
