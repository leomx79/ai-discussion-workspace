import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ANSTEEL_PROTOCOL_RUNTIME_EVENT_NAMES,
	ANSTEEL_RUNTIME_EVENT_CATALOG,
	ANSTEEL_RUNTIME_EVENT_CATALOG_VERSION,
	ANSTEEL_RUNTIME_REASON_CODES,
	abandonOrphanedAnsteelTeamRun,
	auditAnsteelRuntimeArtifacts,
	createAnsteelResumedRunContext,
	createAnsteelRunContext,
	createAnsteelRuntimeEnvironmentFingerprint,
	createAnsteelRuntimeLogger,
	createAnsteelTeamIncidentBundle,
	diagnoseAnsteelTeamRun,
	formatAnsteelTeamDiagnosis,
	getAnsteelRuntimeLogDirectory,
	inspectAndRedactAnsteelSensitiveText,
	inspectAndRedactAnsteelSensitiveValue,
	isAnsteelRuntimeEventCombination,
	isAnsteelRuntimeReasonCode,
	listAnsteelRuntimeRuns,
	readAnsteelRuntimeLogs,
	traceAnsteelTeamRuntime,
	verifyAnsteelRuntimeLogIntegrity,
} from "../src/core/ansteel-team-observability.ts";

const temporaryProjects: string[] = [];

function createTemporaryProject(): string {
	const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-observability-"));
	temporaryProjects.push(cwd);
	return cwd;
}

function getRuntimeRunLockPaths(cwd: string, runId: string): { lockDirectoryPath: string; ownerPath: string } {
	const logPath = join(getAnsteelRuntimeLogDirectory(cwd), `run-${runId}-0001.jsonl`);
	return {
		lockDirectoryPath: `${logPath}.lock`,
		ownerPath: `${logPath}.lock-owner.json`,
	};
}

async function waitForChildStdout(child: ReturnType<typeof spawn>, expected: string): Promise<void> {
	await new Promise<void>((resolvePromise, reject) => {
		let output = "";
		const onData = (chunk: Buffer): void => {
			output += chunk.toString("utf8");
			if (!output.includes(expected)) return;
			child.stdout?.off("data", onData);
			resolvePromise();
		};
		child.stdout?.on("data", onData);
		child.once("error", reject);
		child.once("exit", (code) => {
			if (!output.includes(expected)) reject(new Error(`Lock-holder child exited early with code ${code}`));
		});
	});
}

async function createExitedProcessId(): Promise<number> {
	const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	const pid = child.pid;
	if (pid === undefined) throw new Error("Unable to start the dead-owner PID fixture");
	await new Promise<void>((resolvePromise, reject) => {
		child.once("error", reject);
		child.once("exit", () => resolvePromise());
	});
	return pid;
}

afterEach(() => {
	vi.useRealTimers();
	for (const cwd of temporaryProjects.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe("Ansteel team observability", () => {
	it("waits for short cross-process index audit-gate contention without leaking the gate", async () => {
		const cwd = createTemporaryProject();
		const runtimeDirectory = join(cwd, ".pi", "ansteel-team");
		mkdirSync(runtimeDirectory, { recursive: true });
		const gatePath = join(runtimeDirectory, "run-index.json.lease-audit-gate");
		const holderScript = [
			'const lockfile = require("proper-lockfile");',
			"const release = lockfile.lockSync(process.argv[1], { realpath: false, stale: 30000, update: 5000 });",
			'process.stdout.write("LOCKED\\n");',
			"setTimeout(() => { release(); process.exit(0); }, 150);",
		].join("\n");
		const holder = spawn(process.execPath, ["-e", holderScript, gatePath], {
			cwd: join(import.meta.dirname, ".."),
			stdio: ["ignore", "pipe", "pipe"],
		});
		const holderExit = new Promise<void>((resolvePromise, reject) => {
			holder.once("error", reject);
			holder.once("exit", (code) =>
				code === 0 ? resolvePromise() : reject(new Error(`Lock holder exited ${code}`)),
			);
		});
		await waitForChildStdout(holder, "LOCKED");

		// 子进程独立持有审计门时，当前进程的同步索引读取必须等待它正常释放；不能把一次
		// 可恢复的跨进程提交窗口误报成 event-fsync-failed，也不能在成功后遗留门目录。
		expect(listAnsteelRuntimeRuns(cwd)).toEqual([]);
		await holderExit;
		expect(existsSync(`${gatePath}.lock`)).toBe(false);
		expect(existsSync(`${gatePath}.lock-owner.json`)).toBe(false);
		expect(listAnsteelRuntimeRuns(cwd)).toEqual([]);
	});

	it("recovers an index audit gate only after its recorded owner process is killed", async () => {
		const cwd = createTemporaryProject();
		const runtimeDirectory = join(cwd, ".pi", "ansteel-team");
		mkdirSync(runtimeDirectory, { recursive: true });
		const gatePath = join(runtimeDirectory, "run-index.json.lease-audit-gate");
		const holderScript = [
			'const fs = require("node:fs");',
			'const lockfile = require("proper-lockfile");',
			"const gatePath = process.argv[1];",
			"lockfile.lockSync(gatePath, { realpath: false, stale: 30000, update: 5000 });",
			"const now = new Date().toISOString();",
			'const hash = "0".repeat(64);',
			'const owner = { schemaVersion: 1, ownerId: "dead-audit-gate-" + process.pid, pid: process.pid, processStartedAtUtc: now, executableHash: hash, commandHash: hash, workingDirectoryHash: hash, lockKind: "audit-gate", acquiredAtUtc: now };',
			'fs.writeFileSync(gatePath + ".lock-owner.json", JSON.stringify(owner) + "\\n", "utf8");',
			'process.stdout.write("LOCKED\\n");',
			"setInterval(() => {}, 1000);",
		].join("\n");
		const holder = spawn(process.execPath, ["-e", holderScript, gatePath], {
			cwd: join(import.meta.dirname, ".."),
			stdio: ["ignore", "pipe", "pipe"],
		});
		await waitForChildStdout(holder, "LOCKED");
		const holderExit = new Promise<void>((resolvePromise) => holder.once("exit", () => resolvePromise()));
		expect(holder.kill("SIGKILL")).toBe(true);
		await holderExit;

		// 只有子进程已经由操作系统确认退出，且 owner sidecar 结构完整时，读取方才可提前
		// 回收 30 秒 stale 周期内的空门目录。成功接管后 lock 与 owner 两个私有文件都必须消失。
		expect(listAnsteelRuntimeRuns(cwd)).toEqual([]);
		expect(existsSync(`${gatePath}.lock`)).toBe(false);
		expect(existsSync(`${gatePath}.lock-owner.json`)).toBe(false);
	});

	it("defines all protocol events in one versioned event and outcome catalog", () => {
		expect(ANSTEEL_RUNTIME_EVENT_CATALOG_VERSION).toBe(1);
		expect(ANSTEEL_PROTOCOL_RUNTIME_EVENT_NAMES).toHaveLength(37);
		expect(new Set(ANSTEEL_PROTOCOL_RUNTIME_EVENT_NAMES).size).toBe(37);
		for (const eventName of ANSTEEL_PROTOCOL_RUNTIME_EVENT_NAMES) {
			const outcomes = ANSTEEL_RUNTIME_EVENT_CATALOG[eventName];
			expect(outcomes.length, eventName).toBeGreaterThan(0);
			for (const outcome of outcomes) expect(isAnsteelRuntimeEventCombination(eventName, outcome)).toBe(true);
		}
		expect(isAnsteelRuntimeEventCombination("provider.request.completed", "started")).toBe(false);
		expect(isAnsteelRuntimeEventCombination("invented.runtime.event", "succeeded")).toBe(false);
		expect(isAnsteelRuntimeEventCombination("runtime-index-rebuilt", "abandoned")).toBe(true);
	});

	it("rejects unknown versioned events and invalid event-outcome combinations before writing", () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-catalog-writer", command: "status" });
		const logger = createAnsteelRuntimeLogger(cwd, context);
		try {
			expect(() =>
				logger.write({
					level: "info",
					eventName: "invented.runtime.event",
					outcome: "succeeded",
					message: "must not persist",
					data: {},
				}),
			).toThrow("event catalog rejects");
			expect(() =>
				logger.write({
					level: "info",
					eventName: "provider.request.completed",
					outcome: "started",
					message: "invalid lifecycle combination",
					data: {},
				}),
			).toThrow("event catalog rejects");
			expect(readAnsteelRuntimeLogs(cwd, context.runId)).toEqual([]);
		} finally {
			logger.close();
		}
	});

	it("rejects catalog-invalid persisted entries while preserving pre-catalog schema-v1 compatibility", () => {
		const versionedCwd = createTemporaryProject();
		const versionedContext = createAnsteelRunContext({ teamId: "team-catalog-reader", command: "status" });
		const versionedLogger = createAnsteelRuntimeLogger(versionedCwd, versionedContext);
		versionedLogger.write({
			level: "audit",
			eventName: "state.persisted",
			outcome: "succeeded",
			message: "valid versioned entry",
			data: {},
		});
		versionedLogger.close();
		const versionedPath = join(
			getAnsteelRuntimeLogDirectory(versionedCwd),
			`run-${versionedContext.runId}-0001.jsonl`,
		);
		const tampered = JSON.parse(readFileSync(versionedPath, "utf8")) as Record<string, unknown>;
		tampered.eventCatalogVersion = 999;
		writeFileSync(versionedPath, `${JSON.stringify(tampered)}\n`, "utf8");
		expect(() => readAnsteelRuntimeLogs(versionedCwd, versionedContext.runId)).toThrow("is unsupported");
		tampered.eventCatalogVersion = ANSTEEL_RUNTIME_EVENT_CATALOG_VERSION;
		tampered.eventName = "invented.persisted.event";
		writeFileSync(versionedPath, `${JSON.stringify(tampered)}\n`, "utf8");
		expect(() => readAnsteelRuntimeLogs(versionedCwd, versionedContext.runId)).toThrow("event catalog rejects");

		const legacyCwd = createTemporaryProject();
		const legacyContext = createAnsteelRunContext({ teamId: "team-legacy-runtime", command: "legacy" });
		const legacyUnsigned = {
			schemaVersion: 1 as const,
			timestampUtc: "2026-07-29T00:00:00.000Z",
			monotonicElapsedNs: "0",
			sequence: 1,
			level: "info" as const,
			eventName: "legacy.pre-catalog.event",
			outcome: "succeeded" as const,
			runId: legacyContext.runId,
			traceId: legacyContext.traceId,
			spanId: "0000000000000001",
			teamId: legacyContext.teamId,
			message: "legacy entry remains readable",
			data: {},
			artifactRefs: [],
			previousHash: null,
		};
		const legacyEntry = {
			...legacyUnsigned,
			hash: createHash("sha256").update(JSON.stringify(legacyUnsigned), "utf8").digest("hex"),
		};
		const legacyDirectory = getAnsteelRuntimeLogDirectory(legacyCwd);
		mkdirSync(legacyDirectory, { recursive: true });
		writeFileSync(
			join(legacyDirectory, `run-${legacyContext.runId}-0001.jsonl`),
			`${JSON.stringify(legacyEntry)}\n`,
			"utf8",
		);
		expect(readAnsteelRuntimeLogs(legacyCwd, legacyContext.runId)).toEqual([legacyEntry]);
	});

	it("creates stable run and trace identifiers and rejects unknown reason codes", () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({
			teamId: "ansteel-team-test",
			command: "status --explain",
			now: new Date("2026-07-29T00:00:00.000Z"),
		});

		expect(cwd).toBeTruthy();
		expect(context.runId).toMatch(/^RUN-/);
		expect(context.traceId).toMatch(/^[0-9a-f]{32}$/);
		expect(context.startedAt).toBe("2026-07-29T00:00:00.000Z");
		expect(isAnsteelRuntimeReasonCode("provider-timeout")).toBe(true);
		expect(isAnsteelRuntimeReasonCode("made-up-reason")).toBe(false);
		expect(ANSTEEL_RUNTIME_REASON_CODES).toContain("unclassified-runtime-error");
	});

	it("keeps recovery on the latest operational trace and skips diagnostic commands", async () => {
		const cwd = createTemporaryProject();
		const operational = createAnsteelRunContext({ teamId: "team-resume", command: "task TASK-RESUME" });
		const operationalLogger = createAnsteelRuntimeLogger(cwd, operational);
		const operationalRoot = operationalLogger.startSpan("run.started", {
			role: "coordinator",
			data: { command: operational.command },
		});
		operationalRoot.end({ outcome: "failed", reasonCode: "coordinator-restarted", message: "host stopped" });
		await operationalLogger.forceFlush();
		operationalLogger.close();
		const unrelated = createAnsteelRunContext({ teamId: "team-resume", command: "task TASK-OTHER" });
		const unrelatedLogger = createAnsteelRuntimeLogger(cwd, unrelated);
		unrelatedLogger.write({
			level: "info",
			eventName: "task.progress",
			outcome: "progress",
			taskId: "TASK-OTHER",
			message: "unrelated task progressed",
			data: { command: unrelated.command },
		});
		unrelatedLogger.close();

		const diagnostic = createAnsteelRunContext({ teamId: "team-resume", command: "status --explain" });
		const diagnosticLogger = createAnsteelRuntimeLogger(cwd, diagnostic);
		diagnosticLogger.write({
			level: "info",
			eventName: "state.persisted",
			outcome: "succeeded",
			message: "status inspected",
			data: { command: diagnostic.command },
		});
		diagnosticLogger.close();

		const resumed = createAnsteelResumedRunContext(cwd, {
			teamId: "team-resume",
			command: "task TASK-RESUME",
			taskId: "TASK-RESUME",
		});
		expect(resumed.runId).not.toBe(operational.runId);
		expect(resumed.traceId).toBe(operational.traceId);
		expect(resumed.traceId).not.toBe(diagnostic.traceId);
		expect(resumed.resumedFromRunId).toBe(operational.runId);
		expect(resumed.resumedFromSequence).toBe(2);

		const resumedLogger = createAnsteelRuntimeLogger(cwd, resumed);
		resumedLogger.startSpan("run.started", { role: "coordinator", data: { command: resumed.command } });
		await resumedLogger.forceFlush();
		resumedLogger.close();
		const resumedStart = readAnsteelRuntimeLogs(cwd, resumed.runId)[0]!;
		expect(resumedStart.data).toMatchObject({
			resumedFromRunId: operational.runId,
			resumedFromSequence: 2,
		});
		expect(traceAnsteelTeamRuntime(cwd, operational.traceId).map((entry) => entry.runId)).toEqual([
			operational.runId,
			operational.runId,
			resumed.runId,
			resumed.runId,
		]);
		expect(readAnsteelRuntimeLogs(cwd, resumed.runId)[1]).toMatchObject({
			eventName: "run.resumed",
			outcome: "progress",
		});
	});

	it("resumes an audited run from its explicit root command instead of assuming the root is the first event", () => {
		const cwd = createTemporaryProject();
		const operational = createAnsteelRunContext({ teamId: "team-audited-resume", command: "task TASK-AUDITED" });
		const logger = createAnsteelRuntimeLogger(cwd, operational, { auditRunLease: true });
		const root = logger.startSpan("run.started", {
			role: "coordinator",
			data: { command: operational.command },
		});
		root.end({ outcome: "failed", reasonCode: "coordinator-restarted", message: "host stopped" });
		logger.close();

		const entries = readAnsteelRuntimeLogs(cwd, operational.runId);
		expect(entries.map((entry) => entry.eventName)).toEqual([
			"lease.acquired",
			"run.started",
			"run.failed",
			"lease.released",
		]);
		const resumed = createAnsteelResumedRunContext(cwd, {
			teamId: operational.teamId,
			command: operational.command,
			taskId: "TASK-AUDITED",
		});
		expect(resumed).toMatchObject({
			traceId: operational.traceId,
			resumedFromRunId: operational.runId,
			resumedFromSequence: 4,
		});
	});

	it("records a complete environment fingerprint without key or environment values", async () => {
		const firstCwd = createTemporaryProject();
		const secondCwd = createTemporaryProject();
		for (const [cwd, secret] of [
			[firstCwd, "first-config-secret"],
			[secondCwd, "second-config-secret"],
		] as const) {
			mkdirSync(join(cwd, ".pi"), { recursive: true });
			writeFileSync(
				join(cwd, ".pi", "ansteel.json"),
				JSON.stringify({
					apiKey: secret,
					allowProviderFallback: true,
					allowSingleModel: false,
					teamTaskMaxEpochs: 8,
					teamTaskOwners: ["staff-engineer"],
				}),
				"utf8",
			);
		}
		const previousKey = process.env.ANSTEEL_TL_API_KEY;
		process.env.ANSTEEL_TL_API_KEY = "environment-secret-value";
		try {
			const firstFingerprint = createAnsteelRuntimeEnvironmentFingerprint(firstCwd);
			const secondFingerprint = createAnsteelRuntimeEnvironmentFingerprint(secondCwd);
			expect(firstFingerprint.configFingerprint).toBe(secondFingerprint.configFingerprint);
			expect(firstFingerprint.enabledEnvironmentVariables).toContain("ANSTEEL_TL_API_KEY");
			process.env.ANSTEEL_TL_API_KEY = "changed-environment-secret-value";
			expect(createAnsteelRuntimeEnvironmentFingerprint(firstCwd).environmentFingerprint).toBe(
				firstFingerprint.environmentFingerprint,
			);
			expect(firstFingerprint).toMatchObject({
				productVersion: expect.any(String),
				extensionVersion: expect.any(String),
				gitCommit: null,
				configStatus: "parsed",
				featureFlags: {
					allowProviderFallback: true,
					allowSingleModel: false,
					teamTaskMaxEpochs: 8,
					teamTaskOwners: ["staff-engineer"],
				},
				nodeVersion: expect.any(String),
				osPlatform: expect.any(String),
				osRelease: expect.any(String),
				architecture: expect.any(String),
				projectRootId: expect.stringMatching(/^[0-9a-f]{64}$/),
				environmentFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
			});

			const context = createAnsteelRunContext({ teamId: "team-environment", command: "start topic" });
			const logger = createAnsteelRuntimeLogger(firstCwd, context);
			logger.startSpan("run.started", { role: "coordinator", data: { command: context.command } });
			await logger.forceFlush();
			logger.close();
			const persisted = JSON.stringify(readAnsteelRuntimeLogs(firstCwd, context.runId));
			expect(persisted).not.toContain("first-config-secret");
			expect(persisted).not.toContain("environment-secret-value");
			expect(persisted).not.toContain("changed-environment-secret-value");
			expect(JSON.parse(persisted)[0].data.runtimeEnvironment).toMatchObject(firstFingerprint);
		} finally {
			if (previousKey === undefined) delete process.env.ANSTEEL_TL_API_KEY;
			else process.env.ANSTEEL_TL_API_KEY = previousKey;
		}
	});

	it("redacts secrets, stores large output by hash, and writes structured JSONL", () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-1", command: "task TASK-1" });
		const logger = createAnsteelRuntimeLogger(cwd, context);

		const entry = logger.write({
			level: "error",
			eventName: "tool.call.completed",
			outcome: "failed",
			reasonCode: "tool-exit-nonzero",
			message: `command failed OPENAI_API_KEY="message secret"; provider_access_token='second secret'; API_KEY=bare-api-secret`,
			data: {
				authorization: "Bearer top-secret",
				environment: `PASSWORD='bare password'; TOKEN="bare token"`,
				exitCode: 1,
			},
			artifacts: [
				{
					kind: "stderr",
					content:
						'ANSTEEL_TL_API_KEY=artifact-secret, SECRET=bare-secret;\napi_key: colon-secret; authorization: Basic scheme-secret; {"access_token":"json-secret"}\nfailure',
				},
			],
		});
		logger.close();

		expect(entry.data.authorization).toBe("[REDACTED]");
		expect(entry.message).toContain("OPENAI_API_KEY=[REDACTED]");
		expect(entry.message).toContain("provider_access_token=[REDACTED]");
		expect(entry.message).toContain("API_KEY=[REDACTED]");
		expect(entry.message).not.toContain("message secret");
		expect(entry.message).not.toContain("second secret");
		expect(entry.message).not.toContain("bare-api-secret");
		expect(entry.data.environment).toBe("PASSWORD=[REDACTED]; TOKEN=[REDACTED]");
		expect(entry.artifactRefs[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
		const artifact = readFileSync(entry.artifactRefs[0]!.storageId, "utf8");
		expect(artifact).toContain("ANSTEEL_TL_API_KEY=[REDACTED]");
		expect(artifact).toContain("SECRET=[REDACTED]");
		expect(artifact).toContain("api_key: [REDACTED]");
		expect(artifact).toContain("authorization: [REDACTED]");
		expect(artifact).toContain('"access_token":[REDACTED]');
		expect(artifact).not.toContain("artifact-secret");
		expect(artifact).not.toContain("bare-secret");
		expect(artifact).not.toContain("colon-secret");
		expect(artifact).not.toContain("scheme-secret");
		expect(artifact).not.toContain("json-secret");
		const entries = readAnsteelRuntimeLogs(cwd, context.runId);
		expect(entries.map((item) => item.eventName)).toEqual([
			"tool.call.completed",
			"security.secret-detected",
			"security.redaction-applied",
			"artifact.stored",
		]);
		const secretDetected = entries[1];
		const redactionApplied = entries[2];
		expect(secretDetected).toMatchObject({
			outcome: "failed",
			reasonCode: "secret-detected",
			causeEventId: entry.hash,
			artifactRefs: [],
			data: {
				sourceEventName: "tool.call.completed",
				sourceSequence: entry.sequence,
				redactionBoundary: "runtime-persistence",
				surfaces: ["message", "data", "artifact"],
			},
		});
		expect(secretDetected?.data.findingCount).toBeGreaterThan(0);
		expect(redactionApplied).toMatchObject({
			outcome: "succeeded",
			causeEventId: entry.hash,
			artifactRefs: [],
			data: secretDetected?.data,
		});
		const persisted = JSON.stringify(entries);
		for (const secret of [
			"message secret",
			"second secret",
			"bare-api-secret",
			"top-secret",
			"bare password",
			"bare token",
			"artifact-secret",
			"json-secret",
		]) {
			expect(persisted).not.toContain(secret);
		}
		expect(listAnsteelRuntimeRuns(cwd)).toContainEqual(
			expect.objectContaining({ runId: context.runId, lastOutcome: "failed" }),
		);
		expect(existsSync(getAnsteelRuntimeLogDirectory(cwd))).toBe(true);
	});

	it("preserves token accounting without missing camel-case cloud credentials", () => {
		const text = inspectAndRedactAnsteelSensitiveText(
			"Authorization: [REDACTED]; API_KEY=[REDACTED]; Bearer [REDACTED]; sk-[REDACTED]",
		);
		const data = inspectAndRedactAnsteelSensitiveValue({
			inputTokens: 12,
			outputTokens: 4,
			maxTokens: 32,
			tokenCountsAvailable: true,
			apiKey: "[REDACTED]",
			awsSecretAccessKey: "cloud-secret",
			sessionToken: "session-secret",
		});
		expect(text.findingCount).toBe(0);
		expect(data.findingCount).toBe(2);
		expect(data.value).toMatchObject({
			inputTokens: 12,
			outputTokens: 4,
			maxTokens: 32,
			tokenCountsAvailable: true,
			apiKey: "[REDACTED]",
			awsSecretAccessKey: "[REDACTED]",
			sessionToken: "[REDACTED]",
		});

		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-redaction-idempotent", command: "status" });
		const logger = createAnsteelRuntimeLogger(cwd, context);
		logger.write({
			level: "info",
			eventName: "provider.request.completed",
			outcome: "succeeded",
			message: text.value,
			data: {
				inputTokens: 12,
				outputTokens: 4,
				maxTokens: 32,
				tokenCountsAvailable: true,
				apiKey: "[REDACTED]",
			},
		});
		logger.close();
		expect(readAnsteelRuntimeLogs(cwd, context.runId).map((entry) => entry.eventName)).toEqual([
			"provider.request.completed",
		]);
	});

	it("records stored and deduplicated verified artifacts without recursively attaching the artifact", () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-artifact-write", command: "task TASK-ARTIFACT" });
		const logger = createAnsteelRuntimeLogger(cwd, context);
		const first = logger.write({
			level: "error",
			eventName: "tool.call.completed",
			outcome: "failed",
			reasonCode: "tool-exit-nonzero",
			toolCallId: "TOOL-ARTIFACT-1",
			message: "first artifact write",
			data: {},
			artifacts: [{ kind: "stderr", content: "stable failure output" }],
		});
		const second = logger.write({
			level: "error",
			eventName: "tool.call.completed",
			outcome: "failed",
			reasonCode: "tool-exit-nonzero",
			toolCallId: "TOOL-ARTIFACT-2",
			message: "deduplicated artifact write",
			data: {},
			artifacts: [{ kind: "stderr", content: "stable failure output" }],
		});
		logger.close();

		const entries = readAnsteelRuntimeLogs(cwd, context.runId);
		expect(first.sequence).toBe(1);
		expect(second.sequence).toBe(3);
		expect(entries.map((entry) => entry.eventName)).toEqual([
			"tool.call.completed",
			"artifact.stored",
			"tool.call.completed",
			"artifact.verified",
		]);
		expect(entries[1]).toMatchObject({
			outcome: "succeeded",
			causeEventId: first.hash,
			toolCallId: first.toolCallId,
			artifactRefs: [],
			data: {
				artifactKind: "stderr",
				sha256: first.artifactRefs[0]!.sha256,
				storageResult: "created",
			},
		});
		expect(entries[3]).toMatchObject({
			outcome: "succeeded",
			causeEventId: second.hash,
			toolCallId: second.toolCallId,
			artifactRefs: [],
			data: {
				sha256: second.artifactRefs[0]!.sha256,
				storageResult: "deduplicated-and-verified",
			},
		});
	});

	it("rejects recursive artifact lifecycle attachments before creating any artifact file", () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-artifact-recursion", command: "doctor" });
		const logger = createAnsteelRuntimeLogger(cwd, context);
		expect(() =>
			logger.write({
				level: "audit",
				eventName: "artifact.stored",
				outcome: "succeeded",
				message: "recursive artifact must be rejected",
				data: {},
				artifacts: [{ kind: "recursive", content: "must not be stored" }],
			}),
		).toThrow("cannot recursively attach artifacts");
		expect(readAnsteelRuntimeLogs(cwd, context.runId)).toEqual([]);
		expect(existsSync(join(cwd, ".pi", "ansteel-team", "artifacts"))).toBe(false);
		logger.close();
	});

	it("rejects recursive or secret-bearing security events before any batch artifact I/O", () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-security-recursion", command: "doctor" });
		const logger = createAnsteelRuntimeLogger(cwd, context);
		expect(() =>
			logger.writeBatch([
				{
					level: "error",
					eventName: "tool.call.completed",
					outcome: "failed",
					reasonCode: "tool-exit-nonzero",
					message: "source",
					data: {},
					artifacts: [{ kind: "stderr", content: "must not be stored" }],
				},
				{
					level: "audit",
					eventName: "security.secret-detected",
					outcome: "failed",
					reasonCode: "secret-detected",
					message: "invalid recursive security event",
					data: { apiKey: "must-never-be-persisted" },
				},
			]),
		).toThrow("must already contain only non-sensitive metadata");
		expect(readAnsteelRuntimeLogs(cwd, context.runId)).toEqual([]);
		expect(existsSync(join(cwd, ".pi", "ansteel-team", "artifacts"))).toBe(false);
		expect(() =>
			logger.write({
				level: "audit",
				eventName: "security.redaction-applied",
				outcome: "succeeded",
				message: "invalid recursive artifact",
				data: {},
				artifacts: [{ kind: "recursive", content: "must not be stored" }],
			}),
		).toThrow("cannot recursively attach artifacts");
		logger.close();
	});

	it("derives access-denied only from a mechanical tool policy terminal fact", () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-access-denied", command: "task TASK-SECURITY" });
		const logger = createAnsteelRuntimeLogger(cwd, context);
		const denied = logger.write({
			level: "warn",
			eventName: "tool.call.completed",
			outcome: "failed",
			reasonCode: "tool-policy-denied",
			role: "staff-engineer",
			toolCallId: "TOOL-DENIED",
			message: "tool denied",
			data: { toolName: "read", denialBoundary: "evidence-boundary" },
		});
		logger.close();
		const entries = readAnsteelRuntimeLogs(cwd, context.runId);
		expect(entries).toHaveLength(2);
		expect(entries[1]).toMatchObject({
			eventName: "security.access-denied",
			outcome: "failed",
			reasonCode: "tool-policy-denied",
			role: "staff-engineer",
			toolCallId: "TOOL-DENIED",
			causeEventId: denied.hash,
			artifactRefs: [],
			data: {
				sourceEventName: "tool.call.completed",
				sourceSequence: denied.sequence,
				denialBoundary: "evidence-boundary",
			},
		});
	});

	it("persists the bounded read-only budget lifecycle without security derivation", () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-budget", command: "task TASK-BUDGET" });
		const logger = createAnsteelRuntimeLogger(cwd, context);
		logger.writeBatch([
			{
				level: "audit",
				eventName: "budget.reserved",
				outcome: "progress",
				role: "staff-engineer",
				message: "stage allowance reserved",
				data: { resourceKind: "read-only-tool-calls", used: 0, limit: 1, remaining: 1 },
			},
			{
				level: "audit",
				eventName: "budget.consumed",
				outcome: "progress",
				role: "staff-engineer",
				toolCallId: "TOOL-READ-1",
				message: "stage allowance consumed",
				data: { resourceKind: "read-only-tool-calls", toolName: "read", used: 1, limit: 1, remaining: 0 },
			},
			{
				level: "audit",
				eventName: "budget.exhausted",
				outcome: "failed",
				reasonCode: "budget-exhausted",
				role: "staff-engineer",
				toolCallId: "TOOL-READ-2",
				message: "stage allowance exhausted before execution",
				data: { resourceKind: "read-only-tool-calls", toolName: "read", used: 1, limit: 1, remaining: 0 },
			},
		]);
		logger.close();
		const entries = readAnsteelRuntimeLogs(cwd, context.runId);
		expect(entries.map((entry) => entry.eventName)).toEqual([
			"budget.reserved",
			"budget.consumed",
			"budget.exhausted",
		]);
		expect(entries.at(-1)).toMatchObject({
			outcome: "failed",
			reasonCode: "budget-exhausted",
			toolCallId: "TOOL-READ-2",
		});
		expect(entries.some((entry) => entry.eventName.startsWith("security."))).toBe(false);
	});

	it("audits verified, corrupted, and missing-run artifacts into a separate observed run", () => {
		const cwd = createTemporaryProject();
		const sourceContext = createAnsteelRunContext({ teamId: "team-artifact-audit", command: "task TASK-AUDIT" });
		const sourceLogger = createAnsteelRuntimeLogger(cwd, sourceContext);
		const source = sourceLogger.write({
			level: "error",
			eventName: "tool.call.completed",
			outcome: "failed",
			reasonCode: "tool-exit-nonzero",
			message: "source artifact",
			data: {},
			artifacts: [{ kind: "stderr", content: "artifact to verify" }],
		});
		sourceLogger.close();

		const verifiedContext = createAnsteelRunContext({ teamId: "team-artifact-audit", command: "doctor verified" });
		const verifiedLogger = createAnsteelRuntimeLogger(cwd, verifiedContext);
		expect(auditAnsteelRuntimeArtifacts(cwd, sourceContext.runId, verifiedLogger)).toEqual({
			verifiedCount: 1,
			missingCount: 0,
		});
		verifiedLogger.close();
		expect(readAnsteelRuntimeLogs(cwd, verifiedContext.runId)).toEqual([
			expect.objectContaining({
				eventName: "artifact.verified",
				outcome: "succeeded",
				causeEventId: source.hash,
				artifactRefs: [],
				data: expect.objectContaining({ sourceRunId: sourceContext.runId, sourceSequence: source.sequence }),
			}),
		]);

		writeFileSync(source.artifactRefs[0]!.storageId, "tampered", "utf8");
		const missingContext = createAnsteelRunContext({ teamId: "team-artifact-audit", command: "doctor missing" });
		const missingLogger = createAnsteelRuntimeLogger(cwd, missingContext);
		expect(auditAnsteelRuntimeArtifacts(cwd, sourceContext.runId, missingLogger)).toEqual({
			verifiedCount: 0,
			missingCount: 1,
		});
		missingLogger.close();
		expect(readAnsteelRuntimeLogs(cwd, missingContext.runId)).toEqual([
			expect.objectContaining({
				eventName: "artifact.missing",
				outcome: "failed",
				reasonCode: "artifact-missing",
				causeEventId: source.hash,
				artifactRefs: [],
				data: expect.objectContaining({ verificationResult: "hash-mismatch" }),
			}),
		]);

		const absentRunId = "RUN-00000000-0000-4000-8000-000000000000";
		const absentContext = createAnsteelRunContext({ teamId: "team-artifact-audit", command: "doctor absent" });
		const absentLogger = createAnsteelRuntimeLogger(cwd, absentContext);
		expect(auditAnsteelRuntimeArtifacts(cwd, absentRunId, absentLogger)).toEqual({
			verifiedCount: 0,
			missingCount: 1,
		});
		absentLogger.close();
		expect(readAnsteelRuntimeLogs(cwd, absentContext.runId)).toEqual([
			expect.objectContaining({
				eventName: "artifact.missing",
				outcome: "failed",
				reasonCode: "artifact-missing",
				artifactRefs: [],
				data: { resourceKind: "runtime-log", sourceRunId: absentRunId, verificationResult: "missing" },
			}),
		]);
	});

	it("records a damaged target chain in an independent diagnostic run", () => {
		const cwd = createTemporaryProject();
		const sourceContext = createAnsteelRunContext({ teamId: "team-chain-audit", command: "task TASK-CHAIN" });
		const sourceLogger = createAnsteelRuntimeLogger(cwd, sourceContext);
		sourceLogger.write({
			level: "info",
			eventName: "state.persisted",
			outcome: "succeeded",
			message: "valid source before corruption",
			data: {},
		});
		sourceLogger.close();

		const sourcePath = join(getAnsteelRuntimeLogDirectory(cwd), `run-${sourceContext.runId}-0001.jsonl`);
		const sourceEntry = JSON.parse(readFileSync(sourcePath, "utf8")) as Record<string, unknown>;
		sourceEntry.message = "tampered after the source writer closed";
		writeFileSync(sourcePath, `${JSON.stringify(sourceEntry)}\n`, "utf8");
		const ordinaryContext = createAnsteelRunContext({ teamId: "team-chain-audit", command: "ordinary write" });
		const ordinaryLogger = createAnsteelRuntimeLogger(cwd, ordinaryContext);
		expect(() =>
			ordinaryLogger.write({
				level: "info",
				eventName: "state.persisted",
				outcome: "succeeded",
				message: "This normal write must remain fail-closed.",
				data: {},
			}),
		).toThrow("hash does not match");
		ordinaryLogger.close();
		expect(readAnsteelRuntimeLogs(cwd, ordinaryContext.runId)).toEqual([]);

		const diagnosticContext = createAnsteelRunContext({ teamId: "team-chain-audit", command: "doctor damaged" });
		const diagnosticLogger = createAnsteelRuntimeLogger(cwd, diagnosticContext, {
			allowUnindexedDiagnosticWrites: true,
		});

		expect(() => auditAnsteelRuntimeArtifacts(cwd, sourceContext.runId, diagnosticLogger)).toThrow(
			"hash does not match",
		);
		diagnosticLogger.close();
		expect(readAnsteelRuntimeLogs(cwd, diagnosticContext.runId)).toEqual([
			expect.objectContaining({
				eventName: "event.chain.invalid",
				outcome: "failed",
				reasonCode: "event-chain-invalid",
				role: "coordinator",
				artifactRefs: [],
				data: {
					resourceKind: "runtime-log-chain",
					sourceRunId: sourceContext.runId,
					verificationBoundary: "diagnostic-target-read",
				},
			}),
		]);
	});

	it("exports nested OpenTelemetry spans with the same trace and parent relationship", async () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-1", command: "ask" });
		const logger = createAnsteelRuntimeLogger(cwd, context);
		const root = logger.startSpan("run", { role: "coordinator" });
		const child = logger.startSpan("provider.request", { role: "tech-lead", parent: root });

		child.end({ outcome: "failed", reasonCode: "provider-timeout", message: "provider timed out" });
		root.end({ outcome: "failed", reasonCode: "provider-timeout", message: "run failed" });
		await logger.forceFlush();
		logger.close();

		const logs = readAnsteelRuntimeLogs(cwd, context.runId);
		expect(logs.map((entry) => [entry.eventName, entry.outcome])).toEqual([
			["run.started", "started"],
			["provider.request.started", "started"],
			["provider.request.completed", "failed"],
			["run.failed", "failed"],
		]);
		expect(logs.every((entry) => entry.eventCatalogVersion === ANSTEEL_RUNTIME_EVENT_CATALOG_VERSION)).toBe(true);
		const childEnd = logs.find(
			(entry) => entry.eventName === "provider.request.completed" && entry.outcome === "failed",
		);
		expect(childEnd?.traceId).toBe(context.traceId);
		expect(childEnd?.parentSpanId).toBe(root.spanId);
	});

	it("explains the first cause and returns non-healthy for a damaged artifact", () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-1", command: "task TASK-1" });
		const logger = createAnsteelRuntimeLogger(cwd, context);
		const failed = logger.write({
			level: "error",
			eventName: "tool.call.completed",
			outcome: "failed",
			reasonCode: "tool-exit-nonzero",
			message: "test failed",
			data: { exitCode: 1 },
			artifacts: [{ kind: "stderr", content: "assertion failed" }],
		});
		logger.close();
		writeFileSync(failed.artifactRefs[0]!.storageId, "tampered", "utf8");

		const diagnosis = diagnoseAnsteelTeamRun(cwd, context.runId);
		expect(diagnosis.healthy).toBe(false);
		expect(diagnosis.rootCause).toMatchObject({
			reasonCode: "tool-exit-nonzero",
			eventName: "tool.call.completed",
		});
		expect(diagnosis.issues).toContainEqual(expect.objectContaining({ reasonCode: "artifact-missing" }));
	});

	it("returns artifact-missing instead of healthy for a run without persisted logs", () => {
		const cwd = createTemporaryProject();
		const diagnosis = diagnoseAnsteelTeamRun(cwd, "RUN-00000000-0000-4000-8000-000000000000");

		expect(diagnosis.healthy).toBe(false);
		expect(diagnosis.entryCount).toBe(0);
		expect(diagnosis.issues.map((issue) => issue.reasonCode)).toEqual(["artifact-missing"]);
	});

	it("returns process-orphaned for a root run span without a terminal record", async () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-1", command: "start" });
		const logger = createAnsteelRuntimeLogger(cwd, context);
		logger.startSpan("run.started", { role: "coordinator" });
		await logger.forceFlush();
		logger.close();

		const diagnosis = diagnoseAnsteelTeamRun(cwd, context.runId);
		expect(diagnosis.healthy).toBe(false);
		expect(diagnosis.entryCount).toBe(1);
		expect(diagnosis.issues.map((issue) => issue.reasonCode)).toEqual(["process-orphaned"]);
	});

	it("returns process-orphaned when any root run span lacks a terminal record", async () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-1", command: "start" });
		const logger = createAnsteelRuntimeLogger(cwd, context);
		const completedRoot = logger.startSpan("run.started", { role: "coordinator" });
		completedRoot.end({ outcome: "succeeded", message: "first command completed" });
		logger.startSpan("run.started", { role: "coordinator" });
		await logger.forceFlush();
		logger.close();

		const diagnosis = diagnoseAnsteelTeamRun(cwd, context.runId);
		expect(diagnosis.healthy).toBe(false);
		expect(diagnosis.issues.map((issue) => issue.reasonCode)).toEqual(["process-orphaned"]);
	});

	it("does not accept a root terminal record that precedes its matching start", () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-1", command: "start" });
		const logger = createAnsteelRuntimeLogger(cwd, context);
		const spanId = "0000000000000001";
		logger.write({
			level: "info",
			eventName: "run.completed",
			outcome: "succeeded",
			spanId,
			role: "coordinator",
			message: "forged early terminal",
			data: {},
		});
		logger.write({
			level: "info",
			eventName: "run.started",
			outcome: "started",
			spanId,
			role: "coordinator",
			message: "late start",
			data: {},
		});
		logger.close();

		const diagnosis = diagnoseAnsteelTeamRun(cwd, context.runId);
		expect(diagnosis.healthy).toBe(false);
		expect(diagnosis.issues.map((issue) => issue.reasonCode)).toEqual(["process-orphaned"]);
	});

	it("does not accept a non-root terminal record for a root run span", () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-1", command: "start" });
		const logger = createAnsteelRuntimeLogger(cwd, context);
		const root = logger.startSpan("run.started", { role: "coordinator" });
		logger.write({
			level: "info",
			eventName: "run.completed",
			outcome: "succeeded",
			spanId: root.spanId,
			parentSpanId: "forged-child-parent",
			role: "coordinator",
			message: "forged non-root terminal",
			data: {},
		});
		logger.close();

		const summary = listAnsteelRuntimeRuns(cwd).find((run) => run.runId === context.runId);
		expect(summary?.terminalOutcome).toBeUndefined();
		const diagnosis = diagnoseAnsteelTeamRun(cwd, context.runId);
		expect(diagnosis.healthy).toBe(false);
		expect(diagnosis.issues.map((issue) => issue.reasonCode)).toContain("process-orphaned");
	});

	it("returns process-orphaned when a child span lacks a terminal record", async () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-1", command: "start" });
		const logger = createAnsteelRuntimeLogger(cwd, context);
		const root = logger.startSpan("run.started", { role: "coordinator" });
		logger.startSpan("provider.request", {
			parent: root,
			role: "staff-engineer",
			providerRequestId: "PROVIDER-ORPHAN-1",
		});
		root.end({ outcome: "succeeded", message: "root command completed" });
		await logger.forceFlush();
		logger.close();

		const diagnosis = diagnoseAnsteelTeamRun(cwd, context.runId);
		expect(diagnosis.healthy).toBe(false);
		expect(diagnosis.issues).toContainEqual(
			expect.objectContaining({
				reasonCode: "process-orphaned",
				entrySequence: 2,
			}),
		);
	});

	it("does not abandon an orphaned span while its original logger still owns the run", async () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-1", command: "start" });
		const logger = createAnsteelRuntimeLogger(cwd, context);
		logger.startSpan("run.started", { role: "coordinator" });
		await logger.forceFlush();

		await expect(abandonOrphanedAnsteelTeamRun(cwd, context.runId)).rejects.toMatchObject({
			reasonCode: "lease-owner-mismatch",
		});
		expect(readAnsteelRuntimeLogs(cwd, context.runId).map((entry) => entry.outcome)).toEqual(["started"]);

		logger.close();
	});

	it("rejects a second concurrent writer for the same runtime run", () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-1", command: "start" });
		const first = createAnsteelRuntimeLogger(cwd, context);
		const { ownerPath } = getRuntimeRunLockPaths(cwd, context.runId);
		const originalOwner = readFileSync(ownerPath, "utf8");

		expect(() => createAnsteelRuntimeLogger(cwd, context)).toThrow(
			expect.objectContaining({ reasonCode: "lease-owner-mismatch" }),
		);
		expect(readFileSync(ownerPath, "utf8")).toBe(originalOwner);

		first.close();
	});

	it("records one truthful acquired and released receipt for an audited runtime writer lease", () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-run-lease", command: "status" });
		const logger = createAnsteelRuntimeLogger(cwd, context, { auditRunLease: true });
		const { lockDirectoryPath, ownerPath } = getRuntimeRunLockPaths(cwd, context.runId);
		const acquired = readAnsteelRuntimeLogs(cwd, context.runId);
		expect(acquired).toHaveLength(1);
		expect(acquired[0]).toMatchObject({
			eventName: "lease.acquired",
			outcome: "succeeded",
			role: "coordinator",
			leaseId: expect.any(String),
			data: {
				resourceKind: "runtime-run",
				resourceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
				ownerPid: process.pid,
				staleAfterMs: 300_000,
				renewEveryMs: 10_000,
			},
		});
		expect(existsSync(lockDirectoryPath)).toBe(true);
		expect(existsSync(ownerPath)).toBe(true);

		logger.close();

		const completed = readAnsteelRuntimeLogs(cwd, context.runId);
		expect(completed.map((entry) => [entry.eventName, entry.outcome])).toEqual([
			["lease.acquired", "succeeded"],
			["lease.released", "succeeded"],
		]);
		expect(completed[1]).toMatchObject({
			leaseId: completed[0]!.leaseId,
			data: { resourceKind: "runtime-run", renewalCount: 0 },
		});
		expect(existsSync(lockDirectoryPath)).toBe(false);
		expect(existsSync(ownerPath)).toBe(false);
		expect(traceAnsteelTeamRuntime(cwd, completed[0]!.leaseId!)).toHaveLength(2);
	});

	it("keeps a failed command outcome visible after its writer lease releases successfully", () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-run-lease-failed-command", command: "start" });
		const logger = createAnsteelRuntimeLogger(cwd, context, { auditRunLease: true });
		const root = logger.startSpan("run", { role: "coordinator", data: { command: context.command } });
		root.end({ outcome: "failed", reasonCode: "provider-timeout", message: "provider timed out" });
		logger.close();

		expect(readAnsteelRuntimeLogs(cwd, context.runId).at(-1)).toMatchObject({
			eventName: "lease.released",
			outcome: "succeeded",
		});
		expect(listAnsteelRuntimeRuns(cwd)).toContainEqual(
			expect.objectContaining({
				runId: context.runId,
				lastOutcome: "failed",
				terminalOutcome: "failed",
			}),
		);
	});

	it("records renewal only after the lock library successfully refreshes the owned directory", async () => {
		vi.useFakeTimers();
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-run-lease-renewal", command: "status" });
		const logger = createAnsteelRuntimeLogger(cwd, context, { auditRunLease: true });
		try {
			await vi.advanceTimersByTimeAsync(10_000);
			const renewed = readAnsteelRuntimeLogs(cwd, context.runId).filter(
				(entry) => entry.eventName === "lease.renewed",
			);
			expect(renewed).toHaveLength(1);
			expect(renewed[0]).toMatchObject({
				outcome: "progress",
				leaseId: readAnsteelRuntimeLogs(cwd, context.runId)[0]!.leaseId,
				data: { renewalCount: 1 },
			});
		} finally {
			logger.close();
		}
	});

	it("does not forge a released event when the owned lock directory cannot be removed", () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-run-lease-release-failure", command: "status" });
		const logger = createAnsteelRuntimeLogger(cwd, context, { auditRunLease: true });
		const { lockDirectoryPath, ownerPath } = getRuntimeRunLockPaths(cwd, context.runId);
		writeFileSync(join(lockDirectoryPath, "unexpected-entry"), "release must fail\n", "utf8");

		expect(() => logger.close()).toThrow();
		expect(readAnsteelRuntimeLogs(cwd, context.runId).map((entry) => entry.eventName)).toEqual(["lease.acquired"]);
		expect(existsSync(ownerPath)).toBe(true);
	});

	it("records an unconfirmed dead-owner lease as expired before the replacement lease", async () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-run-lease-recovery", command: "status" });
		const fixtureLogger = createAnsteelRuntimeLogger(cwd, context);
		const { lockDirectoryPath, ownerPath } = getRuntimeRunLockPaths(cwd, context.runId);
		const fixtureOwner = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
		fixtureLogger.close();

		const deadPid = await createExitedProcessId();
		const expiredLeaseId = "LEASE-DEAD-OWNER-FIXTURE";
		mkdirSync(lockDirectoryPath);
		writeFileSync(
			ownerPath,
			`${JSON.stringify({ ...fixtureOwner, ownerId: expiredLeaseId, pid: deadPid })}\n`,
			"utf8",
		);

		const recovered = createAnsteelRuntimeLogger(cwd, context, { auditRunLease: true });
		try {
			const entries = readAnsteelRuntimeLogs(cwd, context.runId);
			expect(entries.map((entry) => [entry.eventName, entry.outcome])).toEqual([
				["lease.expired", "failed"],
				["lease.acquired", "succeeded"],
			]);
			expect(entries[0]).toMatchObject({
				reasonCode: "lease-expired",
				leaseId: expiredLeaseId,
				data: { replacementLeaseId: entries[1]!.leaseId },
			});
		} finally {
			recovered.close();
		}
	});

	it("stores only hashed command and working-directory identity in the runtime lock owner", () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({
			teamId: "team-lock-owner-redaction",
			command: "start raw-command-must-not-enter-owner",
		});
		const previousKey = process.env.ANSTEEL_TL_API_KEY;
		process.env.ANSTEEL_TL_API_KEY = "lock-owner-api-secret";
		const logger = createAnsteelRuntimeLogger(cwd, context);
		try {
			const { ownerPath } = getRuntimeRunLockPaths(cwd, context.runId);
			const rawOwner = readFileSync(ownerPath, "utf8");
			const owner = JSON.parse(rawOwner) as Record<string, unknown>;
			expect(Object.keys(owner).sort()).toEqual([
				"acquiredAtUtc",
				"commandHash",
				"executableHash",
				"lockKind",
				"ownerId",
				"pid",
				"processStartedAtUtc",
				"schemaVersion",
				"workingDirectoryHash",
			]);
			expect(owner).toMatchObject({
				schemaVersion: 1,
				pid: process.pid,
				lockKind: "run",
				executableHash: expect.stringMatching(/^[0-9a-f]{64}$/),
				commandHash: expect.stringMatching(/^[0-9a-f]{64}$/),
				workingDirectoryHash: expect.stringMatching(/^[0-9a-f]{64}$/),
			});
			expect(rawOwner).not.toContain(context.command);
			expect(rawOwner).not.toContain(process.cwd());
			expect(rawOwner).not.toContain(cwd);
			expect(rawOwner).not.toContain("lock-owner-api-secret");
		} finally {
			logger.close();
			if (previousKey === undefined) delete process.env.ANSTEEL_TL_API_KEY;
			else process.env.ANSTEEL_TL_API_KEY = previousKey;
		}
	});

	it("refuses early takeover when a runtime lock owner is missing or malformed", () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-lock-owner-invalid", command: "start" });
		const first = createAnsteelRuntimeLogger(cwd, context);
		const { lockDirectoryPath, ownerPath } = getRuntimeRunLockPaths(cwd, context.runId);
		first.close();

		mkdirSync(lockDirectoryPath);
		expect(() => createAnsteelRuntimeLogger(cwd, context)).toThrow(
			expect.objectContaining({ reasonCode: "lease-owner-mismatch" }),
		);

		writeFileSync(ownerPath, '{"schemaVersion":1,"pid":"invalid"}\n', "utf8");
		expect(() => createAnsteelRuntimeLogger(cwd, context)).toThrow(
			expect.objectContaining({ reasonCode: "lease-owner-mismatch" }),
		);
	});

	it("recovers a runtime lock immediately when its valid owner PID has exited", async () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-lock-owner-dead", command: "start" });
		const first = createAnsteelRuntimeLogger(cwd, context);
		const { lockDirectoryPath, ownerPath } = getRuntimeRunLockPaths(cwd, context.runId);
		const originalOwner = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
		first.close();

		const deadPid = await createExitedProcessId();
		mkdirSync(lockDirectoryPath);
		writeFileSync(ownerPath, `${JSON.stringify({ ...originalOwner, pid: deadPid })}\n`, "utf8");

		const recovered = createAnsteelRuntimeLogger(cwd, context);
		try {
			const recoveredOwner = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
			expect(recoveredOwner).toMatchObject({ pid: process.pid, lockKind: "run" });
			expect(recoveredOwner.ownerId).not.toBe(originalOwner.ownerId);
		} finally {
			recovered.close();
		}
		expect(existsSync(lockDirectoryPath)).toBe(false);
		expect(existsSync(ownerPath)).toBe(false);
	});

	it("returns structured chain evidence for a recovery audit while preserving the original cause", async () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-1", command: "start" });
		const logger = createAnsteelRuntimeLogger(cwd, context);
		logger.startSpan("provider.request", {
			role: "staff-engineer",
			providerRequestId: "PROVIDER-ORPHAN-CAUSE-1",
			causeEventId: "EV-ORIGINAL-CAUSE",
		});
		await logger.forceFlush();
		logger.close();
		const start = readAnsteelRuntimeLogs(cwd, context.runId)[0]!;

		await expect(abandonOrphanedAnsteelTeamRun(cwd, context.runId)).resolves.toMatchObject({
			runId: context.runId,
			abandonedSpanCount: 1,
			previousHeadHash: start.hash,
			recoveredHeadHash: expect.stringMatching(/^[0-9a-f]{64}$/),
		});

		const abandoned = readAnsteelRuntimeLogs(cwd, context.runId).find(
			(entry) => entry.outcome === "abandoned" && entry.reasonCode === "process-orphaned",
		);
		expect(abandoned).toMatchObject({
			outcome: "abandoned",
			reasonCode: "process-orphaned",
			causeEventId: "EV-ORIGINAL-CAUSE",
			data: {
				recoveredFromSequence: start.sequence,
				recoveredFromEventHash: start.hash,
			},
		});
	});

	it("records orphan detection before abandoning an open governed process span", async () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-process-orphan", command: "task TASK-ORPHAN" });
		const logger = createAnsteelRuntimeLogger(cwd, context);
		logger.startSpan("process", {
			role: "staff-engineer",
			taskId: "TASK-ORPHAN",
			processId: "PROC-ORPHAN",
			data: { pid: 424242, policy: "task-test" },
		});
		logger.close();

		await expect(abandonOrphanedAnsteelTeamRun(cwd, context.runId)).resolves.toMatchObject({
			abandonedSpanCount: 1,
		});
		const entries = readAnsteelRuntimeLogs(cwd, context.runId);
		expect(entries.map((entry) => entry.eventName)).toEqual([
			"process.spawned",
			"lease.acquired",
			"process.orphan-detected",
			"process.exited",
			"lease.released",
		]);
		expect(entries[2]).toMatchObject({
			outcome: "abandoned",
			reasonCode: "process-orphaned",
			processId: "PROC-ORPHAN",
			data: { pid: 424242, recoveredFromSequence: 1 },
		});
		expect(entries[3]).toMatchObject({
			outcome: "abandoned",
			reasonCode: "process-orphaned",
			processId: "PROC-ORPHAN",
		});
	});

	it("persists a verifiable historical run index and locates every governed association after logger close", () => {
		const cwd = createTemporaryProject();
		const firstContext = createAnsteelRunContext({ teamId: "team-history", command: "task TASK-HISTORY-1" });
		const firstLogger = createAnsteelRuntimeLogger(cwd, firstContext);
		firstLogger.write({
			level: "info",
			eventName: "tool.call.completed",
			outcome: "succeeded",
			taskId: "TASK-HISTORY-1",
			checkpointId: "CP-HISTORY-1",
			issueId: "ISSUE-HISTORY-1",
			toolCallId: "TOOL-HISTORY-1",
			providerRequestId: "PROVIDER-HISTORY-1",
			processId: "PROCESS-HISTORY-1",
			leaseId: "LEASE-HISTORY-1",
			causeEventId: "EVENT-HISTORY-1",
			message: "first historical event",
			data: { stdout: "SECRET-STDOUT-MUST-NOT-ENTER-INDEX" },
		});
		firstLogger.close();

		const secondContext = createAnsteelRunContext({ teamId: "team-history", command: "task TASK-HISTORY-2" });
		const secondLogger = createAnsteelRuntimeLogger(cwd, secondContext);
		secondLogger.write({
			level: "info",
			eventName: "tool.call.completed",
			outcome: "succeeded",
			taskId: "TASK-HISTORY-2",
			issueId: "ISSUE-HISTORY-2",
			toolCallId: "TOOL-HISTORY-2",
			message: "second historical event",
			data: {},
		});
		secondLogger.close();

		const indexPath = join(cwd, ".pi", "ansteel-team", "run-index.json");
		expect(existsSync(indexPath)).toBe(true);
		const persistedIndex = readFileSync(indexPath, "utf8");
		expect(persistedIndex).not.toContain("SECRET-STDOUT-MUST-NOT-ENTER-INDEX");
		expect(persistedIndex).not.toContain("TASK-HISTORY-1");
		expect(persistedIndex).not.toContain("ISSUE-HISTORY-1");

		for (const selector of [
			firstContext.runId,
			firstContext.traceId,
			"TASK-HISTORY-1",
			"CP-HISTORY-1",
			"ISSUE-HISTORY-1",
			"TOOL-HISTORY-1",
			"PROVIDER-HISTORY-1",
			"PROCESS-HISTORY-1",
			"LEASE-HISTORY-1",
			"EVENT-HISTORY-1",
		]) {
			expect(traceAnsteelTeamRuntime(cwd, selector).map((entry) => entry.runId)).toEqual([firstContext.runId]);
		}
		expect(listAnsteelRuntimeRuns(cwd).map((run) => run.runId)).toEqual([firstContext.runId, secondContext.runId]);
	});

	it("mechanically rebuilds a deleted historical run index and leaves a queryable audit record", () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-history", command: "task TASK-REBUILD-1" });
		const logger = createAnsteelRuntimeLogger(cwd, context);
		logger.write({
			level: "info",
			eventName: "tool.call.completed",
			outcome: "succeeded",
			taskId: "TASK-REBUILD-1",
			message: "historical event before index deletion",
			data: {},
		});
		logger.close();
		const indexPath = join(cwd, ".pi", "ansteel-team", "run-index.json");
		rmSync(indexPath, { force: true });

		expect(traceAnsteelTeamRuntime(cwd, "TASK-REBUILD-1")).toHaveLength(1);
		expect(existsSync(indexPath)).toBe(true);
		const auditEntries = listAnsteelRuntimeRuns(cwd)
			.flatMap((run) => readAnsteelRuntimeLogs(cwd, run.runId))
			.filter((entry) => entry.eventName === "runtime-index-rebuilt");
		expect(auditEntries).toContainEqual(
			expect.objectContaining({
				level: "audit",
				outcome: "succeeded",
				role: "coordinator",
				data: expect.objectContaining({
					rebuildReason: "missing",
					rebuiltAt: expect.any(String),
				}),
			}),
		);
		expect(traceAnsteelTeamRuntime(cwd, "runtime-index-rebuilt")).toEqual(auditEntries);
	});

	it("mechanically rebuilds a tampered historical run index without losing selector mappings", () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-history", command: "task TASK-INDEX-TAMPER-1" });
		const logger = createAnsteelRuntimeLogger(cwd, context);
		logger.write({
			level: "info",
			eventName: "tool.call.completed",
			outcome: "succeeded",
			taskId: "TASK-INDEX-TAMPER-1",
			message: "historical event before index tampering",
			data: {},
		});
		logger.close();
		const indexPath = join(cwd, ".pi", "ansteel-team", "run-index.json");
		const index = JSON.parse(readFileSync(indexPath, "utf8")) as Record<string, unknown>;
		index.associations = {};
		writeFileSync(indexPath, `${JSON.stringify(index)}\n`, "utf8");

		expect(traceAnsteelTeamRuntime(cwd, "TASK-INDEX-TAMPER-1").map((entry) => entry.runId)).toEqual([context.runId]);
		const auditEntries = listAnsteelRuntimeRuns(cwd)
			.flatMap((run) => readAnsteelRuntimeLogs(cwd, run.runId))
			.filter((entry) => entry.eventName === "runtime-index-rebuilt");
		expect(auditEntries.at(-1)?.data).toMatchObject({
			rebuildReason: "hash-invalid",
			rebuiltAt: expect.any(String),
		});
	});

	it("serializes concurrent historical run index updates without an old snapshot dropping another run", () => {
		const cwd = createTemporaryProject();
		const firstContext = createAnsteelRunContext({ teamId: "team-history", command: "task TASK-CONCURRENT-1" });
		const secondContext = createAnsteelRunContext({ teamId: "team-history", command: "task TASK-CONCURRENT-2" });
		const firstLogger = createAnsteelRuntimeLogger(cwd, firstContext);
		const secondLogger = createAnsteelRuntimeLogger(cwd, secondContext);

		firstLogger.write({
			level: "info",
			eventName: "tool.call.completed",
			outcome: "succeeded",
			taskId: "TASK-CONCURRENT-1",
			message: "first interleaved write",
			data: {},
		});
		secondLogger.write({
			level: "info",
			eventName: "tool.call.completed",
			outcome: "succeeded",
			taskId: "TASK-CONCURRENT-2",
			message: "second interleaved write",
			data: {},
		});
		firstLogger.write({
			level: "info",
			eventName: "task.progress",
			outcome: "progress",
			issueId: "ISSUE-CONCURRENT-1",
			message: "first run continued",
			data: {},
		});
		secondLogger.write({
			level: "info",
			eventName: "task.progress",
			outcome: "progress",
			issueId: "ISSUE-CONCURRENT-2",
			message: "second run continued",
			data: {},
		});
		firstLogger.close();
		secondLogger.close();

		expect(traceAnsteelTeamRuntime(cwd, "TASK-CONCURRENT-1").map((entry) => entry.runId)).toEqual([
			firstContext.runId,
		]);
		expect(traceAnsteelTeamRuntime(cwd, "TASK-CONCURRENT-2").map((entry) => entry.runId)).toEqual([
			secondContext.runId,
		]);
		expect(traceAnsteelTeamRuntime(cwd, "ISSUE-CONCURRENT-1").map((entry) => entry.runId)).toEqual([
			firstContext.runId,
		]);
		expect(traceAnsteelTeamRuntime(cwd, "ISSUE-CONCURRENT-2").map((entry) => entry.runId)).toEqual([
			secondContext.runId,
		]);
	});

	it("rebuilds the historical run index across multiple durable log segments of the same run", () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-history", command: "task TASK-SEGMENTED-1" });
		const logger = createAnsteelRuntimeLogger(cwd, context);
		logger.write({
			level: "info",
			eventName: "task.started",
			outcome: "started",
			taskId: "TASK-SEGMENTED-1",
			message: "first durable segment record",
			data: {},
		});
		logger.write({
			level: "info",
			eventName: "task.progress",
			outcome: "progress",
			issueId: "ISSUE-SEGMENTED-1",
			message: "second durable segment record",
			data: {},
		});
		logger.close();

		const firstSegmentPath = join(getAnsteelRuntimeLogDirectory(cwd), `run-${context.runId}-0001.jsonl`);
		const secondSegmentPath = join(getAnsteelRuntimeLogDirectory(cwd), `run-${context.runId}-0002.jsonl`);
		const lines = readFileSync(firstSegmentPath, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		writeFileSync(firstSegmentPath, `${lines[0]}\n`, "utf8");
		writeFileSync(secondSegmentPath, `${lines[1]}\n`, "utf8");

		const resumedLogger = createAnsteelRuntimeLogger(cwd, context);
		resumedLogger.write({
			level: "info",
			eventName: "tool.call.completed",
			outcome: "succeeded",
			toolCallId: "TOOL-SEGMENTED-1",
			message: "continued in the last durable segment",
			data: {},
		});
		resumedLogger.close();

		expect(traceAnsteelTeamRuntime(cwd, "TASK-SEGMENTED-1").map((entry) => entry.sequence)).toEqual([1]);
		expect(traceAnsteelTeamRuntime(cwd, "ISSUE-SEGMENTED-1").map((entry) => entry.sequence)).toEqual([2]);
		expect(traceAnsteelTeamRuntime(cwd, "TOOL-SEGMENTED-1").map((entry) => entry.sequence)).toEqual([3]);
		expect(readFileSync(secondSegmentPath, "utf8").trim().split("\n")).toHaveLength(2);
		const persistedIndex = readFileSync(join(cwd, ".pi", "ansteel-team", "run-index.json"), "utf8");
		expect(persistedIndex).toContain(`run-${context.runId}-0001.jsonl`);
		expect(persistedIndex).toContain(`run-${context.runId}-0002.jsonl`);
	});

	it("rejects a runtime segment whose name is not covered by the historical index", () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-history", command: "task TASK-UNINDEXED-SEGMENT-1" });
		const logger = createAnsteelRuntimeLogger(cwd, context);
		logger.write({
			level: "info",
			eventName: "task.started",
			outcome: "started",
			taskId: "TASK-UNINDEXED-SEGMENT-1",
			message: "indexed segment record",
			data: {},
		});
		logger.write({
			level: "info",
			eventName: "task.progress",
			outcome: "progress",
			issueId: "ISSUE-UNINDEXED-SEGMENT-1",
			message: "record moved outside the indexed segment namespace",
			data: {},
		});
		logger.close();

		const firstSegmentPath = join(getAnsteelRuntimeLogDirectory(cwd), `run-${context.runId}-0001.jsonl`);
		const unindexedSegmentPath = join(getAnsteelRuntimeLogDirectory(cwd), `run-${context.runId}-99999.jsonl`);
		const lines = readFileSync(firstSegmentPath, "utf8").trim().split("\n");
		writeFileSync(unindexedSegmentPath, `${lines.join("\n")}\n`, "utf8");
		rmSync(firstSegmentPath, { force: true });
		rmSync(join(cwd, ".pi", "ansteel-team", "run-index.json"), { force: true });

		expect(() => traceAnsteelTeamRuntime(cwd, "ISSUE-UNINDEXED-SEGMENT-1")).toThrow(
			expect.objectContaining({ reasonCode: "event-chain-invalid" }),
		);
	});

	it("rejects an extra unindexed segment even while the trusted index still exists", () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-history", command: "task TASK-EXTRA-SEGMENT-1" });
		const logger = createAnsteelRuntimeLogger(cwd, context);
		logger.write({
			level: "info",
			eventName: "task.started",
			outcome: "started",
			taskId: "TASK-EXTRA-SEGMENT-1",
			message: "first indexed record",
			data: {},
		});
		logger.write({
			level: "info",
			eventName: "task.progress",
			outcome: "progress",
			issueId: "ISSUE-EXTRA-SEGMENT-1",
			message: "record moved into an unindexed segment",
			data: {},
		});
		logger.close();

		const firstSegmentPath = join(getAnsteelRuntimeLogDirectory(cwd), `run-${context.runId}-0001.jsonl`);
		const unindexedSegmentPath = join(getAnsteelRuntimeLogDirectory(cwd), `run-${context.runId}-99999.jsonl`);
		const lines = readFileSync(firstSegmentPath, "utf8").trim().split("\n");
		writeFileSync(firstSegmentPath, `${lines[0]}\n`, "utf8");
		writeFileSync(unindexedSegmentPath, `${lines[1]}\n`, "utf8");

		expect(() => traceAnsteelTeamRuntime(cwd, "ISSUE-EXTRA-SEGMENT-1")).toThrow(
			expect.objectContaining({ reasonCode: "event-chain-invalid" }),
		);
	});

	it("rejects an invalid log chain instead of hiding history while rebuilding the historical run index", () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-history", command: "task TASK-DAMAGED-1" });
		const logger = createAnsteelRuntimeLogger(cwd, context);
		logger.write({
			level: "info",
			eventName: "tool.call.completed",
			outcome: "succeeded",
			taskId: "TASK-DAMAGED-1",
			message: "historical event before chain tampering",
			data: {},
		});
		logger.close();
		const logPath = join(getAnsteelRuntimeLogDirectory(cwd), `run-${context.runId}-0001.jsonl`);
		const damaged = JSON.parse(readFileSync(logPath, "utf8")) as Record<string, unknown>;
		damaged.message = "tampered without rehashing";
		writeFileSync(logPath, `${JSON.stringify(damaged)}\n`, "utf8");
		rmSync(join(cwd, ".pi", "ansteel-team", "run-index.json"), { force: true });

		expect(() => traceAnsteelTeamRuntime(cwd, "TASK-DAMAGED-1")).toThrow(
			expect.objectContaining({ reasonCode: "event-chain-invalid" }),
		);
	});

	it("rejects a valid-prefix truncation that removes the trusted historical run index head", () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-history", command: "task TASK-TRUNCATED-1" });
		const logger = createAnsteelRuntimeLogger(cwd, context);
		logger.write({
			level: "info",
			eventName: "task.started",
			outcome: "started",
			taskId: "TASK-TRUNCATED-1",
			message: "trusted first record",
			data: {},
		});
		logger.write({
			level: "info",
			eventName: "task.progress",
			outcome: "progress",
			issueId: "ISSUE-TRUNCATED-1",
			message: "trusted chain head that will be removed",
			data: {},
		});
		logger.close();
		const logPath = join(getAnsteelRuntimeLogDirectory(cwd), `run-${context.runId}-0001.jsonl`);
		const firstLine = readFileSync(logPath, "utf8").trim().split("\n")[0]!;
		writeFileSync(logPath, `${firstLine}\n`, "utf8");

		expect(() => traceAnsteelTeamRuntime(cwd, "TASK-TRUNCATED-1")).toThrow(
			expect.objectContaining({ reasonCode: "event-chain-invalid" }),
		);
	});

	it("strictly rejects a changed log segment instead of rebuilding its index", () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-integrity", command: "task TASK-STRICT-SEGMENT" });
		const logger = createAnsteelRuntimeLogger(cwd, context);
		logger.write({
			level: "audit",
			eventName: "task.completed",
			outcome: "succeeded",
			taskId: "TASK-STRICT-SEGMENT",
			message: "trusted runtime record",
			data: {},
		});
		logger.close();
		expect(verifyAnsteelRuntimeLogIntegrity(cwd)).toMatchObject({ runCount: 1, segmentCount: 1 });

		const logPath = join(getAnsteelRuntimeLogDirectory(cwd), `run-${context.runId}-0001.jsonl`);
		const changed = JSON.parse(readFileSync(logPath, "utf8")) as Record<string, unknown>;
		changed.message = "changed after the indexed segment hash was written";
		writeFileSync(logPath, `${JSON.stringify(changed)}\n`, "utf8");

		expect(() => verifyAnsteelRuntimeLogIntegrity(cwd)).toThrow(
			expect.objectContaining({ reasonCode: "event-chain-invalid" }),
		);
	});

	it("keeps a successful low-level runtime log without a root command span healthy", () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-1", command: "tool" });
		const logger = createAnsteelRuntimeLogger(cwd, context);
		logger.write({
			level: "info",
			eventName: "tool.call.completed",
			outcome: "succeeded",
			role: "staff-engineer",
			message: "tool completed",
			data: { exitCode: 0 },
		});
		logger.close();

		const diagnosis = diagnoseAnsteelTeamRun(cwd, context.runId);
		expect(diagnosis.healthy).toBe(true);
		expect(diagnosis.issues).toEqual([]);
	});

	it("indexes runs and traces entries by governed identifiers", () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-1", command: "task TASK-1" });
		const logger = createAnsteelRuntimeLogger(cwd, context);
		logger.write({
			level: "info",
			eventName: "tool.call.completed",
			outcome: "succeeded",
			taskId: "TASK-1",
			toolCallId: "TOOL-1",
			message: "test passed",
			data: { exitCode: 0 },
		});
		logger.close();

		expect(listAnsteelRuntimeRuns(cwd)).toContainEqual(
			expect.objectContaining({ runId: context.runId, traceId: context.traceId, entryCount: 1 }),
		);
		expect(traceAnsteelTeamRuntime(cwd, "TASK-1")).toHaveLength(1);
		expect(traceAnsteelTeamRuntime(cwd, "TOOL-1")).toHaveLength(1);
		expect(traceAnsteelTeamRuntime(cwd, context.traceId)).toHaveLength(1);
	});

	it("creates a hashed incident bundle from mechanical facts", () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-1", command: "task TASK-1" });
		const logger = createAnsteelRuntimeLogger(cwd, context);
		const root = logger.startSpan("run", {
			role: "coordinator",
			message: "task command started",
			data: { command: "task TASK-1" },
		});
		const tool = logger.startSpan("tool.call", {
			role: "staff-engineer",
			parent: root,
			taskId: "TASK-1",
			revision: 2,
			toolCallId: "TOOL-1",
			message: "read tool started",
			data: { toolName: "read", denialBoundary: "read-only-policy" },
		});
		tool.end({ outcome: "succeeded", message: "read tool completed", data: { toolName: "read" } });
		const provider = logger.startSpan("provider.request", {
			role: "staff-engineer",
			parent: root,
			taskId: "TASK-1",
			revision: 2,
			providerRequestId: "PROVIDER-1",
			message: "provider request started",
			data: {
				provider: "provider-b",
				model: "model-b",
				configurationIdentity: "provider-b/model-b",
				timeoutMs: 120_000,
			},
		});
		provider.end({
			outcome: "failed",
			reasonCode: "provider-timeout",
			message: "provider timed out",
			data: { retryCount: 1 },
			artifacts: [{ kind: "exception-stack", content: "Error: provider timed out" }],
		});
		root.end({
			outcome: "failed",
			reasonCode: "provider-timeout",
			message: "task command failed",
			data: { command: "task TASK-1" },
		});
		logger.close();

		const bundle = createAnsteelTeamIncidentBundle(cwd, context.runId);
		const repeated = createAnsteelTeamIncidentBundle(cwd, context.runId);
		const persisted = JSON.parse(readFileSync(bundle.storageId, "utf8")) as Record<string, unknown>;

		expect(bundle.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(repeated).toMatchObject({ sha256: bundle.sha256, storageId: bundle.storageId });
		expect(persisted).toMatchObject({
			schemaVersion: 2,
			evidenceModel: "mechanical-facts-only",
			run: { runId: context.runId, traceId: context.traceId, terminalOutcome: "failed" },
			rootCause: { reasonCode: "provider-timeout" },
			propagationEvents: [expect.objectContaining({ eventName: "run.failed", reasonCode: "provider-timeout" })],
			finalRuntimeState: { terminalEvent: { eventName: "run.failed", outcome: "failed" } },
			configurationSummary: {
				providers: [
					expect.objectContaining({
						providerRequestId: "PROVIDER-1",
						provider: "provider-b",
						model: "model-b",
						retryCount: 1,
					}),
				],
				tools: [
					expect.objectContaining({
						toolCallId: "TOOL-1",
						toolName: "read",
						policyBoundary: "read-only-policy",
					}),
				],
			},
			integrity: {
				runtimeEventChain: { status: "verified" },
				logSegments: { status: "verified" },
				artifacts: { status: "verified", verifiedCount: 1, missingCount: 0 },
			},
			projectContext: { availability: "unavailable", reasonCode: "team-state-missing" },
		});
		expect(bundle.manifest.spanTree.rootSpanIds).toContain(root.spanId);
		expect(bundle.manifest.spanTree.nodes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					spanId: root.spanId,
					childSpanIds: expect.arrayContaining([tool.spanId, provider.spanId]),
				}),
				expect.objectContaining({ spanId: tool.spanId, parentSpanId: root.spanId }),
				expect.objectContaining({ spanId: provider.spanId, parentSpanId: root.spanId }),
			]),
		);
		expect(bundle.manifest.logSegments).toEqual([
			expect.objectContaining({ verificationResult: "verified", expectedSha256: expect.any(String) }),
		]);
		expect(persisted).not.toHaveProperty("modelAnalysis");
		expect(formatAnsteelTeamDiagnosis(diagnoseAnsteelTeamRun(cwd, context.runId))).toContain("provider-timeout");
	});

	it("reports a deleted referenced artifact as failed incident integrity", () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-artifact", command: "task TASK-ARTIFACT" });
		const logger = createAnsteelRuntimeLogger(cwd, context);
		logger.write({
			level: "error",
			eventName: "task.completed",
			outcome: "failed",
			reasonCode: "tool-exit-nonzero",
			taskId: "TASK-ARTIFACT",
			revision: 1,
			message: "task failed",
			data: { exitCode: 1 },
			artifacts: [{ kind: "stderr", content: "deterministic failure output" }],
		});
		logger.close();
		const artifact = readAnsteelRuntimeLogs(cwd, context.runId).find((entry) => entry.artifactRefs.length > 0)
			?.artifactRefs[0];
		expect(artifact).toBeDefined();
		rmSync(artifact!.storageId);

		const bundle = createAnsteelTeamIncidentBundle(cwd, context.runId);

		expect(bundle.manifest.integrity.artifacts).toMatchObject({
			status: "failed",
			verifiedCount: 0,
			missingCount: 1,
			results: [
				{
					kind: "stderr",
					sha256: artifact!.sha256,
					verificationResult: "missing",
				},
			],
		});
		expect(bundle.manifest.issues).toEqual(
			expect.arrayContaining([expect.objectContaining({ reasonCode: "artifact-missing" })]),
		);
	});
});
