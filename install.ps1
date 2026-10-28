#Requires -Version 5.1
<#
.SYNOPSIS
  Build the Openlock UI addon as a VPK and mount it from the game's own search paths.

.DESCRIPTION
  The UI half is a normal Panorama mod packed as `pak01_dir.vpk`, so it is location-independent:
  one file mounts under whatever game directory the client is running from. This script assembles
  the content tree, packs it with the CSDK VPK tool,  installs the single archive into
  game/citadel/addons/openlock_ui, and puts that directory in gameinfo.gi's SearchPaths. It also
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
    [switch]$VpkOnly,
    [switch]$Compile,
    [int]$PackTimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'

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
$addonRoot = Join-Path $citadel 'addons\openlock_ui'

if (-not (Test-Path $gameinfo)) {
    throw "gameinfo.gi not found at '$gameinfo'. The installer will not restore a backup without asking; verify the game files so Steam writes a clean copy, then run this again."
}

if (Get-Process deadlock,project8 -ErrorAction SilentlyContinue) {
    throw 'Deadlock is running. Close the game (not the server) and run this again; gameinfo.gi and a mounted VPK are read at launch.'
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
    throw "clientaddon not found. Pass -SourceRoot, set OPENLOCK_SOURCE, or pass -RepoUrl."
}
$repoRoot = Split-Path $source -Parent
$build = Join-Path $repoRoot 'dist\openlock_ui'
$archive = Join-Path $build 'pak01_dir.vpk'

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
# installed, not the checkout that happened to build the archive. Generate from this game's own
# gameinfo.gi and VPKs before anything is copied or compiled. A minimal install simply produces a
# smaller catalog; it is never replaced by a baked list from another version.
$generator = Join-Path $repoRoot 'tools\gen_shell_data.py'
$dataFile = Join-Path $source 'panorama\scripts\openlock_shell_data.js'
if (-not (Test-Path $generator)) { throw "data generator not found at '$generator'." }

& $Python $generator (Join-Path $repoRoot 'shell\alpha-shell') $dataFile $gameinfo
if ($LASTEXITCODE -ne 0) {
    throw "gen_shell_data.py failed with exit code $LASTEXITCODE; refusing to pack stale UI data."
}

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

if (-not $VpkTool -or -not (Test-Path $VpkTool)) {
    throw 'CSDKCfgVPK.exe not found. Pass -VpkTool or set OPENLOCK_SDK.'
}
if (-not $SdkRoot) {
    throw 'resourcecompiler.exe not found. Pass -SdkRoot or set OPENLOCK_SDK.'
}

# 1. Assemble the content tree.
#
#    There is exactly one stock-layout override: `base_hud.xml`, the client's root HUD layout.
#    It is the agnostic mount — loaded in the menu and in a match — and its <CitadelHud> child
#    keeps every stock game window. A mode-specific layout (hud_hideout, base_dashboard) is
#    deliberately not touched: those are other mods' hook, and a partial copy of one is what
#    leaves the client with no HUD to draw.
if (Test-Path $build) { Remove-Item $build -Recurse -Force }
$contentLayout = Join-Path $build 'panorama\layout'
$contentScripts = Join-Path $build 'panorama\scripts'
$contentStyles = Join-Path $build 'panorama\styles'
New-Item -ItemType Directory -Force -Path $contentLayout, $contentScripts, $contentStyles | Out-Null

Copy-Item (Join-Path $source 'panorama\layout\*.xml') $contentLayout -Force
Copy-Item (Join-Path $source 'panorama\scripts\*.js') $contentScripts -Force
Copy-Item (Join-Path $source 'panorama\styles\*.css') $contentStyles -Force
Copy-Item (Join-Path $source 'standalone\panorama\scripts\openlock_boot.js') $contentScripts -Force
Copy-Item (Join-Path $source 'standalone\panorama\layout\base_hud.xml') $contentLayout -Force

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
$stockOverrides = @(Get-ChildItem (Join-Path $source 'standalone\panorama\layout') -Filter *.xml |
    Where-Object { $_.Name -ne 'base_hud.xml' })
if ($stockOverrides.Count -gt 0) {
    throw "Only base_hud.xml may override a stock layout; refusing: $($stockOverrides.Name -join ', ')"
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
    if (Test-Path $sdkContent) { Remove-Item $sdkContent -Recurse -Force }
    if (Test-Path $sdkBuilt) { Remove-Item $sdkBuilt -Recurse -Force }
    New-Item -ItemType Directory -Force -Path (Join-Path $sdkContent 'panorama') | Out-Null
    Copy-Item (Join-Path $build 'panorama\*') (Join-Path $sdkContent 'panorama') -Recurse -Force

    # Absolute inputs: the compiler resolves a relative one against its own start directory, and
    # Start-Process does not always hand it the one this script set.
    $inputs = @(
        'panorama\layout\openlock_shell.xml',
        'panorama\layout\openlock_shell_server.xml',
        'panorama\layout\openlock_hud.xml',
        'panorama\layout\base_hud.xml',
        'panorama\scripts\openlock_shell.js',
        'panorama\scripts\openlock_server_mount.js',
        'panorama\scripts\openlock_hud.js',
        'panorama\scripts\openlock_shell_data.js',
        'panorama\scripts\openlock_boot.js',
        'panorama\styles\openlock_shell.css',
        'panorama\styles\openlock_schemes.css'
    ) | ForEach-Object { (Join-Path $sdkContent $_).Replace('\', '/') }

    # One command-line string: PowerShell 5.1 does not reliably split an array into separate
    # native arguments, and a compiler that receives one space-joined path compiles nothing.
    $compileArgs = '-f -nop4 -DANGER_MODE_ignore_schema_mismatches -game "' +
        (Join-Path $SdkRoot 'game\citadel') + '" -i ' + ($inputs -join ' ')

    $process = Start-Process -FilePath $compiler -ArgumentList $compileArgs -WorkingDirectory $SdkRoot -Wait -PassThru -NoNewWindow
    if ($process.ExitCode -ne 0) {
        throw "resourcecompiler failed with exit code $($process.ExitCode)."
    }

    $compiled = Get-ChildItem $sdkBuilt -Recurse -File -Include *.vxml_c, *.vjs_c, *.vcss_c
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
        'panorama\scripts\openlock_boot.vjs_c',
        'panorama\styles\openlock_schemes.vcss_c'
    )
    $absent = @($required | Where-Object { -not (Test-Path (Join-Path $build $_)) })
    if ($absent.Count -gt 0) {
        throw "resourcecompiler wrote no $($absent -join ', '); base_hud would abort at load."
    }

    Write-Host "Compiled $($compiled.Count) Panorama resources with $compiler"
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
Write-Host "Packing with $VpkTool"
try {
    $pack = Start-Process -FilePath $VpkTool -ArgumentList $packArgs -WorkingDirectory $repoRoot `
        -PassThru -NoNewWindow -RedirectStandardOutput $packLog -RedirectStandardError $packErr
} catch {
    throw "Could not start CSDKCfgVPK at '$VpkTool': $($_.Exception.Message)"
}
if (-not $pack) { throw 'CSDKCfgVPK did not start.' }

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
    } else {
        $stablePolls = 0
    }
}
$timedOut = (-not $packExited -and $stablePolls -lt 3)
$packerWasRunning = -not $pack.HasExited
$packExitCode = if ($pack.HasExited) { $pack.ExitCode } else { $null }
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
} elseif ($packExitCode -ne 0) {
    Write-Warning "CSDKCfgVPK exited with code $packExitCode after writing a valid archive; continuing."
} else {
    Write-Host "CSDKCfgVPK wrote a valid $archiveBytes-byte archive."
}
Remove-Item -LiteralPath $packLog,$packErr -Force -ErrorAction SilentlyContinue

# 5. Install the archive as the only source. A loose copy of the same layout names beside the
#    archive is a duplicate answer for `base_hud`; the shipping client reads the compiled resource
#    from the archive, so the loose tree is removed rather than kept as a second authority.
$builtHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
New-Item -ItemType Directory -Force -Path $addonRoot | Out-Null
$installedArchive = Join-Path $addonRoot 'pak01_dir.vpk'
Copy-Item $archive $installedArchive -Force
$installedHash = (Get-FileHash -LiteralPath $installedArchive -Algorithm SHA256).Hash
if ($builtHash -ne $installedHash) {
    throw "Installed VPK hash $installedHash does not match the built archive's $builtHash."
}
$installedError = Test-VpkArchive $installedArchive
if ($installedError) {
    throw "Installed VPK is not readable: $installedError"
}
Write-Host "Installed VPK SHA-256 $builtHash matches the built archive."
$legacy = Join-Path $addonRoot 'panorama'
if (Test-Path $legacy) { Remove-Item $legacy -Recurse -Force }

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

        $packageMountRel = 'citadel/addons/openlock_packages/' + $id
        $packageMount = Join-Path $citadel ('addons\openlock_packages\' + $id)
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
$backup = "$gameinfo.openlock-bak"
if (-not (Test-Path $backup)) { Copy-Item $gameinfo $backup -Force }

# KeyValues is byte-faithful here: a UTF-8 BOM is not a key and Deadlock aborts at launch with
# "unable to parse keyvalues" when one is present. Read and write without one, keep CRLF.
$text = [System.IO.File]::ReadAllText($gameinfo)
$hadBom = $text.Length -gt 0 -and $text[0] -eq [char]0xFEFF
if ($hadBom) { $text = $text.Substring(1) }
$lines = [System.Collections.Generic.List[string]]($text -split "`r?`n")
$entry = "`t`t`tGame`t`tcitadel/addons/openlock_ui"

# Drop any previous entry so the script is idempotent. Companion package mounts are rewritten from
# the packages installed in this run, so an uninstalled package cannot keep a stale search path.
$lines = [System.Collections.Generic.List[string]]($lines | Where-Object {
    $_ -notmatch 'citadel/addons/openlock_ui' -and $_ -notmatch 'citadel/addons/openlock_packages/'
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

Write-Host "Mounted citadel/addons/openlock_ui from $gameinfo"
if ($hadBom) { Write-Host 'Removed the UTF-8 BOM the previous install left on gameinfo.gi.' }

# 7. Leave the build record the Tools window reads. The next data generation embeds it; this
#    record is also useful on its own when an install is inspected without launching the client.
$archiveInfo = Get-Item $archive
$buildState = [ordered]@{
    stage = 'installed'
    finishedAt = (Get-Date -Format 'yyyy-MM-dd HH:mm')
    vpk = 'dist/openlock_ui/pak01_dir.vpk'
    vpkBytes = $archiveInfo.Length
    resources = $compiledCount
    path = 'citadel/addons/openlock_ui/pak01_dir.vpk'
    stages = @(
        [ordered]@{ name = 'compile'; ok = $true; resources = $compiledCount },
        [ordered]@{ name = 'pack'; ok = $true; bytes = $archiveInfo.Length },
        [ordered]@{ name = 'install'; ok = $true }
    )
    packages = @($installedPackages)
}
$buildPath = Join-Path $repoRoot 'shell\alpha-shell\build.json'
if (-not (Test-Path (Split-Path $buildPath -Parent))) { $buildPath = Join-Path $build 'build.json' }
[System.IO.File]::WriteAllText($buildPath, ($buildState | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Wrote build record $buildPath"
Write-Host "Start the game. The shell boots from pak01_dir.vpk; the server is optional."
