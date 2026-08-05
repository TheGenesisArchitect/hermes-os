# OmniRoute — the AI gateway, and how to use it from VS Code

**Status:** Phase 1 complete + Phase 2 wired · gateway healthy, 311 models,
loopback-only, digest-pinned `sha256:92c768c5…14658c1a1`.
**Scope:** DEV INFRASTRUCTURE ONLY. Never the trading path. This machine holds
a live wallet key; the gateway container mounts no repo, sees no `.env`, and
holds every provider credential in its own AES-encrypted store.

## Verified working
```
POST /v1/chat/completions  model=auto/best-coding
  → claude-haiku-4-5-20251001   "READY"          (Anthropic key live)
GET  /v1/models             → 311 models
container                   → Up, healthy, 127.0.0.1:20128 only
```
Note on probing: the models endpoint enumerates hundreds of providers and
combo routes stream — **use ≥45s timeouts**. Short timeouts read as failures
(the container logs them honestly as client 499 disconnects).

## Use it from VS Code

### Claude Code / terminal sessions (opt-in per shell)
```powershell
. .\ops\omniroute.ps1        # route this shell through the gateway
. .\ops\omniroute.ps1 -Off   # back to direct
```
The profile health-gates itself (never points a session at a dead gateway)
and prints the alias menu. Default shells stay direct — this is opt-in by
design so a gateway problem can never block your primary workflow.

### Extension-based tools (Continue, Cline, Roo, Kilo…)
Point the provider at an **OpenAI-compatible endpoint**:
```
Base URL : http://127.0.0.1:20128/v1
API key  : any non-empty string (loopback is unauthenticated by design)
Model    : auto/best-coding
```

## The aliases that matter here
| alias | use it for |
|---|---|
| `auto/best-coding` | default — strongest coding model with fallback |
| `auto/coding:free` | free tiers only: bulk refactors, scaffolding, docs, tests |
| `auto/best-reasoning` | harness design, audit reasoning, replay logic |
| `auto/cheap` | high-volume, low-stakes calls |
| `auto/best-fast` | latency-sensitive interactive work |

Aliases resolve per request across every configured provider, so a vendor
outage degrades to a slower/cheaper model instead of stopping work — the same
router philosophy the trading lane uses for swaps.

## Billing note
A gateway-routed Claude session meters the **API key in OmniRoute's store**,
not a subscription. That is the tradeoff Phase 2 measures: fallback
resilience and free-tier bulk work against metered premium calls. Use
`auto/coding:free` for volume, direct sessions for premium work, and review
after a week.

## Operations
```
start / stop     docker start omniroute | docker stop omniroute
health           curl -m 10 http://127.0.0.1:20128/healthz   (models endpoint takes ~48s)
dashboard        http://localhost:20128   (providers, keys, routing strategy)
upgrade          by ratification only — re-pin the digest, same as any dep
```
A gateway crash affects coding sessions only: no trading service imports it,
and no trading credential is reachable from it.
