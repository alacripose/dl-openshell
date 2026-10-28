# Compatibility shim: the shipping installer is install.ps1.
& (Join-Path $PSScriptRoot 'install.ps1') @args
exit $LASTEXITCODE
