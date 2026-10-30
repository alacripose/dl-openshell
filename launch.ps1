#Requires -Version 5.1
<#
.SYNOPSIS
  dl-openshell boot entry: gate the worktree, install the shell, launch the surface that hosts it.

.DESCRIPTION
  The shell is loaded through the CSDK10 installer shell for development. That shell is a
  Panorama surface hosted by the reduced tools client; it is not the game and it is not a
  WinForms dialog. The in-game shell is the fallback, and it is used only when a mountable game
  package and the game itself are available: a game tree is installed through its tools host and
  then launched normally, with the shell mounting from the packaged VPK.

  The boot surface is therefore never a console-only run and never the installer's WinForms
  window. `-Headless`, `-NoUi` and `-List` are refused by name. install.ps1 is invoked with
  `-BootShellHost`, which tells it that the shell host owns the surface; it publishes the same
  build record the installer shell renders.

  Before anything is mounted, the worktree is read by tools/axis_witness.py: one code witness per
  declared segment and per worktree change, held or absent, with refusals named. The run is
  written to MongoDB and read back, then re-derived and compared with the stored run. A gate that
  cannot record its reading refuses the mount.

.EXAMPLE
  .\launch.ps1

.EXAMPLE
  .\launch.ps1 -Root 'D:\Users\alacrity\Documents\Documents\deadlockpreview\Project8Staging\Reduced_CSDK_10' -Install

.EXAMPLE
  .\launch.ps1 -SelfTest
#>
[CmdletBinding()]
param(
    [string]$Root = '',
    [switch]$Install,
    [ValidateSet('dev', 'observer', 'player')]
    [string]$Grade = 'dev',
    [string]$SdkRoot = '',
    [string]$Python = 'python',
    [int]$ReadyTimeoutSeconds = 90,
    [switch]$SelfTest,
    # These exist only to be refused with a reason a caller can read.
    [switch]$Headless,
    [switch]$NoUi,
    [switch]$List
)

$ErrorActionPreference = 'Stop'

if ($Headless) {
    throw 'Headless operation is refused: the CSDK10 installer shell is the only boot surface. Run launch.ps1 from an interactive desktop session.'
}
if ($NoUi) {
    throw 'The WinForms installer surface is refused by the boot shell. launch.ps1 drives install.ps1 through -BootShellHost; it never opens the WinForms window or runs a console-only install.'
}
if ($List) {
    throw 'Console listing is refused: the install list is a module of the installer shell. Launch the shell instead of asking this script for a headless list.'
}
if (-not [Environment]::UserInteractive -or $env:CI) {
    throw 'No interactive desktop session: the boot shell has no surface to load into. Headless runs are refused.'
}

$repoRoot = $PSScriptRoot
$installer = Join-Path $repoRoot 'install.ps1'
$lister = Join-Path $repoRoot 'tools\list_installs.py'
$witness = Join-Path $repoRoot 'tools\axis_witness.py'
$parity = Join-Path $repoRoot 'tools\parity_check.py'
$buildRecord = Join-Path $repoRoot 'shell\alpha-shell\build.json'

foreach ($required in @($installer, $lister, $witness, $parity)) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "Boot module missing: '$required'."
    }
}

function Write-Boot([string]$Text = '') {
    Write-Host $Text
}

function Invoke-Python([string[]]$Arguments) {
    $raw = & $Python @Arguments
    $code = $LASTEXITCODE
    return [pscustomobject]@{ Text = (($raw | Out-String).Trim()); Code = $code }
}

function Get-Discovery {
    $arguments = @($lister)
    if ($Root) { $arguments += @('--root', $Root) }
    $run = Invoke-Python $arguments
    if ($run.Code -ne 0) {
        throw "install discovery failed (python exit $($run.Code)).`n$($run.Text)"
    }
    try {
        return $run.Text | ConvertFrom-Json
    } catch {
        throw "install discovery returned unreadable JSON: $($_.Exception.Message)"
    }
}

function Format-Bytes([long]$Bytes) {
    if ($Bytes -le 0) { return '-' }
    if ($Bytes -ge 1MB) { return ('{0:N1} MB' -f ($Bytes / 1MB)) }
    return ('{0:N0} KB' -f ($Bytes / 1KB))
}

function Format-Build($Row) {
    if ($Row.build -and $Row.build.state -eq 'ok' -and $Row.build.grade) {
        return "$($Row.build.grade) | $($Row.build.finishedAt)"
    }
    if ($Row.build -and $Row.build.stage) {
        return "$($Row.build.stage) ($($Row.build.state))"
    }
    return 'no build record'
}

function Get-Surface($Row) {
    if ($Row.kind -eq 'tools') { return 'installer-shell' }
    return 'game-shell'
}

function Show-Installs($Discovery) {
    Write-Boot 'installs'
    $index = 1
    foreach ($row in @($Discovery.installs)) {
        Write-Boot ('  [{0}] {1,-10} {2,-15} {3,-22} {4,-26} {5,8}  {6}' -f `
            $index, $row.kind, (Get-Surface $row), $row.shell, (Format-Build $row), (Format-Bytes $row.vpkBytes), $row.path)
        $index++
    }
    if (-not @($Discovery.installs).Count) {
        Write-Boot '  (none found)'
    }

    Write-Boot ''
    Write-Boot 'installer hosts'
    foreach ($hostRow in @($Discovery.hosts)) {
        $notes = @()
        if ($hostRow.engine -eq 'cs2') { $notes += 'CS2 base; needs its own addon package' }
        if ($hostRow.hasVpkTool) { $notes += 'vpk packer' } else { $notes += 'python packer' }
        if ($hostRow.deadlockHost) { $notes += 'deadlock layouts' }
        $rank = if ($hostRow.engine -eq 'csdk') { "csdk$($hostRow.csdk)" } else { $hostRow.engine }
        Write-Boot ('  {0,-7} {1}  ({2})' -f $rank, $hostRow.path, ($notes -join ' | '))
    }
    if (-not @($Discovery.hosts).Count) {
        Write-Boot '  (none found; the installer shell cannot be hosted and WinForms is refused)'
    }
}

function Select-Install($Discovery) {
    $installs = @($Discovery.installs)
    if (-not $installs.Count) {
        throw 'No Deadlock or tools install found. Pass -Root to a tree that contains game/citadel/gameinfo.gi.'
    }
    if ($Root) {
        $wanted = ([System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/') -replace '\\', '/').ToLowerInvariant()
        foreach ($row in $installs) {
            if (([string]$row.path).TrimEnd('/').ToLowerInvariant() -eq $wanted) { return $row }
        }
        throw "The -Root path is not a Deadlock install with game/citadel/gameinfo.gi: $Root"
    }
    if ($installs.Count -eq 1) { return $installs[0] }

    while ($true) {
        $answer = Read-Host "Select an install [1-$($installs.Count)] or Q to quit"
        if ($answer -match '^[Qq]$') { exit 0 }
        $number = 0
        if ([int]::TryParse($answer, [ref]$number) -and $number -ge 1 -and $number -le $installs.Count) {
            return $installs[$number - 1]
        }
        Write-Boot 'Not a listed number.'
    }
}

function Find-InstallerHost($Discovery, $Chosen) {
    if ($SdkRoot) {
        $compiler = Join-Path $SdkRoot 'game\bin\win64\resourcecompiler.exe'
        if (-not (Test-Path -LiteralPath $compiler)) {
            throw "-SdkRoot has no game/bin/win64/resourcecompiler.exe: $SdkRoot"
        }
        return [pscustomobject]@{ path = ([System.IO.Path]::GetFullPath($SdkRoot).TrimEnd('\')); engine = 'manual' }
    }

    $selfCompiler = Join-Path $Chosen.path 'game\bin\win64\resourcecompiler.exe'
    if ($Chosen.kind -eq 'tools' -and (Test-Path -LiteralPath $selfCompiler)) {
        return [pscustomobject]@{ path = $Chosen.path; engine = 'self' }
    }

    # The CSDK10 reduced tree is the development installer shell. When it is present it hosts the
    # build; the newer CSDK trees and a CS2 base are not substitutes for it and a game's shipping
    # compiler is never used to build its own addon.
    $candidates = @($Discovery.hosts | Where-Object {
        $_.deadlockHost -and $_.hasContent -and $_.engine -ne 'cs2'
    })
    $csdk10 = @($candidates | Where-Object { $_.engine -eq 'csdk' -and [int]$_.csdk -eq 10 })
    if ($csdk10.Count) {
        return [pscustomobject]@{ path = $csdk10[0].path; engine = 'csdk10' }
    }
    if ($candidates.Count) {
        return [pscustomobject]@{ path = $candidates[0].path; engine = "csdk$($candidates[0].csdk)" }
    }
    return $null
}

function Test-TreeRunning([string]$TreeRoot) {
    foreach ($process in @(Get-Process deadlock,project8 -ErrorAction SilentlyContinue)) {
        $path = ''
        try { $path = [string]$process.Path } catch { }
        if ($path -and $path.StartsWith($TreeRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $process
        }
    }
    return $null
}

function Invoke-WitnessGate {
    Write-Boot 'witness'
    $record = Invoke-Python @($witness, 'record', '--json')
    $payload = $null
    try { $payload = $record.Text | ConvertFrom-Json } catch { }
    if (-not $payload) {
        throw "the axis witness gate returned no reading (python exit $($record.Code)).`n$($record.Text)"
    }

    foreach ($cell in @($payload.cells)) {
        Write-Boot ('  {0,-7} {1}  {2}' -f $cell.state, $cell.grade, $cell.witness)
    }
    foreach ($refusal in @($payload.refusals)) {
        Write-Boot ('  REFUSED {0,-10} {1}  {2}' -f $refusal.kind, $refusal.witness, $refusal.detail)
    }
    if ($payload.store) {
        Write-Boot ("  store {0}/{1}  run {2}" -f $payload.store.uri, $payload.store.database, $payload.run)
    }
    if ($payload.state -ne 'PASS') {
        throw "The worktree did not pass the axis gate ($($payload.state)): $(@($payload.refusals | ForEach-Object { $_.witness + ': ' + $_.detail }) -join '; ') $($payload.detail)"
    }

    $verify = Invoke-Python @($witness, 'verify', '--json', '--run', [string]$payload.run)
    $verification = $null
    try { $verification = $verify.Text | ConvertFrom-Json } catch { }
    if (-not $verification -or $verification.state -ne 'PASS') {
        $detail = if ($verification) { (@($verification.verification.mismatches) -join '; ') } else { $verify.Text }
        throw "The axis run was written but did not verify against the worktree ($($verification.state)): $detail"
    }
    Write-Boot ("  verified {0} cell(s) against the stored run {1}" -f $verification.verification.cells, $verification.run)
    return $payload
}

function Invoke-ParityGate($Chosen) {
    # The installer checked the archive it copied against the archive it built. This is the second
    # reading: the installed VPK is hashed again and the commit baked into it is compared with the
    # worktree, origin/main and the live Steam client. A broken or hand-copied install refuses here.
    # The live Steam client and the other tools trees are readings, not mount prerequisites: a
    # development tools shell must launch while the player VPK is on an older build.
    Write-Boot 'parity'
    $parityArgs = @($parity, '--install', $Chosen.path, '--json')
    $run = Invoke-Python $parityArgs
    $payload = $null
    try { $payload = $run.Text | ConvertFrom-Json } catch { }
    if (-not $payload) {
        throw "the parity gate returned no reading (python exit $($run.Code)).`n$($run.Text)"
    }
    foreach ($row in @($payload.cells)) {
        Write-Boot ('  {0,-7} {1}  {2,-8} {3}' -f $row.state, $row.grade, $row.cell, $row.detail)
    }
    # The CSDK10 server slot checks every other client and tools shell, not only the live Steam
    # tree. A shell update that reached one install is a partial update, and the dashboard says so.
    foreach ($row in @($payload.audits)) {
        Write-Boot ('  {0,-7} B  {1,-16} {2}' -f $row.state, $row.cell, $row.detail)
    }
    foreach ($refusal in @($payload.refusals)) {
        Write-Boot ('  REFUSED {0,-10} {1}  {2}' -f $refusal.kind, $refusal.cell, $refusal.detail)
    }
    if ($payload.store) {
        Write-Boot ("  store {0}/{1}  read back {2} cell(s)" -f $payload.store.uri, $payload.store.database, $payload.verification.cells)
    }
    if ($payload.detail) { Write-Boot "  $($payload.detail)" }
    if ($run.Code -eq 1 -or $payload.state -eq 'FAIL') {
        throw "The installed shell did not pass the parity gate ($($payload.state)): $(@($payload.refusals | ForEach-Object { $_.cell + ': ' + $_.detail }) -join '; ') $($payload.detail)"
    }
    if ($payload.state -eq 'BLOCKED') {
        # A GitHub mismatch (this worktree is ahead of or behind origin/main) is a reading for
        # the dashboard, not a reason to refuse a local mount. A BLOCKED run for any other
        # reason, including an unrecorded parity run, still refuses.
        $blocking = @($payload.refusals | Where-Object { $_.cell -ne 'github' })
        if ($blocking.Count -eq 0) {
            Write-Boot '  parity BLOCKED: GitHub differs; reported, not a mount refusal'
            return $payload
        }
    }
    if ($payload.state -ne 'PASS') {
        throw "The installed shell did not pass the parity gate ($($payload.state)): $(@($payload.refusals | ForEach-Object { $_.cell + ': ' + $_.detail }) -join '; ') $($payload.detail)"
    }
    return $payload
}

function Invoke-Installer($Chosen, $InstallerHost) {
    $outLog = Join-Path $env:TEMP ('openlock-launch-' + [guid]::NewGuid().ToString('N') + '.out.log')
    $errLog = Join-Path $env:TEMP ('openlock-launch-' + [guid]::NewGuid().ToString('N') + '.err.log')
    # -BootShellHost, never -NoUi: the CSDK10 installer shell owns the surface and this process
    # must not draw its own window.
    $argLine = '-NoProfile -ExecutionPolicy Bypass -File "' + $installer + '" -DeadlockRoot "' +
        $Chosen.path + '" -Grade ' + $Grade + ' -BootShellHost -SdkRoot "' + $InstallerHost.path + '"'
    if ($Python -ne 'python') { $argLine += ' -Python "' + $Python + '"' }

    Write-Boot "mount    : $($InstallerHost.engine)  $($InstallerHost.path)"
    Write-Boot "install  : $($Chosen.path)"
    $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $argLine -PassThru `
        -NoNewWindow -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    if (-not $process) { throw 'The installer did not start.' }

    $stage = ''
    if (Test-Path -LiteralPath $buildRecord) {
        try { $stage = [string](Get-Content -LiteralPath $buildRecord -Raw | ConvertFrom-Json).stage } catch { }
    }
    $percentFor = @{ prepare = 10; compile = 40; pack = 72; install = 90; installed = 100 }
    while (-not $process.HasExited) {
        if (Test-Path -LiteralPath $buildRecord) {
            try {
                $state = Get-Content -LiteralPath $buildRecord -Raw | ConvertFrom-Json
                if ($state.stage -and $state.stage -ne $stage) {
                    $stage = [string]$state.stage
                    $percent = if ($percentFor.ContainsKey($stage)) { $percentFor[$stage] } else { 5 }
                    $message = if ($state.message) { " | $($state.message)" } else { '' }
                    Write-Boot ('[{0,3}%] {1}{2}' -f $percent, $stage, $message)
                }
            } catch { }
        }
        Start-Sleep -Milliseconds 300
    }
    $process.WaitForExit()
    $process.Refresh()
    $code = if ($null -ne $process.ExitCode) { [int]$process.ExitCode } else { -1 }
    foreach ($line in @(Get-Content -LiteralPath $outLog -ErrorAction SilentlyContinue)) {
        Write-Boot "  $line"
    }
    $recordOk = $false
    try {
        $final = Get-Content -LiteralPath $buildRecord -Raw | ConvertFrom-Json
        $recordOk = ([string]$final.state -eq 'ok' -and [string]$final.stage -eq 'installed')
    } catch { }
    if ($code -ne 0) {
        if ($recordOk -and $code -eq -1) {
            Write-Boot 'installer exit code was unavailable, but its build record says installed'
        } else {
            foreach ($line in @(Get-Content -LiteralPath $errLog -ErrorAction SilentlyContinue | Select-Object -Last 30)) {
                Write-Host "  $line" -ForegroundColor Red
            }
            throw "install.ps1 failed with exit code $code."
        }
    }
    if (-not $recordOk) {
        throw 'install.ps1 exited cleanly but its build record is not installed/ok.'
    }
    Remove-Item -LiteralPath $outLog, $errLog -Force -ErrorAction SilentlyContinue
}

function Start-InstallerShell($Chosen) {
    if (-not $Chosen.exe -or -not (Test-Path -LiteralPath $Chosen.exe)) {
        throw "No launchable client exe in $($Chosen.path)."
    }
    $running = Test-TreeRunning $Chosen.path
    if ($running) {
        Write-Boot "already running : PID $($running.Id) ($($running.ProcessName)); not starting a second copy"
        return [pscustomobject]@{ Process = $running; Surface = (Get-Surface $Chosen) }
    }

    # A tools tree hosts the CSDK10 installer shell: the reduced client has no hideout and no
    # lobby, so the map is requested at launch and the shell is mounted into the tools dashboard.
    # A game tree is the fallback surface, launched as the player launches it, with the shell
    # mounting from the packaged VPK.
    $arguments = ''
    if ($Chosen.kind -eq 'tools') {
        # -addon openlock_ui: the tools client only loads the AddonRoot tree named on the command
        # line. Without it the packed game UI wins and the addon is visible to the asset tools but
        # never mounted. -nohltv: the reduced tree has no HLTV camera targets, so the director
        # asserts in StartRandomShot as soon as the start map reaches WaitingForPlayersToJoin; the
        # assert window freezes the process and the console log with it.
        $arguments = '-dev -condebug -allow_no_lobby_connect -insecure -nohltv -game citadel -addon openlock_ui +map start'
    }

    # console.log is append-only across sessions. Record where this session starts so the wait
    # below cannot report the previous client's mount as this one's.
    $console = Join-Path $Chosen.path 'game\citadel\console.log'
    $script:consoleStart = if (Test-Path -LiteralPath $console) { (Get-Item -LiteralPath $console).Length } else { 0 }

    $exe = [string]$Chosen.exe
    $working = Split-Path $exe -Parent
    $started = Start-Process -FilePath $exe -WorkingDirectory $working -ArgumentList $arguments -PassThru
    Write-Boot "surface  : $(Get-Surface $Chosen)"
    Write-Boot "launched : PID $($started.Id)  $exe"
    if ($arguments) { Write-Boot "args     : $arguments" }
    return [pscustomobject]@{ Process = $started; Surface = (Get-Surface $Chosen) }
}

function Read-NewConsole([string]$Console, [long]$Start) {
    try {
        $length = (Get-Item -LiteralPath $Console).Length
        $offset = if ($length -lt $Start) { 0 } else { $Start }
        $stream = [System.IO.File]::Open($Console, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try {
            $stream.Seek($offset, [System.IO.SeekOrigin]::Begin) | Out-Null
            $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
            try { return @($reader.ReadToEnd() -split "`r?`n") } finally { $reader.Dispose() }
        } finally { $stream.Dispose() }
    } catch {
        return @()
    }
}

function Wait-ForShell($Chosen) {
    if ($ReadyTimeoutSeconds -le 0) { return }
    $console = Join-Path $Chosen.path 'game\citadel\console.log'
    $start = if ($null -ne $script:consoleStart) { [long]$script:consoleStart } else { 0 }
    $deadline = (Get-Date).AddSeconds($ReadyTimeoutSeconds)
    $reported = @{}
    Write-Boot "waiting  : $console (from byte $start)"
    while ((Get-Date) -lt $deadline) {
        if (Test-Path -LiteralPath $console) {
            $tail = Read-NewConsole $console $start
            foreach ($line in $tail) {
                if ($line -match '\[Openlock\] shell ready:' -and -not $reported.ready) {
                    Write-Boot "  $line"
                    $reported.ready = $true
                }
                if ($line -match 'csdk10 mount|shell mounted from' -and -not $reported.mount) {
                    Write-Boot "  $line"
                    $reported.mount = $true
                }
                if ($line -match '\[Openlock\] chrome idle:' -and -not $reported.idle) {
                    Write-Boot "  $line"
                    $reported.idle = $true
                }
            }
            if ($reported.ready -or $reported.mount) { break }
        }
        Start-Sleep -Milliseconds 500
    }
    if (-not $reported.ready -and -not $reported.mount) {
        Write-Warning "the shell did not report mounted within $ReadyTimeoutSeconds s; see $console"
    }
}

if ($SelfTest) {
    # Not a headless install: no surface is mounted and no client is started. The boot modules are
    # loaded and read so a check can prove the gate and the discovery without a window.
    $discovery = Get-Discovery
    Show-Installs $discovery
    Write-Boot ''
    $chosen = Select-Install $discovery
    $installerHost = Find-InstallerHost $discovery $chosen
    if (-not $installerHost) {
        throw 'No CSDK10 or other tools host is available. The WinForms fallback is refused, so the installer shell cannot be mounted.'
    }
    Write-Boot ("modules  : discovery ready | witness pending | install idle | parity idle | launch idle")
    Write-Boot ("selected : {0}  {1}" -f (Get-Surface $chosen), $chosen.path)
    Write-Boot ("host     : {0}  {1}" -f $installerHost.engine, $installerHost.path)
    Write-Boot ''
    $null = Invoke-WitnessGate
    Write-Boot ''
    Write-Boot 'self-test: modules loaded; nothing was installed or launched'
    exit 0
}

$discovery = Get-Discovery
Show-Installs $discovery
Write-Boot ''
Write-Boot 'modules  : discovery ready | witness pending | install idle | parity idle | launch idle'
Write-Boot ''

$chosen = Select-Install $discovery
Write-Boot "selected : $(Get-Surface $chosen)  $($chosen.path)"
Write-Boot "shell    : $($chosen.shell)  $((Format-Build $chosen))"
Write-Boot ''

$null = Invoke-WitnessGate
Write-Boot ''

$needsInstall = $Install.IsPresent -or $chosen.shell -ne 'mounted'
if ($needsInstall) {
    $running = Test-TreeRunning $chosen.path
    if ($running) {
        throw "The selected client is running (PID $($running.Id)). Close it, then run launch.ps1 again."
    }

    $installerHost = Find-InstallerHost $discovery $chosen
    if (-not $installerHost) {
        throw 'No tools-capable host was found. The WinForms installer is refused by the boot shell, so this tree cannot be installed: add a CSDK or reduced-CSDK tools tree and run launch.ps1 again.'
    }
    Invoke-Installer $chosen $installerHost

    $discovery = Get-Discovery
    $wanted = ([string]$chosen.path).TrimEnd('/').ToLowerInvariant()
    $chosen = @($discovery.installs | Where-Object { ([string]$_.path).TrimEnd('/').ToLowerInvariant() -eq $wanted })[0]
    if (-not $chosen -or $chosen.shell -ne 'mounted') {
        throw "install.ps1 finished but the shell is not mounted in $($chosen.path)"
    }
    Write-Boot ''
    Write-Boot "installed: $((Format-Build $chosen))  $(Format-Bytes $chosen.vpkBytes)  $($chosen.path)"
} else {
    Write-Boot 'shell is already mounted; pass -Install to rebuild or update it'
}

$null = Invoke-ParityGate $chosen
Write-Boot ''
$surface = Start-InstallerShell $chosen
Wait-ForShell $chosen
