# Multi-Wallet Architecture & Gold Rope Cascade — Tech Spec

Status: **DRAFT for review** (infrastructure design; build not yet started)
Author: Hermes OS · 2026-07-17
Scope: (A) a global wallet/lane selector in the Hermes dashboard, scaling to N wallets;
(B) cascading per-wallet trading performance into the Genesis Reserve "Gold Rope" service.

---

## 0. The ask, restated

1. The Account Ledger + Fills panels (and, top-down, the **whole dashboard**) should let the
   user **isolate performance by wallet** — Paper, Live, a specific wallet, or All.
2. A "**completely live dashboard**" mode = the whole surface reflects only the live (or a
   selected) wallet.
3. Build with **scaling in mind** — many wallets connected in the future.
4. **Cascade** per-wallet performance to the **Genesis Smarter Wallet** platform, tied to the
   **Gold Rope** premium service.

---

## 1. Where we are today

### Hermes
- `positions` and `pnl_snapshots` carry only **`lane` (`paper|live`)** — a 2-value enum. `fills`
  derives lane by join to `positions`. **No wallet-identity dimension exists.**
- The live lane *is a single `.env` wallet* (`TRADER_WALLET_SECRET_KEY`), identified only as
  `lane='live'`. `liveWallet()` loads exactly one key.
- **`lane='paper'` is hardcoded in ~17 query sites** across ~13 functions.
- Filtering today (`timeFilter.tsx`) is **client-side** (filters already-fetched rows). Wallet
  scope cannot work that way — it must filter in **SQL** and be driven server-side.

### Genesis Reserve (researched from `genesis-reserve-smarter-wallet`)
- Monorepo: `apps/api` (Express + Neon "ledger" DB, raw SQL migrations) and `apps/web` (Next 14
  + Supabase). **Two databases.**
- **Identity anchor = Privy DID** (`user_auth_identities.provider_user_id`, `UNIQUE(provider,
  provider_user_id)`) → `user_id` → `treasury_accounts.account_id` (`pta-*`). **`wallet_profiles`
  makes multiple wallets per user first-class** (embedded EOA / smart account / external), keyed
  by lowercased `address` + `chain_id` + `provider`. Per-wallet read routes already key on
  **lowercased `wallet_address`**.
- **Gold Rope = Revenue Stream 3**, "premium opt-in subscription for high-balance members." It is
  *concept + copy only*: no table, no subscription record, **no performance/returns attribution**.
  (NB: the `gr.` canon prefix means *Genesis Reserve*, not Gold Rope. The real yield tiers —
  Preserve/Grow/Accelerate ERC-4626 vaults — are a separate system.)
- **No per-wallet performance time-series** exists. `strategy_positions` / `yield_accruals` are
  per-*account*, current-state. `helix_deposit_log` (per `wallet_address`, append) is the closest
  precedent for a per-wallet log.
- **Service-to-service ingestion** is a solved problem there: the **Partner API** (`x-api-key`
  keccak256-hashed → `partners` table, `ip_allowlist`, `integration_level`, `yield_share_bps`,
  `webhook_url`) with mandatory **`Idempotency-Key`**; and a **signed-webhook pattern** (Clay:
  HMAC-SHA256 + ≤5-min timestamp skew + Zod + delivery idempotency). `partner_revenue` is the
  existing shape for "external party economics flowing into the ledger."
- **Ground-layer sync is NOT a fit** for this — org-scoped singletons (`UNIQUE(org_id,key)`), no
  per-wallet grain, no history, PR/CI cadence. It's for company canon, not user financial data.

---

## 2. Part A — Hermes multi-wallet identity model

Introduce a first-class wallet dimension; keep `lane` as a denormalized `kind` through the
transition so nothing breaks mid-migration.

### 2.1 `wallets` table (new)
```
wallets
  id            text primary key            -- e.g. 'paper', 'live-alpha', 'gr-vault-01'
  kind          text not null               -- paper | live | external
  address       text                        -- null for paper; base58 for live
  name          text not null               -- 'Paper Book', 'Live α'
  label_color   text                        -- UI accent
  active        boolean not null default true
  secret_ref    text                        -- ENV VAR NAME holding the key (never the key itself)
  metadata      jsonb not null default '{}' -- { genesisWalletAddress, genesisUserId, sizer overrides }
  created_at    timestamptz not null default now()
```
- `secret_ref` names the env var (e.g. `TRADER_WALLET_SECRET_KEY`, `TRADER_WALLET_SECRET_KEY_2`)
  — **keys never leave `.env`**; the table only points at which env var to read.
- Seed rows: `paper` (kind=paper), `live-alpha` (kind=live, address=`rEPAt2u…`, secret_ref=
  `TRADER_WALLET_SECRET_KEY`).

### 2.2 `wallet_id` on the fact tables
- Add `wallet_id text references wallets(id)` to `positions` and `pnl_snapshots`.
- **Backfill**: `paper → 'paper'`, `live → 'live-alpha'`. Keep `lane` populated (derive from
  `wallets.kind`) so legacy queries work until they're migrated.
- `fills` inherits scope via `positions.wallet_id` (no column needed).

### 2.3 Multi-wallet execution (scaling the trader)
- Generalize `liveWallet()` → `liveWallet(walletId)` reading `wallets.secret_ref`.
- The live loop iterates **active `kind='live'` wallets**; each carries its **own sizer inputs
  (balance fetched per wallet), gates, and caps** (per-wallet overrides in `metadata`).
- Adding a wallet = insert a `wallets` row + set its env var. **No code change.** This is the
  scaling primitive.

---

## 3. Part A — the global scope selector

### 3.1 One `Scope`, one resolver (kills the 17 literals)
```ts
type Scope = { kind: 'all' } | { kind: 'lane'; lane: 'paper'|'live' } | { kind: 'wallet'; walletId: string }
function scopeFilter(scope): SQL            // → e.g. eq(positions.walletId, id) | eq(lane,'paper') | undefined(all)
```
Every scoped query takes `scope` and applies `scopeFilter`. Single choke point.

### 3.2 Driven by a URL searchParam (SSR-correct)
- `?w=paper | live | <walletId> | all` read in `page.tsx` (server), resolved to `Scope`, passed
  into the `Promise.all`. Shareable, bookmarkable, no hydration mismatch.
- **"Completely live dashboard"** = `?w=live-alpha` (or `?w=live`).
- Default = `paper` initially; later a persisted user preference (localStorage → cookie for SSR).

### 3.3 `WalletSelector` component
- Header control (like the System Health pin): lists wallets from `getWallets()` with a live
  status dot + kind badge; selecting sets `?w=`. An "All / Paper / Live" quick row on top.

### 3.4 Refactor surface
- ~13 query fns gain a `scope` param (getStats, getEquitySeries, getManagedPositions,
  getAccountingLedger, getFillsSummary, edge/forecast, getWalletStatus already live-scoped).
- `LaneComparison` stays lane-vs-lane (its own thing). Per-shared-mint execution delta remains the
  rigorous paper-vs-live comparison.

---

## 4. Part B — the Gold Rope cascade (Hermes → Genesis)

**Principle:** Hermes is the source of truth for *managed trading performance*; Genesis is the
*consumer/display* for Gold Rope subscribers. Hermes **pushes**; Genesis **stores + surfaces**.

### 4.1 Identity bridge
- Join key = **lowercased wallet `address`** (both sides already speak this).
- A Hermes live wallet is associated with a Genesis user via `wallets.metadata.genesisWalletAddress`
  (and optionally `genesisUserId`/Privy DID). Association is an explicit, admin-gated mapping — a
  Gold Rope subscriber opts in and links the managed wallet to their account.
- No PII crosses the boundary — Hermes sends **wallet address + performance numbers only**.

### 4.2 Transport — **Hermes as a registered Partner** (recommended)
- Register Hermes in Genesis `partners` (gets `x-api-key`, `ip_allowlist`, `integration_level`).
- Hermes POSTs snapshots to a **new** Genesis route
  `POST /v1/partners/managed-performance` with `x-api-key` + `Idempotency-Key` (mirrors the
  `deposit-intents`/`finalize` write pattern + `partner_revenue` precedent).
- Alternative: a **signed webhook** mirroring the Clay ingest (HMAC-SHA256 + timestamp + Zod +
  `enrichment_deliveries`-style idempotency). Either works; the partner API is the cleaner fit
  because this is authenticated, stateful financial data, not an event stream.
- **Rejected:** ground-layer sync (wrong grain, no history, PR cadence).

### 4.3 New Genesis table (modeled on `yield_accruals` / `helix_deposit_log`)
```
managed_wallet_performance
  id              bigserial pk
  wallet_address  text not null          -- lowercased; joins to wallet_profiles.address
  account_id      text                   -- resolved pta-* if linked
  source          text not null default 'hermes'
  snapshot_at     timestamptz not null
  equity_usd      numeric not null
  realized_pnl_usd numeric not null
  unrealized_pnl_usd numeric
  roi_pct         numeric                -- since inception of the managed mandate
  win_rate        numeric
  open_positions  int
  period          text                   -- 'live' | 'daily' | 'inception'
  raw             jsonb                  -- full snapshot for audit
  delivery_id     text unique            -- idempotency (partner Idempotency-Key echo)
  created_at      timestamptz not null default now()
```
Append-only (WORM-friendly, consistent with their `ledger_entries` philosophy).

### 4.4 Data contract (the push payload)
```json
{ "walletAddress": "rEPAt2u…", "snapshotAt": "2026-07-17T…Z", "period": "live",
  "equityUsd": 61.2, "realizedPnlUsd": 2.12, "unrealizedPnlUsd": -0.3,
  "roiPct": 2.0, "winRate": 0.5, "openPositions": 1,
  "mandate": { "sizer": "regime+balance", "gates": ["premium-venue","wallet-graph","honeypot"] } }
```

### 4.5 Cadence
- Hermes pushes on its existing `pnl_snapshot` cadence (per live wallet) + on each close, debounced
  to ≤1/min per wallet. Idempotency-Key = `${walletId}:${snapshotAt}`.

### 4.6 Gold Rope surface (Genesis side, greenfield)
- `gr_subscriptions` (new): `wallet_address`/`account_id`, `tier='gold_rope'`, `status`,
  `started_at` — the missing subscription record.
- `GET /api/gr/managed-performance` reads `managed_wallet_performance` for the subscriber's linked
  wallet(s) → a "Your Managed Trading" panel (equity curve, ROI, win rate) gated to Gold Rope subs.

---

## 5. Security & trust boundary
- Keys never cross systems. Hermes wallet secrets stay in Hermes `.env`; Genesis partner API key
  stays in Hermes `.env` as `GENESIS_PARTNER_API_KEY`.
- All pushes carry `Idempotency-Key`; Genesis enforces `api_idempotency_keys` (existing).
- Hermes sends no PII (Genesis tokenizes email separately). Only wallet address + numbers.
- Association (wallet ↔ Gold Rope user) is explicit + admin/opt-in gated, never inferred.

---

## 6. Rollout phases (each independently shippable)
1. **Hermes wallet identity + scope selector** (internal only) — `wallets` table, `wallet_id`
   backfill, `scopeFilter`, URL param, `WalletSelector`. Delivers "completely live dashboard" now.
2. **Multi-wallet execution** — `liveWallet(walletId)`, per-wallet sizer/gates, live loop over
   wallets. Delivers N-wallet scaling.
3. **Genesis ingest** — partner registration, `managed_wallet_performance` table, the push endpoint
   + Hermes pusher.
4. **Gold Rope surface** — `gr_subscriptions`, `managed-performance` route + UI panel.

---

## 7. Open decisions (need your call before build)
1. **Ingestion channel:** Partner API (recommended) vs new signed webhook?
2. **Identity linkage:** key on wallet address only, or also bind Privy DID / `account_id`?
3. **Metrics exposed to Gold Rope users:** equity + ROI + win rate only, or full position detail?
4. **Push cadence:** live (per snapshot) vs daily digest vs both?
5. **Default dashboard scope:** paper, live, or a per-user remembered preference?
6. **Mandate framing:** is Gold Rope showing *the user's own* managed wallet, or a *pooled/fund*
   performance? (changes whether the association is 1:1 or many:1.)
