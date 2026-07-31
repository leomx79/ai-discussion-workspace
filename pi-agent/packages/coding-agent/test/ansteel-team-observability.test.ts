import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ANSTEEL_RUNTIME_REASON_CODES,
	abandonOrphanedAnsteelTeamRun,
	createAnsteelRunContext,
	createAnsteelRuntimeLogger,
	createAnsteelTeamIncidentBundle,
	diagnoseAnsteelTeamRun,
	formatAnsteelTeamDiagnosis,
	getAnsteelRuntimeLogDirectory,
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

afterEach(() => {
	for (const cwd of temporaryProjects.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe("Ansteel team observability", () => {
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
		expect(readAnsteelRuntimeLogs(cwd, context.runId)).toHaveLength(1);
		expect(existsSync(getAnsteelRuntimeLogDirectory(cwd))).toBe(true);
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
		const childEnd = logs.find((entry) => entry.eventName === "provider.request" && entry.outcome === "failed");
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
			eventName: "run.started",
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
			eventName: "run.started",
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

		expect(() => createAnsteelRuntimeLogger(cwd, context)).toThrow(
			expect.objectContaining({ reasonCode: "lease-owner-mismatch" }),
		);

		first.close();
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

		const abandoned = readAnsteelRuntimeLogs(cwd, context.runId).at(-1);
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
		logger.write({
			level: "error",
			eventName: "provider.request.completed",
			outcome: "failed",
			reasonCode: "provider-timeout",
			message: "provider timed out",
			data: { attempt: 1 },
		});
		logger.close();

		const bundle = createAnsteelTeamIncidentBundle(cwd, context.runId);
		const persisted = JSON.parse(readFileSync(bundle.storageId, "utf8")) as Record<string, unknown>;

		expect(bundle.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(persisted).toMatchObject({
			runId: context.runId,
			traceId: context.traceId,
			rootCause: { reasonCode: "provider-timeout" },
		});
		expect(persisted).not.toHaveProperty("modelAnalysis");
		expect(formatAnsteelTeamDiagnosis(diagnoseAnsteelTeamRun(cwd, context.runId))).toContain("provider-timeout");
	});
});
