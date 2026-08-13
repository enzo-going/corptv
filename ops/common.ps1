Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-CorporTVRoot {
    param([Parameter(Mandatory)][string]$AppRoot)
    $resolved = (Resolve-Path -LiteralPath $AppRoot).Path.TrimEnd('\')
    if ($resolved -ne $AppRoot.TrimEnd('\')) {
        throw "Raiz inesperada: $resolved"
    }
    $item = Get-Item -LiteralPath $resolved -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "A raiz precisa ser um diretório local comum: $resolved"
    }
    return $resolved
}

function Test-CorporTVPathInside {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Root
    )
    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    return $fullPath.StartsWith($fullRoot + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Invoke-CorporTVHealth {
    param(
        [int]$Port = 3000,
        [int]$TimeoutSeconds = 3
    )
    try {
        $health = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec $TimeoutSeconds
        if ($health.status -eq 'ok') { return $health }
    }
    catch {}
    return $null
}

function Stop-CorporTV {
    param(
        [string]$AppRoot = 'C:\corptv',
        [string]$TaskName = 'CorporTV',
        [int]$Port = 3000
    )
    $root = Assert-CorporTVRoot $AppRoot
    $starter = Join-Path $root 'iniciar.bat'
    $wrappers = @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" |
        Where-Object { $_.CommandLine -like "*$starter*" })
    $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)

    foreach ($connection in $listeners) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.OwningProcess)"
        if ($process.Name -ne 'node.exe' -or $process.CommandLine -notmatch 'src\\server\.js') {
            throw "Processo inesperado na porta ${Port}: $($process.Name) $($process.CommandLine)"
        }
    }
    foreach ($wrapper in $wrappers) {
        if ($wrapper.CommandLine -notlike "*$starter*") {
            throw "Wrapper inesperado: $($wrapper.CommandLine)"
        }
    }

    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    if ($task.State -eq 'Running') {
        Stop-ScheduledTask -TaskName $TaskName
        Start-Sleep -Seconds 1
    }

    foreach ($wrapper in $wrappers) {
        $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($wrapper.ProcessId)" -ErrorAction SilentlyContinue
        if ($current) {
            if ($current.Name -ne 'cmd.exe' -or $current.CommandLine -notlike "*$starter*") {
                throw "PID de wrapper reutilizado: $($wrapper.ProcessId)"
            }
            Stop-Process -Id $current.ProcessId -Force -ErrorAction Stop
        }
    }

    $remaining = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    foreach ($connection in $remaining) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.OwningProcess)"
        if ($process.Name -ne 'node.exe' -or $process.CommandLine -notmatch 'src\\server\.js') {
            throw "Listener mudou durante a parada: $($process.CommandLine)"
        }
        Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
    }

    for ($attempt = 1; $attempt -le 20; $attempt += 1) {
        if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { return }
        Start-Sleep -Milliseconds 250
    }
    throw "A porta $Port permaneceu ocupada."
}

function Start-CorporTV {
    param(
        [string]$TaskName = 'CorporTV',
        [int]$Port = 3000
    )
    Start-ScheduledTask -TaskName $TaskName
    for ($attempt = 1; $attempt -le 30; $attempt += 1) {
        Start-Sleep -Milliseconds 500
        $health = Invoke-CorporTVHealth -Port $Port
        if ($health) {
            $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
            if ($listeners.Count -ne 1) { throw "Esperado um listener; encontrados $($listeners.Count)." }
            return $health
        }
    }
    throw 'O CorporTV não voltou saudável dentro de 15 segundos.'
}

function Rotate-CorporTVLog {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$AllowedRoot,
        [long]$MaxBytes = 10MB,
        [ValidateRange(1, 20)][int]$Keep = 5
    )
    if (-not (Test-CorporTVPathInside -Path $Path -Root $AllowedRoot)) {
        throw "Log fora da raiz permitida: $Path"
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Log é um reparse point: $Path" }
    if ($item.Length -lt $MaxBytes) { return $false }

    for ($index = $Keep; $index -ge 1; $index -= 1) {
        $source = if ($index -eq 1) { $Path } else { "$Path.$($index - 1)" }
        $destination = "$Path.$index"
        if (Test-Path -LiteralPath $destination -PathType Leaf) {
            Remove-Item -LiteralPath $destination -Force -ErrorAction Stop
        }
        if (Test-Path -LiteralPath $source -PathType Leaf) {
            Move-Item -LiteralPath $source -Destination $destination -Force -ErrorAction Stop
        }
    }
    return $true
}

function Write-CorporTVOpsLog {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Message
    )
    $parent = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    Add-Content -LiteralPath $Path -Encoding UTF8 -Value "[$((Get-Date).ToString('o'))] $Message"
}
