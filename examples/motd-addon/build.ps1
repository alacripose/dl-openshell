param(
    [string]$Game = 'D:\SteamLibrary\steamapps\common\Deadlock\game',
    [string]$Sdk = '',
    [string]$Motd = '',
    [switch]$NoInstall
)

$arguments = @('--game', $Game)
if ($Sdk) { $arguments += @('--sdk', $Sdk) }
if ($Motd) { $arguments += @('--motd', $Motd) }
if ($NoInstall) { $arguments += '--no-install' }

python (Join-Path $PSScriptRoot 'build.py') @arguments
exit $LASTEXITCODE
