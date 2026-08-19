// Inspect OmniRoute storage: list tables, then dump combo/route definitions.
const db = require("better-sqlite3")("/app/data/storage.sqlite");
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
console.log("TABLES:", JSON.stringify(tables));
// Show schema of any table that looks like combos/routes/providers
for (const t of tables) {
    if (/combo|route|alias|provider|model|strateg/i.test(t)) {
        const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
        const n = db.prepare(`SELECT count(*) c FROM ${t}`).get().c;
        console.log(`\n== ${t} (${n} rows) cols: ${cols.join(",")}`);
    }
}
