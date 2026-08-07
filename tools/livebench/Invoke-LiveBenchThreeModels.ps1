[CmdletBinding()]
param(
	[string]$LiveBenchRoot = "F:\codex\benchmarks\LiveBench",
	[string]$PiModelsPath = (Join-Path $env:USERPROFILE ".pi\agent\models.json"),
	[string[]]$BenchName = @("live_bench"),
	[ValidateSet("tech-lead", "staff-engineer", "qa-engineer")]
	[string[]]$Role = @("tech-lead", "staff-engineer", "qa-engineer"),
	[ValidatePattern("^\d{4}-\d{2}-\d{2}$")]
	[string]$Release = "2024-11-25",
	[ValidateRange(1, 65536)]
	[int]$MaxTokens = 4096,
	[ValidateRange(1, 16)]
	[int]$ParallelRequests = 1,
	[ValidateRange(-1, 1000000)]
	[int]$QuestionBegin = -1,
	[ValidateRange(-1, 1000000)]
	[int]$QuestionEnd = -1,
	[string]$QuestionIds = "",
	[switch]$Resume,
	[switch]$RetryFailures,
	[switch]$DryRun
)

$ErrorActionPreference = "Stop"

# Run models sequentially by default. It prevents three independent provider
# rate limits from multiplying on Windows and keeps each model's answer files
# resumable through LiveBench's native --resume behavior.
$protocolConfigPath = Join-Path $PSScriptRoot "ansteel-livebench-config.json"
if (-not (Test-Path -LiteralPath $protocolConfigPath)) {
	throw "Protocol role-model config not found at $protocolConfigPath."
}
$protocolConfig = Get-Content -LiteralPath $protocolConfigPath -Raw | ConvertFrom-Json

function ConvertTo-AnsteelTransportModel {
	param([string]$ModelId)
	$slug = ($ModelId -replace '[^A-Za-z0-9]+', '-')
	return "ansteel-livebench-$slug"
}

# Role models come from the protocol config (single source of truth);
# changing a role model means editing ansteel-livebench-config.json only.
$modelPlan = @{}
foreach ($roleName in @("tech-lead", "staff-engineer", "qa-engineer")) {
	$reference = [string]$protocolConfig.roles.$roleName.model
	$provider, $model = $reference -split '/', 2
	if ([string]::IsNullOrWhiteSpace($provider) -or [string]::IsNullOrWhiteSpace($model)) {
		throw "Role '$roleName' in $protocolConfigPath must use provider/model form."
	}
	$modelPlan[$roleName] = [pscustomobject]@{
		Provider = $provider
		Model = $model
		TransportModel = ConvertTo-AnsteelTransportModel $model
		DisplayName = "livebench-$model"
	}
}

function Assert-ForwardedQuestionRange {
	param(
		[string[]]$Arguments,
		[string]$CommandName
	)

	foreach ($range in @(
		[pscustomobject]@{ Flag = "--question-begin"; Value = $QuestionBegin },
		[pscustomobject]@{ Flag = "--question-end"; Value = $QuestionEnd }
	)) {
		$flagIndex = [Array]::IndexOf($Arguments, $range.Flag)
		if ($range.Value -ge 0) {
			if ($flagIndex -lt 0 -or $flagIndex -eq ($Arguments.Count - 1) -or $Arguments[$flagIndex + 1] -ne [string]$range.Value) {
				throw "$CommandName did not forward $($range.Flag)=$($range.Value). Refusing to run an unintended question range."
			}
		}
		elseif ($flagIndex -ge 0) {
			throw "$CommandName unexpectedly contains $($range.Flag)."
		}
	}
}

if (-not (Test-Path -LiteralPath $LiveBenchRoot)) {
	throw "LiveBench checkout was not found at $LiveBenchRoot."
}
if (-not (Test-Path -LiteralPath $PiModelsPath)) {
	throw "Pi provider configuration was not found at $PiModelsPath."
}

$venvPython = Join-Path $LiveBenchRoot ".venv\Scripts\python.exe"
$answerGenerator = Join-Path $LiveBenchRoot "livebench\gen_api_answer.py"
$judgmentRunner = Join-Path $LiveBenchRoot "livebench\gen_ground_truth_judgment.py"
if (
	-not (Test-Path -LiteralPath $venvPython) -or
	-not (Test-Path -LiteralPath $answerGenerator) -or
	-not (Test-Path -LiteralPath $judgmentRunner)
) {
	throw "LiveBench environment is incomplete. Run Setup-LiveBench.ps1 first."
}
$questionFiles = Get-ChildItem -LiteralPath (Join-Path $LiveBenchRoot "livebench\data") -Recurse -File -Filter "question.jsonl" -ErrorAction SilentlyContinue
if ($questionFiles.Count -eq 0) {
	throw "LiveBench local questions are missing. Run Setup-LiveBench.ps1 -DownloadQuestions first."
}
if ($QuestionBegin -ge 0 -and $QuestionEnd -ge 0 -and $QuestionEnd -lt $QuestionBegin) {
	throw "QuestionEnd ($QuestionEnd) cannot be less than QuestionBegin ($QuestionBegin)."
}
if (-not [string]::IsNullOrWhiteSpace($QuestionIds)) {
	if ($QuestionBegin -ge 0 -or $QuestionEnd -ge 0) {
		throw "QuestionIds cannot be combined with QuestionBegin/QuestionEnd."
	}
}
$transportConfigPath = Join-Path $LiveBenchRoot "livebench\model\model_configs\ansteel-livebench.yml"
if (-not (Test-Path -LiteralPath $transportConfigPath)) {
	throw "Local transport model aliases are missing at $transportConfigPath. Re-run Setup-LiveBench.ps1 before launching."
}

$piModels = Get-Content -LiteralPath $PiModelsPath -Raw | ConvertFrom-Json
$previousApiKey = [Environment]::GetEnvironmentVariable("LIVEBENCH_API_KEY", "Process")
$previousPythonUtf8 = [Environment]::GetEnvironmentVariable("PYTHONUTF8", "Process")
$previousPythonIoEncoding = [Environment]::GetEnvironmentVariable("PYTHONIOENCODING", "Process")

try {
	# LiveBench imports an agentic module even for standard categories. That module
	# prints Unicode symbols through Rich, so force UTF-8 for this child-process
	# scope instead of depending on the Windows console's legacy GBK code page.
	$env:PYTHONUTF8 = "1"
	$env:PYTHONIOENCODING = "utf-8"

	foreach ($roleName in $Role) {
		$spec = $modelPlan[$roleName]
		$provider = $piModels.providers.$($spec.Provider)
		if ($null -eq $provider -or [string]::IsNullOrWhiteSpace([string]$provider.apiKey)) {
			throw "Provider '$($spec.Provider)' has no usable local credential."
		}
		if ($provider.api -ne "openai-completions" -or [string]::IsNullOrWhiteSpace([string]$provider.baseUrl)) {
			throw "Provider '$($spec.Provider)' is not usable through LiveBench's OpenAI-compatible route."
		}

		$modelIds = @($provider.models | ForEach-Object { $_.id })
		if ($modelIds -notcontains $spec.Model) {
			throw "Provider '$($spec.Provider)' does not declare model '$($spec.Model)'."
		}

		$inferenceArguments = @(
			$answerGenerator,
			"--model", $spec.TransportModel,
			"--model-display-name", $spec.DisplayName,
			"--api-base", $provider.baseUrl,
			"--model-provider-override", "local",
			"--bench-name"
		) + $BenchName + @(
			"--question-source", "jsonl",
			"--livebench-release-option", $Release,
			"--force-temperature", "0",
			"--max-tokens", "$MaxTokens",
			"--parallel", "$ParallelRequests"
		)
		$judgmentArguments = @(
			$judgmentRunner,
			"--model", $spec.Model,
			"--model-display-name", $spec.DisplayName,
			"--bench-name"
		) + $BenchName + @(
			"--question-source", "jsonl",
			"--livebench-release-option", $Release,
			"--parallel", "$ParallelRequests"
		)

		if ($QuestionBegin -ge 0) {
			$inferenceArguments += @("--question-begin", "$QuestionBegin")
			$judgmentArguments += @("--question-begin", "$QuestionBegin")
		}
		if ($QuestionEnd -ge 0) {
			$inferenceArguments += @("--question-end", "$QuestionEnd")
			$judgmentArguments += @("--question-end", "$QuestionEnd")
		}
		if (-not [string]::IsNullOrWhiteSpace($QuestionIds)) {
			$questionIdList = @($QuestionIds -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }
			if ($questionIdList.Count -eq 0) {
				throw "QuestionIds is non-empty but contained no usable ids."
			}
			$inferenceArguments += @("--question-id") + $questionIdList
			$judgmentArguments += @("--question-id") + $questionIdList
		}
		if ($Resume) {
			$inferenceArguments += "--resume"
			$judgmentArguments += "--resume"
		}
		if ($RetryFailures) { $inferenceArguments += "--retry-failures" }
		Assert-ForwardedQuestionRange -Arguments ([string[]]$inferenceArguments) -CommandName "LiveBench answer generation"
		Assert-ForwardedQuestionRange -Arguments ([string[]]$judgmentArguments) -CommandName "LiveBench scoring"

		Write-Host ("Preparing {0}: {1}/{2} against {3} with max_tokens={4}" -f $roleName, $spec.Provider, $spec.Model, $provider.baseUrl, $MaxTokens)
		if ($DryRun) {
			Write-Host ("Dry run inference: LIVEBENCH_API_KEY=<local Pi credential>; python {0}" -f ($inferenceArguments -join " "))
			Write-Host ("Dry run scoring: python {0}" -f ($judgmentArguments -join " "))
			continue
		}

		# The upstream aggregate runner exports and logs its API key through Bash.
		# Calling the two official Python stages directly avoids that Windows-only
		# dependency and keeps the key out of command lines and benchmark logs.
		$env:LIVEBENCH_API_KEY = [string]$provider.apiKey
		Push-Location (Join-Path $LiveBenchRoot "livebench")
		try {
			& $venvPython @inferenceArguments
			if ($LASTEXITCODE -ne 0) {
				throw "LiveBench answer generation failed for $roleName with exit code $LASTEXITCODE. Re-run with -Resume after diagnosing the saved result."
			}
			& $venvPython @judgmentArguments
			if ($LASTEXITCODE -ne 0) {
				throw "LiveBench scoring failed for $roleName with exit code $LASTEXITCODE. Re-run with -Resume after diagnosing the saved result."
			}
		}
		finally {
			Pop-Location
		}
	}
}
finally {
	if ($null -eq $previousApiKey) {
		Remove-Item Env:\LIVEBENCH_API_KEY -ErrorAction SilentlyContinue
	}
	else {
		$env:LIVEBENCH_API_KEY = $previousApiKey
	}
	if ($null -eq $previousPythonUtf8) {
		Remove-Item Env:\PYTHONUTF8 -ErrorAction SilentlyContinue
	}
	else {
		$env:PYTHONUTF8 = $previousPythonUtf8
	}
	if ($null -eq $previousPythonIoEncoding) {
		Remove-Item Env:\PYTHONIOENCODING -ErrorAction SilentlyContinue
	}
	else {
		$env:PYTHONIOENCODING = $previousPythonIoEncoding
	}
}

Write-Host "Requested LiveBench runs completed. Use show_livebench_result.py in the external checkout to view scored results."
