/**
 * MOON CONVERSION — the last N 🌙-alerted moons scored against GCE-MOON canon:
 * E[moon P&L] = arrivals × P(board) × P(ride) × capture × size.
 * Per moon: what it did, what we took, and WHICH equation term ate the delta.
 * Run: npx tsx packages/db/replays/moon-conversion.ts [n=50]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);
const N = Number(process.argv[2] ?? 50);
const [st] = await sql`SELECT value FROM config WHERE key = 'sentinel_state'`;
const seen: string[] = ((st?.value as any)?.moonshotSeen ?? []).slice(-N);
console.log(`scoring last ${seen.length} 🌙-alerted moons\n`);

type Verdict = "CONVERTED" | "PARTIAL" | "probe-sized" | "ride-cut-early" | "not-boarded" | "rugged" | "fizzled";
const tally = new Map<Verdict, { n: number; pnl: number; offered: number }>();
const add = (v: Verdict, pnl: number, off: number) => {
  const t = tally.get(v) ?? { n: 0, pnl: 0, offered: 0 };
  t.n++; t.pnl += pnl; t.offered += off;
  tally.set(v, t);
};
for (const mint of seen) {
  const [c] = await sql`
    SELECT t.symbol, c.peak_multiple::float AS peak, c.trigger_multiple::float AS trig, c.label
    FROM candidate_outcomes c JOIN tokens t ON t.mint = c.mint WHERE c.mint = ${mint}`;
  if (!c) continue;
  const pos = await sql`
    SELECT lane, size_usd::float AS s, realized_pnl_usd::float AS pnl, status,
           CASE WHEN entry_price_usd::float > 0 THEN peak_price_usd::float / entry_price_usd::float END AS ppeak
    FROM positions WHERE mint = ${mint}`;
  const offer = c.trig && c.peak && c.peak > c.trig ? (c.peak / c.trig - 1) : 0; // per-$ offer post-trigger
  const totPnl = pos.reduce((s2, p) => s2 + (p.pnl ?? 0), 0);
  const maxSize = Math.max(0, ...pos.map((p) => p.s));
  const offeredUsd = offer * Math.max(maxSize, 0);
  let v: Verdict;
  if (!pos.length) v = "not-boarded";
  else if (c.label === "rug" && totPnl < 0) v = "rugged";
  else if ((c.peak ?? 0) / (c.trig || 1) < 1.5) v = "fizzled"; // the moon never actually flew post-trigger
  else if (maxSize < 3) v = "probe-sized";
  else if (totPnl >= 0.25 * offeredUsd && totPnl > 1) v = "CONVERTED";
  else if (totPnl > 0.5) v = "PARTIAL";
  else v = "ride-cut-early";
  add(v, totPnl, offeredUsd);
}
console.log(`verdict          n     ΣP&L      Σoffered@our-size`);
for (const [k, t] of [...tally.entries()].sort((a, b) => b[1].n - a[1].n))
  console.log(`${k.padEnd(15)} ${String(t.n).padStart(3)}  $${t.pnl.toFixed(2).padStart(8)}  $${t.offered.toFixed(0).padStart(6)}`);
const tot = [...tally.values()].reduce((s2, t) => ({ n: s2.n + t.n, pnl: s2.pnl + t.pnl, offered: s2.offered + t.offered }), { n: 0, pnl: 0, offered: 0 });
const conv = (tally.get("CONVERTED")?.n ?? 0) + (tally.get("PARTIAL")?.n ?? 0);
console.log(`\nTOTAL ${tot.n} · banked $${tot.pnl.toFixed(2)} of $${tot.offered.toFixed(0)} offered at our sizes · conversion ${Math.round((100 * conv) / Math.max(1, tot.n))}% (CONVERTED+PARTIAL)`);
await sql.end();
