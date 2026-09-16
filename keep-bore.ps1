# keep-bore.ps1 - keep the bore TURN tunnel alive and record its public host:port
# Silent + self-healing: if bore.exe is missing (e.g. deleted by antivirus),
# it quietly re-extracts it from the zip instead of spamming Start-Process errors.
# Uses a global mutex so only ONE instance of this watchdog ever runs.

$mutex = New-Object System.Threading.Mutex($false, 'Global\BMBoreWatchdog')
if (-not $mutex.WaitOne(0)) { exit }   # another watchdog is already running -> exit silently

$dir  = 'C:\Users\BlackLine\Downloads\bore-tool'
$bore = Join-Path $dir 'bore.exe'
$zip1 = 'C:\Users\BlackLine\Downloads\bore-v0.6.0-x86_64-pc-windows-msvc.zip'
$zip2 = 'C:\Users\BlackLine\Downloads\bore.zip'
$tf   = 'C:\xampp\htdocs\black-meet\turn_host.txt'
$out  = 'C:\Users\BLACKL~1\AppData\Local\Temp\opencode\bore.out'

function Restore-Bore {
    # Defender may delete bore.exe; re-extract quietly from a local zip if one exists
    if (Test-Path $bore) { return $true }
    foreach ($z in @($zip1, $zip2)) {
        if (Test-Path $z) {
            try {
                if (Test-Path $dir) { Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue }
                New-Item -ItemType Directory -Path $dir -Force | Out-Null
                Expand-Archive -LiteralPath $z -DestinationPath $dir -Force
                $exe = Get-ChildItem $dir -Recurse -Filter 'bore.exe' | Select-Object -First 1
                if ($exe -and $exe.FullName -ne $bore) { Move-Item $exe.FullName $bore -Force }
                if (Test-Path $bore) { return $true }
            } catch { }
        }
    }
    return $false
}

while ($true) {
    if (-not (Restore-Bore)) {
        # bore.exe unavailable (deleted by AV, no zip) -> stay silent, clear stale host, retry later
        Set-Content -LiteralPath $tf -Value '' -Encoding ascii
        Start-Sleep -Seconds 120
        continue
    }
    $p = $null
    try {
        $p = Start-Process -FilePath $bore -PassThru -WindowStyle Hidden `
            -ArgumentList 'local','3478','--to','bore.pub' -RedirectStandardOutput $out -RedirectStandardError ($out + '.err')
    } catch { }
    if ($null -eq $p) { Start-Sleep -Seconds 120; continue }
    Start-Sleep -Seconds 6
    $txt = Get-Content $out -Raw -ErrorAction SilentlyContinue
    if ($txt -match 'listening at ([^:\s]+:\d+)') {
        Set-Content -LiteralPath $tf -Value $Matches[1] -Encoding ascii
    }
    $p.WaitForExit()
    # bore died -> clear the recorded host so the app falls back to public TURN
    Set-Content -LiteralPath $tf -Value '' -Encoding ascii
    Start-Sleep -Seconds 3
}
