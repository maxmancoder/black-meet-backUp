# keep-tunnel-chain.ps1 - website tunnel watchdog with automatic fallback.
# Order:  Cloudflare (default) -> SSH (localhost.run) -> bore (bore.pub).
# The chain loops forever: if the active tunnel dies or fails health checks it
# is killed and the next method is tried; after bore fails we loop back to
# Cloudflare. Only ONE chain runs (global mutex).
# All methods forward to the Node app on 127.0.0.1:3000 (Apache is gone).
#
# tunnel_url.txt always holds the CURRENT public URL:
#   cloudflare -> https://<sub>.trycloudflare.com/black-meet/
#   ssh        -> https://<sub>.lhr.life/black-meet/
#   bore       -> http://bore.pub:<port>/black-meet/

$mutex = New-Object System.Threading.Mutex($false, 'Global\BMTunnelChain')
if (-not $mutex.WaitOne(0)) { exit }

$root     = 'C:\xampp\htdocs\black-meet'
$urlFile  = Join-Path $root 'tunnel_url.txt'
$tmpDir   = 'C:\Users\BLACKL~1\AppData\Local\Temp\opencode'
$ssh      = 'C:\windows\System32\OpenSSH\ssh.exe'
$cfExe    = Join-Path $root 'bin\cloudflared.exe'
$bore1    = 'C:\Users\BlackLine\Downloads\bore-tool\bore.exe'
$bore2    = Join-Path $tmpDir 'bore\bore.exe'
$chainLog = Join-Path $tmpDir 'bmt-chain.log'
$appPort  = 3000

function Log([string]$msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
    try { Add-Content -LiteralPath $chainLog -Value $line -Encoding utf8 } catch {}
}

function Get-UrlFile { try { return (Get-Content $urlFile -Raw -ErrorAction Stop).Trim() } catch { return '' } }
function Set-UrlFile([string]$u) { try { Set-Content -LiteralPath $urlFile -Value $u -Encoding ascii } catch {} }
function Clear-UrlFile { Set-UrlFile '' }

function Test-Http([string]$u) {
    if (-not $u) { return $false }
    try {
        $r = Invoke-WebRequest -Uri ($u.TrimEnd('/') + '/index.php') -UseBasicParsing -TimeoutSec 20 -ErrorAction Stop
        if ($r.StatusCode -eq 200) { return $true }
    } catch {}
    return $false
}

function Get-NewestHost([string]$logPath, [string]$re) {
    try {
        $txt = Get-Content $logPath -Raw -ErrorAction SilentlyContinue
        if (-not $txt) { return $null }
        $m = [regex]::Matches($txt, $re)
        if ($m.Count -gt 0) { return $m[$m.Count - 1].Groups[1].Value }
    } catch {}
    return $null
}

# ---- method 1: Cloudflare quick tunnel (default) ----
function Start-CfTunnel {
    Log 'CF : starting cloudflared quick tunnel'
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $log = Join-Path $tmpDir ("cf-" + $stamp + ".log")
    $p = Start-Process -FilePath $cfExe -PassThru -WindowStyle Hidden `
            -ArgumentList 'tunnel','--url',('http://127.0.0.1:' + $appPort),'--no-autoupdate','--loglevel','info',('--logfile=' + $log) `
            -RedirectStandardOutput ($log + '.out') -RedirectStandardError ($log + '.err')
    if ($null -eq $p) { Log 'CF : failed to launch cloudflared'; return $false }

    $deadline = (Get-Date).AddSeconds(60)
    $host2 = $null
    while ((Get-Date) -lt $deadline -and -not $p.HasExited) {
        Start-Sleep -Seconds 3
        $host2 = Get-NewestHost $log 'https://([a-z0-9-]+\.trycloudflare\.com)'
        if ($host2) { break }
    }
    if (-not $host2) {
        Log 'CF : no public URL within 60s - edge unreachable'
        try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
        Clear-UrlFile
        Start-Sleep -Seconds 2
        return $false
    }
    Set-UrlFile ("https://" + $host2 + "/black-meet/")
    Log ("CF : URL https://" + $host2)

    $fails = 0
    while (-not $p.HasExited -and $fails -lt 2) {
        Start-Sleep -Seconds 10
        if (Test-Http (Get-UrlFile)) { $fails = 0 } else { $fails++ }
    }
    try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
    Clear-UrlFile
    Log 'CF : failed - switching to SSH'
    Start-Sleep -Seconds 2
    return $false
}

# ---- method 2: SSH localhost.run ----
function Start-SshTunnel {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $log = Join-Path $tmpDir ("ssh-" + $stamp + ".log")
    if (Test-Path $log) { Remove-Item $log -Force -ErrorAction SilentlyContinue }
    if (Test-Path ($log + '.err')) { Remove-Item ($log + '.err') -Force -ErrorAction SilentlyContinue }
    Log 'SSH: starting localhost.run tunnel'
    $p = Start-Process -FilePath $ssh -PassThru -WindowStyle Hidden `
            -ArgumentList '-o','StrictHostKeyChecking=no','-o','ServerAliveInterval=20','-o','ServerAliveCountMax=3','-R',('80:localhost:' + $appPort),'nokey@localhost.run' `
            -RedirectStandardOutput $log -RedirectStandardError ($log + '.err')
    if ($null -eq $p) { Log 'SSH: failed to launch ssh'; return $false }

    $deadline = (Get-Date).AddSeconds(45)
    while ((Get-Date) -lt $deadline -and -not $p.HasExited) {
        Start-Sleep -Seconds 3
        if (Get-NewestHost $log '([a-z0-9]+\.lhr\.life) tunneled') { break }
    }

    $fails = 0
    while (-not $p.HasExited -and $fails -lt 2) {
        Start-Sleep -Seconds 10
        # localhost.run rotates the subdomain on reconnect while ssh stays up -> always re-parse
        $h2 = Get-NewestHost $log '([a-z0-9]+\.lhr\.life) tunneled'
        if ($h2) {
            $newUrl = "https://" + $h2 + "/black-meet/"
            if ((Get-UrlFile) -ne $newUrl) { Set-UrlFile $newUrl; Log ("SSH: URL " + $newUrl) }
        }
        if (Test-Http (Get-UrlFile)) { $fails = 0 } else { $fails++ }
    }
    try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
    Clear-UrlFile
    Log 'SSH: failed - switching to bore'
    Start-Sleep -Seconds 2
    return $false
}

# ---- method 3: bore raw-TCP tunnel (plain http website) ----
function Start-BoreTunnel {
    $bore = $null
    if (Test-Path $bore1) { $bore = $bore1 } elseif (Test-Path $bore2) { $bore = $bore2 }
    if (-not $bore) { Log 'BORE: bore.exe missing - skipped'; return $false }
    $out = Join-Path $tmpDir 'bore-www.out'
    if (Test-Path $out) { Remove-Item $out -Force -ErrorAction SilentlyContinue }
    if (Test-Path ($out + '.err')) { Remove-Item ($out + '.err') -Force -ErrorAction SilentlyContinue }
    Log 'BORE: starting bore website tunnel'
    $p = Start-Process -FilePath $bore -PassThru -WindowStyle Hidden `
            -ArgumentList 'local',('' + $appPort),'--to','bore.pub' `
            -RedirectStandardOutput $out -RedirectStandardError ($out + '.err')
    if ($null -eq $p) { Log 'BORE: failed to launch bore'; return $false }

    $deadline = (Get-Date).AddSeconds(25)
    $port = $null
    while ((Get-Date) -lt $deadline -and -not $p.HasExited) {
        Start-Sleep -Seconds 2
        $txt = Get-Content $out -Raw -ErrorAction SilentlyContinue
        if ($txt -and $txt -match 'listening at bore\.pub:(\d+)') { $port = $Matches[1]; break }
    }
    if (-not $port) {
        Log 'BORE: no public port within 25s'
        try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
        Clear-UrlFile
        Start-Sleep -Seconds 2
        return $false
    }
    Set-UrlFile ("http://bore.pub:" + $port + "/black-meet/")
    Log ("BORE: URL http://bore.pub:" + $port)

    $fails = 0
    while (-not $p.HasExited -and $fails -lt 2) {
        Start-Sleep -Seconds 10
        if (Test-Http (Get-UrlFile)) { $fails = 0 } else { $fails++ }
    }
    try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
    Clear-UrlFile
    Log 'BORE: failed - looping back to Cloudflare'
    Start-Sleep -Seconds 2
    return $false
}

# ---- startup cleanup: make sure we own the website tunnel ----
# kill the OLD ssh watchdog + its ssh, and any leftover cloudflared quick tunnels.
# (do NOT touch bore running for TURN via keep-bore.ps1 - that one is port 3478)
try {
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'keep-tunnel\.ps1' } |
        ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }
} catch {}
try {
    Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'localhost\.run' } |
        ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }
} catch {}
try {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'cloudflared\.exe' -and $_.CommandLine -match '\-\-url' } |
        ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }
} catch {}

Clear-UrlFile
Log '=== chain started: cloudflare -> ssh -> bore ==='

# ---- main chain ----
while ($true) {
    if (Test-Path $cfExe) { Start-CfTunnel } else { Log 'CF : bin\cloudflared.exe missing - skipping' }
    Start-SshTunnel
    Start-BoreTunnel
    Start-Sleep -Seconds 10
}