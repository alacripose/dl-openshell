#Requires -Version 5.1
<#
.SYNOPSIS
  Build the dl-openshell UI addon as a VPK and mount it from the game's own search paths.

.DESCRIPTION
  The UI half is a normal Panorama mod packed as `pak01_dir.vpk`, so it is location-independent:
  one file mounts under whatever game directory the client is running from. This script assembles
  the content tree, packs it with the CSDK VPK tool,  installs the single archive into
  game/citadel/addons/mods, and puts that directory in gameinfo.gi's SearchPaths. It also
  removes the loose-file copy an earlier install left behind, so exactly one source is mounted.

  The game must be closed when the search path changes: gameinfo.gi is read at launch. The VPK
  itself can be replaced between sessions; nothing here touches deadlock.exe or a running server.
#>
[CmdletBinding()]
param(
    [string]$DeadlockRoot = '',
    [string]$SourceRoot = '',
    [string]$VpkTool = '',
    [string]$SdkRoot = '',
    [string]$Python = 'python',
    [string]$RepoUrl = '',
    [string[]]$PackageRepo = @(),
    [string]$PackageRef = '',
    [switch]$ForcePackage,
    [bool]$Update = $true,
    [switch]$NoUi,
    # The CSDK10 installer shell is the surface: launch.ps1 has already mounted it or is about to,
    # so this process must not draw a window of its own. A boot-shell host is not a headless run -
    # the build record it publishes is what that shell renders.
    [switch]$BootShellHost,
    # Rebuild and replace the mounted archive while the tools client is running. The search path
    # is already in gameinfo.gi, so this mode never rewrites it; the client's map reload picks up
    # the new archive. It is for the CSDK10 tools host, not the shipping game.
    [switch]$Live,
    [ValidateSet('dev', 'observer', 'player')]
    [string]$Grade = '',
    [switch]$VpkOnly,
    [switch]$Compile,
    [int]$PackTimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'

# Windows marks a downloaded script and the default policy refuses to run it before a single line
# of this file executes, so install.cmd is the double-click entry point. When the script does run,
# every terminating error still has to be visible: right-click "Run with PowerShell" closes the
# console as soon as the script exits, and a failed preflight would otherwise look like nothing
# happened.
function Show-InstallFailure {
    param([string]$Message)
    if ($script:noUi -or -not [Environment]::UserInteractive -or $env:CI) { return }

    try {
        Add-Type -AssemblyName System.Windows.Forms
        [void][System.Windows.Forms.MessageBox]::Show(
            $Message, 'dl-openshell install failed',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error)
    } catch {
        Write-Host "dl-openshell install failed: $Message"
    }
}

trap {
    $failure = $_.Exception.Message
    if (Get-Command Write-BuildRecord -ErrorAction SilentlyContinue) {
        try { Write-BuildRecord -Stage $script:buildStage -State 'failed' -Message $failure } catch { }
    }
    if (Get-Command Complete-InstallUi -ErrorAction SilentlyContinue) {
        try { Complete-InstallUi -Ok $false -Message $failure } catch { }
    }
    Show-InstallFailure $failure
    Write-Host "dl-openshell install failed: $failure"
    exit 1
}

# The launcher name is read from Steam by the running client, never baked into the VPK. A build
# copied to another player must show that player's name, not the builder's.

# The script is also shipped beside a game: in game/bin/win64 next to deadlock.exe or project8.exe.
# Resolve the install from the executable, then from an explicit root, so the same file works from
# a checkout and from a running game directory.
$gameExe = @('deadlock.exe', 'project8.exe') |
    ForEach-Object { Join-Path $PSScriptRoot $_ } |
    Where-Object { Test-Path $_ } | Select-Object -First 1

$roots = @()
if ($gameExe) { $roots += (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path }
if ($DeadlockRoot) { $roots += $DeadlockRoot }
$roots += 'D:\SteamLibrary\steamapps\common\Deadlock'
$roots += 'C:\Program Files (x86)\Steam\steamapps\common\Deadlock'

if (-not $DeadlockRoot) {
    foreach ($candidate in $roots) {
        if (Test-Path (Join-Path $candidate 'game\citadel\gameinfo.gi')) {
            $DeadlockRoot = $candidate
            break
        }
    }
}
if (-not $DeadlockRoot) {
    throw 'Could not find a Deadlock install. Run install.ps1 from game/bin/win64 or pass -DeadlockRoot.'
}
$DeadlockRoot = (Resolve-Path $DeadlockRoot).Path.TrimEnd('\')

$game = Join-Path $DeadlockRoot 'game'
$citadel = Join-Path $game 'citadel'
$gameinfo = Join-Path $citadel 'gameinfo.gi'
# Openlock owns a dedicated addon root. A mod manager may rewrite any shared `pak01_dir.vpk`
# path, so the shell does not install over or rename a file another manager owns: it creates
# `citadel/addons/mods` and mounts that directory only.
$addonRoot = Join-Path $citadel 'addons\mods'

if (-not (Test-Path $gameinfo)) {
    throw "gameinfo.gi not found at '$gameinfo'. The installer will not restore a backup without asking; verify the game files so Steam writes a clean copy, then run this again."
}

# Only a client running from the tree being installed can hold its gameinfo.gi or VPK open. A
# client from another tree (the live game beside a reduced tools install) is left untouched.
$runningTarget = @(Get-Process deadlock,project8 -ErrorAction SilentlyContinue | Where-Object {
    $path = ''
    try { $path = [string]$_.Path } catch { }
    $path -and $path.StartsWith($DeadlockRoot, [System.StringComparison]::OrdinalIgnoreCase)
})
$skipMount = $false
if ($runningTarget.Count -gt 0) {
    if (-not $Live) {
        throw 'Deadlock is running from the install tree. Close it and run this again, or pass -Live to replace the mounted archive for a map reload.'
    }
    $mountedText = ''
    try { $mountedText = [System.IO.File]::ReadAllText($gameinfo).Replace('\', '/').ToLowerInvariant() } catch { }
    if ($mountedText -notmatch 'citadel/addons/mods') {
        throw 'Live install needs citadel/addons/mods mounted already; run a normal install once before using -Live.'
    }
    $skipMount = $true
    Write-Host 'Live install: the tools client is running; the archive will be replaced and gameinfo.gi left untouched.'
}

# The source can be beside the script, in the parent checkout, in OPENLOCK_SOURCE, or cloned from
# -RepoUrl. A standalone copy next to the game is a supported placement; it is not required to
# carry the whole checkout in game/bin/win64.
$sourceCandidates = @()
if ($SourceRoot) { $sourceCandidates += $SourceRoot }
if ($env:OPENLOCK_SOURCE) { $sourceCandidates += $env:OPENLOCK_SOURCE }
$sourceCandidates += (Join-Path $PSScriptRoot 'clientaddon')
$sourceCandidates += (Join-Path (Split-Path $PSScriptRoot -Parent) 'clientaddon')
$sourceCandidates += (Join-Path $PSScriptRoot 'openlock-src\clientaddon')

if (-not $SourceRoot -and $RepoUrl -and -not ($sourceCandidates | Where-Object { Test-Path $_ })) {
    $clone = Join-Path $PSScriptRoot 'openlock-src'
    if (-not (Test-Path $clone)) {
        Write-Host "Cloning $RepoUrl into $clone"
        & git clone --depth 1 $RepoUrl $clone
        if ($LASTEXITCODE -ne 0) { throw "git clone failed with exit code $LASTEXITCODE." }
    }
    $sourceCandidates += (Join-Path $clone 'clientaddon')
}

$source = $sourceCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $source) {
    # The release asset is the standalone installer. A checkout root placed beside the game uses
    # that same path instead of failing on the absent source tree; it verifies and mounts the
    # published player VPK rather than compiling.
    $releaseInstaller = Join-Path $PSScriptRoot 'release\install.ps1'
    if (Test-Path -LiteralPath $releaseInstaller) {
        $releaseArgs = @{ DeadlockRoot = $DeadlockRoot; NoUi = [bool]($NoUi -or $BootShellHost) }
        if ($Grade) { $releaseArgs.Grade = $Grade }
        & $releaseInstaller @releaseArgs
        exit $LASTEXITCODE
    }

    throw "clientaddon not found. Use the install.ps1 published in the GitHub release (it downloads the verified player VPK), or pass -SourceRoot / -RepoUrl."
}
$repoRoot = Split-Path $source -Parent
$build = Join-Path $repoRoot 'dist\openlock_ui'
$archive = Join-Path $build 'pak01_dir.vpk'

# The installer publishes the work it is actually doing. The shell reads this record through the
# server bridge (or its baked fallback), so every stage, byte count and final VPK size is a value
# the tool wrote, never a value the window invented. Two copies are written: the repository one
# is the durable record, and the game/bin/win64 one is where a running server looks for it.
$buildRecordPath = Join-Path $repoRoot 'shell\alpha-shell\build.json'
$liveBuildPath = Join-Path $game 'bin\win64\openlock.build.json'
$script:buildStarted = Get-Date
$script:buildStage = 'prepare'
$script:buildState = 'running'
$script:buildStages = @()
$script:buildResources = 0
$script:buildVpkBytes = 0
$script:buildMessage = ''
$script:buildPackages = @()
$script:installUi = $null
$script:noUi = [bool]($NoUi -or $BootShellHost)
$script:installGrade = 'dev'

# The installer is the only Openlock surface when the game is closed. A small WinForms window
# shows the stage the record is actually in, and a tray balloon reports the final result. The UI
# is deliberately optional: a non-interactive or CI run still publishes the same record and
# never waits for a window.
function Select-InstallGrade {
    param([string]$Selected = '')

    if ($Selected) { return $Selected }
    if ($script:noUi -or -not [Environment]::UserInteractive -or $env:CI) { return 'dev' }

    try {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        [System.Windows.Forms.Application]::EnableVisualStyles()

        $form = New-Object System.Windows.Forms.Form
        $form.Text = 'dl-openshell install · choose a grade'
        $form.ClientSize = New-Object System.Drawing.Size(490, 286)
        $form.StartPosition = 'CenterScreen'
        $form.FormBorderStyle = 'FixedDialog'
        $form.MaximizeBox = $false
        $form.MinimizeBox = $false
        $form.TopMost = $true

        $heading = New-Object System.Windows.Forms.Label
        $heading.Location = New-Object System.Drawing.Point(16, 12)
        $heading.Size = New-Object System.Drawing.Size(458, 24)
        $heading.Font = [System.Drawing.Font]::new('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
        $heading.Text = 'Choose the shell grade'

        $choices = @(
            @{ Id = 'dev'; Text = 'Dev  —  every Deadlock and Deadworks addon and shell window is available.' }
            @{ Id = 'observer'; Text = 'Observer  —  hide the shell chrome and windows so recordings stay clean; toasts still appear.' }
            @{ Id = 'player'; Text = 'Player  —  keep your UI layout schemes and load the saved scheme automatically on startup.' }
        )

        $radios = @()
        $top = 46
        foreach ($choice in $choices) {
            $radio = New-Object System.Windows.Forms.RadioButton
            $radio.Location = New-Object System.Drawing.Point(16, $top)
            $radio.Size = New-Object System.Drawing.Size(458, 42)
            $radio.Text = $choice.Text
            $radio.Tag = $choice.Id
            if ($choice.Id -eq 'dev') { $radio.Checked = $true }
            $form.Controls.Add($radio)
            $radios += $radio
            $top += 54
        }

        $ok = New-Object System.Windows.Forms.Button
        $ok.Location = New-Object System.Drawing.Point(374, 226)
        $ok.Size = New-Object System.Drawing.Size(100, 30)
        $ok.Text = 'Install'
        $form.Controls.Add($ok)
        $form.Controls.Add($heading)
        $form.AcceptButton = $ok

        $form.Tag = 'dev'
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

    return 'dev'
}

function Add-InstallLog {
    param([string]$Line)
    if (-not $Line -or $null -eq $script:installUi) { return }

    try {
        $ui = $script:installUi
        if ($ui.LastLog -eq $Line) { return }
        $ui.LastLog = $Line
        $ui.Log.AppendText('[' + (Get-Date).ToString('HH:mm:ss') + '] ' + $Line + "`r`n")
        $ui.Log.SelectionStart = $ui.Log.TextLength
        $ui.Log.ScrollToCaret()
        [System.Windows.Forms.Application]::DoEvents()
    } catch {
        $script:installUi = $null
    }
}

function Start-InstallUi {
    if ($script:noUi -or -not [Environment]::UserInteractive -or $env:CI) { return }

    try {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        [System.Windows.Forms.Application]::EnableVisualStyles()

        # The installer is the minimal shell outside the game. It uses the same Deadlock
        # palette the generated schemes give the in-game taskbar and windows: off-black body,
        # dark-gray chrome, gold border, warm ink and the green launcher accent.
        $offBlack = [System.Drawing.Color]::FromArgb(16, 19, 13)
        $panel = [System.Drawing.Color]::FromArgb(26, 26, 26)
        $title = [System.Drawing.Color]::FromArgb(46, 44, 39)
        $border = [System.Drawing.Color]::FromArgb(68, 68, 68)
        $gold = [System.Drawing.Color]::FromArgb(255, 237, 121)
        $green = [System.Drawing.Color]::FromArgb(95, 230, 158)
        $ink = [System.Drawing.Color]::FromArgb(255, 239, 215)
        $muted = [System.Drawing.Color]::FromArgb(198, 198, 198)

        $form = New-Object System.Windows.Forms.Form
        $form.Text = 'dl-openshell'
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
        $detail.Text = 'starting'

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

        $percent = New-Object System.Windows.Forms.Label
        $percent.Location = New-Object System.Drawing.Point(16, 376)
        $percent.Size = New-Object System.Drawing.Size(608, 18)
        $percent.ForeColor = $gold
        $percent.Text = '0%  ·  prepare'

        $note = New-Object System.Windows.Forms.Label
        $note.Location = New-Object System.Drawing.Point(16, 400)
        $note.Size = New-Object System.Drawing.Size(608, 18)
        $note.ForeColor = $muted
        $note.Text = 'Close Deadlock before installing.'

        $form.Controls.AddRange(@($taskbar, $heading, $detail, $logLabel, $log, $bar, $percent, $note))
        $form.Show()
        [System.Windows.Forms.Application]::DoEvents()
        $script:installUi = [pscustomobject]@{
            Form = $form
            Taskbar = $taskbar
            Heading = $heading
            Detail = $detail
            Log = $log
            Bar = $bar
            Percent = $percent
            LastLog = ''
        }
        Add-InstallLog "minimal shell ready · grade $script:installGrade · scheme deadlock"
        Update-InstallUi -Percent 0 -Stage 'prepare' -Message 'starting'
    } catch {
        $script:installUi = $null
        Write-Warning "installer window unavailable: $($_.Exception.Message)"
    }
}

function Update-InstallUi {
    param([int]$Percent, [string]$Stage, [string]$Message, [string]$State = 'running')
    if ($null -eq $script:installUi) { return }

    try {
        $ui = $script:installUi
        $ui.Bar.Value = [Math]::Max(0, [Math]::Min(100, $Percent))
        $ui.Percent.Text = "$([Math]::Max(0, [Math]::Min(100, $Percent)))%  ·  $Stage"
        if ($Message) { $ui.Detail.Text = $Message }
        $ui.Heading.Text = if ($State -eq 'failed') { 'dl-openshell install failed' } else { 'dl-openshell is installing' }
        $ui.Heading.ForeColor = if ($State -eq 'failed') {
            [System.Drawing.Color]::FromArgb(236, 112, 104)
        } elseif ($State -eq 'ok') {
            [System.Drawing.Color]::FromArgb(132, 214, 138)
        } else {
            [System.Drawing.Color]::FromArgb(255, 237, 121)
        }
        if ($Message) { Add-InstallLog ("$Stage  ·  $Message") }
        [System.Windows.Forms.Application]::DoEvents()
    } catch {
        $script:installUi = $null
    }
}

function Show-OpenlockToast {
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

function Complete-InstallUi {
    param([bool]$Ok, [string]$Message)

    if ($null -ne $script:installUi) {
        Update-InstallUi -Percent $(if ($Ok) { 100 } else { 0 }) -Stage $(if ($Ok) { 'installed' } else { 'failed' }) `
            -Message $Message -State $(if ($Ok) { 'ok' } else { 'failed' })
        Start-Sleep -Milliseconds 700
        try {
            $script:installUi.Form.Close()
            $script:installUi.Form.Dispose()
        } catch { }
        $script:installUi = $null
    }

    Show-OpenlockToast -Title $(if ($Ok) { 'dl-openshell installed' } else { 'dl-openshell install failed' }) `
        -Text $Message -Kind $(if ($Ok) { 'Info' } else { 'Error' })
}

function Write-BuildRecord {
    param(
        [string]$Stage = '',
        [string]$State = 'running',
        [int]$Resources = -1,
        [long]$VpkBytes = -1,
        [string]$Message = '',
        [object[]]$Packages = $null
    )

    if ($Stage) { $script:buildStage = $Stage }
    if ($State) { $script:buildState = $State }
    if ($Resources -ge 0) { $script:buildResources = $Resources }
    if ($VpkBytes -ge 0) { $script:buildVpkBytes = $VpkBytes }
    if ($Message) { $script:buildMessage = $Message }
    if ($null -ne $Packages) { $script:buildPackages = @($Packages) }

    $now = Get-Date
    if ($Stage) {
        $found = $false
        foreach ($row in $script:buildStages) {
            if ($row.name -ne $Stage) { continue }
            $found = $true
            if ($State -eq 'running') {
                $row.state = 'running'
                $row.startedAt = $now.ToString('HH:mm:ss')
            } elseif ($State -eq 'ok') {
                $row.state = 'ok'
                $row.finishedAt = $now.ToString('HH:mm:ss')
            } elseif ($State -eq 'failed') {
                $row.state = 'failed'
                $row.finishedAt = $now.ToString('HH:mm:ss')
            }
        }
        if (-not $found) {
            $stageFinished = ''
            if ($State -ne 'running') { $stageFinished = $now.ToString('HH:mm:ss') }
            $script:buildStages += [ordered]@{
                name = $Stage
                state = $State
                startedAt = $now.ToString('HH:mm:ss')
                finishedAt = $stageFinished
            }
        }
    }

    $finishedAt = ''
    if ($script:buildState -eq 'ok') { $finishedAt = $now.ToString('yyyy-MM-dd HH:mm:ss') }
    $record = [ordered]@{
        format = 'openlock.build/1'
        grade = $script:installGrade
        stage = $script:buildStage
        state = $script:buildState
        startedAt = $script:buildStarted.ToString('yyyy-MM-dd HH:mm:ss')
        updatedAt = $now.ToString('yyyy-MM-dd HH:mm:ss')
        finishedAt = $finishedAt
        vpk = 'dist/openlock_ui/pak01_dir.vpk'
        vpkBytes = $script:buildVpkBytes
        resources = $script:buildResources
        path = 'citadel/addons/mods/pak01_dir.vpk'
        stages = $script:buildStages
        message = $script:buildMessage
        packages = $script:buildPackages
    }

    $json = $record | ConvertTo-Json -Depth 6
    foreach ($path in @($buildRecordPath, $liveBuildPath)) {
        try {
            $parent = Split-Path $path -Parent
            if (-not (Test-Path $parent)) { continue }
            [System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
        } catch {
            Write-Warning "could not publish build record '$path': $($_.Exception.Message)"
        }
    }

    $percent = switch ($script:buildStage) {
        'prepare' { 10 }
        'compile' { 40 }
        'pack' { 72 }
        'install' { 90 }
        'installed' { 100 }
        default { 5 }
    }
    if ($script:buildState -eq 'failed') { $percent = [Math]::Min($percent, 99) }
    Update-InstallUi -Percent $percent -Stage $script:buildStage -Message $script:buildMessage -State $script:buildState
}

$script:installGrade = Select-InstallGrade -Selected $Grade
Start-InstallUi

Write-BuildRecord -Stage 'prepare' -State 'running' -Message 'assembling the client tree'

# Read one NUL-terminated string from a VPK directory tree. Returns $null when the tree ends
# before a terminator, which is how Test-VpkArchive tells a truncated tree from an empty string.
function Read-VpkString([byte[]]$Data, [int]$Start, [ref]$Next) {
    $i = $Start
    while ($i -lt $Data.Length -and $Data[$i] -ne 0) { $i++ }
    if ($i -ge $Data.Length) { return $null }
    $value = [System.Text.Encoding]::UTF8.GetString($Data, $Start, $i - $Start)
    $Next.Value = $i + 1
    return $value
}

# An entry name is a resource path under the archive root. The engine resolves it against the
# mount, so `..`, an absolute path, a drive prefix or a backslash must never reach it.
function Test-VpkEntryPath([string]$Path) {
    if (-not $Path) { return $false }
    if ($Path -match '[:\\]') { return $false }
    foreach ($segment in $Path.Split('/')) {
        if (-not $segment -or $segment -eq '.' -or $segment -eq '..') { return $false }
    }
    return $true
}

# A VPK is installable only when its header and directory tree parse. The packer in this SDK can
# leave a syntactically complete archive behind and then not exit; this check is what makes that
# observable success, and what refuses a half-written file. Returns $null on success, or the
# reason as a string.
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
            $ext = Read-VpkString -Data $tree -Start $pos -Next ([ref]$next)
            if ($null -eq $ext) { return 'VPK tree has an unterminated extension string' }
            $pos = $next
            if ($ext.Length -eq 0) { break }
            $extensions++
            while ($true) {
                $next = 0
                $dir = Read-VpkString -Data $tree -Start $pos -Next ([ref]$next)
                if ($null -eq $dir) { return 'VPK tree has an unterminated directory string' }
                $pos = $next
                if ($dir.Length -eq 0) { break }
                while ($true) {
                    $next = 0
                    $name = Read-VpkString -Data $tree -Start $pos -Next ([ref]$next)
                    if ($null -eq $name) { return 'VPK tree has an unterminated entry name' }
                    $pos = $next
                    if ($name.Length -eq 0) { break }
                    if ($pos + 18 -gt $treeSize) { return 'VPK entry metadata runs past the tree' }
                    $pos += 18
                    $entryPath = if ($dir.Length -gt 0) { "$dir/$name" } else { $name }
                    if ($ext.Length -gt 0) { $entryPath += '.' + $ext }
                    if (-not (Test-VpkEntryPath $entryPath)) {
                        return "VPK entry '$entryPath' escapes the archive root"
                    }
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

function Stop-VpkPacker([System.Diagnostics.Process]$Process) {
    if (-not $Process) { return }
    if (-not $Process.HasExited) {
        try { $Process.Kill() } catch {}
        try { [void]$Process.WaitForExit(5000) } catch {}
    }
}

function Get-LogTail([string]$Path) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return '' }
    return ((Get-Content -LiteralPath $Path -Tail 12 -ErrorAction SilentlyContinue) -join "`n")
}

# A clean checkout may fast-forward to the remote before the version-specific generation. Local
# changes are never discarded; an update is skipped and the build proceeds from what is here.
if ($Update -and (Test-Path (Join-Path $repoRoot '.git'))) {
    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($git) {
        $dirty = & git -C $repoRoot status --porcelain
        if ($LASTEXITCODE -eq 0 -and -not ($dirty -join '').Trim()) {
            Write-Host 'Updating source with git pull --ff-only'
            & git -C $repoRoot pull --ff-only
            if ($LASTEXITCODE -ne 0) { throw "git pull failed with exit code $LASTEXITCODE; refusing to build an unknown revision." }
        } else {
            Write-Host 'Source has local changes; skipping git update rather than overwriting them.'
        }
    }
}

# The layout catalog, tool paths, themes and build record must describe the game copy being
# installed, not the checkout that happened to build the archive. They are generated from this
# game's own gameinfo.gi and VPKs into the build tree only: installing to a minimal tools client
# must never rewrite the checked-in live assets that the current game install ships.
$generator = Join-Path $repoRoot 'tools\gen_shell_data.py'
if (-not (Test-Path $generator)) { throw "data generator not found at '$generator'." }

$sdkCandidates = @()
if ($SdkRoot) { $sdkCandidates += $SdkRoot }
if ($env:OPENLOCK_SDK) { $sdkCandidates += $env:OPENLOCK_SDK }
$sdkCandidates += $PSScriptRoot
$sdkCandidates += (Join-Path $PSScriptRoot '..\..\..')
$sdkCandidates += 'C:\Program Files (x86)\Steam\steamapps\content\app_1422450\depot_1422456'
$sdkCandidates += 'D:\Users\alacrity\Documents\Documents\Reduced_CSDK_12'

if (-not $SdkRoot) {
    foreach ($candidate in $sdkCandidates) {
        if ($candidate -and (Test-Path (Join-Path $candidate 'game\bin\win64\resourcecompiler.exe'))) {
            $SdkRoot = $candidate
            break
        }
    }
}

if (-not $VpkTool) {
    $vpkCandidates = @()
    if ($SdkRoot) { $vpkCandidates += (Join-Path $SdkRoot 'game\bin\win64\CSDKCfgVPK.exe') }
    $vpkCandidates += (Join-Path $PSScriptRoot 'CSDKCfgVPK.exe')
    $vpkCandidates += (Join-Path $repoRoot 'tools\CSDKCfgVPK.exe')
    foreach ($candidate in $vpkCandidates) {
        if ($candidate -and (Test-Path $candidate)) { $VpkTool = $candidate; break }
    }
}

$pythonPacker = Join-Path $repoRoot 'tools\pack_vpk.py'
if (-not $VpkTool -or -not (Test-Path $VpkTool)) {
    if (-not (Test-Path $pythonPacker)) {
        throw 'CSDKCfgVPK.exe not found. Pass -VpkTool, set OPENLOCK_SDK, or keep tools/pack_vpk.py for the built-in packer.'
    }
    $VpkTool = $pythonPacker
}
$vpkWithPython = $VpkTool.EndsWith('.py', [System.StringComparison]::OrdinalIgnoreCase)
if (-not $SdkRoot) {
    throw 'resourcecompiler.exe not found. Pass -SdkRoot or set OPENLOCK_SDK.'
}

# 1. Assemble the content tree.
#
#    A live install gets the live base_hud only, byte-for-byte. A reduced CSDK 10 tools tree gets
#    its own base_hud and base_dashboard, both built from the stock host roots, plus a legacy shell
#    entry generated from the live shell at pack time. The workaround for the older parser therefore
#    never exists inside the live layouts, sheet or script.
$toolsTarget = Test-Path (Join-Path $DeadlockRoot 'game\citadel_addons')
if (Test-Path $build) { Remove-Item $build -Recurse -Force }
$contentLayout = Join-Path $build 'panorama\layout'
$contentScripts = Join-Path $build 'panorama\scripts'
$contentStyles = Join-Path $build 'panorama\styles'
New-Item -ItemType Directory -Force -Path $contentLayout, $contentScripts, $contentStyles | Out-Null

# The shell's four procedural UI cues are rendered from tools/gen_shell_audio.py.
# They are generated into the build tree, never checked in as binary assets, so the
# WAVs and the soundevent manifest cannot drift from the synthesis table.
$audioGenerator = Join-Path $repoRoot 'tools\gen_shell_audio.py'
if (-not (Test-Path $audioGenerator)) { throw "audio generator not found at '$audioGenerator'." }
& $Python $audioGenerator --self-test
if ($LASTEXITCODE -ne 0) {
    throw "gen_shell_audio.py self-test failed with exit code $LASTEXITCODE; refusing to pack uncertified audio."
}
& $Python $audioGenerator $build
if ($LASTEXITCODE -ne 0) {
    throw "gen_shell_audio.py failed with exit code $LASTEXITCODE; refusing to pack a silent shell."
}

Copy-Item (Join-Path $source 'panorama\layout\*.xml') $contentLayout -Force
Copy-Item (Join-Path $source 'panorama\scripts\*.js') $contentScripts -Force
Copy-Item (Join-Path $source 'panorama\styles\*.css') $contentStyles -Force
Copy-Item (Join-Path $source 'standalone\panorama\scripts\openlock_boot.js') $contentScripts -Force
Copy-Item (Join-Path $source 'standalone\panorama\layout\base_hud.xml') $contentLayout -Force

& $Python $generator (Join-Path $repoRoot 'shell\alpha-shell') `
    (Join-Path $contentScripts 'openlock_shell_data.js') `
    $gameinfo (Join-Path $contentStyles 'openlock_schemes.css')
if ($LASTEXITCODE -ne 0) {
    throw "gen_shell_data.py failed with exit code $LASTEXITCODE; refusing to pack stale UI data."
}

if ($toolsTarget) {
    Copy-Item (Join-Path $source 'standalone\tools\panorama\layout\base_hud.xml') $contentLayout -Force
    Copy-Item (Join-Path $source 'standalone\tools\panorama\layout\base_dashboard.xml') $contentLayout -Force
    Copy-Item (Join-Path $source 'standalone\tools\panorama\scripts\openlock_boot_csdk10.js') $contentScripts -Force
    & $Python (Join-Path $repoRoot 'tools\gen_legacy_shell.py') `
        (Join-Path $source 'panorama\layout\openlock_shell.xml') `
        (Join-Path $source 'panorama\styles\openlock_shell.css') `
        (Join-Path $contentLayout 'openlock_shell_legacy.xml') `
        (Join-Path $contentStyles 'openlock_shell_legacy.css')
    if ($LASTEXITCODE -ne 0) {
        throw "gen_legacy_shell.py failed with exit code $LASTEXITCODE; the tools shell entry was not generated."
    }
}

# Fonts and stock art stay the game's. The addon supplies layouts, scripts, styles and the one
# root HUD mount; a file under panorama/fonts here would override the client's own font set and
# would not come back when Steam verifies the game files. The search path is the only install
# surface, so verification restores the defaults and rerunning this script remounts the addon.
$fontOverrides = @(Get-ChildItem $build -Recurse -File |
    Where-Object { ($_.FullName.Replace('\', '/') -like '*/panorama/fonts/*') -or ($_.FullName.Replace('\', '/') -like '*/resource/fonts/*') -or $_.Extension -in '.ttf', '.otf' })
if ($fontOverrides.Count -gt 0) {
    throw "Refusing to pack font overrides: $($fontOverrides.FullName -join ', ')"
}

# A second stock override would be a second answer for one layout name. Refuse it here rather
# than let search-path order decide which copy the client parses.
$allowedOverrides = if ($toolsTarget) { @('base_hud.xml', 'base_dashboard.xml') } else { @('base_hud.xml') }
$overrideDirs = if ($toolsTarget) {
    @((Join-Path $source 'standalone\panorama\layout'), (Join-Path $source 'standalone\tools\panorama\layout'))
} else {
    @((Join-Path $source 'standalone\panorama\layout'))
}
$stockOverrides = @($overrideDirs | ForEach-Object {
    Get-ChildItem $_ -Filter *.xml | Where-Object { $allowedOverrides -notcontains $_.Name }
})
if ($stockOverrides.Count -gt 0) {
    throw "Only $($allowedOverrides -join ' and ') may override a stock layout; refusing: $($stockOverrides.Name -join ', ')"
}

# 2. Every include each layout names must exist in the tree that is about to be packed. A missing
#    include aborts the client when the layout is loaded, so this is a hard pack-time refusal rather
#    than something to discover by launching the game.
$missing = @()
foreach ($layout in @(Get-ChildItem (Join-Path $build 'panorama\layout') -Filter *.xml)) {
    foreach ($match in [regex]::Matches((Get-Content $layout.FullName -Raw), '<include\s+src="file://\{resources\}/([^"]+)"')) {
        # {resources} is the archive's panorama root, so an include is resolved under panorama/.
        $relative = $match.Groups[1].Value -replace '/', '\'
        if (-not (Test-Path (Join-Path (Join-Path $build 'panorama') $relative))) { $missing += "$($layout.Name) -> $relative" }
    }
}
if ($missing.Count -gt 0) {
    throw "Layout includes with no file in the package: $($missing -join '; ')"
}

Write-BuildRecord -Stage 'prepare' -State 'ok' -Message 'client tree assembled'

# 3. Compile. The shipping client resolves `panorama/layout/base_hud.vxml_c`, not an .xml source:
#    a source-only archive draws nothing. Compiling is therefore part of the install, and the
#    override is only accepted once every compiled artifact the layout names is on disk.
$compiler = Join-Path $SdkRoot 'game\bin\win64\resourcecompiler.exe'
$sdkContent = Join-Path $SdkRoot 'content\citadel_addons\openlock_ui'
$sdkBuilt = Join-Path $SdkRoot 'game\citadel_addons\openlock_ui'

if (-not (Test-Path $compiler)) {
    throw "resourcecompiler.exe is not at '$compiler'. The client loads compiled Panorama resources, so a source-only install cannot draw.'"
}

if (-not $Compile) {
    Write-Host 'Compiling: the client resolves base_hud.vxml_c, so this install always compiles.'
}

$compiledCount = 0
if (Test-Path $compiler) {
    Write-BuildRecord -Stage 'compile' -State 'running' -Message 'compiling Panorama resources'
    if (Test-Path $sdkContent) { Remove-Item $sdkContent -Recurse -Force }
    if (Test-Path $sdkBuilt) { Remove-Item $sdkBuilt -Recurse -Force }
    New-Item -ItemType Directory -Force -Path (Join-Path $sdkContent 'panorama'), (Join-Path $sdkContent 'sounds'), (Join-Path $sdkContent 'soundevents') | Out-Null
    Copy-Item (Join-Path $build 'panorama\*') (Join-Path $sdkContent 'panorama') -Recurse -Force
    Copy-Item (Join-Path $build 'sounds\*') (Join-Path $sdkContent 'sounds') -Recurse -Force
    Copy-Item (Join-Path $build 'soundevents\*') (Join-Path $sdkContent 'soundevents') -Recurse -Force

    # Absolute inputs: the compiler resolves a relative one against its own start directory, and
    # Start-Process does not always hand it the one this script set.
    $inputs = @(
        'panorama\layout\openlock_shell.xml',
        'panorama\layout\openlock_shell_server.xml',
        'panorama\layout\openlock_hud.xml',
        'panorama\layout\base_hud.xml',
        'panorama\scripts\openlock_shell.js',
        'panorama\scripts\openlock_audio.js',
        'panorama\scripts\openlock_delivery.js',
        'panorama\scripts\openlock_popit.js',
        'panorama\scripts\openlock_server_mount.js',
        'panorama\scripts\openlock_hud.js',
        'panorama\scripts\openlock_shell_data.js',
        'panorama\scripts\openlock_boot.js',
        'panorama\styles\openlock_shell.css',
        'panorama\styles\openlock_schemes.css'
    )
    if ($toolsTarget) {
        $inputs += @(
            'panorama\layout\base_dashboard.xml',
            'panorama\layout\openlock_shell_legacy.xml',
            'panorama\scripts\openlock_boot_csdk10.js',
            'panorama\styles\openlock_shell_legacy.css'
        )
    }
    $inputs = $inputs | ForEach-Object { (Join-Path $sdkContent $_).Replace('\', '/') }

    # One command-line string: PowerShell 5.1 does not reliably split an array into separate
    # native arguments, and a compiler that receives one space-joined path compiles nothing.
    $compileArgs = '-f -nop4 -DANGER_MODE_ignore_schema_mismatches -game "' +
        (Join-Path $SdkRoot 'game\citadel') + '" -i ' + ($inputs -join ' ')

    $process = Start-Process -FilePath $compiler -ArgumentList $compileArgs -WorkingDirectory $SdkRoot -Wait -PassThru -NoNewWindow
    if ($process.ExitCode -ne 0) {
        throw "resourcecompiler failed with exit code $($process.ExitCode)."
    }

    # Sound is a two-pass compile: the WAVs become .vsnd_c first, then the manifest
    # resolves those names. A single pass would emit the manifest before its samples
    # exist and resourcecompiler would report "Couldn't read asset".
    # Compile from the SDK's addon tree, not the checkout's dist tree. resourcecompiler
    # resolves a resource's mod from the path under content/citadel_addons; a source path
    # in the checkout is reported as "unknown mod ''" and the WAV compile fails.
    $soundWavs = @(Get-ChildItem (Join-Path $sdkContent 'sounds\openlock') -Filter *.wav -File |
        ForEach-Object { $_.FullName.Replace('\', '/') })
    if ($soundWavs.Count -eq 0) { throw 'gen_shell_audio.py wrote no WAVs under sounds/openlock.' }
    $soundManifest = (Join-Path $sdkContent 'soundevents\openlock_ui.vsndevts').Replace('\', '/')
    if (-not (Test-Path $soundManifest)) { throw "audio manifest not generated at '$soundManifest'." }

    $soundArgs = '-f -nop4 -DANGER_MODE_ignore_schema_mismatches -game "' +
        (Join-Path $SdkRoot 'game\citadel') + '" -i ' + ($soundWavs -join ' ')
    $soundProcess = Start-Process -FilePath $compiler -ArgumentList $soundArgs -WorkingDirectory $SdkRoot -Wait -PassThru -NoNewWindow
    if ($soundProcess.ExitCode -ne 0) {
        throw "resourcecompiler failed on the shell WAVs with exit code $($soundProcess.ExitCode)."
    }

    $manifestArgs = '-f -nop4 -DANGER_MODE_ignore_schema_mismatches -game "' +
        (Join-Path $SdkRoot 'game\citadel') + '" -i ' + $soundManifest
    $manifestProcess = Start-Process -FilePath $compiler -ArgumentList $manifestArgs -WorkingDirectory $SdkRoot -Wait -PassThru -NoNewWindow
    if ($manifestProcess.ExitCode -ne 0) {
        throw "resourcecompiler failed on the shell soundevent manifest with exit code $($manifestProcess.ExitCode)."
    }

    $compiled = Get-ChildItem $sdkBuilt -Recurse -File -Include *.vxml_c, *.vjs_c, *.vcss_c, *.vsnd_c, *.vsndevts_c
    if (-not $compiled) { throw "resourcecompiler reported success but wrote no compiled resource under '$sdkBuilt'." }
    $compiledCount = @($compiled).Count
    foreach ($file in $compiled) {
        $relative = $file.FullName.Substring($sdkBuilt.Length + 1)
        Copy-Item $file.FullName (Join-Path $build $relative) -Force
    }

    # The boot script is included by base_hud. A missing .vjs_c there aborts the layout load,
    # which is the whole HUD, so this is a hard failure here rather than a discovery at launch.
    $required = @(
        'panorama\layout\base_hud.vxml_c',
        'panorama\layout\openlock_shell.vxml_c',
        'panorama\layout\openlock_shell_server.vxml_c',
        'panorama\scripts\openlock_server_mount.vjs_c',
        'panorama\scripts\openlock_audio.vjs_c',
        'panorama\scripts\openlock_delivery.vjs_c',
        'panorama\scripts\openlock_popit.vjs_c',
        'panorama\scripts\openlock_boot.vjs_c',
        'panorama\styles\openlock_schemes.vcss_c',
        'sounds\openlock\select.vsnd_c',
        'sounds\openlock\place.vsnd_c',
        'sounds\openlock\refuse.vsnd_c',
        'sounds\openlock\notify.vsnd_c',
        'soundevents\openlock_ui.vsndevts_c'
    )
    if ($toolsTarget) {
        $required += @(
            'panorama\layout\base_dashboard.vxml_c',
            'panorama\layout\openlock_shell_legacy.vxml_c',
            'panorama\scripts\openlock_boot_csdk10.vjs_c',
            'panorama\styles\openlock_shell_legacy.vcss_c'
        )
    }
    $absent = @($required | Where-Object { -not (Test-Path (Join-Path $build $_)) })
    if ($absent.Count -gt 0) {
        throw "resourcecompiler wrote no $($absent -join ', '); base_hud would abort at load."
    }

    Write-Host "Compiled $($compiled.Count) Panorama resources with $compiler"
    Write-BuildRecord -Stage 'compile' -State 'ok' -Resources $compiledCount -Message "compiled $compiledCount Panorama resources"
}

# 3b. Live tools update. The mounted VPK resolves before the loose tree on the CSDK10 client:
#     leaving a stale archive beside fresh `_c` files is a split authority, and the client keeps
#     reading the archive. Copy the loose resources for inspection, then pack and replace the
#     archive below. The fallback in step 5 can replace a held archive in place; the client still
#     needs a map reload, never a restart.
if ($Live) {
    # The CSDK10 tools client mounts `AddonRoot citadel_addons`, so its live slot is
    # game/citadel_addons/openlock_ui, not the shipping game's citadel/addons/mods archive. The
    # server tools slot reads the loose compiled resources and the layout XML beside them; a VPK
    # written into the game addon directory is not this slot's authority.
    $toolsAddon = Join-Path $game 'citadel_addons\openlock_ui'
    $liveRoot = Join-Path $toolsAddon 'panorama'
    $compiledRoot = Join-Path $build 'panorama'
    if (Test-Path -LiteralPath $liveRoot) { Remove-Item -LiteralPath $liveRoot -Recurse -Force }
    $liveCount = 0
    foreach ($file in @(Get-ChildItem $compiledRoot -Recurse -File -Include *.vxml_c, *.vjs_c, *.vcss_c, *.xml)) {
        $relative = $file.FullName.Substring($compiledRoot.Length + 1)
        $target = Join-Path $liveRoot $relative
        New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
        Copy-Item -LiteralPath $file.FullName -Destination $target -Force
        $liveCount++
    }
    foreach ($sub in @('sounds', 'soundevents')) {
        $from = Join-Path $build $sub
        $to = Join-Path $toolsAddon $sub
        if (-not (Test-Path $from)) { continue }
        if (Test-Path $to) { Remove-Item $to -Recurse -Force }
        Copy-Item $from $to -Recurse -Force
        $liveCount += @(Get-ChildItem $to -Recurse -File).Count
    }
    if ($liveCount -lt 1) { throw 'Live install compiled no resources to copy.' }
    Write-BuildRecord -Stage 'installed' -State 'ok' -Resources $liveCount `
        -Message "live tools slot $liveCount resources for the next map reload"
    Write-Host "Live install: $liveCount resource(s) in $liveRoot (server tools slot)."
    Write-Host 'The shipping game archive and gameinfo.gi were not touched.'

    # A CSDK10 change is not complete until the live Steam client also carries it. Refuse the
    # tools install explicitly instead of reporting a successful development mount.
    $parityTool = Join-Path $PSScriptRoot 'tools\parity_check.py'
    if (Test-Path -LiteralPath $parityTool) {
        $parityOut = & $Python $parityTool --install $DeadlockRoot --require-live 2>&1
        $parityCode = $LASTEXITCODE
        $parityOut | ForEach-Object { Write-Host $_ }
        if ($parityCode -ne 0) {
            throw "Live tools install refused: the CSDK10 slot was written, but the live Steam client did not receive this build. Deliver the signed shell package to the player client before continuing (exit $parityCode)."
        }
    }
    return
}

# 4. Pack it. CSDKCfgVPK takes a content directory and the archive to write. On this SDK the
#    packer writes the archive and then never exits, so run it as a child, wait for a stable file,
#    terminate it when it overruns, and validate the VPK tree before installing. A timeout only
#    ends the wait; a missing or invalid archive is still a hard failure.
if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
$packLog = Join-Path $env:TEMP ('openlock-vpk-' + [guid]::NewGuid().ToString('N') + '.out.log')
$packErr = Join-Path $env:TEMP ('openlock-vpk-' + [guid]::NewGuid().ToString('N') + '.err.log')
$packArgs = '"' + $build + '" "' + $archive + '"'
$packTimeout = [Math]::Max(5, $PackTimeoutSeconds)
Write-BuildRecord -Stage 'pack' -State 'running' -Message 'packing pak01_dir.vpk'
Write-Host "Packing with $VpkTool"
try {
    if ($vpkWithPython) {
        # Same content directory and archive path as the SDK packer; Python exits when done.
        $pack = Start-Process -FilePath $Python -ArgumentList ('"' + $VpkTool + '" "' + $build + '" "' + $archive + '"') `
            -WorkingDirectory $repoRoot -PassThru -NoNewWindow -RedirectStandardOutput $packLog -RedirectStandardError $packErr
    } else {
        $pack = Start-Process -FilePath $VpkTool -ArgumentList $packArgs -WorkingDirectory $repoRoot `
            -PassThru -NoNewWindow -RedirectStandardOutput $packLog -RedirectStandardError $packErr
    }
} catch {
    throw "Could not start the VPK packer at '$VpkTool': $($_.Exception.Message)"
}
if (-not $pack) { throw 'The VPK packer did not start.' }

$deadline = (Get-Date).AddSeconds($packTimeout)
$lastLength = -1
$stablePolls = 0
$packExited = $false
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
    if ($pack.HasExited) { $packExited = $true; break }
    $item = Get-Item -LiteralPath $archive -ErrorAction SilentlyContinue
    if ($item -and $item.Length -gt 0) {
        if ($item.Length -eq $lastLength) {
            $stablePolls++
        } else {
            $stablePolls = 0
            $lastLength = $item.Length
        }
        if ($stablePolls -ge 3) { break }
        Write-BuildRecord -Stage 'pack' -State 'running' -VpkBytes $item.Length -Message 'packing pak01_dir.vpk'
    } else {
        $stablePolls = 0
    }
}
$timedOut = (-not $packExited -and $stablePolls -lt 3)
$packerWasRunning = -not $pack.HasExited
$packExitCode = $null
if ($pack.HasExited) {
    # Start-Process can leave ExitCode null even after the child exits. Refresh before reading it
    # so a successful Python packer is not announced as "exited with code " and treated as a
    # warning by the boot shell.
    $pack.Refresh()
    if ($null -ne $pack.ExitCode) { $packExitCode = [int]$pack.ExitCode }
}
if ($packerWasRunning) { Stop-VpkPacker $pack }

$archiveInfo = Get-Item -LiteralPath $archive -ErrorAction SilentlyContinue
$archiveBytes = if ($archiveInfo) { $archiveInfo.Length } else { 0 }
$vpkError = Test-VpkArchive $archive
if ($vpkError) {
    $tail = Get-LogTail $packLog
    if ($tail) { $tail = "`nCSDKCfgVPK output:`n" + $tail }
    if ($timedOut) {
        $reason = "CSDKCfgVPK produced no valid archive within $packTimeout seconds (packer PID $($pack.Id) was terminated; $archiveBytes bytes at '$archive'; $vpkError)."
    } elseif ($packerWasRunning) {
        $reason = "CSDKCfgVPK left an invalid archive and did not exit (packer PID $($pack.Id) was terminated; $archiveBytes bytes at '$archive'; $vpkError)."
    } elseif ($packExitCode -ne 0) {
        $reason = "CSDKCfgVPK exited with code $packExitCode and left no valid archive ($archiveBytes bytes at '$archive'; $vpkError)."
    } else {
        $reason = "CSDKCfgVPK reported success but left no valid archive ($archiveBytes bytes at '$archive'; $vpkError)."
    }
    throw ($reason + $tail)
}
$archiveBytes = (Get-Item -LiteralPath $archive).Length
if ($packerWasRunning) {
    Write-Host "CSDKCfgVPK wrote a valid $archiveBytes-byte archive and did not exit; terminated PID $($pack.Id)."
} elseif ($null -ne $packExitCode -and $packExitCode -ne 0) {
    Write-Warning "CSDKCfgVPK exited with code $packExitCode after writing a valid archive; continuing."
} else {
    Write-Host "CSDKCfgVPK wrote a valid $archiveBytes-byte archive."
}
Remove-Item -LiteralPath $packLog,$packErr -Force -ErrorAction SilentlyContinue
Write-BuildRecord -Stage 'pack' -State 'ok' -VpkBytes $archiveBytes -Resources $compiledCount -Message "packed $archiveBytes bytes"

# 5. Install the archive as the only source. A loose copy of the same layout names beside the
#    archive is a duplicate answer for `base_hud`; the shipping client reads the compiled resource
#    from the archive, so the loose tree is removed rather than kept as a second authority.
Write-BuildRecord -Stage 'install' -State 'running' -VpkBytes $archiveBytes -Message 'installing the archive'
$builtHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
New-Item -ItemType Directory -Force -Path $addonRoot | Out-Null
$installedArchive = Join-Path $addonRoot 'pak01_dir.vpk'
# The first archive this installer replaces is kept beside it once. A later install must not
# overwrite that original with another generated build: `.pre-openlock` is the player's way back.
$installedBackup = "$installedArchive.pre-openlock"
if ((Test-Path -LiteralPath $installedArchive) -and -not (Test-Path -LiteralPath $installedBackup)) {
    Copy-Item -LiteralPath $installedArchive -Destination $installedBackup -Force
    Write-Host "Backed up the existing archive to $installedBackup"
}
try {
    Copy-Item $archive $installedArchive -Force
} catch {
    if (-not $Live) { throw }
    # A running client can hold the archive open. Replace through a sibling path; if the mount
    # still refuses the move, say so instead of pretending the live update landed.
    $staged = "$installedArchive.new"
    Copy-Item $archive $staged -Force
    try {
        Move-Item -LiteralPath $staged -Destination $installedArchive -Force
    } catch {
        Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
        # A running client may hold a read handle that forbids rename but still permits an
        # in-place write. Open for write once to test the share mode before truncating anything.
        try {
            $probe = [System.IO.File]::Open($installedArchive, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
            $probe.Dispose()
            $bytes = [System.IO.File]::ReadAllBytes($archive)
            $stream = [System.IO.File]::Open($installedArchive, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
            try {
                $stream.SetLength(0)
                $stream.Write($bytes, 0, $bytes.Length)
                $stream.Flush()
            } finally { $stream.Dispose() }
            Write-Host 'Live install: rewrote the mounted archive in place; reload the map to read it.'
        } catch {
            throw "Live install could not replace $installedArchive; the client still holds it. Use a map reload after it releases the file."
        }
    }
}
$installedHash = (Get-FileHash -LiteralPath $installedArchive -Algorithm SHA256).Hash
if ($builtHash -ne $installedHash) {
    throw "Installed VPK hash $installedHash does not match the built archive's $builtHash."
}
$installedError = Test-VpkArchive $installedArchive
if ($installedError) {
    throw "Installed VPK is not readable: $installedError"
}
Write-Host "Installed VPK SHA-256 $builtHash matches the built archive."
Write-BuildRecord -Stage 'install' -State 'ok' -VpkBytes $archiveBytes -Resources $compiledCount -Message "installed $archiveBytes bytes"
# The CSDK10 layout manager opens the source XML as well as the compiled resource. A VPK-only
# addon leaves `file://{resources}/layout/base_hud.xml` unreadable and the HUD asserts before the
# shell can mount. Keep only the layout sources beside the archive; compiled resources stay in
# the VPK, so there is one compiled authority and one readable source tree.
$legacy = Join-Path $addonRoot 'panorama'
if (Test-Path $legacy) { Remove-Item $legacy -Recurse -Force }
$sourcePanorama = Join-Path $build 'panorama'
$sourceLayouts = Join-Path $sourcePanorama 'layout'
if (Test-Path $sourceLayouts) {
    $liveLayouts = Join-Path $legacy 'layout'
    New-Item -ItemType Directory -Force -Path $liveLayouts | Out-Null
    foreach ($xml in @(Get-ChildItem $sourceLayouts -File -Filter *.xml)) {
        Copy-Item -LiteralPath $xml.FullName -Destination (Join-Path $liveLayouts $xml.Name) -Force
    }
    Write-Host "Kept $((Get-ChildItem $liveLayouts -File -Filter *.xml).Count) layout source file(s) beside the archive."
}

$flat = Join-Path $citadel 'addons\panorama'
if (Test-Path $flat) {
    $flatShell = Join-Path $flat 'layout\openlock_shell.xml'
    if (Test-Path $flatShell) { Remove-Item $flat -Recurse -Force }
}

Write-Host "Packed $(Split-Path $archive -Leaf) into $addonRoot"

# 5b. Install companion packages from other git repositories. A package is a repository with an
#     `openlock.package.json` at its root. The installer never runs package code: it validates the
#     manifest, refuses a package built for another game revision, verifies the prebuilt VPK magic
#     and copies only that archive into its own addons directory. The mount is added below with
#     the Openlock mount, so a Steam verification that resets gameinfo.gi is repaired by rerunning
#     this script. Shell packages and loose Panorama sources are not installed this way: the client
#     only loads compiled Panorama resources, and a source tree would be an unverifiable build.
$packageMounts = @()
$installedPackages = @()

function Get-GameSteamInfo([string]$CitadelDir) {
    $info = @{ gameVersion = ''; sourceRevision = ''; versionDate = '' }
    $steamInf = Join-Path $CitadelDir 'steam.inf'
    if (-not (Test-Path -LiteralPath $steamInf)) { return $info }
    foreach ($line in [System.IO.File]::ReadAllLines($steamInf)) {
        $pair = $line.Split('=', 2)
        if ($pair.Count -ne 2) { continue }
        switch ($pair[0].Trim()) {
            'ClientVersion' { $info.gameVersion = $pair[1].Trim() }
            'SourceRevision' { $info.sourceRevision = $pair[1].Trim() }
            'VersionDate' { $info.versionDate = $pair[1].Trim() }
        }
    }
    return $info
}

function Assert-PackageVpk([string]$Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $head = New-Object byte[] 4
        $read = $stream.Read($head, 0, 4)
        if ($read -ne 4 -or $head[0] -ne 0x34 -or $head[1] -ne 0x12 -or $head[2] -ne 0xAA -or $head[3] -ne 0x55) {
            throw "package archive '$Path' is not a VPK (bad magic); refusing to mount it."
        }
    } finally {
        $stream.Dispose()
    }
}

if ($PackageRepo.Count -gt 0) {
    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git) { throw '-PackageRepo needs git on PATH.' }

    $packageBase = Join-Path $PSScriptRoot 'openlock-packages'
    New-Item -ItemType Directory -Force -Path $packageBase | Out-Null
    $packageBaseFull = [System.IO.Path]::GetFullPath($packageBase).TrimEnd('\') + '\'
    $steamInfo = Get-GameSteamInfo $citadel
    $seenPackages = @{}

    foreach ($repo in $PackageRepo) {
        if (-not $repo) { continue }
        $repoName = ($repo -replace '[\\/]+$', '') -replace '\.git$', ''
        $repoName = Split-Path $repoName -Leaf
        if (-not $repoName) { $repoName = 'package-' + ($installedPackages.Count + 1) }
        $checkout = Join-Path $packageBase $repoName
        $checkoutResolved = [System.IO.Path]::GetFullPath($checkout)
        if (-not $checkoutResolved.StartsWith($packageBaseFull, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "package repo '$repo' resolves its checkout outside '$packageBase'; refusing."
        }

        if (Test-Path (Join-Path $checkout '.git')) {
            $dirty = & git -C $checkout status --porcelain
            if ($LASTEXITCODE -eq 0 -and -not (($dirty -join '').Trim())) {
                & git -C $checkout pull --ff-only
                if ($LASTEXITCODE -ne 0) { throw "git pull failed for package '$repo' with exit code $LASTEXITCODE." }
            } else {
                Write-Host "Package checkout '$checkout' has local changes; installing it without updating."
            }
        } else {
            $cloneArgs = @('clone', '--depth', '1')
            if ($PackageRef) { $cloneArgs += @('--branch', $PackageRef) }
            # `--` ends git's options. Without it a repo value beginning with '-' is parsed as a
            # git option (for example an upload-pack command) rather than a source.
            $cloneArgs += @('--', $repo, $checkout)
            Write-Host "Cloning package $repo into $checkout"
            & git @cloneArgs
            if ($LASTEXITCODE -ne 0) { throw "git clone failed for package '$repo' with exit code $LASTEXITCODE." }
        }

        $manifestPath = Join-Path $checkout 'openlock.package.json'
        if (-not (Test-Path -LiteralPath $manifestPath)) {
            throw "package '$repo' has no openlock.package.json at its root."
        }
        try { $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json }
        catch { throw "package '$repo' has an unreadable openlock.package.json: $($_.Exception.Message)" }

        $id = [string]$manifest.id
        # The id is a directory name and a gameinfo path component. `.` and `..` are valid under
        # the character class but resolve to the package root or its parent, which would copy the
        # package VPK into citadel/addons and mount the whole addons tree. A trailing dot is
        # stripped by Windows and can alias another package.
        if (-not $id -or $id -notmatch '^[A-Za-z0-9_.-]{1,40}$' -or $id -eq 'openlock_ui' -or
            $id -eq '.' -or $id -eq '..' -or $id.EndsWith('.')) {
            throw "package '$repo' declares an invalid id '$id'."
        }
        if ($seenPackages.ContainsKey($id)) { throw "two package repositories declare the id '$id'." }
        $seenPackages[$id] = $true

        $kind = [string]$manifest.kind
        if ($kind -and $kind -ne 'panorama-vpk') {
            throw "package '$id' uses kind '$kind'; this installer only mounts 'panorama-vpk'."
        }

        if ($manifest.target) {
            $builtGame = [string]$manifest.target.gameVersion
            $builtRevision = [string]$manifest.target.sourceRevision
            if ($builtGame -and $steamInfo.gameVersion -and $builtGame -ne $steamInfo.gameVersion -and -not $ForcePackage) {
                throw "package '$id' targets game version $builtGame but this install is $($steamInfo.gameVersion). Pass -ForcePackage only if you know the package accepts that mismatch."
            }
            if ($builtRevision -and $steamInfo.sourceRevision -and $builtRevision -ne $steamInfo.sourceRevision -and -not $ForcePackage) {
                throw "package '$id' targets SourceRevision $builtRevision but this install is $($steamInfo.sourceRevision). Pass -ForcePackage only if you know the package accepts that mismatch."
            }
        }

        $vpkRel = [string]$manifest.vpk
        if (-not $vpkRel) { throw "package '$id' declares no vpk path." }
        $checkoutFull = [System.IO.Path]::GetFullPath($checkout).TrimEnd('\') + '\'
        $vpkFull = [System.IO.Path]::GetFullPath((Join-Path $checkout $vpkRel))
        if (-not $vpkFull.StartsWith($checkoutFull, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "package '$id' points its vpk outside its checkout; refusing."
        }
        if (-not (Test-Path -LiteralPath $vpkFull) -or [System.IO.Path]::GetExtension($vpkFull) -ne '.vpk') {
            throw "package '$id' has no prebuilt .vpk at '$vpkRel'."
        }
        # The lexical containment check above does not stop a link/junction inside the checkout
        # from pointing the VPK at a file outside it. Walk the components and refuse reparse points.
        $checkoutRoot = $checkoutFull.TrimEnd('\')
        $vpkRelative = $vpkFull.Substring($checkoutRoot.Length).TrimStart('\')
        $walk = $checkoutRoot
        foreach ($segment in $vpkRelative.Split([char]'\')) {
            if (-not $segment) { continue }
            $walk = Join-Path $walk $segment
            $item = Get-Item -LiteralPath $walk -Force -ErrorAction Stop
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "package '$id' vpk path follows a link at '$segment'; refusing."
            }
        }
        Assert-PackageVpk $vpkFull
        $structureError = Test-VpkArchive $vpkFull
        if ($structureError) {
            throw "package '$id' vpk '$vpkRel' is not a readable VPK: $structureError"
        }

        $packageMountRel = 'citadel/addons/mods/packages/' + $id
        $packageMount = Join-Path $citadel ('addons\mods\packages\' + $id)
        New-Item -ItemType Directory -Force -Path $packageMount | Out-Null
        Copy-Item -LiteralPath $vpkFull (Join-Path $packageMount 'pak01_dir.vpk') -Force
        $packageMounts += $packageMountRel
        $commit = (& git -C $checkout rev-parse --short HEAD 2>$null)
        $installedPackages += [ordered]@{
            id = $id
            name = [string]$manifest.name
            version = [string]$manifest.version
            repo = $repo
            commit = ([string]$commit).Trim()
            vpk = ($packageMountRel + '/pak01_dir.vpk')
            target = $manifest.target
        }
        Write-Host "Installed package $id ($($manifest.version)) from $repo"
    }
}

# 6. Mount it from the game's search paths.
if ($skipMount) {
    Write-Host 'Live install: citadel/addons/mods is already mounted; gameinfo.gi is not rewritten.'
} else {
$backup = "$gameinfo.openlock-bak"
if (-not (Test-Path $backup)) { Copy-Item $gameinfo $backup -Force }

# KeyValues is byte-faithful here: a UTF-8 BOM is not a key and Deadlock aborts at launch with
# "unable to parse keyvalues" when one is present. Read and write without one, keep CRLF.
$text = [System.IO.File]::ReadAllText($gameinfo)
$hadBom = $text.Length -gt 0 -and $text[0] -eq [char]0xFEFF
if ($hadBom) { $text = $text.Substring(1) }
$lines = [System.Collections.Generic.List[string]]($text -split "`r?`n")
$entry = "`t`t`tGame`t`tcitadel/addons/mods"

# Drop any previous entry so the script is idempotent. Companion package mounts are rewritten from
# the packages installed in this run, so an uninstalled package cannot keep a stale search path.
$lines = [System.Collections.Generic.List[string]]($lines | Where-Object {
    $_ -notmatch 'citadel/addons/openlock_ui' -and $_ -notmatch 'citadel/addons/openlock_packages/' -and
        $_ -notmatch 'citadel/addons/mods(?:/|\s|$)'
})

# A verified stock gameinfo has SearchPaths but no addon path. Mount this addon's own
# directory directly. Mounting the whole `citadel/addons` tree would also mount whatever stale
# VPK another launcher left there (the current one carries an old game tree and breaks default
# keybindings), so the installer never takes that path on the player's behalf.
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
        throw "Could not find a SearchPaths block in '$gameinfo'; install the addon directory manually."
    }
    $braceAt = -1
    for ($i = $searchAt + 1; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^\s*\{\s*$') { $braceAt = $i; break }
        if ($lines[$i] -match '^\s*\}\s*$') { break }
    }
    if ($braceAt -lt 0) {
        throw "Could not find the opening brace of SearchPaths in '$gameinfo'; install the addon directory manually."
    }
    $insertAt = $braceAt + 1
}

$lines.Insert($insertAt, $entry)
foreach ($mountRel in $packageMounts) {
    $insertAt++
    $lines.Insert($insertAt, "`t`t`tGame`t`t" + $mountRel)
}
[System.IO.File]::WriteAllText($gameinfo, (($lines -join "`r`n").TrimEnd() + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))

$check = [System.IO.File]::ReadAllBytes($gameinfo)
if ($check.Length -ge 3 -and $check[0] -eq 0xEF -and $check[1] -eq 0xBB -and $check[2] -eq 0xBF) {
    throw 'gameinfo.gi was written with a BOM; Deadlock cannot parse that and will crash at launch.'
}

Write-Host "Mounted citadel/addons/mods from $gameinfo"
if ($hadBom) { Write-Host 'Removed the UTF-8 BOM the previous install left on gameinfo.gi.' }
}

# 7. Leave the build record the Tools window reads. The next data generation embeds it; this
#    record is also useful on its own when an install is inspected without launching the client.
Write-BuildRecord -Stage 'installed' -State 'ok' -VpkBytes $archiveBytes -Resources $compiledCount `
    -Packages $installedPackages -Message "installed $archiveBytes bytes"
Write-Host "Wrote build record $buildRecordPath and $liveBuildPath"
Write-Host "Start the game. The shell boots from pak01_dir.vpk; the server is optional."
Complete-InstallUi -Ok $true -Message "Installed $([Math]::Round($archiveBytes / 1MB, 2)) MB to addons/mods/pak01_dir.vpk · grade $script:installGrade."
