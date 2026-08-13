/**
 * THE DEPLOYER-EDGE HARNESS (part b of the Narrative/Wallet-Graph push).
 *
 * PURPOSE
 *   The uncommitted walletReputation change adds a deployer term to the wallet
 *   edge: strict winner +0.16, net-positive +0.08, serial rug −0.16. Per the
 *   desk protocol, that weight is a HYPOTHESIS until the full tape says
 *   otherwise. This harness measures whether deployer reputation, knowable at
 *   entry, actually separates winners from rugs.
 *
 * WHAT IT MEASURES (entry-knowable only — GTPED §10.1)
 *   For every candidate with a fingerprinted deployer (token_deployers ⨝
 *   candidate_outcomes), the deployer's track record as of TODAY is bucketed:
 *     strict-winner  ≥ MIN_SAMPLE tokens, wins>0, rugs=0   (the +0.16 cohort)
 *     net-positive   ≥ MIN_SAMPLE tokens, wins>rugs>0       (the +0.08 cohort)
 *     serial-rug     ≥ MIN_SAMPLE tokens, rugs≥2, wins=0    (the −0.16 cohort)
 *     unproven       < MIN_SAMPLE launches or mixed/no signal (term = 0)
 *   Each cohort is priced on the labeled outcome of the candidate itself:
 *   win rate, rug rate, and the mean outcome multiple.
 *
 * CAVEAT (stated, not hidden): the deployer rep is computed over ALL launches
 *   including the candidate's own — a same-day look-ahead bias. It inflates
 *   separation. Treat the numbers as an upper bound on the signal; the live
 *   path recomputes rep at arm time, which is what actually matters.
 *
 * SUCCESS       strict-winner cohort shows win-rate materially above the
 *               unproven baseline AND serial-rug cohort shows rug-rate
 *               materially above baseline, each with n ≥ MIN_N.
 * FAILURE MODE  small-n cohorts read as signal; MIN_N floor printed per cohort.
 * OWNER         Data Science
 *
 * Run: npx tsx packages/db/replays/deployer-edge.ts [minSample=3]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(env)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const MIN_SAMPLE = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? "3"); // WALLET_MIN_SAMPLE
const MIN_N = 30; // no under-powered sample defends a rail

type Cohort = {
    name: string;
    n: number;
    winners: number;
    rugs: number;
    open: number;
    avgPeak: number | null;
};

const pct = (a: number, b: number) => (b > 0 ? Math.round((1000 * a) / b) / 10 + "%" : "—");

function row(name: string, n: number, winners: number, rugs: number, open: number, avgPeak: number | null): Cohort {
    return { name, n, winners, rugs, open, avgPeak };
}

function show(c: Cohort): string {
    const labeled = c.winners + c.rugs;
    return (
        `${c.name.padEnd(16)} n=${String(c.n).padStart(5)}  labeled=${String(labeled).padStart(5)}  ` +
        `win% ${pct(c.winners, labeled).padStart(6)}  rug% ${pct(c.rugs, labeled).padStart(6)}  ` +
        `avgPeak ${c.avgPeak == null ? "—" : c.avgPeak.toFixed(2) + "x"}  ${c.n < MIN_N ? "  ⚠ under-powered" : ""}`
    );
}

(async () => {
    const q = postgres(url, { idle_timeout: 10 });
    console.log(`DEPLOYER-EDGE HARNESS — deployer rep cohorts vs labeled outcomes (MIN_SAMPLE=${MIN_SAMPLE})\n`);

    // Bias-free pass: each candidate's deployer rep EXCLUDES the candidate's own
    // mint (kills the same-mint look-ahead). A deployer whose only launch is this
    // candidate drops to unproven, which is the honest entry-time state.
    const rows = (await q`
    WITH rep AS (
      SELECT d.mint, d.deployer,
        (SELECT count(*) FROM token_deployers d2
          LEFT JOIN candidate_outcomes c2 ON c2.mint = d2.mint
          WHERE d2.deployer = d.deployer AND d2.mint <> d.mint)::int AS launches,
        (SELECT count(*) FROM token_deployers d2
          JOIN candidate_outcomes c2 ON c2.mint = d2.mint
          WHERE d2.deployer = d.deployer AND d2.mint <> d.mint AND c2.label = 'winner')::int AS wins,
        (SELECT count(*) FROM token_deployers d2
          JOIN candidate_outcomes c2 ON c2.mint = d2.mint
          WHERE d2.deployer = d.deployer AND d2.mint <> d.mint AND c2.label = 'rug')::int AS rugs
      FROM token_deployers d
      WHERE d.deployer IS NOT NULL
    )
    SELECT
      CASE
        WHEN launches >= ${MIN_SAMPLE} AND wins > 0 AND rugs = 0 THEN 'strict-winner'
        WHEN launches >= ${MIN_SAMPLE} AND wins > rugs AND rugs > 0 THEN 'net-positive'
        WHEN launches >= ${MIN_SAMPLE} AND rugs >= 2 AND wins = 0 THEN 'serial-rug'
        ELSE 'unproven'
      END AS cohort,
      count(*)::int AS n,
      count(*) FILTER (WHERE co.label = 'winner')::int AS winners,
      count(*) FILTER (WHERE co.label = 'rug')::int AS rugs,
      count(*) FILTER (WHERE co.label = 'open')::int AS open,
      avg(co.peak_multiple::float) AS avg_peak
    FROM rep
    JOIN candidate_outcomes co ON co.mint = rep.mint
    GROUP BY 1
    ORDER BY 1
  `) as unknown as { cohort: string; n: number; winners: number; rugs: number; open: number; avg_peak: number | null }[];

    const cohorts = rows.map((r) =>
        row(r.cohort, Number(r.n), Number(r.winners), Number(r.rugs), Number(r.open), r.avg_peak == null ? null : Number(r.avg_peak)),
    );
    for (const c of cohorts) console.log(show(c));

    // Lift vs the unproven baseline.
    const base = cohorts.find((c) => c.name === "unproven");
    if (base && base.winners + base.rugs > 0) {
        const baseWin = base.winners / (base.winners + base.rugs);
        const baseRug = base.rugs / (base.winners + base.rugs);
        console.log(`\nBaseline (unproven): win% ${(100 * baseWin).toFixed(1)}  rug% ${(100 * baseRug).toFixed(1)}`);
        for (const c of cohorts) {
            if (c.name === "unproven" || c.winners + c.rugs === 0) continue;
            const w = c.winners / (c.winners + c.rugs);
            const r = c.rugs / (c.winners + c.rugs);
            console.log(
                `  ${c.name.padEnd(16)} win-lift ${((w - baseWin) * 100).toFixed(1).padStart(6)}pp   rug-lift ${((r - baseRug) * 100).toFixed(1).padStart(6)}pp`,
            );
        }
    }

    // Coverage: how much of the labeled universe carries a deployer signal at all.
    const [cov] = (await q`
    SELECT
      (SELECT count(*) FROM candidate_outcomes WHERE label IN ('winner','rug'))::int AS labeled_total,
      (SELECT count(*) FROM token_deployers d JOIN candidate_outcomes co ON co.mint = d.mint
        WHERE co.label IN ('winner','rug') AND d.deployer IS NOT NULL)::int AS labeled_with_deployer
  `) as unknown as { labeled_total: number; labeled_with_deployer: number }[];
    console.log(
        `\nCoverage: ${cov.labeled_with_deployer} of ${cov.labeled_total} labeled candidates have a fingerprinted deployer (${pct(cov.labeled_with_deployer, cov.labeled_total)})`,
    );

    await q.end();
})();
