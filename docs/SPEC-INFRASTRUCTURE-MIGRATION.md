# TECH SPEC — Infrastructure Migration: Hetzner · Tailscale · Public Dex Console

**Status:** for engineering review · **Date:** 2026-08-06 · **Author:** desk
**Scope:** move the trading stack off the operator laptop onto a dedicated
host with real service supervision; private operator access; a public
read-only investor console. **NOT in scope:** trading logic — zero strategy
or execution changes ship in this migration.

---

## 1. Why (the evidence, not the aspiration)

Three independent failure classes in 72 hours, none of them trading defects:

| Incident | Cost | Root cause |
|---|---|---|
| Two silent trader deaths (08-04) | ~9h of a winner-dense tape unobserved | no service supervision; a background DB timeout killed the process |
| Orphaned-supervisor cascade (08-05) | duplicate traders racing the same rows; "Failed query" on trivial statements; sensor chain killed by a wildcard match | hand-rolled `cmd /c for /L` supervisors + PID-pattern kills |
| CPU starvation (08-05) | RPC breakers tripping on **healthy** endpoints (verified: Solana RPC 200 in 0.80s, DexScreener 200 in 0.20s from the same host while the trader called them dead); console latency 0.2s → 7.7s | `genesis-kafka` from an unrelated project at **292% CPU**; host pinned at 97% of 8 shared cores |

**The through-line:** a laptop shared with other projects, with improvised
process management, cannot hold the uptime an institutional MVP requires.
Every one of these produced *observation gaps*, and observation gaps are what
the last two weeks of work proved to be our most expensive failure mode.

**Success = 99.9% stack uptime, measured**, with the laptop reduced to a
client that can close its lid without consequence.

---

## 2. Target architecture

```
                    ┌──────────────────────────────────────┐
                    │  HETZNER CX32  (Falkenstein/Ashburn) │
                    │  4 vCPU · 8 GB · 80 GB NVMe · ~€8/mo │
                    │                                      │
   Tailscale  ──────┤  systemd: trader · scout · recorder  │
   (private)        │           sentinel · optimizer       │
   operator only    │           capital-console (:3900)    │
                    │  docker: postgres 16 (persistent vol)│
                    │  ufw: DENY all inbound except SSH    │
                    └──────────────┬───────────────────────┘
                                   │ read-only pooled connection
                                   ▼
                    ┌──────────────────────────────────────┐
                    │  VERCEL — public "Dex Console"       │
                    │  Next.js, read-only, no wallet env   │
                    │  investor-facing metrics only        │
                    └──────────────────────────────────────┘
```

**Sizing rationale:** current DB is **2,971 MB** and grows ~1 GB/week from
`candidate_ticks`; 80 GB NVMe holds ~1 year with headroom for retention
policy. 4 dedicated vCPU vs today's *contended* 8 — the stack's own load sat
near 20% before genesis-kafka saturated the box. 8 GB covers Postgres (2.5 GB
resident today) plus six node processes with margin.

---

## 3. Service supervision — the defect this eliminates

One unit file per service; `systemctl restart hermes-trader` is atomic and
idempotent. **No orphaned supervisors, no duplicate processes, no pattern
matching, no respawn races** — the exact class of failure that produced
tonight's cascade.

```ini
# /etc/systemd/system/hermes-trader.service
[Unit]
Description=Hermes Trader
After=network-online.target docker.service
Requires=docker.service

[Service]
Type=simple
User=hermes
WorkingDirectory=/opt/hermes/services/trader
EnvironmentFile=/opt/hermes/.env
ExecStart=/usr/bin/node /opt/hermes/node_modules/tsx/dist/cli.mjs src/index.ts
Restart=always
RestartSec=5
StartLimitIntervalSec=0        # never give up on a trading service
StandardOutput=journal
StandardError=journal
MemoryMax=1500M                # a leak cannot starve its siblings

[Install]
WantedBy=multi-user.target
```

Five siblings identical but for `WorkingDirectory`/`ExecStart`:
`hermes-scout`, `hermes-recorder`, `hermes-sentinel`, `hermes-optimizer`
(`src/optimizer-main.ts`), `hermes-console` (`apps/capital-console/server.ts`).

**Operational surface:** `systemctl status hermes-*` · `journalctl -u
hermes-trader -f` · boot persistence via `enable`. The in-process crash
handlers and heartbeat watchdog stay as defence in depth.

---

## 4. Private access — Tailscale

- Tailscale on the VPS and the operator laptop/phone (free tier).
- **Zero public ports**: `ufw` denies all inbound except SSH (key-only,
  password auth off, root login off, fail2ban).
- Console at `http://hermes-vps:3900` over the tailnet; `psql` likewise.
- Optional Tailscale SSH so no key material sits on the laptop.

---

## 5. Public "Dex Console" on Vercel (read-only, investor-facing)

**Purpose:** a shareable link that demonstrates the platform's discipline —
the artifact an investor or auditor can look at without touching operations.

**Hard constraints (non-negotiable):**
- **Read-only DB role** (`hermes_public`): `GRANT SELECT` on an allowlist of
  views only. No table access, no wallet env, no mutation path — enforced at
  the database, not in application code.
- **Aggregated views only** — `v_public_equity`, `v_public_capture`,
  `v_public_manifest`, `v_public_uptime`. No mints, no wallet addresses, no
  audit rows, no open positions (nothing front-runnable).
- Vercel connects over the tailnet or a dedicated read-replica; the primary
  never accepts public connections.
- ISR/caching at 60s so the page cannot load-test the trading database.

**Content (the "plush" surface):** equity curve both lanes · the **Offer vs
Capture** KPI with its 40–70% target band · manifest version + governance
history · uptime and observation-health · the replay-court ledger (six exit
courts, three rejected hypotheses) · doctrine one-liners. Design language
matches the operator console: dark, monospace, numeric, no marketing copy.

---

## 6. Migration plan — staged, reversible, capital last

| Stage | Action | Gate to proceed |
|---|---|---|
| **0** | Provision CX32, harden (ufw, SSH keys, fail2ban, `hermes` user), install Node 24 + Docker + Tailscale | SSH over tailnet only |
| **1** | Postgres 16 in Docker, persistent volume, tuned; restore `pg_dump` (~3 GB) | row counts + latest timestamps match the laptop |
| **2** | Deploy repo, `.env` **re-entered by operator on the box** (never copied through chat/git), `pnpm install`, six systemd units, **paper lane only, live kill ENGAGED** | all six `active (running)`; heartbeat <10s |
| **3** | **48-hour soak.** Laptop stack stopped to avoid double-trading. Watch: zero unplanned restarts, CPU <40%, RPC breakers quiet, tick cadence ≈2s, F2 fires accumulating | 48h clean + paper behaviour statistically identical to the laptop era |
| **4** | Public Dex Console: read-only role, views, Vercel deploy | audit: `hermes_public` cannot SELECT outside the views |
| **5** | **Live wallet migration** — operator enters the key on the box; small tranche (4 seats, $2.50); rolling-10 gate governs | operator ratification only |

**Rollback at every stage:** the laptop stack remains intact and can resume
in minutes; nothing is deleted until Stage 5 has held for a week.

---

## 7. The wallet-key decision (state it plainly)

Moving the key to a VPS is a **real** security change and deserves its own
ratification, not a footnote:

- **Better than today:** dedicated box, no other tenants, no browser, no
  desktop attack surface, disk encryption, key-only SSH, `hermes` user with
  no sudo, `.env` at `0600`, no key in git (already enforced).
- **Worse than today:** the provider is a new trust party; a compromised VPS
  is remotely exploitable in ways a closed laptop is not.
- **Mitigations:** Hetzner root password + 2FA, no public inbound, automatic
  security updates, key rotation at cutover (fund a **fresh** wallet and
  retire the current one), and a hard balance cap on the hot wallet.

---

## 8. Cost

| Item | Monthly |
|---|---|
| Hetzner CX32 (4 vCPU / 8 GB / 80 GB) | ~€8 (~$9) |
| Hetzner automated backups (20%) | ~€1.60 |
| Tailscale (free tier, ≤3 users) | $0 |
| Vercel Hobby (public console) | $0 |
| **Total** | **~$11/month** |

Against ~9 hours of unobserved winner-dense tape in a single day, the payback
is immediate.

---

## 9. Verification

1. **Uptime:** `systemctl` restart counters at zero across 48h; heartbeat
   gaps >60s = zero; sentinel's dead-trader watchdog silent.
2. **Behavioural parity:** paper open/close counts, capture %, and exit-reason
   distribution statistically indistinguishable from the laptop era over the
   same tape conditions.
3. **Observation health:** tick cadence ≈2s (from 3.0–3.6s), gaps >10s <20/24h
   (from 179), HOLD-ALL ≤1/48h, **F2 `rung_high_water` fires >0** — the
   capture fix finally gets a clean window to prove itself.
4. **Isolation:** killing any one unit leaves the others untouched; killing
   the console does not touch the trader (the insulation test, deliberately
   run).
5. **Public console security:** `hermes_public` SELECT outside the allowlisted
   views must fail; no wallet address or mint appears in any response.
6. **Live:** kill remains ENGAGED through Stage 4; Stage 5 proceeds only on
   operator word with the rolling-10 gate governing.
