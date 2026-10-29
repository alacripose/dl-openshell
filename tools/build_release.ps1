#Requires -Version 5.1
<#
.SYNOPSIS
  Build the verified player VPK and the release assets for dl-openshell.

.DESCRIPTION
  The Deadlock client and CSDK are needed to compile Panorama resources, so the release binary is
  built on a machine with the game, not on a generic CI runner. This script runs the normal
  installer in player mode, copies the resulting VPK into `release/`, writes the SHA-256 the
  standalone installer verifies, and prints the `gh release create` command.

  Nothing is uploaded. Publishing is a separate, explicit step.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$DeadlockRoot,
    [string]$Tag = '',
    [switch]$SkipBuild,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$dist = Join-Path $root 'dist\openlock_ui\pak01_dir.vpk'
$release = Join-Path $root 'release'
$playerVpk = Join-Path $release 'openshell-player.vpk'
$checksum = Join-Path $release 'openshell-player.sha256'
$installer = Join-Path $release 'install.ps1'
$launcher = Join-Path $release 'install.cmd'
$license = Join-Path $root 'LICENSE'

if (-not $Tag) {
    $manifest = Get-Content -LiteralPath (Join-Path $root 'openlock.manifest.json') -Raw | ConvertFrom-Json
    $Tag = 'v' + [string]$manifest.version
}

if (-not $SkipBuild) {
    Write-Host "Building the player VPK from $DeadlockRoot"
    # No silent switch: a release build runs the same visible minimal shell a player sees.
    & (Join-Path $root 'install.ps1') -DeadlockRoot $DeadlockRoot -Grade player
    if ($LASTEXITCODE -ne 0) { throw "install.ps1 failed with exit code $LASTEXITCODE." }
}

if (-not (Test-Path -LiteralPath $dist)) {
    throw "No built archive at '$dist'. Run install.ps1 -Grade player first."
}
if (-not (Test-Path -LiteralPath $installer)) {
    throw "The release installer is missing at '$installer'."
}
if (-not (Test-Path -LiteralPath $launcher)) {
    throw "The double-click launcher is missing at '$launcher'."
}
if (-not (Test-Path -LiteralPath $license)) {
    throw "The MIT license is missing at '$license'."
}

New-Item -ItemType Directory -Force -Path $release | Out-Null
if ((Test-Path -LiteralPath $playerVpk) -and -not $Force) {
    throw "'$playerVpk' already exists. Pass -Force to replace the release asset."
}

Copy-Item -LiteralPath $dist -Destination $playerVpk -Force
$hash = (Get-FileHash -LiteralPath $playerVpk -Algorithm SHA256).Hash.ToLowerInvariant()
$bytes = (Get-Item -LiteralPath $playerVpk).Length

# sha256sum format: the installer reads the first token. Keep the asset name so a human can
# verify the downloaded file with the same line.
[System.IO.File]::WriteAllText($checksum, "$hash  openshell-player.vpk`n",
    (New-Object System.Text.UTF8Encoding($false)))

Write-Host "Release VPK: $playerVpk ($bytes bytes)"
Write-Host "SHA-256: $hash"
Write-Host ''
Write-Host 'Upload these assets with:'
Write-Host "  gh release create $Tag `"$playerVpk`" `"$checksum`" `"$installer`" `"$launcher`" `"$license`" --repo alacripose/dl-openshell --title `"dl-openshell $Tag`" --notes-file README.md"
Write-Host ''
Write-Host 'The release installer expects the asset names openshell-player.vpk and openshell-player.sha256.'
