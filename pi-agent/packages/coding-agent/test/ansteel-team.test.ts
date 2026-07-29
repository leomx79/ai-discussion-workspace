import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AnsteelWorkCheckpoint,
	type AnsteelWorkCheckpointInput,
	appendAnsteelTeamEvent,
	claimAnsteelTeamTask,
	createAnsteelTeamMilestone,
	createAnsteelTeamState,
	getAnsteelTeamEventPath,
	getAnsteelTeamSharedBoard,
	getAnsteelTeamStatePath,
	getAnsteelTeamTaskProgressFingerprint,
	getAnsteelTeamTransactionPath,
	getAnsteelTeamWriteBlockReason,
	listAnsteelTeamEvents,
	loadAnsteelTeamState,
	publishAnsteelWorkCheckpoint,
	raiseAnsteelProcessIssue,
	recordAnsteelTeamTaskTestResult,
	resolveAnsteelProcessIssue,
	reviewAnsteelProcessResolution,
	reviewAnsteelTeamMilestone,
	reviewAnsteelTeamTask,
	runAnsteelTeamMilestoneTest,
	runAnsteelTeamTaskTest,
	saveAnsteelTeamState,
	submitAnsteelTeamMilestone,
	submitAnsteelTeamTask,
} from "../src/core/ansteel-team.ts";
import {
	type AnsteelRuntimeLogEntry,
	createAnsteelRunContext,
	createAnsteelRuntimeLogger,
	readAnsteelRuntimeLogs,
} from "../src/core/ansteel-team-observability.ts";

const temporaryDirectories: string[] = [];

function createTemporaryProject(): string {
	const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-team-"));
	temporaryDirectories.push(cwd);
	return cwd;
}

function createTeam(cwd: string) {
	return createAnsteelTeamState({
		cwd,
		topic: "Review the parser change",
		roleModels: {
			"tech-lead": "provider-a/model-a",
			"staff-engineer": "provider-b/model-b",
			"qa-engineer": "provider-c/model-c",
		},
		now: new Date("2026-07-24T00:00:00.000Z"),
	});
}

function createValidPublicCollaborationState(cwd: string): Record<string, unknown> {
	const state = createTeam(cwd);
	Object.assign(state, {
		workCheckpoints: [
			{
				id: "CP-PARSER-0001",
				actor: "staff-engineer",
				goal: "Prevent malformed parser input",
				currentUnderstanding: "The parser currently accepts an empty token",
				assumptions: ["The public parser is the only entry point"],
				evidenceRefs: ["file:src/parser.ts:10"],
				uncertainties: ["Whether whitespace-only input follows the same path"],
				nextAction: {
					kind: "test",
					target: "test/parser.test.ts",
					expectedResult: "Empty input is rejected",
				},
				risk: "yellow",
				confidence: "L2",
				status: "active",
				createdAt: "2026-07-24T00:01:00.000Z",
			},
		],
		processIssues: [
			{
				id: "PI-PARSER-0001",
				targetCheckpointId: "CP-PARSER-0001",
				author: "qa-engineer",
				targetRole: "staff-engineer",
				severity: "blocking",
				claim: "Whitespace-only input is not covered",
				evidenceRefs: ["test:parser-whitespace"],
				suggestedCorrection: "Add a whitespace-only regression",
				status: "closed",
				resolutions: [
					{
						id: "PR-PARSER-0001",
						issueId: "PI-PARSER-0001",
						actor: "staff-engineer",
						outcome: "ACCEPTED",
						summary: "Cover empty and whitespace-only input",
						evidenceRefs: ["test:parser-whitespace"],
						createdAt: "2026-07-24T00:02:00.000Z",
						review: {
							reviewer: "qa-engineer",
							verdict: "accept",
							reason: "The regression now covers the reported gap",
							reviewedAt: "2026-07-24T00:03:00.000Z",
						},
					},
				],
				createdAt: "2026-07-24T00:01:30.000Z",
			},
		],
	});
	return state as unknown as Record<string, unknown>;
}

function writePersistedTeamState(cwd: string, state: Record<string, unknown>): void {
	mkdirSync(join(cwd, ".pi", "ansteel-team"), { recursive: true });
	writeFileSync(getAnsteelTeamStatePath(cwd), `${JSON.stringify(state)}\n`, "utf8");
}

function initializeGitProject(cwd: string): void {
	mkdirSync(join(cwd, "src"), { recursive: true });
	writeFileSync(join(cwd, "src", "parser.ts"), "export const parser = 'before';\n", "utf8");
	execFileSync("git", ["init"], { cwd, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "ansteel@example.test"], { cwd, stdio: "ignore" });
	execFileSync("git", ["config", "user.name", "Ansteel Test"], { cwd, stdio: "ignore" });
	execFileSync("git", ["add", "src/parser.ts"], { cwd, stdio: "ignore" });
	execFileSync("git", ["commit", "-m", "baseline"], { cwd, stdio: "ignore" });
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

describe("public collaboration state", () => {
	it("derives the shared board without trusting role-written counts", () => {
		const cwd = createTemporaryProject();
		const state = createTeam(cwd);
		const first = publishAnsteelWorkCheckpoint(cwd, state, "staff-engineer", {
			id: "CP-BOARD-0001",
			goal: "Prevent unsafe lease expiry",
			currentUnderstanding: "The calculated expiry needs validation",
			assumptions: [],
			evidenceRefs: ["file:src/lease.ts:10"],
			uncertainties: ["Boundary behavior"],
			nextAction: { kind: "test", target: "test/lease.test.ts", expectedResult: "Overflow is reproduced" },
			risk: "yellow",
			confidence: "L2",
		});
		const firstIssue = raiseAnsteelProcessIssue(cwd, state, "qa-engineer", {
			id: "PI-BOARD-0001",
			targetCheckpointId: first.id,
			severity: "blocking",
			claim: "The boundary test is missing",
			evidenceRefs: ["test:lease-boundary"],
			suggestedCorrection: "Add the boundary regression",
		});
		const replacement = publishAnsteelWorkCheckpoint(cwd, state, "staff-engineer", {
			id: "CP-BOARD-0002",
			goal: first.goal,
			currentUnderstanding: "The calculated expiry must remain a safe integer",
			assumptions: [],
			evidenceRefs: ["test:lease-boundary:passed"],
			uncertainties: [],
			nextAction: { kind: "edit", target: "src/lease.ts", expectedResult: "Unsafe expiry is rejected" },
			risk: "yellow",
			confidence: "L1",
			supersedesCheckpointId: first.id,
		});
		resolveAnsteelProcessIssue(cwd, state, "staff-engineer", {
			id: "PR-BOARD-0001",
			issueId: firstIssue.id,
			outcome: "ACCEPTED",
			summary: "Validate the calculated expiry",
			evidenceRefs: ["test:lease-boundary:passed"],
			replacementCheckpointId: replacement.id,
		});
		reviewAnsteelProcessResolution(cwd, state, "qa-engineer", firstIssue.id, {
			verdict: "accept",
			reason: "The replacement includes the passing boundary regression",
		});
		raiseAnsteelProcessIssue(cwd, state, "tech-lead", {
			id: "PI-BOARD-0002",
			targetCheckpointId: replacement.id,
			severity: "blocking",
			claim: "The compatibility impact remains unverified",
			evidenceRefs: ["test:compatibility-missing"],
			suggestedCorrection: "Run the compatibility suite",
		});
		appendAnsteelTeamEvent(cwd, state, {
			type: "role-report",
			role: "staff-engineer",
			content: "All issues closed. Active checkpoints: 99.",
		});

		const runtimeEntries = [
			{
				sequence: 7,
				eventName: "tool.completed",
				outcome: "failed",
				reasonCode: "tool-timeout",
				toolCallId: "TOOL-BOARD-0001",
			},
			{ sequence: 8, eventName: "role.progress", outcome: "progress" },
		] as AnsteelRuntimeLogEntry[];
		const board = getAnsteelTeamSharedBoard(state, listAnsteelTeamEvents(cwd), runtimeEntries);

		expect(board.currentGoal).toBe(state.topic);
		expect(board.roles["staff-engineer"].activeCheckpointId).toBe("CP-BOARD-0002");
		expect(board.openProcessIssues).toEqual([expect.objectContaining({ id: "PI-BOARD-0002", severity: "blocking" })]);
		expect(board.counts).toEqual({
			activeCheckpoints: 1,
			openProcessIssues: 1,
			blockingProcessIssues: 1,
			escalatedProcessIssues: 0,
		});
		expect(board.recentToolFacts).toEqual([
			{
				sequence: 7,
				eventName: "tool.completed",
				outcome: "failed",
				reasonCode: "tool-timeout",
			},
		]);
		board.activeCheckpoints[0].currentUnderstanding = "Caller mutated projection";
		expect(state.workCheckpoints.find((checkpoint) => checkpoint.id === "CP-BOARD-0002")?.currentUnderstanding).toBe(
			"The calculated expiry must remain a safe integer",
		);
	});

	it("rejects a shared board when persisted state differs from event replay", () => {
		const cwd = createTemporaryProject();
		const state = createTeam(cwd);
		publishAnsteelWorkCheckpoint(cwd, state, "staff-engineer", {
			id: "CP-MISMATCH-0001",
			goal: "Keep state and events aligned",
			currentUnderstanding: "The event payload is authoritative",
			assumptions: [],
			evidenceRefs: ["event:1"],
			uncertainties: [],
			nextAction: { kind: "read", target: "events.jsonl", expectedResult: "Replay matches state" },
			risk: "green",
			confidence: "L1",
		});
		state.workCheckpoints[0].currentUnderstanding = "State was modified without an event";

		expect(() => getAnsteelTeamSharedBoard(state, listAnsteelTeamEvents(cwd))).toThrow("state-projection-mismatch");
	});

	it("normalizes invalid persisted collaboration state to a projection mismatch", () => {
		const cwd = createTemporaryProject();
		const state = createTeam(cwd);
		publishAnsteelWorkCheckpoint(cwd, state, "staff-engineer", {
			id: "CP-MISMATCH-0002",
			goal: "Reject invalid persisted collaboration state",
			currentUnderstanding: "The projection must fail closed",
			assumptions: [],
			evidenceRefs: ["event:1"],
			uncertainties: [],
			nextAction: { kind: "read", target: "team.json", expectedResult: "Invalid state is rejected" },
			risk: "green",
			confidence: "L1",
		});
		state.workCheckpoints[0].status = "closed" as AnsteelWorkCheckpoint["status"];

		expect(() => getAnsteelTeamSharedBoard(state, listAnsteelTeamEvents(cwd))).toThrow("state-projection-mismatch");
	});

	it("counts open critical process issues as blockers", () => {
		const cwd = createTemporaryProject();
		const state = createTeam(cwd);
		const checkpoint = publishAnsteelWorkCheckpoint(cwd, state, "staff-engineer", {
			id: "CP-CRITICAL-0001",
			goal: "Protect the critical safety boundary",
			currentUnderstanding: "Critical issues must block affected work",
			assumptions: [],
			evidenceRefs: ["file:src/safety.ts:1"],
			uncertainties: [],
			nextAction: { kind: "edit", target: "src/safety.ts", expectedResult: "The boundary is enforced" },
			risk: "yellow",
			confidence: "L2",
		});
		raiseAnsteelProcessIssue(cwd, state, "qa-engineer", {
			id: "PI-CRITICAL-0001",
			targetCheckpointId: checkpoint.id,
			severity: "critical",
			claim: "The safety boundary is not enforced",
			evidenceRefs: ["test:safety-boundary"],
			suggestedCorrection: "Add a fail-closed boundary check",
		});

		const board = getAnsteelTeamSharedBoard(state, listAnsteelTeamEvents(cwd));

		expect(board.counts.blockingProcessIssues).toBe(1);
	});

	it("requires the issue author to verify a checkpoint correction", () => {
		const cwd = createTemporaryProject();
		const state = createTeam(cwd);
		const checkpointInput: AnsteelWorkCheckpointInput = {
			id: "CP-LEASE-0001",
			goal: "Prevent lease timestamp overflow",
			currentUnderstanding: "The sum must remain a safe integer",
			assumptions: ["clock and leaseMs are non-negative safe integers"],
			evidenceRefs: ["file:src/lease.ts:10"],
			uncertainties: ["Callers near MAX_SAFE_INTEGER"],
			nextAction: { kind: "edit", target: "src/lease.ts", expectedResult: "Overflow is rejected" },
			risk: "yellow",
			confidence: "L2",
		};
		const checkpoint = publishAnsteelWorkCheckpoint(cwd, state, "staff-engineer", checkpointInput);
		raiseAnsteelProcessIssue(cwd, state, "qa-engineer", {
			id: "PI-LEASE-0001",
			targetCheckpointId: checkpoint.id,
			severity: "blocking",
			claim: "Valid inputs can still produce an unsafe sum",
			evidenceRefs: ["test:lease-overflow"],
			suggestedCorrection: "Validate the calculated expiry",
		});
		publishAnsteelWorkCheckpoint(cwd, state, "staff-engineer", {
			...checkpointInput,
			id: "CP-LEASE-0002",
			currentUnderstanding: "The calculated expiry must also be a safe integer",
			evidenceRefs: ["test:lease-overflow"],
			supersedesCheckpointId: "CP-LEASE-0001",
		});
		resolveAnsteelProcessIssue(cwd, state, "staff-engineer", {
			id: "PR-LEASE-0001",
			issueId: "PI-LEASE-0001",
			outcome: "ACCEPTED",
			summary: "Validate expiry before persistence",
			evidenceRefs: ["diff:sha256:abc"],
			replacementCheckpointId: "CP-LEASE-0002",
		});

		expect(() =>
			reviewAnsteelProcessResolution(cwd, state, "tech-lead", "PI-LEASE-0001", {
				verdict: "accept",
				reason: "Looks good",
			}),
		).toThrow("issue author");

		reviewAnsteelProcessResolution(cwd, state, "qa-engineer", "PI-LEASE-0001", {
			verdict: "accept",
			reason: "The replacement checkpoint includes the overflow test",
		});
		expect(state.processIssues[0].status).toBe("closed");
	});

	it("keeps state and ledger unchanged when a role challenges its own checkpoint", () => {
		const cwd = createTemporaryProject();
		const state = createTeam(cwd);
		const checkpoint = publishAnsteelWorkCheckpoint(cwd, state, "staff-engineer", {
			id: "CP-SELF-0001",
			goal: "Inspect the parser boundary",
			currentUnderstanding: "The boundary needs a regression",
			assumptions: [],
			evidenceRefs: ["file:src/parser.ts:10"],
			uncertainties: [],
			nextAction: { kind: "test", target: "test/parser.test.ts", expectedResult: "Boundary is covered" },
			risk: "yellow",
			confidence: "L2",
		});
		const before = structuredClone(state);
		const eventCount = listAnsteelTeamEvents(cwd).length;

		expect(() =>
			raiseAnsteelProcessIssue(cwd, state, "staff-engineer", {
				id: "PI-SELF-0001",
				targetCheckpointId: checkpoint.id,
				severity: "blocking",
				claim: "The checkpoint is incomplete",
				evidenceRefs: ["test:self-review"],
				suggestedCorrection: "Ask a peer to review it",
			}),
		).toThrow("own checkpoint");
		expect(state).toEqual(before);
		expect(listAnsteelTeamEvents(cwd)).toHaveLength(eventCount);
	});

	it("rejects invalid resolution actors and outcomes without partial mutation", () => {
		const cwd = createTemporaryProject();
		const state = createTeam(cwd);
		const checkpoint = publishAnsteelWorkCheckpoint(cwd, state, "staff-engineer", {
			id: "CP-INVALID-0001",
			goal: "Validate lease expiry",
			currentUnderstanding: "Calculated expiry needs validation",
			assumptions: [],
			evidenceRefs: ["file:src/lease.ts:10"],
			uncertainties: [],
			nextAction: { kind: "test", target: "test/lease.test.ts", expectedResult: "Overflow is rejected" },
			risk: "yellow",
			confidence: "L2",
		});
		const issue = raiseAnsteelProcessIssue(cwd, state, "qa-engineer", {
			id: "PI-INVALID-0001",
			targetCheckpointId: checkpoint.id,
			severity: "blocking",
			claim: "The overflow case is missing",
			evidenceRefs: ["test:lease-overflow"],
			suggestedCorrection: "Add the overflow regression",
		});

		for (const attempt of [
			() =>
				resolveAnsteelProcessIssue(cwd, state, "tech-lead", {
					id: "PR-INVALID-ROLE",
					issueId: issue.id,
					outcome: "EXPERIMENT_REQUIRED",
					summary: "Run the overflow test",
					evidenceRefs: [],
					experiment: "Execute the boundary regression",
				}),
			() =>
				resolveAnsteelProcessIssue(cwd, state, "staff-engineer", {
					id: "PR-INVALID-ACCEPT",
					issueId: issue.id,
					outcome: "ACCEPTED",
					summary: "Accept without a replacement",
					evidenceRefs: ["diff:sha256:missing"],
				}),
			() =>
				resolveAnsteelProcessIssue(cwd, state, "staff-engineer", {
					id: "PR-INVALID-REFUTE",
					issueId: issue.id,
					outcome: "REFUTED",
					summary: "Repeat the existing evidence",
					evidenceRefs: ["test:lease-overflow"],
				}),
		]) {
			const before = structuredClone(state);
			const eventCount = listAnsteelTeamEvents(cwd).length;
			expect(attempt).toThrow();
			expect(state).toEqual(before);
			expect(listAnsteelTeamEvents(cwd)).toHaveLength(eventCount);
		}
	});

	it("rejects duplicate issue and resolution IDs", () => {
		const cwd = createTemporaryProject();
		const state = createTeam(cwd);
		const checkpoint = publishAnsteelWorkCheckpoint(cwd, state, "staff-engineer", {
			id: "CP-DUPLICATE-0001",
			goal: "Validate duplicate handling",
			currentUnderstanding: "Public IDs must be globally unique",
			assumptions: [],
			evidenceRefs: [],
			uncertainties: [],
			nextAction: { kind: "test", target: "test/ids.test.ts", expectedResult: "Duplicates are rejected" },
			risk: "green",
			confidence: "L1",
		});
		const issue = raiseAnsteelProcessIssue(cwd, state, "qa-engineer", {
			id: "PI-DUPLICATE-0001",
			targetCheckpointId: checkpoint.id,
			severity: "advisory",
			claim: "Duplicate IDs need a regression",
			evidenceRefs: ["test:duplicate-ids"],
			suggestedCorrection: "Add the regression",
		});

		expect(() =>
			raiseAnsteelProcessIssue(cwd, state, "tech-lead", {
				id: issue.id,
				targetCheckpointId: checkpoint.id,
				severity: "advisory",
				claim: "Reuse the issue ID",
				evidenceRefs: ["test:duplicate-issue"],
				suggestedCorrection: "Reject it",
			}),
		).toThrow("already exists");

		resolveAnsteelProcessIssue(cwd, state, "staff-engineer", {
			id: "PR-DUPLICATE-0001",
			issueId: issue.id,
			outcome: "EXPERIMENT_REQUIRED",
			summary: "Run a duplicate-ID test",
			evidenceRefs: [],
			experiment: "Run the public ID regression",
		});
		reviewAnsteelProcessResolution(cwd, state, "qa-engineer", issue.id, {
			verdict: "reject",
			reason: "The test output is still missing",
		});
		expect(() =>
			resolveAnsteelProcessIssue(cwd, state, "staff-engineer", {
				id: "PR-DUPLICATE-0001",
				issueId: issue.id,
				outcome: "REFUTED",
				summary: "Try to reuse the resolution ID",
				evidenceRefs: ["test:duplicate-result"],
			}),
		).toThrow("already exists");
	});

	it("records a rejected correction followed by a new accepted resolution as v2 events", () => {
		const cwd = createTemporaryProject();
		const state = createTeam(cwd);
		const checkpoint = publishAnsteelWorkCheckpoint(cwd, state, "staff-engineer", {
			id: "CP-RETRY-0001",
			goal: "Prevent unsafe lease expiry",
			currentUnderstanding: "The calculated expiry is not validated",
			assumptions: [],
			evidenceRefs: ["file:src/lease.ts:10"],
			uncertainties: ["The exact boundary"],
			nextAction: { kind: "experiment", target: "test/lease.test.ts", expectedResult: "Boundary is known" },
			risk: "yellow",
			confidence: "L3",
		});
		const issue = raiseAnsteelProcessIssue(cwd, state, "qa-engineer", {
			id: "PI-RETRY-0001",
			targetCheckpointId: checkpoint.id,
			severity: "blocking",
			claim: "No executable boundary evidence is present",
			evidenceRefs: ["test:lease-boundary"],
			suggestedCorrection: "Run and record the boundary regression",
		});
		resolveAnsteelProcessIssue(cwd, state, "staff-engineer", {
			id: "PR-RETRY-0001",
			issueId: issue.id,
			outcome: "EXPERIMENT_REQUIRED",
			summary: "Run the boundary regression",
			evidenceRefs: [],
			experiment: "Execute test/lease.test.ts at MAX_SAFE_INTEGER",
		});
		reviewAnsteelProcessResolution(cwd, state, "qa-engineer", issue.id, {
			verdict: "reject",
			reason: "The executable test result is still missing",
		});
		expect(state.processIssues[0].status).toBe("open");

		const replacement = publishAnsteelWorkCheckpoint(cwd, state, "staff-engineer", {
			id: "CP-RETRY-0002",
			goal: checkpoint.goal,
			currentUnderstanding: "The calculated expiry must remain a safe integer",
			assumptions: [],
			evidenceRefs: ["test:lease-boundary:passed"],
			uncertainties: [],
			nextAction: { kind: "edit", target: "src/lease.ts", expectedResult: "Unsafe expiry is rejected" },
			risk: "yellow",
			confidence: "L1",
			supersedesCheckpointId: checkpoint.id,
		});
		resolveAnsteelProcessIssue(cwd, state, "staff-engineer", {
			id: "PR-RETRY-0002",
			issueId: issue.id,
			outcome: "ACCEPTED",
			summary: "Validate calculated expiry before persistence",
			evidenceRefs: ["test:lease-boundary:passed"],
			replacementCheckpointId: replacement.id,
		});
		reviewAnsteelProcessResolution(cwd, state, "qa-engineer", issue.id, {
			verdict: "accept",
			reason: "The replacement checkpoint carries the passing boundary evidence",
		});

		expect(state.processIssues[0].status).toBe("closed");
		const events = listAnsteelTeamEvents(cwd);
		expect(events.map((event) => event.type)).toEqual([
			"work-checkpoint",
			"process-issue",
			"process-resolution",
			"process-resolution-review",
			"work-checkpoint",
			"process-resolution",
			"process-resolution-review",
		]);
		expect(events.every((event) => event.schemaVersion === 2 && event.payload !== undefined)).toBe(true);
	});

	it("enters escalation directly and rejects a modified v2 event history", () => {
		const cwd = createTemporaryProject();
		const state = createTeam(cwd);
		const checkpoint = publishAnsteelWorkCheckpoint(cwd, state, "staff-engineer", {
			id: "CP-ESCALATE-0001",
			goal: "Decide whether the public API may change",
			currentUnderstanding: "The fix requires a scope decision",
			assumptions: [],
			evidenceRefs: ["file:src/api.ts:10"],
			uncertainties: ["Compatibility policy"],
			nextAction: { kind: "decision", target: "API scope", expectedResult: "Scope owner decides" },
			risk: "red",
			confidence: "L2",
		});
		const issue = raiseAnsteelProcessIssue(cwd, state, "qa-engineer", {
			id: "PI-ESCALATE-0001",
			targetCheckpointId: checkpoint.id,
			severity: "critical",
			claim: "The proposed edit changes the public API",
			evidenceRefs: ["diff:public-api"],
			suggestedCorrection: "Escalate the scope decision",
		});
		resolveAnsteelProcessIssue(cwd, state, "staff-engineer", {
			id: "PR-ESCALATE-0001",
			issueId: issue.id,
			outcome: "SCOPE_ESCALATION",
			summary: "The API owner must decide the compatibility policy",
			evidenceRefs: ["diff:public-api"],
		});
		expect(state.processIssues[0].status).toBe("escalated");

		const path = getAnsteelTeamEventPath(cwd);
		const lines = readFileSync(path, "utf8").trimEnd().split("\n");
		const first = JSON.parse(lines[0]) as Record<string, unknown>;
		first.content = "Modified historical checkpoint";
		lines[0] = JSON.stringify(first);
		writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
		expect(() => listAnsteelTeamEvents(cwd)).toThrow("hash mismatch");
	});

	it("migrates v6 teams to empty public collaboration state without changing existing state", () => {
		const cwd = createTemporaryProject();
		const state = createTeam(cwd);
		claimAnsteelTeamTask(cwd, state, {
			id: "TASK-PARSER",
			owner: "staff-engineer",
			files: ["src/parser.ts"],
			description: "Reject malformed parser input.",
			acceptanceCriteria: "The parser regression passes.",
		});
		const statePath = getAnsteelTeamStatePath(cwd);
		const legacy = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
		legacy.version = 6;
		delete legacy.workCheckpoints;
		delete legacy.processIssues;
		const preserved = {
			tasks: structuredClone(legacy.tasks),
			milestones: structuredClone(legacy.milestones),
			roles: structuredClone(legacy.roles),
			ledgerHeadHash: legacy.ledgerHeadHash,
			nextEventSequence: legacy.nextEventSequence,
		};
		writePersistedTeamState(cwd, legacy);

		const migrated = loadAnsteelTeamState(cwd);
		const persisted = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;

		expect(migrated).toMatchObject({
			version: 7,
			workCheckpoints: [],
			processIssues: [],
			...preserved,
		});
		expect(persisted).toMatchObject({
			version: 7,
			workCheckpoints: [],
			processIssues: [],
			...preserved,
		});
	});

	it("loads a valid public collaboration state", () => {
		const cwd = createTemporaryProject();
		writePersistedTeamState(cwd, createValidPublicCollaborationState(cwd));

		expect(loadAnsteelTeamState(cwd)).toMatchObject({
			version: 7,
			workCheckpoints: [{ id: "CP-PARSER-0001" }],
			processIssues: [{ id: "PI-PARSER-0001" }],
		});
	});

	it("rejects duplicate checkpoint IDs", () => {
		const cwd = createTemporaryProject();
		const state = createValidPublicCollaborationState(cwd);
		const checkpoints = state.workCheckpoints as Array<Record<string, unknown>>;
		checkpoints.push({ ...checkpoints[0], createdAt: "2026-07-24T00:04:00.000Z" });
		writePersistedTeamState(cwd, state);

		expect(() => loadAnsteelTeamState(cwd)).toThrow("checkpoint CP-PARSER-0001 is duplicated");
	});

	it("rejects process issues that target an unknown checkpoint", () => {
		const cwd = createTemporaryProject();
		const state = createValidPublicCollaborationState(cwd);
		const issues = state.processIssues as Array<Record<string, unknown>>;
		issues[0].targetCheckpointId = "CP-UNKNOWN-0001";
		writePersistedTeamState(cwd, state);

		expect(() => loadAnsteelTeamState(cwd)).toThrow("references unknown checkpoint CP-UNKNOWN-0001");
	});

	it("rejects checkpoint confidence outside L1 through L4", () => {
		const cwd = createTemporaryProject();
		const state = createValidPublicCollaborationState(cwd);
		const checkpoints = state.workCheckpoints as Array<Record<string, unknown>>;
		checkpoints[0].confidence = "L0";
		writePersistedTeamState(cwd, state);

		expect(() => loadAnsteelTeamState(cwd)).toThrow("checkpoint CP-PARSER-0001 has invalid confidence");
	});

	it("rejects resolutions written by a role other than the issue target", () => {
		const cwd = createTemporaryProject();
		const state = createValidPublicCollaborationState(cwd);
		const issues = state.processIssues as Array<Record<string, unknown>>;
		const resolutions = issues[0].resolutions as Array<Record<string, unknown>>;
		resolutions[0].actor = "tech-lead";
		writePersistedTeamState(cwd, state);

		expect(() => loadAnsteelTeamState(cwd)).toThrow("resolution PR-PARSER-0001 must be written by staff-engineer");
	});

	it.each([
		{
			name: "checkpoint IDs outside CP-<UPPERCASE-ID>",
			mutate(state: Record<string, unknown>) {
				const checkpoints = state.workCheckpoints as Array<Record<string, unknown>>;
				checkpoints[0].id = "cp-parser-0001";
			},
			message: "checkpoint IDs must use the CP-<UPPERCASE-ID> form",
		},
		{
			name: "process issue IDs outside PI-<UPPERCASE-ID>",
			mutate(state: Record<string, unknown>) {
				const issues = state.processIssues as Array<Record<string, unknown>>;
				issues[0].id = "pi-parser-0001";
			},
			message: "process issue IDs must use the PI-<UPPERCASE-ID> form",
		},
		{
			name: "process resolution IDs outside PR-<UPPERCASE-ID>",
			mutate(state: Record<string, unknown>) {
				const issues = state.processIssues as Array<Record<string, unknown>>;
				const resolutions = issues[0].resolutions as Array<Record<string, unknown>>;
				resolutions[0].id = "pr-parser-0001";
			},
			message: "process resolution IDs must use the PR-<UPPERCASE-ID> form",
		},
		{
			name: "unknown task references",
			mutate(state: Record<string, unknown>) {
				const checkpoints = state.workCheckpoints as Array<Record<string, unknown>>;
				checkpoints[0].taskId = "TASK-UNKNOWN";
			},
			message: "references unknown task TASK-UNKNOWN",
		},
		{
			name: "checkpoint actors that do not own the referenced task",
			mutate(state: Record<string, unknown>) {
				const checkpoints = state.workCheckpoints as Array<Record<string, unknown>>;
				checkpoints[0].taskId = "TASK-PARSER";
				(state.tasks as Array<Record<string, unknown>>).push({
					id: "TASK-PARSER",
					owner: "qa-engineer",
					files: ["src/parser.ts"],
					description: "Reject malformed parser input.",
					acceptanceCriteria: "The parser regression passes.",
					dependsOn: [],
					status: "claimed",
					revision: 0,
					testEvidence: [],
					submissions: [],
					reviews: [],
				});
			},
			message: "must be written by task owner qa-engineer",
		},
		{
			name: "unknown superseded checkpoints",
			mutate(state: Record<string, unknown>) {
				const checkpoints = state.workCheckpoints as Array<Record<string, unknown>>;
				checkpoints[0].supersedesCheckpointId = "CP-UNKNOWN-0001";
			},
			message: "supersedes unknown checkpoint CP-UNKNOWN-0001",
		},
		{
			name: "superseded checkpoints from another role",
			mutate(state: Record<string, unknown>) {
				const checkpoints = state.workCheckpoints as Array<Record<string, unknown>>;
				checkpoints.push({
					...checkpoints[0],
					id: "CP-PARSER-0002",
					actor: "qa-engineer",
					supersedesCheckpointId: "CP-PARSER-0001",
					createdAt: "2026-07-24T00:04:00.000Z",
				});
			},
			message: "must supersede a checkpoint from the same role",
		},
		{
			name: "issues authored by the checkpoint actor",
			mutate(state: Record<string, unknown>) {
				const issues = state.processIssues as Array<Record<string, unknown>>;
				issues[0].author = "staff-engineer";
			},
			message: "cannot be written by the checkpoint actor",
		},
		{
			name: "issue target roles that differ from the checkpoint actor",
			mutate(state: Record<string, unknown>) {
				const issues = state.processIssues as Array<Record<string, unknown>>;
				issues[0].targetRole = "tech-lead";
			},
			message: "must target checkpoint actor staff-engineer",
		},
		{
			name: "resolution reviews written by anyone except the issue author",
			mutate(state: Record<string, unknown>) {
				const issues = state.processIssues as Array<Record<string, unknown>>;
				const resolutions = issues[0].resolutions as Array<Record<string, unknown>>;
				(resolutions[0].review as Record<string, unknown>).reviewer = "tech-lead";
			},
			message: "must be reviewed by qa-engineer",
		},
		{
			name: "resolutions that reference a different issue",
			mutate(state: Record<string, unknown>) {
				const issues = state.processIssues as Array<Record<string, unknown>>;
				const resolutions = issues[0].resolutions as Array<Record<string, unknown>>;
				resolutions[0].issueId = "PI-OTHER-0001";
			},
			message: "must reference containing issue PI-PARSER-0001",
		},
		{
			name: "resolutions that reference an unknown replacement checkpoint",
			mutate(state: Record<string, unknown>) {
				const issues = state.processIssues as Array<Record<string, unknown>>;
				const resolutions = issues[0].resolutions as Array<Record<string, unknown>>;
				resolutions[0].replacementCheckpointId = "CP-UNKNOWN-0001";
			},
			message: "references unknown replacement checkpoint CP-UNKNOWN-0001",
		},
		{
			name: "closed issues without an accepted resolution",
			mutate(state: Record<string, unknown>) {
				const issues = state.processIssues as Array<Record<string, unknown>>;
				const resolutions = issues[0].resolutions as Array<Record<string, unknown>>;
				(resolutions[0].review as Record<string, unknown>).verdict = "reject";
			},
			message: "closed without an accepted resolution",
		},
		{
			name: "escalated issues without a scope-escalation resolution",
			mutate(state: Record<string, unknown>) {
				const issues = state.processIssues as Array<Record<string, unknown>>;
				issues[0].status = "escalated";
			},
			message: "escalated without a SCOPE_ESCALATION resolution",
		},
		{
			name: "duplicate resolution IDs across issues",
			mutate(state: Record<string, unknown>) {
				const issues = state.processIssues as Array<Record<string, unknown>>;
				const duplicate = structuredClone(issues[0]);
				duplicate.id = "PI-PARSER-0002";
				(duplicate.resolutions as Array<Record<string, unknown>>)[0].issueId = "PI-PARSER-0002";
				issues.push(duplicate);
			},
			message: "resolution PR-PARSER-0001 is duplicated",
		},
	])("rejects $name", ({ mutate, message }) => {
		const cwd = createTemporaryProject();
		const state = createValidPublicCollaborationState(cwd);
		mutate(state);
		writePersistedTeamState(cwd, state);

		expect(() => loadAnsteelTeamState(cwd)).toThrow(message);
	});
});

describe("Ansteel team state", () => {
	it("persists an active team with one independent role session slot per role", () => {
		const cwd = createTemporaryProject();
		const team = createTeam(cwd);

		saveAnsteelTeamState(cwd, team);

		expect(loadAnsteelTeamState(cwd)).toEqual(team);
		expect(team.status).toBe("active");
		expect(team.nextEventSequence).toBe(1);
		expect(Object.keys(team.roles)).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
		expect(team.roles["qa-engineer"].model).toBe("provider-c/model-c");
		expect(team.tasks).toEqual([]);
		expect(team).toMatchObject({ taskOwners: ["staff-engineer"] });
	});

	it("migrates a persisted version 1 team with an empty task and hashed event ledger", () => {
		const cwd = createTemporaryProject();
		const team = createTeam(cwd);
		const legacyTeam = { ...team, version: 1 } as Record<string, unknown>;
		delete legacyTeam.tasks;
		delete legacyTeam.ledgerHeadHash;
		mkdirSync(join(cwd, ".pi", "ansteel-team"), { recursive: true });
		writeFileSync(getAnsteelTeamStatePath(cwd), `${JSON.stringify(legacyTeam)}\n`, "utf8");

		const migrated = loadAnsteelTeamState(cwd);

		expect(migrated).toMatchObject({
			version: 7,
			tasks: [],
			milestones: [],
			workCheckpoints: [],
			processIssues: [],
			ledgerHeadHash: null,
		});
		expect(migrated?.roles).toEqual(team.roles);
	});

	it("migrates a contiguous legacy event ledger into a persisted hash chain", () => {
		const cwd = createTemporaryProject();
		const team = createTeam(cwd);
		const legacyTeam = { ...team, version: 1, nextEventSequence: 2 } as Record<string, unknown>;
		delete legacyTeam.tasks;
		delete legacyTeam.ledgerHeadHash;
		mkdirSync(join(cwd, ".pi", "ansteel-team"), { recursive: true });
		writeFileSync(getAnsteelTeamStatePath(cwd), `${JSON.stringify(legacyTeam)}\n`, "utf8");
		writeFileSync(
			getAnsteelTeamEventPath(cwd),
			`${JSON.stringify({
				sequence: 1,
				type: "role-report",
				role: "tech-lead",
				content: "L1: inspected the legacy parser implementation.",
				createdAt: "2026-07-24T00:00:00.000Z",
			})}\n`,
			"utf8",
		);

		const migrated = loadAnsteelTeamState(cwd);
		const events = listAnsteelTeamEvents(cwd);
		const persistedState = JSON.parse(readFileSync(getAnsteelTeamStatePath(cwd), "utf8")) as Record<string, unknown>;
		const persistedEvent = JSON.parse(readFileSync(getAnsteelTeamEventPath(cwd), "utf8")) as Record<string, unknown>;

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			sequence: 1,
			previousHash: null,
			hash: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(migrated).toMatchObject({ version: 7, ledgerHeadHash: events[0]?.hash, nextEventSequence: 2 });
		expect(persistedState).toMatchObject({ version: 7, ledgerHeadHash: events[0]?.hash });
		expect(persistedEvent).toMatchObject({ previousHash: null, hash: events[0]?.hash });
	});

	it("migrates a version 3 team to an explicit persisted legacy task-owner policy", () => {
		const cwd = createTemporaryProject();
		const team = createTeam(cwd);
		const legacyTeam = { ...team, version: 3 } as Record<string, unknown>;
		delete legacyTeam.taskOwners;
		mkdirSync(join(cwd, ".pi", "ansteel-team"), { recursive: true });
		writeFileSync(getAnsteelTeamStatePath(cwd), `${JSON.stringify(legacyTeam)}\n`, "utf8");

		const migrated = loadAnsteelTeamState(cwd);
		const persistedState = JSON.parse(readFileSync(getAnsteelTeamStatePath(cwd), "utf8")) as Record<string, unknown>;

		expect(migrated).toMatchObject({ version: 7, taskOwners: ["tech-lead", "staff-engineer", "qa-engineer"] });
		expect(persistedState).toMatchObject({
			version: 7,
			taskOwners: ["tech-lead", "staff-engineer", "qa-engineer"],
		});
	});

	it("rejects a mixed legacy and hashed event ledger during migration", () => {
		const cwd = createTemporaryProject();
		const team = createTeam(cwd);
		const legacyTeam = { ...team, version: 2, nextEventSequence: 3 } as Record<string, unknown>;
		delete legacyTeam.ledgerHeadHash;
		mkdirSync(join(cwd, ".pi", "ansteel-team"), { recursive: true });
		writeFileSync(getAnsteelTeamStatePath(cwd), `${JSON.stringify(legacyTeam)}\n`, "utf8");
		writeFileSync(
			getAnsteelTeamEventPath(cwd),
			`${[
				JSON.stringify({
					sequence: 1,
					type: "role-report",
					role: "tech-lead",
					content: "L1: legacy event.",
					createdAt: "2026-07-24T00:00:00.000Z",
				}),
				JSON.stringify({
					sequence: 2,
					type: "role-report",
					role: "qa-engineer",
					content: "L1: malformed mixed event.",
					createdAt: "2026-07-24T00:01:00.000Z",
					previousHash: "0".repeat(64),
				}),
			].join("\n")}\n`,
			"utf8",
		);

		expect(() => loadAnsteelTeamState(cwd)).toThrow("mixed legacy and hashed");
	});

	it("appends public events in sequence and advances the persisted state", () => {
		const cwd = createTemporaryProject();
		const team = createTeam(cwd);
		saveAnsteelTeamState(cwd, team);

		const report = appendAnsteelTeamEvent(cwd, team, {
			type: "role-report",
			role: "staff-engineer",
			content: "L1: package test output is green.",
		});
		const challenge = appendAnsteelTeamEvent(cwd, team, {
			type: "challenge",
			role: "qa-engineer",
			targetRole: "staff-engineer",
			challengeId: "QA-1",
			content: "Add a regression for malformed input.",
		});

		expect(report.sequence).toBe(1);
		expect(challenge.sequence).toBe(2);
		expect(loadAnsteelTeamState(cwd)?.nextEventSequence).toBe(3);
		expect(listAnsteelTeamEvents(cwd)).toEqual([report, challenge]);
		expect(readFileSync(getAnsteelTeamEventPath(cwd), "utf8").trim().split("\n")).toHaveLength(2);
	});

	it("allows the coordinator to assign a task without becoming a review role", () => {
		const cwd = createTemporaryProject();
		const team = createTeam(cwd);

		const assigned = appendAnsteelTeamEvent(cwd, team, {
			type: "task-assigned",
			role: "coordinator",
			targetRole: "staff-engineer",
			content: "TASK-PARSER assigned to staff-engineer",
		});

		expect(assigned).toMatchObject({
			type: "task-assigned",
			role: "coordinator",
			targetRole: "staff-engineer",
		});
		expect(() =>
			appendAnsteelTeamEvent(cwd, team, {
				type: "role-report",
				role: "coordinator",
				content: "invalid fourth reviewer",
			}),
		).toThrow("coordinator");
	});

	it("recovers an interrupted event transaction whether the ledger append happened or not", () => {
		const cwd = createTemporaryProject();
		const team = createTeam(cwd);
		saveAnsteelTeamState(cwd, team);
		const before = readFileSync(getAnsteelTeamStatePath(cwd), "utf8");
		const event = appendAnsteelTeamEvent(cwd, team, {
			type: "role-report",
			role: "tech-lead",
			content: "L1: captured recoverable state.",
		});
		const candidate = readFileSync(getAnsteelTeamStatePath(cwd), "utf8");
		writeFileSync(getAnsteelTeamStatePath(cwd), before, "utf8");
		writeFileSync(
			getAnsteelTeamTransactionPath(cwd),
			`${JSON.stringify({ state: JSON.parse(candidate), event })}\n`,
			"utf8",
		);

		expect(loadAnsteelTeamState(cwd)).toMatchObject({ nextEventSequence: 2, ledgerHeadHash: event.hash });
		expect(() => readFileSync(getAnsteelTeamTransactionPath(cwd), "utf8")).toThrow();

		writeFileSync(getAnsteelTeamEventPath(cwd), "", "utf8");
		writeFileSync(getAnsteelTeamStatePath(cwd), before, "utf8");
		writeFileSync(
			getAnsteelTeamTransactionPath(cwd),
			`${JSON.stringify({ state: JSON.parse(candidate), event })}\n`,
			"utf8",
		);

		expect(loadAnsteelTeamState(cwd)).toMatchObject({ nextEventSequence: 2, ledgerHeadHash: event.hash });
		expect(listAnsteelTeamEvents(cwd)).toEqual([event]);
	});

	it("links event hashes and rejects a tampered event ledger", () => {
		const cwd = createTemporaryProject();
		const team = createTeam(cwd);
		saveAnsteelTeamState(cwd, team);

		const first = appendAnsteelTeamEvent(cwd, team, {
			type: "role-report",
			role: "tech-lead",
			content: "L1: inspected the parser implementation.",
		});
		const second = appendAnsteelTeamEvent(cwd, team, {
			type: "role-report",
			role: "qa-engineer",
			content: "L1: reviewed the test evidence.",
		});

		expect(first.previousHash).toBeNull();
		expect(second.previousHash).toBe(first.hash);
		expect(team.ledgerHeadHash).toBe(second.hash);

		const eventPath = getAnsteelTeamEventPath(cwd);
		const events = readFileSync(eventPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		events[1].content = "L1: rewritten after review.";
		writeFileSync(eventPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

		expect(() => listAnsteelTeamEvents(cwd)).toThrow("hash mismatch");
	});

	it("rejects a persisted state whose ledger head does not match the event chain", () => {
		const cwd = createTemporaryProject();
		const team = createTeam(cwd);
		saveAnsteelTeamState(cwd, team);
		appendAnsteelTeamEvent(cwd, team, {
			type: "role-report",
			role: "tech-lead",
			content: "L1: inspected the parser implementation.",
		});

		const statePath = getAnsteelTeamStatePath(cwd);
		const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
		state.ledgerHeadHash = "0".repeat(64);
		writeFileSync(statePath, `${JSON.stringify(state)}\n`, "utf8");

		expect(() => loadAnsteelTeamState(cwd)).toThrow("ledger head hash");
	});

	it("requires an owner to claim exact in-project files before a change task is active", () => {
		const cwd = createTemporaryProject();
		const team = createTeam(cwd);

		const task = claimAnsteelTeamTask(cwd, team, {
			id: "TASK-1",
			owner: "staff-engineer",
			files: ["src/parser.ts", "test/parser.test.ts"],
			description: "Handle empty parser input.",
			acceptanceCriteria: "The targeted parser test passes.",
		});

		expect(task).toMatchObject({
			id: "TASK-1",
			owner: "staff-engineer",
			files: ["src/parser.ts", "test/parser.test.ts"],
			status: "claimed",
		});
		expect(() =>
			claimAnsteelTeamTask(cwd, team, {
				id: "TASK-2",
				owner: "staff-engineer",
				files: ["src/parser.ts"],
				description: "Competing change.",
				acceptanceCriteria: "No conflict.",
			}),
		).toThrow("already claimed");
		expect(() =>
			claimAnsteelTeamTask(cwd, team, {
				id: "TASK-3",
				owner: "staff-engineer",
				files: ["../outside.ts"],
				description: "Escaping change.",
				acceptanceCriteria: "Never runs.",
			}),
		).toThrow("must stay inside the project");
		expect(getAnsteelTeamWriteBlockReason(cwd, team, "staff-engineer", "src/parser.ts")).toBeUndefined();
		expect(getAnsteelTeamWriteBlockReason(cwd, team, "qa-engineer", "src/parser.ts")).toContain("must be claimed");
	});

	it("allows only Staff Engineer to claim change tasks by default", () => {
		const cwd = createTemporaryProject();
		const team = createTeam(cwd);

		expect(
			claimAnsteelTeamTask(cwd, team, {
				id: "TASK-STAFF",
				owner: "staff-engineer",
				files: ["src/staff.ts"],
				description: "Implement the scoped change.",
				acceptanceCriteria: "The targeted test passes.",
			}),
		).toMatchObject({ owner: "staff-engineer", status: "claimed" });

		expect(() =>
			claimAnsteelTeamTask(cwd, team, {
				id: "TASK-TL",
				owner: "tech-lead",
				files: ["src/lead.ts"],
				description: "Implement an unapproved change.",
				acceptanceCriteria: "The targeted test passes.",
			}),
		).toThrow("is not authorized to claim change tasks");
	});

	it("changes the task progress fingerprint only when governed task evidence changes", () => {
		const cwd = createTemporaryProject();
		initializeGitProject(cwd);
		const team = createTeam(cwd);
		claimAnsteelTeamTask(cwd, team, {
			id: "TASK-PARSER",
			owner: "staff-engineer",
			files: ["src/parser.ts"],
			description: "Update the parser.",
			acceptanceCriteria: "The parser test passes.",
		});
		const before = getAnsteelTeamTaskProgressFingerprint(cwd, team, "TASK-PARSER");

		writeFileSync(join(cwd, "unrelated.txt"), "not governed\n", "utf8");
		expect(getAnsteelTeamTaskProgressFingerprint(cwd, team, "TASK-PARSER")).toBe(before);

		writeFileSync(join(cwd, "src", "parser.ts"), "export const parser = 'after';\n", "utf8");
		const after = getAnsteelTeamTaskProgressFingerprint(cwd, team, "TASK-PARSER");
		expect(after).not.toBe(before);
		expect(getAnsteelTeamTaskProgressFingerprint(cwd, team, "TASK-PARSER")).toBe(after);
	});

	it("allows an explicitly authorized Tech Lead to claim a change task", () => {
		const cwd = createTemporaryProject();
		const team = createTeam(cwd);

		expect(
			claimAnsteelTeamTask(
				cwd,
				team,
				{
					id: "TASK-TL",
					owner: "tech-lead",
					files: ["src/lead.ts"],
					description: "Implement an explicitly authorized change.",
					acceptanceCriteria: "The targeted test passes.",
				},
				["staff-engineer", "tech-lead"],
			),
		).toMatchObject({ owner: "tech-lead", status: "claimed" });
	});

	it("derives a dependent task's lock and release from approved predecessors", () => {
		const cwd = createTemporaryProject();
		initializeGitProject(cwd);
		const team = createTeam(cwd);
		const predecessor = claimAnsteelTeamTask(cwd, team, {
			id: "TASK-PARSER",
			owner: "staff-engineer",
			files: ["src/parser.ts"],
			description: "Implement the parser boundary.",
			acceptanceCriteria: "The parser test passes.",
		});
		const dependent = claimAnsteelTeamTask(cwd, team, {
			id: "TASK-INTEGRATION",
			owner: "staff-engineer",
			files: ["src/integration.ts"],
			description: "Integrate the approved parser boundary.",
			acceptanceCriteria: "The integration test passes.",
			dependsOn: ["TASK-PARSER"],
		});

		expect(dependent).toMatchObject({ dependsOn: ["TASK-PARSER"], status: "blocked" });
		expect(getAnsteelTeamWriteBlockReason(cwd, team, "staff-engineer", "src/integration.ts")).toContain(
			"waiting for approved dependencies",
		);

		writeFileSync(join(cwd, "src", "parser.ts"), "export const parser = 'after';\n", "utf8");
		recordAnsteelTeamTaskTestResult(cwd, team, "staff-engineer", predecessor.id, {
			command: "npm test -- parser",
			output: "PASS parser boundary",
			isError: false,
		});
		submitAnsteelTeamTask(cwd, team, "staff-engineer", predecessor.id, "npm test -- parser");
		reviewAnsteelTeamTask(cwd, team, "tech-lead", predecessor.id, { verdict: "approve" });
		reviewAnsteelTeamTask(cwd, team, "qa-engineer", predecessor.id, { verdict: "approve" });

		expect(dependent.status).toBe("claimed");
		expect(getAnsteelTeamWriteBlockReason(cwd, team, "staff-engineer", "src/integration.ts")).toBeUndefined();

		predecessor.status = "revision-required";
		expect(() => saveAnsteelTeamState(cwd, team)).toThrow("is unblocked before its dependencies are approved");
	});

	it("rejects unknown, self-referential, and cyclic task dependencies", () => {
		const cwd = createTemporaryProject();
		const team = createTeam(cwd);

		expect(() =>
			claimAnsteelTeamTask(cwd, team, {
				id: "TASK-UNKNOWN",
				owner: "staff-engineer",
				files: ["src/unknown.ts"],
				description: "Depend on a missing task.",
				acceptanceCriteria: "Never runs.",
				dependsOn: ["TASK-MISSING"],
			}),
		).toThrow("depends on unknown task TASK-MISSING");
		expect(() =>
			claimAnsteelTeamTask(cwd, team, {
				id: "TASK-SELF",
				owner: "staff-engineer",
				files: ["src/self.ts"],
				description: "Depend on itself.",
				acceptanceCriteria: "Never runs.",
				dependsOn: ["TASK-SELF"],
			}),
		).toThrow("cannot depend on itself");

		const first = claimAnsteelTeamTask(cwd, team, {
			id: "TASK-FIRST",
			owner: "staff-engineer",
			files: ["src/first.ts"],
			description: "First task.",
			acceptanceCriteria: "Never runs.",
		});
		const second = claimAnsteelTeamTask(cwd, team, {
			id: "TASK-SECOND",
			owner: "staff-engineer",
			files: ["src/second.ts"],
			description: "Second task.",
			acceptanceCriteria: "Never runs.",
		});
		(first as typeof first & { dependsOn: string[] }).dependsOn = [second.id];
		(second as typeof second & { dependsOn: string[] }).dependsOn = [first.id];

		expect(() => saveAnsteelTeamState(cwd, team)).toThrow("task dependency cycle");
	});

	it("requires task approval, a real integration test, and two independent milestone reviews", () => {
		const cwd = createTemporaryProject();
		initializeGitProject(cwd);
		mkdirSync(join(cwd, "test"), { recursive: true });
		writeFileSync(
			join(cwd, "test", "integration.test.mjs"),
			"import test from 'node:test';\ntest('integration', () => {});\n",
			"utf8",
		);
		const team = createTeam(cwd);
		const task = claimAnsteelTeamTask(cwd, team, {
			id: "TASK-PARSER",
			owner: "staff-engineer",
			files: ["src/parser.ts"],
			description: "Implement the parser boundary.",
			acceptanceCriteria: "The parser test passes.",
		});
		const milestone = createAnsteelTeamMilestone(cwd, team, {
			id: "MILESTONE-PARSER-INTEGRATION",
			taskIds: [task.id],
			description: "Integrate the parser boundary with the application.",
			acceptanceCriteria: "The integration test passes and both independent reviewers approve.",
		});

		expect(milestone.status).toBe("blocked");
		expect(() =>
			runAnsteelTeamMilestoneTest(cwd, team, "tech-lead", milestone.id, "node --test test/integration.test.mjs"),
		).toThrow("is waiting for approved tasks");

		writeFileSync(join(cwd, "src", "parser.ts"), "export const parser = 'after';\n", "utf8");
		recordAnsteelTeamTaskTestResult(cwd, team, "staff-engineer", task.id, {
			command: "npm test -- parser",
			output: "PASS parser boundary",
			isError: false,
		});
		submitAnsteelTeamTask(cwd, team, "staff-engineer", task.id, "npm test -- parser");
		reviewAnsteelTeamTask(cwd, team, "tech-lead", task.id, { verdict: "approve" });
		reviewAnsteelTeamTask(cwd, team, "qa-engineer", task.id, { verdict: "approve" });

		expect(milestone.status).toBe("ready");
		const evidence = runAnsteelTeamMilestoneTest(
			cwd,
			team,
			"tech-lead",
			milestone.id,
			"node --test test/integration.test.mjs",
		);
		expect(evidence).toMatchObject({ isError: false, command: "node --test test/integration.test.mjs" });
		const submission = submitAnsteelTeamMilestone(
			cwd,
			team,
			"tech-lead",
			milestone.id,
			"node --test test/integration.test.mjs",
		);
		expect(submission.test.output).toMatch(/pass 1/i);
		reviewAnsteelTeamMilestone(cwd, team, "staff-engineer", milestone.id, { verdict: "approve" });
		reviewAnsteelTeamMilestone(cwd, team, "qa-engineer", milestone.id, { verdict: "approve" });

		expect(milestone.status).toBe("approved");
	});

	it("submits an immutable scoped diff only after a successful recorded test", () => {
		const cwd = createTemporaryProject();
		initializeGitProject(cwd);
		const team = createTeam(cwd);
		const task = claimAnsteelTeamTask(cwd, team, {
			id: "TASK-1",
			owner: "staff-engineer",
			files: ["src/parser.ts"],
			description: "Handle empty parser input.",
			acceptanceCriteria: "The targeted parser test passes.",
		});
		writeFileSync(join(cwd, "src", "parser.ts"), "export const parser = 'after';\n", "utf8");

		recordAnsteelTeamTaskTestResult(cwd, team, "staff-engineer", task.id, {
			command: "npm test -- parser",
			output: "PASS parser handles empty input",
			isError: false,
		});
		const submission = submitAnsteelTeamTask(cwd, team, "staff-engineer", task.id, "npm test -- parser");

		expect(submission.diff).toContain("parser = 'after'");
		expect(submission.test).toMatchObject({ command: "npm test -- parser", isError: false });
		expect(task.status).toBe("submitted");
		expect(getAnsteelTeamWriteBlockReason(cwd, team, "staff-engineer", "src/parser.ts")).toContain("code is frozen");
	});

	it("runs a bounded allowed test command and records its real output", () => {
		const cwd = createTemporaryProject();
		mkdirSync(join(cwd, "test"), { recursive: true });
		writeFileSync(
			join(cwd, "test", "task.test.mjs"),
			"import test from 'node:test';\ntest('ok', () => {});\n",
			"utf8",
		);
		const team = createTeam(cwd);
		const task = claimAnsteelTeamTask(cwd, team, {
			id: "TASK-1",
			owner: "staff-engineer",
			files: ["src/parser.ts"],
			description: "Handle empty parser input.",
			acceptanceCriteria: "The targeted parser test passes.",
		});

		const test = runAnsteelTeamTaskTest(cwd, team, "staff-engineer", task.id, "node --test test/task.test.mjs");

		expect(test.isError).toBe(false);
		expect(test.output).toMatch(/pass 1/i);
	});

	it("returns a submitted change for revision when QA rejects and approves only after both peers agree", () => {
		const cwd = createTemporaryProject();
		initializeGitProject(cwd);
		const team = createTeam(cwd);
		const task = claimAnsteelTeamTask(cwd, team, {
			id: "TASK-1",
			owner: "staff-engineer",
			files: ["src/parser.ts"],
			description: "Handle empty parser input.",
			acceptanceCriteria: "The targeted parser test passes.",
		});
		writeFileSync(join(cwd, "src", "parser.ts"), "export const parser = 'first';\n", "utf8");
		recordAnsteelTeamTaskTestResult(cwd, team, "staff-engineer", task.id, {
			command: "npm test -- parser",
			output: "PASS first revision",
			isError: false,
		});
		submitAnsteelTeamTask(cwd, team, "staff-engineer", task.id, "npm test -- parser");

		reviewAnsteelTeamTask(cwd, team, "tech-lead", task.id, { verdict: "approve" });
		reviewAnsteelTeamTask(cwd, team, "qa-engineer", task.id, {
			verdict: "reject",
			issue: "QA-1: empty input remains untested.",
		});
		expect(task.status).toBe("revision-required");

		writeFileSync(join(cwd, "src", "parser.ts"), "export const parser = 'second';\n", "utf8");
		recordAnsteelTeamTaskTestResult(cwd, team, "staff-engineer", task.id, {
			command: "npm test -- parser",
			output: "PASS revised parser",
			isError: false,
		});
		submitAnsteelTeamTask(cwd, team, "staff-engineer", task.id, "npm test -- parser");
		reviewAnsteelTeamTask(cwd, team, "tech-lead", task.id, { verdict: "approve" });
		reviewAnsteelTeamTask(cwd, team, "qa-engineer", task.id, { verdict: "approve" });

		expect(task.status).toBe("approved");
		expect(task.submissions).toHaveLength(2);
	});

	it("closes an open challenge only through a matching resolution event", () => {
		const cwd = createTemporaryProject();
		const team = createTeam(cwd);

		appendAnsteelTeamEvent(cwd, team, {
			type: "challenge",
			role: "staff-engineer",
			targetRole: "tech-lead",
			challengeId: "STAFF-1",
			content: "Clarify the transaction boundary.",
		});
		expect(team.openChallenges).toEqual([
			{
				id: "STAFF-1",
				raisedBy: "staff-engineer",
				targetRole: "tech-lead",
				status: "open",
			},
		]);

		appendAnsteelTeamEvent(cwd, team, {
			type: "resolution",
			role: "tech-lead",
			challengeId: "STAFF-1",
			content: "The boundary is documented and covered by a test.",
		});

		expect(team.openChallenges[0]?.status).toBe("resolved");
	});

	it("records ledger append, fsync, and state persistence under one trace", () => {
		const cwd = createTemporaryProject();
		const team = createTeam(cwd);
		const context = createAnsteelRunContext({ teamId: team.id, command: "ask" });
		const logger = createAnsteelRuntimeLogger(cwd, context);

		appendAnsteelTeamEvent(cwd, team, { type: "role-report", role: "tech-lead", content: "checkpoint" }, { logger });
		logger.close();

		const logs = readAnsteelRuntimeLogs(cwd, context.runId);
		expect(logs.map((entry) => entry.eventName)).toEqual(
			expect.arrayContaining(["event.appended", "event.fsync.completed", "state.persisted"]),
		);
		expect(logs.every((entry) => entry.traceId === context.traceId)).toBe(true);
	});

	it("rejects state and event paths that escape the reviewed project", () => {
		const cwd = createTemporaryProject();

		expect(getAnsteelTeamStatePath(cwd)).toMatch(/^.+\.pi[\\/]ansteel-team[\\/]team\.json$/);
		expect(getAnsteelTeamEventPath(cwd)).toMatch(/^.+\.pi[\\/]ansteel-team[\\/]events\.jsonl$/);
		expect(() => createAnsteelTeamState({ cwd: "", topic: "Review", roleModels: {} as never })).toThrow(
			"Ansteel team requires a project directory",
		);
	});

	it("rejects corrupt persisted challenge entries with a governance error", () => {
		const cwd = createTemporaryProject();
		const team = createTeam(cwd);
		team.openChallenges = [null as unknown as (typeof team.openChallenges)[number]];

		expect(() => saveAnsteelTeamState(cwd, team)).toThrow("Ansteel team state has invalid challenge entries");
	});
});
