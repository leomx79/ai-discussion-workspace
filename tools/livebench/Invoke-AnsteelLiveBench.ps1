[CmdletBinding()]
param(
	[string]$LiveBenchRoot = "F:\codex\benchmarks\LiveBench",
	[string]$PiAgentRoot = "",
	[string]$EvaluationRoot = "F:\codex\benchmarks\LiveBench\ansteel-livebench-runs",
	[string[]]$BenchName = @("live_bench"),
	[ValidatePattern("^\d{4}-\d{2}-\d{2}$")]
	[string]$Release = "2024-11-25",
	[ValidateRange(-1, 1000000)]
	[int]$QuestionBegin = -1,
	[ValidateRange(-1, 1000000)]
	[int]$QuestionEnd = -1,
	[string]$QuestionIds = "",
	[ValidateRange(1, 128)]
	[int]$MaxEpochs = 64,
	[ValidatePattern("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")]
	[string]$RunLabel = "r1",
	[ValidatePattern("^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$")]
	[string]$ModelDisplayName = "ansteel-three-role-consensus-v1",
	[switch]$Resume,
	[switch]$DryRun,
	# Optional protocol config override for ablation runs (e.g. disable bash,
	# disable adaptive rounds, or force a single model). Defaults to the
	# canonical ansteel-livebench-config.json when omitted.
	[string]$ProtocolConfig = ""
)

$ErrorActionPreference = "Stop"

# The Python adapter owns per-question workspaces and runs Pi's checkpointed
# supervisor. This wrapper only resolves local executable paths and forwards
# non-secret benchmark options; it never reads or exports provider credentials.
if ([string]::IsNullOrWhiteSpace($PiAgentRoot)) {
	$workspaceRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
	$PiAgentRoot = Join-Path $workspaceRoot "pi-agent"
}
$venvPython = Join-Path $LiveBenchRoot ".venv\Scripts\python.exe"
$adapterPath = Join-Path $PSScriptRoot "ansteel_livebench_adapter.py"
$protocolConfigPath = if ([string]::IsNullOrWhiteSpace($ProtocolConfig)) {
	Join-Path $PSScriptRoot "ansteel-livebench-config.json"
}
else {
	$ProtocolConfig
}
$piTestPath = Join-Path $PiAgentRoot "pi-test.ps1"
foreach ($required in @($venvPython, $adapterPath, $protocolConfigPath, $piTestPath)) {
	if (-not (Test-Path -LiteralPath $required)) {
		throw "Required Ansteel LiveBench path is missing: $required"
	}
}
if ($QuestionBegin -ge 0 -and $QuestionEnd -ge 0 -and $QuestionEnd -lt $QuestionBegin) {
	throw "QuestionEnd ($QuestionEnd) cannot be less than QuestionBegin ($QuestionBegin)."
}
if (-not [string]::IsNullOrWhiteSpace($QuestionIds)) {
	if ($QuestionBegin -ge 0 -or $QuestionEnd -ge 0) {
		throw "QuestionIds cannot be combined with QuestionBegin/QuestionEnd."
	}
}

$arguments = @(
	$adapterPath,
	"--livebench-root", $LiveBenchRoot,
	"--python-path", $venvPython,
	"--pi-test-path", $piTestPath,
	"--protocol-config", $protocolConfigPath,
	"--evaluation-root", $EvaluationRoot,
	"--bench-name"
) + $BenchName + @(
	"--release", $Release,
	"--question-begin", "$QuestionBegin",
	"--question-end", "$QuestionEnd",
	"--question-ids", $QuestionIds,
	"--max-epochs", "$MaxEpochs",
	"--run-label", $RunLabel,
	"--model-display-name", $ModelDisplayName
)
if ($Resume) { $arguments += "--resume" }
if ($DryRun) { $arguments += "--dry-run" }

& $venvPython @arguments
if ($LASTEXITCODE -ne 0) {
	throw "Ansteel LiveBench adapter failed with exit code $LASTEXITCODE. Its per-question external workspace contains the protocol and scoring logs."
}
