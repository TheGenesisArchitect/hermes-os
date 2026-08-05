# OMNIROUTE DEV PROFILE - opt-in AI gateway for coding sessions.
#
# Phase 2 of the approved integration plan: OPT-IN per shell. Default
# sessions stay direct (subscription); a shell that dot-sources this routes
# through the local gateway (fallback across 311 models, free tiers, token
# compression). Nothing here touches the trading stack.
#
#   Usage:  . .\ops\omniroute.ps1          # this shell only
#           . .\ops\omniroute.ps1 -Off     # revert to direct
#
# The gateway is loopback-only (127.0.0.1:20128), digest-pinned, and holds
# every provider credential in its own encrypted store - no provider keys
# live in the hermes .env (that file stays trading-secrets-only).
#
# ASCII-ONLY BY REQUIREMENT: PowerShell 5.1 parses .ps1 as ANSI, so unicode
# glyphs corrupt string quoting. Keep this file plain ASCII.
param([switch]$Off)

$Gateway = "http://127.0.0.1:20128"

if ($Off) {
  Remove-Item Env:ANTHROPIC_BASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:OPENAI_BASE_URL -ErrorAction SilentlyContinue
  Write-Host "omniroute OFF - this shell talks directly to providers again" -ForegroundColor Yellow
  return
}

# Health-gate the profile: never point a session at a dead gateway.
try {
  $null = Invoke-WebRequest -Uri "$Gateway/healthz" -UseBasicParsing -TimeoutSec 10
} catch {
  Write-Host "omniroute NOT reachable at $Gateway - profile not applied." -ForegroundColor Red
  Write-Host "  start it:  docker start omniroute" -ForegroundColor DarkGray
  return
}

$env:ANTHROPIC_BASE_URL = "$Gateway/v1"
$env:OPENAI_BASE_URL    = "$Gateway/v1"

Write-Host "omniroute ON  ->  $Gateway/v1" -ForegroundColor Green
Write-Host "  auto/best-coding     strongest coding model available (fallback chain)" -ForegroundColor DarkGray
Write-Host "  auto/coding:free     free tiers only - bulk refactors, scaffolding, docs" -ForegroundColor DarkGray
Write-Host "  auto/best-reasoning  harness design, audit reasoning, replay logic" -ForegroundColor DarkGray
Write-Host "  auto/cheap           high-volume low-stakes calls" -ForegroundColor DarkGray
Write-Host "  billing: gateway-routed Claude meters the API key in the gateway" -ForegroundColor DarkGray
Write-Host "  store, not your subscription. Use -Off to revert." -ForegroundColor DarkGray
