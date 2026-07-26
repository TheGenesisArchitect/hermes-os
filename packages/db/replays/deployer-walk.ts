/** P4 WALKER — paginate each mint's history to its genesis tx; fee payer =
 * the DEPLOYER. Upserts token_deployers; prints the rep table. curl RPC. */
import fs from "node:fs"; import { execSync } from "node:child_process"; import postgres from "postgres";
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync("C:/Users/mrbee/Projects/hermes-os/.env","utf8"))![1]!.trim();
const q = postgres(url);
await q.unsafe(fs.readFileSync("C:/Users/mrbee/Projects/hermes-os/packages/db/sql/deployers_p4.sql","utf8"));
const rpc = (method: string, params: unknown[]) => JSON.parse(execSync(
  `curl -s --max-time 25 https://solana-rpc.publicnode.com -H "content-type: application/json" -d "${JSON.stringify({jsonrpc:"2.0",id:1,method,params}).replace(/"/g,'\\"')}"`,
  { maxBuffer: 80e6 }).toString()).result;
// Walk queue: live-traded mints first, then the freshest qualified candidates.
const mints = await q.unsafe(`
  SELECT DISTINCT mint FROM (
    SELECT p.mint, 0 prio FROM positions p WHERE p.lane='live' AND p.opened_at > now() - interval '24 hours'
    UNION ALL
    SELECT c.mint, 1 FROM candidate_outcomes c WHERE c.triggered_at > now() - interval '2 hours'
      AND (c.stars = 2 OR c.wallet_winner_hits >= 1)
  ) u WHERE NOT EXISTS (SELECT 1 FROM token_deployers d WHERE d.mint = u.mint)
  LIMIT 8`) as any[];
console.log(`walking ${mints.length} mints…`);
for (const { mint } of mints) {
  try {
    let before: string | undefined; let oldest: any = null; let pages = 0;
    while (pages < 12) {
      const sigs = rpc("getSignaturesForAddress", [mint, { limit: 1000, ...(before ? { before } : {}) }]) as any[];
      if (!sigs?.length) break;
      oldest = sigs[sigs.length - 1]; before = oldest.signature; pages++;
      if (sigs.length < 1000) break;
    }
    if (!oldest) { console.log(`${mint.slice(0,8)}…: no history`); continue; }
    const tx = rpc("getTransaction", [oldest.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]) as any;
    const k = tx?.transaction?.message?.accountKeys?.[0];
    const deployer = typeof k === "string" ? k : k?.pubkey ?? null;
    const createdAt = oldest.blockTime ? new Date(oldest.blockTime * 1000) : null;
    await q`INSERT INTO token_deployers (mint, deployer, creation_sig, created_at, tx_pages)
      VALUES (${mint}, ${deployer}, ${oldest.signature}, ${createdAt?.toISOString() ?? null}, ${pages})
      ON CONFLICT (mint) DO UPDATE SET deployer=EXCLUDED.deployer, creation_sig=EXCLUDED.creation_sig,
        created_at=EXCLUDED.created_at, tx_pages=EXCLUDED.tx_pages, walked_at=now()`;
    console.log(`${mint.slice(0,8)}…: deployer ${deployer?.slice(0,8)}… (${pages} page${pages>1?"s":""}${pages>=12?" — CAP HIT, floor not genesis":""}) created ${createdAt?.toISOString().slice(0,16) ?? "?"}Z`);
  } catch (e) { console.log(`${mint.slice(0,8)}…: walk failed — ${e instanceof Error ? e.message.slice(0,50) : e}`); }
}
// REP TABLE: deployers with >1 tracked launch, scored by our outcome labels.
const rep = await q.unsafe(`
  SELECT d.deployer, count(*)::int launches,
    count(*) filter (where co.label='winner')::int wins,
    count(*) filter (where co.label='rug')::int rugs
  FROM token_deployers d LEFT JOIN candidate_outcomes co ON co.mint = d.mint
  WHERE d.deployer IS NOT NULL GROUP BY 1 HAVING count(*) > 1 ORDER BY count(*) DESC LIMIT 6`);
console.log(`\nDEPLOYER REP (multi-launch):`);
for (const r of rep as any[]) console.log(`  ${String(r.deployer).slice(0,10)}… launches=${r.launches} winners=${r.wins} rugs=${r.rugs}`);
if (!(rep as any[]).length) console.log("  (none yet — table grows as the walker runs)");
await q.end();
