# status.ps1 — liveness snapshot. Run this in the morning (or any time) to see
# whether the stack survived the night and how the trader did.
$here = $PSScriptRoot
$logDir = Join-Path $here "logs"

Write-Host "== processes =="
$patterns = 'services\\(scout|recorder|trader|sentinel).*index\.ts|dev -p 3777|run-service\.ps1|keep-awake\.ps1'
$procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine -match $patterns) }
if (-not $procs) { Write-Host "  (none running)" }
foreach ($p in $procs) {
  $tag = switch -Regex ($p.CommandLine) {
    'keep-awake'  { "keep-awake"; break }
    'run-service' { "wrapper";    break }
    'scout.*index\.ts'    { "scout";     break }
    'recorder.*index\.ts' { "recorder";  break }
    'trader.*index\.ts'   { "trader";     break }
    'sentinel.*index\.ts' { "sentinel";  break }
    'dev -p 3777' { "dashboard";  break }
    default       { "?" }
  }
  Write-Host ("  {0,-11} pid {1}" -f $tag, $p.ProcessId)
}

Write-Host "`n== power keep-awake requests =="
# needs admin to read; best-effort
try { powercfg /requests 2>$null | Select-String -Pattern "SYSTEM|EXECUTION" -Context 0,2 } catch {}

Write-Host "`n== last lines per log =="
foreach ($f in Get-ChildItem $logDir -Filter *.log -ErrorAction SilentlyContinue | Sort-Object Name) {
  Write-Host ("  --- {0} ---" -f $f.Name)
  Get-Content $f.FullName -Tail 4 | ForEach-Object { Write-Host "    $_" }
}

Write-Host "`n== trader heartbeat (recent equity snapshots) =="
$q = "select snapped_at, lane, round(equity_usd,2) as equity, open_positions from pnl_snapshots order by snapped_at desc limit 6;"
docker exec -i -e PGPASSWORD=hermes hermes-postgres psql -h localhost -U hermes -d hermes -c $q
Write-Host "== kill switch / breaker =="
docker exec -i -e PGPASSWORD=hermes hermes-postgres psql -h localhost -U hermes -d hermes -c "select key, value from config where key in ('kill_switch','circuit_breaker') order by key;"
