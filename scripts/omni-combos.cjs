// Query the OmniRoute management API for combos using the loopback CLI token.
const TOK = "c3141fe279e504696e82d920d505211959c190ba43b5ce7a337033a8dda66a29";
const LEGACY = "13f3a5eaee178b616af2cf855cbf8bd9";

async function tryToken(label, token) {
    const r = await fetch("http://127.0.0.1:20128/api/combos?limit=200", {
        headers: { "x-omniroute-cli-token": token },
    });
    const text = await r.text();
    console.log(`\n== ${label}: HTTP ${r.status} ==`);
    if (r.status !== 200) {
        console.log(text.slice(0, 200));
        return null;
    }
    return JSON.parse(text);
}

(async () => {
    let data = await tryToken("machineToken", TOK);
    if (!data) data = await tryToken("legacy", LEGACY);
    if (!data) return;
    const combos = data.combos || [];
    console.log("combo count:", combos.length);
    for (const c of combos) {
        if (/best-coding|coding/i.test(c.name || "")) {
            console.log(`\n### ${c.name} (id=${c.id}) strategy=${c.strategy}`);
            console.log(JSON.stringify(c.models ?? c.config ?? c, null, 2).slice(0, 1200));
        }
    }
})();
