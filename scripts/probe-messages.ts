// Probe which provider each picker alias resolves to through the Messages route.
// Run: npx tsx scripts/probe-messages.ts
const aliases = ["auto/best-reasoning", "auto/best-coding", "auto/best-fast", "auto/coding:free"];
(async () => {
    for (const model of aliases) {
        try {
            const r = await fetch("http://127.0.0.1:20128/v1/messages", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-api-key": "omniroute-local",
                    "anthropic-version": "2023-06-01",
                },
                body: JSON.stringify({
                    model,
                    max_tokens: 32,
                    messages: [{ role: "user", content: "Reply with the single word: READY" }],
                }),
                signal: AbortSignal.timeout(45_000),
            });
            const j = (await r.json()) as { model?: string; content?: { text?: string }[] };
            const text = j.content?.map((c) => c.text).join("") ?? "";
            console.log(`${model.padEnd(22)} → ${String(j.model).padEnd(20)} status=${r.status}  reply="${text.slice(0, 40)}"`);
        } catch (e) {
            console.log(`${model.padEnd(22)} → ERROR ${e instanceof Error ? e.message : e}`);
        }
    }
})();
