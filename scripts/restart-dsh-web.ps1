# restart-dsh-web.ps1 — detached one-shot: restart the dsh web profile so the
# freshly installed dsh-worktree-flow plugin loads. Launched out-of-process
# (WMI Win32_Process.Create) so it survives the death of the current host.
$ErrorActionPreference = 'Continue'
$log = Join-Path $PSScriptRoot 'restart.log'
function Log($line) { "$(Get-Date -Format 'HH:mm:ss.fff') $line" | Out-File $log -Append -Encoding utf8 }

Log 'restart script armed; waiting 6s for the current turn to settle'
Start-Sleep -Seconds 6

try {
	$conn = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
	if ($null -ne $conn) {
		$target = $conn.OwningProcess
		Log "port 3080 listener PID = $target; killing process tree"
		taskkill /PID $target /T /F 2>&1 | ForEach-Object { Log "taskkill: $_" }
		Start-Sleep -Seconds 2
	} else {
		Log 'no listener on 3080 (already stopped?)'
	}
} catch {
	Log "kill phase error: $($_.Exception.Message)"
}

Log 'starting dsh web (detached)'
Start-Process -FilePath 'pwsh' -ArgumentList '-NoProfile','-Command','dsh web' -WindowStyle Hidden

$ok = $false
for ($i = 0; $i -lt 20; $i++) {
	Start-Sleep -Seconds 2
	try {
		$resp = Invoke-WebRequest -Uri 'http://127.0.0.1:3080' -UseBasicParsing -TimeoutSec 3
		if ($resp.StatusCode -eq 200) { $ok = $true; break }
	} catch { }
}
Log "health check: $ok"
if (-not $ok) { Log 'WARNING: GUI did not answer on 3080 within 40s — check the dsh web console manually' }
