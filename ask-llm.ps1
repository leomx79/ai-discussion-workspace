# ask-llm.ps1 — Codex 调用外部 LLM 的桥接脚本（V3 Codex原生版）
# 直接调用 OpenAI 兼容 API，不依赖 Kilo Code。
#
# 用法:
#   .\ask-llm.ps1 -Role "tech-lead" -Prompt "你的指令"
#   .\ask-llm.ps1 -Role "qa-engineer" -Prompt "质疑内容" -Context "之前的讨论内容"
#   .\ask-llm.ps1 -Role "staff-engineer" -Prompt "方案" -SystemOverride "自定义system prompt"
#
param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("tech-lead", "staff-engineer", "qa-engineer")]
    [string]$Role,

    [Parameter(Mandatory=$true)]
    [string]$Prompt,

    [string]$Context = "",           # 之前的讨论内容（作为上下文传入）

    [string]$SystemOverride = "",    # 覆盖默认 system prompt（可选）

    [int]$TimeoutSec = 120,          # API 超时（秒）

    [int]$MaxTokens = 4096           # 最大输出 token
)

$ErrorActionPreference = "Stop"

# ─── 读取配置 ───
$configPath = Join-Path $PSScriptRoot "llm-config.ps1"
if (-not (Test-Path $configPath)) {
    Write-Error "配置文件不存在: $configPath`n请先创建 llm-config.ps1"
    exit 1
}
. $configPath

# ─── 按角色选择配置 ───
switch ($Role) {
    "tech-lead" {
        $baseUrl = $TL_BASE_URL; $apiKey = $TL_API_KEY; $model = $TL_MODEL; $temp = $TL_TEMPERATURE
    }
    "staff-engineer" {
        $baseUrl = $SE_BASE_URL; $apiKey = $SE_API_KEY; $model = $SE_MODEL; $temp = $SE_TEMPERATURE
    }
    "qa-engineer" {
        $baseUrl = $QA_BASE_URL; $apiKey = $QA_API_KEY; $model = $QA_MODEL; $temp = $QA_TEMPERATURE
    }
}

if ($apiKey -eq "your-glm-api-key-here" -or $apiKey -eq "your-key" -or [string]::IsNullOrWhiteSpace($apiKey)) {
    Write-Error "请先在 llm-config.ps1 中配置 $Role 的 API Key！"
    exit 1
}

# ─── 鞍钢宪法治理规则（嵌入所有角色）───
$ansteelRules = @"

## 鞍钢宪法治理规则（必须严格遵守）

### 事实挂帅
- 证据 > 自信。有证据的L2胜过没证据的L1。
- 不知道就说不知道，绝不编造。
- 每个事实性断言必须标注置信度（L1-L4）。

### 置信度标签
- L1 🟢 已验证：有明确来源、可交叉验证（必须给出具体来源）
- L2 🟡 高可信：基于可靠知识但无法即时验证（必须说明推理依据）
- L3 🟠 待验证：不确定，需要进一步核查（必须标注并建议验证方法）
- L4 🔴 存疑/未知：不确定或可能错误（必须明确说"我不确定"）

### 讨论纪律
- 对事不对人：质疑观点，不质疑角色。
- 有错必纠：发现错误立即修正，不掩饰。
- 不得回避质疑：必须逐条正面回应。
- 最终输出中不得包含未标注的L3/L4断言。
"@

# ─── 角色 System Prompt ───
$systemPrompts = @{
    "tech-lead" = @"
你是一家大型科技公司的 Tech Lead（技术负责人）。

## 你的职责
1. 主持讨论，确保流程按鞍钢宪法进行
2. 对关键争议点亲自验证（干部参加劳动，不当甩手掌柜）
3. 主持三方合议，形成最终结论
4. 确保最终输出质量

## 你的鞍钢宪法身份：干部
- 你必须亲自下场验证，不能只当裁判
- 你要确保 QA 的否决权被尊重

## 工作风格
- 严谨、务实、不偏不倚
- 先验证再下结论
$ansteelRules
"@

    "staff-engineer" = @"
你是一家大型科技公司的 Staff Engineer（资深工程师）。

## 你的职责
1. 针对议题提出方案和回答
2. 每个事实性断言必须标注置信度（L1-L4）
3. 提供证据来源和推理依据
4. 逐条回应 QA 的质疑，不得回避
5. 有错必纠，修正后重新标注置信度

## 你的鞍钢宪法身份：技术人员
- 你的方案必须经得起质疑和验证
- 用证据说话，不用权威压人

## 工作风格
- 专业、深入、有理有据
- 承认不确定性，不假装全知
- 欢迎质疑，视质疑为改进机会
$ansteelRules
"@

    "qa-engineer" = @"
你是一家大型科技公司的 QA & Reliability Engineer（质量与可靠性工程师）。

## 你的职责
1. 对 Staff Engineer 的回答进行逐条质疑
2. 重点检查 L2-L4 断言：证据是否充分？推理是否合理？
3. 检查是否有遗漏、矛盾、逻辑漏洞
4. 行使否决权：对未经验证的关键断言，有权否决（需给出理由）
5. 验证修正后的回答是否真正解决了问题

## 你的鞍钢宪法身份：工人（有否决权）
- 你的否决权是真实的，不是橡皮图章
- 敢于说"不"，即使对方是 Tech Lead

## 工作风格
- 怀疑一切未经验证的断言
- 关注边界条件、异常路径、最坏情况
- 不放过任何"看起来对但没证据"的说法
$ansteelRules
"@
}

if ($SystemOverride -ne "") {
    $systemPrompt = $SystemOverride
} else {
    $systemPrompt = $systemPrompts[$Role]
}

# ─── 构建消息 ───
$messages = @()
$messages += @{ role = "system"; content = $systemPrompt }

if ($Context -ne "") {
    $messages += @{ role = "user"; content = "以下是之前的讨论内容，请作为上下文参考：`n`n$Context" }
    $messages += @{ role = "assistant"; content = "好的，我已经阅读了之前的讨论内容，将在此基础上继续。" }
}

$messages += @{ role = "user"; content = $Prompt }

# ─── 调用 API ───
$uri = "$($baseUrl.TrimEnd('/'))/chat/completions"

$body = @{
    model       = $model
    messages    = $messages
    temperature = $temp
    max_tokens  = $MaxTokens
} | ConvertTo-Json -Depth 10

$headers = @{
    "Authorization" = "Bearer $apiKey"
    "Content-Type"  = "application/json"
}

Write-Host "=== ask-llm: $Role ===" -ForegroundColor Cyan
Write-Host "Model: $model | Temp: $temp" -ForegroundColor Yellow
Write-Host "API: $uri" -ForegroundColor DarkGray
Write-Host "---" -ForegroundColor DarkGray

try {
    $response = Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec $TimeoutSec
    $content = $response.choices[0].message.content

    if ([string]::IsNullOrWhiteSpace($content)) {
        Write-Error "API 返回空内容"
        exit 1
    }

    # 输出纯文本结果（Codex 读取这个输出）
    Write-Output $content

} catch {
    $errMsg = $_.Exception.Message
    if ($_.ErrorDetails.Message) {
        $errMsg += "`nAPI Error: $($_.ErrorDetails.Message)"
    }
    Write-Error "API 调用失败: $errMsg"
    exit 1
}
