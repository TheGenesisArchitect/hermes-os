/**
 * WALLET VALUE WALKER (SPEC-WALLET-GRAPH-VALUE Workstream A — the "A" path).
 *
 * Reconstructs per-wallet realized P&L from on-chain swap history via the Helius
 * enhanced-transactions API (one call = 100 fully-parsed txs, tokenTransfers +
 * nativeTransfers decoded). This is the DOLLAR layer beneath the wallet graph's
 * win-COUNT layer — the dust-vs-whale discriminator.
 *
 * METHOD (per wallet):
 *   Paginate the wallet's parsed history. For each tx, net the wallet's token
 *   deltas per mint and its native (SOL) delta. Attribute only CLEAN swaps —
 *   exactly one mint with a nonzero token delta and an opposite-sign SOL delta —
 *   so multi-token txs and plain transfers never corrupt the accounting (they are
 *   counted and reported as skipped, not silently dropped). Buy: SOL out + fee =
 *   cost. Sell: SOL in − fee = proceeds. Realized per (wallet, mint) = proceeds −
 *   cost basis of the sold portion; tokens still held are unrealized, excluded.
 *
 * SELECTION: wallets ranked by graph activity (tokens seen) — the prolific cohort
 * the rugs===0 rule expelled — plus any holder of a live position. The walk is the
 * expensive step (RPC budget), so it walks TOP_N per run and watermarks for
 * incremental continuation.
 *
 * Run:    npx tsx packages/db/replays/wallet-value-walk.ts [topN=10] [maxPages=50]
 * Tables: packages/db/sql/wallet_value_p5.sql (wallet_trades, wallet_value)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const url = /DATABASE_URL=(.+)/.exec(env)?.[1]?.trim() ?? "postgres://hermes:hermes@localhost:5433/hermes";
const HELIUS_KEY = /HELIUS_API_KEY=(.+)/.exec(env)?.[1]?.trim() ?? "";
if (!HELIUS_KEY) { console.error("HELIUS_API_KEY required for the enhanced-tx walk"); process.exit(1); }

const args = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n > 0);
const TOP_N = args[0] ?? 10;        // wallets per run (RPC budget)
const MAX_PAGES = args[1] ?? 50;    // 100 txs/page → 5k txs max per wallet per run
const SLEEP_MS = 200;               // between API pages — stay well under Helius rate

// Pool/vault authorities are not traders — exclude from candidacy (same set the
// holder-concentration fallback uses).
const POOL_VAULTS = new Set([
    "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", // Raydium AMM v4
    "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL", // Raydium CPMM vault
    "5unTfT2kssBuNvHPY6LbJfJpLqEcdMxGYLWHwShaeTLi", // Meteora DLMM event authority
]);

const LAMPORTS = 1e9;
const WSOL = "So11111111111111111111111111111111111111112"; // wrapped SOL — the cash leg on AMM swaps
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface HeliusTransfer { fromUserAccount?: string; toUserAccount?: string; tokenAmount?: number; mint?: string; amount?: number }
interface HeliusTx {
    signature: string; timestamp?: number; fee?: number; feePayer?: string; type?: string;
    tokenTransfers?: HeliusTransfer[]; nativeTransfers?: HeliusTransfer[];
    transactionError?: unknown;
}

async function heliusPage(wallet: string, before?: string): Promise<HeliusTx[]> {
    const u = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${HELIUS_KEY}&limit=100${before ? `&before=${before}` : ""}`;
    for (let attempt = 1; attempt <= 4; attempt++) {
        const r = await fetch(u, { signal: AbortSignal.timeout(25_000) });
        if (r.status === 429 || r.status >= 500) { await sleep(1_000 * 2 ** (attempt - 1)); continue; }
        if (!r.ok) throw new Error(`Helius HTTP ${r.status}`);
        return (await r.json()) as HeliusTx[];
    }
    throw new Error("Helius rate-limited after retries");
}

async function solPriceUsd(): Promise<number> {
    // DexScreener: the WSOL/USDC pair's priceUsd IS the SOL price. (The datapi
    // pools endpoint answers with tokens quoted AGAINST WSOL, not WSOL itself.)
    try {
        const r = await fetch("https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112", { signal: AbortSignal.timeout(10_000) });
        const j = (await r.json()) as { pairs?: { quoteToken?: { address?: string }; priceUsd?: string }[] };
        const pair = (j.pairs ?? []).find((p) => p.quoteToken?.address === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") ?? (j.pairs ?? [])[0];
        const p = Number(pair?.priceUsd ?? 0);
        return p > 0 ? p : 0;
    } catch { return 0; }
}

interface MintAcc { buys: number; sells: number; tokensBought: number; tokensSold: number; solSpent: number; solReceived: number; first: number | null; last: number | null }
const newAcc = (): MintAcc => ({ buys: 0, sells: 0, tokensBought: 0, tokensSold: 0, solSpent: 0, solReceived: 0, first: null, last: null });

(async () => {
    const q = postgres(url, { idle_timeout: 10 });
    await q.unsafe(fs.readFileSync(path.join(root, "packages/db/sql/wallet_value_p5.sql"), "utf8"));

    // Candidate set: most-active graph wallets (the expelled pros) + live-position
    // holders, excluding pool vaults and already-fully-walked wallets.
    const vaultList = [...POOL_VAULTS];
    const candidates = await q`
    SELECT wr.wallet, wr.tokens FROM wallet_reputation wr
    WHERE NOT (wr.wallet = ANY (${q.array(vaultList)}::text[]))
    ORDER BY wr.tokens DESC
    LIMIT ${TOP_N * 4}`; // over-fetch; some will fail/skip
    const liveHolders = await q`
    SELECT DISTINCT h.value->>'owner' AS wallet
    FROM positions p
    JOIN safety_checks sc ON sc.mint = p.mint AND sc.check_name = 'holder_concentration'
    CROSS JOIN LATERAL jsonb_array_elements(sc.evidence->'holdersSampled') h
    WHERE p.lane = 'live' AND sc.evidence ? 'holdersSampled'`;
    const seen = new Set<string>();
    const walkList: string[] = [];
    for (const r of [...liveHolders.map((x) => ({ wallet: x.wallet as string })), ...candidates]) {
        const w = r.wallet;
        if (!w || POOL_VAULTS.has(w) || seen.has(w)) continue;
        seen.add(w);
        walkList.push(w);
        if (walkList.length >= TOP_N) break;
    }
    console.log(`WALLET VALUE WALK — ${walkList.length} wallets, ≤${MAX_PAGES} pages each (${MAX_PAGES * 100} txs cap)\n`);

    const solUsd = await solPriceUsd();
    console.log(`SOL price for USD conversion: ${solUsd > 0 ? "$" + solUsd.toFixed(2) : "unavailable (SOL-only)"}\n`);

    for (const wallet of walkList) {
        const t0 = Date.now();
        const perMint = new Map<string, MintAcc>();
        let sigs = 0, parsed = 0, counted = 0, skipped = 0, pages = 0, oldestSig: string | null = null, capped = false;
        let before: string | undefined;
        try {
            while (pages < MAX_PAGES) {
                const txs = await heliusPage(wallet, before);
                if (!txs.length) break;
                pages++; sigs += txs.length;
                oldestSig = txs[txs.length - 1]!.signature;
                for (const tx of txs) {
                    if (tx.transactionError) continue; // failed tx moved nothing
                    parsed++;
                    const deltas = new Map<string, number>();
                    for (const tt of tx.tokenTransfers ?? []) {
                        if (!tt.mint) continue;
                        let d = 0;
                        if (tt.toUserAccount === wallet) d += tt.tokenAmount ?? 0;
                        if (tt.fromUserAccount === wallet) d -= tt.tokenAmount ?? 0;
                        if (d !== 0) deltas.set(tt.mint, (deltas.get(tt.mint) ?? 0) + d);
                    }
                    // THE CASH LEG: on Solana AMM swaps the SOL side moves as a WSOL token
                    // transfer (and ALSO shows as native in/out when the tx wraps/unwraps —
                    // counting both double-counts, verified on live txs 2026-08-17). Rule:
                    // WSOL delta is the cash leg when present; native net only when no WSOL.
                    const wsolDelta = deltas.get(WSOL) ?? 0;
                    deltas.delete(WSOL);
                    const nativeIn = (tx.nativeTransfers ?? []).filter((n) => n.toUserAccount === wallet).reduce((s, n) => s + (n.amount ?? 0), 0);
                    const nativeOut = (tx.nativeTransfers ?? []).filter((n) => n.fromUserAccount === wallet).reduce((s, n) => s + (n.amount ?? 0), 0);
                    const cashLeg = wsolDelta !== 0 ? wsolDelta : (nativeIn - nativeOut) / LAMPORTS;
                    const fee = tx.feePayer === wallet ? (tx.fee ?? 0) / LAMPORTS : 0;
                    const touched = [...deltas.entries()].filter(([, d]) => d !== 0);
                    // CLEAN-SWAP RULE: exactly one non-WSOL mint, opposite-sign cash leg.
                    if (touched.length !== 1 || cashLeg === 0) { if (touched.length > 0) skipped++; continue; }
                    const [mint, tokDelta] = touched[0]!;
                    if (tokDelta > 0 && cashLeg < 0) { /* buy */ } else if (tokDelta < 0 && cashLeg > 0) { /* sell */ } else { skipped++; continue; }
                    const acc = perMint.get(mint) ?? newAcc();
                    const ts = tx.timestamp ?? null;
                    if (ts) { acc.first = acc.first == null ? ts : Math.min(acc.first, ts); acc.last = acc.last == null ? ts : Math.max(acc.last, ts); }
                    if (tokDelta > 0) { acc.buys++; acc.tokensBought += tokDelta; acc.solSpent += -cashLeg + fee; }
                    else { acc.sells++; acc.tokensSold += -tokDelta; acc.solReceived += Math.max(0, cashLeg - fee); }
                    perMint.set(mint, acc);
                    counted++;
                }
                before = oldestSig;
                if (txs.length < 100) break;
                await sleep(SLEEP_MS);
            }
            capped = pages >= MAX_PAGES;
        } catch (e) {
            console.log(`${wallet.slice(0, 10)}…: walk failed after ${pages} pages — ${e instanceof Error ? e.message.slice(0, 60) : e}`);
            continue;
        }

        // Persist per-mint rows + wallet rollup.
        let solSpent = 0, solReceived = 0, realized = 0;
        const entrySizes: number[] = [];
        for (const [mint, a] of perMint) {
            const portion = a.tokensBought > 0 ? Math.min(a.tokensSold / a.tokensBought, 1) : 1;
            const costOfSold = a.solSpent * portion;
            const realizedMint = a.solReceived - costOfSold;
            solSpent += a.solSpent; solReceived += a.solReceived; realized += realizedMint;
            if (a.buys > 0) entrySizes.push(a.solSpent / a.buys);
            await q`
        INSERT INTO wallet_trades (wallet, mint, buys, sells, tokens_bought, tokens_sold, sol_spent, sol_received, realized_sol, first_trade_at, last_trade_at)
        VALUES (${wallet}, ${mint}, ${a.buys}, ${a.sells}, ${a.tokensBought}, ${a.tokensSold}, ${a.solSpent}, ${a.solReceived}, ${realizedMint},
          ${a.first ? new Date(a.first * 1000).toISOString() : null}, ${a.last ? new Date(a.last * 1000).toISOString() : null})
        ON CONFLICT (wallet, mint) DO UPDATE SET buys=EXCLUDED.buys, sells=EXCLUDED.sells, tokens_bought=EXCLUDED.tokens_bought,
          tokens_sold=EXCLUDED.tokens_sold, sol_spent=EXCLUDED.sol_spent, sol_received=EXCLUDED.sol_received, realized_sol=EXCLUDED.realized_sol,
          first_trade_at=EXCLUDED.first_trade_at, last_trade_at=EXCLUDED.last_trade_at`;
        }
        entrySizes.sort((a, b) => a - b);
        const medianEntry = entrySizes.length ? entrySizes[entrySizes.length >> 1]! : null;
        await q`
      INSERT INTO wallet_value (wallet, sigs_seen, txs_parsed, swaps_counted, txs_skipped, tokens_traded, sol_spent, sol_received, realized_sol, volume_sol, median_entry_sol, sol_usd_at_walk, realized_usd, oldest_sig, pages, capped, walked_at)
      VALUES (${wallet}, ${sigs}, ${parsed}, ${counted}, ${skipped}, ${perMint.size}, ${solSpent}, ${solReceived}, ${realized}, ${solSpent + solReceived},
        ${medianEntry}, ${solUsd || null}, ${solUsd ? realized * solUsd : null}, ${oldestSig}, ${pages}, ${capped}, now())
      ON CONFLICT (wallet) DO UPDATE SET sigs_seen=EXCLUDED.sigs_seen, txs_parsed=EXCLUDED.txs_parsed, swaps_counted=EXCLUDED.swaps_counted,
        txs_skipped=EXCLUDED.txs_skipped, tokens_traded=EXCLUDED.tokens_traded, sol_spent=EXCLUDED.sol_spent, sol_received=EXCLUDED.sol_received,
        realized_sol=EXCLUDED.realized_sol, volume_sol=EXCLUDED.volume_sol, median_entry_sol=EXCLUDED.median_entry_sol,
        sol_usd_at_walk=EXCLUDED.sol_usd_at_walk, realized_usd=EXCLUDED.realized_usd, oldest_sig=EXCLUDED.oldest_sig, pages=EXCLUDED.pages,
        capped=EXCLUDED.capped, walked_at=now()`;
        console.log(
            `${wallet.slice(0, 10)}…  ${pages}p ${sigs} sigs  swaps ${counted} (skip ${skipped})  tokens ${perMint.size}  ` +
            `realized ${realized.toFixed(2)} SOL${solUsd ? " ($" + Math.round(realized * solUsd).toLocaleString() + ")" : ""}  ` +
            `median entry ${medianEntry != null ? medianEntry.toFixed(3) + " SOL" : "—"}${capped ? "  ⚠ CAPPED" : ""}  [${((Date.now() - t0) / 1000).toFixed(0)}s]`,
        );
    }
    await q.end();
    console.log("\nDone.");
})();
