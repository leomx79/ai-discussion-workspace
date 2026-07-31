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
/ansteel-team task {"id":"TASK-MOTOR","owner":"staff-engineer","type":"implementation","files":["src/motor.ts"],"description":"Implement the approved motor change","acceptanceCriteria":"The motor tests pass","dependsOn":[]}
/ansteel-team task TASK-MOTOR
/ansteel-team status
/ansteel-team anchor TASK-MOTOR-PARSER origin
/ansteel-team anchor MILESTONE-MOTOR-INTEGRATION origin
/ansteel-team verify-anchor MILESTONE-MOTOR-INTEGRATION origin
/ansteel-team stop
```

`start` creates or resumes a dedicated Pi session for Tech Lead, Staff Engineer, and QA Engineer using the role models in `.pi/ansteel.json`. A new team first performs three independent investigations, then a public cross-examination round. `ask` continues the work from an isolated conversation branch for each role, with current facts reconstructed from the bounded public ledger. The append-only session file remains available for audit, but old assistant messages and truncated private work are not automatically injected into the next role stage. Role responses are shown in the host Pi timeline as public updates; hidden reasoning and raw provider payloads are not shared.

Project state lives under `.pi/ansteel-team/`: `team.json` records the team, role-session locations, immutable task-owner policy, typed task ownership, evidence packages, and peer verdicts; `events.jsonl` is an append-only public ledger. The coordinator creates four independent Ed25519 identities on the first new event. Its public manifest is retained beside the ledger, while `signing-private-keys.json` stays in the ignored, role-inaccessible runtime directory and is never included in prompts, reports, runtime logs, or Git commits. A pre-existing hash-only ledger remains readable as an explicit legacy prefix, but once a signed event exists every later event must verify under the exact key assigned to its declared role. `stop` disposes live role sessions but retains these files so a later `start` can resume the team. Resume requires the current `teamTaskOwners` configuration to match the persisted policy. Starting a different topic requires removing or archiving the existing team state first.

### Typed parallel tasks

Task types are mechanical state, not prose inferred from the description:

| Type | Default owner | Typical scope |
|---|---|---|
| `architecture` | Tech Lead | Architecture and interface decisions |
| `integration` | Tech Lead | Cross-module integration |
| `implementation` | Staff Engineer | Main product implementation |
| `verification` | QA Engineer | Test fixtures, adversarial tests, and acceptance automation |

A non-default owner is allowed only when the task includes a non-empty `assignmentReason`; the reason is persisted and published in the task-assignment event. Every owner must also be permitted by the team's immutable `teamTaskOwners` policy.

Pass a JSON array containing two or three tasks to run distinct owners in a parallel owner wave:

```text
/ansteel-team task [{"id":"TASK-API","owner":"tech-lead","type":"architecture","files":["src/contracts.ts"],"description":"Define the integration contract","acceptanceCriteria":"The contract test passes","dependsOn":[]},{"id":"TASK-CORE","owner":"staff-engineer","type":"implementation","files":["src/core.ts"],"description":"Implement the contract","acceptanceCriteria":"The core test passes","dependsOn":[]},{"id":"TASK-QA","owner":"qa-engineer","type":"verification","files":["test/core.test.ts"],"description":"Add acceptance automation","acceptanceCriteria":"The acceptance test passes","dependsOn":[]}]
```

The coordinator validates the whole batch against a cloned state, then commits the task state and one aggregate `tasks-assigned` event through the pending-transaction protocol. A duplicate owner, unauthorized owner, unresolved dependency, duplicate task ID, overlapping file, or invalid public event rejects the complete batch without leaving a partial claim or partial assignment ledger. Owner sessions then run concurrently. All tool-triggered task and milestone collaboration or final-verification prompts are queued for the duration of the parallel command, including submissions for older work. After every owner settles, the coordinator first obtains two public non-owner collaboration updates for each immutable revision. A task additionally checks that its frozen claimed-file diff has not drifted before the two independent final reviews; a milestone verifies its frozen integration evidence and required task state. Other deferred submissions are flushed in stable `kind/id/revision` order after the parallel command; missing collaboration or final-verification work remains queued, and a same-topic restart rebuilds the queue from `submitted` or `final-verification` tasks and milestones. This ordering prevents a persistent role session from being entered simultaneously as an owner and a collaborator or final reviewer without losing recoverability after a provider or host failure.

### Public collaboration board

Public work reasoning is a concise, structured engineering record: goal, current understanding, evidence, assumptions, uncertainties, next action and expected result, risk, and confidence. It is not hidden chain-of-thought. Pi does not publish private reasoning, raw provider payloads, or internal deliberation; public prose also cannot replace a structured collaboration event.

Roles use these four collaboration tools to append the public ledger:

| Tool | Required fields | Actor and state transition |
|---|---|---|
| `ansteel_publish_checkpoint` | `id`, `goal`, `currentUnderstanding`, `assumptions`, `evidenceRefs`, `uncertainties`, `nextAction`, `risk`, `confidence`; optional `taskId`, `supersedesCheckpointId` | Any role may publish its own `CP-...` checkpoint. A task-bound checkpoint must be written by that task's owner. A replacement must be from the same actor and supersede that actor's active checkpoint, changing the prior checkpoint to `superseded` and the replacement to `active`. |
| `ansteel_raise_process_issue` | `id`, `targetCheckpointId`, `severity`, `claim`, `evidenceRefs`, `suggestedCorrection` | A role may challenge a real peer checkpoint, never its own. The target role is derived from the checkpoint actor. The `PI-...` issue begins as `open`. |
| `ansteel_resolve_process_issue` | `id`, `issueId`, `outcome`, `summary`, `evidenceRefs`; `replacementCheckpointId` for `ACCEPTED`, or `experiment` for `EXPERIMENT_REQUIRED` | Only the issue's target role may respond. `ACCEPTED` requires its direct replacement checkpoint and moves the issue to `resolution-proposed`; `REFUTED` and `EXPERIMENT_REQUIRED` retain a reviewable proposal; `SCOPE_ESCALATION` becomes `escalated` and requires a user decision. |
| `ansteel_review_process_resolution` | `issueId`, `verdict`, `reason` | Only the issue author may review the latest proposal. `accept` closes the issue; `reject` returns it to `open`. No other role can close an issue, and a resolution is reviewed at most once. |

`/ansteel-team board` re-reads persisted `team.json` and the full hash-chained `events.jsonl`, then replays public collaboration events before it renders. It reads recent tool facts only from a same-team historical run with exactly one root `run.started` span, one later successful root terminal with the same span, event name, and root-level parent relationship, no open span, no failed/cancelled/abandoned fact, and a healthy artifact diagnosis. A successful child tool, a forged child terminal, or the last record's outcome cannot make an orphaned run trusted history. The coordinator derives active checkpoints, open/blocking/escalated issues, role status, and all board counts from those persisted facts; role-written prose and manually stated totals are not inputs to the board.

### 交互式动作风险门禁

交互式团队已把风险门禁接到真实工具执行前。风险由协调器根据工具、目标、覆盖语义和当前目标版本机械计算；角色在检查点中声明的风险只能升级该结果，不能降级。`edit` 通常为黄色；覆盖已有文件、删除，以及 `git commit`、`git push` 为红色。既有任务所有权和精确文件范围仍会共同参与判定，不能被风险确认绕过。

每个黄色或红色动作必须绑定精确的活动检查点、动作类型、规范化目标和当前动作版本，并由动作执行角色（actor）之外的两名同伴针对同一不可变绑定独立确认。确认不能跨检查点、动作类型、目标或版本复用。任一开放的 `blocking`/`critical` 问题，以及确认缺失、拒绝、超时、绑定不匹配或目标版本漂移，都会在工具执行前阻断动作。绿色只读动作无需等待确认，可立即执行，同时留下公共评估事实和运行事实。

文件目标同时经过词法路径和规范文件系统路径校验。已有目标跟随 `realpath`，缺失目标从最近存在的父目录解析；Windows junction 或 POSIX symlink 只要把目标导向项目外，就不能被认领、确认或执行。既有文件的动作版本从同一个只读句柄绑定非零 `dev/ino` 与内容 SHA-256；两名同伴批准的是这份精确身份。真实 `edit/write` 只消费一次对应授权，打开后立即把句柄身份与批准身份比较，并在每次 mutation 前核对当前路径、句柄身份、大小和批准哈希。`edit` 使用的 buffer 就是该次复核返回的同一份内容；覆盖和截断也复用该句柄。即使外部进程在路径校验与 `open()` 之间交替切换链接，项目外对象也不能匹配批准身份；同 inode 内容漂移会因哈希不符拒绝，打开后再替换链接也不能重定向写入。

受治理的 `write` 当前只允许覆盖已经获得稳定文件身份的普通文件。缺失目标、旧的纯内容哈希动作版本、零 inode 或身份漂移都会失败关闭，并要求发布新检查点；在 Node 提供可移植的目录句柄相对原子创建能力之前，治理模式不会降级为按路径字符串新建文件。普通非 Ansteel Pi `write` 未启用该守卫，仍保留原有的新建文件行为。

运行日志、artifact、公共事件账本和 UI 时间线共用凭据脱敏规则，覆盖 `=`、`:`、JSON 键值、Provider 前缀、Basic/Bearer 与 `sk-`。公共事件在哈希和持久化前递归脱敏；命令失败向 AgentSession、RPC、print 或 TUI 传播时会新建只含脱敏消息的异常，不会重新抛出原始 provider 错误。

## Interactive observability and diagnosis

The interactive team keeps four distinct durable record classes under `.pi/ansteel-team/`:

| Record | Path | Purpose |
|---|---|---|
| Public collaboration ledger | `events.jsonl` | Hash-chained role reports, failures, task events, reviews, and milestones |
| Structured runtime traces | `logs/run-<runId>-<segment>.jsonl` | Hash-chained command, role, provider, tool, and persistence span records |
| Content-addressed artifacts | `artifacts/<sha256>` | Redacted exception stacks and other large evidence referenced by runtime records |
| State and incident manifests | `team.json`, `transactions/`, `incidents/incident-<runId>-<sha256>.json` | Restart state, pending durable transactions, and mechanically assembled failure bundles |

The public ledger, current state, pending transactions, and incident manifests are governance or recovery records and must be retained until an explicit project retention policy archives them. Runtime logs and unreferenced artifacts are the high-volume record class intended for later time/size rotation. This release deliberately does not run an automatic retention or deletion job: logs and artifacts remain on disk, and no deletion is silently inferred from age. A future collector must preserve every segment or artifact referenced by a ledger event, incident, commit, or delivery record and append an auditable deletion event.

Every runtime command receives a `runId` and `traceId`; each operation receives a `spanId` and, when nested, a `parentSpanId`. Records can also carry `teamId`, `role`, `taskId`, `checkpointId`, `toolCallId`, provider/process identifiers, revision information, and a direct cause identifier. Failures use the versioned reason-code set, including `provider-timeout`, `provider-empty-public-output`, `provider-rate-limited`, `provider-authentication-failed`, `tool-exit-nonzero`, `tool-timeout`, `tool-policy-denied`, `process-orphaned`, `event-chain-invalid`, `event-fsync-failed`, `artifact-missing`, `state-projection-mismatch`, `budget-exhausted`, `no-governed-progress`, `coordinator-restarted`, and `unclassified-runtime-error`.

Use the read-only diagnostic commands from the host session:

```text
/ansteel-team status --explain
/ansteel-team trace <runId|traceId|taskId|issueId|toolCallId>
/ansteel-team doctor [runId]
/ansteel-team incident <runId>
```

`status --explain` combines persistent team status with the most recent completed run diagnosis. `trace` reloads and validates matching runtime records from disk. Before `doctor` starts an observed command, it first validates the complete persisted public-event hash chain independently, then re-reads `team.json` and verifies its ledger cursor and replayed public collaboration projection. A damaged event chain fails with `event-chain-invalid`; valid events paired with malformed state, a changed ledger cursor, or a divergent public projection fail with `state-projection-mismatch`. This preflight deliberately happens before any doctor log writer is created, so damaged evidence cannot be repaired or masked by a new diagnostic run. `doctor` then verifies the selected run's log chain and artifact hashes. A syntactically valid run ID with no persisted logs fails with `artifact-missing`; every `started` span must have a later terminal record with the same `spanId`, `eventName`, and `parentSpanId`, otherwise the run fails with `process-orphaned`. The command fails whenever persisted-team integrity or the selected runtime is unhealthy. Each runtime run has one persistent writer lease. A new host cannot finalize spans while the original logger still renews that lease, and a second recovery writer cannot reuse the same sequence/hash head. After acquiring an expired or released lease, recovery re-reads the chain and only then appends `abandoned/process-orphaned` in the original run, trace, team, parent-span, causal and operation correlation chain. The recovery attempt that appends those terminals fails closed; a later explicit retry may continue the existing role-recovery path. `incident` creates an always-redacted, content-addressed JSON manifest from existing facts; it does not ask a model to guess the cause. Extension-command errors are rethrown after the visible timeline message, so RPC returns `success: false` instead of reporting a failed command as successful.

`doctor` also performs a strict runtime-segment check. Unlike `trace`, it never rebuilds a missing, stale, or changed `run-index.json` before declaring integrity healthy; segment/index divergence fails closed as `event-chain-invalid`.

### Signed task and milestone anchors

`/ansteel-team anchor <TASK-ID|MILESTONE-ID> [remote]` is the only remote-anchor command. It never runs automatically after an approval. Before it touches Git, the coordinator requires the approved target's signed final approvals from every required peer, a fully signed ledger with no legacy prefix, a strict runtime-log result, a clean worktree, a named local branch, and the exact current `HEAD` already present on the selected remote branch. Every configured fetch URL and push URL for the selected alias must normalize to one matching credential-free endpoint; split or multi-endpoint `url`/`pushurl` aliases fail closed. It captures a content-addressed runtime-index snapshot before writing, builds a domain-separated SHA-256/JCS Merkle root over the immutable preceding ledger range, writes a canonical receipt to a distinct `refs/notes/ansteel/<team>/<task|milestone>/<id>/<revision>` Git notes ref, pushes that ref, then rechecks both the source branch reachability and exact remote ref object. Only after those checks succeed does it append a signed `task-anchor` or `milestone-anchor` event containing the complete structured receipt: the target, range, root, signing-manifest hash, runtime-index hash, runtime-snapshot hash, commit, source branch, credential-free remote endpoint identity, notes ref, and both local and remote note object IDs.

`/ansteel-team verify-anchor <TASK-ID|MILESTONE-ID> [remote]` first replays the persisted ledger and state projection, requires the current fully signed ledger to use the exact anchored signing-manifest hash, and verifies the immutable runtime snapshot. The snapshot preserves the anchored prefix hash and byte boundary of every indexed segment, so later append-only runtime logs are allowed but replacement or truncation is rejected. It then performs the explicit remote reads needed to confirm the credential-free endpoint identity, source-branch reachability of the recorded commit, exact notes-ref object, and canonical note body. A renamed remote alias pointing to a different endpoint, a force-push that removes the anchored commit, signing-key rotation/re-signing, failed remote access, altered persisted evidence, or a non-matching remote notes ref fails closed and leaves no local success event. Verification intentionally does not require a clean worktree because it makes no source-tree mutation. Both commands may use the configured Git credential helper and network only because the user explicitly invoked them.

A successfully pushed note proves that the checked remote received the exact receipt, and later verification detects deletion or replacement. It does **not** itself prove that the Git notes ref or the source branch has server-enforced protection. A protected GitHub branch/ruleset or an equivalent server-side protected-ref policy remains an operational prerequisite before this receipt can be represented as the protected external anchor required by the protocol; it also does not prove real-provider diversity, package publication, or `deliveryStatus: passed`.

Redaction happens before hashing and writing. Runtime records and artifacts must not contain API keys, authorization headers, cookies, private keys, environment-variable secret values, raw provider request bodies, private provider payloads, or hidden chain-of-thought. Environment assignments are matched by the complete variable name and sensitive suffix, so both bare names such as `API_KEY`, `TOKEN`, `PASSWORD`, and `SECRET` and provider-prefixed names such as `OPENAI_API_KEY` and `ANSTEEL_TL_API_KEY`, including mixed case and quoted values, are redacted in messages, nested data, and artifacts. Public role updates remain project data in the separate collaboration ledger. Logs keep only the structured result, correlation metadata, output length, reason code, and redacted evidence needed to diagnose the run.

本阶段已实现黄色/红色动作的动态执行前阻断。成功的自动恢复会写入公共审计事件；成功的历史运行索引重建会写入可由 `trace` 查询的协调器审计事实。只有恢复或索引重建成功才记录对应成功事实；活跃宿主、锁冲突、损坏日志链或其他失败不会伪造成功事件。这些门禁证明的是动作绑定、确认顺序和可追溯执行边界，不是最终交付正确性证明；持续协作后的最终双独立验收仍然保留。当前也没有完成真实三提供商探针验证。

### 三轴状态（只读投影）

`/ansteel-team status --explain` 和 `board` 都会从已校验的持久团队事实显示 `collaborationStatus`、`governanceStatus`、`deliveryStatus` 与派生的 `workflowStatus`，并附上机械原因。它们不是角色可直接写入的状态字段。公开协作更新、当前 revision 的最终独立评审、过程问题、角色失败和非绿色动作会签分别影响协作或治理轴；`approved` 只表示治理要求已经满足，不能替代交付证据。

当前运行时还没有受信任、可重放的交付验证记录，因此 `deliveryStatus` 会明确保持 `not-started`。任务或里程碑批准、黄色/红色动作会签、Git 提交以及 GitHub Actions 的文本均不能把它升级为 `passed`。只有未来引入经校验的交付证据记录后，`workflowStatus` 才可能同时满足协作完成、治理完成和交付通过而成为 `completed`；本投影不改变现有任务依赖释放语义。

## Interactive change gate

Interactive roles use ordinary project tools, but code changes are governed by the coordinator task entry and role-specific task tools:

1. The coordinator is the only task-creation entry. `/ansteel-team task <JSON>` registers one task through the shared task validator and records a `task-assigned` event whose actor is `coordinator` and whose target is the configured owner. Interactive roles are not given `ansteel_claim_task`, cannot create or rename tasks, and cannot race the coordinator by claiming a different file set. The coordinator cannot publish role reports, reviews, or sign-offs and is not a fourth governance role. Each dependency must already exist, cannot reference itself, and the coordinator rejects any dependency cycle.
2. A task with unmet predecessors is coordinator-derived as `blocked`; no role can write its files or assert that it has been unlocked. It becomes `claimed` only after every predecessor has received both peer approvals. Only then can its owner use `edit` or `write` on those exact files. All other paths, all other roles, and a submitted task are blocked. Direct `bash` is inspection-only; it cannot be used to bypass the file gate.
3. The owner calls `ansteel_submit_change` with one supported test/check command. Pi runs it, records the actual stdout/stderr and exit result, captures the Git diff for exactly the claimed files, and freezes that evidence package. The task is now `submitted`, which means it is open for public collaboration rather than already approved for final review.
4. Tech Lead and QA, or the two roles other than the owner, receive the same frozen test output and diff as continuous collaborators. Each must call `ansteel_publish_task_collaboration` with a public summary, evidence references, and remaining uncertainties. A blocking or critical process issue raised against the submitted task returns it to its owner before final verification.
5. After exactly one public collaboration update from each non-owner, the coordinator rechecks the frozen diff. Drift returns the task to its owner. Otherwise the coordinator changes the task to `final-verification` and sends the same immutable evidence package to both non-owners independently. Their current final-review replies are not shown to each other. Each must call `ansteel_review_task` with `approve` or `reject`; a rejection requires a concrete issue.
6. Both final peer approvals mark the task `approved`. Any final rejection returns it to `revision-required`; the owner must change it, run a new test, and submit a new diff. QA has the same immediate return authority and cannot be bypassed.

`/ansteel-team task TASK-ID` resumes an existing non-approved task without creating a duplicate. A coordinator task runs through isolated owner epochs. `teamTaskMaxEpochs` controls the maximum owner epochs (`1..128`, default `8`), while `teamTaskMaxNoProgressEpochs` controls consecutive epochs without governed progress (`1..8`, default `2`, and never greater than the maximum epoch count). Governed progress means a change to task status or revision, recorded test/submission/review counts, or the SHA-256 of the exact claimed-file Git diff. Reading files, repeating tools, producing prose, or extending wall-clock time is not progress.

Interactive role sessions also enforce the existing `maxToolCallsPerStage` setting as a per-prompt read-only tool budget (default `4`). The counter resets for every isolated stage or owner epoch. `read`, `grep`, `find`, `ls`, and valid inspection-only `bash` calls consume it; governed `edit`, `write`, and Ansteel task tools do not. When the budget is exhausted, further scanning is blocked and an authorized owner must leave a governed implementation checkpoint or return a concise blocker. This prevents a long task from spending every epoch rereading the same repository until provider output truncation.

An assistant completion with `stopReason: length`, a provider error, or no nonempty public text is a role-stage failure and is never recorded as a successful empty `role-report`. A truncated owner epoch may continue only when its governed progress fingerprint changed. Otherwise the task stops with `owner-no-progress`; reaching the configured epoch ceiling stops with `task-epoch-limit`. These stops preserve the task, diff, evidence, and append-only session so an operator can inspect the cause and explicitly resume. They never manufacture task approval.

Task approval is not a project-delivery claim. Tech Lead may register `MILESTONE-...` through `ansteel_plan_milestone` with the exact approved task set and a cross-task acceptance condition. Until every listed task is approved, the milestone is coordinator-derived as `blocked`. Tech Lead then uses `ansteel_submit_integration` to run one real bounded integration command and freeze its output. Staff Engineer and QA Engineer must first publish independent public integration collaboration updates with `ansteel_publish_integration_collaboration`. Once both exist, the frozen integration evidence is successful, and the required task state remains valid, the coordinator enters `final-verification` and sends the immutable integration evidence to both roles for `ansteel_review_integration`. Both final approvals are required for the milestone to become `approved`, while either final rejection returns it to `revision-required` for a new integration run. No role can turn a task-only approval into a milestone approval by prose.

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
	"teamTaskOwners": ["tech-lead", "staff-engineer", "qa-engineer"],
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

`teamTaskOwners` controls which interactive roles may claim code-change tasks. It defaults to `["staff-engineer"]`; enable typed three-role batches explicitly with `["tech-lead", "staff-engineer", "qa-engineer"]`. The selected policy is written into the team state when the team starts; a changed policy rejects a resume rather than silently changing an existing team's authority. Task type defaults and cross-role `assignmentReason` checks apply in addition to this allowlist. Both non-owners publish public collaboration updates for every submitted task, then independently final-review the same immutable revision.

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
