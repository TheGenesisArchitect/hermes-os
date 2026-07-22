/**
 * CLOSE WATCH — one line per closed trade, both lanes, with management deltas.
 *
 * Emitted per close: lane, symbol, class, size → P&L, peak, per-trade capture
 * (pnl ÷ size×(peak−1), peaks ≥1.2 only) vs the class's pooled capture on the
 * regime window (Δpp), TP rungs banked, exit reason. Built for the operator's
 * close-following sessions: each stdout line is a real-time event.
 *
 * Run: npx tsx packages/db/replays/close-watch.ts [--last5]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(env)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const q = postgres(url);

interface Row {
  id: number; lane: string; symbol: string | null; signature: string | null;
  size: number; pnl: number; peak: number; exitm: number; reason: string | null;
  tp: number; closedAt: Date;
}

const SEL = (extra: string) => `
  SELECT p.id, p.lane, tk.symbol, p.signature, p.size_usd::float size, p.realized_pnl_usd::float pnl,
    coalesce(p.peak_price_usd::float / nullif(p.entry_price_usd::float,0), 0) peak,
    coalesce(p.exit_price_usd::float / nullif(p.entry_price_usd::float,0), 0) exitm,
    p.exit_reason reason, p.closed_at as "closedAt",
    (SELECT count(*) FROM fills f WHERE f.position_id=p.id AND f.side='sell' AND f.reason LIKE 'take_profit%')::int tp
  FROM positions p LEFT JOIN tokens tk ON tk.mint=p.mint
  WHERE p.status='closed' AND p.signature IS NOT NULL ${extra}`;

async function classCapture(sig: string, lane: string): Promise<number | null> {
  const [r] = await q.unsafe(`
    SELECT coalesce(sum(realized_pnl_usd) filter (where peak_price_usd::float/nullif(entry_price_usd::float,0) >= 1.2),0)::float8 kept,
      coalesce(sum(size_usd*(peak_price_usd::float/nullif(entry_price_usd::float,0)-1))
        filter (where peak_price_usd::float/nullif(entry_price_usd::float,0) >= 1.2),0)::float8 offered
    FROM positions WHERE lane='${lane}' AND status='closed' AND signature='${sig.replace(/'/g, "")}'
      AND closed_at > now() - interval '8 hours'`);
  return r && Number(r.offered) > 0 ? (100 * Number(r.kept)) / Number(r.offered) : null;
}

function line(r: Row, avg: number | null): string {
  const armed = r.peak >= 1.2;
  const cap = armed && r.size > 0 ? (100 * r.pnl) / (r.size * (r.peak - 1)) : null;
  const capS = cap == null ? "pre-arm" : `capture ${cap.toFixed(0)}%`;
  const delta = cap != null && avg != null ? ` (class ${avg.toFixed(0)}%, Δ${cap - avg >= 0 ? "+" : ""}${(cap - avg).toFixed(0)}pp)` : "";
  const money = `${r.pnl >= 0 ? "+" : "−"}$${Math.abs(r.pnl).toFixed(2)}`;
  return `${r.lane === "live" ? "◆ LIVE " : "SIM    "}${String(r.symbol ?? "?").slice(0, 10).padEnd(10)} ${String(r.signature).padEnd(11)} $${r.size.toFixed(2).padStart(6)} → ${money.padStart(7)}  peak ${r.peak.toFixed(2)}× ${capS}${delta} · rungs ${r.tp} · ${r.reason ?? "?"}`;
}

(async () => {
  if (process.argv.includes("--last5")) {
    const rows = (await q.unsafe(SEL("") + ` ORDER BY p.closed_at DESC LIMIT 5`)) as unknown as Row[];
    for (const r of rows.reverse()) process.stdout.write(line(r, await classCapture(String(r.signature), r.lane)) + "\n");
    await q.end();
    return;
  }
  let cursor = new Date();
  process.stdout.write(`close-watch armed ${cursor.toISOString().slice(11, 19)}Z — one line per closed trade, both lanes\n`);
  for (;;) {
    try {
      const rows = (await q.unsafe(SEL(`AND p.closed_at > '${cursor.toISOString()}'`) + ` ORDER BY p.closed_at`)) as unknown as Row[];
      for (const r of rows) {
        cursor = new Date(Math.max(cursor.getTime(), new Date(r.closedAt).getTime()));
        process.stdout.write(line(r, await classCapture(String(r.signature), r.lane)) + "\n");
      }
    } catch (e) {
      process.stdout.write(`watch error (retrying): ${e instanceof Error ? e.message : e}\n`);
    }
    await new Promise((res) => setTimeout(res, 15_000));
  }
})();
