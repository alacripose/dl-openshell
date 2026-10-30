#Requires -Version 5.1
<#
.SYNOPSIS
  Install the verified dl-openshell player build beside deadlock.exe.

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
    [string]$Grade = '',
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

function Add-ShellLog {
    param([string]$Line)
    if (-not $Line -or $null -eq $script:shellUi) { return }

    try {
        $ui = $script:shellUi
        if ($ui.LastLog -eq $Line) { return }
        $ui.LastLog = $Line
        $ui.Log.AppendText('[' + (Get-Date).ToString('HH:mm:ss') + '] ' + $Line + "`r`n")
        $ui.Log.SelectionStart = $ui.Log.TextLength
        $ui.Log.ScrollToCaret()
        [System.Windows.Forms.Application]::DoEvents()
    } catch {
        $script:shellUi = $null
    }
}

function Show-ShellUi {
    param([string]$Title = 'dl-openshell', [string]$Message = 'starting')
    if ($script:noUi -or -not [Environment]::UserInteractive -or $env:CI) { return }

    try {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        [System.Windows.Forms.Application]::EnableVisualStyles()

        # The same palette the generated shell schemes use, so the desktop installer reads as
        # the same product: off-black body, dark-gray taskbar, gold border, green launcher mark.
        $offBlack = [System.Drawing.Color]::FromArgb(16, 19, 13)
        $panel = [System.Drawing.Color]::FromArgb(26, 26, 26)
        $gold = [System.Drawing.Color]::FromArgb(255, 237, 121)
        $green = [System.Drawing.Color]::FromArgb(95, 230, 158)
        $ink = [System.Drawing.Color]::FromArgb(255, 239, 215)
        $muted = [System.Drawing.Color]::FromArgb(198, 198, 198)

        $form = New-Object System.Windows.Forms.Form
        $form.Text = $Title
        $form.ClientSize = New-Object System.Drawing.Size(640, 430)
        $form.StartPosition = 'CenterScreen'
        $form.FormBorderStyle = 'FixedDialog'
        $form.MaximizeBox = $false
        $form.MinimizeBox = $false
        $form.ControlBox = $false
        $form.TopMost = $true
        $form.BackColor = $offBlack
        $form.ForeColor = $ink

        $taskbar = New-Object System.Windows.Forms.Panel
        $taskbar.Location = New-Object System.Drawing.Point(0, 0)
        $taskbar.Size = New-Object System.Drawing.Size(640, 32)
        $taskbar.BackColor = $panel
        $brand = New-Object System.Windows.Forms.Label
        $brand.Location = New-Object System.Drawing.Point(12, 6)
        $brand.Size = New-Object System.Drawing.Size(260, 20)
        $brand.Font = [System.Drawing.Font]::new('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
        $brand.ForeColor = $green
        $brand.Text = 'dl-openshell'
        $scheme = New-Object System.Windows.Forms.Label
        $scheme.Location = New-Object System.Drawing.Point(430, 7)
        $scheme.Size = New-Object System.Drawing.Size(198, 18)
        $scheme.TextAlign = 'MiddleRight'
        $scheme.ForeColor = $muted
        $scheme.Text = 'scheme  ·  deadlock'
        $taskbar.Controls.AddRange(@($brand, $scheme))

        $heading = New-Object System.Windows.Forms.Label
        $heading.Location = New-Object System.Drawing.Point(16, 46)
        $heading.Size = New-Object System.Drawing.Size(608, 26)
        $heading.Font = [System.Drawing.Font]::new('Segoe UI', 12, [System.Drawing.FontStyle]::Bold)
        $heading.ForeColor = $gold
        $heading.Text = 'dl-openshell is installing'

        $detail = New-Object System.Windows.Forms.Label
        $detail.Location = New-Object System.Drawing.Point(16, 76)
        $detail.Size = New-Object System.Drawing.Size(608, 20)
        $detail.ForeColor = $ink
        $detail.Text = $Message

        $logLabel = New-Object System.Windows.Forms.Label
        $logLabel.Location = New-Object System.Drawing.Point(16, 106)
        $logLabel.Size = New-Object System.Drawing.Size(608, 18)
        $logLabel.ForeColor = $green
        $logLabel.Text = 'Log'

        $log = New-Object System.Windows.Forms.TextBox
        $log.Location = New-Object System.Drawing.Point(16, 126)
        $log.Size = New-Object System.Drawing.Size(608, 214)
        $log.Multiline = $true
        $log.ReadOnly = $true
        $log.ScrollBars = 'Vertical'
        $log.WordWrap = $true
        $log.BackColor = $offBlack
        $log.ForeColor = $muted
        $log.BorderStyle = 'FixedSingle'
        $log.Font = [System.Drawing.Font]::new('Consolas', 9)

        $bar = New-Object System.Windows.Forms.ProgressBar
        $bar.Location = New-Object System.Drawing.Point(16, 352)
        $bar.Size = New-Object System.Drawing.Size(608, 18)
        $bar.Minimum = 0
        $bar.Maximum = 100
        $bar.Style = 'Continuous'
        $bar.Value = 0

        $percent = New-Object System.Windows.Forms.Label
        $percent.Location = New-Object System.Drawing.Point(16, 376)
        $percent.Size = New-Object System.Drawing.Size(608, 18)
        $percent.ForeColor = $gold
        $percent.Text = '0%  ·  starting'

        $note = New-Object System.Windows.Forms.Label
        $note.Location = New-Object System.Drawing.Point(16, 400)
        $note.Size = New-Object System.Drawing.Size(608, 18)
        $note.ForeColor = $muted
        $note.Text = 'Close Deadlock before installing.'

        $form.Controls.AddRange(@($taskbar, $heading, $detail, $logLabel, $log, $bar, $percent, $note))
        $form.Show()
        [System.Windows.Forms.Application]::DoEvents()
        $script:shellUi = [pscustomobject]@{
            Form = $form; Taskbar = $taskbar; Heading = $heading; Detail = $detail; Log = $log
            Bar = $bar; Percent = $percent; Note = $note; LastLog = ''
        }
        Add-ShellLog "minimal shell ready · scheme deadlock"
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
            $ui.Heading.Text = 'dl-openshell install failed'
            $ui.Heading.ForeColor = [System.Drawing.Color]::FromArgb(236, 112, 104)
            $ui.Note.Text = 'Nothing was mounted. Read the message above, then run the installer again.'
        } elseif ($State -eq 'ok') {
            $ui.Heading.Text = 'dl-openshell installed'
            $ui.Heading.ForeColor = [System.Drawing.Color]::FromArgb(132, 214, 138)
            $ui.Note.Text = 'Start Deadlock. The shell boots from its own addons/mods archive.'
        }
        if ($Message) { Add-ShellLog ("$Stage  ·  $Message") }
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
        $tip.Text = 'dl-openshell'
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
    Show-Toast -Title $(if ($Ok) { 'dl-openshell installed' } else { 'dl-openshell install failed' }) `
        -Text $Message -Kind $(if ($Ok) { 'Info' } else { 'Error' })
}

function Select-OpenShellGrade {
    param([string]$Selected = '')

    if ($Selected -in @('dev', 'observer', 'player')) { return $Selected }
    if ($script:noUi -or -not [Environment]::UserInteractive -or $env:CI) { return 'player' }

    try {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        [System.Windows.Forms.Application]::EnableVisualStyles()

        $form = New-Object System.Windows.Forms.Form
        $form.Text = 'dl-openshell install · choose a grade'
        $form.ClientSize = New-Object System.Drawing.Size(520, 300)
        $form.StartPosition = 'CenterScreen'
        $form.FormBorderStyle = 'FixedDialog'
        $form.MaximizeBox = $false
        $form.MinimizeBox = $false
        $form.TopMost = $true

        $heading = New-Object System.Windows.Forms.Label
        $heading.Location = New-Object System.Drawing.Point(18, 14)
        $heading.Size = New-Object System.Drawing.Size(484, 26)
        $heading.Font = [System.Drawing.Font]::new('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
        $heading.Text = 'Choose the shell grade'

        $choices = @(
            @{ Id = 'dev'; Text = 'Dev — every Deadlock and Deadworks addon and shell window is available.' }
            @{ Id = 'observer'; Text = 'Observer — hide the shell chrome so recordings stay clean; toasts still appear.' }
            @{ Id = 'player'; Text = 'Player — keep your UI layout schemes and load the saved scheme on startup.' }
        )

        $radios = @()
        $top = 50
        foreach ($choice in $choices) {
            $radio = New-Object System.Windows.Forms.RadioButton
            $radio.Location = New-Object System.Drawing.Point(18, $top)
            $radio.Size = New-Object System.Drawing.Size(484, 44)
            $radio.Text = $choice.Text
            $radio.Tag = $choice.Id
            if ($choice.Id -eq 'player') { $radio.Checked = $true }
            $form.Controls.Add($radio)
            $radios += $radio
            $top += 56
        }

        $ok = New-Object System.Windows.Forms.Button
        $ok.Location = New-Object System.Drawing.Point(396, 240)
        $ok.Size = New-Object System.Drawing.Size(106, 32)
        $ok.Text = 'Install'
        $form.Controls.Add($ok)
        $form.Controls.Add($heading)
        $form.AcceptButton = $ok
        $form.Tag = 'player'

        $ok.Add_Click({
            $picked = $form.Tag
            foreach ($radio in $radios) {
                if ($radio.Checked) { $picked = [string]$radio.Tag; break }
            }
            $form.Tag = $picked
            $form.Close()
        }.GetNewClosure())

        $form.ShowDialog() | Out-Null
        $picked = [string]$form.Tag
        $form.Dispose()
        if ($picked -in @('dev', 'observer', 'player')) { return $picked }
    } catch {
        Write-Warning "grade dialog unavailable: $($_.Exception.Message)"
    }

    return 'player'
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
    param([string]$Name, [string]$Destination, [int]$Attempts = 3)
    $base = if ($ReleaseBase) {
        $ReleaseBase.TrimEnd('/')
    } elseif ($ReleaseTag -and $ReleaseTag -ne 'latest') {
        "https://github.com/$ReleaseRepo/releases/download/$ReleaseTag"
    } else {
        "https://github.com/$ReleaseRepo/releases/latest/download"
    }
    $uri = "$base/$Name"
    # A CDN can close a connection mid-response, and one dropped socket is not a missing release.
    # Retry with backoff, discard the partial file before each attempt so a truncated archive is
    # never verified as if it were complete, and return one refusal that names the URL, the number
    # of attempts and the last error instead of the raw exception.
    $lastError = ''
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force }
            Invoke-WebRequest -Uri $uri -OutFile $Destination -UseBasicParsing -TimeoutSec 180
            if (Test-Path -LiteralPath $Destination) { return $null }
            $lastError = 'the request completed but wrote no file'
        } catch {
            $lastError = $_.Exception.Message
        }
        if ($attempt -lt $Attempts) {
            $wait = [Math]::Pow(2, $attempt - 1) * 2
            Write-Host "  download attempt $attempt for $Name failed: $lastError"
            Write-Host "  retrying in $wait s"
            Start-Sleep -Seconds $wait
        }
    }
    return "$uri — $Attempts attempt(s): $lastError"
}

$temp = Join-Path $env:TEMP ('openlock-release-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $temp | Out-Null
$downloadedVpk = Join-Path $temp 'pak01_dir.vpk'

try {
    $chosenGrade = Select-OpenShellGrade -Selected $Grade
    Show-ShellUi -Message "grade $chosenGrade · finding the Deadlock install"
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
        # A complete release drop-in carries the player VPK and its checksum beside this script;
        # using them makes the installer work offline and makes the same double-click path the
        # release advertises. Otherwise fall back to the published assets.
        $localVpk = Join-Path $PSScriptRoot 'openshell-player.vpk'
        $localHash = Join-Path $PSScriptRoot 'openshell-player.sha256'
        if ((Test-Path -LiteralPath $localVpk) -and (Test-Path -LiteralPath $localHash)) {
            $VpkPath = (Resolve-Path $localVpk).Path
            $HashPath = (Resolve-Path $localHash).Path
            Update-ShellUi -Percent 20 -Stage 'verify' -Message 'using the player archive beside the installer'
        } else {
            Update-ShellUi -Percent 12 -Stage 'download' -Message "downloading the verified player archive from $ReleaseRepo"
            $errorText = Get-ReleaseAsset -Name 'openshell-player.vpk' -Destination $downloadedVpk
            if ($errorText) {
                throw "Could not download the player archive from ${ReleaseRepo}: $errorText. A connection that keeps dropping is not a reason to install an unverified archive: retry later, or pass -VpkPath <file> -HashPath <file> to install a verified archive already on disk."
            }
            $checksumPath = Join-Path $temp 'openshell-player.sha256'
            Update-ShellUi -Percent 32 -Stage 'download' -Message 'downloading the release checksum'
            $errorText = Get-ReleaseAsset -Name 'openshell-player.sha256' -Destination $checksumPath
            if ($errorText) {
                throw "The release did not provide openshell-player.sha256, so the archive cannot be verified: $errorText"
            }
            $VpkPath = $downloadedVpk
            $HashPath = $checksumPath
        }
    }

    if ($HashPath) {
        $expected = (Get-Content -LiteralPath $HashPath -TotalCount 1).Trim().Split(' ')[0].ToLowerInvariant()
        if ($expected -notmatch '^[0-9a-f]{64}$') {
            throw "The release checksum is not a SHA-256 value: '$expected'."
        }
        $actual = (Get-FileHash -LiteralPath $VpkPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $expected) {
            throw "Archive hash $actual does not match the published $expected; refusing to install."
        }
        Write-Host "Verified release archive SHA-256 $actual"
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
        grade = $chosenGrade
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
    Complete-ShellUi -Ok $true -Message "Installed dl-openshell $chosenGrade into addons/mods ($([Math]::Round($archiveBytes / 1MB, 2)) MB). Start Deadlock."
    Write-Host "Installed $installedArchive"
    Write-Host "Mounted citadel/addons/mods from $gameinfo"
    exit 0
} catch {
    $failure = $_.Exception.Message
    Write-Host "dl-openshell install failed: $failure"
    Complete-ShellUi -Ok $false -Message $failure
    exit 1
} finally {
    if (-not $KeepArchive) {
        Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
    }
}
