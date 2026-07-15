/**
 * Fit the rug-prediction logistic regression from the recorder's labeled dataset.
 *
 *   pnpm --filter @hermes/recorder exec tsx src/fitRugModel.ts
 *
 * POINT-IN-TIME HONEST: every feature comes from the last candidate_tick at or
 * before triggered_at — exactly what the recorder knew at the moment it armed
 * the candidate. The label (rug vs not) comes from the future; the features
 * never do. Validation is a TIME-ORDERED split (train on the first 70% of
 * triggers, test on the most recent 30%) so the test set is genuinely unseen
 * later market regime, not a random shuffle that leaks intra-hour structure.
 *
 * Output: fitted weights (standardized + raw-space), per-decile rug rates on
 * the held-out set, and a ready-to-paste weights object for
 * packages/core/src/management/rugModel.ts.
 */
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
loadEnv({ path: resolve(import.meta.dirname, "../../../.env") });

const { db } = await import("@hermes/db");
const { sql } = await import("drizzle-orm");

interface Row {
  mint: string;
  label: string;
  triggered_at: string;
  dex: string | null;
  liq: number | null;
  fdv: number | null;
  bs: number | null;
  vol_m5: number | null;
  vol_h1: number | null;
  mm: number | null;
  dd: number | null;
  wm: number | null;
  age_min: number | null;
}

const rows = (await db.execute(sql`
  with trig as (
    select o.mint, o.label, o.triggered_at, lower(t.dex) as dex
    from candidate_outcomes o join tokens t on t.mint = o.mint
    where o.triggered_at is not null and o.label in ('winner','dud','rug')
  ),
  lt as (
    select distinct on (ct.mint)
      ct.mint, ct.liquidity_usd as liq, ct.fdv_usd as fdv, ct.buy_share_m5 as bs,
      ct.vol_m5, ct.vol_h1, ct.mark_multiple as mm, ct.drawdown_from_peak_pct as dd,
      ct.watch_minutes as wm, ct.age_minutes as age_min
    from candidate_ticks ct join trig on trig.mint = ct.mint and ct.snapped_at <= trig.triggered_at
    order by ct.mint, ct.snapped_at desc
  )
  select trig.mint, trig.label, trig.triggered_at, trig.dex,
    lt.liq, lt.fdv, lt.bs, lt.vol_m5, lt.vol_h1, lt.mm, lt.dd, lt.wm, lt.age_min
  from trig join lt on lt.mint = trig.mint
  order by trig.triggered_at asc
`)) as unknown as Row[];

console.log(`dataset: ${rows.length} triggered candidates`);

// ── Feature engineering — the SAME function the live scorer uses, imported
// from core so fit-time and score-time can never drift apart.
const { rugFeatureVector, RUG_FEATURE_NAMES } = await import("@hermes/core");
const n = (v: unknown): number => (v === null || v === undefined ? NaN : Number(v));
function featurize(r: Row): number[] {
  return rugFeatureVector({
    venue: r.dex,
    liquidityUsd: n(r.liq),
    fdvUsd: n(r.fdv),
    volM5: n(r.vol_m5),
    volH1: n(r.vol_h1),
    markMultiple: n(r.mm),
    drawdownPct: n(r.dd),
    watchMinutes: n(r.wm),
  });
}
const FEATURE_NAMES = [...RUG_FEATURE_NAMES];

const X = rows.map(featurize);
const y = rows.map((r) => (r.label === "rug" ? 1 : 0));

// Standardize on TRAIN stats only.
const split = Math.floor(rows.length * 0.7);
const dim = FEATURE_NAMES.length;
const mean = new Array(dim).fill(0);
const std = new Array(dim).fill(0);
const xat = (i: number, j: number): number => X[i]?.[j] ?? 0;
for (let j = 0; j < dim; j++) {
  let s = 0;
  for (let i = 0; i < split; i++) s += xat(i, j);
  mean[j] = s / split;
  let v = 0;
  for (let i = 0; i < split; i++) v += (xat(i, j) - mean[j]) ** 2;
  std[j] = Math.sqrt(v / split) || 1;
}
const Z = X.map((row) => row.map((x, j) => (x - mean[j]) / std[j]));

// Logistic regression, gradient descent + light L2.
const w = new Array(dim).fill(0);
let b = 0;
const LR = 0.1;
const L2 = 1e-3;
const EPOCHS = 4000;
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
for (let epoch = 0; epoch < EPOCHS; epoch++) {
  const gw = new Array(dim).fill(0);
  let gb = 0;
  for (let i = 0; i < split; i++) {
    const zi = Z[i] ?? [];
    const p = sigmoid(zi.reduce((s, x, j) => s + x * (w[j] ?? 0), b));
    const err = p - (y[i] ?? 0);
    for (let j = 0; j < dim; j++) gw[j] += err * (zi[j] ?? 0);
    gb += err;
  }
  for (let j = 0; j < dim; j++) w[j] -= (LR * (gw[j] / split + L2 * w[j]));
  b -= LR * (gb / split);
}

const prob = (i: number) => sigmoid((Z[i] ?? []).reduce((s, x, j) => s + x * (w[j] ?? 0), b));

// ── Validation on the held-out (most recent) 30% ────────────────────────────
function report(from: number, to: number, title: string) {
  const idx = Array.from({ length: to - from }, (_, k) => from + k);
  const scored = idx.map((i) => ({ p: prob(i), y: y[i] ?? 0 })).sort((a, b) => a.p - b.p);
  const base = scored.reduce((s, r) => s + r.y, 0) / scored.length;
  console.log(`\n${title} — n=${scored.length}, base rug rate ${(base * 100).toFixed(1)}%`);
  const D = 5;
  for (let d = 0; d < D; d++) {
    const seg = scored.slice(Math.floor((d * scored.length) / D), Math.floor(((d + 1) * scored.length) / D));
    const r = seg.reduce((s, x) => s + x.y, 0) / seg.length;
    const lo = seg[0]?.p ?? 0;
    const hi = seg[seg.length - 1]?.p ?? 0;
    console.log(`  quintile ${d + 1}: prob ${lo.toFixed(2)}-${hi.toFixed(2)} → rug rate ${(r * 100).toFixed(1)}%`);
  }
  // AUC via rank statistic
  let pos = 0;
  let rankSum = 0;
  scored.forEach((r, rank) => {
    if (r.y === 1) {
      pos += 1;
      rankSum += rank + 1;
    }
  });
  const neg = scored.length - pos;
  const auc = (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
  console.log(`  AUC ${auc.toFixed(3)}`);
}
report(0, split, "TRAIN (first 70%)");
report(split, rows.length, "TEST (most recent 30%, unseen)");

// ── Raw-space weights for the core scorer: w_raw = w_std/std, b_raw adjusts ──
const wRaw = w.map((wj, j) => wj / std[j]);
const bRaw = b - w.reduce((s, wj, j) => s + (wj * mean[j]) / std[j], 0);
console.log("\nstandardized weights:");
FEATURE_NAMES.forEach((f, j) => console.log(`  ${f.padEnd(12)} ${w[j].toFixed(3)}`));
console.log("\n// ── paste into packages/core/src/management/rugModel.ts ──");
console.log(`export const RUG_WEIGHTS = {`);
FEATURE_NAMES.forEach((f, j) => console.log(`  ${f}: ${(wRaw[j] ?? 0).toFixed(6)},`));
console.log(`} as const;`);
console.log(`export const RUG_BIAS = ${bRaw.toFixed(6)};`);
console.log(`// fitted ${new Date().toISOString()} on n=${rows.length} (train ${split}/test ${rows.length - split}, time-split)`);

process.exit(0);
