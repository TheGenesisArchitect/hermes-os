# Swap-Route Resilience — Tech Spec

Status: **DRAFT for review** (triggered by a Jupiter hosted-API outage taking all live execution down)
Author: Hermes OS · 2026-07-17
Principle: **Execution must survive any single provider outage. Down is not an option.**

---

## 0. The problem

The live lane's entire execution path — quote, build, and (implicitly) sell — depends on **one
provider: Jupiter's hosted API** (`lite-api.jup.ag` / `api.jup.ag`). When that tier degrades (as
now: their `datapi` is 200 but their swap tier is 000), **no wallet can buy or sell.** Our RPC,
filter, and connectivity are all healthy — the outage is entirely inside one vendor, and it halts
everything. For a system scaling to many wallets and real capital, that is a disqualifying single
point of failure.

---

## 1. The architecture — provider abstraction + ordered failover

Abstract the swap path behind a **SwapProvider interface**; a **FailoverExecutor** tries providers
in priority order, skips unhealthy ones (per-provider circuit breaker), and records which provider
filled. The system alarms **only when the entire stack is down** (a true outage), not on any single
provider blip. The execution layer is **wallet-agnostic** — one layer serves every wallet, so adding
wallets never adds execution risk.

```
SwapProvider { quote(in,out,amt,slip) · buildSwapTx(quote,wallet) · healthy() }

FailoverExecutor.quoteAndBuild():
  for p in providers (priority order):
     if breaker[p].open: continue
     try: return await p.quote()+p.buildSwapTx()   // record provider used
     catch: breaker[p].trip(); continue
  → ALL failed → the only case that alarms + halts entries
```

---

## 2. The providers — tiered independence

| # | Provider | Depends on | Role |
|---|---|---|---|
| 1 | **Jupiter hosted** (`lite-api`) | Jupiter's uptime | Primary — best liquidity, fastest. What we have today. |
| 2 | **Self-hosted Jupiter Swap API** | **our RPC + our host** | The resilience anchor — same routing quality, our uptime. Jupiter open-sources the swap-api binary; run it against our RPC so their hosted outage can't touch us. |
| 3 | **Direct-DEX execution** (per premium venue) | **RPC only** | Ultimate independence — build swap instructions directly against the pool program via each DEX SDK (Raydium / Orca / Meteora / PumpSwap). Needs only the RPC, which stays up in exactly these outages. |
| 4 | *(optional)* second hosted aggregator (DFlow / Titan / Jupiter-paid) | that vendor | Quick diversification — reduces correlated-outage risk, but still external. |

**Why direct-DEX is the real endgame:** live only ever trades a **small, known premium set**
(pumpswap, fluxbeam, meteora-dbc, raydium). We don't need to support the whole market — only the
venues we actually trade. That makes RPC-only direct execution a *bounded* build, and it aligns
perfectly with the premium-venue-only live strategy. As long as the RPC is up, we can always exit a
position — which is the property that actually matters for real capital.

---

## 3. Health-driven failover & the watchdog

- **Per-provider circuit breaker:** N consecutive failures → mark unhealthy → skip → periodic
  re-probe → auto-restore on a clean success.
- **The existing sell-route watchdog becomes per-provider** — it already probes the swap route; it
  now probes *each* provider and drives selection. It alarms only when **every** provider is down.
- **Every fill is audited with the provider that executed it** — so we can see failover happening
  and measure each provider's reliability over time.

---

## 4. Scaling posture

One execution layer, shared across all wallets. A new wallet is a registry row + a key (per the
multi-wallet spec) — it inherits the full failover stack automatically. No wallet is ever exposed to
a single-provider outage. This is the property that makes "many wallets" safe.

---

## 5. Immediate reality vs the fix

Honest: **there is no instant flip** that restores execution mid-outage — resilience is a build, not
a config toggle. The current outage is bounded (a $60 test wallet, 0 open positions, paper
unaffected), so nothing is at risk *right now*; but the build is what guarantees this is the last
time a vendor outage can stall us.

**Fastest path to real resilience:**
1. Provider interface + FailoverExecutor; refactor today's Jupiter client into provider #1 (foundation).
2. **Self-hosted Jupiter** (provider #2) — the biggest single win; removes the hosted dependency.
3. **Direct-DEX** for pumpswap + fluxbeam (providers covering most live volume) — RPC-only independence.
4. Per-provider watchdog + alarm-only-when-all-down.

---

## 6. Open decisions (for your review)
1. **Anchor choice:** stand up **self-hosted Jupiter** (best routing, our uptime) as provider #2, or
   start with a **second hosted aggregator** (faster to integrate, still external)? *Rec: self-hosted
   Jupiter — it's the "own your execution" answer.*
2. **Direct-DEX scope:** which venues first? *Rec: pumpswap + fluxbeam (most live volume), then
   meteora-dbc + raydium.*
3. **Host topology:** run self-hosted Jupiter on this machine, or a separate box for isolation
   (so a desktop reboot doesn't take execution down)?
4. **RPC redundancy:** the whole resilience story rests on the RPC — do we also add a **second RPC**
   with failover (Helius/Triton/own node) so the RPC itself isn't the next single point of failure?
