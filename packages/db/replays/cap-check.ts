import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url"; import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1]!.trim();
const q = postgres(url);
const rows = await q.unsafe(`
  SELECT a.action, a.details->>'inflow' AS inflow, a.details->>'from' AS f, a.details->>'to' AS t, a.created_at
  FROM audit_log a WHERE a.created_at > now() - interval '10 minutes'
    AND a.action IN ('entry_subfloor_probe_cap','entry_mandate_size','entry_moonshot_tier','entry_sensor_tier')
  ORDER BY a.created_at DESC LIMIT 10`);
for (const r of rows as any[]) console.log(`${new Date(r.created_at).toISOString().slice(11,19)} ${r.action} inflow=${r.inflow == null ? "—" : Number(r.inflow).toFixed(2)} ${r.f ?? ""}→${r.t ?? ""}`);
const opens = await q.unsafe(`
  SELECT p.size_usd, p.signature, co.liq_growth FROM positions p
  LEFT JOIN candidate_outcomes co ON co.mint = p.mint
  WHERE p.opened_at > now() - interval '10 minutes' AND p.lane='paper' ORDER BY p.opened_at DESC LIMIT 8`);
console.log("recent opens:");
for (const o of opens as any[]) console.log(`  $${o.size_usd} ${o.signature} lg=${o.liq_growth == null ? "—" : Number(o.liq_growth).toFixed(2)}`);
await q.end();
