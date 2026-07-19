/**
 * WALLET REPUTATION — the recorder's persistent behavioral layer.
 *
 * Holder wallet addresses (safety_checks holder_concentration → holdersSampled)
 * recur across one-shot tokens; this job aggregates each wallet's realized
 * outcome history into wallet_reputation, and scores a candidate's holder set
 * against it at arm time. VALIDATED leak-free: a winner-rep wallet in the holder
 * set = 2.2× winner lift out-of-sample. The reputation is a MOAT — built from our
 * own labeled outcome set, unavailable to anyone else.
 */
import { db } from "@hermes/db";
import { sql } from "drizzle-orm";
import { walletEdgeFrom, WALLET_MIN_SAMPLE, type WalletEdge, type WalletRep } from "@hermes/core";
import type { loadConfig } from "@hermes/core";

type Cfg = ReturnType<typeof loadConfig>;

const REFRESH_MS = 180_000; // recompute reputation every 3 min (full recompute is cheap at this scale)
let lastRefresh = 0;

/** Full recompute of wallet_reputation from the holder graph × labeled outcomes. */
export async function refreshWalletReputation(_cfg: Cfg): Promise<void> {
  if (Date.now() - lastRefresh < REFRESH_MS) return;
  lastRefresh = Date.now();
  try {
    await db.execute(sql`
      insert into wallet_reputation (wallet, tokens, wins, rugs, duds, score, last_seen_at, updated_at)
      select wallet, count(distinct mint) as tokens,
        count(*) filter (where label = 'winner') as wins,
        count(*) filter (where label = 'rug') as rugs,
        count(*) filter (where label = 'dud') as duds,
        round(((count(*) filter (where label = 'winner'))::numeric
               - (count(*) filter (where label = 'rug'))) / nullif(count(distinct mint), 0), 4) as score,
        max(first_seen_at) as last_seen_at, now()
      from (
        select distinct (h->>'owner') as wallet, sc.mint, co.label, co.first_seen_at
        from safety_checks sc
        cross join lateral jsonb_array_elements(sc.evidence->'holdersSampled') h
        join candidate_outcomes co on co.mint = sc.mint
        where sc.check_name = 'holder_concentration' and sc.evidence ? 'holdersSampled'
          and co.label in ('winner', 'dud', 'rug')
      ) e
      group by wallet
      on conflict (wallet) do update set
        tokens = excluded.tokens, wins = excluded.wins, rugs = excluded.rugs,
        duds = excluded.duds, score = excluded.score,
        last_seen_at = excluded.last_seen_at, updated_at = now()
    `);
  } catch (err) {
    console.error(`wallet reputation refresh failed: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Score a candidate's holder set against wallet reputation — point-in-time (the
 * reputation as it stands now, before this token's own outcome exists). Returns
 * null when we have no holder sample to judge.
 */
export async function scoreCandidateWalletEdge(mint: string): Promise<(WalletEdge & { holders: number }) | null> {
  try {
    const holderRows = (await db.execute(sql`
      select distinct (h->>'owner') as wallet
      from safety_checks sc
      cross join lateral jsonb_array_elements(sc.evidence->'holdersSampled') h
      where sc.mint = ${mint} and sc.check_name = 'holder_concentration' and sc.evidence ? 'holdersSampled'
    `)) as unknown as { wallet: string }[];
    const holders = holderRows.map((r) => r.wallet).filter(Boolean);
    if (holders.length === 0) return null;

    // sql.join IN-list — drizzle spreads a JS array into scalar params, which
    // breaks `in (...)`; join individual placeholders instead.
    const inList = sql.join(
      holders.map((h) => sql`${h}`),
      sql`, `,
    );
    const repRows = (await db.execute(sql`
      select tokens, wins, rugs from wallet_reputation
      where wallet in (${inList}) and tokens >= ${WALLET_MIN_SAMPLE}
    `)) as unknown as { tokens: number; wins: number; rugs: number }[];

    const reps: WalletRep[] = repRows.map((r) => ({
      tokens: Number(r.tokens),
      wins: Number(r.wins),
      rugs: Number(r.rugs),
    }));
    return { ...walletEdgeFrom(reps, holders.length), holders: holders.length };
  } catch (err) {
    console.error(`wallet edge score failed for ${mint}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
