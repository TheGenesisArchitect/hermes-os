# OMNIROUTE DEV PROFILE - the AI gateway, on a switch.
#
# Two things happen when this is ON:
#   1. THIS SHELL routes through the gateway (env vars, immediate).
#   2. VS CODE / Claude Code sessions in this repo get the gateway wired into
#      the MODEL PICKER via .claude/settings.local.json - the familiar
#      Opus / Sonnet / Haiku slots are remapped onto gateway routing aliases,
#      so switching stays exactly as user-friendly as it already is:
#
#        /model opus    -> auto/best-reasoning   (deep work, best available)
#        /model sonnet  -> auto/best-coding      (default coding driver)
#        /model haiku   -> auto/coding:free      (free tiers, bulk work)
#
#      Picker changes apply to the NEXT session (settings are read at start).
#
# RATE LIMITS NEVER REQUIRE A SWITCH. Two independent layers:
#   - gateway side: an auto/* alias fails over across 311 models internally.
#     The session never sees the rate limit; it sees an answer.
#   - Claude Code side: fallbackModel in .claude/settings.json continues the
#     turn on the next model when the primary is overloaded. Always on, even
#     with the gateway off.
#
#   Usage:  . .\ops\omniroute.ps1          # on  (shell + picker)
#           . .\ops\omniroute.ps1 -Off     # off (both, fully reverted)
#
# The gateway is loopback-only, digest-pinned, and holds every provider
# credential in its own encrypted store - no provider keys live in the hermes
# .env (that file stays trading-secrets-only). Nothing here touches trading.
#
# ASCII-ONLY BY REQUIREMENT: PowerShell 5.1 parses .ps1 as ANSI, so unicode
# glyphs corrupt string quoting. Keep this file plain ASCII.
param([switch]$Off)

$Gateway = "http://127.0.0.1:20128"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Local = Join-Path $RepoRoot ".claude\settings.local.json"

if ($Off) {
  Remove-Item Env:ANTHROPIC_BASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:OPENAI_BASE_URL -ErrorAction SilentlyContinue
  if (Test-Path $Local) { Remove-Item $Local -Force }
  Write-Host "omniroute OFF - shell and model picker back to direct Anthropic" -ForegroundColor Yellow
  Write-Host "  fallbackModel chain stays active (rate-limit failover is native)" -ForegroundColor DarkGray
  return
}

# Health-gate: never point a session at a dead gateway. /healthz answers in
# milliseconds; /v1/models enumerates hundreds of providers and takes ~48s.
try {
  $null = Invoke-WebRequest -Uri "$Gateway/healthz" -UseBasicParsing -TimeoutSec 10
}
catch {
  Write-Host "omniroute NOT reachable at $Gateway - nothing changed." -ForegroundColor Red
  Write-Host "  start it:  docker start omniroute" -ForegroundColor DarkGray
  return
}

# 1. This shell. ANTHROPIC_BASE_URL carries NO /v1 (Anthropic clients append
#    /v1/messages themselves); OPENAI_BASE_URL does (OpenAI clients do not).
$env:ANTHROPIC_BASE_URL = $Gateway
$env:ANTHROPIC_AUTH_TOKEN = "omniroute-local"
$env:OPENAI_BASE_URL = "$Gateway/v1"

# 2. The model picker for VS Code / Claude Code sessions in this repo.
$settings = @{
  '$comment' = @(
    "WRITTEN BY ops/omniroute.ps1 - do not hand-edit; toggle with the script.",
    "Remaps the opus/sonnet/haiku picker slots onto OmniRoute routing aliases.",
    "Remove with: . .\ops\omniroute.ps1 -Off"
  )
  env        = [ordered]@{
    ANTHROPIC_BASE_URL             = $Gateway
    ANTHROPIC_AUTH_TOKEN           = "omniroute-local"
    ANTHROPIC_DEFAULT_OPUS_MODEL   = "auto/best-reasoning"
    # sonnet uses best-reasoning, NOT best-coding: the coding variant's dynamic
    # ranking currently resolves to the non-functional felo-chat provider (verified
    # 2026-08-12), which presents as a dead/rate-limited session. best-reasoning and
    # best-fast resolve to big-pickle and work. Restore best-coding once OmniRoute
    # fixes the coding-variant routing upstream.
    ANTHROPIC_DEFAULT_SONNET_MODEL = "auto/best-reasoning"
    ANTHROPIC_DEFAULT_HAIKU_MODEL  = "auto/coding:free"
  }
}
$dir = Split-Path -Parent $Local
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$settings | ConvertTo-Json -Depth 5 | Out-File -FilePath $Local -Encoding utf8

Write-Host "omniroute ON  ->  $Gateway" -ForegroundColor Green
Write-Host "  model picker (next session):" -ForegroundColor DarkGray
Write-Host "    /model opus    -> auto/best-reasoning   deep work, best available" -ForegroundColor DarkGray
Write-Host "    /model sonnet  -> auto/best-reasoning   default (best-coding route broken -> felo-chat)" -ForegroundColor DarkGray
Write-Host "    /model haiku   -> auto/coding:free      free tiers, bulk work" -ForegroundColor DarkGray
Write-Host "  rate limits fail over inside the gateway - no switching needed." -ForegroundColor DarkGray
Write-Host "  billing: gateway-routed Claude meters the API key in the gateway" -ForegroundColor DarkGray
Write-Host "  store, not your subscription. Use -Off to revert." -ForegroundColor DarkGray
