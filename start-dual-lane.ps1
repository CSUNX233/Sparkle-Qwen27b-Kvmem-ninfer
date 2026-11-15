param(
    [string]$Config = 'config/local.json',
    [string]$Engine = '',
    [string]$Model = '',
    [string]$ModelId = '',
    [string]$ChatTemplate = '',
    [string]$ApiKeyFile = 'D:\34229\speedtest\api-key.txt',
    [string]$BindHost = '0.0.0.0',
    [int]$Port = 1234,
    [int]$MaxContext = 262144,
    [int]$DeviceKV = 78336,
    [int]$HostKVMiB = 7168,
    [int]$CudaGraphAllowanceMiB = 64,
    [switch]$NoGraph,
    [switch]$GdnFp16,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts/common.ps1')
Initialize-LocalEnvironment

$configPath = Resolve-ProjectPath $Config
$cfg = $null
if (Test-Path -LiteralPath $configPath) {
    $cfg = Read-LocalConfig $Config
}

if ([string]::IsNullOrWhiteSpace($Model)) {
    if ($null -eq $cfg -or [string]::IsNullOrWhiteSpace([string]$cfg.ModelPath)) {
        throw 'No model. Pass -Model <vision+mtp .ninfer> or create config/local.json.'
    }
    $Model = [string]$cfg.ModelPath
}
if ([string]::IsNullOrWhiteSpace($ModelId)) {
    if ($null -ne $cfg -and -not [string]::IsNullOrWhiteSpace([string]$cfg.ModelId)) {
        $ModelId = [string]$cfg.ModelId
    } else {
        $ModelId = 'Qwen3.8-27B-UD-Q3_K_XL'
    }
}
if ([string]::IsNullOrWhiteSpace($ChatTemplate)) {
    $ChatTemplate = Join-Path $PSScriptRoot 'templates/chat_template_qwen3.8-enhanced.jinja'
}

$modelPath = Resolve-ProjectPath $Model
$templatePath = Resolve-ProjectPath $ChatTemplate
if ([string]::IsNullOrWhiteSpace($Engine)) {
    # Prefer the installed layout, then the downloaded release asset in the checkout root.
    foreach ($candidate in @(
        'runtime/engine/ninfer-serve.exe',
        'ninfer-dual-lane-v6-win-x64-sm120a.exe',
        'ninfer-compact-fixes-v6.exe')) {
        if (Test-Path -LiteralPath (Resolve-ProjectPath $candidate) -PathType Leaf) {
            $Engine = $candidate
            break
        }
    }
    if ([string]::IsNullOrWhiteSpace($Engine)) {
        $Engine = 'runtime/engine/ninfer-serve.exe'
    }
}
$enginePath = Resolve-ProjectPath $Engine
if (-not (Test-Path -LiteralPath $enginePath -PathType Leaf)) {
    throw ("Engine not found: " + $enginePath + "`nPass -Engine .\ninfer-dual-lane-v6-win-x64-sm120a.exe or place v6 at runtime/engine/ninfer-serve.exe.")
}
if (-not (Test-Path -LiteralPath $modelPath -PathType Leaf)) { throw ('Model not found: ' + $modelPath) }
if (-not (Test-Path -LiteralPath $templatePath -PathType Leaf)) { throw ('Chat template not found: ' + $templatePath) }
if (-not (Test-Path -LiteralPath $ApiKeyFile -PathType Leaf)) {
    throw ('API key file not found: ' + $ApiKeyFile + "`nPut the Bearer key in this file (one line) or pass -ApiKeyFile.")
}
$apiKey = (Get-Content -LiteralPath $ApiKeyFile -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($apiKey)) { throw ('API key file is empty: ' + $ApiKeyFile) }

# 16GB planning profile:
#   Main pool 78,336 tokens = 1,224 pages, two lanes x 39,168.
#   Per-lane quality budgets (sink 12,288 + recent 19,456 + retrieve 6,144 + pending/slack).
# If startup is OOM, try -DeviceKV 65536, -MaxContext 131072, -GdnFp16, or -NoGraph.
$env:NINFER_KV_COMPACT = '1'
$env:NINFER_KV_RING = '1'
$env:NINFER_KV_SINK = '12288'
$env:NINFER_KV_WINDOW = '19456'
$env:NINFER_KV_RETRIEVE = '6144'
$env:NINFER_TERNARY_KVMEM = '1'
$env:NINFER_TERNARY_KVMEM_SCORE = '1'
$env:NINFER_KVMEM_CACHE_QUERY = '1'
$env:NINFER_KVMEM_INDEX_HOST = '1'
$env:NINFER_KV_REUSE_HOSTBACKED = '1'
$env:NINFER_HOST_PAGEABLE = '1'
$env:NINFER_KV_LEASE_RING = '1'
$env:NINFER_KVMEM_HARVEST_TEXT = '1'
$env:NINFER_KV_DEMOTE_BATCH = '32'
$env:NINFER_C2_ROLLING_ANCHOR = '1'
$env:NINFER_C2_CONSUME_ANCHOR = '1'
$env:NINFER_KVMEM_OVERLAP_PREDECESSOR = '1'
$env:NINFER_POST_THINKING_PENALTY_SCOPE = 'answer'
$env:CUDA_MODULE_LOADING = 'LAZY'
# Dual-lane decode indexing is not enabled on this branch.
Remove-Item Env:NINFER_KVMEM_INDEX_DECODE -ErrorAction SilentlyContinue
foreach ($name in @('NINFER_KV_AUDIT_DIR','NINFER_KVMEM_RANK_AUDIT_DIR','NINFER_TOOLCALL_DUMP')) {
    Remove-Item ('Env:' + $name) -ErrorAction SilentlyContinue
}

$engineArgs = @(
    $modelPath,
    '--model-id', $ModelId,
    '--chat-template', $templatePath,
    '--max-context', [string]$MaxContext,
    '--kv-capacity', [string]$DeviceKV,
    '--max-concurrency', '2',
    '--concurrent-prefill',
    '--max-shared-prefixes', '0',
    '--kv-dtype', 'rk4v4',
    '--host-kv-mib', [string]$HostKVMiB,
    '--prefill-chunk', '128',
    '--spec', 'mtp', '--draft-tokens', '3',
    '--default-max-tokens', '0',
    '--kv-lease-growth',
    '--default-reasoning-effort', 'xhigh',
    '--presence-penalty', '1.0',
    '--post-thinking-sampler', 'temp=0.7,top_p=0.95,presence=1.0',
    '--recover-invariant-failures',
    '--context-cache-policy', 'rolling',
    '--release-diverged-checkpoints',
    '--recency-eviction',
    '--host-state-slots', '8',
    '--auto-long-anchors',
    '--long-anchor-spacing', '49152',
    '--max-long-anchors-per-continuation', '2',
    '--device-state-slots', '0',
    '--no-webui',
    '--log-stats-interval-ms', '5000',
    '--vision-cpu', '--vision-max-merged', '256',
    '--host', $BindHost,
    '--port', [string]$Port,
    '--api-key', $apiKey
)
if ($GdnFp16) { $engineArgs += '--gdn-state-fp16' }
if ($NoGraph) {
    $engineArgs += '--no-cuda-graph'
} else {
    $engineArgs += @('--cuda-graph-allowance-mib', [string]$CudaGraphAllowanceMiB)
}

if ($DryRun) {
    $redacted = @($engineArgs | ForEach-Object { if ($_ -eq $apiKey) { '<api-key>' } else { $_ } })
    Write-Host ('Engine: ' + $enginePath)
    Write-Host ('Model:  ' + $modelPath)
    Write-Host ('ModelId: ' + $ModelId)
    Write-Host ('Args:   ' + ($redacted -join ' '))
    return
}

$launchMutex = Enter-LaunchMutex
try {
    $oldState = @(Get-DeploymentState | Where-Object { $_ -and (Test-OwnedProcess $_) })
    if ($oldState.Count) { throw 'This checkout already has running processes. Use stop.cmd before restarting.' }
    Assert-PortFree $Port

    $records = New-Object 'System.Collections.Generic.List[object]'
    try {
        Write-Host 'Starting dual-lane engine (2 x 39,168 tokens, MTP3, CPU vision) ...'
        Write-Host 'Note: dual-lane + CPU vision is allowed by the compact gate but is not covered by the final dual-lane validation; smoke-test a short image request first.'
        $records.Add((Start-OwnedProcess 'engine-dual' $enginePath $engineArgs $modelPath (Split-Path $enginePath -Parent)))
        Write-LocalJson (Join-Path $script:RuntimeRoot 'processes.json') @($records.ToArray())

        $ready = $false
        $deadline = [datetime]::UtcNow.AddSeconds(300)
        while ([datetime]::UtcNow -lt $deadline) {
            if (-not (Test-OwnedProcess $records[0])) { throw 'Engine exited. See runtime/logs/engine-dual.stderr.log.' }
            try {
                $health = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Port + '/health') -TimeoutSec 2
                $ready = $true
                break
            } catch {}
            Start-Sleep -Seconds 1
        }
        if (-not $ready) { throw 'Engine startup timed out. See runtime/logs/engine-dual.stderr.log.' }

        Write-Host ('API ready: http://127.0.0.1:' + $Port + '/v1')
        $addresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
            Select-Object -ExpandProperty IPAddress -Unique)
        foreach ($address in $addresses) {
            Write-Host ('           http://' + $address + ':' + $Port + '/v1  (LAN / ZeroTier)')
        }
        Write-Host 'If remote clients cannot connect, allow inbound TCP port in Windows Firewall.'
        Write-Host 'Use stop.cmd to stop the engine started by this checkout.'
    } catch {
        for ($i = $records.Count - 1; $i -ge 0; $i--) { Stop-OwnedProcess $records[$i] }
        Write-LocalJson (Join-Path $script:RuntimeRoot 'processes.json') @()
        throw
    }
} finally {
    $launchMutex.ReleaseMutex()
    $launchMutex.Dispose()
}