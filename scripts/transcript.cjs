// Fetch a YouTube transcript, trying multiple Invidious instances until one
// returns a non-empty caption body. Strips XML to plain text.
const VID = "gMVWRNGgIdc";
const BASES = [
    "https://inv.nadeko.net",
    "https://invidious.nerdvpn.de",
    "https://invidious.f5.si",
    "https://yewtu.be",
    "inv.tux.pizza".replace(/^/, "https://"),
    "https://vid.puffyan.us",
    "https://invidious.lunar.icu",
];

function decode(s) {
    return s
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n/g, " ");
}

async function tryInstance(base) {
    const list = await fetch(`${base}/api/v1/captions/${VID}`, { signal: AbortSignal.timeout(12000) }).then((r) => r.json());
    const cap = (list.captions || []).find((c) => /english/i.test(c.label)) || list.captions?.[0];
    if (!cap) return { base, err: "no captions" };
    const r = await fetch(`${base}${cap.url}`, { signal: AbortSignal.timeout(15000) });
    const xml = await r.text();
    if (!xml || xml.length < 200) return { base, err: `empty (${xml.length}b)` };
    const texts = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((m) => decode(m[1]).trim());
    const full = texts.join(" ").replace(/\s+/g, " ").trim();
    return { base, full, segs: texts.length };
}

(async () => {
    for (const base of BASES) {
        try {
            const res = await tryInstance(base);
            if (res.full) {
                require("fs").writeFileSync("scripts/transcript.txt", res.full, "utf8");
                console.log(`SUCCESS via ${base} — ${res.segs} segments, ${res.full.split(" ").length} words`);
                console.log("\n=== FIRST 1500 chars ===\n" + res.full.slice(0, 1500));
                return;
            }
            console.log(`${base}: ${res.err}`);
        } catch (e) {
            console.log(`${base}: FAIL ${e instanceof Error ? e.message : e}`);
        }
    }
    console.log("\nALL INSTANCES FAILED");
})();
