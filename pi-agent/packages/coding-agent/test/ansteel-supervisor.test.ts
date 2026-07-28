import { describe, expect, it } from "vitest";
import { runAnsteelEpochSupervisor } from "../src/cli/ansteel-supervisor.ts";

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
});
