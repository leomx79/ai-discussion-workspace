# call-kilo-agent.ps1 — Codex调用Kilo Code Agent的桥接脚本（多模型版）
# 用法: .\call-kilo-agent.ps1 -Agent "tech-lead" -Prompt "你的指令"
# 模型自动从 model-config.ps1 读取，也可用 -Model 手动覆盖
param(
    [Parameter(Mandatory=$true)]
    [string]$Agent,
    
    [Parameter(Mandatory=$true)]
    [string]$Prompt,
    
    [string]$Model = "",  # 留空则自动从配置读取
    
    [string]$Dir = "F:\codex\ai群讨论",
    
    [int]$TimeoutSec = 300
)

# 读取模型配置
$configPath = Join-Path $PSScriptRoot "model-config.ps1"
if (Test-Path $configPath) { . $configPath }

# 如果没手动指定模型，按角色自动选择
if ($Model -eq "") {
    switch ($Agent) {
        "tech-lead"      { $Model = $TL_MODEL }
        "staff-engineer" { $Model = $SE_MODEL }
        "qa-engineer"    { $Model = $QA_MODEL }
        default          { $Model = "agent/glm-5.2 (glm-latest)" }
    }
}

$kiloExe = "C:\Users\leomx\.vscode\extensions\kilocode.kilo-code-7.4.11-win32-x64\bin\kilo.exe"

if (-not (Test-Path $kiloExe)) {
    Write-Error "Kilo CLI not found: $kiloExe"
    exit 1
}

Write-Host "=== Calling Kilo Agent: $Agent ===" -ForegroundColor Cyan
Write-Host "Model: $Model" -ForegroundColor Yellow
Write-Host "---"

$job = Start-Job -ScriptBlock {
    param($exe, $agent, $model, $dir, $prompt)
    $output = & $exe run --agent $agent --model $model --auto --dir $dir --format json $prompt 2>&1
    return $output
} -ArgumentList $kiloExe, $Agent, $Model, $Dir, $Prompt

$completed = $job | Wait-Job -Timeout $TimeoutSec
if (-not $completed) {
    $job | Stop-Job
    $job | Remove-Job -Force
    Write-Error "Timeout after ${TimeoutSec}s"
    exit 1
}

$rawOutput = $job | Receive-Job
$job | Remove-Job -Force

# Parse JSON lines and extract text content
$textParts = @()
foreach ($line in $rawOutput) {
    $lineStr = $line.ToString().Trim()
    if ($lineStr -eq "") { continue }
    try {
        $json = $lineStr | ConvertFrom-Json
        if ($json.type -eq "text" -and $json.part.text) {
            $textParts += $json.part.text
        }
    } catch {}
}

# Deduplicate (Kilo CLI outputs each text part twice)
$uniqueParts = @()
$seen = @{}
foreach ($part in $textParts) {
    $key = $part.GetHashCode().ToString()
    if (-not $seen.ContainsKey($key)) {
        $seen[$key] = $true
        $uniqueParts += $part
    }
}

$result = $uniqueParts -join "`n"
Write-Host $result
