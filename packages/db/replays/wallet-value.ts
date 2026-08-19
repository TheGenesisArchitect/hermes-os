// WALLET-VALUE DIAGNOSTIC (operator 2026-08-14: "our winning wallets only have a
// couple hundred dollars; Orangie/Brez-class wallets have MILLIONS").
//
// QUESTION: does the current `wallet_reputation` "winner" definition surface
// HIGH-VALUE traders, or high-FREQUENCY small-ticket ones? The rep is built from
// holder_concentration samples × outcome LABELS (winner/dud/rug) — it counts
// WINS, never DOLLARS. A wallet that aped $5 into a 2x and a wallet that aped
// $50k into a 2x both count as "1 win". This script measures the value blindness.
//
// Run: npx tsx packages/db/replays/wallet-value.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(env)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";

(async () => {
    const q = postgres(url, { idle_timeout: 8 });

    // 1. The reputation table as it stands: how many wallets, and what's the
    //    "winner" cohort's shape? (tokens/wins/rugs only — note: NO dollar fields).
    const [cov] = await q`
    select count(*)::int wallets,
      count(*) filter (where tokens >= 2 and wins >= 1 and rugs = 0)::int strict_winners,
      count(*) filter (where tokens >= 2 and wins > rugs and wins >= 1)::int net_positive,
      count(*) filter (where rugs >= 2 and wins = 0)::int serial_rugs
    from wallet_reputation`;
    console.log("wallet_reputation census:", JSON.stringify(cov));

    // 2. THE SMOKING GUN: do we even TRACK position size / notional for these
    //    wallets? The rep is derived from safety_checks.holdersSampled — check
    //    whether that evidence carries any value field at all.
    const sample = await q`
    select sc.evidence->'holdersSampled' as holders
    from safety_checks sc
    where sc.check_name='holder_concentration' and sc.evidence ? 'holdersSampled'
    limit 1`;
    console.log("\nholdersSampled evidence shape (what we know about each holder):");
    console.log(JSON.stringify(sample[0]?.holders?.slice?.(0, 3) ?? sample[0]?.holders ?? "none", null, 2));

    // 3. Distribution of "winner" wallets by activity count — are we capturing
    //    prolific traders or one-hit small holders?
    const dist = await q`
    select
      case
        when tokens >= 20 then '20+ tokens (prolific)'
        when tokens >= 10 then '10-19'
        when tokens >= 5  then '5-9'
        when tokens >= 2  then '2-4'
        else '1'
      end as activity_band,
      count(*)::int n,
      count(*) filter (where wins >= 1 and rugs = 0)::int strict_winners
    from wallet_reputation
    group by 1 order by 1`;
    console.log("\nactivity distribution (tokens seen -> wallets):");
    for (const r of dist) console.log("  ", JSON.stringify(r));

    // 4. The top "winners" by our current score — how many tokens, and is there ANY
    //    signal of their scale? (There isn't a dollar column — that's the point.)
    const top = await q`
    select wallet, tokens, wins, rugs, score::float
    from wallet_reputation
    where tokens >= 2 and wins >= 1 and rugs = 0
    order by score desc, wins desc limit 10`;
    console.log("\ntop 10 'winners' by current score (note: wins/tokens only, no $ value):");
    for (const r of top) console.log("  ", r.wallet.slice(0, 12) + "…", "tokens", r.tokens, "wins", r.wins, "score", r.score);

    await q.end();
})();
