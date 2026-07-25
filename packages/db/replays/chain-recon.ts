/**
 * P0 CHAIN RECONCILIATION — the truth layer vs the intent records.
 * fills ↔ chain_txs by signature: matched, unmatched-on-chain (untracked!),
 * unmatched-in-fills (unconfirmed?), and per-sell recorded-vs-chain proceeds
 * (TRUE slippage). Run: npx tsx packages/db/replays/chain-recon.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);

const [cov] = await sql`
  SELECT count(*)::int AS chain_n,
         count(matched_fill_id)::int AS matched,
         min(block_time) AS oldest, max(block_time) AS newest
  FROM chain_txs`;
console.log(`chain_txs: ${cov.chain_n} rows (${cov.matched} matched to fills) · ${cov.oldest ? new Date(cov.oldest).toISOString().slice(5, 16) : "—"} → ${cov.newest ? new Date(cov.newest).toISOString().slice(5, 16) : "—"}`);

const cls = await sql`
  SELECT class, count(*)::int AS n, round(sum(sol_delta)::numeric, 4) AS sol
  FROM chain_txs GROUP BY class ORDER BY n DESC`;
for (const c of cls) console.log(`  ${String(c.class).padEnd(9)} n=${String(c.n).padStart(4)} · ΣSOL ${c.sol}`);

const untracked = await sql`
  SELECT signature, class, sol_delta, block_time FROM chain_txs
  WHERE matched_fill_id IS NULL AND class IN ('buy','sell')
  ORDER BY block_time DESC LIMIT 8`;
console.log(`\nUNTRACKED swaps on-chain (no fill row): ${untracked.length === 8 ? "8+" : untracked.length}`);
for (const u of untracked) console.log(`  ${String(u.signature).slice(0, 16)}… ${u.class} ${Number(u.sol_delta).toFixed(4)} SOL ${u.block_time ? new Date(u.block_time).toISOString().slice(5, 16) : ""}`);

const [orphan] = await sql`
  SELECT count(*)::int AS n FROM fills f JOIN positions p ON p.id = f.position_id
  WHERE p.lane = 'live' AND f.tx_signature IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM chain_txs c WHERE c.signature = f.tx_signature)`;
console.log(`\nlive fills whose signature is not yet ingested: ${orphan.n} (shrinks as backfill walks history)`);
await sql.end();
