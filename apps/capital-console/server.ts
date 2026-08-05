/**
 * CAPITAL ALLOCATION CONSOLE v0 (approved plan, gate #3 vehicle).
 * READ-ONLY BY CONSTRUCTION: zero-dependency HTTP server (no framework — more
 * insulated than the planned Next shell, which becomes the P2 upgrade), one
 * SQL client, SELECT-only, no wallet env, port 3900, own log. A crash here
 * touches nothing. Four v1 workspaces on one auto-refreshing page:
 * Command · Opportunity Market (shadow) · Manifest & Optimizer · Attribution.
 * Run: npx tsx apps/capital-console/server.ts   (log: capital-console.log)
 */
import http from "node:http";
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import postgres from "../../packages/db/node_modules/postgres/src/index.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(env)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const q = postgres(url, { idle_timeout: 10, max: 3 });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
const usd = (x: unknown) => { const v = Number(x ?? 0); return `${v < 0 ? "−" : "+"}$${Math.abs(v).toFixed(2)}`; };

async function page(): Promise<string> {
  const [cmd] = await q`SELECT
    (SELECT equity_usd::float FROM pnl_snapshots WHERE lane='live' ORDER BY snapped_at DESC LIMIT 1) le,
    (SELECT equity_usd::float FROM pnl_snapshots WHERE lane='paper' ORDER BY snapped_at DESC LIMIT 1) pe,
    (SELECT coalesce(sum(realized_pnl_usd::float),0) FROM positions WHERE lane='live' AND closed_at>date_trunc('day',now())) lp,
    (SELECT coalesce(sum(realized_pnl_usd::float),0) FROM positions WHERE lane='paper' AND closed_at>date_trunc('day',now())) pp,
    (SELECT count(*) FROM positions WHERE lane='live' AND status='open') seats,
    (SELECT value FROM config WHERE key='live_kill') kill,
    (SELECT value FROM config WHERE key='selection_dial') dial,
    (SELECT value FROM config WHERE key='truth_agreement') truth,
    (SELECT value->>'version' FROM config WHERE key='formula_manifest') mv,
    (SELECT coalesce(jsonb_array_length(value->'deltas'),0) FROM config WHERE key='formula_manifest_proposal') deltas`;
  const dial = (cmd!.dial ?? {}) as Record<string, unknown>;
  const kill = (cmd!.kill ?? {}) as Record<string, unknown>;
  const market = await q`SELECT rank, symbol, dex, signature, cell_ev, confidence, score, tier
    FROM queue_snapshots WHERE snapped_at = (SELECT max(snapped_at) FROM queue_snapshots) ORDER BY rank LIMIT 15`;
  // MARKET TRUTH — hourly observation-health report (tech spec v2 §4/§5).
  const [th] = await q`
    SELECT count(*) FILTER (WHERE gap>10) gaps10, count(*) total, round(avg(gap)::numeric,1) avg_gap,
      round(max(gap)::numeric,0) worst
    FROM (SELECT extract(epoch from (snapped_at - lag(snapped_at) OVER (PARTITION BY position_id ORDER BY snapped_at))) gap
          FROM position_ticks WHERE snapped_at > now() - interval '1 hour') g WHERE gap IS NOT NULL`;
  const [rf] = await q`
    WITH c AS (SELECT p.id, p.tier,
      (SELECT max(mark_multiple::float) FROM position_ticks WHERE position_id=p.id) pk,
      (SELECT count(*) FROM fills f WHERE f.position_id=p.id AND f.side='sell' AND f.reason LIKE 'take_profit%') tp
      FROM positions p WHERE p.lane='paper' AND p.status='closed' AND p.closed_at > now() - interval '6 hours')
    SELECT count(*) FILTER (WHERE pk>=1.15 AND tier<>'moonshot') qualified,
           count(*) FILTER (WHERE pk>=1.15 AND tier<>'moonshot' AND tp>0) fired FROM c`;
  const [ho] = await q`SELECT count(*) n FROM audit_log WHERE action='feed_outage' AND created_at > now() - interval '24 hours'`;
  // ── OFFER vs CAPTURE — THE CORE KPI (operator, 2026-08-05) ────────────────
  // "The success of our system is capturing what the market is ACTUALLY
  // offering." Offered = size × (tape high-water on a LIVE pool ÷ entry − 1),
  // i.e. what a position could have paid at its best transactable moment.
  // Captured = realized. Target band 40–70%. This leads the page because it
  // is the number that decides whether live is released.
  const capRows = await q`
    WITH t AS (
      SELECT p.tier, p.size_usd::float sz, p.realized_pnl_usd::float pnl, p.entry_price_usd::float e,
        (SELECT max(ct.price_usd::float) FROM candidate_ticks ct WHERE ct.mint = p.mint
           AND ct.snapped_at BETWEEN p.opened_at AND p.closed_at AND ct.liquidity_usd::float >= 1200) hi
      FROM positions p WHERE p.lane='paper' AND p.status='closed'
        AND p.closed_at > now() - interval '24 hours' AND p.entry_price_usd::float > 0)
    SELECT tier, count(*) n,
      count(*) FILTER (WHERE hi/e >= 1.3) offered_13,
      round(sum(sz*(hi/e-1)) FILTER (WHERE hi > e)::numeric, 2) offered,
      round(sum(pnl)::numeric, 2) captured
    FROM t WHERE hi IS NOT NULL GROUP BY tier ORDER BY offered DESC NULLS LAST`;
  const [f2] = await q`SELECT count(*) n FROM audit_log WHERE action='rung_high_water' AND created_at > now() - interval '24 hours'`;
  const capTotal = capRows.reduce((a, r) => ({ o: a.o + Number(r.offered ?? 0), c: a.c + Number(r.captured ?? 0) }), { o: 0, c: 0 });
  const pctOf = (c: number, o: number) => (o > 0 ? ((100 * c) / o).toFixed(1) + "%" : "—");
  const mani = await q`SELECT key, value FROM config WHERE key IN ('formula_manifest','formula_manifest_proposal')`;
  const attr = await q`
    SELECT coalesce(al.details->>'reason','') gate, count(*) n,
      round(sum(pp.pnl)::numeric,2) paper_counterfactual
    FROM audit_log al LEFT JOIN LATERAL (
      SELECT sum(realized_pnl_usd::float) pnl FROM positions p
      WHERE p.lane='paper' AND p.mint=al.details->>'mint' AND p.closed_at > al.created_at) pp ON true
    WHERE al.action='live_buy_skipped' AND al.created_at > now() - interval '24 hours'
    GROUP BY 1 ORDER BY n DESC LIMIT 10`;
  const m = Object.fromEntries(mani.map((r) => [r.key, r.value]));
  const manifest = (m["formula_manifest"] ?? {}) as Record<string, unknown>;
  const prop = (m["formula_manifest_proposal"] ?? {}) as Record<string, unknown>;
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="30">
<title>Capital Allocation Console</title>
<style>body{font:13px/1.5 ui-monospace,monospace;background:#0b0e14;color:#cdd6f4;margin:2rem;max-width:1100px}
h1{font-size:16px;color:#89b4fa}h2{font-size:13px;color:#a6e3a1;border-bottom:1px solid #313244;margin-top:1.6rem}
table{border-collapse:collapse;width:100%}td,th{padding:2px 10px;text-align:left;border-bottom:1px solid #1e1e2e}
.k{color:#f38ba8}.g{color:#a6e3a1}.d{color:#7f849c}</style>
<h1>▦ CAPITAL ALLOCATION CONSOLE <span class="d">· read-only · refresh 30s · ${new Date().toISOString().slice(11, 19)}Z</span></h1>
<h2>OFFER vs CAPTURE — 24h, trades we TOOK <span class="d">· the core KPI · target band 40–70%</span></h2>
<table><tr><th>tier</th><th>n</th><th>offered ≥1.3×</th><th>offered $</th><th>captured $</th><th>capture %</th></tr>
${capRows.map((r) => `<tr><td>${esc(r.tier)}</td><td>${esc(r.n)}</td><td>${esc(r.offered_13)}</td><td>$${Number(r.offered ?? 0).toFixed(2)}</td><td class="${Number(r.captured) < 0 ? "k" : "g"}">${usd(r.captured)}</td><td><b class="${Number(r.captured) / Math.max(Number(r.offered ?? 0), 1e-9) >= 0.4 ? "g" : "k"}">${pctOf(Number(r.captured ?? 0), Number(r.offered ?? 0))}</b></td></tr>`).join("")}
<tr><td><b>ALL</b></td><td></td><td></td><td><b>$${capTotal.o.toFixed(2)}</b></td><td><b class="${capTotal.c < 0 ? "k" : "g"}">${usd(capTotal.c)}</b></td>
<td><b class="${capTotal.c / Math.max(capTotal.o, 1e-9) >= 0.4 ? "g" : "k"}">${pctOf(capTotal.c, capTotal.o)}</b></td></tr></table>
<div class="d">F2 high-water rungs armed (24h): <b>${esc(f2!.n)}</b> — each one is a rung the manager's polls would have stepped over.</div>
<h2>COMMAND</h2>
<table><tr>
<td>live equity <b>$${Number(cmd!.le ?? 0).toFixed(2)}</b></td><td>paper $${Number(cmd!.pe ?? 0).toFixed(0)}</td>
<td>today L <b>${usd(cmd!.lp)}</b> · P ${usd(cmd!.pp)}</td><td>seats ${esc(cmd!.seats)}/4</td></tr><tr>
<td>kill <b class="${kill.enabled === "true" || kill.enabled === true ? "k" : "g"}">${kill.enabled === "true" || kill.enabled === true ? "ENGAGED" : "clear"}</b></td>
<td>dial MODE ${esc(dial.mode)} · ECR ${esc(dial.ecr ?? "∞")}</td>
<td>waves/h ${esc(dial.wavesPerH)} vs cap ${esc(dial.capacityPerH)}/h</td>
<td>manifest v${esc(cmd!.mv)} · ${esc(cmd!.deltas)} proposal delta(s)</td></tr></table>
<div class="d">${esc(kill.reason ?? "")}</div>
<h2>MARKET TRUTH — observation health (the machinery gap's scoreboard)</h2>
<table><tr>
<td>first-rung fire rate (6h, non-moon) <b>${rf!.qualified > 0 ? Math.round((100 * Number(rf!.fired)) / Number(rf!.qualified)) + "%" : "—"}</b>
 <span class="d">(${esc(rf!.fired)}/${esc(rf!.qualified)}) target ≥70%</span></td>
<td>tick gaps &gt;10s (1h) <b>${esc(th!.gaps10)}</b><span class="d">/${esc(th!.total)}</span></td></tr><tr>
<td>tick cadence avg <b>${esc(th!.avg_gap)}s</b> · worst ${esc(th!.worst)}s <span class="d">target 2s</span></td>
<td>HOLD-ALL events (24h) <b>${esc(ho!.n)}</b> <span class="d">target ≤1 · quorum-only</span></td></tr><tr>
<td>truth agreement (recorder↔aggregator) <b>${cmd!.truth ? ((cmd!.truth as any).recorderVsAggregator * 100).toFixed(1) + "%" : "—"}</b></td>
<td>canonical marks served by tape <b>${cmd!.truth ? esc((cmd!.truth as any).truthUsed) : "—"}</b>
 <span class="d">${cmd!.truth ? "samples " + esc((cmd!.truth as any).samples) : "engine off"}</span></td></tr></table>
<h2>OPPORTUNITY MARKET — latest shadow queue (CAEV-ranked; nothing here trades)</h2>
<table><tr><th>#</th><th>asset</th><th>venue</th><th>genome</th><th>cell EV/t</th><th>conf</th><th>score</th><th>tier</th></tr>
${market.map((r) => `<tr><td>${esc(r.rank)}</td><td>${esc(r.symbol)}</td><td>${esc(r.dex)}</td><td>${esc(r.signature)}</td><td>${usd(r.cell_ev)}</td><td>${Number(r.confidence).toFixed(2)}</td><td><b>${Number(r.score).toFixed(2)}</b></td><td>${esc(r.tier)}</td></tr>`).join("")}
</table>
<h2>MANIFEST v${esc(manifest.version)} & OPTIMIZER PROPOSAL</h2>
<table><tr><td style="vertical-align:top;width:50%"><b>genomes</b><br>${esc(JSON.stringify(manifest.genomes ?? {}))}<br>
<b>elite</b> ${esc(JSON.stringify((manifest as any).elite ?? {}))}<br><b>filler</b> ${esc(JSON.stringify((manifest as any).filler ?? {}))}</td>
<td style="vertical-align:top"><b>proposal</b> (basis v${esc(prop.basedOnVersion)}, ${esc((prop as any).computedAt ?? "")})<br>
drift: ${esc(JSON.stringify((prop as any).drift ?? {}))}<br>
deltas: ${esc(JSON.stringify((prop as any).deltas ?? []))}<br>
withheld: ${esc(JSON.stringify((prop as any).withheldByDrift ?? []))}</td></tr></table>
<h2>ATTRIBUTION — 24h refusals judged by paper counterfactual</h2>
<table><tr><th>gate</th><th>n</th><th>paper realized on refused mints</th></tr>
${attr.map((r) => `<tr><td style="max-width:640px">${esc(r.gate)}</td><td>${esc(r.n)}</td><td>${usd(r.paper_counterfactual)}</td></tr>`).join("")}
</table>
<p class="d">Governing theorem: certified execution converts the distribution to convex capture — selection prioritizes scarce
execution throughput, never manufactures scarcity. Mode changes are operator ratification acts; this console has no controls.</p>`;
}

http.createServer((req, res) => {
  if (req.method !== "GET") { res.writeHead(405).end(); return; }
  page().then((html) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(html); })
    .catch((e) => { res.writeHead(500, { "content-type": "text/plain" }); res.end(`console error (trading unaffected): ${e instanceof Error ? e.message : e}`); });
}).listen(3900, () => console.log("▦ capital console listening on http://localhost:3900 (read-only)"));
