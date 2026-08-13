param(
    [string]$Path = 'C:\ProgramData\CodexInstallLogs\corptv.log',
    [string]$AllowedRoot = 'C:\ProgramData\CodexInstallLogs',
    [long]$MaxBytes = 10MB,
    [int]$Keep = 5
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
Rotate-CorporTVLog -Path $Path -AllowedRoot $AllowedRoot -MaxBytes $MaxBytes -Keep $Keep | Out-Null
