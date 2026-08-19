// Check whether Helius enhanced-transactions API is reachable through the filter.
const fs = require("fs");
const env = fs.readFileSync("C:/Users/mrbee/Projects/hermes-os/.env", "utf8");
const key = /HELIUS_API_KEY=(.+)/.exec(env)?.[1]?.trim();
(async () => {
    const u = `https://api.helius.xyz/v0/addresses/So11111111111111111111111111111111111111112/transactions?api-key=${key}&limit=1`;
    try {
        const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
        const t = await r.text();
        console.log("enhanced API:", r.status, t.length, "bytes");
    } catch (e) {
        console.log("enhanced API FAIL:", e instanceof Error ? e.message : e);
    }
})();
