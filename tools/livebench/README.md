# LiveBench Three-Model Runner

This directory contains the reproducible local setup and launch path for the
three independent provider/model identities validated by the Ansteel r57 run:

| Role | Pi provider | Model | LiveBench result name |
| --- | --- | --- | --- |
| Tech Lead | `volcengine-agent-plan` | `glm-5.2` | `livebench-glm-5.2` |
| Staff Engineer | `deepseek-flash` | `deepseek-v4-flash` | `livebench-deepseek-v4-flash` |
| QA Engineer | `volcengine-coding` | `kimi-k2.7-code` | `livebench-kimi-k2.7-code` |

## Boundaries

- The official checkout, virtual environment, question data, answers, and
  scores live outside this workspace at `F:\codex\benchmarks\LiveBench`.
- Provider keys remain in `%USERPROFILE%\.pi\agent\models.json`. The scripts
  read them only at run time, do not print them, and do not create an `.env`.
- The Windows launcher calls `gen_api_answer.py` and
  `gen_ground_truth_judgment.py` directly. Upstream `run_livebench.py` shells
  through Bash and echoes the exported API key, so it is intentionally not used.
- `ansteel-livebench-models.yml` installs local transport aliases into the
  external checkout. This prevents upstream public-model presets from changing
  the selected local endpoint, output token ceiling, or request defaults.
- These commands evaluate each model independently. They do not measure the
  Ansteel multi-role protocol; a protocol benchmark needs a separate answer
  adapter and must not be compared directly to these baselines.
- The public `2024-11-25` release is the default because the upstream README
  states that newer releases do not publish every question category. The
  launcher reads the downloaded local JSONL snapshot, not the live Hub, so all
  three models receive the same question files without runtime dataset network.
- Agentic coding is not configured: Docker is absent and upstream documents up
  to 150 GB of task images. Standard categories and their code scoring support
  are installed.

## Setup And Offline Check

```powershell
Set-Location F:\codex\ai群讨论
.\tools\livebench\Setup-LiveBench.ps1
.\tools\livebench\Test-LiveBenchEnvironment.ps1
```

`Setup-LiveBench.ps1 -DownloadQuestions` downloads the public question JSONL
files required by the launcher. The default Hugging Face proxy is the verified
local Windows proxy; override it with `-HuggingFaceProxy <url>` or pass an empty
value when another machine has direct access.

## Preview And Run

First print the fully resolved, redacted three-model plan without making an API
request:

```powershell
.\tools\livebench\Invoke-LiveBenchThreeModels.ps1 -BenchName live_bench/reasoning -QuestionEnd 3 -DryRun
```

To verify the question-slice plumbing without calling a provider, use the empty
half-open interval below. Its redacted commands must contain both range flags:

```powershell
.\tools\livebench\Invoke-LiveBenchThreeModels.ps1 -BenchName live_bench/reasoning -QuestionBegin 0 -QuestionEnd 0 -DryRun
```

Run the same small smoke subset for all three models:

```powershell
.\tools\livebench\Invoke-LiveBenchThreeModels.ps1 -BenchName live_bench/reasoning -QuestionEnd 3
```

`-MaxTokens` defaults to `4096` and is forwarded exactly to all three local
transport aliases. Do not use `-Resume` after an error-only run; remove its
external answer artifacts first so LiveBench cannot treat failed placeholders as
completed answers.

Run the complete public benchmark sequentially, one provider at a time:

```powershell
.\tools\livebench\Invoke-LiveBenchThreeModels.ps1 -BenchName live_bench -Resume
```

Use `-Resume -RetryFailures` after a provider rate limit or transient failure.
LiveBench stores answer and judgment files under its external checkout, so a
re-run does not overwrite completed answers.
