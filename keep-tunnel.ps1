# keep-tunnel.ps1 - keep the localhost.run website tunnel alive and record its URL
#
# Key behaviors:
#  - Single instance (global mutex) + orphan ssh cleanup at startup.
#  - localhost.run rotates the hostname on every internal reconnect WHILE ssh
#    stays alive. The log is therefore re-parsed continuously and the newest
#    "*.lhr.life tunneled" banner is always written to tunnel_url.txt.
#  - Health monitor polls the CURRENT public URL; on sustained failure it kills
#    ssh so a fresh session (and fresh URL) is created.
#  - Unique log per attempt; old logs (>1h) are cleaned up silently.

$mutex = New-Object System.Threading.Mutex($false, 'Global\BMTunnelWatchdog')
if (-not $mutex.WaitOne(0)) { exit }   # another watchdog is already running -> exit silently

$ssh     = 'C:\windows\System32\OpenSSH\ssh.exe'
$urlFile = 'C:\xampp\htdocs\black-meet\tunnel_url.txt'
$tmpDir  = 'C:\Users\BLACKL~1\AppData\Local\Temp\opencode'

function Update-UrlFromLog([string]$logPath) {
    # Returns the newest tunneled hostname found in the log, or $null.
    try {
        $txt = Get-Content $logPath -Raw -ErrorAction SilentlyContinue
        if (-not $txt) { return $null }
        $m = [regex]::Matches($txt, '([a-z0-9]+\.lhr\.life) tunneled')
        if ($m.Count -gt 0) { return $m[$m.Count - 1].Groups[1].Value }
    } catch { }
    return $null
}

# --- startup cleanup: kill orphaned ssh tunnels from previous watchdog runs ---
try {
    Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'localhost\.run' } |
        ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }
} catch { }

while ($true) {
    # unique log per attempt -> never locked, never needs deleting upfront
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $log   = Join-Path $tmpDir ("ssh-$stamp.log")

    # tidy up old logs (older than 1h); locked files are simply skipped
    try {
        Get-ChildItem $tmpDir -Filter 'ssh-*.log*' -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -lt (Get-Date).AddHours(-1) } |
            Remove-Item -Force -ErrorAction SilentlyContinue
    } catch { }

    $p = $null
    try {
        $p = Start-Process -FilePath $ssh -PassThru -WindowStyle Hidden `
            -ArgumentList '-o','StrictHostKeyChecking=no','-o','ServerAliveInterval=20','-o','ServerAliveCountMax=3','-R','80:localhost:80','nokey@localhost.run' `
            -RedirectStandardOutput $log -RedirectStandardError ($log + '.err')
    } catch { }
    if ($null -eq $p) { Start-Sleep -Seconds 60; continue }

    Start-Sleep -Seconds 6
    $host2 = Update-UrlFromLog $log
    if ($host2) {
        Set-Content -LiteralPath $urlFile -Value ("https://" + $host2 + "/black-meet/") -Encoding ascii
    }

    # Health monitor: re-parse the log continuously (hostname rotates on
    # reconnect!) and poll the CURRENT public URL; restart ssh on failure.
    while (-not $p.HasExited) {
        Start-Sleep -Seconds 10

        # 1) always track the newest hostname in the log
        $h2 = Update-UrlFromLog $log
        if ($h2) {
            $newUrl = "https://" + $h2 + "/black-meet/"
            $cur = ''
            try { $cur = (Get-Content $urlFile -Raw -ErrorAction SilentlyContinue) } catch { }
            if (-not $cur -or $cur.Trim() -ne $newUrl) {
                Set-Content -LiteralPath $urlFile -Value $newUrl -Encoding ascii
            }
        }

        # 2) health-check the URL that is currently recorded
        $raw = Get-Content $urlFile -ErrorAction SilentlyContinue
        $base = if ($raw) { [string]$raw.Trim() } else { '' }
        $ok = $false
        if ($base) {
            try {
                $r = Invoke-WebRequest -Uri ($base.TrimEnd('/') + '/index.php') -UseBasicParsing -TimeoutSec 20 -ErrorAction Stop
                if ($r.StatusCode -eq 200) { $ok = $true }
            } catch { $ok = $false }
        }
        if (-not $ok) {
            # one more check to avoid flapping on a single blip
            Start-Sleep -Seconds 10
            $ok2 = $false
            if ($base) {
                try {
                    $r2 = Invoke-WebRequest -Uri ($base.TrimEnd('/') + '/index.php') -UseBasicParsing -TimeoutSec 20 -ErrorAction Stop
                    if ($r2.StatusCode -eq 200) { $ok2 = $true }
                } catch { $ok2 = $false }
            }
            if (-not $ok2) {
                try { $p.Kill() } catch {}
                break
            }
        }
    }
    $p.WaitForExit()
    Start-Sleep -Seconds 3
}
