import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ANSTEEL_RUNTIME_REASON_CODES,
	createAnsteelRuntimeLogger,
	createAnsteelRunContext,
	getAnsteelRuntimeLogDirectory,
	isAnsteelRuntimeReasonCode,
	readAnsteelRuntimeLogs,
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
});
