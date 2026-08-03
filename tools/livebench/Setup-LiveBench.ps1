[CmdletBinding()]
param(
	[string]$LiveBenchRoot = "F:\codex\benchmarks\LiveBench",
	[string]$PythonPath = "C:\Users\leomx\AppData\Local\Programs\Python\Python312\python.exe",
	[switch]$SkipCodeRunner,
	[switch]$DownloadQuestions,
	[string]$HuggingFaceProxy = "http://127.0.0.1:7890"
)

$ErrorActionPreference = "Stop"

# Keep the benchmark checkout out of the workspace repository so upstream files,
# downloaded data, results, virtual environments, and credentials never affect
# the Ansteel source tree's commit boundary.
$repositoryUrl = "https://github.com/LiveBench/LiveBench.git"
$expectedCommit = "010fa61e99f2751032a27434d13ffc01c7995432"
$transportModelConfig = Join-Path $PSScriptRoot "ansteel-livebench-models.yml"

function Invoke-CheckedCommand {
	param([string]$FilePath, [string[]]$Arguments)

	& $FilePath @Arguments
	if ($LASTEXITCODE -ne 0) {
		throw "Command failed ($LASTEXITCODE): $FilePath $($Arguments -join ' ')"
	}
}

if (-not (Test-Path -LiteralPath $LiveBenchRoot)) {
	$parent = Split-Path -Parent $LiveBenchRoot
	New-Item -ItemType Directory -Force -Path $parent | Out-Null
	Invoke-CheckedCommand -FilePath "git" -Arguments @("clone", "--filter=blob:none", $repositoryUrl, $LiveBenchRoot)
	Invoke-CheckedCommand -FilePath "git" -Arguments @("-C", $LiveBenchRoot, "checkout", "--detach", $expectedCommit)
}

$actualCommit = (& git -C $LiveBenchRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $actualCommit -ne $expectedCommit) {
	throw "LiveBench checkout must be $expectedCommit, found '$actualCommit'."
}
if (-not (Test-Path -LiteralPath $transportModelConfig)) {
	throw "Local LiveBench transport model configuration was not found at $transportModelConfig."
}

# The official registry has provider-specific defaults for public model names.
# Install the local transport aliases after validating the pinned checkout so a
# benchmark run always honors the selected local provider and --max-tokens.
$modelConfigTarget = Join-Path $LiveBenchRoot "livebench\model\model_configs\ansteel-livebench.yml"
Copy-Item -LiteralPath $transportModelConfig -Destination $modelConfigTarget -Force

if (-not (Test-Path -LiteralPath $PythonPath)) {
	throw "Python 3.12 runtime was not found at $PythonPath."
}

$venvPath = Join-Path $LiveBenchRoot ".venv"
$venvPython = Join-Path $venvPath "Scripts\python.exe"
if (-not (Test-Path -LiteralPath $venvPython)) {
	Invoke-CheckedCommand -FilePath $PythonPath -Arguments @("-m", "venv", $venvPath)
}

$uv = (Get-Command "uv" -ErrorAction Stop).Source
$previousNoProxy = $env:NO_PROXY
$previousNoProxyLower = $env:no_proxy
$previousLinkMode = $env:UV_LINK_MODE

try {
	# The local Windows proxy can serve interactive curl requests but caused the
	# Python package resolvers to stall before writing dependencies. Direct PyPI
	# access is verified locally, so scope this workaround to installation only.
	$env:NO_PROXY = "*"
	$env:no_proxy = "*"
	$env:UV_LINK_MODE = "copy"

	Invoke-CheckedCommand -FilePath $uv -Arguments @("pip", "install", "--python", $venvPython, "-e", $LiveBenchRoot)

	if (-not $SkipCodeRunner) {
		$requirementsPath = Join-Path $LiveBenchRoot "livebench\code_runner\requirements_eval.txt"
		# This legacy package has no CPython 3.12 Windows wheel and duplicates the
		# supported Levenshtein>=0.25 requirement present in the same official file.
		$requirements = Get-Content -LiteralPath $requirementsPath |
			ForEach-Object { $_.Trim() } |
			Where-Object { $_ -and -not $_.StartsWith("#") -and $_ -notmatch "^python-Levenshtein-wheels(?:[<>=!~].*)?$" }
		Invoke-CheckedCommand -FilePath $uv -Arguments (@("pip", "install", "--python", $venvPython) + $requirements)
	}
}
finally {
	$env:NO_PROXY = $previousNoProxy
	$env:no_proxy = $previousNoProxyLower
	$env:UV_LINK_MODE = $previousLinkMode
}

Invoke-CheckedCommand -FilePath $venvPython -Arguments @("-m", "pip", "check")

if ($DownloadQuestions) {
	$previousHttpProxy = $env:HTTP_PROXY
	$previousHttpsProxy = $env:HTTPS_PROXY
	try {
		# PyPI is reachable directly, while the public Hugging Face dataset endpoint
		# is reachable through this local proxy on the configured Windows host. The
		# parameter is overridable for another machine or proxy address.
		if (-not [string]::IsNullOrWhiteSpace($HuggingFaceProxy)) {
			$env:HTTP_PROXY = $HuggingFaceProxy
			$env:HTTPS_PROXY = $HuggingFaceProxy
		}
		Push-Location (Join-Path $LiveBenchRoot "livebench")
		try {
			Invoke-CheckedCommand -FilePath $venvPython -Arguments @("download_questions.py")
		}
		finally {
			Pop-Location
		}
	}
	finally {
		$env:HTTP_PROXY = $previousHttpProxy
		$env:HTTPS_PROXY = $previousHttpsProxy
	}
}

Write-Host "LiveBench environment is ready at $LiveBenchRoot (commit $expectedCommit); local transport model aliases were installed."
