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
			message: "command failed",
			data: { authorization: "Bearer top-secret", exitCode: 1 },
			artifacts: [{ kind: "stderr", content: "API_KEY=top-secret\nfailure" }],
		});
		logger.close();

		expect(entry.data.authorization).toBe("[REDACTED]");
		expect(entry.artifactRefs[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(readFileSync(entry.artifactRefs[0]!.storageId, "utf8")).not.toContain("top-secret");
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

	it("preserves an orphaned span cause while recording its recovered start hash", async () => {
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

		await expect(abandonOrphanedAnsteelTeamRun(cwd, context.runId)).resolves.toBe(1);

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
