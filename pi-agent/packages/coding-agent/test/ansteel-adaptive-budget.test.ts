import { describe, expect, it } from "vitest";
import * as adaptiveBudget from "../src/core/ansteel-adaptive-budget.ts";

describe("Ansteel adaptive budget", () => {
	it("starts each stage with coordinator-owned counters and hard project limits", () => {
		const createState = (
			adaptiveBudget as typeof adaptiveBudget & {
				createAnsteelAdaptiveBudgetState?: (options: {
					policy: ReturnType<typeof adaptiveBudget.createAnsteelAdaptiveBudgetPolicy>;
					role: "tech-lead";
					stage: "architecture";
					stageBaseTimeoutMs: number;
					stageHardTimeoutMs: number;
					stageBaseToolCalls: number;
					stageHardToolCalls: number;
					unresolvedChallengeCount: number;
					now: number;
				}) => unknown;
			}
		).createAnsteelAdaptiveBudgetState;
		expect(createState).toBeTypeOf("function");

		const state = createState!({
			policy: adaptiveBudget.createAnsteelAdaptiveBudgetPolicy({
				enabled: true,
				projectTimeoutMs: 900_000,
				maxProjectToolCalls: 96,
			}),
			role: "tech-lead",
			stage: "architecture",
			stageBaseTimeoutMs: 120_000,
			stageHardTimeoutMs: 180_000,
			stageBaseToolCalls: 8,
			stageHardToolCalls: 12,
			unresolvedChallengeCount: 3,
			now: 1_000,
		});

		expect(state).toMatchObject({
			projectStartedAt: 1_000,
			hardProjectDeadline: 901_000,
			remainingProjectTimeMs: 900_000,
			remainingProjectToolCalls: 96,
			stageGrantedTimeoutMs: 120_000,
			stageGrantedToolCalls: 8,
			evidenceProgressCount: 0,
			duplicateOperationCount: 0,
			blockedRequestCount: 0,
			unresolvedChallengeCount: 3,
			allocationEvents: [],
		});
	});

	it("grants a bounded time extension only after new evidence for unresolved work", () => {
		const recordEvidence = (
			adaptiveBudget as typeof adaptiveBudget & {
				recordAnsteelAdaptiveEvidence?: (state: unknown, kind: "new" | "duplicate" | "blocked") => void;
			}
		).recordAnsteelAdaptiveEvidence;
		const decideAllocation = (
			adaptiveBudget as typeof adaptiveBudget & {
				decideAnsteelAdaptiveAllocation?: (options: unknown) => unknown;
			}
		).decideAnsteelAdaptiveAllocation;
		expect(recordEvidence).toBeTypeOf("function");
		expect(decideAllocation).toBeTypeOf("function");

		const policy = adaptiveBudget.createAnsteelAdaptiveBudgetPolicy({
			enabled: true,
			projectTimeoutMs: 900_000,
			protectedVerificationTimeMs: 360_000,
		});
		const state = adaptiveBudget.createAnsteelAdaptiveBudgetState({
			policy,
			role: "tech-lead",
			stage: "architecture-revision",
			stageBaseTimeoutMs: 120_000,
			stageHardTimeoutMs: 180_000,
			stageBaseToolCalls: 8,
			stageHardToolCalls: 12,
			unresolvedChallengeCount: 1,
			now: 1_000,
		});
		recordEvidence!(state, "new");

		expect(decideAllocation!({ state, policy, kind: "time", now: 121_000 })).toMatchObject({
			action: "grant-time",
			granted: { timeMs: 30_000 },
		});
		expect(state.stageGrantedTimeoutMs).toBe(150_000);
		expect(state.allocationEvents).toHaveLength(1);
	});
});
