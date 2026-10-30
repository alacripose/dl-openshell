# Prove the release downloader survives a CDN that drops the first connection.
#
# The server this test points at is local and closes the first request without writing a
# response; the retry has to re-download from scratch and succeed, and the five-attempt run
# against a dead port has to return one refusal naming the URL and the attempt count.
#
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File tools/tests/download-retry-test.ps1
param([string]$Flaky = '', [string]$Dead = '')

$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$source = Get-Content -LiteralPath (Join-Path $repoRoot 'release\install.ps1') -Raw
$match = [regex]::Match($source, 'function Get-ReleaseAsset \{.*?\r?\n\}', 'Singleline')
if (-not $match.Success) { throw 'Get-ReleaseAsset was not found in release/install.ps1' }
Invoke-Expression $match.Value

$failures = 0
function Check([string]$Name, [bool]$Ok, [string]$Detail) {
    if ($Ok) {
        Write-Host "ok: $Name"
    } else {
        Write-Host "FAILED: $Name - $Detail"
        $script:failures++
    }
}

if ($Flaky) {
    $ReleaseBase = $Flaky
    $ReleaseTag = ''
    $ReleaseRepo = 'local'
    $dest = Join-Path $env:TEMP ('openlock-retry-' + [guid]::NewGuid().ToString('N') + '.vpk')
    $errorText = Get-ReleaseAsset -Name 'player.vpk' -Destination $dest
    Check 'a dropped first connection is retried' ([string]::IsNullOrEmpty($errorText)) ([string]$errorText)
    if (Test-Path -LiteralPath $dest) {
        $bytes = (Get-Item -LiteralPath $dest).Length
        Check 'the retry wrote the whole asset' ($bytes -eq 7) "wrote $bytes bytes, expected 7"
        Check 'the asset is the served payload' ((Get-Content -LiteralPath $dest -Raw) -eq 'PAYLOAD') 'payload differs'
        Remove-Item -LiteralPath $dest -Force
    } else {
        Check 'the retry wrote the whole asset' $false 'no file was written'
    }
}

if ($Dead) {
    $ReleaseBase = $Dead
    $ReleaseTag = ''
    $ReleaseRepo = 'local'
    $dest = Join-Path $env:TEMP ('openlock-dead-' + [guid]::NewGuid().ToString('N') + '.vpk')
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $errorText = Get-ReleaseAsset -Name 'openshell-player.vpk' -Destination $dest -Attempts 3
    $sw.Stop()
    Check 'an unreachable asset is a refusal, not a throw' (-not [string]::IsNullOrEmpty($errorText)) 'returned no refusal'
    Check 'the refusal names the URL and every attempt' ($errorText -match 'openshell-player\.vpk' -and $errorText -match '3 attempt') ([string]$errorText)
    Check 'the retries waited between attempts' ($sw.Elapsed.TotalSeconds -ge 5) ("elapsed $([Math]::Round($sw.Elapsed.TotalSeconds,1)) s")
}

if ($failures -gt 0) { exit 1 }
Write-Host 'ok: 6 download checks'
exit 0
