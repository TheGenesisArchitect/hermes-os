// Probe the exact external endpoints the platform depends on, with timing.
const targets = [
    ["DexScreener", "https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112"],
    ["Jupiter", "https://lite-api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000&slippageBps=50"],
    ["JupiterPrice", "https://datapi.jup.ag/v1/pools?ids=So11111111111111111111111111111111111111112"],
    ["GeckoTerminal", "https://api.geckoterminal.com/api/v2/networks/solana/tokens/So11111111111111111111111111111111111111112"],
    ["RugCheck", "https://api.rugcheck.xyz/v1/tokens/So11111111111111111111111111111111111111112/report"],
    ["RPC-helius", "https://mainnet.helius-rpc.com"],
    ["RPC-publicnode", "https://solana-rpc.publicnode.com"],
    ["RPC-mainnet-beta", "https://api.mainnet-beta.solana.com"],
];
(async () => {
    for (const [name, url] of targets) {
        const t = Date.now();
        try {
            const r = await fetch(url, {
                signal: AbortSignal.timeout(12000), method: url.includes("mainnet") && !url.includes("datapi") ? "POST" : "GET",
                headers: { "content-type": "application/json" },
                body: url.includes("mainnet") && !url.includes("datapi") && !url.includes("gecko") && !url.includes("rugcheck") ? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }) : undefined,
            });
            console.log(`${name.padEnd(18)} HTTP ${r.status}  ${Date.now() - t}ms`);
        } catch (e) {
            console.log(`${name.padEnd(18)} FAIL  ${Date.now() - t}ms  ${e instanceof Error ? e.message : e}`);
        }
    }
})();
