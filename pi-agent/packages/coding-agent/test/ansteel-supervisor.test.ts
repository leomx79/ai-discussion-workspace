import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	runAnsteelEpochSupervisor,
	runAnsteelEpochSupervisorWithLock,
	type AnsteelEpochCall,
} from "../src/cli/ansteel-supervisor.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createSupervisorDirectory(): { cwd: string; lockPath: string } {
	const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-supervisor-"));
	temporaryDirectories.push(cwd);
	mkdirSync(join(cwd, ".pi"));
	return { cwd, lockPath: join(cwd, ".pi", "ansteel-supervisor.lock") };
}

function createTerminalEpochOptions(cwd: string) {
	const calls: Array<{ kind: "new" | "resume"; runId?: string; topic?: string }> = [];
	return {
		calls,
		options: {
			cwd,
			topic: "Long review",
			maxEpochs: 1,
			listRunIds: () => (calls.length === 0 ? [] : ["ansteel-run-new"]),
			loadCheckpoint: () => ({ id: "ansteel-run-new", status: "completed" }),
			runEpoch: async (call: { kind: "new" | "resume"; runId?: string; topic?: string }) => {
				calls.push(call);
				return 0;
			},
		},
	};
}

describe("runAnsteelEpochSupervisor", () => {
	it("starts a new epoch, resumes its only paused checkpoint, and stops at terminal state", async () => {
		const calls: Array<{ kind: "new" | "resume"; runId?: string; topic?: string }> = [];
		const result = await runAnsteelEpochSupervisor({
			topic: "Long review",
			maxEpochs: 4,
			listRunIds: () => (calls.length === 0 ? [] : ["ansteel-run-new"]),
			loadCheckpoint: () => ({
				id: "ansteel-run-new",
				status: calls.length === 1 ? "ready-to-resume" : "completed",
			}),
			runEpoch: async (call) => {
				calls.push(call);
				return 0;
			},
		});

		expect(calls).toEqual([
			{ kind: "new", topic: "Long review" },
			{ kind: "resume", runId: "ansteel-run-new" },
		]);
		expect(result).toMatchObject({
			outcome: "terminal",
			runId: "ansteel-run-new",
			epochsStarted: 2,
			exitCode: 0,
		});
	});

	it("treats an absent run directory as no runs before starting a new epoch", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-supervisor-fresh-"));
		temporaryDirectories.push(cwd);
		const calls: AnsteelEpochCall[] = [];

		const result = await runAnsteelEpochSupervisor({
			cwd,
			topic: "Fresh review",
			maxEpochs: 1,
			loadCheckpoint: () => ({ id: "ansteel-run-new", status: "completed" }),
			runEpoch: async (call) => {
				calls.push(call);
				mkdirSync(join(cwd, ".pi", "ansteel-runs", "ansteel-run-new"), { recursive: true });
				return 0;
			},
		});

		expect(calls).toEqual([{ kind: "new", topic: "Fresh review" }]);
		expect(result).toMatchObject({ outcome: "terminal", runId: "ansteel-run-new", exitCode: 0 });
	});

	it.each([
		{
			name: "rejects ambiguity when a new epoch produces two run IDs",
			listRunIds: (calls: unknown[]) => (calls.length === 0 ? [] : ["ansteel-run-one", "ansteel-run-two"]),
			expectedCalls: 1,
			expectFailure: /expected exactly one new Ansteel run ID/i,
		},
		{
			name: "returns child-failed when the epoch child exits nonzero",
			listRunIds: () => [],
			exitCode: 1,
			expectedCalls: 1,
			expectedResult: { outcome: "child-failed", epochsStarted: 1, exitCode: 1 },
		},
		{
			name: "rejects a zero-exit new epoch that produces no checkpoint",
			listRunIds: () => [],
			expectedCalls: 1,
			expectFailure: /expected exactly one new Ansteel run ID/i,
		},
	])("$name", async ({ listRunIds, exitCode = 0, expectedCalls, expectedResult, expectFailure }) => {
		const calls: Array<{ kind: "new" | "resume"; runId?: string; topic?: string }> = [];
		const operation = runAnsteelEpochSupervisor({
			topic: "Long review",
			maxEpochs: 4,
			listRunIds: () => listRunIds(calls),
			loadCheckpoint: () => ({ id: "ansteel-run-unused", status: "completed" }),
			runEpoch: async (call) => {
				calls.push(call);
				return exitCode;
			},
		});

		if (expectFailure !== undefined) await expect(operation).rejects.toThrow(expectFailure);
		else expect(await operation).toMatchObject(expectedResult);
		expect(calls).toHaveLength(expectedCalls);
	});

	it.each([
		{ status: "waiting-provider", outcome: "invalid-checkpoint", exitCode: 1 },
		{ status: "blocked", outcome: "invalid-checkpoint", exitCode: 1 },
		{ status: "unknown-status", outcome: "invalid-checkpoint", exitCode: 1 },
	] as const)("stops after one epoch for $status", async ({ status, outcome, exitCode }) => {
		const calls: Array<{ kind: "new" | "resume"; runId?: string; topic?: string }> = [];
		const result = await runAnsteelEpochSupervisor({
			topic: "Long review",
			maxEpochs: 4,
			listRunIds: () => (calls.length === 0 ? [] : ["ansteel-run-new"]),
			loadCheckpoint: () => ({ id: "ansteel-run-new", status }),
			runEpoch: async (call) => {
				calls.push(call);
				return 0;
			},
		});

		expect(result).toMatchObject({ outcome, runId: "ansteel-run-new", epochsStarted: 1, exitCode });
		expect(calls).toHaveLength(1);
	});

	it("fails closed when loading the new checkpoint throws", async () => {
		const calls: Array<{ kind: "new" | "resume"; runId?: string; topic?: string }> = [];
		const result = await runAnsteelEpochSupervisor({
			topic: "Long review",
			maxEpochs: 4,
			listRunIds: () => (calls.length === 0 ? [] : ["ansteel-run-new"]),
			loadCheckpoint: () => {
				throw new Error("malformed checkpoint");
			},
			runEpoch: async (call) => {
				calls.push(call);
				return 0;
			},
		});

		expect(result).toMatchObject({
			outcome: "invalid-checkpoint",
			runId: "ansteel-run-new",
			epochsStarted: 1,
			exitCode: 1,
		});
		expect(calls).toHaveLength(1);
	});

	it("does not choose another run when resuming and stops at the epoch limit", async () => {
		const calls: Array<{ kind: "new" | "resume"; runId?: string; topic?: string }> = [];
		const result = await runAnsteelEpochSupervisor({
			resumeRunId: "ansteel-run-resume",
			maxEpochs: 2,
			listRunIds: () => {
				throw new Error("resume must not inspect other runs");
			},
			loadCheckpoint: (runId) => ({ id: runId, status: "ready-to-resume" }),
			runEpoch: async (call) => {
				calls.push(call);
				return 0;
			},
		});

		expect(calls).toEqual([
			{ kind: "resume", runId: "ansteel-run-resume" },
			{ kind: "resume", runId: "ansteel-run-resume" },
		]);
		expect(result).toMatchObject({
			outcome: "limit-reached",
			runId: "ansteel-run-resume",
			epochsStarted: 2,
			exitCode: 1,
		});
	});

	it("rejects a live supervisor lock without starting an epoch", async () => {
		const { cwd, lockPath } = createSupervisorDirectory();
		const { calls, options } = createTerminalEpochOptions(cwd);
		writeFileSync(lockPath, JSON.stringify({ version: 1, pid: 42, startedAt: "2026-07-28T00:00:00.000Z" }));

		await expect(
			runAnsteelEpochSupervisorWithLock({ ...options, isProcessAlive: (pid) => pid === 42 }),
		).rejects.toThrow("already owns this project");

		expect(calls).toHaveLength(0);
		expect(existsSync(lockPath)).toBe(true);
	});

	it("takes over a confirmed-dead lock and releases its own lock after terminal completion", async () => {
		const { cwd, lockPath } = createSupervisorDirectory();
		const { options } = createTerminalEpochOptions(cwd);
		writeFileSync(lockPath, JSON.stringify({ version: 1, pid: 41, startedAt: "2026-07-28T00:00:00.000Z" }));

		const result = await runAnsteelEpochSupervisorWithLock({ ...options, isProcessAlive: () => false });

		expect(result).toMatchObject({ outcome: "terminal", exitCode: 0 });
		expect(existsSync(lockPath)).toBe(false);
	});

	it.each([
		{ name: "malformed JSON", lock: "{", alive: () => false },
		{ name: "missing integer PID", lock: JSON.stringify({ version: 1, startedAt: "2026-07-28T00:00:00.000Z" }), alive: () => false },
		{
			name: "unverifiable PID due to EPERM",
			lock: JSON.stringify({ version: 1, pid: 42, startedAt: "2026-07-28T00:00:00.000Z" }),
			alive: () => {
				throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
			},
		},
	])("does not remove a $name lock", async ({ lock, alive }) => {
		const { cwd, lockPath } = createSupervisorDirectory();
		const { calls, options } = createTerminalEpochOptions(cwd);
		writeFileSync(lockPath, lock);

		await expect(runAnsteelEpochSupervisorWithLock({ ...options, isProcessAlive: alive })).rejects.toThrow(
			/Ansteel supervisor lock/i,
		);

		expect(calls).toHaveLength(0);
		expect(readFileSync(lockPath, "utf8")).toBe(lock);
	});

	it.each([
		{ name: "a failed child", runEpoch: async () => 1 },
		{ name: "an invalid checkpoint", runEpoch: async () => 0 },
	])("releases its own lock after $name", async ({ runEpoch }) => {
		const { cwd, lockPath } = createSupervisorDirectory();
		const { calls, options } = createTerminalEpochOptions(cwd);
		const result = await runAnsteelEpochSupervisorWithLock({
			...options,
			runEpoch: async (call) => {
				calls.push(call);
				return await runEpoch();
			},
			loadCheckpoint: () => ({ id: "ansteel-run-new", status: "waiting-provider" }),
			isProcessAlive: () => false,
		});

		expect(result.exitCode).toBe(1);
		expect(existsSync(lockPath)).toBe(false);
	});
});
