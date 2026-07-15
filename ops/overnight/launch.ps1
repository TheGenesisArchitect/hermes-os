# launch.ps1 — bring up the full hermes stack for an unattended overnight run.
# Kills any stale instances FIRST (two traders managing the same book is a race,
# not redundancy), then starts the keep-awake holder + all four services, each in
# its own detached, logged, self-restarting wrapper. Verifies exactly one of each.
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$logDir = Join-Path $here "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

Write-Host "== 1. killing stale hermes processes =="
# Match only OUR processes by command line: the tsx service entrypoints and the
# dashboard's next dev. Never touch node processes that aren't clearly ours.
$patterns = 'hermes-os.*services\\(scout|recorder|trader).*index\.ts|hermes-os.*dev -p 3777|dashboard.*next.*dev -p 3777|run-service\.ps1|keep-awake\.ps1'
$stale = Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -and ($_.CommandLine -match $patterns) }
foreach ($p in $stale) {
  Write-Host ("  kill {0}  {1}" -f $p.ProcessId, ($p.CommandLine.Substring(0, [Math]::Min(90, $p.CommandLine.Length))))
  try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {}
}
Start-Sleep -Seconds 2

Write-Host "== 2. keep-awake (S0 assertion) =="
Start-Process powershell -WindowStyle Hidden -ArgumentList @(
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $here "keep-awake.ps1")
)

Write-Host "== 3. services (detached, logged, auto-restart) =="
foreach ($name in @("scout", "recorder", "trader", "dashboard")) {
  Start-Process powershell -WindowStyle Hidden -ArgumentList @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $here "run-service.ps1"),
    "-Name", $name
  )
  Write-Host ("  launched {0}  ->  logs\{0}.log" -f $name)
  Start-Sleep -Milliseconds 800
}

Start-Sleep -Seconds 6
Write-Host "== 4. verify =="
& (Join-Path $here "status.ps1")
