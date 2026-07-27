import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);
// The three live Nongwan mints: how did each measure at decision time, and
// which door admitted them?
const mints = await sql`
  SELECT t.mint, t.symbol, t.dex, co.liq_growth::float lg, co.label, co.signature,
         (SELECT count(*) FROM token_deployers d WHERE d.mint = t.mint) AS fingerprinted
  FROM tokens t LEFT JOIN candidate_outcomes co ON co.mint = t.mint
  WHERE t.mint IN (SELECT p.mint FROM positions p WHERE p.lane='live' AND p.opened_at > now() - interval '4 hours')`;
for (const m of mints) console.log(`${m.symbol} ${m.mint.slice(0,6)} dex=${m.dex} lg=${m.lg} label=${m.label} sig=${m.signature} deployer-fingerprinted=${m.fingerprinted}`);
const doors = await sql`
  SELECT created_at, action, details->>'reason' r FROM audit_log
  WHERE created_at > now() - interval '4 hours'
    AND action IN ('live_rugrisk_formula','live_mandate_ticket','live_open')
  ORDER BY created_at ASC LIMIT 15`;
for (const d of doors) console.log(new Date(d.created_at).toISOString().slice(11,19), d.action, (d.r ?? '').slice(0,130));
await sql.end();
