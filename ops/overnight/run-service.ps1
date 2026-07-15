param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("scout", "recorder", "trader", "dashboard")]
  [string]$Name
)
# run-service.ps1 — supervise one hermes service for the overnight run.
# Takes ONLY a short name and maps it to the pnpm filter internally: passing an
# "@hermes/..." string across a `powershell -File` boundary triggers PowerShell's
# splatting operator (@hermes → splat of $hermes) and kills param binding before
# the script even runs. Keep the "@" off the command line.
$filters = @{
  scout     = "@hermes/scout"
  recorder  = "@hermes/recorder"
  trader    = "@hermes/trader"
  dashboard = "@hermes/dashboard"
}
$Filter = $filters[$Name]

# The trader's own loop self-heals transient errors per-tick (try/catch), but if
# the whole node process dies (OOM, unhandled reject, tsx crash) nothing restarts
# it. This wrapper does: run → on exit, log the code, back off, relaunch. All
# stdout+stderr is teed to a timestamped log on disk because Claude's task output
# vanishes when the session ends and we need the trail for the morning post-mortem.
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$logDir = Join-Path $PSScriptRoot "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir "$Name.log"
Set-Location $repo
$backoff = 2
while ($true) {
  "$(Get-Date -Format o)  -- starting $Filter --" | Out-File -Append -Encoding utf8 $log
  & cmd /c "pnpm --filter $Filter dev >> `"$log`" 2>&1"
  $code = $LASTEXITCODE
  "$(Get-Date -Format o)  !! $Name exited code=$code -- restarting in ${backoff}s" | Out-File -Append -Encoding utf8 $log
  Start-Sleep -Seconds $backoff
  $backoff = [Math]::Min($backoff * 2, 60)
}
