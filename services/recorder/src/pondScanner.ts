/**
 * POND SCANNER — the Market R&D organ that counteracts edge decay.
 *
 * The report's 30-day half-life assumes allocation stands still while the
 * market moves. This job makes allocation TRACK the live pond map instead:
 * every venue the recorder observes walks a lifecycle computed from rolling
 * 24h evidence, and the trader's prime set follows it automatically.
 *
 *   observed ──(n≥8, early promise)──► watchlist ──(n≥15, win≥35%, rug≤25%)──► promoted
 *        ▲                                  ▲                                      │
 *        └────────── new venue seen         └───────(decay: win<20% or rug>40%)────┘
 *
 *   core    = established volume venues — traded normally, no boost
 *   blocked = entry-blocked (bags-fm class) — stays observed for readmission,
 *             but transition out is a HUMAN decision, never automatic
 *
 * Promotion is earned on RECORDER evidence (every safety-passed candidate is
 * watched whether we trade it or not), so a brand-new venue can qualify before
 * a dollar is risked there — the Blue Ocean discovery path. Demotion is the
 * decay defense: a cooling pond loses its boost on data, not on memory.
 */
import { auditLog, db } from "@hermes/db";
import { sql } from "drizzle-orm";
import type { loadConfig } from "@hermes/core";

type Cfg = ReturnType<typeof loadConfig>;

const SEED_STATES: Record<string, string> = {
  "meteora-damm-v2": "core",
  pumpswap: "core",
  "pump-amm": "core",
  "meteora-dbc": "core",
  fluxbeam: "promoted",
  "bags-fm": "blocked",
};

let lastScan = 0;

export async function scanPonds(cfg: Cfg): Promise<void> {
  if (Date.now() - lastScan < cfg.POND_SCAN_MS) return;
  lastScan = Date.now();
  try {
    await scanPondsInner(cfg);
  } catch (err) {
    console.error(`pond scan failed: ${err instanceof Error ? err.message : err}`);
  }
  try {
    await scanHours(cfg);
  } catch (err) {
    console.error(`hour policy scan failed: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * HOUR POLICY — classify each ET hour-of-day by its own measured economics.
 * prime = enough closed trades AND positive realized → full size;
 * probe = enough trades AND negative realized → OFF_HOURS_SIZE_MULT;
 * unmeasured = thin sample → the trader falls back to static PRIME_HOURS_UTC.
 * Written to config `hour_policy`; the trader reads it cached. Audited only
 * when the classification SET changes, so the log stays quiet.
 */
let lastHourPolicy = "";
async function scanHours(cfg: Cfg): Promise<void> {
  if (!cfg.HOUR_POLICY_ENABLED) return;
  const rows = (await db.execute(sql`
    select extract(hour from p.opened_at at time zone 'America/New_York')::int as h,
      count(*)::int as n, sum(p.realized_pnl_usd::float) as pnl
    from positions p where p.status = 'closed'
    group by 1
  `)) as unknown as { h: number; n: number; pnl: number | null }[];

  const hours: Record<number, string> = {};
  for (let h = 0; h < 24; h++) hours[h] = "unmeasured";
  for (const r of rows) {
    if (r.n < cfg.HOUR_POLICY_MIN_TRADES) continue;
    const pnl = r.pnl ?? 0;
    if (pnl >= cfg.HOUR_POLICY_MIN_PNL_USD) hours[r.h] = "prime";
    else if (pnl <= -cfg.HOUR_POLICY_MIN_PNL_USD) hours[r.h] = "probe";
    // measured-but-flat stays unmeasured → static declaration decides
  }

  const fingerprint = Object.values(hours).join("");
  await db.execute(sql`
    insert into config (key, value)
    values ('hour_policy', ${JSON.stringify({ hours, computedAt: new Date().toISOString() })}::jsonb)
    on conflict (key) do update set value = excluded.value, updated_at = now()
  `);
  if (fingerprint !== lastHourPolicy && lastHourPolicy !== "") {
    const prime = Object.entries(hours).filter(([, v]) => v === "prime").map(([k]) => k);
    const probe = Object.entries(hours).filter(([, v]) => v === "probe").map(([k]) => k);
    await db.insert(auditLog).values({
      actor: "recorder",
      action: "hour_policy_update",
      details: { primeET: prime, probeET: probe },
    });
    console.log(`🕐 HOUR POLICY — prime ET [${prime.join(",")}] · probe ET [${probe.join(",")}]`);
  }
  lastHourPolicy = fingerprint;
}

interface VenueRow {
  venue: string;
  watched: number;
  wins: number;
  rugs: number;
  avg_peak: number | null;
  traded: number;
  realized: number | null;
  state: string | null;
  state_since: Date | null;
}

async function scanPondsInner(cfg: Cfg): Promise<void> {
  // Rolling 24h per-venue evidence: recorder outcomes (the hypothetical
  // universe) LEFT JOIN traded results, joined to any existing lifecycle row.
  const rows = (await db.execute(sql`
    with watched as (
      select lower(t.dex) as venue,
        count(*)::int as watched,
        sum((o.label = 'winner')::int)::int as wins,
        sum((o.label = 'rug')::int)::int as rugs,
        avg(o.peak_multiple)::float as avg_peak
      from candidate_outcomes o
      join tokens t on t.mint = o.mint
      where o.first_seen_at > now() - interval '24 hours'
        and o.label in ('winner','dud','rug')
        and t.dex is not null
      group by 1
    ),
    traded as (
      select lower(t.dex) as venue,
        count(*)::int as traded,
        sum(p.realized_pnl_usd::float) as realized
      from positions p
      join tokens t on t.mint = p.mint
      where p.status = 'closed' and p.closed_at > now() - interval '24 hours'
      group by 1
    )
    select w.venue, w.watched, w.wins, w.rugs, w.avg_peak,
      coalesce(tr.traded, 0) as traded, tr.realized,
      vi.state, vi.state_since
    from watched w
    left join traded tr on tr.venue = w.venue
    left join venue_intel vi on vi.venue = w.venue
  `)) as unknown as VenueRow[];

  for (const r of rows) {
    const win = r.watched > 0 ? r.wins / r.watched : 0;
    const rug = r.watched > 0 ? r.rugs / r.watched : 0;
    const prevState = r.state;
    let state = prevState ?? SEED_STATES[r.venue] ?? "observed";

    // Lifecycle transitions — blocked and core are sticky (human decisions);
    // hysteresis: promote gate is strictly harder than the demote gate.
    if (state === "observed" && r.watched >= cfg.POND_WATCH_MIN_N && rug <= 0.5 && (win >= 0.25 || (r.avg_peak ?? 1) >= 1.5)) {
      state = "watchlist";
    }
    if (state === "watchlist" && r.watched >= cfg.POND_PROMOTE_MIN_N && win >= cfg.POND_PROMOTE_WIN && rug <= cfg.POND_PROMOTE_MAX_RUG) {
      state = "promoted";
    }
    if (state === "promoted" && r.watched >= 10 && (win < cfg.POND_DEMOTE_WIN || rug > cfg.POND_DEMOTE_RUG)) {
      state = "watchlist"; // decay demotion — the boost is rented, not owned
    }

    const changed = prevState !== null && prevState !== undefined && prevState !== state;
    const discovered = prevState === null || prevState === undefined;

    await db.execute(sql`
      insert into venue_intel (venue, state, watched_24h, win_rate_24h, rug_rate_24h, avg_peak_24h, traded_24h, realized_24h, state_since, updated_at)
      values (${r.venue}, ${state}, ${r.watched}, ${win.toFixed(4)}, ${rug.toFixed(4)}, ${(r.avg_peak ?? 1).toFixed(4)}, ${r.traded}, ${r.realized ?? 0}, now(), now())
      on conflict (venue) do update set
        state = ${state},
        watched_24h = ${r.watched},
        win_rate_24h = ${win.toFixed(4)},
        rug_rate_24h = ${rug.toFixed(4)},
        avg_peak_24h = ${(r.avg_peak ?? 1).toFixed(4)},
        traded_24h = ${r.traded},
        realized_24h = ${r.realized ?? 0},
        state_since = case when venue_intel.state = ${state} then venue_intel.state_since else now() end,
        updated_at = now()
    `);

    if (discovered && !(r.venue in SEED_STATES)) {
      await db.insert(auditLog).values({
        actor: "recorder",
        action: "pond_discovered",
        details: { venue: r.venue, watched: r.watched, win: Number(win.toFixed(2)), rug: Number(rug.toFixed(2)) },
      });
      console.log(`🌊 NEW POND ${r.venue} — ${r.watched} watched, win ${(win * 100).toFixed(0)}%, rug ${(rug * 100).toFixed(0)}%`);
    } else if (changed) {
      const up = state === "promoted" || (state === "watchlist" && prevState === "observed");
      await db.insert(auditLog).values({
        actor: "recorder",
        action: up ? "pond_promoted" : "pond_demoted",
        details: { venue: r.venue, from: prevState, to: state, watched: r.watched, win: Number(win.toFixed(2)), rug: Number(rug.toFixed(2)) },
      });
      console.log(`${up ? "🏆" : "🍂"} POND ${r.venue}: ${prevState} → ${state} (n=${r.watched}, win ${(win * 100).toFixed(0)}%, rug ${(rug * 100).toFixed(0)}%)`);
    }
  }
}
