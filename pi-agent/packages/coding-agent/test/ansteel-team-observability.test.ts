import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ANSTEEL_RUNTIME_REASON_CODES,
	createAnsteelTeamIncidentBundle,
	createAnsteelRuntimeLogger,
	createAnsteelRunContext,
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
