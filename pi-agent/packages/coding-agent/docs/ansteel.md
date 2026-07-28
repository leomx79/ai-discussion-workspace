# Ansteel Evidence-First Reviews

`pi --ansteel` runs a non-interactive, evidence-first engineering collaboration under mandatory three-role governance:

- Tech Lead independently investigates, publishes a work card, challenges peer claims, responds to assigned challenges, and verifies each revision.
- Staff Engineer independently investigates, publishes a work card, challenges peer claims, responds to assigned challenges, and verifies each revision.
- QA Engineer independently investigates, publishes a work card, challenges peer claims, responds to assigned challenges, and verifies each revision.

All three roles normally use explicitly configured, distinct `provider/model` values. This is a configuration-identity check, not proof that the configured names reach distinct backend models, provider endpoints, or providers. There is no fourth reviewer or sign-off role. A review is approved only after all three revised work cards pass independent verification, Tech Lead writes consensus, and both Staff Engineer and QA Engineer explicitly sign off on that immutable text. The protocol makes uncertainty and verification work visible; it does not guarantee that a model response is correct.

## Run a review

From the project being reviewed, first create the required `.pi/ansteel.json` configuration, then run:

```bash
pi --ansteel "Review the motor safety change"
```

`--ansteel` uses non-interactive output. It prints a stage-progress line as each role begins, completes, fails, or times out. At completion it prints the complete discussion transcript, followed by the result and path to the saved Markdown report, for example:

```text
Ansteel review approved: /project/.pi/ansteel-reports/ansteel-2026-07-22-10-30-00-review-the-motor-safety-change.md
```

## Resume a bounded review

Every `--ansteel` run writes coordinator-owned state under `.pi/ansteel-runs/<run-id>/checkpoint.json`. A process may be restarted after a committed role stage with:

```bash
pi --ansteel-resume ansteel-run-2026-07-28T00-00-00-000Z
```

`--ansteel-resume` accepts only a generated run ID. It cannot be combined with `--ansteel` or Pi's ordinary `--resume/-r` session selector. Before creating any role session, Pi reloads the v3 checkpoint and rejects a resume when the review root, immutable evidence-package hash, coordinator configuration fingerprint, or any configured role provider/model identity changed. It preserves the original project start and hard deadline, so a resumed process never receives a fresh project SLA; an expired checkpoint is archived before prompting the next role. New checkpoints retain the bounded evidence-file path selection and its candidate count, then rebuild exactly that selection on resume: a changed, deleted, unreadable, or out-of-bound selected file rejects the resume; a later unselected ordinary file cannot alter ordering or enter the historical evidence boundary. Checkpoints are local protected governance records: they retain the frozen evidence and committed role responses needed for deterministic replay, but never credentials, raw tool arguments, or tool output. They restore the project-wide tool count and deterministically replay only coordinator validation for committed transcript entries; those completed role prompts are never sent to a provider again.

When an enabled `adaptiveBudgetPolicy.epochTimeoutMs` boundary is reached between committed role stages, Pi reports `PAUSED`, leaves the checkpoint in `ready-to-resume`, increments its epoch counter, and exits with success rather than publishing a rejected review report. The next `--ansteel-resume` invocation opens fresh short-lived role sessions and continues from the next uncommitted stage.

## Supervise a long-running review

Use the local supervisor when a review can span many bounded epochs:

```bash
pi --ansteel-supervise "Review the motor safety change"
pi --ansteel-supervise-resume ansteel-run-2026-07-28T00-00-00-000Z
```

The supervisor starts a fresh short-lived `pi --ansteel` or `pi --ansteel-resume` child for each epoch. It never creates a role session or calls a provider itself; after every child exits successfully, it reloads only the durable checkpoint and continues only while its status is `ready-to-resume`. A completed, failed, or expired checkpoint is terminal. A missing, malformed, ambiguous, or other nonterminal checkpoint fails closed.

`--ansteel-supervise` defaults to 64 epochs. Set `--ansteel-supervise-max-epochs <1..128>` to choose a lower or higher bounded limit. Reaching that limit preserves the `ready-to-resume` checkpoint and exits nonzero with `SUPERVISOR_STOPPED`; it does not invent a terminal governance result. The same marker is printed when a child exits nonzero or the durable checkpoint is invalid.

Only one supervisor may own a project. Its lock is `.pi/ansteel-supervisor.lock`; a second supervisor refuses to start while the recorded owner PID is alive or cannot be verified. New version-2 locks explicitly record `idle`, `starting`, or `running`: before spawning an epoch child, the supervisor durably records `starting`, then changes it to `running` with the child PID. Pi removes an orphaned version-2 lock only after confirming that the owner PID has exited and it is `idle`, or that its recorded active child has also exited. An orphaned `starting` claim is intentionally not auto-recovered: the process may have died between creating the child and recording its PID, so an operator must first confirm that no epoch child remains before clearing the lock. The older version-1 lock format did not record this child state; when its owner PID has exited it is also retained for manual investigation rather than being auto-recovered. Before manually running `--ansteel-resume`, stop the supervisor that owns the project. Every epoch has newly created role sessions, but resume still verifies the original checkpoint, evidence boundary, project deadline, and role identities.

There is no fallback to the current Pi model. Before naming each role model, make sure it is available and authenticated in Pi. Use `/login`, `pi --list-models`, and the normal [Providers](providers.md) and [Custom models](models.md) setup as needed. A role can use only its explicitly configured fallback chain, and only when provider fallback is enabled for the review.

For a monorepo review, do not rely on a topic's relative paths to reach a parent directory. Set `reviewRoot` to `git-root` and declare every workflow, document, or configuration file that must be in the shared evidence package. Before any role session is created, Pi resolves the Git root, rejects missing, excluded, out-of-root, binary, or over-limit required paths, and retains declared files ahead of the normal evidence-file limit. The default `cwd` scope remains unchanged for ordinary single-project reviews.

## Run an interactive team

`--ansteel` is a bounded review that exits. For ordinary project work with three persistent roles, start Pi in interactive mode and use the built-in team command instead:

```text
/ansteel-team start "Review the motor safety change"
/ansteel-team ask "Compare the encoder implementations and identify the next safe task"
/ansteel-team task {"id":"TASK-MOTOR","owner":"staff-engineer","files":["src/motor.ts"],"description":"Implement the approved motor change","acceptanceCriteria":"The motor tests pass","dependsOn":[]}
/ansteel-team task TASK-MOTOR
/ansteel-team status
/ansteel-team stop
```

`start` creates or resumes a dedicated Pi session for Tech Lead, Staff Engineer, and QA Engineer using the role models in `.pi/ansteel.json`. A new team first performs three independent investigations, then a public cross-examination round. `ask` continues the work from an isolated conversation branch for each role, with current facts reconstructed from the bounded public ledger. The append-only session file remains available for audit, but old assistant messages and truncated private work are not automatically injected into the next role stage. Role responses are shown in the host Pi timeline as public updates; hidden reasoning and raw provider payloads are not shared.

Project state lives under `.pi/ansteel-team/`: `team.json` records the team, role-session locations, immutable task-owner policy, task ownership, evidence packages, and peer verdicts; `events.jsonl` is an append-only public ledger. `stop` disposes live role sessions but retains these files so a later `start` can resume the team. Resume requires the current `teamTaskOwners` configuration to match the persisted policy. Starting a different topic requires removing or archiving the existing team state first.

## Interactive change gate

Interactive roles use ordinary project tools, but code changes are governed by the coordinator task entry and role-specific task tools:

1. The coordinator is the only task-creation entry. `/ansteel-team task <JSON>` registers one task through the shared task validator and records a `task-assigned` event whose actor is `coordinator` and whose target is the configured owner. Interactive roles are not given `ansteel_claim_task`, cannot create or rename tasks, and cannot race the coordinator by claiming a different file set. The coordinator cannot publish role reports, reviews, or sign-offs and is not a fourth governance role. Each dependency must already exist, cannot reference itself, and the coordinator rejects any dependency cycle.
2. A task with unmet predecessors is coordinator-derived as `blocked`; no role can write its files or assert that it has been unlocked. It becomes `claimed` only after every predecessor has received both peer approvals. Only then can its owner use `edit` or `write` on those exact files. All other paths, all other roles, and a submitted task are blocked. Direct `bash` is inspection-only; it cannot be used to bypass the file gate.
3. The owner calls `ansteel_submit_change` with one supported test/check command. Pi runs it, records the actual stdout/stderr and exit result, captures the Git diff for exactly the claimed files, and freezes that evidence package.
4. Tech Lead and QA, or the two roles other than the owner, receive the same frozen test output and diff concurrently. Their current review replies are not shown to each other. Each must call `ansteel_review_task` with `approve` or `reject`; a rejection requires a concrete issue.
5. Both peer approvals mark the task `approved`. Any peer rejection returns it to `revision-required`; the owner must change it, run a new test, and submit a new diff. QA has the same immediate return authority and cannot be bypassed.

`/ansteel-team task TASK-ID` resumes an existing non-approved task without creating a duplicate. A coordinator task runs through isolated owner epochs. `teamTaskMaxEpochs` controls the maximum owner epochs (`1..128`, default `8`), while `teamTaskMaxNoProgressEpochs` controls consecutive epochs without governed progress (`1..8`, default `2`, and never greater than the maximum epoch count). Governed progress means a change to task status or revision, recorded test/submission/review counts, or the SHA-256 of the exact claimed-file Git diff. Reading files, repeating tools, producing prose, or extending wall-clock time is not progress.

Interactive role sessions also enforce the existing `maxToolCallsPerStage` setting as a per-prompt read-only tool budget (default `4`). The counter resets for every isolated stage or owner epoch. `read`, `grep`, `find`, `ls`, and valid inspection-only `bash` calls consume it; governed `edit`, `write`, and Ansteel task tools do not. When the budget is exhausted, further scanning is blocked and an authorized owner must leave a governed implementation checkpoint or return a concise blocker. This prevents a long task from spending every epoch rereading the same repository until provider output truncation.

An assistant completion with `stopReason: length`, a provider error, or no nonempty public text is a role-stage failure and is never recorded as a successful empty `role-report`. A truncated owner epoch may continue only when its governed progress fingerprint changed. Otherwise the task stops with `owner-no-progress`; reaching the configured epoch ceiling stops with `task-epoch-limit`. These stops preserve the task, diff, evidence, and append-only session so an operator can inspect the cause and explicitly resume. They never manufacture task approval.

Task approval is not a project-delivery claim. Tech Lead may register `MILESTONE-...` through `ansteel_plan_milestone` with the exact approved task set and a cross-task acceptance condition. Until every listed task is approved, the milestone is coordinator-derived as `blocked`. Tech Lead then uses `ansteel_submit_integration` to run one real bounded integration command and freeze its output. Staff Engineer and QA Engineer independently receive that same output and must use `ansteel_review_integration`; both approvals are required for the milestone to become `approved`, while either rejection returns it to `revision-required` for a new integration run. No role can turn a task-only approval into a milestone approval by prose.

An interactive submission requires a Git worktree and a nonempty diff for the claimed files. This gate proves task ownership, recorded tool evidence, and review sequence; it does not make a passing test or a model conclusion inherently correct.

## Review flow

The coordinator runs these stages in order:

1. Tech Lead, Staff Engineer, and QA Engineer each independently investigate the same topic and publish a work card. Their work-card prompts do not include another role's conclusion.
2. Each role receives the same three work cards and independently cross-examines the other roles' claims, evidence, omissions, alternatives, and trade-offs.
3. For at most two revision rounds, every role publishes a response and revised work card that resolves every open challenge assigned to that role. The revision must explain the evidence, decision, and remaining risk behind each response, then propose actionable next steps with an owner or decision maker, scope, and acceptance condition.
4. Tech Lead, Staff Engineer, and QA Engineer independently verify the same set of three revised work cards. Their current-round verification answers are not shared until all three are complete.
5. All three verifiers must approve. A valid rejection creates the next revision round; exhausting the cap rejects the review.
6. Tech Lead writes consensus from the visible evidence, followed by immutable Staff Engineer and QA Engineer sign-off.

Initial work cards must contain visible Markdown headings with nonempty body content for `Conclusion`, `Evidence`, `Assumptions and Unknowns`, `Alternatives and Trade-offs`, `Self-Refutation Conditions`, and `Questions for Peers`. Revised work cards additionally require `Challenge Responses` and `Recommended Actions`. `Challenge Responses` explains why each issue can be closed and what risk remains; `Recommended Actions` turns the discussion into a proposed owner or decision maker, scope, and acceptance condition. Missing any required heading or leaving its body empty rejects the review. The transcript shares these auditable materials, not hidden model reasoning. Each role still has its own in-memory session, role-local memory, and configured Skill set; role sessions load no extensions or custom tools.

Every role stage has a total wall-clock deadline independent of the provider HTTP idle timeout. The default soft limit is 120 seconds. A coordinator may grant a bounded extension only after observing a successful, previously unseen tool-operation pattern or an already-valid open ledger obligation. It never reads model reasoning, raw tool arguments, or tool output to make that decision. The stage hard ceiling, project wall-clock ceiling, and project-wide tool ceiling remain immutable; if no eligible progress exists or any hard limit is reached, Pi aborts the active role session, rejects the review with `stage-timeout`, and continues through normal cleanup and report writing rather than waiting indefinitely.

## Challenge ledger

Every required cross-examination change must use its own exact marker, followed by evidence, impact, and an acceptance condition:

```text
ISSUE: STAFF-1 | TARGET: qa-engineer
```

Use an uppercase unique ID such as `STAFF-1` or `QA-1` and target another role. A role cannot target itself. During cross-examination, every reviewer must explicitly cover both peer roles. For each peer, emit one or more issue markers targeted at that peer, or this exact marker on its own line:

```text
NO ISSUES | TARGET: qa-engineer
```

Plain `NO ISSUES` remains shorthand for both peers only. It cannot coexist with an `ISSUE` marker or a targeted `NO ISSUES` marker. A targeted `NO ISSUES` marker may coexist with issues for the other peer. Do not emit it for a peer that already has an issue; normal agent responses sometimes add it as a redundant "no additional issues" summary, which is tolerated and does not cancel the recorded issues.

Each role revision must include this exact marker for every open challenge assigned to that role. Do not emit a resolution marker when no challenge is assigned:

```text
RESOLUTION: STAFF-1 | RESOLVED
```

The marker is only the ledger transition. The revised work card must also explain the response in `Challenge Responses` and convert the resulting decision into testable `Recommended Actions`; a marker alone does not constitute team discussion or a delivery plan.

Missing, duplicated, unknown, self-targeted, or malformed issue and resolution markers reject the review. A verification rejection must add at least one new targeted `ISSUE` marker; a rejection without a new issue is rejected as unsupported rather than silently retried.

## Evidence labels

Every factual claim should carry one of these labels:

| Label | Meaning | Expected treatment |
|-------|---------|--------------------|
| `L1` | Verified | Cite the concrete file, tool output, test result, or authoritative source. |
| `L2` | High confidence | State the technical basis, but do not present it as directly verified. |
| `L3` | Needs verification | State what is uncertain and how to check it. |
| `L4` | Unknown or doubtful | Say that it is unknown; do not convert it into a conclusion. |

An `L1` label requires cited evidence. A role's confidence alone does not raise a claim to `L1`.

## Approval gates

All three verification stages and both final sign-off stages are fail-closed. An approval must use this marker on its own line:

```text
VERDICT: APPROVE
```

Each verification prompt requires its response's final nonblank line to be exactly `VERDICT: APPROVE` or exactly `VERDICT: REJECT`. A verifier that rejects must emit at least one new targeted issue marker before that final verdict line. During verification, an exact `VERDICT: REJECT` plus at least one new targeted issue enters the next collaborative revision round. A missing marker, duplicate marker, marker with extra whitespace, malformed marker, or rejection without a new issue rejects the review immediately. After two unsuccessful revision rounds, the review is rejected and archived. A final Staff or QA sign-off rejection is terminal: it preserves the immutable consensus and transcript in the report, but the process exits nonzero.

## Per-role configuration

Create `.pi/ansteel.json` in the project being reviewed. The `model` field is required for every role, and all three configured `provider/model` values must be distinct by default. Missing, invalid, duplicate, or unavailable role models reject the review before any role session is created.

```json
{
  "roles": {
    "tech-lead": {
      "model": "<provider-a>/<model-id-a>",
	  "fallbackModels": ["<provider-a>/<fallback-model-id>"],
	  "tools": ["read", "grep", "find", "ls"],
	  "teamTools": ["read", "grep", "find", "ls", "bash", "edit", "write"],
      "memoryFile": ".pi/ansteel-memory/tech-lead.md",
      "skillPaths": [".pi/ansteel-skills/tech-lead"]
    },
    "staff-engineer": {
      "model": "<provider-b>/<model-id-b>",
      "thinkingLevel": "high",
	  "tools": ["read", "grep", "find", "ls"]
    },
    "qa-engineer": {
      "model": "<provider-c>/<model-id-c>",
	  "tools": ["read", "grep", "find", "ls"]
    }
  },
  "reportDirectory": ".pi/ansteel-reports",
	"reviewRoot": "git-root",
	"requiredEvidencePaths": [
		".github/workflows/ansteel-delivery.yml",
		"pi-agent/packages/coding-agent/docs/ansteel-acceptance.md",
		"pi-agent/.pi/ansteel.json"
	],
  "stageTimeoutMs": 120000,
	"maxToolCallsPerStage": 8,
	"stageBudgetPolicy": {
		"maxStageTimeoutMs": 150000,
		"timeoutExtensionMs": 30000,
		"maxStageExtensions": 1,
		"projectTimeoutMs": 3600000,
		"maxProjectToolCalls": 96
	},
	"allowProviderFallback": false,
	"teamTaskOwners": ["staff-engineer"],
	"allowSingleModel": false
}
```

Set `allowSingleModel` to `true` only for an intentional same-model discussion. It retains independent role sessions, role tools, challenge gates, and QA veto. The report marks it `Diversity status: SINGLE_MODEL_CONFIGURED`; it must not be interpreted as cross-model verification. With the default `false`, Pi requires distinct configured/resolved role identities, but reports `Diversity status: UNVERIFIED` because this version does not verify that those identities reach distinct backend models, provider endpoints, or providers.

`model` must use the exact `provider/model` form known to Pi, and that provider must have configured authentication. There is no current-model fallback.

`allowProviderFallback` defaults to `false`. Set it to `true` only with a role-local `fallbackModels` chain. The coordinator resolves every configured fallback before the review begins and rejects duplicate identities when cross-model mode is required. It switches only the failed role, only after a `429`/quota failure or a transient provider/network/service failure; authentication, request, configuration, and unknown failures remain fail-closed. Every switch records the from/to configured identities and the classified failure category in the report. A fallback never borrows another role's active session or model.

`thinkingLevel` is optional per role and accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Pi clamps the selected level to the configured model's supported levels. Set it explicitly when a provider requires thinking to be enabled; it does not change the role's tool or governance permissions.

`memoryFile` is optional and names one role-local Markdown or text file inside the reviewed project. Its content is added only to that role's session as fallible background context. `skillPaths` is an optional array of role-local Skill files or directories inside the reviewed project. Ansteel sessions load only the paths listed for their own role; ordinary project and user Skills remain disabled during a review. A missing configured memory file rejects setup; a missing Skill path is reported by Pi's resource loader.

Keep API credentials out of `.pi/ansteel.json`. Configure authentication through Pi's existing provider settings or environment variables, and use separate provider aliases in each role's `provider/model` value when the roles need distinct API keys or endpoints.

`tools` configures only the non-interactive `--ansteel` review. Use the bounded read-only tools `read`, `grep`, `find`, and `ls`. Review roles cannot execute arbitrary shell commands and cannot read coordinator state such as historical reports, team state, role memory, Skills, or sessions. No batch-review role can receive `edit`, `write`, or SDK custom tools through this field.

`teamTools` configures interactive team sessions independently. It is optional and defaults to `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write`. The task tools are always present in interactive team mode. Even when `edit`, `write`, or `bash` are listed, task ownership remains enforced: `edit` and `write` require an active exact-file claim, `bash` is limited to read-only inspection, and the only test execution path is `ansteel_submit_change`.

`teamTaskOwners` controls which interactive roles may claim code-change tasks. It defaults to `["staff-engineer"]`; Tech Lead or QA may only claim changes when explicitly listed, for example `["staff-engineer", "tech-lead"]`. The selected policy is written into the team state when the team starts; a changed policy rejects a resume rather than silently changing an existing team's authority. The other roles still independently review every submitted task.

`reportDirectory` is resolved from the project directory and must remain inside it. Omit it to use the default `.pi/ansteel-reports` location.

`reviewRoot` is optional and defaults to `cwd`. Set it to `git-root` only when the review must include repository-level evidence outside the command's current subdirectory. Pi walks upward only to the first Git root; it never lets model-provided paths expand the boundary. `requiredEvidencePaths` is optional and contains root-relative supported text files. Every declared file must exist, stay within the resolved review root, remain outside generated Ansteel state, and fit within the 24-file evidence package cap. Declared files are hashed and included before ordinary discovered files. Review tools also run from the resolved root, so role prompts use manifest paths directly, without a launch-subdirectory prefix or `../` traversal.

`stageTimeoutMs` is optional and defaults to `120000`. It is the soft `--ansteel` stage limit and must be an integer from `1` through `2147483647` milliseconds. It applies to both `--ansteel` review stages and interactive team investigations or task reviews; an interactive timeout still aborts the role when possible and records a public `role-failure` event.

`maxToolCallsPerStage` is optional and defaults to `4`. It must be an integer from `1` through `32`. A tool request beyond the configured budget rejects the current review stage rather than allowing an unbounded tool loop.

`stageBudgetPolicy` is optional and applies to `--ansteel`. It may set `maxStageTimeoutMs`, `timeoutExtensionMs`, `maxStageExtensions`, `projectTimeoutMs`, and `maxProjectToolCalls`; it can also override the soft `stageTimeoutMs` and `maxToolCallsPerStage` together. Defaults are one 30-second extension, a stage hard ceiling of the soft limit plus 30 seconds, a one-hour project ceiling, and 96 tool executions across all role sessions. `maxStageTimeoutMs` must be at least the soft stage limit, `projectTimeoutMs` must be at least the stage hard ceiling, and `maxProjectToolCalls` must be at least the per-stage tool ceiling. Set `maxStageExtensions` to `0` to disable extension. A project-wide tool budget is consumed before executing each permitted tool request and is shared by all three roles.

`adaptiveBudgetPolicy` is optional and disabled unless `enabled: true`. When enabled, the coordinator uses observed successful new evidence, necessary unfinished governance output, duplicate/blocked request counts, project hard limits, and protected verification/sign-off reserves to decide each small time or tool allocation. Model text cannot request or justify allocation. Its bounded integer fields are `projectTimeoutMs`, `maxProjectToolCalls`, `timeExtensionMs`, `toolExtensionCalls`, `maxBlockedRequestsPerStage`, `maxDuplicateRequestsPerStage`, `protectedVerificationTimeMs`, `protectedVerificationToolCalls`, and `epochTimeoutMs`. Protected reserves must be strictly smaller than their project ceilings. `enabled: false` is equivalent to omitting the policy and retains fixed-budget behavior.

### Long-running reviews

For reviews that can legitimately take hours, configure three limits together: the project ceiling, each role stage's hard ceiling, and the epoch boundary. Raising only `projectTimeoutMs` does not extend a role that is still bounded by `maxStageTimeoutMs`. Keep every stage bounded to a defensible value, then use `epochTimeoutMs` with `--ansteel-supervise` to checkpoint and continue between committed stages before the immutable project deadline expires. `--ansteel-resume <run-id>` remains the explicit manual recovery command after the supervisor has stopped.

```json
{
  "stageBudgetPolicy": {
    "stageTimeoutMs": 600000,
    "maxStageTimeoutMs": 900000,
    "timeoutExtensionMs": 60000,
    "maxStageExtensions": 5,
    "projectTimeoutMs": 14400000,
    "maxProjectToolCalls": 160
  },
  "adaptiveBudgetPolicy": {
    "enabled": true,
    "projectTimeoutMs": 14400000,
    "maxProjectToolCalls": 160,
    "protectedVerificationTimeMs": 900000,
    "protectedVerificationToolCalls": 10,
    "epochTimeoutMs": 1800000
  }
}
```

`epochTimeoutMs` is checked only at a coordinator boundary after a stage commits. It cannot interrupt a live role request; `maxStageTimeoutMs` remains the fail-closed upper bound for that request. A timed-out or failed stage is terminal for that run and must not be resumed as though its response had committed.

## Reports and governance evidence

Every completed approval or rejection writes a complete, unedited Markdown transcript and the immutable project evidence package to `.pi/ansteel-reports/` by default. A configuration, model-resolution, or role-session construction failure also writes a sanitized rejected setup report, even when the configuration could not be parsed; it may not include an evidence package when preflight failed. The filename includes a UTC timestamp and a topic-derived slug. The CLI also creates a separate live checkpoint at `.pi/ansteel-runs/<run-id>/checkpoint.json`; it records immutable recovery identities, the next coordinator action, committed transcript, redacted stage audits, fixed and adaptive budget ledgers, challenge/revision state, provider fallback identities, and terminal or resumable status. Reports are historical model output and are never loaded as recovery state or review evidence.

`Governance result` records whether the required role review, verification, and sign-off gates passed. It does not mean the reviewed task was implemented, proven, or otherwise delivered. `Delivery result` is therefore always `NOT_DELIVERED` for `--ansteel`. A rejected report does not publish a standalone Tech Lead consensus section: the raw response remains in the complete transcript, but no governance conclusion was formed without both final sign-offs.

The report records the result, challenge ledger, revision-round outcomes, complete role responses, configured/resolved role identities, Tech Lead consensus when it exists, and coordinator-derived fixed and adaptive budget ledgers. The adaptive ledger records every grant or denial and the observed reason before the transcript; role prose cannot override it. The ledgers intentionally store neither credentials, raw provider endpoints, tool arguments, nor tool output. A distinct configured-identity check does not prove backend model or provider diversity, and it does not prove that any factual claim is true. Retain cited file, tool, test, or source evidence; model identity configuration supplements rather than replaces it.
