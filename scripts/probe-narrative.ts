// One-shot diagnostic: probe the OmniRoute chat-completions endpoint and show
// the raw status + body shape the narrative scorer has to parse.
// Run: npx tsx scripts/probe-narrative.ts
const body = {
    model: process.argv[2] ?? "auto/best-fast",
    stream: false,
    max_tokens: 512,
    messages: [
        { role: "system", content: "You are a memecoin narrative analyst. Reply with ONLY a JSON object: {\"score\": number 0-100, \"narrative\": \"short hook phrase\", \"reasoning\": \"one sentence\"}" },
        { role: "user", content: "New token launch: symbol \"FLOKI\", name \"Floki Inu\", dex pumpswap, liquidity $42000. Score its narrative strength." },
    ],
};

(async () => {
    const r = await fetch("http://127.0.0.1:20128/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer omniroute" },
        body: JSON.stringify(body),
    });
    console.log("STATUS", r.status, "| content-type:", r.headers.get("content-type"));
    const t = await r.text();
    console.log(t.slice(0, 1500));
})();
