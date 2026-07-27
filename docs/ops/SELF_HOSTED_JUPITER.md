# Self-Hosted Jupiter Swap API — Deployment Runbook

The live lane now routes swaps through a **failover SwapRouter**. Provider #2
(`jupiter-selfhosted`) is wired and **dormant** — the router skips it until
`JUPITER_SELFHOSTED_URL` is set. Standing up the container turns it into an active
failover target, so a Jupiter **hosted** outage (like today's) can no longer halt
execution: we run our own copy of their router on our uptime.

## What it is
Jupiter open-sources `jupiter-swap-api` — the exact `/quote` + `/swap` engine
behind lite-api.jup.ag, runnable locally against our own RPC. Same routing, our
uptime.

## The honest requirement — a decent RPC
The engine indexes on-chain AMM pools, which is **RPC-heavy**. The keyless public
RPC (`solana-rpc.publicnode.com`) will likely rate-limit it. For real use it wants:
- a **dedicated RPC** (Helius / Triton / QuickNode), ideally with
- a **Yellowstone gRPC** endpoint for low-latency market updates.

On a Windows desktop against the public RPC it may run degraded or thrash — so the
right home for this is a **dedicated box (or the same box we scale wallets on)
with a paid RPC**. Until then it stays dormant and the hosted provider + (future)
direct-DEX carry execution.

## Deploy (Docker — we already run Docker here for Postgres)
```bash
docker run -d --name jupiter-swap-api --restart unless-stopped \
  -p 8080:8080 \
  -e RPC_URL="<DEDICATED_RPC_HTTPS>" \
  -e YELLOWSTONE_GRPC_ENDPOINT="<GRPC_ENDPOINT>"   # optional but recommended \
  ghcr.io/jup-ag/jupiter-swap-api:latest
# health: curl "http://localhost:8080/quote?inputMint=So111...112&outputMint=EPjF...Dt1v&amount=10000000&slippageBps=300"
```
(Exact env keys/path can vary by release — confirm against the image's README, and
set `JUPITER_SELFHOSTED_URL` to whatever base path the container serves.)

## Wire it in
1. In repo-root `.env`:
   ```
   JUPITER_SELFHOSTED_URL=http://localhost:8080/swap/v1   # or the base the container serves
   ```
2. Restart the trader. Boot banner will show the self-hosted provider active; the
   router logs `🔀 swap route via jupiter-selfhosted` whenever it fails over to it.
3. Validate: `pnpm --filter @hermes/trader exec tsx src/live/dryRun.ts` still
   simulates clean (it now runs through the router).

## Proof it works
Stop the hosted path (or when Jupiter's hosted API is down, as now): the router
trips `jupiter-hosted`'s breaker and fails over to `jupiter-selfhosted`
automatically — live keeps trading. That is the whole point.

## Also shipped alongside (no infra needed)
- **RPC failover** — `RPC_URLS` (comma-separated) ∪ keyless public fallbacks; every
  live RPC read/send fails over across endpoints with a per-endpoint breaker. The
  RPC is no longer a single point of failure either.

## Still to build (the endgame)
- **Direct-DEX providers** (provider #3) for pumpswap + fluxbeam — RPC-only, needs
  no aggregator at all. This is what guarantees we can always exit a premium-venue
  position as long as the chain is up.

## 2026-07-27 STATUS — path is now LICENSE-GATED
- `ghcr.io/jup-ag/jupiter-swap-api` does not exist publicly (pull → unauthorized).
- The repo now ships the **Metis v7 binary** (v7.0.17), which requires an
  authenticated **Binary Key with a staked JUP requirement**, or a metered
  partner deployment (Triton ~$80/M queries, QuickNode add-on).
- Evidence check (48h audit 2026-07-27): all 14 live_unsellable write-offs were
  LP pulls (pool gone — direct damm-v2 provider passed through "no pool"), NOT
  hosted-Jupiter downtime. The direct-DEX chain (PumpSwap/MeteoraDbc/
  MeteoraDammV2/PumpFunCurve/Fluxbeam/PumpPortal) already covers the outage
  class this spec targeted.
- DECISION NEEDED (operator): stake JUP / buy Triton metered, or accept the
  direct-DEX chain as the failover. Provider #2 stays dormant until then.
