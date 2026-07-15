# keep-awake.ps1 — hold the machine out of Modern Standby (S0) overnight.
# This laptop is S0 (connected standby): zeroing the sleep TIMEOUT is not enough,
# because the box drops to low-power the moment the display sleeps and background
# CPU does not stop it. SetThreadExecutionState(ES_SYSTEM_REQUIRED|ES_CONTINUOUS)
# is the same assertion media players / downloads use to stay alive with the
# screen off. The flag is per-thread and cleared when the process exits, so this
# script must stay running for the whole test window.
Add-Type -Namespace Win32 -Name Power -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern uint SetThreadExecutionState(uint esFlags);
'@
$ES_CONTINUOUS       = [uint32]"0x80000000"
$ES_SYSTEM_REQUIRED  = [uint32]"0x00000001"
$flags = $ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED

# Assert once as continuous, then re-assert on a slow heartbeat as belt-and-braces.
[void][Win32.Power]::SetThreadExecutionState($flags)
$log = Join-Path $PSScriptRoot "logs\keep-awake.log"
"$(Get-Date -Format o)  keep-awake armed (ES_SYSTEM_REQUIRED|ES_CONTINUOUS)" | Out-File -Append -Encoding utf8 $log
while ($true) {
  [void][Win32.Power]::SetThreadExecutionState($flags)
  Start-Sleep -Seconds 60
}
