/**
 * TARGETED INVARIANT HARNESS — the four QTEA P0 corrections, pinned.
 *
 * Deliberately NOT a testing platform. This is the minimum set of assertions
 * that would have caught the four defects an external audit found on 2026-08-01,
 * and nothing else. Router simulation, provider contract fixtures, replay
 * fixtures and property tests are explicitly out of scope for this patch.
 *
 * Run: pnpm --filter @hermes/trader test
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  shouldPersistLatch, impactFraction, impactPct, impliedLiquidityUsd, closeVerdict,
  classifySwapFailure, customErrorCode, providerFromMessage,
} from "../src/live/invariants.js";

// ─── QTEA-001 ────────────────────────────────────────────────────────────────
// INVARIANT: partial exits and non-latching exits must never create or
// overwrite persistent latch state.
describe("QTEA-001 latch persistence", () => {
  it("1. a partial take-profit does NOT persist a latch", () => {
    assert.equal(shouldPersistLatch({ fraction: 0.25, reason: "take_profit", alreadyLatched: false }), false);
    // even a partial carrying a LATCHING reason is not a position in trouble
    assert.equal(shouldPersistLatch({ fraction: 0.5, reason: "floor_45", alreadyLatched: false }), false);
  });

  it("2. profit_trail does NOT persist a latch, even at full size", () => {
    assert.equal(shouldPersistLatch({ fraction: 1, reason: "profit_trail", alreadyLatched: false }), false);
    // the other deliberately-unlatched opportunistic exits
    assert.equal(shouldPersistLatch({ fraction: 1, reason: "liquid_window", alreadyLatched: false }), false);
    assert.equal(shouldPersistLatch({ fraction: 1, reason: "profit_lock", alreadyLatched: false }), false);
  });

  it("3. a full floor_45 exit persists exactly one latch", () => {
    assert.equal(shouldPersistLatch({ fraction: 1, reason: "floor_45", alreadyLatched: false }), true);
    assert.equal(shouldPersistLatch({ fraction: 0.999, reason: "hard_stop", alreadyLatched: false }), true);
    assert.equal(shouldPersistLatch({ fraction: 1, reason: "user_cut", alreadyLatched: false }), true);
    assert.equal(shouldPersistLatch({ fraction: 1, reason: "runner_timeout", alreadyLatched: false }), true);
  });

  it("4. a repeated protective retry does NOT reset the latch", () => {
    assert.equal(shouldPersistLatch({ fraction: 1, reason: "floor_45", alreadyLatched: true }), false);
  });
});

// ─── QTEA-004 ────────────────────────────────────────────────────────────────
// INVARIANT: 0.01 from Jupiter means 1% impact, not 0.01 percentage points.
describe("QTEA-004 price-impact units", () => {
  it("5. Jupiter impact 0.01 resolves to 1%", () => {
    assert.equal(impactFraction("0.01"), 0.01);
    assert.equal(impactPct("0.01"), 1);
    assert.equal(impactPct("0.001"), 0.1);
    assert.equal(impactPct("0.1"), 10);
  });

  it("6. liquidity inversion produces the expected value for known inputs", () => {
    // liq = 2 · trade · (1/frac − 1). A $100 sell at 1% impact implies a pool of
    // 2 · 100 · (100 − 1) = $19,800.
    assert.equal(impliedLiquidityUsd(100, impactFraction("0.01")), 19_800);
    // 10% impact on the same $100 → 2 · 100 · 9 = $1,800.
    assert.equal(impliedLiquidityUsd(100, impactFraction("0.1")), 1_800);
    // THE REGRESSION GUARD: the old code read "0.01" as 1.23-style percentage
    // points and computed 2·100·(100/0.01 − 1) = $1,999,800 — a pool ~101×
    // deeper than reality, which stood down every depth-based protection.
    assert.notEqual(impliedLiquidityUsd(100, impactFraction("0.01")), 1_999_800);
  });

  it("malformed, zero, and total-impact quotes carry no depth signal", () => {
    for (const bad of [null, undefined, "", "abc", "0", "-0.5", "1", "1.5", "NaN"]) {
      assert.equal(impactFraction(bad as string | null | undefined), null, `expected null for ${String(bad)}`);
    }
    assert.equal(impliedLiquidityUsd(100, null), null);
    assert.equal(impliedLiquidityUsd(0, 0.01), null);
  });
});

// ─── QTEA-002 + QTEA-011 ─────────────────────────────────────────────────────
// INVARIANT: recorded sold quantity equals the SETTLED quantity; a closed
// position implies a verified chain balance at or below the dust threshold.
describe("QTEA-002/011 settled quantity and chain-truth close", () => {
  const DEC = 6;
  const unit = (n: number) => BigInt(Math.round(n * 10 ** DEC));

  it("7. a sniper selling 99.5% records 99.5%, not 100%", () => {
    const pre = unit(1_000_000);
    const executed = (pre * 995n) / 1000n; // the chamber's dust margin
    const v = closeVerdict({
      preRaw: pre, executedRaw: executed, postRaw: pre - executed,
      decimals: DEC, priceUsd: 0.0001, dustUsd: 0.02,
    });
    // the residual is real and must be reflected, not rounded away
    assert.equal(Number(executed) / 10 ** DEC, 995_000);
    assert.notEqual(v.kind, "closed");
  });

  it("8. a sniper residual prevents a false full closure", () => {
    const pre = unit(1_000_000);
    const executed = (pre * 995n) / 1000n;
    const residual = pre - executed;              // 5,000 tokens
    const v = closeVerdict({
      preRaw: pre, executedRaw: executed, postRaw: residual,
      decimals: DEC, priceUsd: 0.01, dustUsd: 0.02, // residual worth $50
    });
    assert.equal(v.kind, "open");
    assert.equal(v.kind === "open" && v.remainingUi, 5_000);
  });

  it("9. a zero post-sell chain balance closes the position", () => {
    const pre = unit(1_000);
    const v = closeVerdict({
      preRaw: pre, executedRaw: pre, postRaw: 0n,
      decimals: DEC, priceUsd: 0.5, dustUsd: 0.02,
    });
    assert.equal(v.kind, "closed");
    assert.equal(v.remainingUi, 0);
  });

  it("10. an economically immaterial remainder follows the dust policy", () => {
    const pre = unit(1_000_000);
    const executed = (pre * 995n) / 1000n;
    const residual = pre - executed;              // 5,000 tokens
    const v = closeVerdict({
      preRaw: pre, executedRaw: executed, postRaw: residual,
      decimals: DEC, priceUsd: 0.000001, dustUsd: 0.02, // residual worth $0.005
    });
    assert.equal(v.kind, "dust_close");
    assert.ok(v.kind === "dust_close" && v.dustUsd < 0.02);
  });

  it("an unexplained divergence refuses to close silently", () => {
    const pre = unit(1_000);
    // settlement says everything sold, but the chain still holds 40% — never
    // close on that; audit it and re-evaluate next cycle.
    const v = closeVerdict({
      preRaw: pre, executedRaw: pre, postRaw: unit(400),
      decimals: DEC, priceUsd: 0.5, dustUsd: 0.02,
    });
    assert.equal(v.kind, "mismatch");
  });

  it("a failed post-read falls back to the settlement expectation", () => {
    const pre = unit(1_000);
    const v = closeVerdict({
      preRaw: pre, executedRaw: pre, postRaw: null,
      decimals: DEC, priceUsd: 0.5, dustUsd: 0.02,
    });
    assert.equal(v.kind, "closed"); // pre − executed = 0
  });
});

// ─── QTEA-014 ────────────────────────────────────────────────────────────────
// INVARIANT: a swap failure is classified by PROGRAM + code, never by a bare
// number. Codes collide across Anchor programs and mean opposite things.
describe("QTEA-014 swap failure classification", () => {
  // The exact message that killed the first live buy after arming, 03:09:09Z.
  const REAL = 'tx failed on-chain: {"InstructionError":[6,{"Custom":6004}]} '
    + '(4U3DcrXjey6pxeeMjdJEjQMVYjnkUXnb8vheCo6wsmfgEDReVuoDPE8s4htwPsH5AAYzvXJD35NcsESxbejaz1xU) [via pumpswap]';

  it("the production failure is now classified as slippage (was: unknown → no retry)", () => {
    assert.equal(classifySwapFailure(REAL, "pumpswap"), "slippage");
    // provider is also recoverable from the message alone
    assert.equal(classifySwapFailure(REAL), "slippage");
    assert.equal(customErrorCode(REAL), 6004);
    assert.equal(providerFromMessage(REAL), "pumpswap");
    // the OLD regex is what we are replacing — prove it missed this
    assert.equal(/6001|ExceededSlippage|simulation failed/i.test(REAL), false);
  });

  it("6003 means opposite things on the two programs", () => {
    const m = 'tx failed on-chain: {"InstructionError":[4,{"Custom":6003}]}';
    // pump_amm 6003 = TooLittlePoolTokenLiquidity → a VENUE problem
    assert.equal(classifySwapFailure(m, "pumpswap"), "thin_pool");
    // curve 6003 = TooLittleSolReceived → a PRICE problem
    assert.equal(classifySwapFailure(m, "pumpfun"), "slippage");
  });

  it("6001 is NOT slippage on pumpswap (it is ZeroBaseAmount)", () => {
    const m = 'tx failed on-chain: {"InstructionError":[4,{"Custom":6001}]} [via pumpswap]';
    assert.notEqual(classifySwapFailure(m), "slippage");
    // the old regex retried this forever by widening tolerance
    assert.equal(/6001|ExceededSlippage|simulation failed/i.test(m), true);
  });

  it("curve buy/sell slippage codes classify", () => {
    assert.equal(classifySwapFailure('{"Custom":6002}', "pumpfun"), "slippage"); // TooMuchSolRequired
    assert.equal(classifySwapFailure('{"Custom":6003}', "pumpfun"), "slippage"); // TooLittleSolReceived
  });

  it("named conditions and venue rejects still classify without a program", () => {
    assert.equal(classifySwapFailure("ExceededSlippage"), "slippage");
    assert.equal(classifySwapFailure("build 400 from provider"), "venue_reject");
    assert.equal(classifySwapFailure("NO_ROUTES"), "venue_reject");
  });

  it("a bare code with no known program is NOT guessed at", () => {
    assert.equal(classifySwapFailure('{"Custom":6004}'), "unknown");
    assert.equal(classifySwapFailure('{"Custom":6004}', "raydium"), "unknown");
    assert.equal(classifySwapFailure(""), "unknown");
  });
});

// ─── ADMISSION DOORS ─────────────────────────────────────────────────────────
// INVARIANT: a closed door REFUSES AND RETURNS. It must never merely drop the
// ticket-size flag — that would let the candidate fall through to normal sizing
// and board at FULL SLOT, strictly worse than the door being open.
describe("admission doors stay closed", () => {
  const read = async (rel: string) =>
    (await import("node:fs")).readFileSync(new URL(rel, import.meta.url), "utf8");

  it("both doors are gated on their config flag and each refuses with a return", async () => {
    const s = await read("../src/live/executor.ts");
    for (const flag of ["cfg.LIVE_SUBFLOOR_DOOR", "cfg.LIVE_CLIFFSAFE_DOOR"]) {
      const i = s.indexOf(`if (!${flag})`);
      assert.ok(i > 0, `${flag} must guard an explicit closed-door branch`);
      // the branch must audit a skip AND return, within a small window
      const branch = s.slice(i, i + 1200);
      assert.match(branch, /audit\("live_buy_skipped"/, `${flag} branch must audit a skip`);
      assert.match(branch, /\n\s*return;/, `${flag} branch must return, not fall through`);
    }
  });

  it("executability and solvency rails are OUTSIDE the strategy wraps", async () => {
    const s = await read("../src/live/executor.ts");
    // The two wraps are NOT contiguous — the pool-depth floor sits between them,
    // deliberately outside both. Slice each region separately.
    const a0 = s.indexOf("STRATEGY GATE LAYER, REGION 1");
    const a1 = s.indexOf("end strategy region 1");
    const b0 = s.indexOf("STRATEGY GATE LAYER, REGION 2");
    const b1 = s.indexOf("end strategy region 2");
    assert.ok(a0 > 0 && a1 > a0 && b0 > a1 && b1 > b0, "both strategy regions must be marked, in order");
    const wrapped = s.slice(a0, a1) + s.slice(b0, b1);
    const after = s.slice(b1);
    // the depth floor must live in the gap BETWEEN the two wraps
    assert.match(s.slice(a1, b0), /no exit at size/, "pool-depth floor must sit between the wraps, ungated");

    // These MUST NOT be inside the wrapped strategy regions — they are the
    // rails real capital needs and paper does not.
    for (const rail of ["SOL reserve floor", "no balance read", "no room (exposure", "no SOL price"]) {
      assert.ok(after.includes(rail), `solvency rail "${rail}" must follow the strategy regions`);
      assert.ok(!wrapped.includes(rail), `solvency rail "${rail}" must not be gated by LIVE_STRATEGY_GATES`);
    }
    // The gate CALL itself — kill switch, daily cap, concurrency/session caps,
    // already-held, venue executability, honeypot, sell-route probe — must never
    // be strategy-gated. 2026-08-02: region 2 captured it, and live bought
    // through an ENGAGED kill on a FAILED honeypot probe (RABBIT #7280,
    // unsellable in 19 minutes).
    assert.ok(after.includes("await liveBuyGate("), "liveBuyGate call must follow the strategy regions");
    assert.ok(!wrapped.includes("liveBuyGate("), "liveBuyGate must not be inside a LIVE_STRATEGY_GATES wrap");
    // ...and these selection opinions MUST be inside.
    for (const gate of ["REGIME CLASS GATE", "CLONE-WAVE GATE", "BUY-SHARE FLOOR", "CLIFF-SAFE DOOR"]) {
      assert.ok(wrapped.includes(gate), `strategy gate "${gate}" must be inside a wrap`);
    }
  });

  it("neither door defaults to open", async () => {
    const cfgSrc = await read("../../../packages/core/src/config.ts");
    for (const key of ["LIVE_SUBFLOOR_DOOR", "LIVE_CLIFFSAFE_DOOR"]) {
      const m = new RegExp(`${key}:\\s*z\\.coerce\\.boolean\\(\\)\\.default\\((\\w+)\\)`).exec(cfgSrc);
      assert.ok(m, `${key} must be declared`);
      assert.equal(m[1], "false", `${key} must default closed`);
    }
  });
});

// ─── RECONCILE MISMATCH + CHAMBER FAIL-CLOSED ────────────────────────────────
// Both learned from JORDAN #7110 (2026-08-02).
describe("settlement that moved no tokens is an expense, not a fill", () => {
  const read = async (rel: string) =>
    (await import("node:fs")).readFileSync(new URL(rel, import.meta.url), "utf8");

  it("the mismatch branch returns BEFORE any fill is journalled", async () => {
    const s = await read("../src/live/executor.ts");
    const mm = s.indexOf('if (verdict.kind === "mismatch")');
    assert.ok(mm > 0, "the mismatch branch must exist");
    // the NEXT fill insert after the branch — the buy path has its own, earlier
    const fill = s.indexOf("db.insert(fills)", mm);
    assert.ok(fill > mm, "a sell fill insert must follow the mismatch branch");
    const branch = s.slice(mm, fill);
    assert.match(branch, /return false;/, "mismatch must return, not fall through to the fill");
    // it must still book the fee — the transaction was genuinely paid for
    assert.match(branch, /realizedPnlUsd:[^\n]*feeUsd/, "mismatch must book the fee");
    // ...and must NOT allocate cost basis
    assert.doesNotMatch(branch, /costBasis/, "mismatch must not allocate cost basis");
  });

  it("the chamber refuses to sign a round it cannot floor", async () => {
    const s = await read("../src/live/presigned.ts");
    const i = s.indexOf("const canFloor");
    assert.ok(i > 0, "chamberExit must compute whether a cost-basis floor is priceable");
    const branch = s.slice(i, i + 900);
    assert.match(branch, /if \(!canFloor\)/, "must branch on the floor being unpriceable");
    assert.match(branch, /return false;/, "must refuse to chamber, not fall through");
    // the guard is worthless if outNow==0 isn't part of it — that was the JORDAN case
    assert.match(s.slice(i, i + 200), /outNow > 0/, "outNow > 0 must gate the floor");
  });
});

// ─── QTEA-010 ────────────────────────────────────────────────────────────────
// INVARIANT: live telemetry reports the LIVE mandate configuration.
describe("QTEA-010 mandate telemetry", () => {
  it("11. the live sizing audit reports LIVE_MANDATE_*, not paper's MANDATE_*", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/live/executor.ts", import.meta.url), "utf8"),
    );
    const line = src.split("\n").find((l) => l.includes("even mandate slot"));
    assert.ok(line, "the mandate audit line must exist");
    assert.match(line, /cfg\.LIVE_MANDATE_AGG_FRAC/);
    assert.match(line, /cfg\.LIVE_MANDATE_SLOTS/);
    // the paper keys must not appear on the LIVE sizing audit row
    assert.doesNotMatch(line, /cfg\.MANDATE_AGG_FRAC/);
    assert.doesNotMatch(line, /cfg\.MANDATE_SLOTS/);
  });
});

// ─── THE FORMULA MANIFEST ────────────────────────────────────────────────────
// INVARIANT (operator-ratified 2026-08-02): selection lives in ONE versioned
// manifest. The verdict is pure and fail-open; a refusal always names both
// tiers' reasons; solvency rails stay upstream of it.
describe("formula manifest", () => {
  const M = {
    version: 2,
    ratifiedAt: "2026-08-02T17:00:00Z",
    genomes: { BASE: 1.5, MOON_SLOW: 1.25, MOON_FAST: 0.6, RISER: 0.6, MOON_VIOLENT: 1.0 },
    elite: { inflowMin: 1.2, buyShareMin: 0.55, crowdNetWinners: true, venues: ["pumpswap", "fluxbeam"] },
    filler: { inflowMin: 1.2, inflowMax: 2.05, buyShareMin: 0.55, crowdNetWinners: true, venues: ["pumpswap", "fluxbeam", "meteora-damm-v2"] },
  };
  const base = { signature: "BASE", inflow: 1.4, buyShare: 0.7, winnerHits: 2, rugHits: 0, venue: "pumpswap" };

  it("no manifest → fail-open pass-through, never a refusal", async () => {
    const { manifestVerdict } = await import("../src/live/manifest.js");
    assert.deepEqual(manifestVerdict(null, base), { kind: "no-manifest" });
  });

  it("elite seat when every elite term holds", async () => {
    const { manifestVerdict } = await import("../src/live/manifest.js");
    const v = manifestVerdict(M as any, base);
    assert.deepEqual(v, { kind: "seat", tier: "elite", weight: 1.5, version: 2 });
  });

  it("falls to filler on venue, refuses above the filler envelope", async () => {
    const { manifestVerdict } = await import("../src/live/manifest.js");
    const damm = manifestVerdict(M as any, { ...base, venue: "meteora-damm-v2" });
    assert.equal((damm as any).tier, "filler");
    // inflow 3.0 on damm-v2: elite fails on venue, filler on the 2.05 ceiling
    const hot = manifestVerdict(M as any, { ...base, venue: "meteora-damm-v2", inflow: 3.0 });
    assert.equal(hot.kind, "refuse");
    assert.match((hot as any).reason, /elite → venue/);
    assert.match((hot as any).reason, /filler → inflow/);
  });

  it("crowd W>R binds: measured-equal refuses, unmeasured refuses", async () => {
    const { manifestVerdict } = await import("../src/live/manifest.js");
    assert.equal(manifestVerdict(M as any, { ...base, winnerHits: 1, rugHits: 1 }).kind, "refuse");
    assert.equal(manifestVerdict(M as any, { ...base, winnerHits: null, rugHits: null }).kind, "refuse");
  });

  it("genome outside the manifest refuses; unrouted refuses", async () => {
    const { manifestVerdict } = await import("../src/live/manifest.js");
    assert.equal(manifestVerdict(M as any, { ...base, signature: "MOON_STEADY" }).kind, "refuse");
    assert.equal(manifestVerdict(M as any, { ...base, signature: null }).kind, "refuse");
  });

  it("unmeasured inflow and buy share pass (absence isn't evidence)", async () => {
    const { manifestVerdict } = await import("../src/live/manifest.js");
    const v = manifestVerdict(M as any, { ...base, inflow: null, buyShare: null });
    assert.equal(v.kind, "seat");
  });

  it("the manifest gate is flag-gated, refusals audit + return, and it never wraps the solvency gate", async () => {
    const s = await (await import("node:fs")).readFileSync(new URL("../src/live/executor.ts", import.meta.url), "utf8");
    const i = s.indexOf("if (cfg.FORMULA_MANIFEST_ENABLED)");
    assert.ok(i > 0, "manifest gate must be flag-gated");
    const branch = s.slice(i, i + 1600);
    assert.match(branch, /audit\("live_buy_skipped"/, "manifest refusal must audit");
    assert.match(branch, /\n\s*return;/, "manifest refusal must return");
    assert.ok(!branch.includes("liveBuyGate"), "the solvency gate must not live inside the manifest branch");
    assert.ok(i < s.indexOf("await liveBuyGate("), "manifest (selection) must sit before the solvency gate, never around it");
  });
});
