param(
    [string]$AppRoot = 'C:\corptv',
    [string]$TaskName = 'CorporTV',
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$root = Assert-CorporTVRoot $AppRoot
$logPath = Join-Path $root 'logs\corptv-operations.log'
$marker = Join-Path $root 'logs\watchdog-failure.json'
$healthy = $null
for ($attempt = 1; $attempt -le 3; $attempt += 1) {
    $healthy = Invoke-CorporTVHealth
    if ($healthy) { break }
    Start-Sleep -Seconds 2
}

if ($healthy) {
    if (Test-Path -LiteralPath $marker -PathType Leaf) { Remove-Item -LiteralPath $marker -Force }
    [pscustomobject]@{ ok=$true; action='none'; health=$healthy }
    return
}
if ($CheckOnly) {
    [pscustomobject]@{ ok=$false; action='check-only' }
    exit 1
}

$now = Get-Date
if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) {
    @{ first_failure=$now.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $marker -Encoding UTF8
    Write-CorporTVOpsLog -Path $logPath -Message 'watchdog: primeira falha de saúde; aguardando confirmação'
    [pscustomobject]@{ ok=$false; action='marked' }
    return
}

$mutex = [Threading.Mutex]::new($false, 'Global\CorporTVMaintenance')
$acquired = $false
try {
    try { $acquired = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) {
        [pscustomobject]@{ ok=$false; action='maintenance-in-progress' }
        return
    }
    Write-CorporTVOpsLog -Path $logPath -Message 'watchdog: segunda falha consecutiva; reiniciando serviço'
    Stop-CorporTV -AppRoot $root -TaskName $TaskName
    Rotate-CorporTVLog -Path 'C:\ProgramData\CodexInstallLogs\corptv.log' -AllowedRoot 'C:\ProgramData\CodexInstallLogs' | Out-Null
    $health = Start-CorporTV -TaskName $TaskName
    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
    Write-CorporTVOpsLog -Path $logPath -Message "watchdog: serviço recuperado; pid na porta 3000; uptime=$($health.uptime_s)s"
    [pscustomobject]@{ ok=$true; action='restarted'; health=$health }
}
finally {
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
