import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AnsteelWorkCheckpoint,
	type AnsteelWorkCheckpointInput,
	anchorAnsteelTeamMilestone,
	anchorAnsteelTeamTask,
	appendAnsteelTeamEvent,
	assessAnsteelTeamAction,
	beginAnsteelTeamMilestoneFinalVerification,
	beginAnsteelTeamTaskFinalVerification,
	claimAnsteelTeamTask,
	claimAnsteelTeamTasks,
	classifyAnsteelTeamActionRisk,
	createAnsteelTeamMilestone,
	createAnsteelTeamState,
	getAnsteelTeamEventPath,
	getAnsteelTeamMilestoneFinalVerificationReadiness,
	getAnsteelTeamSharedBoard,
	getAnsteelTeamStatePath,
	getAnsteelTeamStatusAxes,
	getAnsteelTeamTaskFinalVerificationReadiness,
	getAnsteelTeamTaskProgressFingerprint,
	getAnsteelTeamTransactionPath,
	getAnsteelTeamWriteBlockReason,
	listAnsteelTeamEvents,
	loadAnsteelTeamState,
	publishAnsteelTeamMilestoneCollaboration,
	publishAnsteelTeamTaskCollaboration,
	publishAnsteelWorkCheckpoint,
	raiseAnsteelProcessIssue,
	recordAnsteelTeamTaskTestResult,
	resolveAnsteelProcessIssue,
	resolveAnsteelTeamWritePath,
	revalidateAnsteelTeamWritePath,
	reviewAnsteelProcessResolution,
	reviewAnsteelTeamAction,
	reviewAnsteelTeamMilestone,
	reviewAnsteelTeamTask,
	runAnsteelTeamMilestoneTest,
	runAnsteelTeamTaskTest,
	saveAnsteelTeamState,
	submitAnsteelTeamMilestone,
	submitAnsteelTeamTask,
	verifyAnsteelTeamExternalAnchor,
} from "../src/core/ansteel-team.ts";
import {
	canonicalizeAnsteelAuditValue,
	createAnsteelTeamMerkleRoot,
	signAnsteelTeamAuditEvent,
	verifyAnsteelTeamAuditEventSignatures,
} from "../src/core/ansteel-team-integrity.ts";
import {
	type AnsteelRuntimeLogEntry,
	createAnsteelRunContext,
	createAnsteelRuntimeLogger,
	getAnsteelRuntimeAnchorSnapshotPath,
	readAnsteelRuntimeLogs,
} from "../src/core/ansteel-team-observability.ts";
import { createEditTool } from "../src/core/tools/edit.ts";
import { createGuardedFileMutationController } from "../src/core/tools/guarded-file-mutation.ts";
import { createWriteTool } from "../src/core/tools/write.ts";

const temporaryDirectories: string[] = [];

function createTemporaryProject(): string {
	const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-team-"));
	temporaryDirectories.push(cwd);
	return cwd;
}

function getStableFileIdentity(path: string): { dev: bigint; ino: bigint; sha256: string } {
	const stats = statSync(path, { bigint: true });
	if (!stats.isFile() || stats.ino === 0n) throw new Error(`Test target has no stable file identity: ${path}`);
	return {
		dev: stats.dev,
		ino: stats.ino,
		sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
	};
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

function createCompletePublicCorrectionLoop(cwd: string) {
	const state = createTeam(cwd);
	const checkpoint = publishAnsteelWorkCheckpoint(cwd, state, "staff-engineer", {
		id: "CP-REPLAY-0001",
		goal: "Keep persisted collaboration state replayable",
		currentUnderstanding: "The public event ledger is the durable collaboration record",
		assumptions: [],
		evidenceRefs: ["event:public-ledger"],
		uncertainties: [],
		nextAction: { kind: "read", target: "events.jsonl", expectedResult: "Hash chain verifies" },
		risk: "yellow",
		confidence: "L2",
	});
	const issue = raiseAnsteelProcessIssue(cwd, state, "qa-engineer", {
		id: "PI-REPLAY-0001",
		targetCheckpointId: checkpoint.id,
		severity: "blocking",
		claim: "The first checkpoint lacks a persisted replay check",
		evidenceRefs: ["event:public-ledger"],
		suggestedCorrection: "Publish a replacement checkpoint with replay evidence",
	});
	const replacement = publishAnsteelWorkCheckpoint(cwd, state, "staff-engineer", {
		id: "CP-REPLAY-0002",
		goal: checkpoint.goal,
		currentUnderstanding: "The public state must replay exactly after a restart",
		assumptions: checkpoint.assumptions,
		evidenceRefs: ["test:restart-replay"],
		uncertainties: [],
		nextAction: { kind: "test", target: "test/ansteel-team.test.ts", expectedResult: "Board matches" },
		risk: "green",
		confidence: "L1",
		supersedesCheckpointId: checkpoint.id,
	});
	const resolution = resolveAnsteelProcessIssue(cwd, state, "staff-engineer", {
		id: "PR-REPLAY-0001",
		issueId: issue.id,
		outcome: "ACCEPTED",
		summary: "Replay the durable ledger before exposing the shared board",
		evidenceRefs: ["test:restart-replay"],
		replacementCheckpointId: replacement.id,
	});
	reviewAnsteelProcessResolution(cwd, state, "qa-engineer", issue.id, {
		verdict: "accept",
		reason: "The replacement checkpoint includes the required replay evidence",
	});
	return { checkpoint, issue, replacement, resolution, state };
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
				governedAction: {
					kind: "test",
					target: "test/parser.test.ts",
					version: "unscoped;checkpoint:CP-PARSER-0001",
					computedRisk: "yellow",
					effectiveRisk: "yellow",
				},
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

function beginTaskFinalVerificationForTest(cwd: string, team: ReturnType<typeof createTeam>, taskId: string): void {
	const task = team.tasks.find((item) => item.id === taskId);
	if (!task) throw new Error(`Missing task ${taskId}`);
	for (const collaborator of ["tech-lead", "staff-engineer", "qa-engineer"] as const) {
		if (collaborator === task.owner) continue;
		publishAnsteelTeamTaskCollaboration(cwd, team, collaborator, taskId, {
			summary: `${collaborator} inspected the frozen task evidence before final verification.`,
			evidenceRefs: [`test:${taskId}:${collaborator}:continuous-collaboration`],
			uncertainties: [],
		});
	}
	beginAnsteelTeamTaskFinalVerification(cwd, team, taskId);
}

function beginMilestoneFinalVerificationForTest(
	cwd: string,
	team: ReturnType<typeof createTeam>,
	milestoneId: string,
): void {
	for (const collaborator of ["staff-engineer", "qa-engineer"] as const) {
		publishAnsteelTeamMilestoneCollaboration(cwd, team, collaborator, milestoneId, {
			summary: `${collaborator} inspected frozen integration evidence before final verification.`,
			evidenceRefs: [`test:${milestoneId}:${collaborator}:continuous-collaboration`],
			uncertainties: [],
		});
	}
	beginAnsteelTeamMilestoneFinalVerification(cwd, team, milestoneId);
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

describe("Ansteel team status axes", () => {
	it("starts without conflating an empty team with governance or delivery success", () => {
		const axes = getAnsteelTeamStatusAxes(createTeam(createTemporaryProject()));

		expect(axes).toMatchObject({
			collaborationStatus: "orienting",
			governanceStatus: "not-required",
			deliveryStatus: "not-started",
			workflowStatus: "in-progress",
		});
		expect(axes.reasons.delivery).toEqual(
			expect.arrayContaining([expect.stringContaining("no trusted, replayable delivery-verification evidence")]),
		);
	});

	it("blocks collaboration when a durable role session has failed", () => {
		const state = createTeam(createTemporaryProject());
		state.roles["qa-engineer"].status = "failed";

		expect(getAnsteelTeamStatusAxes(state)).toMatchObject({
			collaborationStatus: "blocked",
			governanceStatus: "not-required",
			deliveryStatus: "not-started",
			workflowStatus: "blocked",
		});
	});

	it("approves governance for an action-only red checkpoint after both peer confirmations", () => {
		const cwd = createTemporaryProject();
		initializeGitProject(cwd);
		const state = createTeam(cwd);
		const checkpoint = publishAnsteelWorkCheckpoint(cwd, state, "staff-engineer", {
			id: "CP-AXIS-ACTION-ONLY-0001",
			goal: "Replace a governed file after peer confirmation.",
			currentUnderstanding: "The existing parser file requires a red overwrite confirmation.",
			assumptions: [],
			evidenceRefs: ["file:src/parser.ts"],
			uncertainties: [],
			nextAction: { kind: "write", target: "src/parser.ts", expectedResult: "The parser file is replaced" },
			risk: "green",
			confidence: "L2",
		});
		const action = {
			kind: checkpoint.governedAction!.kind,
			target: checkpoint.governedAction!.target,
			version: checkpoint.governedAction!.version,
		};
		for (const reviewer of ["tech-lead", "qa-engineer"] as const) {
			reviewAnsteelTeamAction(cwd, state, reviewer, {
				checkpointId: checkpoint.id,
				action,
				verdict: "approve",
				reason: `${reviewer} confirmed the exact action binding.`,
			});
		}

		expect(getAnsteelTeamStatusAxes(state)).toMatchObject({
			collaborationStatus: "active",
			governanceStatus: "approved",
			deliveryStatus: "not-started",
			workflowStatus: "in-progress",
		});
	});

	it("blocks the workflow when an action-only red checkpoint is rejected", () => {
		const cwd = createTemporaryProject();
		initializeGitProject(cwd);
		const state = createTeam(cwd);
		const checkpoint = publishAnsteelWorkCheckpoint(cwd, state, "staff-engineer", {
			id: "CP-AXIS-ACTION-REJECT-0001",
			goal: "Replace a governed file only after peer review.",
			currentUnderstanding: "The existing parser file requires a red overwrite confirmation.",
			assumptions: [],
			evidenceRefs: ["file:src/parser.ts"],
			uncertainties: [],
			nextAction: { kind: "write", target: "src/parser.ts", expectedResult: "The parser file is replaced" },
			risk: "green",
			confidence: "L2",
		});
		reviewAnsteelTeamAction(cwd, state, "qa-engineer", {
			checkpointId: checkpoint.id,
			action: {
				kind: checkpoint.governedAction!.kind,
				target: checkpoint.governedAction!.target,
				version: checkpoint.governedAction!.version,
			},
			verdict: "reject",
			reason: "QA rejected the exact red overwrite binding.",
		});

		const axes = getAnsteelTeamStatusAxes(state);
		expect(axes).toMatchObject({
			collaborationStatus: "active",
			governanceStatus: "rejected",
			deliveryStatus: "not-started",
			workflowStatus: "blocked",
		});
		expect(getAnsteelTeamSharedBoard(state, listAnsteelTeamEvents(cwd)).axes).toEqual(axes);
	});
});

describe("public collaboration state", () => {
	it("migrates v7 teams without inventing action reviews or reusable action approval", () => {
		const cwd = createTemporaryProject();
		const state = createTeam(cwd);
		claimAnsteelTeamTask(cwd, state, {
			id: "TASK-MIGRATE-RISK",
			owner: "staff-engineer",
			files: ["src/migrate-risk.ts"],
			description: "Preserve a legacy task while migrating risk governance state.",
			acceptanceCriteria: "The legacy task receives the staff implementation type.",
		});
		const checkpoint = publishAnsteelWorkCheckpoint(cwd, state, "staff-engineer", {
			id: "CP-MIGRATE-RISK-0001",
			goal: "Migrate an existing public checkpoint",
			currentUnderstanding: "Version 7 did not bind peer approval to an exact action version",
			assumptions: [],
			evidenceRefs: ["state:v7"],
			uncertainties: ["Whether the old checkpoint is still actionable"],
			nextAction: { kind: "edit", target: "src/parser.ts", expectedResult: "The parser changes" },
			risk: "yellow",
			confidence: "L2",
		});
		const statePath = getAnsteelTeamStatePath(cwd);
		const legacy = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
		legacy.version = 7;
		delete legacy.actionReviews;
		const tasks = legacy.tasks as Array<Record<string, unknown>>;
		delete tasks[0].type;
		const checkpoints = legacy.workCheckpoints as Array<Record<string, unknown>>;
		delete checkpoints[0].governedAction;
		writePersistedTeamState(cwd, legacy);

		const migrated = loadAnsteelTeamState(cwd);

		expect(migrated).toMatchObject({
			version: 10,
			actionReviews: [],
			tasks: [{ id: "TASK-MIGRATE-RISK", type: "implementation", owner: "staff-engineer" }],
			workCheckpoints: [{ id: checkpoint.id, status: "superseded", governedAction: null }],
		});
	});

	it.each([
		["read", { path: "src/parser.ts" }, "green"],
		["grep", { pattern: "parser", path: "src" }, "green"],
		["edit", { path: "src/parser.ts", edits: [] }, "yellow"],
		["write", { path: "src/new.ts", content: "export {};\n" }, "yellow"],
		["write", { path: "src/parser.ts", content: "export {};\n" }, "red"],
		["bash", { command: "git status --short" }, "green"],
		["bash", { command: "git commit -m governed" }, "red"],
		["bash", { command: "git push origin main" }, "red"],
	])("mechanically classifies %s as %s", (toolName, args, expectedRisk) => {
		const cwd = createTemporaryProject();
		initializeGitProject(cwd);

		expect(classifyAnsteelTeamActionRisk(cwd, { toolName, args })).toBe(expectedRisk);
	});

	it("raises sensitive targets to red and never accepts a model risk downgrade", () => {
		const cwd = createTemporaryProject();
		initializeGitProject(cwd);
		const state = createTeam(cwd);

		expect(
			classifyAnsteelTeamActionRisk(cwd, {
				toolName: "edit",
				args: { path: ".github/workflows/delivery.yml", edits: [] },
			}),
		).toBe("red");
		expect(
			classifyAnsteelTeamActionRisk(cwd, {
				toolName: "edit",
				args: { path: "migrations/001.sql", edits: [] },
			}),
		).toBe("red");

		const checkpoint = publishAnsteelWorkCheckpoint(cwd, state, "staff-engineer", {
			id: "CP-RISK-DOWNGRADE-0001",
			goal: "Change the delivery workflow",
			currentUnderstanding: "The workflow controls repository delivery",
			assumptions: [],
			evidenceRefs: ["file:.github/workflows/delivery.yml"],
			uncertainties: [],
			nextAction: {
				kind: "edit",
				target: ".github/workflows/delivery.yml",
				expectedResult: "The delivery workflow changes",
			},
			risk: "green",
			confidence: "L2",
		});

		expect(checkpoint.risk).toBe("red");
		expect(checkpoint.governedAction).toMatchObject({
			kind: "edit",
			target: ".github/workflows/delivery.yml",
			computedRisk: "red",
			effectiveRisk: "red",
		});
	});

	it("blocks a yellow edit until both peers approve the exact action binding", () => {
		const cwd = createTemporaryProject();
		initializeGitProject(cwd);
		const state = createTeam(cwd);
		claimAnsteelTeamTask(cwd, state, {
			id: "TASK-RISK-GATE",
			owner: "staff-engineer",
			files: ["src/parser.ts"],
			description: "Change the governed parser.",
			acceptanceCriteria: "The parser test passes.",
		});
		const editCall = { toolName: "edit", args: { path: "src/parser.ts", edits: [] } };

		expect(assessAnsteelTeamAction(cwd, state, "staff-engineer", editCall).blockReason).toContain(
			"active checkpoint",
		);

		const checkpoint = publishAnsteelWorkCheckpoint(cwd, state, "staff-engineer", {
			id: "CP-RISK-GATE-0001",
			taskId: "TASK-RISK-GATE",
			goal: "Change the governed parser",
			currentUnderstanding: "The exact parser edit is ready for peer inspection",
			assumptions: [],
			evidenceRefs: ["file:src/parser.ts"],
			uncertainties: [],
			nextAction: { kind: "edit", target: "src/parser.ts", expectedResult: "The parser changes" },
			risk: "yellow",
			confidence: "L2",
		});
		const action = {
			kind: checkpoint.governedAction!.kind,
			target: checkpoint.governedAction!.target,
			version: checkpoint.governedAction!.version,
		};

		expect(assessAnsteelTeamAction(cwd, state, "staff-engineer", editCall).blockReason).toContain(
			"tech-lead, qa-engineer",
		);
		reviewAnsteelTeamAction(cwd, state, "tech-lead", {
			checkpointId: checkpoint.id,
			action,
			verdict: "approve",
			reason: "The edit is scoped to the claimed parser file.",
		});
		expect(assessAnsteelTeamAction(cwd, state, "staff-engineer", editCall).blockReason).toContain("qa-engineer");
		reviewAnsteelTeamAction(cwd, state, "qa-engineer", {
			checkpointId: checkpoint.id,
			action,
			verdict: "approve",
			reason: "The parser boundary remains testable.",
		});

		expect(assessAnsteelTeamAction(cwd, state, "staff-engineer", editCall).blockReason).toBeUndefined();
	});

	it("rejects self approval, duplicate reviewers, mismatched bindings, and explicit peer rejection", () => {
		const cwd = createTemporaryProject();
		initializeGitProject(cwd);
		const state = createTeam(cwd);
		claimAnsteelTeamTask(cwd, state, {
			id: "TASK-REVIEW-BINDING",
			owner: "staff-engineer",
			files: ["src/parser.ts"],
			description: "Change the governed parser.",
			acceptanceCriteria: "The parser test passes.",
		});
		const checkpoint = publishAnsteelWorkCheckpoint(cwd, state, "staff-engineer", {
			id: "CP-REVIEW-BINDING-0001",
			taskId: "TASK-REVIEW-BINDING",
			goal: "Change the governed parser",
			currentUnderstanding: "The edit needs an exact peer binding",
			assumptions: [],
			evidenceRefs: ["file:src/parser.ts"],
			uncertainties: [],
			nextAction: { kind: "edit", target: "src/parser.ts", expectedResult: "The parser changes" },
			risk: "yellow",
			confidence: "L2",
		});
		const action = {
			kind: checkpoint.governedAction!.kind,
			target: checkpoint.governedAction!.target,
			version: checkpoint.governedAction!.version,
		};

		expect(() =>
			reviewAnsteelTeamAction(cwd, state, "staff-engineer", {
				checkpointId: checkpoint.id,
				action,
				verdict: "approve",
				reason: "Self approval must fail.",
			}),
		).toThrow("cannot review its own action");
		expect(() =>
			reviewAnsteelTeamAction(cwd, state, "tech-lead", {
				checkpointId: checkpoint.id,
				action: { ...action, version: `${action.version}-stale` },
				verdict: "approve",
				reason: "A stale version must fail.",
			}),
		).toThrow("does not match");

		reviewAnsteelTeamAction(cwd, state, "tech-lead", {
			checkpointId: checkpoint.id,
			action,
			verdict: "reject",
			reason: "The compatibility evidence is missing.",
		});
		expect(() =>
			reviewAnsteelTeamAction(cwd, state, "tech-lead", {
				checkpointId: checkpoint.id,
				action,
				verdict: "approve",
				reason: "A duplicate reviewer must fail.",
			}),
		).toThrow("already reviewed");
		expect(
			assessAnsteelTeamAction(cwd, state, "staff-engineer", {
				toolName: "edit",
				args: { path: "src/parser.ts", edits: [] },
			}).blockReason,
		).toContain("rejected");
	});

	it("upgrades an existing-file write to red and requires both explicit peer approvals", () => {
		const cwd = createTemporaryProject();
		initializeGitProject(cwd);
		const state = createTeam(cwd);
		claimAnsteelTeamTask(cwd, state, {
			id: "TASK-RED-WRITE",
			owner: "staff-engineer",
			files: ["src/parser.ts"],
			description: "Replace the governed parser file.",
			acceptanceCriteria: "The parser test passes.",
		});
		const checkpoint = publishAnsteelWorkCheckpoint(cwd, state, "staff-engineer", {
			id: "CP-RED-WRITE-0001",
			taskId: "TASK-RED-WRITE",
			goal: "Replace the governed parser file",
			currentUnderstanding: "A full write overwrites the current file",
			assumptions: [],
			evidenceRefs: ["file:src/parser.ts"],
			uncertainties: [],
			nextAction: { kind: "write", target: "src/parser.ts", expectedResult: "The parser file is replaced" },
			risk: "green",
			confidence: "L2",
		});
		const action = {
			kind: checkpoint.governedAction!.kind,
			target: checkpoint.governedAction!.target,
			version: checkpoint.governedAction!.version,
		};
		const writeCall = {
			toolName: "write",
			args: { path: "src/parser.ts", content: "export const parser = 'after';\n" },
		};

		expect(checkpoint.risk).toBe("red");
		expect(assessAnsteelTeamAction(cwd, state, "staff-engineer", writeCall).blockReason).toContain(
			"tech-lead, qa-engineer",
		);
		for (const reviewer of ["tech-lead", "qa-engineer"] as const) {
			reviewAnsteelTeamAction(cwd, state, reviewer, {
				checkpointId: checkpoint.id,
				action,
				verdict: "approve",
				reason: `${reviewer} explicitly approved the red overwrite.`,
			});
		}
		expect(assessAnsteelTeamAction(cwd, state, "staff-engineer", writeCall).blockReason).toBeUndefined();
		expect(getAnsteelTeamStatusAxes(state)).toMatchObject({
			collaborationStatus: "active",
			governanceStatus: "pending",
			deliveryStatus: "not-started",
			workflowStatus: "in-progress",
		});
	});

	it("keeps blocking issues and target drift ahead of otherwise complete peer approval", () => {
		const cwd = createTemporaryProject();
		initializeGitProject(cwd);
		const state = createTeam(cwd);
		claimAnsteelTeamTask(cwd, state, {
			id: "TASK-RISK-DRIFT",
			owner: "staff-engineer",
			files: ["src/parser.ts"],
			description: "Change the governed parser.",
			acceptanceCriteria: "The parser test passes.",
		});
		const checkpoint = publishAnsteelWorkCheckpoint(cwd, state, "staff-engineer", {
			id: "CP-RISK-DRIFT-0001",
			taskId: "TASK-RISK-DRIFT",
			goal: "Change the governed parser",
			currentUnderstanding: "Both peers can inspect the current file version",
			assumptions: [],
			evidenceRefs: ["file:src/parser.ts"],
			uncertainties: [],
			nextAction: { kind: "edit", target: "src/parser.ts", expectedResult: "The parser changes" },
			risk: "yellow",
			confidence: "L2",
		});
		const action = {
			kind: checkpoint.governedAction!.kind,
			target: checkpoint.governedAction!.target,
			version: checkpoint.governedAction!.version,
		};
		for (const reviewer of ["tech-lead", "qa-engineer"] as const) {
			reviewAnsteelTeamAction(cwd, state, reviewer, {
				checkpointId: checkpoint.id,
				action,
				verdict: "approve",
				reason: `${reviewer} verified the exact action binding.`,
			});
		}
		raiseAnsteelProcessIssue(cwd, state, "qa-engineer", {
			id: "PI-RISK-DRIFT-0001",
			targetCheckpointId: checkpoint.id,
			severity: "blocking",
			claim: "The compatibility evidence is incomplete.",
			evidenceRefs: ["test:compatibility"],
			suggestedCorrection: "Add the missing compatibility case.",
		});
		const editCall = { toolName: "edit", args: { path: "src/parser.ts", edits: [] } };

		expect(assessAnsteelTeamAction(cwd, state, "staff-engineer", editCall).blockReason).toContain(
			"blocking process issue",
		);

		state.processIssues[0].severity = "advisory";
		writeFileSync(join(cwd, "src", "parser.ts"), "export const parser = 'drifted';\n", "utf8");
		expect(assessAnsteelTeamAction(cwd, state, "staff-engineer", editCall).blockReason).toContain(
			"target version drift",
		);
	});

	it("allows green reads immediately without a checkpoint or peer review", () => {
		const cwd = createTemporaryProject();
		initializeGitProject(cwd);
		const state = createTeam(cwd);

		const assessment = assessAnsteelTeamAction(cwd, state, "qa-engineer", {
			toolName: "read",
			args: { path: "src/parser.ts" },
		});
		expect(assessment).toMatchObject({
			action: { computedRisk: "green", effectiveRisk: "green" },
			requiredReviewers: [],
			approvedReviewers: [],
		});
		expect(assessment.blockReason).toBeUndefined();
	});

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

	it("replays a complete public correction loop into the same shared board after restart", () => {
		const cwd = createTemporaryProject();
		const { state } = createCompletePublicCorrectionLoop(cwd);
		const eventTypes = listAnsteelTeamEvents(cwd).map((event) => event.type);
		expect(eventTypes).toEqual(
			expect.arrayContaining([
				"work-checkpoint",
				"process-issue",
				"process-resolution",
				"process-resolution-review",
			]),
		);

		const boardBeforeRestart = getAnsteelTeamSharedBoard(state, listAnsteelTeamEvents(cwd));
		// Reload both persisted records to model a process restart instead of reusing the original state object.
		const restartedState = loadAnsteelTeamState(cwd);
		expect(restartedState).toBeDefined();
		const boardAfterRestart = getAnsteelTeamSharedBoard(restartedState!, listAnsteelTeamEvents(cwd));

		expect(boardAfterRestart).toEqual(boardBeforeRestart);
		expect(boardAfterRestart.counts).toEqual({
			activeCheckpoints: 1,
			openProcessIssues: 0,
			blockingProcessIssues: 0,
			escalatedProcessIssues: 0,
		});
	});

	it("rejects a hash-preserving-state tamper in every public collaboration event family", () => {
		for (const eventType of [
			"work-checkpoint",
			"process-issue",
			"process-resolution",
			"process-resolution-review",
		] as const) {
			const cwd = createTemporaryProject();
			createCompletePublicCorrectionLoop(cwd);
			const eventPath = getAnsteelTeamEventPath(cwd);
			const events = readFileSync(eventPath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			const event = events.find((candidate) => candidate.type === eventType);
			if (!event) throw new Error(`Missing ${eventType} event from correction loop`);
			// Change a persisted public event without recomputing its hash; each family must independently fail closed.
			event.content = `${String(event.content)} tampered`;
			writeFileSync(eventPath, `${events.map((candidate) => JSON.stringify(candidate)).join("\n")}\n`, "utf8");

			expect(() => listAnsteelTeamEvents(cwd)).toThrow("hash mismatch");
			expect(() => loadAnsteelTeamState(cwd)).toThrow("hash mismatch");
		}
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
		expect(getAnsteelTeamStatusAxes(state)).toMatchObject({
			collaborationStatus: "blocked",
			governanceStatus: "pending",
			deliveryStatus: "not-started",
			workflowStatus: "blocked",
		});

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
			version: 10,
			workCheckpoints: [],
			processIssues: [],
			actionReviews: [],
			...preserved,
		});
		expect(persisted).toMatchObject({
			version: 10,
			workCheckpoints: [],
			processIssues: [],
			actionReviews: [],
			...preserved,
		});
	});

	it("loads a valid public collaboration state", () => {
		const cwd = createTemporaryProject();
		writePersistedTeamState(cwd, createValidPublicCollaborationState(cwd));

		expect(loadAnsteelTeamState(cwd)).toMatchObject({
			version: 10,
			workCheckpoints: [{ id: "CP-PARSER-0001" }],
			processIssues: [{ id: "PI-PARSER-0001" }],
			actionReviews: [],
		});
	});

	it("derives checkpoint risk from the action when the model omits it", () => {
		const cwd = createTemporaryProject();
		const state = createTeam(cwd);
		const checkpoint = publishAnsteelWorkCheckpoint(cwd, state, "staff-engineer", {
			id: "CP-RISK-DERIVED-0001",
			goal: "Publish a checkpoint without an explicit risk",
			currentUnderstanding: "risk is mechanically derived from the action kind",
			assumptions: [],
			evidenceRefs: [],
			uncertainties: [],
			nextAction: { kind: "edit", target: "src/parser.ts", expectedResult: "Edit authorized at yellow" },
			confidence: "L2",
		});
		expect(checkpoint.risk).toBe("yellow");
		expect(checkpoint.governedAction.computedRisk).toBe("yellow");
		expect(checkpoint.governedAction.effectiveRisk).toBe("yellow");
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
					collaborationUpdates: [],
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
			version: 10,
			tasks: [],
			milestones: [],
			workCheckpoints: [],
			processIssues: [],
			actionReviews: [],
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
		expect(migrated).toMatchObject({ version: 10, ledgerHeadHash: events[0]?.hash, nextEventSequence: 2 });
		expect(persistedState).toMatchObject({ version: 10, ledgerHeadHash: events[0]?.hash });
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

		expect(migrated).toMatchObject({ version: 10, taskOwners: ["tech-lead", "staff-engineer", "qa-engineer"] });
		expect(persistedState).toMatchObject({
			version: 10,
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

	it("rejects a task file that escapes the project through a directory link", () => {
		const cwd = createTemporaryProject();
		const outside = createTemporaryProject();
		writeFileSync(join(outside, "outside.ts"), "export const outside = true;\n", "utf8");
		symlinkSync(outside, join(cwd, "linked"), process.platform === "win32" ? "junction" : "dir");
		const team = createTeam(cwd);

		expect(() =>
			claimAnsteelTeamTask(cwd, team, {
				id: "TASK-LINK-ESCAPE",
				owner: "staff-engineer",
				files: ["linked/outside.ts"],
				description: "Attempt to claim a linked file outside the project.",
				acceptanceCriteria: "The project boundary remains intact.",
			}),
		).toThrow("must stay inside the project");
	});

	it("rechecks the canonical project boundary when a claimed path becomes a directory link", () => {
		const cwd = createTemporaryProject();
		const outside = createTemporaryProject();
		writeFileSync(join(outside, "outside.ts"), "export const outside = true;\n", "utf8");
		const team = createTeam(cwd);
		claimAnsteelTeamTask(cwd, team, {
			id: "TASK-LINK-DRIFT",
			owner: "staff-engineer",
			files: ["linked/outside.ts"],
			description: "Edit a file whose parent does not exist yet.",
			acceptanceCriteria: "The write remains inside the project.",
		});
		symlinkSync(outside, join(cwd, "linked"), process.platform === "win32" ? "junction" : "dir");

		expect(getAnsteelTeamWriteBlockReason(cwd, team, "staff-engineer", "linked/outside.ts")).toContain(
			"must stay inside the project",
		);
		expect(classifyAnsteelTeamActionRisk(cwd, { toolName: "edit", args: { path: "linked/outside.ts" } })).toBe("red");
		expect(
			assessAnsteelTeamAction(cwd, team, "staff-engineer", {
				toolName: "edit",
				args: { path: "linked/outside.ts" },
			}).blockReason,
		).toContain("must stay inside the project");
		expect(() => resolveAnsteelTeamWritePath(cwd, "linked/outside.ts")).toThrow("must stay inside the project");
	});

	it("binds an allowed linked write target to its canonical in-project path", () => {
		const cwd = createTemporaryProject();
		mkdirSync(join(cwd, "real"), { recursive: true });
		writeFileSync(join(cwd, "real", "inside.ts"), "export const inside = true;\n", "utf8");
		symlinkSync(join(cwd, "real"), join(cwd, "linked"), process.platform === "win32" ? "junction" : "dir");

		expect(resolveAnsteelTeamWritePath(cwd, "linked/inside.ts")).toBe(realpathSync(join(cwd, "real", "inside.ts")));
	});

	it("blocks the production write tool when a missing parent becomes an external directory link", async () => {
		const cwd = createTemporaryProject();
		const outside = createTemporaryProject();
		const seedPath = join(cwd, "approved-seed.ts");
		writeFileSync(seedPath, "approved seed\n", "utf8");
		const approvedPath = resolveAnsteelTeamWritePath(cwd, "pending/escaped.ts");
		symlinkSync(outside, join(cwd, "pending"), process.platform === "win32" ? "junction" : "dir");
		const guardedFileMutation = createGuardedFileMutationController((absolutePath) => {
			revalidateAnsteelTeamWritePath(cwd, absolutePath);
		});
		const writeTool = createWriteTool(cwd, {
			guardedFileMutation: guardedFileMutation.execute,
		});
		guardedFileMutation.authorize(approvedPath, getStableFileIdentity(seedPath));

		await expect(
			writeTool.execute("TOOL-WRITE-TOCTOU-1", {
				path: approvedPath,
				content: "must not escape\n",
			}),
		).rejects.toThrow("changed after approval");
		expect(() => readFileSync(join(outside, "escaped.ts"), "utf8")).toThrow();
	});

	it("blocks the production edit tool when an approved parent becomes an external directory link", async () => {
		const cwd = createTemporaryProject();
		const outside = createTemporaryProject();
		mkdirSync(join(cwd, "pending"), { recursive: true });
		writeFileSync(join(cwd, "pending", "target.ts"), "inside original\n", "utf8");
		writeFileSync(join(outside, "target.ts"), "outside original\n", "utf8");
		const approvedPath = resolveAnsteelTeamWritePath(cwd, "pending/target.ts");
		const approvedIdentity = getStableFileIdentity(approvedPath);
		rmSync(join(cwd, "pending"), { recursive: true, force: true });
		symlinkSync(outside, join(cwd, "pending"), process.platform === "win32" ? "junction" : "dir");
		const guardedFileMutation = createGuardedFileMutationController((absolutePath) => {
			revalidateAnsteelTeamWritePath(cwd, absolutePath);
		});
		const editTool = createEditTool(cwd, {
			guardedFileMutation: guardedFileMutation.execute,
		});
		guardedFileMutation.authorize(approvedPath, approvedIdentity);

		await expect(
			editTool.execute("TOOL-EDIT-TOCTOU-1", {
				path: approvedPath,
				edits: [{ oldText: "outside original", newText: "outside changed" }],
			}),
		).rejects.toThrow("changed after approval");
		expect(readFileSync(join(outside, "target.ts"), "utf8")).toBe("outside original\n");
	});

	it("binds production write I/O to the approved file when a directory link changes after validation", async () => {
		const cwd = createTemporaryProject();
		const outside = createTemporaryProject();
		mkdirSync(join(cwd, "pending"), { recursive: true });
		writeFileSync(join(cwd, "pending", "target.ts"), "inside original\n", "utf8");
		writeFileSync(join(outside, "target.ts"), "outside original\n", "utf8");
		const approvedPath = resolveAnsteelTeamWritePath(cwd, "pending/target.ts");
		const approvedIdentity = getStableFileIdentity(approvedPath);
		let guardCalls = 0;
		const guardedFileMutation = createGuardedFileMutationController((absolutePath) => {
			revalidateAnsteelTeamWritePath(cwd, absolutePath);
			guardCalls += 1;
			if (guardCalls === 2) {
				rmSync(join(cwd, "pending"), { recursive: true, force: true });
				symlinkSync(outside, join(cwd, "pending"), process.platform === "win32" ? "junction" : "dir");
			}
		});
		const writeTool = createWriteTool(cwd, { guardedFileMutation: guardedFileMutation.execute });
		guardedFileMutation.authorize(approvedPath, approvedIdentity);

		await expect(
			writeTool.execute("TOOL-WRITE-ATOMIC-BOUNDARY-1", {
				path: approvedPath,
				content: "must not escape\n",
			}),
		).rejects.toThrow("changed after approval");
		expect(readFileSync(join(outside, "target.ts"), "utf8")).toBe("outside original\n");
	});

	it("rejects an outside handle opened during an alternating junction race", async () => {
		const cwd = createTemporaryProject();
		const outside = createTemporaryProject();
		mkdirSync(join(cwd, "pending"), { recursive: true });
		writeFileSync(join(cwd, "pending", "target.ts"), "inside original\n", "utf8");
		writeFileSync(join(outside, "target.ts"), "outside original\n", "utf8");
		const approvedPath = resolveAnsteelTeamWritePath(cwd, "pending/target.ts");
		const approvedIdentity = getStableFileIdentity(approvedPath);
		const guardedFileMutation = createGuardedFileMutationController((absolutePath) => {
			revalidateAnsteelTeamWritePath(cwd, absolutePath);
			// Reproduce the reviewer's strongest race: validation sees the
			// approved in-project target, then open() sees the outside junction.
			rmSync(join(cwd, "pending"), { recursive: true, force: true });
			symlinkSync(outside, join(cwd, "pending"), process.platform === "win32" ? "junction" : "dir");
		});
		const writeTool = createWriteTool(cwd, { guardedFileMutation: guardedFileMutation.execute });
		guardedFileMutation.authorize(approvedPath, approvedIdentity);

		await expect(
			writeTool.execute("TOOL-WRITE-ALTERNATING-JUNCTION-1", {
				path: approvedPath,
				content: "outside mutated\n",
			}),
		).rejects.toThrow("opened a different file than the approved checkpoint");
		expect(readFileSync(join(outside, "target.ts"), "utf8")).toBe("outside original\n");
	});

	it("rejects same-inode content drift after peers approve the file hash", async () => {
		const cwd = createTemporaryProject();
		const targetPath = join(cwd, "target.ts");
		writeFileSync(targetPath, "peer approved\n", "utf8");
		const approvedIdentity = getStableFileIdentity(targetPath);
		const guardedFileMutation = createGuardedFileMutationController((absolutePath) => {
			revalidateAnsteelTeamWritePath(cwd, absolutePath);
		});
		const writeTool = createWriteTool(cwd, { guardedFileMutation: guardedFileMutation.execute });

		// An in-place rewrite preserves dev/ino on the tested platform. The
		// approved SHA-256 must therefore be checked independently by the handle.
		writeFileSync(targetPath, "unreviewed drift\n", "utf8");
		expect(getStableFileIdentity(targetPath)).toMatchObject({
			dev: approvedIdentity.dev,
			ino: approvedIdentity.ino,
		});
		guardedFileMutation.authorize(targetPath, approvedIdentity);

		await expect(
			writeTool.execute("TOOL-WRITE-CONTENT-DRIFT-1", {
				path: targetPath,
				content: "must not overwrite drift\n",
			}),
		).rejects.toThrow("contents changed after peer approval");
		expect(readFileSync(targetPath, "utf8")).toBe("unreviewed drift\n");
	});

	it("binds production edit I/O to the approved file when a directory link changes after validation", async () => {
		const cwd = createTemporaryProject();
		const outside = createTemporaryProject();
		mkdirSync(join(cwd, "pending"), { recursive: true });
		writeFileSync(join(cwd, "pending", "target.ts"), "inside original\n", "utf8");
		writeFileSync(join(outside, "target.ts"), "inside original\n", "utf8");
		const approvedPath = resolveAnsteelTeamWritePath(cwd, "pending/target.ts");
		const approvedIdentity = getStableFileIdentity(approvedPath);
		let guardCalls = 0;
		const guardedFileMutation = createGuardedFileMutationController((absolutePath) => {
			revalidateAnsteelTeamWritePath(cwd, absolutePath);
			guardCalls += 1;
			if (guardCalls === 3) {
				rmSync(join(cwd, "pending"), { recursive: true, force: true });
				symlinkSync(outside, join(cwd, "pending"), process.platform === "win32" ? "junction" : "dir");
			}
		});
		const editTool = createEditTool(cwd, { guardedFileMutation: guardedFileMutation.execute });
		guardedFileMutation.authorize(approvedPath, approvedIdentity);

		await expect(
			editTool.execute("TOOL-EDIT-ATOMIC-BOUNDARY-1", {
				path: approvedPath,
				edits: [{ oldText: "inside original", newText: "must not escape" }],
			}),
		).rejects.toThrow("changed after approval");
		expect(readFileSync(join(outside, "target.ts"), "utf8")).toBe("inside original\n");
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

	it("persists task types and requires a public reason for a cross-role assignment", () => {
		const cwd = createTemporaryProject();
		const team = createTeam(cwd);
		const allowedOwners = ["tech-lead", "staff-engineer", "qa-engineer"] as const;

		const implementation = claimAnsteelTeamTask(
			cwd,
			team,
			{
				id: "TASK-IMPLEMENTATION",
				owner: "staff-engineer",
				files: ["src/implementation.ts"],
				description: "Implement the product change.",
				acceptanceCriteria: "The implementation test passes.",
			},
			allowedOwners,
		);
		expect(implementation).toMatchObject({ type: "implementation", owner: "staff-engineer" });

		expect(() =>
			claimAnsteelTeamTask(
				cwd,
				team,
				{
					id: "TASK-CROSS-ROLE-BLOCKED",
					owner: "qa-engineer",
					type: "implementation",
					files: ["src/qa-implementation.ts"],
					description: "Temporarily implement a QA-owned change.",
					acceptanceCriteria: "The implementation test passes.",
				},
				allowedOwners,
			),
		).toThrow("requires a public assignment reason");

		const reassigned = claimAnsteelTeamTask(
			cwd,
			team,
			{
				id: "TASK-CROSS-ROLE",
				owner: "qa-engineer",
				type: "implementation",
				assignmentReason: "Staff is unavailable and QA owns the isolated fixture implementation.",
				files: ["src/qa-implementation.ts"],
				description: "Temporarily implement a QA-owned change.",
				acceptanceCriteria: "The implementation test passes.",
			},
			allowedOwners,
		);
		expect(reassigned).toMatchObject({
			type: "implementation",
			owner: "qa-engineer",
			assignmentReason: "Staff is unavailable and QA owns the isolated fixture implementation.",
		});
	});

	it("claims three typed non-overlapping role tasks atomically", () => {
		const cwd = createTemporaryProject();
		const team = createTeam(cwd);
		const allowedOwners = ["tech-lead", "staff-engineer", "qa-engineer"] as const;
		const baseInputs = [
			{
				id: "TASK-ARCHITECTURE",
				owner: "tech-lead" as const,
				type: "architecture" as const,
				files: ["src/contracts.ts"],
				description: "Define the shared contract.",
				acceptanceCriteria: "The contract test passes.",
			},
			{
				id: "TASK-IMPLEMENTATION",
				owner: "staff-engineer" as const,
				type: "implementation" as const,
				files: ["src/implementation.ts"],
				description: "Implement the contract.",
				acceptanceCriteria: "The implementation test passes.",
			},
			{
				id: "TASK-VERIFICATION",
				owner: "qa-engineer" as const,
				type: "verification" as const,
				files: ["test/acceptance.test.ts"],
				description: "Add acceptance automation.",
				acceptanceCriteria: "The acceptance test passes.",
			},
		];

		expect(() =>
			claimAnsteelTeamTasks(
				cwd,
				team,
				[baseInputs[0]!, { ...baseInputs[1]!, files: ["src/contracts.ts"] }, baseInputs[2]!],
				allowedOwners,
			),
		).toThrow("already claimed");
		expect(team.tasks).toEqual([]);

		const tasks = claimAnsteelTeamTasks(cwd, team, baseInputs, allowedOwners);
		expect(tasks).toEqual([
			expect.objectContaining({ id: "TASK-ARCHITECTURE", owner: "tech-lead", type: "architecture" }),
			expect.objectContaining({ id: "TASK-IMPLEMENTATION", owner: "staff-engineer", type: "implementation" }),
			expect.objectContaining({ id: "TASK-VERIFICATION", owner: "qa-engineer", type: "verification" }),
		]);
		expect(getAnsteelTeamSharedBoard(team, [], []).tasks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "TASK-ARCHITECTURE", type: "architecture" }),
				expect.objectContaining({ id: "TASK-VERIFICATION", type: "verification" }),
			]),
		);
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
		beginTaskFinalVerificationForTest(cwd, team, predecessor.id);
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
		beginTaskFinalVerificationForTest(cwd, team, task.id);
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
		expect(() =>
			reviewAnsteelTeamMilestone(cwd, team, "staff-engineer", milestone.id, { verdict: "approve" }),
		).toThrow("not in final verification");
		expect(getAnsteelTeamMilestoneFinalVerificationReadiness(cwd, team, milestone.id)).toMatchObject({
			ready: false,
			blockers: expect.arrayContaining([
				"missing continuous collaboration update from staff-engineer",
				"missing continuous collaboration update from qa-engineer",
			]),
		});
		beginMilestoneFinalVerificationForTest(cwd, team, milestone.id);
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

	it("requires public continuous collaboration before independent final task verification", () => {
		const cwd = createTemporaryProject();
		initializeGitProject(cwd);
		const team = createTeam(cwd);
		const task = claimAnsteelTeamTask(cwd, team, {
			id: "TASK-COLLABORATION",
			owner: "staff-engineer",
			files: ["src/parser.ts"],
			description: "Exercise the collaboration-to-final-verification boundary.",
			acceptanceCriteria: "The frozen parser test evidence is independently verified.",
		});
		writeFileSync(join(cwd, "src", "parser.ts"), "export const parser = 'collaboration';\n", "utf8");
		recordAnsteelTeamTaskTestResult(cwd, team, "staff-engineer", task.id, {
			command: "npm test -- parser",
			output: "PASS collaboration boundary",
			isError: false,
		});
		submitAnsteelTeamTask(cwd, team, "staff-engineer", task.id, "npm test -- parser");

		expect(() => reviewAnsteelTeamTask(cwd, team, "tech-lead", task.id, { verdict: "approve" })).toThrow(
			"not in final verification",
		);
		expect(getAnsteelTeamTaskFinalVerificationReadiness(cwd, team, task.id)).toMatchObject({
			ready: false,
			blockers: expect.arrayContaining([
				"missing continuous collaboration update from tech-lead",
				"missing continuous collaboration update from qa-engineer",
			]),
		});

		publishAnsteelTeamTaskCollaboration(cwd, team, "tech-lead", task.id, {
			summary: "Tech Lead checked the frozen parser boundary against the task contract.",
			evidenceRefs: ["test:TASK-COLLABORATION:tech-lead"],
			uncertainties: ["QA still needs an independent counterexample check"],
		});
		expect(getAnsteelTeamTaskFinalVerificationReadiness(cwd, team, task.id).ready).toBe(false);
		publishAnsteelTeamTaskCollaboration(cwd, team, "qa-engineer", task.id, {
			summary: "QA checked the frozen evidence and found no blocking counterexample.",
			evidenceRefs: ["test:TASK-COLLABORATION:qa-engineer"],
			uncertainties: [],
		});
		expect(getAnsteelTeamTaskFinalVerificationReadiness(cwd, team, task.id)).toMatchObject({ ready: true });

		beginAnsteelTeamTaskFinalVerification(cwd, team, task.id);
		expect(task.status).toBe("final-verification");
		reviewAnsteelTeamTask(cwd, team, "tech-lead", task.id, { verdict: "approve" });
		reviewAnsteelTeamTask(cwd, team, "qa-engineer", task.id, { verdict: "approve" });
		expect(task.status).toBe("approved");
		expect(getAnsteelTeamStatusAxes(team)).toMatchObject({
			collaborationStatus: "collaboration-complete",
			governanceStatus: "approved",
			deliveryStatus: "not-started",
			workflowStatus: "in-progress",
		});
	});

	it("returns submitted work to the owner when continuous collaboration raises a blocking checkpoint issue", () => {
		const cwd = createTemporaryProject();
		initializeGitProject(cwd);
		const team = createTeam(cwd);
		const task = claimAnsteelTeamTask(cwd, team, {
			id: "TASK-BLOCKING-COLLABORATION",
			owner: "staff-engineer",
			files: ["src/parser.ts"],
			description: "Exercise a structured pre-final blocking issue.",
			acceptanceCriteria: "The owner must resolve the public concern before final verification.",
		});
		const checkpoint = publishAnsteelWorkCheckpoint(cwd, team, "staff-engineer", {
			id: "CP-BLOCKING-COLLABORATION-0001",
			taskId: task.id,
			goal: "Publish the parser test boundary before frozen submission.",
			currentUnderstanding:
				"The owner has a candidate parser change but peer counterexample coverage is incomplete.",
			assumptions: [],
			evidenceRefs: ["file:src/parser.ts"],
			uncertainties: ["Whether an empty token bypasses the parser"],
			nextAction: { kind: "test", target: "test/parser.test.mjs", expectedResult: "The parser regression passes" },
			risk: "green",
			confidence: "L2",
		});
		writeFileSync(join(cwd, "src", "parser.ts"), "export const parser = 'blocking';\n", "utf8");
		recordAnsteelTeamTaskTestResult(cwd, team, "staff-engineer", task.id, {
			command: "npm test -- parser",
			output: "PASS before peer challenge",
			isError: false,
		});
		submitAnsteelTeamTask(cwd, team, "staff-engineer", task.id, "npm test -- parser");
		raiseAnsteelProcessIssue(cwd, team, "qa-engineer", {
			id: "PI-BLOCKING-COLLABORATION-0001",
			targetCheckpointId: checkpoint.id,
			severity: "blocking",
			claim: "The frozen package lacks the required empty-token counterexample.",
			evidenceRefs: ["test:counterexample:empty-token"],
			suggestedCorrection: "Add the counterexample regression and submit a new immutable package.",
		});

		expect(task).toMatchObject({ status: "revision-required", testEvidence: [] });
		expect(() => beginAnsteelTeamTaskFinalVerification(cwd, team, task.id)).toThrow("not submitted");
		expect(getAnsteelTeamStatusAxes(team)).toMatchObject({
			collaborationStatus: "disputed",
			governanceStatus: "pending",
			deliveryStatus: "not-started",
			workflowStatus: "blocked",
		});
	});

	it("migrates a v9 submitted task into legacy final verification without inventing collaboration updates", () => {
		const cwd = createTemporaryProject();
		initializeGitProject(cwd);
		const team = createTeam(cwd);
		const task = claimAnsteelTeamTask(cwd, team, {
			id: "TASK-V9-FINAL",
			owner: "staff-engineer",
			files: ["src/parser.ts"],
			description: "Preserve the old immediate-review interpretation during migration.",
			acceptanceCriteria: "The historical package stays available for final review.",
		});
		writeFileSync(join(cwd, "src", "parser.ts"), "export const parser = 'legacy-v9';\n", "utf8");
		recordAnsteelTeamTaskTestResult(cwd, team, "staff-engineer", task.id, {
			command: "npm test -- parser",
			output: "PASS legacy package",
			isError: false,
		});
		submitAnsteelTeamTask(cwd, team, "staff-engineer", task.id, "npm test -- parser");
		const raw = JSON.parse(readFileSync(getAnsteelTeamStatePath(cwd), "utf8")) as Record<string, unknown>;
		raw.version = 9;
		const rawTask = (raw.tasks as Array<Record<string, unknown>>)[0]!;
		rawTask.status = "submitted";
		delete rawTask.collaborationUpdates;
		writePersistedTeamState(cwd, raw);

		const migrated = loadAnsteelTeamState(cwd);
		expect(migrated?.tasks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: task.id, status: "final-verification", collaborationUpdates: [] }),
			]),
		);
		expect(getAnsteelTeamStatusAxes(migrated!)).toMatchObject({
			collaborationStatus: "active",
			governanceStatus: "pending",
			deliveryStatus: "not-started",
			workflowStatus: "in-progress",
		});
		expect(getAnsteelTeamStatusAxes(migrated!).reasons.collaboration).toEqual(
			expect.arrayContaining([expect.stringContaining("task TASK-V9-FINAL")]),
		);
	});

	it("migrates a v9 submitted milestone into legacy final verification without inventing collaboration updates", () => {
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
			id: "TASK-V9-MILESTONE-PREREQUISITE",
			owner: "staff-engineer",
			files: ["src/parser.ts"],
			description: "Approve the prerequisite before migrating an old milestone.",
			acceptanceCriteria: "The parser evidence is approved before integration.",
		});
		writeFileSync(join(cwd, "src", "parser.ts"), "export const parser = 'legacy-milestone';\n", "utf8");
		recordAnsteelTeamTaskTestResult(cwd, team, "staff-engineer", task.id, {
			command: "npm test -- parser",
			output: "PASS legacy prerequisite",
			isError: false,
		});
		submitAnsteelTeamTask(cwd, team, "staff-engineer", task.id, "npm test -- parser");
		beginTaskFinalVerificationForTest(cwd, team, task.id);
		reviewAnsteelTeamTask(cwd, team, "tech-lead", task.id, { verdict: "approve" });
		reviewAnsteelTeamTask(cwd, team, "qa-engineer", task.id, { verdict: "approve" });
		const milestone = createAnsteelTeamMilestone(cwd, team, {
			id: "MILESTONE-V9-FINAL",
			taskIds: [task.id],
			description: "Preserve the old immediate-review milestone interpretation during migration.",
			acceptanceCriteria: "The historical integration package remains available for final review.",
		});
		runAnsteelTeamMilestoneTest(cwd, team, "tech-lead", milestone.id, "node --test test/integration.test.mjs");
		submitAnsteelTeamMilestone(cwd, team, "tech-lead", milestone.id, "node --test test/integration.test.mjs");
		const raw = JSON.parse(readFileSync(getAnsteelTeamStatePath(cwd), "utf8")) as Record<string, unknown>;
		raw.version = 9;
		const rawMilestone = (raw.milestones as Array<Record<string, unknown>>)[0]!;
		rawMilestone.status = "submitted";
		delete rawMilestone.collaborationUpdates;
		writePersistedTeamState(cwd, raw);

		const migrated = loadAnsteelTeamState(cwd);
		expect(migrated?.milestones).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: milestone.id, status: "final-verification", collaborationUpdates: [] }),
			]),
		);
		expect(getAnsteelTeamStatusAxes(migrated!)).toMatchObject({
			collaborationStatus: "active",
			governanceStatus: "pending",
			deliveryStatus: "not-started",
			workflowStatus: "in-progress",
		});
		expect(getAnsteelTeamStatusAxes(migrated!).reasons.collaboration).toEqual(
			expect.arrayContaining([expect.stringContaining(`milestone ${milestone.id}`)]),
		);
	});

	it("keeps a v9 approved task active when migration has no collaboration evidence", () => {
		const cwd = createTemporaryProject();
		initializeGitProject(cwd);
		const team = createTeam(cwd);
		const task = claimAnsteelTeamTask(cwd, team, {
			id: "TASK-V9-APPROVED",
			owner: "staff-engineer",
			files: ["src/parser.ts"],
			description: "Preserve an old approval without fabricating continuous collaboration.",
			acceptanceCriteria: "The historical approved package remains inspectable.",
		});
		writeFileSync(join(cwd, "src", "parser.ts"), "export const parser = 'legacy-v9-approved';\n", "utf8");
		recordAnsteelTeamTaskTestResult(cwd, team, "staff-engineer", task.id, {
			command: "npm test -- parser",
			output: "PASS legacy approved package",
			isError: false,
		});
		submitAnsteelTeamTask(cwd, team, "staff-engineer", task.id, "npm test -- parser");
		beginTaskFinalVerificationForTest(cwd, team, task.id);
		reviewAnsteelTeamTask(cwd, team, "tech-lead", task.id, { verdict: "approve" });
		reviewAnsteelTeamTask(cwd, team, "qa-engineer", task.id, { verdict: "approve" });
		const raw = JSON.parse(readFileSync(getAnsteelTeamStatePath(cwd), "utf8")) as Record<string, unknown>;
		raw.version = 9;
		const rawTask = (raw.tasks as Array<Record<string, unknown>>)[0]!;
		delete rawTask.collaborationUpdates;
		writePersistedTeamState(cwd, raw);

		const migrated = loadAnsteelTeamState(cwd);
		expect(getAnsteelTeamStatusAxes(migrated!)).toMatchObject({
			collaborationStatus: "active",
			governanceStatus: "approved",
			deliveryStatus: "not-started",
			workflowStatus: "in-progress",
		});
		expect(getAnsteelTeamStatusAxes(migrated!).reasons.collaboration).toEqual(
			expect.arrayContaining([expect.stringContaining("task TASK-V9-APPROVED")]),
		);
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
		beginTaskFinalVerificationForTest(cwd, team, task.id);

		reviewAnsteelTeamTask(cwd, team, "tech-lead", task.id, { verdict: "approve" });
		reviewAnsteelTeamTask(cwd, team, "qa-engineer", task.id, {
			verdict: "reject",
			issue: "QA-1: empty input remains untested.",
		});
		expect(task.status).toBe("revision-required");
		expect(getAnsteelTeamStatusAxes(team)).toMatchObject({
			collaborationStatus: "disputed",
			governanceStatus: "rejected",
			deliveryStatus: "not-started",
			workflowStatus: "blocked",
		});

		writeFileSync(join(cwd, "src", "parser.ts"), "export const parser = 'second';\n", "utf8");
		recordAnsteelTeamTaskTestResult(cwd, team, "staff-engineer", task.id, {
			command: "npm test -- parser",
			output: "PASS revised parser",
			isError: false,
		});
		submitAnsteelTeamTask(cwd, team, "staff-engineer", task.id, "npm test -- parser");
		beginTaskFinalVerificationForTest(cwd, team, task.id);
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

	it("rejects a role-identity forgery, replayed signature, and post-cutover unsigned event", () => {
		const cwd = createTemporaryProject();
		const team = createTeam(cwd);
		const first = appendAnsteelTeamEvent(cwd, team, {
			type: "role-report",
			role: "staff-engineer",
			content: "Staff evidence for a signed event.",
		});
		const second = appendAnsteelTeamEvent(cwd, team, {
			type: "role-report",
			role: "staff-engineer",
			content: "A separate event that cannot reuse the first signature.",
		});
		expect(first.signature?.keyId).toMatch(/^ed25519-/);
		expect(second.signature?.keyId).toBe(first.signature?.keyId);
		expect(verifyAnsteelTeamAuditEventSignatures(cwd, [first, second])).toMatchObject({
			mode: "fully-signed",
			signedEventCount: 2,
		});

		const eventPath = getAnsteelTeamEventPath(cwd);
		const records = readFileSync(eventPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const forgedIdentity = structuredClone(records);
		forgedIdentity[1]!.signature = {
			...(forgedIdentity[1]!.signature as Record<string, unknown>),
			keyId: "ed25519-00000000000000000000000000000000",
		};
		writeFileSync(eventPath, `${forgedIdentity.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
		expect(() => listAnsteelTeamEvents(cwd)).toThrow("signature key does not belong");

		const replayedSignature = structuredClone(records);
		replayedSignature[1]!.signature = records[0]!.signature;
		writeFileSync(eventPath, `${replayedSignature.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
		expect(() => listAnsteelTeamEvents(cwd)).toThrow("signature is invalid");

		const downgraded = structuredClone(records);
		delete downgraded[1]!.signature;
		writeFileSync(eventPath, `${downgraded.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
		expect(() => listAnsteelTeamEvents(cwd)).toThrow("unsigned after the signing cutover");
	});

	it("uses JCS for new event hashes across hostile JSON shapes without changing legacy replay", () => {
		const cwd = createTemporaryProject();
		const team = createTeam(cwd);
		const adversarial = JSON.parse(
			'{"z":5e-324,"__proto__":{"constructor":"data"},"constructor":{"nested":{"deep":{"value":"\\u96ea"}}},"unicode":"\\ud83d\\ude80\\u0301","max":1.7976931348623157e+308}',
		) as Record<string, unknown>;
		const reordered = JSON.parse(
			'{"max":1.7976931348623157e+308,"unicode":"\\ud83d\\ude80\\u0301","constructor":{"nested":{"deep":{"value":"\\u96ea"}}},"__proto__":{"constructor":"data"},"z":5e-324}',
		) as Record<string, unknown>;
		const canonical = canonicalizeAnsteelAuditValue(adversarial);
		expect(canonicalizeAnsteelAuditValue(reordered)).toBe(canonical);
		expect(canonical).toContain('"__proto__"');
		expect(canonical).toContain('"constructor"');

		const event = appendAnsteelTeamEvent(cwd, team, {
			type: "role-report",
			role: "tech-lead",
			content: "JCS event body retains Unicode evidence: 雪 🚀.",
		});
		expect(event.hashAlgorithm).toBe("sha256-jcs-v1");
		expect(listAnsteelTeamEvents(cwd)).toHaveLength(1);
	});

	it("uses domain-separated JCS Merkle roots and anchors approved tasks and milestones to verified remote Git notes", () => {
		const cwd = createTemporaryProject();
		initializeGitProject(cwd);
		writeFileSync(join(cwd, ".gitignore"), ".pi/\n", "utf8");
		execFileSync("git", ["add", ".gitignore"], { cwd, stdio: "ignore" });
		execFileSync("git", ["commit", "-m", "ignore local audit state"], { cwd, stdio: "ignore" });
		mkdirSync(join(cwd, "test"), { recursive: true });
		writeFileSync(
			join(cwd, "test", "integration.test.mjs"),
			"import test from 'node:test';\ntest('integration', () => {});\n",
			"utf8",
		);
		execFileSync("git", ["add", "test/integration.test.mjs"], { cwd, stdio: "ignore" });
		execFileSync("git", ["commit", "-m", "integration fixture"], { cwd, stdio: "ignore" });
		const team = createTeam(cwd);
		const task = claimAnsteelTeamTask(cwd, team, {
			id: "TASK-ANCHOR-PARSER",
			owner: "staff-engineer",
			files: ["src/parser.ts"],
			description: "Implement the parser change that belongs to the anchored milestone.",
			acceptanceCriteria: "Task and integration tests pass before external anchoring.",
		});
		const milestone = createAnsteelTeamMilestone(cwd, team, {
			id: "MILESTONE-ANCHOR-PARSER",
			taskIds: [task.id],
			description: "Anchor the approved parser integration milestone.",
			acceptanceCriteria: "The remote Git note contains the verified Merkle receipt.",
		});
		writeFileSync(join(cwd, "src", "parser.ts"), "export const parser = 'anchored';\n", "utf8");
		recordAnsteelTeamTaskTestResult(cwd, team, "staff-engineer", task.id, {
			command: "npm test -- parser",
			output: "PASS parser boundary",
			isError: false,
		});
		submitAnsteelTeamTask(cwd, team, "staff-engineer", task.id, "npm test -- parser");
		beginTaskFinalVerificationForTest(cwd, team, task.id);
		reviewAnsteelTeamTask(cwd, team, "tech-lead", task.id, { verdict: "approve" });
		reviewAnsteelTeamTask(cwd, team, "qa-engineer", task.id, { verdict: "approve" });
		execFileSync("git", ["add", "src/parser.ts"], { cwd, stdio: "ignore" });
		execFileSync("git", ["commit", "-m", "anchored parser change"], { cwd, stdio: "ignore" });
		expect(milestone.status).toBe("ready");
		runAnsteelTeamMilestoneTest(cwd, team, "tech-lead", milestone.id, "node --test test/integration.test.mjs");
		submitAnsteelTeamMilestone(cwd, team, "tech-lead", milestone.id, "node --test test/integration.test.mjs");
		beginMilestoneFinalVerificationForTest(cwd, team, milestone.id);
		reviewAnsteelTeamMilestone(cwd, team, "staff-engineer", milestone.id, { verdict: "approve" });
		reviewAnsteelTeamMilestone(cwd, team, "qa-engineer", milestone.id, { verdict: "approve" });
		expect(milestone.status).toBe("approved");

		appendAnsteelTeamEvent(cwd, team, {
			type: "role-report",
			role: "tech-lead",
			content: "The approved milestone is ready for its signed external anchor.",
		});
		appendAnsteelTeamEvent(cwd, team, {
			type: "milestone-review",
			role: "staff-engineer",
			content: `${milestone.id} integration revision ${milestone.revision}: APPROVE`,
		});
		appendAnsteelTeamEvent(cwd, team, {
			type: "milestone-review",
			role: "qa-engineer",
			content: `${milestone.id} integration revision ${milestone.revision}: APPROVE`,
		});
		const context = createAnsteelRunContext({ teamId: team.id, command: "anchor milestone" });
		const logger = createAnsteelRuntimeLogger(cwd, context);
		logger.write({
			level: "audit",
			eventName: "milestone.anchor.preflight",
			outcome: "succeeded",
			message: "A durable runtime segment exists before anchoring.",
			data: {},
		});
		logger.close();
		const remoteDirectory = mkdtempSync(join(tmpdir(), "pi-ansteel-anchor-remote-"));
		temporaryDirectories.push(remoteDirectory);
		execFileSync("git", ["init", "--bare", remoteDirectory], { stdio: "ignore" });
		execFileSync("git", ["remote", "add", "audit", remoteDirectory], { cwd, stdio: "ignore" });
		const branch = execFileSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8" }).trim();
		execFileSync("git", ["push", "audit", `HEAD:refs/heads/${branch}`], { cwd, stdio: "ignore" });
		const staleTeam = structuredClone(team);
		appendAnsteelTeamEvent(cwd, team, {
			type: "task-review",
			role: "tech-lead",
			content: `${task.id} revision ${task.revision}: APPROVE`,
		});
		appendAnsteelTeamEvent(cwd, team, {
			type: "task-review",
			role: "qa-engineer",
			content: `${task.id} revision ${task.revision}: APPROVE`,
		});
		expect(() => anchorAnsteelTeamTask(cwd, staleTeam, task.id, { remote: "audit" })).toThrow(
			"ledger head hash does not match",
		);
		const splitPushRemote = mkdtempSync(join(tmpdir(), "pi-ansteel-anchor-split-push-"));
		temporaryDirectories.push(splitPushRemote);
		execFileSync("git", ["init", "--bare", splitPushRemote], { stdio: "ignore" });
		execFileSync("git", ["remote", "set-url", "--add", "--push", "audit", remoteDirectory], {
			cwd,
			stdio: "ignore",
		});
		execFileSync("git", ["remote", "set-url", "--add", "--push", "audit", splitPushRemote], {
			cwd,
			stdio: "ignore",
		});
		expect(() => anchorAnsteelTeamTask(cwd, team, task.id, { remote: "audit" })).toThrow(
			"endpoints are not a single matching endpoint",
		);
		execFileSync("git", ["config", "--unset-all", "remote.audit.pushurl"], { cwd, stdio: "ignore" });

		const postPushRewrite = mkdtempSync(join(tmpdir(), "pi-ansteel-anchor-post-push-rewrite-"));
		temporaryDirectories.push(postPushRewrite);
		writeFileSync(join(postPushRewrite, "replacement.txt"), "post-push replacement history\n", "utf8");
		execFileSync("git", ["init"], { cwd: postPushRewrite, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "ansteel@example.test"], { cwd: postPushRewrite, stdio: "ignore" });
		execFileSync("git", ["config", "user.name", "Ansteel Test"], { cwd: postPushRewrite, stdio: "ignore" });
		execFileSync("git", ["add", "replacement.txt"], { cwd: postPushRewrite, stdio: "ignore" });
		execFileSync("git", ["commit", "-m", "post-push replacement"], { cwd: postPushRewrite, stdio: "ignore" });
		execFileSync("git", ["remote", "add", "audit", remoteDirectory], { cwd: postPushRewrite, stdio: "ignore" });
		execFileSync("git", ["push", "audit", "HEAD:refs/heads/ansteel-post-push-rewrite"], {
			cwd: postPushRewrite,
			stdio: "ignore",
		});
		const replacementCommit = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: postPushRewrite,
			encoding: "utf8",
		}).trim();
		const postReceiveHook = join(remoteDirectory, "hooks", "post-receive");
		writeFileSync(postReceiveHook, `#!/bin/sh\ngit update-ref refs/heads/${branch} ${replacementCommit}\n`, "utf8");
		chmodSync(postReceiveHook, 0o755);
		expect(() => anchorAnsteelTeamTask(cwd, team, task.id, { remote: "audit" })).toThrow(
			"anchored commit remains reachable from the remote source branch",
		);
		expect(listAnsteelTeamEvents(cwd).some((event) => event.type === "task-anchor")).toBe(false);
		rmSync(postReceiveHook, { force: true });
		execFileSync("git", ["push", "audit", `+HEAD:refs/heads/${branch}`], { cwd, stdio: "ignore" });
		const taskAnchor = anchorAnsteelTeamTask(cwd, team, task.id, { remote: "audit" });
		expect(taskAnchor).toMatchObject({
			target: { kind: "task", id: task.id, revision: task.revision },
			git: { remote: "audit" },
		});
		expect(verifyAnsteelTeamExternalAnchor(cwd, team, task.id)).toMatchObject({
			anchorHash: taskAnchor.anchorHash,
		});
		expect(taskAnchor.runtimeLogSnapshotHash).toMatch(/^[0-9a-f]{64}$/);
		const snapshotPath = getAnsteelRuntimeAnchorSnapshotPath(cwd, taskAnchor.runtimeLogSnapshotHash);
		const originalSnapshot = readFileSync(snapshotPath, "utf8");
		writeFileSync(snapshotPath, "{}\n", "utf8");
		expect(() => verifyAnsteelTeamExternalAnchor(cwd, team, task.id)).toThrow(
			"runtime anchor snapshot has an invalid schema",
		);
		writeFileSync(snapshotPath, originalSnapshot, "utf8");

		const signingDirectory = join(cwd, ".pi", "ansteel-team");
		const manifestPath = join(signingDirectory, "signing-manifest.json");
		const privateKeyPath = join(signingDirectory, "signing-private-keys.json");
		const originalManifest = readFileSync(manifestPath, "utf8");
		const originalPrivateKeys = readFileSync(privateKeyPath, "utf8");
		const eventPath = getAnsteelTeamEventPath(cwd);
		const originalEvents = readFileSync(eventPath, "utf8");
		rmSync(manifestPath, { force: true });
		rmSync(privateKeyPath, { force: true });
		const rekeyedEvents = originalEvents
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.map((record) => ({
				...record,
				signature: signAnsteelTeamAuditEvent(cwd, team.id, {
					sequence: record.sequence as number,
					role: record.role as "tech-lead" | "staff-engineer" | "qa-engineer" | "coordinator",
					hash: record.hash as string,
				}),
			}));
		writeFileSync(eventPath, `${rekeyedEvents.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
		expect(() => verifyAnsteelTeamExternalAnchor(cwd, team, task.id)).toThrow(
			"signing manifest does not match the anchored receipt",
		);
		writeFileSync(manifestPath, originalManifest, "utf8");
		writeFileSync(privateKeyPath, originalPrivateKeys, "utf8");
		writeFileSync(eventPath, originalEvents, "utf8");
		expect(listAnsteelTeamEvents(cwd).at(-1)).toMatchObject({
			type: "task-anchor",
			anchor: { anchorHash: taskAnchor.anchorHash, target: { kind: "task", id: task.id } },
		});
		execFileSync("git", ["--git-dir", remoteDirectory, "update-ref", "-d", taskAnchor.git.notesRef], {
			stdio: "ignore",
		});
		expect(() => verifyAnsteelTeamExternalAnchor(cwd, team, task.id)).toThrow("remote anchor ref was not found");

		const beforeAnchor = listAnsteelTeamEvents(cwd);
		const root = createAnsteelTeamMerkleRoot(beforeAnchor.map((event) => event.hash));
		expect(createAnsteelTeamMerkleRoot([...beforeAnchor].reverse().map((event) => event.hash)).root).not.toBe(
			root.root,
		);
		const anchor = anchorAnsteelTeamMilestone(cwd, team, milestone.id, { remote: "audit" });
		expect(anchor).toMatchObject({
			target: { kind: "milestone", id: milestone.id, revision: milestone.revision },
			merkle: { root: root.root, leafCount: beforeAnchor.length },
			git: { remote: "audit", commit: expect.stringMatching(/^[0-9a-f]{40}$/) },
		});
		expect(anchor.git.noteObject).toBe(anchor.git.remoteRefObject);
		const note = execFileSync(
			"git",
			["--git-dir", remoteDirectory, "notes", `--ref=${anchor.git.notesRef}`, "show", anchor.git.commit],
			{
				encoding: "utf8",
			},
		);
		expect(JSON.parse(note)).toMatchObject({ anchorHash: anchor.anchorHash, merkle: { root: root.root } });
		expect(verifyAnsteelTeamExternalAnchor(cwd, team, milestone.id)).toMatchObject({ anchorHash: anchor.anchorHash });
		const rewrittenSource = mkdtempSync(join(tmpdir(), "pi-ansteel-anchor-rewrite-"));
		temporaryDirectories.push(rewrittenSource);
		writeFileSync(join(rewrittenSource, "replacement.txt"), "unrelated replacement history\n", "utf8");
		execFileSync("git", ["init"], { cwd: rewrittenSource, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "ansteel@example.test"], { cwd: rewrittenSource, stdio: "ignore" });
		execFileSync("git", ["config", "user.name", "Ansteel Test"], { cwd: rewrittenSource, stdio: "ignore" });
		execFileSync("git", ["add", "replacement.txt"], { cwd: rewrittenSource, stdio: "ignore" });
		execFileSync("git", ["commit", "-m", "unrelated replacement"], { cwd: rewrittenSource, stdio: "ignore" });
		execFileSync("git", ["remote", "add", "audit", remoteDirectory], { cwd: rewrittenSource, stdio: "ignore" });
		execFileSync("git", ["push", "audit", `+HEAD:refs/heads/${branch}`], { cwd: rewrittenSource, stdio: "ignore" });
		expect(() => verifyAnsteelTeamExternalAnchor(cwd, team, milestone.id)).toThrow(
			"anchored commit remains reachable from the remote source branch",
		);
		execFileSync("git", ["push", "audit", `+${anchor.git.commit}:refs/heads/${branch}`], {
			cwd,
			stdio: "ignore",
		});

		const replacementRemote = mkdtempSync(join(tmpdir(), "pi-ansteel-anchor-replacement-"));
		temporaryDirectories.push(replacementRemote);
		execFileSync("git", ["init", "--bare", replacementRemote], { stdio: "ignore" });
		execFileSync("git", ["remote", "add", "replacement", replacementRemote], { cwd, stdio: "ignore" });
		execFileSync("git", ["push", "replacement", `${anchor.git.commit}:refs/heads/${branch}`], {
			cwd,
			stdio: "ignore",
		});
		execFileSync("git", ["push", "replacement", `${anchor.git.notesRef}:${anchor.git.notesRef}`], {
			cwd,
			stdio: "ignore",
		});
		execFileSync("git", ["remote", "set-url", "audit", replacementRemote], { cwd, stdio: "ignore" });
		expect(() => verifyAnsteelTeamExternalAnchor(cwd, team, milestone.id)).toThrow(
			"endpoint does not match the persisted receipt",
		);
		expect(listAnsteelTeamEvents(cwd).at(-1)).toMatchObject({
			type: "milestone-anchor",
			signature: expect.any(Object),
			anchor: { anchorHash: anchor.anchorHash, target: { kind: "milestone", id: milestone.id } },
		});
	}, 30_000);

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
