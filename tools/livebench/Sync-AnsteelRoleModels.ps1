<#
.SYNOPSIS
    Sync-AnsteelRoleModels.ps1 — 单命令校对所有 Ansteel 角色模型。

.DESCRIPTION
    角色模型只在一份项目文件里定义：tools/livebench/ansteel-livebench-config.json。
    provider 凭据只在一份机器文件里维护：~/.pi/agent/models.json。
    本脚本：
      1) 校验每个角色的 provider/model 在 models.json 中存在且带可用凭据；
      2) 校对 auth.json（pi 运行时凭据缓存会覆盖 models.json，若存在协议 provider
         的运行时凭据则移除，让 models.json 成为唯一权威）；
      3) 确保 LiveBench 传输别名（ansteel-livebench.yml）覆盖每个角色模型。

    换模型流程：改 ansteel-livebench-config.json（角色->provider/model）
    + 在 ~/.pi/agent/models.json 的对应 provider 下补模型/凭据，然后跑一次本脚本。
#>
[CmdletBinding()]
param(
    [string]$ProtocolConfigPath = "",
    [string]$PiModelsPath = "",
    [string]$PiAuthPath = "",
    [string]$TransportConfigPath = "F:\codex\benchmarks\LiveBench\livebench\model\model_configs\ansteel-livebench.yml",
    [switch]$KeepRuntimeCredentials,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($ProtocolConfigPath)) { $ProtocolConfigPath = Join-Path $scriptDir "ansteel-livebench-config.json" }
if ([string]::IsNullOrWhiteSpace($PiModelsPath)) { $PiModelsPath = Join-Path $env:USERPROFILE ".pi\agent\models.json" }
if ([string]::IsNullOrWhiteSpace($PiAuthPath)) { $PiAuthPath = Join-Path $env:USERPROFILE ".pi\agent\auth.json" }
$roleOrder = @("tech-lead", "staff-engineer", "qa-engineer")
$failures = [System.Collections.Generic.List[string]]::new()

if (-not (Test-Path -LiteralPath $ProtocolConfigPath)) { throw "Protocol config missing: $ProtocolConfigPath" }
if (-not (Test-Path -LiteralPath $PiModelsPath)) { throw "Pi models.json missing: $PiModelsPath" }

$protocolConfig = Get-Content -LiteralPath $ProtocolConfigPath -Raw | ConvertFrom-Json
$piModels = Get-Content -LiteralPath $PiModelsPath -Raw | ConvertFrom-Json

function ConvertTo-AnsteelTransportModel {
    param([string]$ModelId)
    $slug = ($ModelId -replace '[^A-Za-z0-9]+', '-')
    return "ansteel-livebench-$slug"
}

$summary = [System.Collections.Generic.List[object]]::new()
$neededProviders = [System.Collections.Generic.HashSet[string]]::new()
foreach ($roleName in $roleOrder) {
    $reference = [string]$protocolConfig.roles.$roleName.model
    $provider, $model = $reference -split '/', 2
    $ok = $true
    $problems = [System.Collections.Generic.List[string]]::new()
    if ([string]::IsNullOrWhiteSpace($provider) -or [string]::IsNullOrWhiteSpace($model)) {
        $problems.Add("model must use provider/model form")
        $ok = $false
    } else {
        $providerDef = $piModels.providers.$provider
        if ($null -eq $providerDef) {
            $problems.Add("provider '$provider' missing from $PiModelsPath")
            $ok = $false
        } else {
            [void]$neededProviders.Add($provider)
            if ($providerDef.api -ne "openai-completions") { $problems.Add("provider api is not openai-completions"); $ok = $false }
            if ([string]::IsNullOrWhiteSpace([string]$providerDef.baseUrl)) { $problems.Add("provider baseUrl missing"); $ok = $false }
            if ([string]::IsNullOrWhiteSpace([string]$providerDef.apiKey)) { $problems.Add("provider apiKey missing"); $ok = $false }
            $modelIds = @($providerDef.models | ForEach-Object { $_.id })
            if ($modelIds -notcontains $model) { $problems.Add("model '$model' not declared for provider '$provider'"); $ok = $false }
        }
    }
    if (-not $ok) { $failures.Add("$roleName : " + ($problems -join '; ')) }
    $summary.Add([pscustomobject]@{
        Role = $roleName
        Provider = $provider
        Model = $model
        Transport = ConvertTo-AnsteelTransportModel $model
        Usable = $ok
    })
}

$identities = @($summary | ForEach-Object { "$($_.Provider)/$($_.Model)" } | Select-Object -Unique)
if ($identities.Count -ne $roleOrder.Count) {
    $failures.Add("role models are not distinct: " + ($identities -join ', '))
}

if (-not $KeepRuntimeCredentials -and -not $DryRun) {
    $auth = @{}
    if (Test-Path -LiteralPath $PiAuthPath) {
        $auth = Get-Content -LiteralPath $PiAuthPath -Raw | ConvertFrom-Json
    }
    $changed = $false
    foreach ($provider in @($neededProviders)) {
        if ($auth.PSObject.Properties.Name -contains $provider) {
            $auth.PSObject.Properties.Remove($provider)
            $changed = $true
        }
    }
    if ($changed) {
        [IO.File]::WriteAllText($PiAuthPath, ($auth | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
        Write-Host "Reconciled $PiAuthPath : removed runtime credentials for protocol providers so models.json governs."
    }
}

$transportChanged = $false
if (-not $DryRun -and (Test-Path -LiteralPath $TransportConfigPath)) {
    $yaml = [IO.File]::ReadAllText($TransportConfigPath)
    foreach ($row in $summary) {
        if (-not $row.Usable) { continue }
        $alias = $row.Transport
        $pattern = "(?m)^display_name: " + [regex]::Escape($alias)
        if ($yaml -notmatch $pattern) {
            $yaml += "`n---`ndisplay_name: $alias`napi_name:`n  local: $($row.Model)`ndefault_provider: local"
            $transportChanged = $true
        }
    }
    if ($transportChanged) {
        [IO.File]::WriteAllText($TransportConfigPath, $yaml, [Text.UTF8Encoding]::new($false))
        Write-Host "Updated $TransportConfigPath with missing transport aliases."
    }
}

$summary | Format-Table Role, Provider, Model, Transport, Usable -AutoSize
if ($failures.Count -gt 0) {
    Write-Host "SYNC FAILED:" -ForegroundColor Red
    foreach ($f in $failures) { Write-Host "  - $f" -ForegroundColor Red }
    exit 1
}
Write-Host "Ansteel role models are consistent. Change a role model by editing $ProtocolConfigPath only, then re-run this script."
exit 0