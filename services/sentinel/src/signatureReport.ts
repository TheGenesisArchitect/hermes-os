/**
 * SIGNATURE REPORT — the phone template for a system that now trades five
 * genomes instead of one.
 *
 * The old RECAP reported one number for the whole book, which was fine when
 * every position shared one profile. It no longer is: RISER and BASE are
 * confirmed on held-out tape, CLIMBER and the moon grades are still
 * accumulating evidence, and a single blended P&L hides which of those is true.
 * So the report is per-signature, and it carries the three things that actually
 * decide what to do next:
 *
 *   PERFORMANCE  — per class: trades, win%, EV per dollar deployed. EV is the
 *                  same unit the learning loop optimises, so the phone and the
 *                  loop never disagree about what "good" means.
 *   SELECTION    — routed vs refused, and the dead-on-arrival rate. A class
 *                  whose entries never move is a selection failure, and no exit
 *                  profile can rescue it.
 *   LEARNING     — what the loop last promoted and when, so a profile change is
 *                  never invisible.
 */
import { db, fills, positions, candidateOutcomes, config } from "@hermes/db";
import { and, eq, gte, sql } from "drizzle-orm";

export interface SignatureLine {
  sig: string;
  n: number;
  wins: number;
  winPct: number;
  pnl: number;
  deployed: number;
  ev: number;
  deadPct: number;
  bestPeak: number;
  // ── PIPELINE QUALITY (the Trade Performance Analyzer's checkpoints) ────────
  /** Pooled capture: $ kept ÷ $ the peaks offered, over trades that reached a rung. Null = none reached. */
  captureP: number | null;
  /** Of trades that reached a rung, share that actually banked one. Null = none reached. */
  bankedRate: number | null;
  /** Winners (peak >1.05×) that still closed red — the management failure P&L hides. */
  trailedRed: number;
}

export interface SignatureReport {
  windowHours: number;
  lines: SignatureLine[];
  totals: { n: number; winPct: number; pnl: number; deployed: number; ev: number };
  routed: { sig: string; n: number }[];
  refused: number;
  promotedAt: string | null;
  promoted: string[];
  openNow: number;
}

export async function buildSignatureReport(windowHours = 8): Promise<SignatureReport> {
  const since = new Date(Date.now() - windowHours * 3_600_000);

  const perf = await db
    .select({
      sig: sql<string>`coalesce(${positions.signature}, '(unrouted)')`,
      n: sql<number>`count(*)::int`,
      wins: sql<number>`count(*) filter (where ${positions.realizedPnlUsd} > 0)::int`,
      pnl: sql<number>`coalesce(sum(${positions.realizedPnlUsd}),0)::float8`,
      deployed: sql<number>`coalesce(sum(${positions.sizeUsd}),0)::float8`,
      // Dead on arrival: never cleared +10% off entry. A selection failure, not
      // an exit one — the distinction the blended number used to hide.
      dead: sql<number>`count(*) filter (where ${positions.peakPriceUsd} / nullif(${positions.entryPriceUsd},0) < 1.10)::int`,
      bestPeak: sql<number>`coalesce(max(${positions.peakPriceUsd} / nullif(${positions.entryPriceUsd},0)),0)::float8`,
      // Pipeline checkpoints, same math as the Trade Performance Analyzer:
      // capture pools dollars kept over dollars the peaks offered (never an
      // average of ratios — the smallest denominator dominates those), gated on
      // the first rung (~1.22×). Banked = a take_profit fill actually exists.
      reached: sql<number>`count(*) filter (where ${positions.peakPriceUsd} / nullif(${positions.entryPriceUsd},0) >= 1.22)::int`,
      banked: sql<number>`count(*) filter (where ${positions.peakPriceUsd} / nullif(${positions.entryPriceUsd},0) >= 1.22 and exists (select 1 from fills f where f.position_id = ${positions.id} and f.reason like 'take_profit%'))::int`,
      gainAvail: sql<number>`coalesce(sum(${positions.sizeUsd} * (${positions.peakPriceUsd} / nullif(${positions.entryPriceUsd},0) - 1)) filter (where ${positions.peakPriceUsd} / nullif(${positions.entryPriceUsd},0) >= 1.22),0)::float8`,
      gainKept: sql<number>`coalesce(sum(${positions.realizedPnlUsd}) filter (where ${positions.peakPriceUsd} / nullif(${positions.entryPriceUsd},0) >= 1.22),0)::float8`,
      trailedRed: sql<number>`count(*) filter (where ${positions.peakPriceUsd} / nullif(${positions.entryPriceUsd},0) > 1.05 and ${positions.realizedPnlUsd} < 0)::int`,
    })
    .from(positions)
    .where(and(eq(positions.lane, "paper"), eq(positions.status, "closed"), gte(positions.closedAt, since)))
    .groupBy(sql`coalesce(${positions.signature}, '(unrouted)')`);

  const lines: SignatureLine[] = perf
    .map((p) => ({
      sig: p.sig,
      n: p.n,
      wins: p.wins,
      winPct: p.n > 0 ? (100 * p.wins) / p.n : 0,
      pnl: p.pnl,
      deployed: p.deployed,
      ev: p.deployed > 0 ? 1 + p.pnl / p.deployed : 0,
      deadPct: p.n > 0 ? (100 * p.dead) / p.n : 0,
      bestPeak: p.bestPeak,
      captureP: p.gainAvail > 0 ? (100 * p.gainKept) / p.gainAvail : null,
      bankedRate: p.reached > 0 ? (100 * p.banked) / p.reached : null,
      trailedRed: p.trailedRed,
    }))
    .sort((a, b) => b.pnl - a.pnl);

  const routedRows = await db
    .select({ sig: sql<string>`${candidateOutcomes.signature}`, n: sql<number>`count(*)::int` })
    .from(candidateOutcomes)
    .where(and(sql`${candidateOutcomes.signature} is not null`, gte(candidateOutcomes.updatedAt, since)))
    .groupBy(candidateOutcomes.signature);

  const [openRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(positions)
    .where(and(eq(positions.lane, "paper"), eq(positions.status, "open")));

  const [learned] = await db.select().from(config).where(eq(config.key, "signature_profiles"));
  const lv = (learned?.value ?? {}) as Record<string, unknown>;
  const promoted = Object.keys(lv).filter((k) => k !== "updatedAt");
  const promotedAt = typeof lv.updatedAt === "string" ? lv.updatedAt : null;

  const tN = lines.reduce((s, l) => s + l.n, 0);
  const tW = lines.reduce((s, l) => s + l.wins, 0);
  const tP = lines.reduce((s, l) => s + l.pnl, 0);
  const tD = lines.reduce((s, l) => s + l.deployed, 0);

  return {
    windowHours,
    lines,
    totals: { n: tN, winPct: tN > 0 ? (100 * tW) / tN : 0, pnl: tP, deployed: tD, ev: tD > 0 ? 1 + tP / tD : 0 },
    routed: routedRows.filter((r) => r.sig !== "RUG_RISK").map((r) => ({ sig: r.sig, n: r.n })).sort((a, b) => b.n - a.n),
    refused: routedRows.find((r) => r.sig === "RUG_RISK")?.n ?? 0,
    promotedAt,
    promoted,
    openNow: openRow?.n ?? 0,
  };
}

const money = (v: number) => `${v < 0 ? "−" : "+"}$${Math.abs(v).toFixed(2)}`;
const pretty = (s: string) => s.replace("MOON_", "MOON ").replace("(unrouted)", "unrouted").toLowerCase();

/**
 * PHONE RENDER. Column-aligned tables do not survive a proportional font on a
 * narrow screen, and jargon like "EV 1.31 · 23% DOA" is unreadable at a glance.
 * So: lead with the money, group winners from losers, keep every line short
 * enough to fit without wrapping, and translate the metrics into plain language.
 * Anything that needs a legend belongs in the dashboard, not on a lock screen.
 */
export function renderSignatureReport(r: SignatureReport): string[] {
  const out: string[] = [];
  const up = r.totals.pnl >= 0;

  // The one number that matters, first and unmissable.
  out.push(`${up ? "🟢" : "🔴"} ${money(r.totals.pnl)}   (${r.totals.ev.toFixed(2)}x per $)`);
  out.push(`${r.totals.n} trades · ${r.totals.winPct.toFixed(0)}% won · ${r.openNow} still open`);
  out.push(`over the last ${r.windowHours}h`);

  const winners = r.lines.filter((l) => l.pnl > 0);
  const losers = r.lines.filter((l) => l.pnl < 0);

  if (winners.length) {
    out.push("");
    out.push("🏆 MAKING MONEY");
    for (const l of winners) {
      out.push(`${money(l.pnl)}  ${pretty(l.sig)}`);
      out.push(`   ${l.n} trade${l.n === 1 ? "" : "s"}, ${l.winPct.toFixed(0)}% won${l.bestPeak >= 2 ? `, best ${l.bestPeak.toFixed(1)}x` : ""}`);
    }
  }
  if (losers.length) {
    out.push("");
    out.push("📉 LOSING MONEY");
    for (const l of losers) {
      out.push(`${money(l.pnl)}  ${pretty(l.sig)}`);
      out.push(`   ${l.n} trade${l.n === 1 ? "" : "s"}, ${l.winPct.toFixed(0)}% won`);
    }
  }

  // ── HOW WELL TRADES WERE MANAGED — the analyzer's checkpoints, every hour.
  // P&L says whether a class won; capture and banked-rate say whether its
  // trades were MANAGED well, and those come apart constantly. This is the
  // standing review the one-off audits kept re-discovering by hand.
  const managed = r.lines.filter((l) => l.captureP != null && l.n >= 2);
  if (managed.length) {
    out.push("");
    out.push("🔬 HOW WE MANAGED THE MOVES");
    for (const l of managed.sort((a, b) => (b.captureP ?? 0) - (a.captureP ?? 0))) {
      out.push(`   ${pretty(l.sig)}: kept ${l.captureP!.toFixed(0)}% of the move, banked ${l.bankedRate!.toFixed(0)}% of rungs${l.trailedRed > 0 ? `, ${l.trailedRed} winner${l.trailedRed === 1 ? "" : "s"} closed red` : ""}`);
    }
  }

  // ── GAPS, auto-flagged. The rule set encodes every defect class found by
  // hand on 2026-07-21, so the next occurrence names itself instead of hiding
  // until someone reruns the audit.
  const gaps: string[] = [];
  for (const l of r.lines) {
    if (l.n >= 3 && l.captureP != null && l.captureP < 0)
      gaps.push(`${pretty(l.sig)} gives back MORE than the move offered (capture ${l.captureP.toFixed(0)}%)`);
    if (l.n >= 3 && l.bankedRate != null && l.bankedRate < 60)
      gaps.push(`${pretty(l.sig)} ladder firing only ${l.bankedRate.toFixed(0)}% of the time`);
    if (l.trailedRed >= 2) gaps.push(`${pretty(l.sig)}: ${l.trailedRed} winners managed into losses`);
    if (l.n >= 3 && l.deadPct >= 40)
      gaps.push(`${l.deadPct.toFixed(0)}% of ${pretty(l.sig)} entries never moved — selection, not exits`);
  }
  if (gaps.length) {
    out.push("");
    out.push("⚠️ GAPS TO CLOSE");
    for (const g of gaps.slice(0, 5)) out.push(`   ${g}`);
  }

  if (r.routed.length) {
    out.push("");
    out.push("🔭 WHAT WE'RE FINDING");
    const top = r.routed.slice(0, 4).map((x) => `${pretty(x.sig)} ${x.n}`);
    out.push(`   ${top.join(", ")}`);
    if (r.refused > 0) out.push(`   skipped ${r.refused} as too risky`);
  }

  out.push("");
  if (r.promoted.length && r.promotedAt) {
    out.push(`🧠 auto-tuned ${r.promoted.map(pretty).join(" & ")}`);
    out.push(`   at ${new Date(r.promotedAt).toISOString().slice(11, 16)} UTC`);
  } else {
    out.push("🧠 no auto-tuning yet (still gathering)");
  }
  return out;
}
