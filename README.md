# Genesis Capital Engine OS

> formerly Hermes OS — renamed 2026-07-23 ("time to Level Up")

Open-source financial copilot, DeFi dashboard, and agentic quant harness. Hermes watches new on-chain token launches, runs every candidate through a hard safety pipeline, scores survivors, and (eventually) trades them — paper by default, live only behind explicit hard-capped gates.

> **This is not financial advice. Memecoin scalping is extremely high risk — most launches go to zero. Never fund the live lane with money you can't lose entirely.**

## Architecture

```
hermes-os/
├── apps/dashboard/     # Next.js dashboard (M3)
├── services/scout/     # ✅ Scanner: new-pool ingest → safety pipeline → signals
├── services/trader/    # Paper engine + capped live lane (M2/M5)
├── agents/hermes/      # ElizaOS agent (M4)
├── packages/core/      # Config, types, safety checks (shared)
└── packages/db/        # Drizzle ORM schema (Postgres)
```

## SCOUT safety pipeline

Every new pool (GeckoTerminal new-pools feed, min liquidity filter) passes through, cheapest check first, evidence persisted per check:

1. **mint_authority** — mint authority revoked, freeze authority null (Solana RPC)
2. **holder_concentration** — top-10 < 25%, no wallet > 5% (pool vaults excluded)
3. **rugcheck** — no danger-level risks in the RugCheck report (covers LP burn/lock)
4. **honeypot_probe** — Jupiter buy+sell quote round-trip must route with sane price impact

Tokens passing all four become **signals**.

## Quickstart

```bash
cp .env.example .env        # add a free Helius key — public RPC rate-limits hard
pnpm install
docker compose up -d        # Postgres 16 on :5432
pnpm db:push                # create schema
pnpm scout                  # run the scanner
```

Probe a single mint without the DB:

```bash
pnpm --filter @hermes/scout probe 4D8qUHm334fxqeTauPvF8gQ7fYgrD4Mpmb1Wy6ftUSWR
```

## Roadmap

- **M1** ✅ SCOUT ingest + safety pipeline
- **M2** Scoring (volume acceleration, unique buyers, LLM narrative score) + paper trader
- **M3** Dashboard (signal feed, safety evidence, equity curve, kill switch)
- **M4** Hermes agent (ElizaOS) — chat with your quant
- **M5** Live lane — throwaway hot wallet, per-position/day hard caps enforced in code, confirm-gated

## License

MIT
