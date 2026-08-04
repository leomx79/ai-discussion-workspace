[CmdletBinding()]
param(
	[string]$LiveBenchRoot = "F:\codex\benchmarks\LiveBench",
	[string]$PiModelsPath = (Join-Path $env:USERPROFILE ".pi\agent\models.json")
)

$ErrorActionPreference = "Stop"

# These identities match the successful r57 topology. The test deliberately
# verifies only provider metadata and credential presence, never credential text
# and never a billable model request.
$expectedModels = @(
	[pscustomobject]@{ Role = "tech-lead"; Provider = "volcengine-agent-plan"; Model = "glm-5.2"; TransportModel = "ansteel-livebench-glm-5-2"; DisplayName = "livebench-glm-5.2" },
	[pscustomobject]@{ Role = "staff-engineer"; Provider = "deepseek-flash"; Model = "deepseek-v4-flash"; TransportModel = "ansteel-livebench-deepseek-v4-flash"; DisplayName = "livebench-deepseek-v4-flash" },
	[pscustomobject]@{ Role = "qa-engineer"; Provider = "qwen-token-plan-cn"; Model = "qwen3.8-max"; TransportModel = "ansteel-livebench-qwen3-8-max"; DisplayName = "livebench-qwen3.8-max" }
)
$identityCount = @($expectedModels | ForEach-Object { "$($_.Provider)/$($_.Model)" } | Select-Object -Unique).Count
if ($identityCount -ne $expectedModels.Count) {
	throw "LiveBench requires three distinct provider/model identities."
}
if (-not (Test-Path -LiteralPath $LiveBenchRoot)) {
	throw "LiveBench checkout was not found at $LiveBenchRoot. Run Setup-LiveBench.ps1 first."
}

$venvPython = Join-Path $LiveBenchRoot ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $venvPython)) {
	throw "LiveBench virtual environment was not found at $venvPython."
}
$transportConfigPath = Join-Path $LiveBenchRoot "livebench\model\model_configs\ansteel-livebench.yml"
if (-not (Test-Path -LiteralPath $transportConfigPath)) {
	throw "Local transport model aliases are missing at $transportConfigPath. Re-run Setup-LiveBench.ps1."
}
$protocolAdapterPath = Join-Path $PSScriptRoot "ansteel_livebench_adapter.py"
$protocolConfigPath = Join-Path $PSScriptRoot "ansteel-livebench-config.json"
$protocolTestPath = Join-Path $PSScriptRoot "test_ansteel_livebench_adapter.py"
foreach ($required in @($protocolAdapterPath, $protocolConfigPath, $protocolTestPath)) {
	if (-not (Test-Path -LiteralPath $required)) {
		throw "Ansteel LiveBench adapter file is missing: $required"
	}
}

if (-not (Test-Path -LiteralPath $PiModelsPath)) {
	throw "Pi provider configuration was not found at $PiModelsPath."
}

$piModels = Get-Content -LiteralPath $PiModelsPath -Raw | ConvertFrom-Json
foreach ($expected in $expectedModels) {
	$provider = $piModels.providers.$($expected.Provider)
	if ($null -eq $provider) {
		throw "Provider '$($expected.Provider)' is missing from Pi models.json."
	}
	if ($provider.api -ne "openai-completions" -or [string]::IsNullOrWhiteSpace([string]$provider.baseUrl)) {
		throw "Provider '$($expected.Provider)' is not an OpenAI Completions-compatible endpoint."
	}
	if ([string]::IsNullOrWhiteSpace([string]$provider.apiKey)) {
		throw "Provider '$($expected.Provider)' has no local credential."
	}

	$modelIds = @($provider.models | ForEach-Object { $_.id })
	if ($modelIds -notcontains $expected.Model) {
		throw "Provider '$($expected.Provider)' does not declare model '$($expected.Model)'."
	}

	Write-Host ("{0}: {1}/{2} -> {3}; credential present" -f $expected.Role, $expected.Provider, $expected.Model, $provider.baseUrl)
}

& $venvPython -m pip check
if ($LASTEXITCODE -ne 0) {
	throw "LiveBench dependency consistency check failed."
}

# Import the code-scoring dependencies as an offline check. TensorFlow is loaded
# because the official code-runner requirements include it; this catches a broken
# native wheel before a long three-model benchmark is started.
& $venvPython -c "import Levenshtein, pandas, tensorflow; print('LiveBench code-scoring imports OK')"
if ($LASTEXITCODE -ne 0) {
	throw "LiveBench code-scoring import check failed."
}

& $venvPython (Join-Path $LiveBenchRoot "livebench\run_livebench.py") --help | Out-Null
if ($LASTEXITCODE -ne 0) {
	throw "LiveBench runner help check failed."
}

# Confirm the installed YAML declares only local aliases and preserves the
# expected API model names. PowerShell performs this offline check directly so
# it stays reliable under Windows native-command quote forwarding.
$transportConfig = Get-Content -LiteralPath $transportConfigPath -Raw
foreach ($expected in $expectedModels) {
	$pattern = "(?ms)^display_name: {0}\r?\napi_name:\r?\n  local: {1}\r?\ndefault_provider: local(?=\r?\n---|\s*\z)" -f [regex]::Escape($expected.TransportModel), [regex]::Escape($expected.Model)
	if ($transportConfig -notmatch $pattern) {
		throw "Local transport alias '$($expected.TransportModel)' does not map to '$($expected.Model)' through the local provider."
	}
}
Write-Host "LiveBench local transport aliases OK"

# The adapter tests use synthetic reports and inputs only. They prove that
# ground truth cannot enter the role workspace and that no rejected consensus
# can silently become a scored answer without spending provider tokens.
& $venvPython $protocolTestPath
if ($LASTEXITCODE -ne 0) {
	throw "Ansteel LiveBench adapter offline contract tests failed."
}

Write-Host "LiveBench offline environment check passed. No provider request was sent."
