import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createAnsteelRunContext,
	createAnsteelRuntimeLogger,
	readAnsteelRuntimeLogs,
} from "../src/core/ansteel-team-observability.ts";
import { runAnsteelGovernedProcess } from "../src/core/ansteel-team-process.ts";

const temporaryDirectories: string[] = [];

function createTemporaryProject(): string {
	const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-process-"));
	temporaryDirectories.push(cwd);
	return cwd;
}

afterEach(() => {
	for (const cwd of temporaryDirectories.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe("Ansteel governed process runner", () => {
	it("records the real PID, heartbeat, bounded output, and exit under its parent tool span", async () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-process", command: "task TASK-PROCESS" });
		const logger = createAnsteelRuntimeLogger(cwd, context);
		const root = logger.startSpan("run", { role: "coordinator", data: { command: context.command } });
		const tool = logger.startSpan("tool.call", {
			parent: root,
			role: "staff-engineer",
			taskId: "TASK-PROCESS",
			toolCallId: "TOOL-PROCESS",
		});

		const result = await runAnsteelGovernedProcess({
			command: process.execPath,
			args: ["-e", "process.stdout.write('x'.repeat(64)); setTimeout(() => process.exit(0), 80)"],
			cwd,
			env: { PATH: process.env.PATH },
			shell: false,
			timeoutMs: 5_000,
			maximumOutputBytes: 16,
			policy: "task-test",
			role: "staff-engineer",
			taskId: "TASK-PROCESS",
			toolCallId: "TOOL-PROCESS",
			persistence: { logger, parentSpan: tool },
			heartbeatIntervalMs: 20,
		});
		expect(result).toMatchObject({
			exitCode: 0,
			timedOut: false,
			stdout: "x".repeat(16),
			stdoutBytes: 64,
			stdoutTruncated: true,
			stdoutHash: createHash("sha256").update("x".repeat(64)).digest("hex"),
		});
		expect(result.pid).toBeGreaterThan(0);

		tool.end({ outcome: "failed", reasonCode: "budget-exhausted", message: "tool output exceeded its boundary" });
		root.end({ outcome: "succeeded", message: "run completed" });
		await logger.forceFlush();
		logger.close();
		const runtimeEntries = readAnsteelRuntimeLogs(cwd, context.runId);
		const processEntries = runtimeEntries.filter(
			(entry) => entry.processId === result.processId && entry.eventName.startsWith("process."),
		);
		const toolProgressEntries = runtimeEntries.filter(
			(entry) => entry.processId === result.processId && entry.eventName === "tool.call.progress",
		);
		expect(processEntries.map((entry) => entry.eventName)).toEqual([
			"process.spawned",
			...processEntries.slice(1, -1).map(() => "process.heartbeat"),
			"process.exited",
		]);
		expect(processEntries.filter((entry) => entry.eventName === "process.heartbeat").length).toBeGreaterThan(0);
		expect(toolProgressEntries).toHaveLength(
			processEntries.filter((entry) => entry.eventName === "process.heartbeat").length,
		);
		expect(toolProgressEntries[0]).toMatchObject({
			outcome: "progress",
			spanId: tool.spanId,
			parentSpanId: root.spanId,
			role: "staff-engineer",
			taskId: "TASK-PROCESS",
			toolCallId: "TOOL-PROCESS",
			processId: result.processId,
			data: { policy: "task-test", sourceEventName: "process.heartbeat" },
		});
		expect(processEntries[0]).toMatchObject({
			parentSpanId: tool.spanId,
			taskId: "TASK-PROCESS",
			toolCallId: "TOOL-PROCESS",
			data: { pid: result.pid, policy: "task-test" },
		});
		expect(processEntries.at(-1)).toMatchObject({
			eventName: "process.exited",
			outcome: "failed",
			reasonCode: "budget-exhausted",
			data: {
				exitCode: 0,
				timedOut: false,
				stdoutBytes: 64,
				stdoutTruncated: true,
				stdoutHash: createHash("sha256").update("x".repeat(64)).digest("hex"),
			},
		});
	});

	it("terminates a timed-out process and records a cancelled terminal event", async () => {
		const cwd = createTemporaryProject();
		const context = createAnsteelRunContext({ teamId: "team-timeout", command: "verify TASK-TIMEOUT" });
		const logger = createAnsteelRuntimeLogger(cwd, context);
		const result = await runAnsteelGovernedProcess({
			command: process.execPath,
			args: ["-e", "setInterval(() => {}, 10_000)"],
			cwd,
			env: { PATH: process.env.PATH },
			shell: false,
			timeoutMs: 100,
			maximumOutputBytes: 1_024,
			policy: "delivery-check",
			role: "coordinator",
			taskId: "TASK-TIMEOUT",
			persistence: { logger },
			heartbeatIntervalMs: 25,
		});
		expect(result.timedOut).toBe(true);
		await logger.forceFlush();
		logger.close();
		expect(readAnsteelRuntimeLogs(cwd, context.runId).at(-1)).toMatchObject({
			eventName: "process.exited",
			outcome: "cancelled",
			reasonCode: "tool-timeout",
			processId: result.processId,
			data: { timedOut: true },
		});
	});
});
