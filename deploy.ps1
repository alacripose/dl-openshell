#Requires -Version 5.1
<#
.SYNOPSIS
  Build Openlock, check the manifest against the built assembly, and install it into Deadworks.

.DESCRIPTION
  Refuses to deploy when the manifest version and the built assembly version disagree, or when the
  target Deadworks runtime is missing. Nothing is written outside the plugin folder.
#>
[CmdletBinding()]
param(
    [string]$DeadlockRoot = 'D:\SteamLibrary\steamapps\common\Deadlock',
    [string]$DeadworksDir = '',
    [switch]$NoDeploy
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

if (-not $DeadworksDir) { $DeadworksDir = Join-Path $DeadlockRoot 'game\bin\win64' }

$apiDll = Join-Path $DeadworksDir 'managed\DeadworksManaged.Api.dll'
if (-not (Test-Path $apiDll)) {
    throw "Deadworks runtime not found at '$DeadworksDir'. Install the Deadworks release into '$DeadlockRoot' first (see docs/GROUND-TRUTH.md)."
}

$manifestPath = Join-Path $root 'openlock.manifest.json'
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json

Write-Host "Building Openlock $($manifest.version) against $DeadworksDir"
dotnet build (Join-Path $root 'src\Openlock\Openlock.csproj') -c Release "-p:DeadworksDir=$DeadworksDir" | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }

$built = Join-Path $root 'src\Openlock\bin\Release\net10.0\Openlock.dll'
$assemblyVersion = [System.Reflection.AssemblyName]::GetAssemblyName($built).Version.ToString(3)
if ($assemblyVersion -ne $manifest.version) {
    throw "Manifest version $($manifest.version) does not match built assembly $assemblyVersion. Refusing to deploy."
}

$hash = (Get-FileHash $built -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "Built $built"
Write-Host "sha256 $hash"

if ($NoDeploy) { Write-Host 'NoDeploy set; not copying.'; return }

$pluginDir = Join-Path $DeadworksDir 'managed\plugins'
New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null
Copy-Item $built (Join-Path $pluginDir 'Openlock.dll') -Force
$pdb = [System.IO.Path]::ChangeExtension($built, '.pdb')
if (Test-Path $pdb) { Copy-Item $pdb (Join-Path $pluginDir 'Openlock.pdb') -Force }

Write-Host "Deployed to $pluginDir"
Write-Host 'Deadworks hot-loads changed plugin DLLs; no restart needed.'
