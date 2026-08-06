/**
 * ROUTER + OPTIMIZER INVARIANTS — the QTEA-003/007/008 corrections and the
 * self-optimization governance, pinned with fake providers (the SwapRouter
 * constructor takes an injected provider list for exactly this).
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { SwapRouter } from "../src/live/swap/router.js";
import { NoRouteError, type SwapProvider, type SwapQuote } from "../src/live/swap/provider.js";
import { proposeManifest } from "../src/live/optimizer.js";
import type { FormulaManifest } from "../src/live/manifest.js";

const WSOL = "So11111111111111111111111111111111111111112";
const MINT = "TokenMint111111111111111111111111111111111";
const CFG = {} as never;

function fake(
  name: string,
  behave: (inputMint: string, outputMint: string) => SwapQuote,
  opts?: { failTimes?: { buy?: number; sell?: number }; canValue?: boolean; sellValue?: string },
): SwapProvider & { calls: string[] } {
  const state = { buyFails: opts?.failTimes?.buy ?? 0, sellFails: opts?.failTimes?.sell ?? 0 };
  const p: SwapProvider & { calls: string[] } = {
    name,
    calls: [],
    async quote(_cfg, inputMint, outputMint) {
      const side = outputMint === WSOL ? "sell" : "buy";
      p.calls.push(`quote:${side}`);
      if (side === "buy" && state.buyFails > 0) { state.buyFails--; throw new Error(`${name} buy down`); }
      if (side === "sell" && state.sellFails > 0) { state.sellFails--; throw new Error(`${name} sell down`); }
      const q = behave(inputMint, outputMint);
      return opts?.canValue === false ? { ...q, canValue: false } : q;
    },
    async buildSwapTx() { return "b64"; },
  };
  if (opts?.sellValue) {
    p.quoteSellValue = async (_cfg, mint, amountRaw) => {
      p.calls.push("sellValue");
      return { inputMint: mint, outputMint: WSOL, inAmount: String(amountRaw), outAmount: opts.sellValue!, priceImpactPct: "0.01", provider: name, raw: null, canValue: true };
    };
  }
  return p;
}
const q = (name: string, out = "1000"): ((i: string, o: string) => SwapQuote) =>
  (inputMint, outputMint) => ({ inputMint, outputMint, inAmount: "1", outAmount: out, priceImpactPct: "0.01", provider: name, raw: null });

describe("QTEA-007 side-scoped breakers", () => {
  it("three buy-path failures do NOT suppress the provider's sell side", async () => {
    const a = fake("alpha", q("alpha"), { failTimes: { buy: 3 } });
    const b = fake("beta", q("beta"));
    const r = new SwapRouter([a, b]);
    for (let i = 0; i < 3; i++) await r.quote(CFG, WSOL, MINT, 1n, 100); // buys: alpha fails ×3 → buy breaker OPEN
    const buy = await r.quote(CFG, WSOL, MINT, 1n, 100);
    assert.equal(buy.provider, "beta", "alpha's BUY side must be open (skipped)");
    const sell = await r.quote(CFG, MINT, WSOL, 1n, 100);
    assert.equal(sell.provider, "alpha", "alpha's SELL side must still route — the sides trip apart");
  });

  it("a protective sell walks past an OPEN sell-side breaker", async () => {
    const a = fake("alpha", q("alpha"), { failTimes: { sell: 3 } });
    const b = fake("beta", q("beta"));
    const r = new SwapRouter([a, b]);
    for (let i = 0; i < 3; i++) await r.quote(CFG, MINT, WSOL, 1n, 100); // alpha sell breaker OPEN (beta filled them)
    const ordinary = await r.quote(CFG, MINT, WSOL, 1n, 100);
    assert.equal(ordinary.provider, "beta", "ordinary sell respects the open breaker");
    const protective = await r.quote(CFG, MINT, WSOL, 1n, 100, { protective: true });
    assert.equal(protective.provider, "alpha", "protective walks past the open breaker and alpha now answers");
  });
});

describe("QTEA-003 read-only valuation walk", () => {
  it("skips build-only quotes and falls to reserve-math sellValue", async () => {
    const buildOnly = fake("direct", q("direct"), { canValue: false, sellValue: "555" });
    const r = new SwapRouter([buildOnly]);
    const v = await r.quoteValue(CFG, MINT, 1n, 100);
    assert.equal(v.outAmount, "555", "the mark must come from quoteSellValue, not the build-only quote");
  });

  it("never mutates lastRoute and never trips a breaker", async () => {
    const a = fake("alpha", q("alpha"));
    const r = new SwapRouter([a]);
    await r.quote(CFG, MINT, WSOL, 1n, 100);
    assert.equal(r.lastRoute(), "alpha");
    const failing = fake("omega", q("omega"), { failTimes: { sell: 99 } });
    const r2 = new SwapRouter([failing, a]);
    await r2.quote(CFG, MINT, WSOL, 1n, 100); // sets lastRoute (alpha; omega fails once)
    const before = r2.lastRoute();
    for (let i = 0; i < 5; i++) await r2.quoteValue(CFG, MINT, 1n, 100).catch(() => {});
    assert.equal(r2.lastRoute(), before, "valuation must not move lastRoute");
    // omega failed 1 (execution) + 5 (valuation) times; valuation must not have
    // contributed to the breaker: two MORE execution failures are needed to trip.
    const sell = await r2.quote(CFG, MINT, WSOL, 1n, 100);
    assert.equal(sell.provider, "alpha");
    const health = r2.providerHealth().find((h) => h.name === "omega");
    assert.equal(health?.healthy, true, "5 valuation failures must not open omega's breaker");
  });
});

describe("QTEA-008 best-sell routing", () => {
  it("takes the higher outAmount of two parallel quotes", async () => {
    const low = fake("low", q("low", "100"));
    const high = fake("high", q("high", "900"));
    const r = new SwapRouter([low, high]);
    const best = await r.quoteBestSell(CFG, MINT, 1n, 100);
    assert.equal(best.provider, "high");
    assert.equal(best.outAmount, "900");
  });

  it("falls back to the ordered walk when the parallel pair is empty", async () => {
    const a = fake("alpha", q("alpha"), { failTimes: { sell: 1 } });
    const r = new SwapRouter([a]);
    const got = await r.quoteBestSell(CFG, MINT, 1n, 100); // parallel attempt fails once, walk retries
    assert.equal(got.provider, "alpha");
  });
});

describe("optimizer governance (L1 — propose, never apply)", () => {
  const ACTIVE: FormulaManifest = {
    version: 2,
    ratifiedAt: "2026-08-02",
    genomes: { BASE: 1.5, RISER: 0.6 },
    elite: { venues: ["pumpswap"] },
    filler: { venues: ["pumpswap"] },
  };

  it("a genome turning negative on the rolling tape becomes a DROP delta", () => {
    const { proposal, material } = proposeManifest(ACTIVE, {
      BASE: { n: 100, adjEv: 300, evPerTrade: 3 },
      RISER: { n: 80, adjEv: -40, evPerTrade: -0.5 },
    });
    assert.equal(material, true);
    assert.ok(proposal.deltas.some((d) => d.startsWith("DROP RISER")));
  });

  it("a new positive genome becomes an ADD delta; under-powered stays silent", () => {
    const { proposal } = proposeManifest(ACTIVE, {
      BASE: { n: 100, adjEv: 300, evPerTrade: 3 },
      MOON_SLOW: { n: 60, adjEv: 90, evPerTrade: 1.5 },
      CLIMBER: { n: 5, adjEv: 50, evPerTrade: 10 },
    });
    assert.ok(proposal.deltas.some((d) => d.startsWith("ADD MOON_SLOW")));
    assert.ok(!proposal.deltas.some((d) => d.includes("CLIMBER")), "n=5 cannot propose anything");
  });

  it("an unchanged book proposes nothing", () => {
    // BASE alone: mean EV = its own EV → weight 1.0? No — clamped relative to
    // itself gives 1.0, active is 1.5 → delta 0.5 IS material. Use two genomes
    // whose relative weights reproduce the active manifest exactly.
    const { material } = proposeManifest(ACTIVE, {
      BASE: { n: 100, adjEv: 300, evPerTrade: 3.0 },
      RISER: { n: 0, adjEv: 0, evPerTrade: 0 }, // insufficient-n → no delta
    });
    // BASE: mean of promoted = 3.0 → weight 1.0 vs active 1.5 → REWEIGHT fires.
    // That is correct behaviour: a one-genome book SHOULD renormalize. So the
    // "no material delta" case is the reweight landing inside the threshold:
    const res2 = proposeManifest(
      { ...ACTIVE, genomes: { BASE: 1.0 } },
      { BASE: { n: 100, adjEv: 300, evPerTrade: 3.0 } },
    );
    assert.equal(res2.material, false, "weight already at the recomputed value → silence");
  });
});

// ─── MODEL RISK MANAGEMENT ───────────────────────────────────────────────────
// INVARIANT (operator review, 2026-08-02): under a MAJOR regime shift the
// optimizer proposes retreat only — "the market has changed, I am no longer
// confident" — never promotions fitted to the regime that just ended.
describe("model risk — PSI drift guard", () => {
  it("identical distributions score ~0; a hard shift scores major", async () => {
    const { psi } = await import("../src/live/optimizer.js");
    assert.ok(psi([50, 30, 20], [50, 30, 20]) < 1e-9);
    assert.ok(psi([50, 30, 20], [48, 32, 20]) < 0.1, "small drift stays under moderate");
    assert.ok(psi([80, 15, 5], [10, 30, 60]) > 0.25, "an inverted mix is a major shift");
  });

  it("empty windows are not evidence of drift", async () => {
    const { psi } = await import("../src/live/optimizer.js");
    assert.equal(psi([0, 0, 0], [10, 20, 30]), 0);
    assert.equal(psi([], []), 0);
  });

  it("major drift withholds ADD/REWEIGHT and keeps DROP", async () => {
    const { applyDriftGate } = await import("../src/live/optimizer.js");
    const deltas = [
      "ADD MOON_SLOW — adjEV $90 over n=60 (not in active manifest)",
      "REWEIGHT BASE ×1.5 → ×1.0 (adjEV/t $2.00, n=100)",
      "DROP RISER — adjEV $-40.00 over n=80 (active weight ×0.6)",
    ];
    const major = applyDriftGate(deltas, { perFeature: {}, max: 0.4, verdict: "major" });
    assert.deepEqual(major.deltas, ["DROP RISER — adjEV $-40.00 over n=80 (active weight ×0.6)"]);
    assert.equal(major.withheld.length, 2);
    const stable = applyDriftGate(deltas, { perFeature: {}, max: 0.05, verdict: "stable" });
    assert.deepEqual(stable.deltas, deltas, "stable regime passes everything through");
    assert.equal(stable.withheld.length, 0);
  });
});

// ─── THE MARKET TRUTH ENGINE ─────────────────────────────────────────────────
// BINDING INVARIANT (tech spec v2 §3, board demand): every evaluation answers
// "could the manager have known this yet?" — the same functions serve the live
// manager AND the replay engine, so look-ahead bias is structurally impossible.
describe("market truth — the look-ahead invariant", () => {
  const T = (at: number, priceUsd: number, liquidityUsd = 20_000) => ({ at, priceUsd, liquidityUsd });
  const tape = [T(1000, 1.0), T(2000, 1.16), T(3000, 1.04), T(4000, 1.30)];

  it("a spike AFTER the evaluation point is invisible", async () => {
    const { highWaterCrossing } = await import("@hermes/core");
    // evaluating at t=1500: only the t=1000 tick is known; the 1.16 spike hasn't happened
    assert.equal(highWaterCrossing(tape, 1.0, 1.15, 1500), null);
  });

  it("a spike BEFORE the evaluation point arms, and fills 2 ticks later", async () => {
    const { highWaterCrossing } = await import("@hermes/core");
    const r = highWaterCrossing(tape, 1.0, 1.15, 5000);
    assert.ok(r, "the 1.16 crossing must arm once known");
    assert.equal(r!.crossed.priceUsd, 1.16, "crossing is the first tick at/above the barrier");
    assert.equal(r!.fill.priceUsd, 1.30, "fill is 2 ticks later — recognition is not instant execution");
    assert.equal(r!.maxExcursion, 1.3);
  });

  it("a tick exactly AT the evaluation timestamp is not yet known (ties)", async () => {
    const { recognizable } = await import("@hermes/core");
    assert.deepEqual(recognizable(tape, 2000).map((t) => t.priceUsd), [1.0]);
  });

  it("untrusted prints cannot arm: thin pool, or a >3x single-tick jump", async () => {
    const { armable, highWaterCrossing } = await import("@hermes/core");
    assert.equal(armable(T(1, 1.2, 500), "recorder", 1.0), false, "sub-$1k pool");
    assert.equal(armable(T(1, 99, 20_000), "recorder", 1.0), false, "16,913x-class phantom");
    assert.equal(armable(T(1, 1.2, 20_000), "recorder", 1.0), true);
    const phantom = [T(1000, 1.0), T(2000, 50, 800)]; // dust-pool phantom above the barrier
    assert.equal(highWaterCrossing(phantom, 1.0, 1.15, 9000), null, "phantom must never arm a rung");
  });

  it("quorum: the freshest confident source wins; one dark feed never blinds", async () => {
    const { canonicalMark } = await import("@hermes/core");
    const now = 10_000;
    const q = canonicalMark({ recorder: T(9_500, 1.10), aggregator: T(9_000, 1.09) }, now);
    assert.equal(q!.source, "recorder");
    // executable is the transactable price — it outranks at equal freshness
    const q2 = canonicalMark({ recorder: T(9_500, 1.10), executable: T(9_500, 1.11) }, now);
    assert.equal(q2!.source, "executable");
    assert.equal(q2!.confidence, 1.0);
    // aggregator alone still produces truth (no HOLD-ALL from one source dying)
    assert.equal(canonicalMark({ aggregator: T(9_900, 1.05) }, now)!.source, "aggregator");
    // everything stale → no truth (quorum loss is the only blindness)
    assert.equal(canonicalMark({ recorder: T(100, 1.0) }, 100_000), null); // 99.9s old > 30s window
  });

  it("truth agreement scores feed drift", async () => {
    const { truthAgreement } = await import("@hermes/core");
    assert.equal(truthAgreement(T(1, 1.0), T(1, 1.0)), 1);
    assert.equal(truthAgreement(T(1, 1.0), T(1, 0.5)), 0.5);
    assert.equal(truthAgreement(T(1, 1.0), undefined), null);
  });
});

// ─── F2: HIGH-WATER RUNG EVALUATION ──────────────────────────────────────────
// THE CAPTURE FIX (tech spec v2 §2). Rungs must arm on the maximum excursion
// the tape recorded between polls — the market DID trade there — while the
// FILL still takes the live price, and protective exits never see the
// excursion at all.
describe("F2 high-water rung evaluation", () => {
  const T = (at: number, priceUsd: number, liquidityUsd = 20_000) => ({ at, priceUsd, liquidityUsd });

  it("arms a rung the manager's polls stepped over (the 74%-miss defect)", async () => {
    const { highWaterCrossing } = await import("@hermes/core");
    // poll at t=1000 saw 1.02x; poll at t=4000 saw 1.03x; the tape holds 1.19x
    // in between — the incumbent banks nothing, F2 banks the rung.
    const tape = [T(1000, 1.02), T(2000, 1.19), T(3000, 1.05), T(4000, 1.03)];
    const r = highWaterCrossing(tape, 1.0, 1.15, 9000);
    assert.ok(r, "the between-poll crossing must arm");
    assert.equal(r!.crossed.priceUsd, 1.19);
  });

  it("the fill price is never the excursion price", async () => {
    const { highWaterCrossing } = await import("@hermes/core");
    const tape = [T(1000, 1.02), T(2000, 1.19), T(3000, 1.05), T(4000, 1.03)];
    const r = highWaterCrossing(tape, 1.0, 1.15, 9000);
    assert.notEqual(r!.fill.priceUsd, r!.crossed.priceUsd, "we cannot transact at the spike");
    assert.equal(r!.fill.priceUsd, 1.03, "fill lands 2 ticks later, at a real bid");
  });

  it("a phantom excursion on a dust pool cannot arm anything", async () => {
    const { highWaterCrossing } = await import("@hermes/core");
    const tape = [T(1000, 1.0), T(2000, 40, 300), T(3000, 1.01)];
    assert.equal(highWaterCrossing(tape, 1.0, 1.15, 9000), null);
  });

  it("the manager gate is profit-scoped and protective-safe in source", async () => {
    const s = await (await import("node:fs")).readFileSync(new URL("../src/paper.ts", import.meta.url), "utf8");
    const i = s.indexOf("F2 APPLIED");
    assert.ok(i > 0, "the applied gate must be present and documented");
    const branch = s.slice(i, i + 1800);
    assert.match(branch, /market\.priceUsd >= n\(position\.entryPriceUsd\)/, "only positions in profit may use an excursion");
    assert.match(branch, /!\/take_profit\|profit_lock\|basket\/\.test\(exit\.reason\)/, "any non-TP verdict must be re-derived from the live mark");
    assert.match(branch, /audit\("rung_high_water"/, "every high-water-armed rung must be audited");
  });
});

// ─── ADMISSION COURT TERMS (R2 pool floor, R5 unknown crowd) ─────────────────
// Shipped 2026-08-06. Both were written into manifest v5 as DATA before the
// verdict code read them — inert config is the "armed but inert" failure this
// session has produced three times. These tests make the enforcement provable.
describe("manifest admission terms are ENFORCED, not just configured", () => {
  const M = {
    version: 5, ratifiedAt: "2026-08-06",
    genomes: { BASE: 1.5 },
    elite: { venues: ["pumpswap"], poolMinUsd: 5000, refuseUnknownCrowd: true, crowdNetWinners: true },
    filler: { venues: ["pumpswap"], poolMinUsd: 5000, refuseUnknownCrowd: true, crowdNetWinners: true },
  };
  const ok = { signature: "BASE", inflow: 1.4, buyShare: 0.7, winnerHits: 2, rugHits: 0, venue: "pumpswap", poolUsd: 20000 };

  it("R2: a pool under the floor is refused; an unmeasured pool passes", async () => {
    const { manifestVerdict } = await import("../src/live/manifest.js");
    assert.equal(manifestVerdict(M as any, ok).kind, "seat");
    const thin = manifestVerdict(M as any, { ...ok, poolUsd: 3200 });
    assert.equal(thin.kind, "refuse");
    assert.match((thin as any).reason, /below the \$5000 admission floor/);
    assert.equal(manifestVerdict(M as any, { ...ok, poolUsd: null }).kind, "seat", "absence of measurement is not evidence");
  });

  it("R5: a 0W/0R crowd is refused as unknown", async () => {
    const { manifestVerdict } = await import("../src/live/manifest.js");
    const unknown = manifestVerdict(M as any, { ...ok, winnerHits: 0, rugHits: 0 });
    assert.equal(unknown.kind, "refuse");
    assert.match((unknown as any).reason, /0W\/0R/);
  });

  it("the executor passes poolUsd from the TRUSTED liquidity band only", async () => {
    const s = await (await import("node:fs")).readFileSync(new URL("../src/live/executor.ts", import.meta.url), "utf8");
    const i = s.indexOf("poolUsd: await");
    assert.ok(i > 0, "the gate must supply poolUsd");
    assert.match(s.slice(i, i + 600), /BETWEEN 1200 AND 5000000/, "a decoy print must never satisfy a depth floor");
  });
});
