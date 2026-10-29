#Requires -Version 5.1
<#
.SYNOPSIS
  Install the verified Openlock player build beside deadlock.exe.

.DESCRIPTION
  This is the file published as the `install.ps1` release asset. It needs no checkout, Python or
  CSDK: it downloads the release player VPK and its SHA-256, verifies both, installs the archive
  into its own `game/citadel/addons/mods` search path, and leaves the game's other addon folders
  alone. Put it in `game/bin/win64` next to `deadlock.exe` and run it; a small shell window shows
  the stage and the final toast.

  The game must be closed while gameinfo.gi changes, because SearchPaths is read at launch.
#>
[CmdletBinding()]
param(
    [string]$DeadlockRoot = '',
    [string]$VpkPath = '',
    [string]$HashPath = '',
    [string]$ReleaseRepo = 'alacripose/dl-openshell',
    [string]$ReleaseTag = 'latest',
    [string]$ReleaseBase = '',
    [ValidateSet('player')]
    [string]$Grade = 'player',
    [switch]$NoUi,
    [switch]$KeepArchive
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

$script:shellUi = $null
$script:shellState = 'starting'
$script:noUi = [bool]$NoUi

# Resolve the game from the file's own location first. The release asset is meant to be dropped
# next to deadlock.exe, so this is the normal path, not a developer convenience.
$gameExe = @('deadlock.exe', 'project8.exe') |
    ForEach-Object { Join-Path $PSScriptRoot $_ } |
    Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

$roots = @()
if ($gameExe) { $roots += (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path }
if ($DeadlockRoot) { $roots += $DeadlockRoot }
$roots += 'D:\SteamLibrary\steamapps\common\Deadlock'
$roots += 'C:\Program Files (x86)\Steam\steamapps\common\Deadlock'

if (-not $DeadlockRoot) {
    foreach ($candidate in $roots) {
        if ($candidate -and (Test-Path (Join-Path $candidate 'game\citadel\gameinfo.gi'))) {
            $DeadlockRoot = $candidate
            break
        }
    }
}

function Show-ShellUi {
    param([string]$Title = 'Openlock', [string]$Message = 'starting')
    if ($script:noUi -or -not [Environment]::UserInteractive -or $env:CI) { return }

    try {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        [System.Windows.Forms.Application]::EnableVisualStyles()

        $form = New-Object System.Windows.Forms.Form
        $form.Text = $Title
        $form.ClientSize = New-Object System.Drawing.Size(470, 176)
        $form.StartPosition = 'CenterScreen'
        $form.FormBorderStyle = 'FixedDialog'
        $form.MaximizeBox = $false
        $form.MinimizeBox = $false
        $form.ControlBox = $false
        $form.TopMost = $true
        $form.BackColor = [System.Drawing.Color]::FromArgb(18, 20, 24)
        $form.ForeColor = [System.Drawing.Color]::FromArgb(232, 235, 238)

        $heading = New-Object System.Windows.Forms.Label
        $heading.Location = New-Object System.Drawing.Point(18, 16)
        $heading.Size = New-Object System.Drawing.Size(434, 26)
        $heading.Font = [System.Drawing.Font]::new('Segoe UI', 12, [System.Drawing.FontStyle]::Bold)
        $heading.ForeColor = [System.Drawing.Color]::FromArgb(240, 196, 84)
        $heading.Text = 'Openlock'

        $detail = New-Object System.Windows.Forms.Label
        $detail.Location = New-Object System.Drawing.Point(18, 48)
        $detail.Size = New-Object System.Drawing.Size(434, 38)
        $detail.Font = [System.Drawing.Font]::new('Segoe UI', 9)
        $detail.Text = $Message

        $bar = New-Object System.Windows.Forms.ProgressBar
        $bar.Location = New-Object System.Drawing.Point(18, 94)
        $bar.Size = New-Object System.Drawing.Size(434, 14)
        $bar.Minimum = 0
        $bar.Maximum = 100
        $bar.Style = 'Continuous'
        $bar.Value = 0

        $percent = New-Object System.Windows.Forms.Label
        $percent.Location = New-Object System.Drawing.Point(18, 116)
        $percent.Size = New-Object System.Drawing.Size(434, 20)
        $percent.Font = [System.Drawing.Font]::new('Segoe UI', 9)
        $percent.ForeColor = [System.Drawing.Color]::FromArgb(160, 168, 178)
        $percent.Text = '0%  ·  starting'

        $note = New-Object System.Windows.Forms.Label
        $note.Location = New-Object System.Drawing.Point(18, 140)
        $note.Size = New-Object System.Drawing.Size(434, 20)
        $note.Font = [System.Drawing.Font]::new('Segoe UI', 8)
        $note.ForeColor = [System.Drawing.Color]::FromArgb(120, 128, 138)
        $note.Text = 'Close Deadlock before installing.'

        $form.Controls.AddRange(@($heading, $detail, $bar, $percent, $note))
        $form.Show()
        [System.Windows.Forms.Application]::DoEvents()
        $script:shellUi = [pscustomobject]@{
            Form = $form; Heading = $heading; Detail = $detail; Bar = $bar; Percent = $percent; Note = $note
        }
    } catch {
        $script:shellUi = $null
        Write-Warning "shell window unavailable: $($_.Exception.Message)"
    }
}

function Update-ShellUi {
    param([int]$Percent, [string]$Stage, [string]$Message, [string]$State = 'running')
    $script:shellState = $State
    if ($null -eq $script:shellUi) { return }

    try {
        $ui = $script:shellUi
        $value = [Math]::Max(0, [Math]::Min(100, $Percent))
        $ui.Bar.Value = $value
        $ui.Percent.Text = "$value%  ·  $Stage"
        if ($Message) { $ui.Detail.Text = $Message }
        if ($State -eq 'failed') {
            $ui.Heading.Text = 'Openlock install failed'
            $ui.Heading.ForeColor = [System.Drawing.Color]::FromArgb(236, 112, 104)
            $ui.Note.Text = 'Nothing was mounted. Read the message above, then run the installer again.'
        } elseif ($State -eq 'ok') {
            $ui.Heading.Text = 'Openlock installed'
            $ui.Heading.ForeColor = [System.Drawing.Color]::FromArgb(132, 214, 138)
            $ui.Note.Text = 'Start Deadlock. The shell boots from its own addons/mods archive.'
        }
        [System.Windows.Forms.Application]::DoEvents()
    } catch {
        $script:shellUi = $null
    }
}

function Show-Toast {
    param([string]$Title, [string]$Text, [string]$Kind = 'Info')
    if ($script:noUi -or -not [Environment]::UserInteractive -or $env:CI) { return }

    try {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $tip = New-Object System.Windows.Forms.NotifyIcon
        $tip.Text = 'Openlock'
        $tip.Icon = if ($Kind -eq 'Error') { [System.Drawing.SystemIcons]::Error } else { [System.Drawing.SystemIcons]::Information }
        $tip.Visible = $true
        $tip.ShowBalloonTip(5000, $Title, $Text, $(if ($Kind -eq 'Error') {
            [System.Windows.Forms.ToolTipIcon]::Error } else { [System.Windows.Forms.ToolTipIcon]::Info }))
        for ($i = 0; $i -lt 25; $i++) {
            [System.Windows.Forms.Application]::DoEvents()
            Start-Sleep -Milliseconds 100
        }
        $tip.Visible = $false
        $tip.Dispose()
    } catch {
        Write-Warning "installer toast unavailable: $($_.Exception.Message)"
    }
}

function Complete-ShellUi {
    param([bool]$Ok, [string]$Message)
    if ($null -ne $script:shellUi) {
        Update-ShellUi -Percent $(if ($Ok) { 100 } else { 0 }) `
            -Stage $(if ($Ok) { 'installed' } else { 'failed' }) -Message $Message `
            -State $(if ($Ok) { 'ok' } else { 'failed' })
        Start-Sleep -Milliseconds 900
        try {
            $script:shellUi.Form.Close()
            $script:shellUi.Form.Dispose()
        } catch { }
        $script:shellUi = $null
    }
    Show-Toast -Title $(if ($Ok) { 'Openlock installed' } else { 'Openlock install failed' }) `
        -Text $Message -Kind $(if ($Ok) { 'Info' } else { 'Error' })
}

function Test-VpkString([byte[]]$Data, [int]$Start, [ref]$Next) {
    $i = $Start
    while ($i -lt $Data.Length -and $Data[$i] -ne 0) { $i++ }
    if ($i -ge $Data.Length) { return $null }
    $value = [System.Text.Encoding]::UTF8.GetString($Data, $Start, $i - $Start)
    $Next.Value = $i + 1
    return $value
}

function Test-VpkArchive([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return 'archive was not written' }
    $stream = $null
    try {
        $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        $length = $stream.Length
        if ($length -lt 12) { return 'archive is shorter than a VPK header' }
        $head = New-Object byte[] 12
        $read = $stream.Read($head, 0, 12)
        if ($read -ne 12) { return 'archive header is truncated' }
        if ($head[0] -ne 0x34 -or $head[1] -ne 0x12 -or $head[2] -ne 0xAA -or $head[3] -ne 0x55) {
            return 'archive has bad VPK magic'
        }
        $version = [int][BitConverter]::ToUInt32($head, 4)
        if ($version -ne 1 -and $version -ne 2) { return "archive uses unsupported VPK version $version" }
        $treeSize = [int][BitConverter]::ToUInt32($head, 8)
        $headerSize = 12
        if ($version -eq 2) { $headerSize += 16 }
        if ($treeSize -lt 1) { return 'archive has an empty VPK tree' }
        if ([long]$headerSize + [long]$treeSize -gt $length) { return 'VPK tree runs past the end of the archive' }

        $stream.Position = $headerSize
        $tree = New-Object byte[] $treeSize
        $got = 0
        while ($got -lt $treeSize) {
            $n = $stream.Read($tree, $got, $treeSize - $got)
            if ($n -le 0) { return 'VPK tree read ended early' }
            $got += $n
        }

        $pos = 0
        $entries = 0
        $extensions = 0
        while ($pos -lt $treeSize) {
            $next = 0
            $ext = Test-VpkString -Data $tree -Start $pos -Next ([ref]$next)
            if ($null -eq $ext) { return 'VPK tree has an unterminated extension string' }
            $pos = $next
            if ($ext.Length -eq 0) { break }
            $extensions++
            while ($true) {
                $next = 0
                $dir = Test-VpkString -Data $tree -Start $pos -Next ([ref]$next)
                if ($null -eq $dir) { return 'VPK tree has an unterminated directory string' }
                $pos = $next
                if ($dir.Length -eq 0) { break }
                while ($true) {
                    $next = 0
                    $name = Test-VpkString -Data $tree -Start $pos -Next ([ref]$next)
                    if ($null -eq $name) { return 'VPK tree has an unterminated entry name' }
                    $pos = $next
                    if ($name.Length -eq 0) { break }
                    if ($pos + 18 -gt $treeSize) { return 'VPK entry metadata runs past the tree' }
                    $pos += 18
                    $entries++
                }
            }
        }
        if ($extensions -eq 0 -or $entries -eq 0) { return 'VPK tree contains no entries' }
        if ($pos -ne $treeSize) { return "VPK tree has trailing bytes ($pos of $treeSize read)" }
        return $null
    } catch {
        return 'could not read VPK: ' + $_.Exception.Message
    } finally {
        if ($stream) { $stream.Dispose() }
    }
}

function Get-ReleaseAsset {
    param([string]$Name, [string]$Destination)
    $base = if ($ReleaseBase) {
        $ReleaseBase.TrimEnd('/')
    } elseif ($ReleaseTag -and $ReleaseTag -ne 'latest') {
        "https://github.com/$ReleaseRepo/releases/download/$ReleaseTag"
    } else {
        "https://github.com/$ReleaseRepo/releases/latest/download"
    }
    try {
        Invoke-WebRequest -Uri "$base/$Name" -OutFile $Destination -UseBasicParsing -TimeoutSec 120
        return $null
    } catch {
        return $_.Exception.Message
    }
}

$temp = Join-Path $env:TEMP ('openlock-release-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $temp | Out-Null
$downloadedVpk = Join-Path $temp 'pak01_dir.vpk'

try {
    Show-ShellUi -Message 'finding the Deadlock install'
    Update-ShellUi -Percent 5 -Stage 'prepare' -Message 'finding the Deadlock install'

    if (-not $DeadlockRoot) {
        throw 'Could not find a Deadlock install. Put install.ps1 in game/bin/win64 next to deadlock.exe, or pass -DeadlockRoot.'
    }
    $DeadlockRoot = (Resolve-Path $DeadlockRoot).Path.TrimEnd('\')
    $game = Join-Path $DeadlockRoot 'game'
    $citadel = Join-Path $game 'citadel'
    $gameinfo = Join-Path $citadel 'gameinfo.gi'
    if (-not (Test-Path -LiteralPath $gameinfo)) {
        throw "gameinfo.gi not found at '$gameinfo'. Verify the game files with Steam, then run install.ps1 again."
    }
    if (Get-Process deadlock, project8 -ErrorAction SilentlyContinue) {
        throw 'Deadlock is running. Close the game, then run install.ps1 again; SearchPaths is read at launch.'
    }

    if ($VpkPath) {
        $VpkPath = (Resolve-Path $VpkPath).Path
        Update-ShellUi -Percent 20 -Stage 'verify' -Message "reading $([System.IO.Path]::GetFileName($VpkPath))"
        if ($HashPath) {
            $HashPath = (Resolve-Path $HashPath).Path
        }
    } else {
        Update-ShellUi -Percent 12 -Stage 'download' -Message "downloading the verified player archive from $ReleaseRepo"
        $errorText = Get-ReleaseAsset -Name 'openlock-player.vpk' -Destination $downloadedVpk
        if ($errorText) {
            throw "Could not download the player archive from ${ReleaseRepo}: $errorText"
        }
        $checksumPath = Join-Path $temp 'openlock-player.sha256'
        Update-ShellUi -Percent 32 -Stage 'download' -Message 'downloading the release checksum'
        $errorText = Get-ReleaseAsset -Name 'openlock-player.sha256' -Destination $checksumPath
        if ($errorText) {
            throw "The release did not provide openlock-player.sha256, so the archive cannot be verified: $errorText"
        }
        $expected = (Get-Content -LiteralPath $checksumPath -TotalCount 1).Trim().Split(' ')[0].ToLowerInvariant()
        if ($expected -notmatch '^[0-9a-f]{64}$') {
            throw "The release checksum is not a SHA-256 value: '$expected'."
        }
        $actual = (Get-FileHash -LiteralPath $downloadedVpk -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $expected) {
            throw "Release archive hash $actual does not match the published $expected; refusing to install."
        }
        Write-Host "Verified release archive SHA-256 $actual"
        $VpkPath = $downloadedVpk
    }

    Update-ShellUi -Percent 48 -Stage 'verify' -Message 'checking the archive tree'
    $vpkError = Test-VpkArchive $VpkPath
    if ($vpkError) {
        throw "The player archive is not a readable VPK: $vpkError"
    }
    $archiveBytes = (Get-Item -LiteralPath $VpkPath).Length

    Update-ShellUi -Percent 62 -Stage 'install' -Message 'installing into citadel/addons/mods'
    $addonRoot = Join-Path $citadel 'addons\mods'
    New-Item -ItemType Directory -Force -Path $addonRoot | Out-Null
    $installedArchive = Join-Path $addonRoot 'pak01_dir.vpk'
    Copy-Item -LiteralPath $VpkPath -Destination $installedArchive -Force
    $installedHash = (Get-FileHash -LiteralPath $installedArchive -Algorithm SHA256).Hash
    $sourceHash = (Get-FileHash -LiteralPath $VpkPath -Algorithm SHA256).Hash
    if ($installedHash -ne $sourceHash) {
        throw "Installed VPK hash $installedHash does not match the verified archive's $sourceHash."
    }
    $installedError = Test-VpkArchive $installedArchive
    if ($installedError) {
        throw "Installed VPK is not readable: $installedError"
    }

    Update-ShellUi -Percent 80 -Stage 'mount' -Message 'adding citadel/addons/mods to SearchPaths'
    $backup = "$gameinfo.openlock-bak"
    if (-not (Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath $gameinfo -Destination $backup -Force }

    $text = [System.IO.File]::ReadAllText($gameinfo)
    if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
    $lines = [System.Collections.Generic.List[string]]($text -split "`r?`n")
    $lines = [System.Collections.Generic.List[string]]($lines | Where-Object {
        $_ -notmatch 'citadel/addons/openlock_ui' -and
        $_ -notmatch 'citadel/addons/openlock_packages/' -and
        $_ -notmatch 'citadel/addons/mods(?:/|\s|$)'
    })
    $entry = "`t`t`tGame`t`tcitadel/addons/mods"
    $insertAt = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^\s*Game\s+citadel/addons\s*$') { $insertAt = $i + 1; break }
    }
    if ($insertAt -lt 0) {
        $searchAt = -1
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match '^\s*SearchPaths\s*$') { $searchAt = $i; break }
        }
        if ($searchAt -lt 0) {
            throw "Could not find a SearchPaths block in '$gameinfo'; the archive is installed but not mounted."
        }
        $braceAt = -1
        for ($i = $searchAt + 1; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match '^\s*\{\s*$') { $braceAt = $i; break }
            if ($lines[$i] -match '^\s*\}\s*$') { break }
        }
        if ($braceAt -lt 0) {
            throw "Could not find the opening brace of SearchPaths in '$gameinfo'; the archive is installed but not mounted."
        }
        $insertAt = $braceAt + 1
    }
    $lines.Insert($insertAt, $entry)
    [System.IO.File]::WriteAllText($gameinfo, (($lines -join "`r`n").TrimEnd() + "`r`n"),
        (New-Object System.Text.UTF8Encoding($false)))

    $check = [System.IO.File]::ReadAllBytes($gameinfo)
    if ($check.Length -ge 3 -and $check[0] -eq 0xEF -and $check[1] -eq 0xBB -and $check[2] -eq 0xBF) {
        throw 'gameinfo.gi was written with a BOM; Deadlock cannot parse that.'
    }

    Update-ShellUi -Percent 94 -Stage 'record' -Message 'writing the installed-build record'
    $record = [ordered]@{
        format = 'openlock.build/1'
        grade = $Grade
        stage = 'installed'
        state = 'ok'
        startedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
        updatedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
        finishedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
        vpk = 'citadel/addons/mods/pak01_dir.vpk'
        vpkBytes = $archiveBytes
        path = 'citadel/addons/mods/pak01_dir.vpk'
        source = if ($VpkPath -eq $downloadedVpk) { "github:$ReleaseRepo@$ReleaseTag" } else { 'local' }
        sha256 = $installedHash.ToLowerInvariant()
        message = 'installed from the release asset'
    }
    $recordPath = Join-Path $game 'bin\win64\openlock.build.json'
    $parent = Split-Path $recordPath -Parent
    if (Test-Path -LiteralPath $parent) {
        [System.IO.File]::WriteAllText($recordPath, ($record | ConvertTo-Json -Depth 4),
            (New-Object System.Text.UTF8Encoding($false)))
    }

    Update-ShellUi -Percent 100 -Stage 'installed' -Message "installed $([Math]::Round($archiveBytes / 1MB, 2)) MB"
    Complete-ShellUi -Ok $true -Message "Installed Openlock $Grade into addons/mods ($([Math]::Round($archiveBytes / 1MB, 2)) MB). Start Deadlock."
    Write-Host "Installed $installedArchive"
    Write-Host "Mounted citadel/addons/mods from $gameinfo"
    exit 0
} catch {
    $failure = $_.Exception.Message
    Write-Host "Openlock install failed: $failure"
    Complete-ShellUi -Ok $false -Message $failure
    exit 1
} finally {
    if (-not $KeepArchive) {
        Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
    }
}
