/** P4 first contact: live txs + deployer of each live-traded token (oldest
 * mint signature's fee payer = the deployer). curl for RPC (host DPI). */
import fs from "node:fs"; import { execSync } from "node:child_process"; import postgres from "postgres";
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync("C:/Users/mrbee/Projects/hermes-os/.env","utf8"))![1]!.trim();
const q = postgres(url);
const rpc = (method: string, params: unknown[]) => JSON.parse(execSync(
  `curl -s --max-time 20 https://solana-rpc.publicnode.com -H "content-type: application/json" -d "${JSON.stringify({jsonrpc:"2.0",id:1,method,params}).replace(/"/g,'\\"')}"`,
  { maxBuffer: 50e6 }).toString()).result;
const txs = await q.unsafe(`
  SELECT c.signature, c.class, c.sol_delta, c.token_mint, tk.symbol, c.block_time
  FROM chain_txs c LEFT JOIN tokens tk ON tk.mint = c.token_mint
  WHERE c.block_time > '2026-07-26T03:45Z' AND c.class IN ('buy','sell')
  ORDER BY c.block_time`);
const mints = new Set<string>();
for (const t of txs as any[]) {
  console.log(`${t.class.toUpperCase().padEnd(4)} ${String(t.symbol??"?").slice(0,10).padEnd(10)} ${Number(t.sol_delta).toFixed(4)} SOL · ${t.signature}`);
  if (t.token_mint) mints.add(t.token_mint);
}
for (const mint of mints) {
  try {
    const sigs = rpc("getSignaturesForAddress", [mint, { limit: 1000 }]) as any[];
    if (!sigs?.length) { console.log(`${mint.slice(0,8)}…: no history`); continue; }
    const oldest = sigs[sigs.length - 1];
    const full = sigs.length >= 1000 ? " (1000+ txs — oldest shown is a floor, true creation needs pagination)" : "";
    const tx = rpc("getTransaction", [oldest.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]) as any;
    const payer = tx?.transaction?.message?.accountKeys?.[0];
    const addr = typeof payer === "string" ? payer : payer?.pubkey;
    console.log(`\nDEPLOYER of ${mint.slice(0,8)}…: ${addr ?? "?"}${full}\n  creation tx ${oldest.signature.slice(0,20)}… at ${oldest.blockTime ? new Date(oldest.blockTime*1000).toISOString().slice(0,16)+"Z" : "?"} · token has ${sigs.length}${sigs.length>=1000?"+":""} txs`);
    const [deployed] = await q.unsafe(`SELECT count(DISTINCT c2.mint)::int n FROM candidate_outcomes c2 JOIN tokens t2 ON t2.mint=c2.mint WHERE t2.raw::text LIKE '%${addr}%'`) as any[];
    if (deployed?.n > 1) console.log(`  ⚠ this wallet appears in ${deployed.n} tracked tokens' metadata`);
  } catch (e) { console.log(`${mint.slice(0,8)}…: RPC failed (${e instanceof Error ? e.message.slice(0,60) : e})`); }
}
await q.end();
