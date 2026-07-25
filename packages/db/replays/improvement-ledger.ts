/**
 * IMPROVEMENT LEDGER — what did the trade-management stack DO over the window,
 * component by component, each scored against its counterfactual.
 * Run: npx tsx packages/db/replays/improvement-ledger.ts [hours=8]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const url = /DATABASE_URL=(.+)/.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))![1].trim();
const sql = postgres(url);
const H = Number(process.argv[2] ?? 8);
const iv = sql`now() - interval '1 hour' * ${H}`;

console.log(`══ BASELINE (${H}h) ══`);
for (const lane of ["paper", "live"]) {
  const [m] = await sql`
    SELECT count(*)::int AS n, round(sum(realized_pnl_usd::float)::numeric,2) AS pnl,
           count(*) FILTER (WHERE realized_pnl_usd::float > 0)::int AS w
    FROM positions WHERE lane=${lane} AND closed_at > ${iv} AND status='closed'`;
  console.log(`${lane.toUpperCase().padEnd(5)} ${m.n} closed · ${m.w}/${m.n} wins · $${m.pnl ?? 0}`);
}

console.log(`\n══ COMPONENT LEDGER ══`);
// 1. Depth rail: actual vs full-loss-of-basis counterfactual.
const cuts = await sql`
  SELECT lane, count(*)::int AS n, round(sum(realized_pnl_usd::float)::numeric,2) AS pnl,
         round(sum(size_usd::float)::numeric,2) AS basis
  FROM positions WHERE closed_at > ${iv} AND exit_reason='depth_collapse_cut' GROUP BY lane`;
let railSaved = 0;
for (const r of cuts) {
  const saved = Number(r.basis) + Number(r.pnl); // counterfactual = -basis
  railSaved += saved;
  console.log(`depth rail ${r.lane === "live" ? "◆" : " "} n=${r.n} · booked $${r.pnl} vs −$${r.basis} full-loss counterfactual → SAVED $${saved.toFixed(2)}`);
}

// 2. Size governors: capped entries that then LOST — loss avoided at pre-cap size.
const caps = await sql`
  SELECT a.action, (a.details->>'from')::float AS f, (a.details->>'to')::float AS t2, a.details->>'mint' AS mint, a.created_at
  FROM audit_log a WHERE a.created_at > ${iv} AND a.action IN ('entry_slot_cap','entry_depth_scaled','entry_second_launch','entry_sensor_tier','entry_recovered_tier')
    AND a.details->>'from' IS NOT NULL`;
let capSaved = 0, capCost = 0;
for (const c of caps) {
  const [pos] = await sql`
    SELECT realized_pnl_usd::float AS pnl, size_usd::float AS s FROM positions
    WHERE mint = ${c.mint} AND lane='paper' AND status='closed'
      AND opened_at BETWEEN ${c.created_at}::timestamptz - interval '2 min' AND ${c.created_at}::timestamptz + interval '2 min' LIMIT 1`;
  if (!pos || !pos.s || !c.f || !c.t2) continue;
  const scale = c.f / c.t2; // what the P&L would scale to at pre-cap size
  const delta = pos.pnl * (scale - 1); // counterfactual − actual (positive pnl → we "lost" upside; negative → we saved)
  if (delta < 0) capSaved += -delta; else capCost += delta;
}
console.log(`size governors (slot cap/depth scale/tier demotions with from→to): losses avoided $${capSaved.toFixed(2)} · winner upside forgone $${capCost.toFixed(2)} → NET $${(capSaved - capCost).toFixed(2)}`);

// 3. Micro-TPs banked.
const [micro] = await sql`
  SELECT count(*)::int AS n, round(sum(f.qty_tokens::float * f.price_usd::float)::numeric,2) AS proceeds
  FROM fills f JOIN positions p ON p.id = f.position_id
  WHERE f.reason='take_profit_micro' AND f.filled_at > ${iv}`;
console.log(`micro-TPs: ${micro.n} fills · $${micro.proceeds ?? 0} banked into strength`);

// 4. MOON armed capture vs pre-floor-removal 29% baseline.
const [moon] = await sql`
  SELECT count(*)::int AS n,
         round(sum(realized_pnl_usd::float)::numeric,2) AS pnl,
         round(sum(CASE WHEN entry_price_usd::float>0 AND peak_price_usd::float/entry_price_usd::float>1
                        THEN (peak_price_usd::float/entry_price_usd::float-1)*size_usd::float ELSE 0 END)::numeric,2) AS offered
  FROM positions WHERE lane='paper' AND status='closed' AND closed_at > ${iv}
    AND signature LIKE 'MOON%' AND entry_price_usd::float > 0 AND peak_price_usd::float/entry_price_usd::float >= 1.2`;
const mcap = moon.offered && Number(moon.offered) > 0 ? Math.round((100*Number(moon.pnl ?? 0))/Number(moon.offered)) : null;
console.log(`MOON armed capture: ${mcap ?? "—"}% on $${moon.offered ?? 0} offered (n=${moon.n}) vs 29% pre-floor-removal baseline → delta $${moon.offered ? ((Number(moon.pnl ?? 0)) - 0.29*Number(moon.offered)).toFixed(2) : "—"}`);

// 5. Sub-floor tickets (live, since ratification).
const [sft] = await sql`
  SELECT count(*)::int AS n FROM audit_log WHERE action='live_subfloor_ticket' AND created_at > ${iv}`;
console.log(`sub-floor tickets fired (live): ${sft.n}`);

// 6. Rungless-death tax vs benchmark (≤25% of gross wins).
const [tax] = await sql`
  SELECT round(sum(realized_pnl_usd::float) FILTER (WHERE realized_pnl_usd::float > 0)::numeric,2) AS gw,
         round(abs(sum(p.realized_pnl_usd::float) FILTER (
           WHERE p.realized_pnl_usd::float < -0.3*p.size_usd::float
             AND NOT EXISTS (SELECT 1 FROM fills f WHERE f.position_id=p.id AND f.side='sell' AND f.reason LIKE 'take_profit%')))::numeric,2) AS rungless
  FROM positions p WHERE lane='paper' AND status='closed' AND closed_at > ${iv}`;
console.log(`benchmark #3 — rungless tax: $${tax.rungless ?? 0} vs gross wins $${tax.gw ?? 0} = ${tax.gw && Number(tax.gw)>0 ? Math.round((100*Number(tax.rungless ?? 0))/Number(tax.gw)) : "—"}% (bar ≤25%)`);
await sql.end();
