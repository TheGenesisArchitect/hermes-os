// Inspect the shape of one wallet's swap txs to fix the attribution rule.
const fs = require("fs");
const env = fs.readFileSync("C:/Users/mrbee/Projects/hermes-os/.env", "utf8");
const key = /HELIUS_API_KEY=(.+)/.exec(env)?.[1]?.trim();
const WALLET = "9eJPBPKP5Q"; // from the walk — but we need the full address; read it from DB
const postgres = require("C:/Users/mrbee/Projects/hermes-os/node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/cjs/src/index.js");
const url = /DATABASE_URL=(.+)/.exec(env)?.[1]?.trim();
(async () => {
    const q = postgres(url);
    const rows = await q`SELECT wallet FROM wallet_value ORDER BY sigs_seen DESC LIMIT 1`;
    const w = rows[0].wallet;
    console.log("wallet:", w);
    const r = await fetch(`https://api.helius.xyz/v0/addresses/${w}/transactions?api-key=${key}&limit=15`);
    const txs = await r.json();
    let swaps = 0;
    for (const tx of txs) {
        if (tx.type !== "SWAP") continue;
        swaps++;
        const tt = (tx.tokenTransfers || []).map((t) => `${t.mint?.slice(0, 6)}… ${t.fromUserAccount === w ? "-" : "+"}${t.tokenAmount}`);
        const nt = (tx.nativeTransfers || []).filter((n) => n.fromUserAccount === w || n.toUserAccount === w).map((n) => `${(n.amount / 1e9).toFixed(4)} SOL ${n.fromUserAccount === w ? "out" : "in"}`);
        console.log(`\nSWAP ${tx.signature.slice(0, 12)}…  nativeSOL(net wallet): ${nt.join(", ") || "none"}`);
        console.log(`  tokenTransfers: ${tt.slice(0, 6).join(" | ")}`);
        if (swaps >= 4) break;
    }
    console.log(`\n(swaps seen in first 15 txs: ${swaps})`);
    await q.end();
})();
