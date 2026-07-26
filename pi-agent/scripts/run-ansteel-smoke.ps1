param(
	[string]$Topic = "Smoke: verify configured role availability and fail-closed governance. Do not edit files.",
	[int]$TimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $root ".pi\ansteel.json"
$smokePath = Join-Path $root ".pi\ansteel-smoke.json"
$config = Get-Content -Raw $configPath | ConvertFrom-Json
$config.stageTimeoutMs = 20000
$config.maxToolCallsPerStage = 1
$budgetPolicy = [pscustomobject]@{
	stageTimeoutMs = 20000; maxStageTimeoutMs = 30000; timeoutExtensionMs = 5000
	maxStageExtensions = 0; projectTimeoutMs = 60000; maxToolCallsPerStage = 1; maxProjectToolCalls = 3
}
if ($null -eq $config.PSObject.Properties["stageBudgetPolicy"]) {
	$config | Add-Member -NotePropertyName stageBudgetPolicy -NotePropertyValue $budgetPolicy
} else {
	$config.stageBudgetPolicy = $budgetPolicy
}
$config | ConvertTo-Json -Depth 20 | Set-Content -NoNewline $smokePath
try {
	$env:PI_ANSTEEL_CONFIG_PATH = ".pi/ansteel-smoke.json"
	$process = Start-Process powershell -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $root "pi-test.ps1"), "--ansteel", $Topic -WorkingDirectory $root -PassThru -WindowStyle Hidden
	if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
		& taskkill /PID $process.Id /T /F | Out-Null
		throw "Ansteel smoke exceeded $TimeoutSeconds seconds and its process tree was stopped."
	}
	if ($process.ExitCode -ne 0) { throw "Ansteel smoke exited with code $($process.ExitCode)." }
} finally {
	Remove-Item Env:PI_ANSTEEL_CONFIG_PATH -ErrorAction SilentlyContinue
	Remove-Item -LiteralPath $smokePath -ErrorAction SilentlyContinue
}
