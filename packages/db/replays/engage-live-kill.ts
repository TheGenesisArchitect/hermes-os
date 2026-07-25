import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);
const value = { enabled: true, reason: "operator-ordered full audit 2026-07-25", at: new Date().toISOString() };
await sql`
  INSERT INTO config (key, value, updated_at) VALUES ('live_kill', ${sql.json(value)}, now())
  ON CONFLICT (key) DO UPDATE SET value = ${sql.json(value)}, updated_at = now()`;
await sql`
  INSERT INTO audit_log (actor, action, details)
  VALUES ('user', 'live_kill_engaged', ${sql.json({ reason: "operator-ordered full audit — find the money", via: "desk" })})`;
const [chk] = await sql`SELECT value FROM config WHERE key = 'live_kill'`;
console.log("live_kill:", JSON.stringify(chk.value));
const open = await sql`SELECT count(*)::int AS n FROM positions WHERE lane = 'live' AND status = 'open'`;
console.log("open live positions:", open[0].n);
await sql.end();
