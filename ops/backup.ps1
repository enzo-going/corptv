param(
    [string]$AppRoot = 'C:\corptv',
    [string]$TaskName = 'CorporTV',
    [ValidateRange(2, 30)][int]$Retention = 7
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$mutex = [Threading.Mutex]::new($false, 'Global\CorporTVMaintenance')
$acquired = $false
$wasRunning = $false
$serviceStopped = $false
$snapshot = $null
$partial = $null
$backupRoot = $null
try {
    try { $acquired = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) { return }

    $root = Assert-CorporTVRoot $AppRoot
    $backupRoot = Join-Path $root 'backups\data'
    $logPath = Join-Path $root 'logs\corptv-operations.log'
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    if ((Get-Item -LiteralPath $backupRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "A raiz de backups é um reparse point: $backupRoot"
    }

    $mainTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $listenerExists = [bool](Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)
    $wasRunning = ($mainTask.State -eq 'Running') -or $listenerExists
    if ($wasRunning) {
        Stop-CorporTV -AppRoot $root -TaskName $TaskName
        $serviceStopped = $true
    }

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $partial = Join-Path $backupRoot ("data-$stamp.partial")
    $snapshot = Join-Path $backupRoot ("data-$stamp")
    if (-not (Test-CorporTVPathInside -Path $partial -Root $backupRoot)) { throw 'Destino parcial inválido.' }
    if ((Test-Path -LiteralPath $partial) -or (Test-Path -LiteralPath $snapshot)) { throw 'O snapshot já existe.' }
    New-Item -ItemType Directory -Path $partial | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $partial 'data') | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $partial 'uploads') | Out-Null

    $databaseFiles = @(Get-ChildItem -LiteralPath (Join-Path $root 'data') -Filter '*.db' -File)
    if (-not $databaseFiles.Count) { throw 'Nenhum banco NeDB encontrado.' }
    foreach ($database in $databaseFiles) {
        $destination = Join-Path $partial ('data\' + $database.Name)
        Copy-Item -LiteralPath $database.FullName -Destination $destination -Force
        foreach ($line in Get-Content -LiteralPath $destination -Encoding UTF8) {
            if (-not [string]::IsNullOrWhiteSpace($line)) { $null = $line | ConvertFrom-Json }
        }
    }

    $uploadFiles = @(Get-ChildItem -LiteralPath (Join-Path $root 'public\uploads') -File)
    foreach ($upload in $uploadFiles) {
        $destination = Join-Path $partial ('uploads\' + $upload.Name)
        New-Item -ItemType HardLink -Path $destination -Target $upload.FullName | Out-Null
        if ((Get-Item -LiteralPath $destination).Length -ne $upload.Length) {
            throw "Falha ao verificar o hardlink: $($upload.Name)"
        }
    }

    $manifest = [ordered]@{
        created_at = (Get-Date).ToString('o')
        app_version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
        databases = @($databaseFiles | ForEach-Object { [ordered]@{ name=$_.Name; bytes=$_.Length } })
        uploads = @($uploadFiles | ForEach-Object { [ordered]@{ name=$_.Name; bytes=$_.Length } })
    }
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $partial 'manifest.json') -Encoding UTF8
    Move-Item -LiteralPath $partial -Destination $snapshot -ErrorAction Stop

    $programDataLogs = 'C:\ProgramData\CorporTVLogs'
    Rotate-CorporTVLog -Path (Join-Path $programDataLogs 'corptv.log') -AllowedRoot $programDataLogs | Out-Null
    Rotate-CorporTVLog -Path (Join-Path $programDataLogs 'corptv-media-access.log') -AllowedRoot $programDataLogs | Out-Null
    Rotate-CorporTVLog -Path (Join-Path $root 'logs\corptv-media-access.log') -AllowedRoot (Join-Path $root 'logs') | Out-Null
    Rotate-CorporTVLog -Path $logPath -AllowedRoot (Join-Path $root 'logs') -MaxBytes 5MB | Out-Null

    $snapshots = @(Get-ChildItem -LiteralPath $backupRoot -Directory |
        Where-Object { $_.Name -match '^data-\d{8}-\d{6}$' } |
        Sort-Object Name -Descending)
    foreach ($old in @($snapshots | Select-Object -Skip $Retention)) {
        if ($old.Parent.FullName -ne $backupRoot -or ($old.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Snapshot inválido para retenção: $($old.FullName)"
        }
        Remove-Item -LiteralPath $old.FullName -Recurse -Force -ErrorAction Stop
    }

    Write-CorporTVOpsLog -Path $logPath -Message "backup concluído: $snapshot; bancos=$($databaseFiles.Count); uploads=$($uploadFiles.Count)"
}
catch {
    if ($partial -and $backupRoot -and (Test-CorporTVPathInside -Path $partial -Root $backupRoot) -and
        (Split-Path -Leaf $partial) -match '^data-\d{8}-\d{6}\.partial$' -and
        (Test-Path -LiteralPath $partial -PathType Container)) {
        $partialItem = Get-Item -LiteralPath $partial -Force
        if (-not ($partialItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            Remove-Item -LiteralPath $partial -Recurse -Force -ErrorAction Stop
        }
    }
    if ($snapshot) {
        $logPath = Join-Path $AppRoot 'logs\corptv-operations.log'
        Write-CorporTVOpsLog -Path $logPath -Message "ERRO no backup: $($_.Exception.Message)"
    }
    throw
}
finally {
    if ($serviceStopped) { $null = Start-CorporTV -TaskName $TaskName }
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}

if ($snapshot) { [pscustomobject]@{ ok=$true; snapshot=$snapshot } }
