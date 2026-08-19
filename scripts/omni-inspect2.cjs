// Inspect OmniRoute storage from within /app so its deps resolve.
process.env.NODE_PATH = "/app/node_modules";
require("module").Module._initPaths();
const db = require("better-sqlite3")("/app/data/storage.sqlite");
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
console.log("TABLES:", JSON.stringify(tables));
for (const t of tables) {
    if (/key|combo|provider|model|strateg|setting|config/i.test(t)) {
        try {
            const n = db.prepare(`SELECT count(*) c FROM ${t}`).get().c;
            console.log(`\n== ${t} (${n} rows)`);
        } catch (e) { console.log(`\n== ${t} (count err ${e.message})`); }
    }
}
