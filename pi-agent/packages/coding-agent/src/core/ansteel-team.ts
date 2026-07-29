import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { getCwdRelativePath, resolvePath } from "../utils/paths.ts";
import { ANSTEEL_ROLES, type AnsteelRole, DEFAULT_ANSTEEL_TEAM_TASK_OWNERS } from "./ansteel-discussion.ts";
import type { AnsteelRuntimeLogger } from "./ansteel-team-observability.ts";

const ANSTEEL_TEAM_STATE_VERSION = 7;
const MAX_PUBLIC_EVENT_CONTENT_LENGTH = 16_384;
const ANSTEEL_TEAM_TEST_TIMEOUT_MS = 60_000;
const ANSTEEL_TEAM_TEST_COMMAND_PREFIX =
	/^(?:npm (?:test|run (?:test|check|lint|typecheck)\b|exec -- (?:vitest|jest|tsc)\b)|npx (?:vitest|jest|tsc)\b|pnpm (?:test|run (?:test|check|lint|typecheck)\b)|yarn (?:test|run (?:test|check|lint|typecheck)\b)|bun test\b|vitest\b|jest\b|node --test\b|pytest\b|go test\b|cargo test\b|dotnet test\b|mvn test\b|(?:\.\/)?gradlew test\b|make test\b)/;

export type AnsteelTeamStatus = "active" | "stopped";

export type AnsteelTeamEventType =
	| "role-report"
	| "challenge"
	| "resolution"
	| "role-failure"
	| "task-assigned"
	| "task-claimed"
	| "task-submitted"
	| "task-review"
	| "milestone-planned"
	| "milestone-submitted"
	| "milestone-review"
	| "work-checkpoint"
	| "process-issue"
	| "process-resolution"
	| "process-resolution-review";

export type AnsteelTeamEventActor = AnsteelRole | "coordinator";

export interface AnsteelTeamRoleState {
	model: string;
	sessionFile: string;
	status: "idle" | "working" | "failed";
}

export interface AnsteelTeamChallenge {
	id: string;
	raisedBy: AnsteelRole;
	targetRole: AnsteelRole;
	status: "open" | "resolved";
}

export type AnsteelCheckpointRisk = "green" | "yellow" | "red";
export type AnsteelCheckpointConfidence = "L1" | "L2" | "L3" | "L4";
export type AnsteelProcessIssueSeverity = "advisory" | "blocking" | "critical";
export type AnsteelProcessResolutionOutcome = "ACCEPTED" | "REFUTED" | "EXPERIMENT_REQUIRED" | "SCOPE_ESCALATION";

export interface AnsteelWorkCheckpoint {
	id: string;
	taskId?: string;
	actor: AnsteelRole;
	goal: string;
	currentUnderstanding: string;
	assumptions: string[];
	evidenceRefs: string[];
	uncertainties: string[];
	nextAction: {
		kind: "read" | "experiment" | "edit" | "test" | "commit" | "publish" | "decision";
		target: string;
		expectedResult: string;
	};
	risk: AnsteelCheckpointRisk;
	confidence: AnsteelCheckpointConfidence;
	status: "active" | "superseded";
	supersedesCheckpointId?: string;
	createdAt: string;
}

export interface AnsteelProcessResolution {
	id: string;
	issueId: string;
	actor: AnsteelRole;
	outcome: AnsteelProcessResolutionOutcome;
	summary: string;
	evidenceRefs: string[];
	replacementCheckpointId?: string;
	experiment?: string;
	createdAt: string;
	review?: {
		reviewer: AnsteelRole;
		verdict: "accept" | "reject";
		reason: string;
		reviewedAt: string;
	};
}

export interface AnsteelProcessIssue {
	id: string;
	targetCheckpointId: string;
	author: AnsteelRole;
	targetRole: AnsteelRole;
	severity: AnsteelProcessIssueSeverity;
	claim: string;
	evidenceRefs: string[];
	suggestedCorrection: string;
	status: "open" | "resolution-proposed" | "closed" | "escalated";
	resolutions: AnsteelProcessResolution[];
	createdAt: string;
}

export type AnsteelWorkCheckpointInput = Omit<AnsteelWorkCheckpoint, "actor" | "status" | "createdAt">;
export type AnsteelProcessIssueInput = Omit<
	AnsteelProcessIssue,
	"author" | "targetRole" | "status" | "resolutions" | "createdAt"
>;
export type AnsteelProcessResolutionInput = Omit<
	AnsteelProcessResolution,
	"issueId" | "actor" | "createdAt" | "review"
> & { issueId: string };
export type AnsteelProcessResolutionReviewInput = Pick<
	NonNullable<AnsteelProcessResolution["review"]>,
	"verdict" | "reason"
>;

export type AnsteelTeamPublicEventPayload =
	| { kind: "work-checkpoint"; checkpoint: AnsteelWorkCheckpoint }
	| { kind: "process-issue"; issue: AnsteelProcessIssue }
	| { kind: "process-resolution"; issueId: string; resolution: AnsteelProcessResolution }
	| {
			kind: "process-resolution-review";
			issueId: string;
			resolutionId: string;
			review: NonNullable<AnsteelProcessResolution["review"]>;
	  };

export interface AnsteelTeamTask {
	id: string;
	owner: AnsteelRole;
	files: string[];
	description: string;
	acceptanceCriteria: string;
	/** Immutable task IDs that must be approved before this task can be changed. */
	dependsOn: string[];
	/** `blocked` is coordinator-derived from `dependsOn`; roles cannot choose it. */
	status: "blocked" | "claimed" | "submitted" | "revision-required" | "approved";
	revision: number;
	testEvidence: AnsteelTeamTaskTestEvidence[];
	submissions: AnsteelTeamTaskSubmission[];
	reviews: AnsteelTeamTaskReview[];
}

export interface AnsteelTeamTaskTestEvidence {
	command: string;
	output: string;
	isError: boolean;
	completedAt: string;
}

export interface AnsteelTeamTaskSubmission {
	revision: number;
	submittedAt: string;
	diff: string;
	test: AnsteelTeamTaskTestEvidence;
}

export interface AnsteelTeamTaskReview {
	revision: number;
	reviewer: AnsteelRole;
	verdict: "approve" | "reject";
	issue?: string;
	reviewedAt: string;
}

export interface AnsteelTeamMilestone {
	id: string;
	taskIds: string[];
	description: string;
	acceptanceCriteria: string;
	status: "blocked" | "ready" | "submitted" | "revision-required" | "approved";
	revision: number;
	testEvidence: AnsteelTeamTaskTestEvidence[];
	submissions: AnsteelTeamMilestoneSubmission[];
	reviews: AnsteelTeamMilestoneReview[];
}

export interface AnsteelTeamMilestoneSubmission {
	revision: number;
	submittedAt: string;
	test: AnsteelTeamTaskTestEvidence;
}

export interface AnsteelTeamMilestoneReview {
	revision: number;
	reviewer: AnsteelRole;
	verdict: "approve" | "reject";
	issue?: string;
	reviewedAt: string;
}

export interface ClaimAnsteelTeamTaskInput {
	id: string;
	owner: AnsteelRole;
	files: string[];
	description: string;
	acceptanceCriteria: string;
	dependsOn?: string[];
}

export interface RecordAnsteelTeamTaskTestResultInput {
	command: string;
	output: string;
	isError: boolean;
}

export interface ReviewAnsteelTeamTaskInput {
	verdict: "approve" | "reject";
	issue?: string;
}

export interface CreateAnsteelTeamMilestoneInput {
	id: string;
	taskIds: string[];
	description: string;
	acceptanceCriteria: string;
}

export interface AnsteelTeamState {
	version: number;
	id: string;
	topic: string;
	status: AnsteelTeamStatus;
	createdAt: string;
	updatedAt: string;
	nextEventSequence: number;
	roles: Record<AnsteelRole, AnsteelTeamRoleState>;
	/** Immutable owner policy for this team's code-change tasks. */
	taskOwners: AnsteelRole[];
	openChallenges: AnsteelTeamChallenge[];
	tasks: AnsteelTeamTask[];
	milestones: AnsteelTeamMilestone[];
	workCheckpoints: AnsteelWorkCheckpoint[];
	processIssues: AnsteelProcessIssue[];
	ledgerHeadHash: string | null;
}

export interface CreateAnsteelTeamStateOptions {
	cwd: string;
	topic: string;
	roleModels: Record<AnsteelRole, string>;
	taskOwners?: readonly AnsteelRole[];
	now?: Date;
}

export interface AnsteelTeamEventInput {
	type: AnsteelTeamEventType;
	role: AnsteelTeamEventActor;
	targetRole?: AnsteelRole;
	challengeId?: string;
	schemaVersion?: 1 | 2;
	checkpointId?: string;
	issueId?: string;
	resolutionId?: string;
	payload?: AnsteelTeamPublicEventPayload;
	content: string;
}

export interface AnsteelTeamEvent extends AnsteelTeamEventInput {
	sequence: number;
	createdAt: string;
	previousHash: string | null;
	hash: string;
}

export interface AnsteelTeamPersistenceContext {
	logger: AnsteelRuntimeLogger;
	causeEventId?: string;
}

export class AnsteelTeamStateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AnsteelTeamStateError";
	}
}

function assertProjectDirectory(cwd: string): string {
	if (cwd.trim().length === 0) throw new AnsteelTeamStateError("Ansteel team requires a project directory");
	return resolvePath(cwd);
}

export function getAnsteelTeamDirectory(cwd: string): string {
	return resolvePath(join(assertProjectDirectory(cwd), ".pi", "ansteel-team"));
}

export function getAnsteelTeamStatePath(cwd: string): string {
	return join(getAnsteelTeamDirectory(cwd), "team.json");
}

export function getAnsteelTeamEventPath(cwd: string): string {
	return join(getAnsteelTeamDirectory(cwd), "events.jsonl");
}

export function getAnsteelTeamTransactionPath(cwd: string): string {
	return join(getAnsteelTeamDirectory(cwd), "transaction.json");
}

function getAnsteelTeamRoleSessionPath(cwd: string, role: AnsteelRole): string {
	return join(getAnsteelTeamDirectory(cwd), "sessions", `${role}.jsonl`);
}

function createAnsteelTeamId(now: Date): string {
	return `ansteel-team-${now.toISOString().replace(/[:.]/g, "-")}`;
}

function assertRoleModels(roleModels: Record<AnsteelRole, string>): void {
	for (const role of ANSTEEL_ROLES) {
		if (typeof roleModels[role] !== "string" || roleModels[role].trim().length === 0) {
			throw new AnsteelTeamStateError(`Ansteel team role ${role} requires a configured provider/model`);
		}
	}
}

function assertRole(role: unknown, field: string): asserts role is AnsteelRole {
	if (!ANSTEEL_ROLES.includes(role as AnsteelRole)) {
		throw new AnsteelTeamStateError(`Ansteel team ${field} must be one of ${ANSTEEL_ROLES.join(", ")}`);
	}
}

function normalizeTaskOwners(value: unknown, field: string): AnsteelRole[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new AnsteelTeamStateError(`Ansteel team ${field} must be a non-empty list of roles`);
	}
	const owners = value.map((role) => {
		assertRole(role, field);
		return role;
	});
	if (new Set(owners).size !== owners.length) {
		throw new AnsteelTeamStateError(`Ansteel team ${field} cannot contain duplicate roles`);
	}
	return owners;
}

function assertChallengeId(id: string | undefined, eventType: AnsteelTeamEventType): asserts id is string {
	if (typeof id !== "string" || !/^[A-Z][A-Z0-9-]*$/.test(id)) {
		throw new AnsteelTeamStateError(`Ansteel team ${eventType} requires an uppercase challenge ID`);
	}
}

function assertTaskId(id: unknown): asserts id is string {
	if (typeof id !== "string" || !/^TASK-[A-Z0-9-]+$/.test(id)) {
		throw new AnsteelTeamStateError("Ansteel team task IDs must use the TASK-<UPPERCASE-ID> form");
	}
}

function assertMilestoneId(id: unknown): asserts id is string {
	if (typeof id !== "string" || !/^MILESTONE-[A-Z0-9-]+$/.test(id)) {
		throw new AnsteelTeamStateError("Ansteel team milestone IDs must use the MILESTONE-<UPPERCASE-ID> form");
	}
}

function assertCheckpointId(id: unknown): asserts id is string {
	if (typeof id !== "string" || !/^CP-[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(id)) {
		throw new AnsteelTeamStateError("Ansteel team checkpoint IDs must use the CP-<UPPERCASE-ID> form");
	}
}

function assertProcessIssueId(id: unknown): asserts id is string {
	if (typeof id !== "string" || !/^PI-[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(id)) {
		throw new AnsteelTeamStateError("Ansteel team process issue IDs must use the PI-<UPPERCASE-ID> form");
	}
}

function assertProcessResolutionId(id: unknown): asserts id is string {
	if (typeof id !== "string" || !/^PR-[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(id)) {
		throw new AnsteelTeamStateError("Ansteel team process resolution IDs must use the PR-<UPPERCASE-ID> form");
	}
}

function assertNonEmptyStateString(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new AnsteelTeamStateError(`Ansteel team ${field} must be a non-empty string`);
	}
}

function assertStateStringArray(value: unknown, field: string): asserts value is string[] {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
		throw new AnsteelTeamStateError(`Ansteel team ${field} must be a list of non-empty strings`);
	}
}

function assertStateTimestamp(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0 || Number.isNaN(Date.parse(value))) {
		throw new AnsteelTeamStateError(`Ansteel team ${field} must be a valid timestamp`);
	}
}

function assertPublicContent(content: string): void {
	if (typeof content !== "string" || content.trim().length === 0) {
		throw new AnsteelTeamStateError("Ansteel team events require non-empty public content");
	}
	if (content.length > MAX_PUBLIC_EVENT_CONTENT_LENGTH) {
		throw new AnsteelTeamStateError(
			`Ansteel team public content exceeds ${MAX_PUBLIC_EVENT_CONTENT_LENGTH} characters`,
		);
	}
}

function assertLedgerHash(value: unknown, field: string, allowNull: true): asserts value is string | null;
function assertLedgerHash(value: unknown, field: string, allowNull: false): asserts value is string;
function assertLedgerHash(value: unknown, field: string, allowNull: boolean): asserts value is string | null {
	if (allowNull && value === null) return;
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
		throw new AnsteelTeamStateError(`Ansteel team ${field} must be a SHA-256 hash`);
	}
}

function assertState(state: AnsteelTeamState): void {
	if (state.version !== ANSTEEL_TEAM_STATE_VERSION) {
		throw new AnsteelTeamStateError(`Unsupported Ansteel team state version: ${state.version}`);
	}
	if (typeof state.id !== "string" || state.id.length === 0)
		throw new AnsteelTeamStateError("Ansteel team state requires an ID");
	if (typeof state.topic !== "string" || state.topic.trim().length === 0) {
		throw new AnsteelTeamStateError("Ansteel team state requires a topic");
	}
	if (state.status !== "active" && state.status !== "stopped") {
		throw new AnsteelTeamStateError("Ansteel team state has an invalid status");
	}
	if (!Number.isSafeInteger(state.nextEventSequence) || state.nextEventSequence < 1) {
		throw new AnsteelTeamStateError("Ansteel team state has an invalid next event sequence");
	}
	assertLedgerHash(state.ledgerHeadHash, "ledger head hash", true);
	assertRoleModels(
		Object.fromEntries(ANSTEEL_ROLES.map((role) => [role, state.roles?.[role]?.model])) as Record<
			AnsteelRole,
			string
		>,
	);
	normalizeTaskOwners(state.taskOwners, "task-owner policy");
	for (const role of ANSTEEL_ROLES) {
		const roleState = state.roles[role];
		if (typeof roleState.sessionFile !== "string" || roleState.sessionFile.length === 0) {
			throw new AnsteelTeamStateError(`Ansteel team ${role} requires a session file`);
		}
		if (roleState.status !== "idle" && roleState.status !== "working" && roleState.status !== "failed") {
			throw new AnsteelTeamStateError(`Ansteel team ${role} has an invalid role status`);
		}
	}
	if (!Array.isArray(state.openChallenges))
		throw new AnsteelTeamStateError("Ansteel team state has invalid challenges");
	for (const challenge of state.openChallenges) {
		if (!isRecord(challenge)) throw new AnsteelTeamStateError("Ansteel team state has invalid challenge entries");
		assertChallengeId(challenge.id, "challenge");
		assertRole(challenge.raisedBy, "challenge author");
		assertRole(challenge.targetRole, "challenge target");
		if (challenge.raisedBy === challenge.targetRole) {
			throw new AnsteelTeamStateError("Ansteel team challenges cannot target their author");
		}
		if (challenge.status !== "open" && challenge.status !== "resolved") {
			throw new AnsteelTeamStateError("Ansteel team challenge has an invalid status");
		}
	}
	if (!Array.isArray(state.tasks)) throw new AnsteelTeamStateError("Ansteel team state has invalid tasks");
	const taskIds = new Set<string>();
	for (const task of state.tasks) {
		if (!isRecord(task)) throw new AnsteelTeamStateError("Ansteel team state has invalid task entries");
		assertTaskId(task.id);
		if (taskIds.has(task.id)) throw new AnsteelTeamStateError(`Ansteel team task ${task.id} is duplicated`);
		taskIds.add(task.id);
		assertRole(task.owner, "task owner");
		if (
			!Array.isArray(task.files) ||
			task.files.length === 0 ||
			task.files.some((file) => typeof file !== "string")
		) {
			throw new AnsteelTeamStateError(`Ansteel team task ${task.id} requires exact file paths`);
		}
		if (typeof task.description !== "string" || task.description.trim().length === 0) {
			throw new AnsteelTeamStateError(`Ansteel team task ${task.id} requires a description`);
		}
		if (typeof task.acceptanceCriteria !== "string" || task.acceptanceCriteria.trim().length === 0) {
			throw new AnsteelTeamStateError(`Ansteel team task ${task.id} requires acceptance criteria`);
		}
		if (
			task.status !== "blocked" &&
			task.status !== "claimed" &&
			task.status !== "submitted" &&
			task.status !== "revision-required" &&
			task.status !== "approved"
		) {
			throw new AnsteelTeamStateError(`Ansteel team task ${task.id} has an invalid status`);
		}
		if (!Number.isSafeInteger(task.revision) || task.revision < 0) {
			throw new AnsteelTeamStateError(`Ansteel team task ${task.id} has an invalid revision`);
		}
		if (!Array.isArray(task.testEvidence)) {
			throw new AnsteelTeamStateError(`Ansteel team task ${task.id} has invalid test evidence`);
		}
		for (const test of task.testEvidence) {
			if (!isRecord(test) || typeof test.command !== "string" || typeof test.output !== "string") {
				throw new AnsteelTeamStateError(`Ansteel team task ${task.id} has invalid test evidence`);
			}
			if (typeof test.isError !== "boolean" || typeof test.completedAt !== "string") {
				throw new AnsteelTeamStateError(`Ansteel team task ${task.id} has invalid test evidence`);
			}
		}
		if (!Array.isArray(task.submissions)) {
			throw new AnsteelTeamStateError(`Ansteel team task ${task.id} has invalid submissions`);
		}
		for (const submission of task.submissions) {
			if (
				!isRecord(submission) ||
				!Number.isSafeInteger(submission.revision) ||
				submission.revision < 1 ||
				typeof submission.submittedAt !== "string" ||
				typeof submission.diff !== "string" ||
				!isRecord(submission.test)
			) {
				throw new AnsteelTeamStateError(`Ansteel team task ${task.id} has invalid submissions`);
			}
		}
		if (!Array.isArray(task.reviews)) {
			throw new AnsteelTeamStateError(`Ansteel team task ${task.id} has invalid reviews`);
		}
		for (const review of task.reviews) {
			if (
				!isRecord(review) ||
				!Number.isSafeInteger(review.revision) ||
				review.revision < 1 ||
				(review.verdict !== "approve" && review.verdict !== "reject") ||
				typeof review.reviewedAt !== "string"
			) {
				throw new AnsteelTeamStateError(`Ansteel team task ${task.id} has invalid reviews`);
			}
			assertRole(review.reviewer, "task reviewer");
			if (review.reviewer === task.owner) {
				throw new AnsteelTeamStateError(`Ansteel team task ${task.id} owner cannot review its own change`);
			}
			if (review.verdict === "reject" && (typeof review.issue !== "string" || review.issue.trim().length === 0)) {
				throw new AnsteelTeamStateError(`Ansteel team task ${task.id} rejection requires an issue`);
			}
		}
	}
	assertAnsteelTeamTaskDependencyGraph(state.tasks);
	assertAnsteelTeamMilestones(state.tasks, state.milestones);
	assertAnsteelPublicCollaborationState(state);
}

function assertAnsteelTeamTaskDependencyGraph(tasks: readonly AnsteelTeamTask[]): void {
	const tasksById = new Map(tasks.map((task) => [task.id, task]));
	for (const task of tasks) {
		if (!Array.isArray(task.dependsOn) || task.dependsOn.some((dependency) => typeof dependency !== "string")) {
			throw new AnsteelTeamStateError(`Ansteel team task ${task.id} has invalid dependencies`);
		}
		if (new Set(task.dependsOn).size !== task.dependsOn.length) {
			throw new AnsteelTeamStateError(`Ansteel team task ${task.id} has duplicate dependencies`);
		}
		for (const dependency of task.dependsOn) {
			assertTaskId(dependency);
			if (dependency === task.id) {
				throw new AnsteelTeamStateError(`Ansteel team task ${task.id} cannot depend on itself`);
			}
			if (!tasksById.has(dependency)) {
				throw new AnsteelTeamStateError(`Ansteel team task ${task.id} depends on unknown task ${dependency}`);
			}
		}
	}

	const visited = new Set<string>();
	const visiting = new Set<string>();
	const visit = (task: AnsteelTeamTask): void => {
		if (visiting.has(task.id)) throw new AnsteelTeamStateError("Ansteel team task dependency cycle");
		if (visited.has(task.id)) return;
		visiting.add(task.id);
		for (const dependency of task.dependsOn) visit(tasksById.get(dependency)!);
		visiting.delete(task.id);
		visited.add(task.id);
	};
	for (const task of tasks) visit(task);

	for (const task of tasks) {
		const dependenciesApproved = task.dependsOn.every(
			(dependency) => tasksById.get(dependency)?.status === "approved",
		);
		if (!dependenciesApproved && task.status !== "blocked") {
			throw new AnsteelTeamStateError(
				`Ansteel team task ${task.id} is unblocked before its dependencies are approved`,
			);
		}
		if (dependenciesApproved && task.status === "blocked") {
			throw new AnsteelTeamStateError(`Ansteel team task ${task.id} is blocked despite approved dependencies`);
		}
	}
}

function reconcileAnsteelTeamTaskDependencies(state: AnsteelTeamState): void {
	const tasksById = new Map(state.tasks.map((task) => [task.id, task]));
	for (const task of state.tasks) {
		const dependenciesApproved = task.dependsOn.every(
			(dependency) => tasksById.get(dependency)?.status === "approved",
		);
		if (!dependenciesApproved && task.status !== "blocked") {
			task.status = "blocked";
			task.testEvidence = [];
		} else if (dependenciesApproved && task.status === "blocked") {
			task.status = "claimed";
		}
	}
	for (const milestone of state.milestones) {
		const tasksApproved = milestone.taskIds.every((taskId) => tasksById.get(taskId)?.status === "approved");
		if (!tasksApproved && milestone.status !== "blocked") {
			milestone.status = "blocked";
			milestone.testEvidence = [];
		} else if (tasksApproved && milestone.status === "blocked") {
			milestone.status = "ready";
		}
	}
}

function assertAnsteelTeamMilestones(tasks: readonly AnsteelTeamTask[], milestones: unknown): void {
	if (!Array.isArray(milestones)) throw new AnsteelTeamStateError("Ansteel team state has invalid milestones");
	const tasksById = new Map(tasks.map((task) => [task.id, task]));
	const milestoneIds = new Set<string>();
	for (const milestone of milestones) {
		if (!isRecord(milestone)) throw new AnsteelTeamStateError("Ansteel team state has invalid milestone entries");
		assertMilestoneId(milestone.id);
		if (milestoneIds.has(milestone.id))
			throw new AnsteelTeamStateError(`Ansteel team milestone ${milestone.id} is duplicated`);
		milestoneIds.add(milestone.id);
		if (
			!Array.isArray(milestone.taskIds) ||
			milestone.taskIds.length === 0 ||
			milestone.taskIds.some((id) => typeof id !== "string")
		) {
			throw new AnsteelTeamStateError(`Ansteel team milestone ${milestone.id} requires task IDs`);
		}
		if (new Set(milestone.taskIds).size !== milestone.taskIds.length) {
			throw new AnsteelTeamStateError(`Ansteel team milestone ${milestone.id} cannot repeat a task`);
		}
		for (const taskId of milestone.taskIds) {
			assertTaskId(taskId);
			if (!tasksById.has(taskId))
				throw new AnsteelTeamStateError(`Ansteel team milestone ${milestone.id} references unknown task ${taskId}`);
		}
		if (typeof milestone.description !== "string" || milestone.description.trim().length === 0) {
			throw new AnsteelTeamStateError(`Ansteel team milestone ${milestone.id} requires a description`);
		}
		if (typeof milestone.acceptanceCriteria !== "string" || milestone.acceptanceCriteria.trim().length === 0) {
			throw new AnsteelTeamStateError(`Ansteel team milestone ${milestone.id} requires acceptance criteria`);
		}
		const revision = milestone.revision;
		if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
			throw new AnsteelTeamStateError(`Ansteel team milestone ${milestone.id} has an invalid revision`);
		}
		if (
			!Array.isArray(milestone.testEvidence) ||
			!Array.isArray(milestone.submissions) ||
			!Array.isArray(milestone.reviews)
		) {
			throw new AnsteelTeamStateError(`Ansteel team milestone ${milestone.id} has invalid evidence`);
		}
		if (
			milestone.status !== "blocked" &&
			milestone.status !== "ready" &&
			milestone.status !== "submitted" &&
			milestone.status !== "revision-required" &&
			milestone.status !== "approved"
		) {
			throw new AnsteelTeamStateError(`Ansteel team milestone ${milestone.id} has an invalid status`);
		}
		const tasksApproved = milestone.taskIds.every((taskId) => tasksById.get(taskId)?.status === "approved");
		if (!tasksApproved && milestone.status !== "blocked") {
			throw new AnsteelTeamStateError(
				`Ansteel team milestone ${milestone.id} is unblocked before its tasks are approved`,
			);
		}
		if (tasksApproved && milestone.status === "blocked") {
			throw new AnsteelTeamStateError(`Ansteel team milestone ${milestone.id} is blocked despite approved tasks`);
		}
	}
}

function assertAnsteelPublicCollaborationState(state: AnsteelTeamState): void {
	if (!Array.isArray(state.workCheckpoints)) {
		throw new AnsteelTeamStateError("Ansteel team state has invalid work checkpoints");
	}
	if (!Array.isArray(state.processIssues)) {
		throw new AnsteelTeamStateError("Ansteel team state has invalid process issues");
	}

	const tasksById = new Map(state.tasks.map((task) => [task.id, task]));
	const checkpointsById = new Map<string, { actor: AnsteelRole; index: number }>();
	const publicIds = new Set<string>();
	const registerPublicId = (id: string, kind: "checkpoint" | "process issue" | "resolution"): void => {
		if (publicIds.has(id)) throw new AnsteelTeamStateError(`Ansteel team ${kind} ${id} is duplicated`);
		publicIds.add(id);
	};

	for (const [index, checkpoint] of state.workCheckpoints.entries()) {
		if (!isRecord(checkpoint)) {
			throw new AnsteelTeamStateError("Ansteel team state has invalid work checkpoint entries");
		}
		assertCheckpointId(checkpoint.id);
		registerPublicId(checkpoint.id, "checkpoint");
		assertRole(checkpoint.actor, `checkpoint ${checkpoint.id} actor`);
		if (checkpoint.taskId !== undefined) {
			assertTaskId(checkpoint.taskId);
			const task = tasksById.get(checkpoint.taskId);
			if (!task) {
				throw new AnsteelTeamStateError(
					`Ansteel team checkpoint ${checkpoint.id} references unknown task ${checkpoint.taskId}`,
				);
			}
			if (task.owner !== checkpoint.actor) {
				throw new AnsteelTeamStateError(
					`Ansteel team checkpoint ${checkpoint.id} must be written by task owner ${task.owner}`,
				);
			}
		}
		assertNonEmptyStateString(checkpoint.goal, `checkpoint ${checkpoint.id} goal`);
		assertNonEmptyStateString(checkpoint.currentUnderstanding, `checkpoint ${checkpoint.id} current understanding`);
		assertStateStringArray(checkpoint.assumptions, `checkpoint ${checkpoint.id} assumptions`);
		assertStateStringArray(checkpoint.evidenceRefs, `checkpoint ${checkpoint.id} evidence references`);
		assertStateStringArray(checkpoint.uncertainties, `checkpoint ${checkpoint.id} uncertainties`);
		if (!isRecord(checkpoint.nextAction)) {
			throw new AnsteelTeamStateError(`Ansteel team checkpoint ${checkpoint.id} has an invalid next action`);
		}
		if (
			checkpoint.nextAction.kind !== "read" &&
			checkpoint.nextAction.kind !== "experiment" &&
			checkpoint.nextAction.kind !== "edit" &&
			checkpoint.nextAction.kind !== "test" &&
			checkpoint.nextAction.kind !== "commit" &&
			checkpoint.nextAction.kind !== "publish" &&
			checkpoint.nextAction.kind !== "decision"
		) {
			throw new AnsteelTeamStateError(`Ansteel team checkpoint ${checkpoint.id} has an invalid next action kind`);
		}
		assertNonEmptyStateString(checkpoint.nextAction.target, `checkpoint ${checkpoint.id} next action target`);
		assertNonEmptyStateString(
			checkpoint.nextAction.expectedResult,
			`checkpoint ${checkpoint.id} next action expected result`,
		);
		if (checkpoint.risk !== "green" && checkpoint.risk !== "yellow" && checkpoint.risk !== "red") {
			throw new AnsteelTeamStateError(`Ansteel team checkpoint ${checkpoint.id} has invalid risk`);
		}
		if (
			checkpoint.confidence !== "L1" &&
			checkpoint.confidence !== "L2" &&
			checkpoint.confidence !== "L3" &&
			checkpoint.confidence !== "L4"
		) {
			throw new AnsteelTeamStateError(`Ansteel team checkpoint ${checkpoint.id} has invalid confidence`);
		}
		if (checkpoint.status !== "active" && checkpoint.status !== "superseded") {
			throw new AnsteelTeamStateError(`Ansteel team checkpoint ${checkpoint.id} has invalid status`);
		}
		assertStateTimestamp(checkpoint.createdAt, `checkpoint ${checkpoint.id} creation time`);
		checkpointsById.set(checkpoint.id, { actor: checkpoint.actor, index });
	}

	for (const [index, checkpoint] of state.workCheckpoints.entries()) {
		if (checkpoint.supersedesCheckpointId === undefined) continue;
		assertCheckpointId(checkpoint.supersedesCheckpointId);
		const superseded = checkpointsById.get(checkpoint.supersedesCheckpointId);
		if (!superseded) {
			throw new AnsteelTeamStateError(
				`Ansteel team checkpoint ${checkpoint.id} supersedes unknown checkpoint ${checkpoint.supersedesCheckpointId}`,
			);
		}
		if (superseded.index >= index) {
			throw new AnsteelTeamStateError(`Ansteel team checkpoint ${checkpoint.id} must supersede an older checkpoint`);
		}
		if (superseded.actor !== checkpoint.actor) {
			throw new AnsteelTeamStateError(
				`Ansteel team checkpoint ${checkpoint.id} must supersede a checkpoint from the same role`,
			);
		}
	}

	for (const issue of state.processIssues) {
		if (!isRecord(issue)) {
			throw new AnsteelTeamStateError("Ansteel team state has invalid process issue entries");
		}
		assertProcessIssueId(issue.id);
		registerPublicId(issue.id, "process issue");
		assertCheckpointId(issue.targetCheckpointId);
		const targetCheckpoint = checkpointsById.get(issue.targetCheckpointId);
		if (!targetCheckpoint) {
			throw new AnsteelTeamStateError(
				`Ansteel team process issue ${issue.id} references unknown checkpoint ${issue.targetCheckpointId}`,
			);
		}
		assertRole(issue.author, `process issue ${issue.id} author`);
		assertRole(issue.targetRole, `process issue ${issue.id} target`);
		if (issue.author === targetCheckpoint.actor) {
			throw new AnsteelTeamStateError(
				`Ansteel team process issue ${issue.id} cannot be written by the checkpoint actor`,
			);
		}
		if (issue.targetRole !== targetCheckpoint.actor) {
			throw new AnsteelTeamStateError(
				`Ansteel team process issue ${issue.id} must target checkpoint actor ${targetCheckpoint.actor}`,
			);
		}
		if (issue.severity !== "advisory" && issue.severity !== "blocking" && issue.severity !== "critical") {
			throw new AnsteelTeamStateError(`Ansteel team process issue ${issue.id} has invalid severity`);
		}
		assertNonEmptyStateString(issue.claim, `process issue ${issue.id} claim`);
		assertStateStringArray(issue.evidenceRefs, `process issue ${issue.id} evidence references`);
		assertNonEmptyStateString(issue.suggestedCorrection, `process issue ${issue.id} suggested correction`);
		if (
			issue.status !== "open" &&
			issue.status !== "resolution-proposed" &&
			issue.status !== "closed" &&
			issue.status !== "escalated"
		) {
			throw new AnsteelTeamStateError(`Ansteel team process issue ${issue.id} has invalid status`);
		}
		if (!Array.isArray(issue.resolutions)) {
			throw new AnsteelTeamStateError(`Ansteel team process issue ${issue.id} has invalid resolutions`);
		}
		assertStateTimestamp(issue.createdAt, `process issue ${issue.id} creation time`);

		for (const resolution of issue.resolutions) {
			if (!isRecord(resolution)) {
				throw new AnsteelTeamStateError(`Ansteel team process issue ${issue.id} has invalid resolution entries`);
			}
			assertProcessResolutionId(resolution.id);
			registerPublicId(resolution.id, "resolution");
			assertProcessIssueId(resolution.issueId);
			if (resolution.issueId !== issue.id) {
				throw new AnsteelTeamStateError(
					`Ansteel team resolution ${resolution.id} must reference containing issue ${issue.id}`,
				);
			}
			assertRole(resolution.actor, `resolution ${resolution.id} actor`);
			if (resolution.actor !== issue.targetRole) {
				throw new AnsteelTeamStateError(
					`Ansteel team resolution ${resolution.id} must be written by ${issue.targetRole}`,
				);
			}
			if (
				resolution.outcome !== "ACCEPTED" &&
				resolution.outcome !== "REFUTED" &&
				resolution.outcome !== "EXPERIMENT_REQUIRED" &&
				resolution.outcome !== "SCOPE_ESCALATION"
			) {
				throw new AnsteelTeamStateError(`Ansteel team resolution ${resolution.id} has an invalid outcome`);
			}
			assertNonEmptyStateString(resolution.summary, `resolution ${resolution.id} summary`);
			assertStateStringArray(resolution.evidenceRefs, `resolution ${resolution.id} evidence references`);
			if (resolution.replacementCheckpointId !== undefined) {
				assertCheckpointId(resolution.replacementCheckpointId);
				const replacement = checkpointsById.get(resolution.replacementCheckpointId);
				if (!replacement) {
					throw new AnsteelTeamStateError(
						`Ansteel team resolution ${resolution.id} references unknown replacement checkpoint ${resolution.replacementCheckpointId}`,
					);
				}
				if (replacement.actor !== resolution.actor) {
					throw new AnsteelTeamStateError(
						`Ansteel team resolution ${resolution.id} replacement checkpoint must belong to ${resolution.actor}`,
					);
				}
			}
			if (resolution.experiment !== undefined) {
				assertNonEmptyStateString(resolution.experiment, `resolution ${resolution.id} experiment`);
			}
			assertStateTimestamp(resolution.createdAt, `resolution ${resolution.id} creation time`);
			if (resolution.review !== undefined) {
				if (!isRecord(resolution.review)) {
					throw new AnsteelTeamStateError(`Ansteel team resolution ${resolution.id} has an invalid review`);
				}
				assertRole(resolution.review.reviewer, `resolution ${resolution.id} reviewer`);
				if (resolution.review.reviewer !== issue.author) {
					throw new AnsteelTeamStateError(
						`Ansteel team resolution ${resolution.id} must be reviewed by ${issue.author}`,
					);
				}
				if (resolution.review.verdict !== "accept" && resolution.review.verdict !== "reject") {
					throw new AnsteelTeamStateError(
						`Ansteel team resolution ${resolution.id} has an invalid review verdict`,
					);
				}
				assertNonEmptyStateString(resolution.review.reason, `resolution ${resolution.id} review reason`);
				assertStateTimestamp(resolution.review.reviewedAt, `resolution ${resolution.id} review time`);
			}
		}

		if (
			issue.status === "closed" &&
			!issue.resolutions.some((resolution) => resolution.review?.verdict === "accept")
		) {
			throw new AnsteelTeamStateError(
				`Ansteel team process issue ${issue.id} is closed without an accepted resolution`,
			);
		}
		if (
			issue.status === "escalated" &&
			!issue.resolutions.some((resolution) => resolution.outcome === "SCOPE_ESCALATION")
		) {
			throw new AnsteelTeamStateError(
				`Ansteel team process issue ${issue.id} is escalated without a SCOPE_ESCALATION resolution`,
			);
		}
	}
}

export function createAnsteelTeamState(options: CreateAnsteelTeamStateOptions): AnsteelTeamState {
	const cwd = assertProjectDirectory(options.cwd);
	if (typeof options.topic !== "string" || options.topic.trim().length === 0) {
		throw new AnsteelTeamStateError("Ansteel team requires a topic");
	}
	assertRoleModels(options.roleModels);
	const taskOwners = normalizeTaskOwners(options.taskOwners ?? DEFAULT_ANSTEEL_TEAM_TASK_OWNERS, "task-owner policy");
	const now = options.now ?? new Date();
	const timestamp = now.toISOString();
	const state: AnsteelTeamState = {
		version: ANSTEEL_TEAM_STATE_VERSION,
		id: createAnsteelTeamId(now),
		topic: options.topic.trim(),
		status: "active",
		createdAt: timestamp,
		updatedAt: timestamp,
		nextEventSequence: 1,
		roles: Object.fromEntries(
			ANSTEEL_ROLES.map((role) => [
				role,
				{ model: options.roleModels[role], sessionFile: getAnsteelTeamRoleSessionPath(cwd, role), status: "idle" },
			]),
		) as Record<AnsteelRole, AnsteelTeamRoleState>,
		taskOwners,
		openChallenges: [],
		tasks: [],
		milestones: [],
		workCheckpoints: [],
		processIssues: [],
		ledgerHeadHash: null,
	};
	assertState(state);
	return state;
}

function normalizeTaskFilePath(cwd: string, file: unknown): string {
	if (typeof file !== "string" || file.trim().length === 0 || isAbsolute(file)) {
		throw new AnsteelTeamStateError("Ansteel team task files must use non-empty project-relative paths");
	}
	const relativePath = getCwdRelativePath(resolvePath(file, cwd), cwd);
	if (relativePath === undefined || relativePath === ".") {
		throw new AnsteelTeamStateError("Ansteel team task files must stay inside the project");
	}
	const normalizedPath = relativePath.replace(/\\/g, "/");
	if (normalizedPath === ".pi" || normalizedPath.startsWith(".pi/")) {
		throw new AnsteelTeamStateError("Ansteel team task files cannot modify team governance state");
	}
	return normalizedPath;
}

function isTaskStillActive(task: AnsteelTeamTask): boolean {
	return task.status !== "approved";
}

export function getAnsteelTeamWriteBlockReason(
	cwd: string,
	state: AnsteelTeamState,
	role: AnsteelRole,
	file: string,
): string | undefined {
	const projectDirectory = assertProjectDirectory(cwd);
	assertState(state);
	assertRole(role, "write role");
	let normalizedFile: string;
	try {
		normalizedFile = normalizeTaskFilePath(projectDirectory, file);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	const task = state.tasks.find((item) => item.files.includes(normalizedFile));
	if (!task) {
		return `Ansteel team writes to ${normalizedFile} must be claimed before code can be modified`;
	}
	if (task.owner !== role) {
		return `Ansteel team writes to ${normalizedFile} must be claimed by ${role}; it belongs to ${task.owner} via ${task.id}`;
	}
	if (task.status === "blocked") {
		return `Ansteel team task ${task.id} is waiting for approved dependencies: ${task.dependsOn.join(", ")}`;
	}
	if (task.status !== "claimed" && task.status !== "revision-required") {
		return `Ansteel team task ${task.id} is ${task.status}; code is frozen until peer review returns it for revision`;
	}
	return undefined;
}

export function isAnsteelTeamGovernancePath(cwd: string, file: unknown): boolean {
	if (typeof file !== "string" || file.trim().length === 0) return false;
	const teamDirectory = getAnsteelTeamDirectory(cwd);
	const resolvedFile = resolvePath(file, cwd);
	return resolvedFile === teamDirectory || getCwdRelativePath(resolvedFile, teamDirectory) !== undefined;
}

export function claimAnsteelTeamTask(
	cwd: string,
	state: AnsteelTeamState,
	input: ClaimAnsteelTeamTaskInput,
	allowedOwners: readonly AnsteelRole[] = DEFAULT_ANSTEEL_TEAM_TASK_OWNERS,
): AnsteelTeamTask {
	const projectDirectory = assertProjectDirectory(cwd);
	assertState(state);
	assertTaskId(input.id);
	assertRole(input.owner, "task owner");
	if (!allowedOwners.includes(input.owner)) {
		throw new AnsteelTeamStateError(
			`Ansteel team role ${input.owner} is not authorized to claim change tasks by the configured teamTaskOwners policy`,
		);
	}
	if (!Array.isArray(input.files) || input.files.length === 0) {
		throw new AnsteelTeamStateError("Ansteel team task requires one or more exact file paths");
	}
	if (typeof input.description !== "string" || input.description.trim().length === 0) {
		throw new AnsteelTeamStateError("Ansteel team task requires a description");
	}
	if (typeof input.acceptanceCriteria !== "string" || input.acceptanceCriteria.trim().length === 0) {
		throw new AnsteelTeamStateError("Ansteel team task requires acceptance criteria");
	}
	if (state.tasks.some((task) => task.id === input.id)) {
		throw new AnsteelTeamStateError(`Ansteel team task ${input.id} already exists`);
	}
	const dependsOn = input.dependsOn ?? [];
	if (!Array.isArray(dependsOn) || dependsOn.some((dependency) => typeof dependency !== "string")) {
		throw new AnsteelTeamStateError("Ansteel team task dependencies must be task IDs");
	}
	if (new Set(dependsOn).size !== dependsOn.length) {
		throw new AnsteelTeamStateError("Ansteel team task cannot declare the same dependency more than once");
	}
	for (const dependency of dependsOn) {
		assertTaskId(dependency);
		if (dependency === input.id) {
			throw new AnsteelTeamStateError(`Ansteel team task ${input.id} cannot depend on itself`);
		}
		if (!state.tasks.some((task) => task.id === dependency)) {
			throw new AnsteelTeamStateError(`Ansteel team task ${input.id} depends on unknown task ${dependency}`);
		}
	}
	const files = [...new Set(input.files.map((file) => normalizeTaskFilePath(projectDirectory, file)))];
	if (files.length !== input.files.length) {
		throw new AnsteelTeamStateError("Ansteel team task cannot claim the same file more than once");
	}
	for (const file of files) {
		const conflictingTask = state.tasks.find((task) => isTaskStillActive(task) && task.files.includes(file));
		if (conflictingTask) {
			throw new AnsteelTeamStateError(`Ansteel team file ${file} is already claimed by ${conflictingTask.id}`);
		}
	}
	const task: AnsteelTeamTask = {
		id: input.id,
		owner: input.owner,
		files,
		description: input.description.trim(),
		acceptanceCriteria: input.acceptanceCriteria.trim(),
		dependsOn: [...dependsOn],
		status: dependsOn.every((dependency) => state.tasks.find((task) => task.id === dependency)?.status === "approved")
			? "claimed"
			: "blocked",
		revision: 0,
		testEvidence: [],
		submissions: [],
		reviews: [],
	};
	state.tasks.push(task);
	saveAnsteelTeamState(projectDirectory, state);
	return task;
}

export function createAnsteelTeamMilestone(
	cwd: string,
	state: AnsteelTeamState,
	input: CreateAnsteelTeamMilestoneInput,
): AnsteelTeamMilestone {
	const projectDirectory = assertProjectDirectory(cwd);
	assertState(state);
	assertMilestoneId(input.id);
	if (state.milestones.some((milestone) => milestone.id === input.id)) {
		throw new AnsteelTeamStateError(`Ansteel team milestone ${input.id} already exists`);
	}
	if (
		!Array.isArray(input.taskIds) ||
		input.taskIds.length === 0 ||
		input.taskIds.some((taskId) => typeof taskId !== "string")
	) {
		throw new AnsteelTeamStateError("Ansteel team milestone requires task IDs");
	}
	if (new Set(input.taskIds).size !== input.taskIds.length) {
		throw new AnsteelTeamStateError("Ansteel team milestone cannot repeat a task");
	}
	for (const taskId of input.taskIds) {
		assertTaskId(taskId);
		if (!state.tasks.some((task) => task.id === taskId)) {
			throw new AnsteelTeamStateError(`Ansteel team milestone ${input.id} references unknown task ${taskId}`);
		}
	}
	if (typeof input.description !== "string" || input.description.trim().length === 0) {
		throw new AnsteelTeamStateError("Ansteel team milestone requires a description");
	}
	if (typeof input.acceptanceCriteria !== "string" || input.acceptanceCriteria.trim().length === 0) {
		throw new AnsteelTeamStateError("Ansteel team milestone requires acceptance criteria");
	}
	const tasksApproved = input.taskIds.every(
		(taskId) => state.tasks.find((task) => task.id === taskId)?.status === "approved",
	);
	const milestone: AnsteelTeamMilestone = {
		id: input.id,
		taskIds: [...input.taskIds],
		description: input.description.trim(),
		acceptanceCriteria: input.acceptanceCriteria.trim(),
		status: tasksApproved ? "ready" : "blocked",
		revision: 0,
		testEvidence: [],
		submissions: [],
		reviews: [],
	};
	state.milestones.push(milestone);
	saveAnsteelTeamState(projectDirectory, state);
	return milestone;
}

function getMilestoneForIntegration(
	state: AnsteelTeamState,
	role: AnsteelRole,
	milestoneId: string,
): AnsteelTeamMilestone {
	assertRole(role, "milestone role");
	if (role !== "tech-lead")
		throw new AnsteelTeamStateError("Only Ansteel team tech-lead can submit milestone integration evidence");
	assertMilestoneId(milestoneId);
	const milestone = state.milestones.find((item) => item.id === milestoneId);
	if (!milestone) throw new AnsteelTeamStateError(`Ansteel team milestone ${milestoneId} does not exist`);
	if (milestone.status === "blocked") {
		throw new AnsteelTeamStateError(`Ansteel team milestone ${milestoneId} is waiting for approved tasks`);
	}
	if (milestone.status !== "ready" && milestone.status !== "revision-required") {
		throw new AnsteelTeamStateError(`Ansteel team milestone ${milestoneId} cannot accept new integration evidence`);
	}
	return milestone;
}

export function runAnsteelTeamMilestoneTest(
	cwd: string,
	state: AnsteelTeamState,
	role: AnsteelRole,
	milestoneId: string,
	command: string,
): AnsteelTeamTaskTestEvidence {
	const projectDirectory = assertProjectDirectory(cwd);
	assertState(state);
	const milestone = getMilestoneForIntegration(state, role, milestoneId);
	if (typeof command !== "string") throw new AnsteelTeamStateError("Ansteel team milestone tests require a command");
	const normalizedCommand = assertAllowedTaskTestCommand(command);
	const result = spawnSync(normalizedCommand, {
		cwd: projectDirectory,
		encoding: "utf8",
		shell: true,
		timeout: ANSTEEL_TEAM_TEST_TIMEOUT_MS,
		maxBuffer: 4 * 1024 * 1024,
		windowsHide: true,
	});
	const evidence: AnsteelTeamTaskTestEvidence = {
		command: normalizedCommand,
		output: `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? `\n${result.error.message}` : ""}`.slice(
			0,
			MAX_PUBLIC_EVENT_CONTENT_LENGTH,
		),
		isError: result.status !== 0 || result.error !== undefined,
		completedAt: new Date().toISOString(),
	};
	milestone.testEvidence.push(evidence);
	saveAnsteelTeamState(projectDirectory, state);
	return evidence;
}

export function submitAnsteelTeamMilestone(
	cwd: string,
	state: AnsteelTeamState,
	role: AnsteelRole,
	milestoneId: string,
	testCommand: string,
): AnsteelTeamMilestoneSubmission {
	const projectDirectory = assertProjectDirectory(cwd);
	assertState(state);
	const milestone = getMilestoneForIntegration(state, role, milestoneId);
	const test = [...milestone.testEvidence]
		.reverse()
		.find((evidence) => evidence.command === testCommand.trim() && !evidence.isError);
	if (!test) {
		throw new AnsteelTeamStateError(
			`Ansteel team milestone ${milestoneId} requires a successful recorded result for ${testCommand.trim()}`,
		);
	}
	const submission: AnsteelTeamMilestoneSubmission = {
		revision: milestone.revision + 1,
		submittedAt: new Date().toISOString(),
		test: { ...test },
	};
	milestone.revision = submission.revision;
	milestone.submissions.push(submission);
	milestone.status = "submitted";
	saveAnsteelTeamState(projectDirectory, state);
	return submission;
}

export function reviewAnsteelTeamMilestone(
	cwd: string,
	state: AnsteelTeamState,
	reviewer: AnsteelRole,
	milestoneId: string,
	input: ReviewAnsteelTeamTaskInput,
): AnsteelTeamMilestoneReview {
	const projectDirectory = assertProjectDirectory(cwd);
	assertState(state);
	assertRole(reviewer, "milestone reviewer");
	if (reviewer === "tech-lead")
		throw new AnsteelTeamStateError("Ansteel team tech-lead cannot review its own milestone evidence");
	assertMilestoneId(milestoneId);
	const milestone = state.milestones.find((item) => item.id === milestoneId);
	if (!milestone) throw new AnsteelTeamStateError(`Ansteel team milestone ${milestoneId} does not exist`);
	if (milestone.status !== "submitted" && milestone.status !== "revision-required") {
		throw new AnsteelTeamStateError(
			`Ansteel team milestone ${milestoneId} has no submitted integration evidence to review`,
		);
	}
	if (input.verdict !== "approve" && input.verdict !== "reject") {
		throw new AnsteelTeamStateError("Ansteel team milestone review requires approve or reject");
	}
	if (input.verdict === "reject" && (typeof input.issue !== "string" || input.issue.trim().length === 0)) {
		throw new AnsteelTeamStateError("Ansteel team milestone rejection requires an issue");
	}
	const submission = milestone.submissions.at(-1);
	if (!submission || submission.revision !== milestone.revision) {
		throw new AnsteelTeamStateError(
			`Ansteel team milestone ${milestoneId} has no immutable integration evidence package`,
		);
	}
	if (milestone.reviews.some((review) => review.revision === submission.revision && review.reviewer === reviewer)) {
		throw new AnsteelTeamStateError(
			`Ansteel team milestone ${milestoneId} already has a ${reviewer} review for revision ${submission.revision}`,
		);
	}
	const review: AnsteelTeamMilestoneReview = {
		revision: submission.revision,
		reviewer,
		verdict: input.verdict,
		...(input.verdict === "reject" ? { issue: input.issue!.trim() } : {}),
		reviewedAt: new Date().toISOString(),
	};
	milestone.reviews.push(review);
	if (review.verdict === "reject") {
		milestone.status = "revision-required";
		milestone.testEvidence = [];
	} else if (
		["staff-engineer", "qa-engineer"].every((role) =>
			milestone.reviews.some(
				(item) => item.revision === submission.revision && item.reviewer === role && item.verdict === "approve",
			),
		)
	) {
		milestone.status = "approved";
	}
	saveAnsteelTeamState(projectDirectory, state);
	return review;
}

function getTaskForOwner(state: AnsteelTeamState, role: AnsteelRole, taskId: string): AnsteelTeamTask {
	assertRole(role, "task role");
	assertTaskId(taskId);
	const task = state.tasks.find((item) => item.id === taskId);
	if (!task) throw new AnsteelTeamStateError(`Ansteel team task ${taskId} does not exist`);
	if (task.owner !== role) throw new AnsteelTeamStateError(`Ansteel team task ${taskId} belongs to ${task.owner}`);
	return task;
}

function assertTaskCanBeChanged(task: AnsteelTeamTask): void {
	if (task.status !== "claimed" && task.status !== "revision-required") {
		throw new AnsteelTeamStateError(`Ansteel team task ${task.id} is ${task.status}; it cannot be changed`);
	}
}

export function recordAnsteelTeamTaskTestResult(
	cwd: string,
	state: AnsteelTeamState,
	role: AnsteelRole,
	taskId: string,
	input: RecordAnsteelTeamTaskTestResultInput,
): AnsteelTeamTaskTestEvidence {
	const projectDirectory = assertProjectDirectory(cwd);
	assertState(state);
	const task = getTaskForOwner(state, role, taskId);
	assertTaskCanBeChanged(task);
	if (typeof input.command !== "string" || input.command.trim().length === 0) {
		throw new AnsteelTeamStateError("Ansteel team test evidence requires a command");
	}
	if (typeof input.output !== "string" || typeof input.isError !== "boolean") {
		throw new AnsteelTeamStateError("Ansteel team test evidence requires output and an error status");
	}
	const evidence: AnsteelTeamTaskTestEvidence = {
		command: input.command.trim(),
		output: input.output.slice(0, MAX_PUBLIC_EVENT_CONTENT_LENGTH),
		isError: input.isError,
		completedAt: new Date().toISOString(),
	};
	task.testEvidence.push(evidence);
	saveAnsteelTeamState(projectDirectory, state);
	return evidence;
}

function assertAllowedTaskTestCommand(command: string): string {
	const normalizedCommand = command.trim();
	if (normalizedCommand.length === 0 || normalizedCommand.length > 1_024) {
		throw new AnsteelTeamStateError("Ansteel team task tests require a bounded command");
	}
	if (/[\r\n;&|><`$()]/.test(normalizedCommand) || !ANSTEEL_TEAM_TEST_COMMAND_PREFIX.test(normalizedCommand)) {
		throw new AnsteelTeamStateError(
			"Ansteel team task tests only allow a single supported test, check, lint, or typecheck command",
		);
	}
	return normalizedCommand;
}

export function runAnsteelTeamTaskTest(
	cwd: string,
	state: AnsteelTeamState,
	role: AnsteelRole,
	taskId: string,
	command: string,
): AnsteelTeamTaskTestEvidence {
	const projectDirectory = assertProjectDirectory(cwd);
	assertState(state);
	const task = getTaskForOwner(state, role, taskId);
	assertTaskCanBeChanged(task);
	if (typeof command !== "string") {
		throw new AnsteelTeamStateError("Ansteel team task tests require a command");
	}
	const normalizedCommand = assertAllowedTaskTestCommand(command);
	const result = spawnSync(normalizedCommand, {
		cwd: projectDirectory,
		encoding: "utf8",
		shell: true,
		timeout: ANSTEEL_TEAM_TEST_TIMEOUT_MS,
		maxBuffer: 4 * 1024 * 1024,
		windowsHide: true,
	});
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? `\n${result.error.message}` : ""}`;
	return recordAnsteelTeamTaskTestResult(projectDirectory, state, role, taskId, {
		command: normalizedCommand,
		output,
		isError: result.status !== 0 || result.error !== undefined,
	});
}

function runGit(cwd: string, args: string[], allowedExitCodes: readonly number[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 4 * 1024 * 1024,
		windowsHide: true,
	});
	if (result.error || result.status === null || !allowedExitCodes.includes(result.status)) {
		const reason = result.error?.message ?? result.stderr?.trim() ?? "unknown git failure";
		throw new AnsteelTeamStateError(`Ansteel team could not capture the task diff: ${reason}`);
	}
	return result.stdout;
}

function collectTaskDiff(cwd: string, task: AnsteelTeamTask): string {
	const repository = runGit(cwd, ["rev-parse", "--is-inside-work-tree"], [0]).trim();
	if (repository !== "true") {
		throw new AnsteelTeamStateError("Ansteel team task submission requires a Git worktree");
	}
	const trackedDiff = runGit(cwd, ["diff", "--no-ext-diff", "--binary", "HEAD", "--", ...task.files], [0]);
	const untrackedFiles = runGit(cwd, ["ls-files", "--others", "--exclude-standard", "--", ...task.files], [0])
		.split("\n")
		.map((file) => file.trim())
		.filter((file) => file.length > 0);
	const untrackedDiffs = untrackedFiles.map((file) =>
		runGit(cwd, ["diff", "--no-index", "--binary", "--", "/dev/null", file], [0, 1]),
	);
	return [trackedDiff, ...untrackedDiffs].filter((entry) => entry.length > 0).join("\n");
}

function captureTaskDiff(cwd: string, task: AnsteelTeamTask): string {
	const diff = collectTaskDiff(cwd, task);
	if (diff.trim().length === 0) {
		throw new AnsteelTeamStateError(`Ansteel team task ${task.id} has no Git diff for its claimed files`);
	}
	return diff;
}

export function getAnsteelTeamTaskProgressFingerprint(cwd: string, state: AnsteelTeamState, taskId: string): string {
	const projectDirectory = assertProjectDirectory(cwd);
	assertState(state);
	assertTaskId(taskId);
	const task = state.tasks.find((item) => item.id === taskId);
	if (!task) throw new AnsteelTeamStateError(`Ansteel team task ${taskId} does not exist`);
	const diffHash = createHash("sha256").update(collectTaskDiff(projectDirectory, task), "utf8").digest("hex");
	return createHash("sha256")
		.update(
			JSON.stringify({
				status: task.status,
				revision: task.revision,
				testEvidence: task.testEvidence.length,
				submissions: task.submissions.length,
				reviews: task.reviews.length,
				diffHash,
			}),
			"utf8",
		)
		.digest("hex");
}

export function submitAnsteelTeamTask(
	cwd: string,
	state: AnsteelTeamState,
	role: AnsteelRole,
	taskId: string,
	testCommand: string,
): AnsteelTeamTaskSubmission {
	const projectDirectory = assertProjectDirectory(cwd);
	assertState(state);
	const task = getTaskForOwner(state, role, taskId);
	assertTaskCanBeChanged(task);
	if (typeof testCommand !== "string" || testCommand.trim().length === 0) {
		throw new AnsteelTeamStateError("Ansteel team task submission requires the exact test command");
	}
	const test = [...task.testEvidence]
		.reverse()
		.find((evidence) => evidence.command === testCommand.trim() && !evidence.isError);
	if (!test) {
		throw new AnsteelTeamStateError(
			`Ansteel team task ${task.id} requires a successful recorded result for ${testCommand.trim()}`,
		);
	}
	const submission: AnsteelTeamTaskSubmission = {
		revision: task.revision + 1,
		submittedAt: new Date().toISOString(),
		diff: captureTaskDiff(projectDirectory, task),
		test: { ...test },
	};
	task.revision = submission.revision;
	task.submissions.push(submission);
	task.status = "submitted";
	saveAnsteelTeamState(projectDirectory, state);
	return submission;
}

export function reviewAnsteelTeamTask(
	cwd: string,
	state: AnsteelTeamState,
	reviewer: AnsteelRole,
	taskId: string,
	input: ReviewAnsteelTeamTaskInput,
): AnsteelTeamTaskReview {
	const projectDirectory = assertProjectDirectory(cwd);
	assertState(state);
	assertRole(reviewer, "task reviewer");
	assertTaskId(taskId);
	const task = state.tasks.find((item) => item.id === taskId);
	if (!task) throw new AnsteelTeamStateError(`Ansteel team task ${taskId} does not exist`);
	if (task.owner === reviewer)
		throw new AnsteelTeamStateError(`Ansteel team task ${taskId} owner cannot review its own change`);
	if (task.status !== "submitted" && task.status !== "revision-required") {
		throw new AnsteelTeamStateError(`Ansteel team task ${taskId} has no submitted change to review`);
	}
	if (input.verdict !== "approve" && input.verdict !== "reject") {
		throw new AnsteelTeamStateError("Ansteel team task review requires approve or reject");
	}
	if (input.verdict === "reject" && (typeof input.issue !== "string" || input.issue.trim().length === 0)) {
		throw new AnsteelTeamStateError("Ansteel team task rejection requires an issue");
	}
	const submission = task.submissions.at(-1);
	if (!submission || submission.revision !== task.revision) {
		throw new AnsteelTeamStateError(`Ansteel team task ${taskId} has no immutable evidence package to review`);
	}
	if (task.reviews.some((review) => review.revision === submission.revision && review.reviewer === reviewer)) {
		throw new AnsteelTeamStateError(
			`Ansteel team task ${taskId} already has a ${reviewer} review for revision ${submission.revision}`,
		);
	}
	const review: AnsteelTeamTaskReview = {
		revision: submission.revision,
		reviewer,
		verdict: input.verdict,
		...(input.verdict === "reject" ? { issue: input.issue!.trim() } : {}),
		reviewedAt: new Date().toISOString(),
	};
	task.reviews.push(review);
	if (review.verdict === "reject") {
		task.status = "revision-required";
		task.testEvidence = [];
	} else {
		const peerReviews = task.reviews.filter((item) => item.revision === submission.revision);
		const peerRoles = ANSTEEL_ROLES.filter((role) => role !== task.owner);
		if (peerRoles.every((role) => peerReviews.some((item) => item.reviewer === role && item.verdict === "approve"))) {
			task.status = "approved";
		}
	}
	reconcileAnsteelTeamTaskDependencies(state);
	saveAnsteelTeamState(projectDirectory, state);
	return review;
}

function writeBuffer(fd: number, content: Buffer): void {
	let offset = 0;
	while (offset < content.length) offset += writeSync(fd, content, offset, content.length - offset);
}

function writeDurableTemporaryFile(path: string, content: string): void {
	const temporaryPath = `${path}.${process.pid}.tmp`;
	const fd = openSync(temporaryPath, "w");
	try {
		writeBuffer(fd, Buffer.from(content, "utf8"));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temporaryPath, path);
}

function appendDurableLine(path: string, line: string): void {
	const fd = openSync(path, "a");
	try {
		writeBuffer(fd, Buffer.from(line, "utf8"));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function writeAnsteelTeamState(
	path: string,
	state: AnsteelTeamState,
	persistence?: AnsteelTeamPersistenceContext,
): void {
	const directory = getAnsteelTeamDirectoryFromStatePath(path);
	mkdirSync(directory, { recursive: true });
	writeDurableTemporaryFile(path, `${JSON.stringify(state, null, "\t")}\n`);
	persistence?.logger.write({
		level: "audit",
		eventName: "state.persisted",
		outcome: "succeeded",
		role: "coordinator",
		...(persistence.causeEventId === undefined ? {} : { causeEventId: persistence.causeEventId }),
		message: "Ansteel team state persisted",
		data: { status: state.status, version: state.version, nextEventSequence: state.nextEventSequence },
	});
}

interface AnsteelTeamPendingTransaction {
	state: AnsteelTeamState;
	event: AnsteelTeamEvent;
}

function writeAnsteelTeamPendingTransaction(
	cwd: string,
	transaction: AnsteelTeamPendingTransaction,
	persistence?: AnsteelTeamPersistenceContext,
): void {
	const path = getAnsteelTeamTransactionPath(cwd);
	mkdirSync(getAnsteelTeamDirectory(cwd), { recursive: true });
	writeDurableTemporaryFile(path, `${JSON.stringify(transaction)}\n`);
	persistence?.logger.write({
		level: "audit",
		eventName: "transaction.persisted",
		outcome: "succeeded",
		role: "coordinator",
		...(persistence.causeEventId === undefined ? {} : { causeEventId: persistence.causeEventId }),
		message: "Ansteel team pending transaction persisted",
		data: { eventSequence: transaction.event.sequence },
	});
}

function recoverAnsteelTeamPendingTransaction(cwd: string, persistence?: AnsteelTeamPersistenceContext): void {
	const path = getAnsteelTeamTransactionPath(cwd);
	if (!existsSync(path)) return;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new AnsteelTeamStateError(
			`Ansteel team transaction could not be read: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!isRecord(raw)) throw new AnsteelTeamStateError("Ansteel team transaction must be a JSON object");
	const state = parseAnsteelTeamState(raw.state);
	const event = parseAnsteelTeamEvent(raw.event);
	const events = listAnsteelTeamEvents(cwd);
	const last = events.at(-1);
	if (last?.hash !== event.hash) {
		if (event.sequence !== events.length + 1 || event.previousHash !== (last?.hash ?? null)) {
			throw new AnsteelTeamStateError("Ansteel team transaction does not continue the event ledger");
		}
		appendDurableLine(getAnsteelTeamEventPath(cwd), `${JSON.stringify(event)}\n`);
		persistence?.logger.write({
			level: "audit",
			eventName: "event.appended",
			outcome: "succeeded",
			role: "coordinator",
			message: "Recovered Ansteel team event appended",
			data: { eventSequence: event.sequence, recovered: true },
		});
		persistence?.logger.write({
			level: "audit",
			eventName: "event.fsync.completed",
			outcome: "succeeded",
			role: "coordinator",
			message: "Recovered Ansteel team event fsync completed",
			data: { eventSequence: event.sequence, recovered: true },
		});
	}
	writeAnsteelTeamState(getAnsteelTeamStatePath(cwd), state, persistence);
	unlinkSync(path);
}

function getAnsteelTeamDirectoryFromStatePath(path: string): string {
	return resolvePath(join(path, ".."));
}

export function saveAnsteelTeamState(
	cwd: string,
	state: AnsteelTeamState,
	persistence?: AnsteelTeamPersistenceContext,
): void {
	assertProjectDirectory(cwd);
	assertState(state);
	assertAnsteelTeamEventLedger(cwd, state);
	writeAnsteelTeamState(getAnsteelTeamStatePath(cwd), state, persistence);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function migrateAnsteelTeamState(value: unknown): unknown {
	if (!isRecord(value)) return value;
	let state = value.version === 1 && !("tasks" in value) ? { ...value, version: 2, tasks: [] } : value;
	if (state.version === 2) state = { ...state, version: 3, ledgerHeadHash: null };
	if (state.version === 3) {
		// Version 3 had no owner restriction, so a resume must explicitly confirm all roles.
		state = { ...state, version: 4, taskOwners: [...ANSTEEL_ROLES] };
	}
	if (state.version === 4) {
		state = {
			...state,
			version: 5,
			tasks: Array.isArray(state.tasks)
				? state.tasks.map((task) => (isRecord(task) ? { ...task, dependsOn: [] } : task))
				: state.tasks,
		};
	}
	if (state.version === 5) state = { ...state, version: 6, milestones: [] };
	if (state.version === 6) {
		state = { ...state, version: ANSTEEL_TEAM_STATE_VERSION, workCheckpoints: [], processIssues: [] };
	}
	return state;
}

function parseAnsteelTeamState(value: unknown): AnsteelTeamState {
	const migratedValue = migrateAnsteelTeamState(value);
	if (!isRecord(migratedValue)) throw new AnsteelTeamStateError("Ansteel team state must be a JSON object");
	const state = migratedValue as unknown as AnsteelTeamState;
	assertState(state);
	return state;
}

function requiresLegacyEventLedgerMigration(value: unknown): boolean {
	return isRecord(value) && (value.version === 1 || value.version === 2);
}

function writeAnsteelTeamEventLedger(
	cwd: string,
	events: readonly AnsteelTeamEvent[],
	persistence?: AnsteelTeamPersistenceContext,
): void {
	const path = getAnsteelTeamEventPath(cwd);
	mkdirSync(getAnsteelTeamDirectory(cwd), { recursive: true });
	writeDurableTemporaryFile(
		path,
		`${events.map((event) => JSON.stringify(event)).join("\n")}${events.length === 0 ? "" : "\n"}`,
	);
	persistence?.logger.write({
		level: "audit",
		eventName: "event.ledger.rewritten",
		outcome: "succeeded",
		role: "coordinator",
		message: "Ansteel team event ledger rewritten",
		data: { eventCount: events.length },
	});
}

function migrateLegacyAnsteelTeamEventLedger(
	cwd: string,
	state: AnsteelTeamState,
	persistence?: AnsteelTeamPersistenceContext,
): void {
	const rawEvents = readAnsteelTeamEventLedger(cwd);
	const hashFieldPresence = rawEvents.map(
		(event) => isRecord(event) && (Object.hasOwn(event, "previousHash") || Object.hasOwn(event, "hash")),
	);
	if (hashFieldPresence.some(Boolean)) {
		if (hashFieldPresence.every(Boolean)) {
			throw new AnsteelTeamStateError("Ansteel team legacy state cannot be migrated from a hashed event ledger");
		}
		throw new AnsteelTeamStateError("Ansteel team event ledger has mixed legacy and hashed events");
	}

	const events: AnsteelTeamEvent[] = [];
	let previousHash: string | null = null;
	for (let index = 0; index < rawEvents.length; index++) {
		const legacyEvent = parseAnsteelTeamEventFields(rawEvents[index]);
		if (legacyEvent.sequence !== index + 1) {
			throw new AnsteelTeamStateError("Ansteel team event ledger has a non-contiguous sequence");
		}
		const unsignedEvent = { ...legacyEvent, previousHash };
		const event: AnsteelTeamEvent = { ...unsignedEvent, hash: hashAnsteelTeamEvent(unsignedEvent) };
		events.push(event);
		previousHash = event.hash;
	}
	if (state.nextEventSequence !== events.length + 1) {
		throw new AnsteelTeamStateError("Ansteel team next event sequence does not match the event ledger");
	}
	state.ledgerHeadHash = previousHash;
	writeAnsteelTeamEventLedger(cwd, events, persistence);
	writeAnsteelTeamState(getAnsteelTeamStatePath(cwd), state, persistence);
}

export function loadAnsteelTeamState(
	cwd: string,
	persistence?: AnsteelTeamPersistenceContext,
): AnsteelTeamState | undefined {
	recoverAnsteelTeamPendingTransaction(cwd, persistence);
	const path = getAnsteelTeamStatePath(cwd);
	if (!existsSync(path)) return undefined;
	try {
		const rawState = JSON.parse(readFileSync(path, "utf8"));
		const state = parseAnsteelTeamState(rawState);
		if (requiresLegacyEventLedgerMigration(rawState)) {
			migrateLegacyAnsteelTeamEventLedger(cwd, state, persistence);
		} else if (isRecord(rawState) && rawState.version !== state.version) {
			writeAnsteelTeamState(path, state, persistence);
		}
		assertAnsteelTeamEventLedger(cwd, state);
		return state;
	} catch (error) {
		if (error instanceof AnsteelTeamStateError) throw error;
		throw new AnsteelTeamStateError(
			`Ansteel team state could not be read: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function isAnsteelPublicCollaborationEventType(type: AnsteelTeamEventType): boolean {
	return (
		type === "work-checkpoint" ||
		type === "process-issue" ||
		type === "process-resolution" ||
		type === "process-resolution-review"
	);
}

function assertAnsteelTeamPublicEventEnvelope(event: AnsteelTeamEvent): void {
	if (event.schemaVersion !== 2) {
		throw new AnsteelTeamStateError("Ansteel team public collaboration events require schema version 2");
	}
	if (event.role === "coordinator") {
		throw new AnsteelTeamStateError("Ansteel team public collaboration events require a role actor");
	}
	if (!isRecord(event.payload)) {
		throw new AnsteelTeamStateError("Ansteel team public collaboration events require a structured payload");
	}
	if (event.type === "work-checkpoint") {
		assertCheckpointId(event.checkpointId);
		if (event.payload.kind !== "work-checkpoint" || !isRecord(event.payload.checkpoint)) {
			throw new AnsteelTeamStateError("Ansteel team work-checkpoint event has an invalid payload");
		}
		if (event.payload.checkpoint.id !== event.checkpointId || event.payload.checkpoint.actor !== event.role) {
			throw new AnsteelTeamStateError("Ansteel team work-checkpoint event identity does not match its payload");
		}
		return;
	}
	assertProcessIssueId(event.issueId);
	if (event.type === "process-issue") {
		if (event.payload.kind !== "process-issue" || !isRecord(event.payload.issue)) {
			throw new AnsteelTeamStateError("Ansteel team process-issue event has an invalid payload");
		}
		if (
			event.payload.issue.id !== event.issueId ||
			event.payload.issue.author !== event.role ||
			event.payload.issue.targetRole !== event.targetRole
		) {
			throw new AnsteelTeamStateError("Ansteel team process-issue event identity does not match its payload");
		}
		return;
	}
	assertProcessResolutionId(event.resolutionId);
	if (event.type === "process-resolution") {
		if (event.payload.kind !== "process-resolution" || !isRecord(event.payload.resolution)) {
			throw new AnsteelTeamStateError("Ansteel team process-resolution event has an invalid payload");
		}
		if (
			event.payload.issueId !== event.issueId ||
			event.payload.resolution.id !== event.resolutionId ||
			event.payload.resolution.issueId !== event.issueId ||
			event.payload.resolution.actor !== event.role
		) {
			throw new AnsteelTeamStateError("Ansteel team process-resolution event identity does not match its payload");
		}
		return;
	}
	if (
		event.payload.kind !== "process-resolution-review" ||
		!isRecord(event.payload.review) ||
		event.payload.issueId !== event.issueId ||
		event.payload.resolutionId !== event.resolutionId ||
		event.payload.review.reviewer !== event.role
	) {
		throw new AnsteelTeamStateError(
			"Ansteel team process-resolution-review event identity does not match its payload",
		);
	}
}

function parseAnsteelTeamEventFields(value: unknown): Omit<AnsteelTeamEvent, "previousHash" | "hash"> {
	if (!isRecord(value)) throw new AnsteelTeamStateError("Ansteel team event must be a JSON object");
	const event = value as unknown as AnsteelTeamEvent;
	if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) {
		throw new AnsteelTeamStateError("Ansteel team event has an invalid sequence");
	}
	if (
		event.type !== "role-report" &&
		event.type !== "challenge" &&
		event.type !== "resolution" &&
		event.type !== "role-failure" &&
		event.type !== "task-assigned" &&
		event.type !== "task-claimed" &&
		event.type !== "task-submitted" &&
		event.type !== "task-review" &&
		event.type !== "milestone-planned" &&
		event.type !== "milestone-submitted" &&
		event.type !== "milestone-review" &&
		event.type !== "work-checkpoint" &&
		event.type !== "process-issue" &&
		event.type !== "process-resolution" &&
		event.type !== "process-resolution-review"
	) {
		throw new AnsteelTeamStateError("Ansteel team event has an invalid type");
	}
	if (event.schemaVersion !== undefined && event.schemaVersion !== 1 && event.schemaVersion !== 2) {
		throw new AnsteelTeamStateError("Ansteel team event has an invalid schema version");
	}
	const isPublicCollaborationEvent = isAnsteelPublicCollaborationEventType(event.type);
	if (event.role === "coordinator") {
		if (event.type !== "task-assigned") {
			throw new AnsteelTeamStateError("Ansteel team coordinator can only record task-assigned events");
		}
	} else {
		assertRole(event.role, "event role");
	}
	assertPublicContent(event.content);
	if (typeof event.createdAt !== "string" || Number.isNaN(Date.parse(event.createdAt))) {
		throw new AnsteelTeamStateError("Ansteel team event has an invalid timestamp");
	}
	if (event.type === "challenge") {
		assertRole(event.targetRole, "challenge target");
		if (event.targetRole === event.role)
			throw new AnsteelTeamStateError("Ansteel team challenges cannot target their author");
		assertChallengeId(event.challengeId, "challenge");
	}
	if (event.type === "resolution") assertChallengeId(event.challengeId, "resolution");
	if (event.type === "task-assigned") {
		if (event.role !== "coordinator") {
			throw new AnsteelTeamStateError("Ansteel team task-assigned events require the coordinator actor");
		}
		assertRole(event.targetRole, "assigned task owner");
	}
	if (isPublicCollaborationEvent) {
		assertAnsteelTeamPublicEventEnvelope(event);
	} else if (
		event.schemaVersion === 2 ||
		event.checkpointId !== undefined ||
		event.issueId !== undefined ||
		event.resolutionId !== undefined ||
		event.payload !== undefined
	) {
		throw new AnsteelTeamStateError("Ansteel team schema version 2 is reserved for public collaboration events");
	}
	return {
		sequence: event.sequence,
		type: event.type,
		role: event.role,
		...(event.targetRole === undefined ? {} : { targetRole: event.targetRole }),
		...(event.challengeId === undefined ? {} : { challengeId: event.challengeId }),
		...(event.schemaVersion === undefined ? {} : { schemaVersion: event.schemaVersion }),
		...(event.checkpointId === undefined ? {} : { checkpointId: event.checkpointId }),
		...(event.issueId === undefined ? {} : { issueId: event.issueId }),
		...(event.resolutionId === undefined ? {} : { resolutionId: event.resolutionId }),
		...(event.payload === undefined ? {} : { payload: structuredClone(event.payload) }),
		content: event.content,
		createdAt: event.createdAt,
	};
}

function parseAnsteelTeamEvent(value: unknown): AnsteelTeamEvent {
	const fields = parseAnsteelTeamEventFields(value);
	if (!isRecord(value)) throw new AnsteelTeamStateError("Ansteel team event must be a JSON object");
	const previousHash = value.previousHash;
	const hash = value.hash;
	assertLedgerHash(previousHash, "event previous hash", true);
	assertLedgerHash(hash, "event hash", false);
	return { ...fields, previousHash, hash };
}

function hashAnsteelTeamEvent(event: Omit<AnsteelTeamEvent, "hash">): string {
	if (event.schemaVersion === 2) {
		return createHash("sha256")
			.update(
				JSON.stringify({
					schemaVersion: event.schemaVersion,
					sequence: event.sequence,
					type: event.type,
					role: event.role,
					targetRole: event.targetRole ?? null,
					challengeId: event.challengeId ?? null,
					checkpointId: event.checkpointId ?? null,
					issueId: event.issueId ?? null,
					resolutionId: event.resolutionId ?? null,
					payload: event.payload ?? null,
					content: event.content,
					createdAt: event.createdAt,
					previousHash: event.previousHash,
				}),
				"utf8",
			)
			.digest("hex");
	}
	return createHash("sha256")
		.update(
			JSON.stringify({
				sequence: event.sequence,
				type: event.type,
				role: event.role,
				targetRole: event.targetRole ?? null,
				challengeId: event.challengeId ?? null,
				content: event.content,
				createdAt: event.createdAt,
				previousHash: event.previousHash,
			}),
			"utf8",
		)
		.digest("hex");
}

function readAnsteelTeamEventLedger(cwd: string): unknown[] {
	const path = getAnsteelTeamEventPath(cwd);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch (error) {
				if (error instanceof AnsteelTeamStateError) throw error;
				throw new AnsteelTeamStateError(
					`Ansteel team event ledger could not be read: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		});
}

export function listAnsteelTeamEvents(cwd: string): AnsteelTeamEvent[] {
	const events = readAnsteelTeamEventLedger(cwd).map((event) => parseAnsteelTeamEvent(event));
	let previousHash: string | null = null;
	for (let index = 0; index < events.length; index++) {
		if (events[index].sequence !== index + 1) {
			throw new AnsteelTeamStateError("Ansteel team event ledger has a non-contiguous sequence");
		}
		if (events[index].previousHash !== previousHash) {
			throw new AnsteelTeamStateError("Ansteel team event ledger has an invalid previous hash");
		}
		if (events[index].hash !== hashAnsteelTeamEvent(events[index])) {
			throw new AnsteelTeamStateError("Ansteel team event ledger has a hash mismatch");
		}
		previousHash = events[index].hash;
	}
	return events;
}

function assertAnsteelTeamEventLedger(cwd: string, state: AnsteelTeamState): void {
	const events = listAnsteelTeamEvents(cwd);
	const ledgerHeadHash = events.at(-1)?.hash ?? null;
	if (state.ledgerHeadHash !== ledgerHeadHash) {
		throw new AnsteelTeamStateError("Ansteel team ledger head hash does not match the event chain");
	}
	if (state.nextEventSequence !== events.length + 1) {
		throw new AnsteelTeamStateError("Ansteel team next event sequence does not match the event ledger");
	}
}

function applyAnsteelTeamEvent(state: AnsteelTeamState, event: AnsteelTeamEvent): void {
	if (event.type === "challenge") {
		if (state.openChallenges.some((challenge) => challenge.id === event.challengeId)) {
			throw new AnsteelTeamStateError(`Ansteel team challenge ${event.challengeId} already exists`);
		}
		state.openChallenges.push({
			id: event.challengeId!,
			raisedBy: event.role as AnsteelRole,
			targetRole: event.targetRole!,
			status: "open",
		});
	}
	if (event.type === "resolution") {
		const challenge = state.openChallenges.find((item) => item.id === event.challengeId && item.status === "open");
		if (!challenge) throw new AnsteelTeamStateError(`Ansteel team has no open challenge ${event.challengeId}`);
		if (challenge.targetRole !== event.role) {
			throw new AnsteelTeamStateError(
				`Ansteel team challenge ${event.challengeId} must be resolved by ${challenge.targetRole}`,
			);
		}
		challenge.status = "resolved";
	}
	if (event.schemaVersion !== 2 || event.payload === undefined) return;
	const payload = event.payload;
	if (payload.kind === "work-checkpoint") {
		const checkpoint = structuredClone(payload.checkpoint);
		if (checkpoint.supersedesCheckpointId !== undefined) {
			const superseded = state.workCheckpoints.find((item) => item.id === checkpoint.supersedesCheckpointId);
			if (!superseded) {
				throw new AnsteelTeamStateError(
					`Ansteel team checkpoint ${checkpoint.id} supersedes unknown checkpoint ${checkpoint.supersedesCheckpointId}`,
				);
			}
			superseded.status = "superseded";
		}
		state.workCheckpoints.push(checkpoint);
		return;
	}
	if (payload.kind === "process-issue") {
		state.processIssues.push(structuredClone(payload.issue));
		return;
	}
	const issue = state.processIssues.find((item) => item.id === payload.issueId);
	if (!issue) {
		throw new AnsteelTeamStateError(`Ansteel team has no process issue ${payload.issueId}`);
	}
	if (payload.kind === "process-resolution") {
		issue.resolutions.push(structuredClone(payload.resolution));
		issue.status = payload.resolution.outcome === "SCOPE_ESCALATION" ? "escalated" : "resolution-proposed";
		return;
	}
	const resolution = issue.resolutions.find((item) => item.id === payload.resolutionId);
	if (!resolution) {
		throw new AnsteelTeamStateError(
			`Ansteel team process issue ${issue.id} has no resolution ${payload.resolutionId}`,
		);
	}
	resolution.review = structuredClone(payload.review);
	if (resolution.review.verdict === "reject") {
		issue.status = "open";
	} else if (resolution.outcome === "SCOPE_ESCALATION") {
		issue.status = "escalated";
	} else {
		issue.status = "closed";
	}
}

export function appendAnsteelTeamEvent(
	cwd: string,
	state: AnsteelTeamState,
	input: AnsteelTeamEventInput,
	persistence?: AnsteelTeamPersistenceContext,
): AnsteelTeamEvent {
	assertProjectDirectory(cwd);
	assertState(state);
	assertAnsteelTeamEventLedger(cwd, state);
	const unsignedEvent = {
		...input,
		sequence: state.nextEventSequence,
		createdAt: new Date().toISOString(),
		previousHash: state.ledgerHeadHash,
	};
	const event = parseAnsteelTeamEvent({
		...unsignedEvent,
		hash: hashAnsteelTeamEvent(unsignedEvent),
	});
	const previewState = structuredClone(state);
	applyAnsteelTeamEvent(previewState, event);
	assertState(previewState);
	applyAnsteelTeamEvent(state, event);
	state.nextEventSequence = event.sequence + 1;
	state.ledgerHeadHash = event.hash;
	state.updatedAt = event.createdAt;
	writeAnsteelTeamPendingTransaction(cwd, { state, event }, persistence);
	mkdirSync(getAnsteelTeamDirectory(cwd), { recursive: true });
	appendDurableLine(getAnsteelTeamEventPath(cwd), `${JSON.stringify(event)}\n`);
	persistence?.logger.write({
		level: "audit",
		eventName: "event.appended",
		outcome: "succeeded",
		role: "coordinator",
		...(persistence.causeEventId === undefined ? {} : { causeEventId: persistence.causeEventId }),
		message: "Ansteel team event appended",
		data: { eventSequence: event.sequence, eventType: event.type, eventHash: event.hash },
	});
	persistence?.logger.write({
		level: "audit",
		eventName: "event.fsync.completed",
		outcome: "succeeded",
		role: "coordinator",
		...(persistence.causeEventId === undefined ? {} : { causeEventId: persistence.causeEventId }),
		message: "Ansteel team event fsync completed",
		data: { eventSequence: event.sequence },
	});
	saveAnsteelTeamState(cwd, state, persistence);
	unlinkSync(getAnsteelTeamTransactionPath(cwd));
	return event;
}

export function publishAnsteelWorkCheckpoint(
	cwd: string,
	state: AnsteelTeamState,
	actor: AnsteelRole,
	input: AnsteelWorkCheckpointInput,
	persistence?: AnsteelTeamPersistenceContext,
): AnsteelWorkCheckpoint {
	assertRole(actor, "checkpoint actor");
	if (state.workCheckpoints.some((checkpoint) => checkpoint.id === input.id)) {
		throw new AnsteelTeamStateError(`Ansteel team checkpoint ${input.id} already exists`);
	}
	if (input.supersedesCheckpointId !== undefined) {
		const superseded = state.workCheckpoints.find((checkpoint) => checkpoint.id === input.supersedesCheckpointId);
		if (!superseded) {
			throw new AnsteelTeamStateError(
				`Ansteel team checkpoint ${input.id} supersedes unknown checkpoint ${input.supersedesCheckpointId}`,
			);
		}
		if (superseded.status !== "active") {
			throw new AnsteelTeamStateError(`Ansteel team checkpoint ${input.id} must supersede an active checkpoint`);
		}
	}
	const checkpoint: AnsteelWorkCheckpoint = {
		...structuredClone(input),
		actor,
		status: "active",
		createdAt: new Date().toISOString(),
	};
	appendAnsteelTeamEvent(
		cwd,
		state,
		{
			schemaVersion: 2,
			type: "work-checkpoint",
			role: actor,
			checkpointId: checkpoint.id,
			content: `Published work checkpoint ${checkpoint.id}`,
			payload: { kind: "work-checkpoint", checkpoint },
		},
		persistence,
	);
	return state.workCheckpoints.find((item) => item.id === checkpoint.id)!;
}

export function raiseAnsteelProcessIssue(
	cwd: string,
	state: AnsteelTeamState,
	author: AnsteelRole,
	input: AnsteelProcessIssueInput,
	persistence?: AnsteelTeamPersistenceContext,
): AnsteelProcessIssue {
	assertRole(author, "process issue author");
	if (state.processIssues.some((issue) => issue.id === input.id)) {
		throw new AnsteelTeamStateError(`Ansteel team process issue ${input.id} already exists`);
	}
	const checkpoint = state.workCheckpoints.find((item) => item.id === input.targetCheckpointId);
	if (!checkpoint) {
		throw new AnsteelTeamStateError(
			`Ansteel team process issue ${input.id} references unknown checkpoint ${input.targetCheckpointId}`,
		);
	}
	if (checkpoint.actor === author) {
		throw new AnsteelTeamStateError("Ansteel team process issue author cannot challenge its own checkpoint");
	}
	const issue: AnsteelProcessIssue = {
		...structuredClone(input),
		author,
		targetRole: checkpoint.actor,
		status: "open",
		resolutions: [],
		createdAt: new Date().toISOString(),
	};
	appendAnsteelTeamEvent(
		cwd,
		state,
		{
			schemaVersion: 2,
			type: "process-issue",
			role: author,
			targetRole: checkpoint.actor,
			checkpointId: checkpoint.id,
			issueId: issue.id,
			content: `Raised process issue ${issue.id} against ${checkpoint.id}`,
			payload: { kind: "process-issue", issue },
		},
		persistence,
	);
	return state.processIssues.find((item) => item.id === issue.id)!;
}

export function resolveAnsteelProcessIssue(
	cwd: string,
	state: AnsteelTeamState,
	actor: AnsteelRole,
	input: AnsteelProcessResolutionInput,
	persistence?: AnsteelTeamPersistenceContext,
): AnsteelProcessResolution {
	assertRole(actor, "process resolution actor");
	const issue = state.processIssues.find((item) => item.id === input.issueId);
	if (!issue) throw new AnsteelTeamStateError(`Ansteel team has no process issue ${input.issueId}`);
	if (issue.targetRole !== actor) {
		throw new AnsteelTeamStateError(`Ansteel team process issue ${issue.id} must be resolved by ${issue.targetRole}`);
	}
	if (issue.status !== "open") {
		throw new AnsteelTeamStateError(`Ansteel team process issue ${issue.id} is not open for a new resolution`);
	}
	if (state.processIssues.some((item) => item.resolutions.some((resolution) => resolution.id === input.id))) {
		throw new AnsteelTeamStateError(`Ansteel team process resolution ${input.id} already exists`);
	}
	const targetCheckpoint = state.workCheckpoints.find((item) => item.id === issue.targetCheckpointId)!;
	if (input.outcome === "ACCEPTED") {
		if (input.replacementCheckpointId === undefined) {
			throw new AnsteelTeamStateError("Ansteel team ACCEPTED resolution requires a replacement checkpoint");
		}
		const replacement = state.workCheckpoints.find((item) => item.id === input.replacementCheckpointId);
		if (!replacement) {
			throw new AnsteelTeamStateError(
				`Ansteel team ACCEPTED resolution references unknown replacement checkpoint ${input.replacementCheckpointId}`,
			);
		}
		if (
			replacement.actor !== actor ||
			replacement.supersedesCheckpointId !== targetCheckpoint.id ||
			replacement.taskId !== targetCheckpoint.taskId
		) {
			throw new AnsteelTeamStateError(
				"Ansteel team ACCEPTED resolution must use a same-role checkpoint that directly supersedes the target and keeps its task",
			);
		}
	}
	if (input.outcome === "REFUTED") {
		const existingEvidence = new Set([
			...targetCheckpoint.evidenceRefs,
			...issue.evidenceRefs,
			...issue.resolutions.flatMap((resolution) => resolution.evidenceRefs),
		]);
		if (input.evidenceRefs.length === 0 || input.evidenceRefs.every((reference) => existingEvidence.has(reference))) {
			throw new AnsteelTeamStateError("Ansteel team REFUTED resolution requires new evidence");
		}
	}
	if (
		input.outcome === "EXPERIMENT_REQUIRED" &&
		(typeof input.experiment !== "string" || input.experiment.trim().length === 0)
	) {
		throw new AnsteelTeamStateError("Ansteel team EXPERIMENT_REQUIRED resolution requires a minimal experiment");
	}
	const resolution: AnsteelProcessResolution = {
		...structuredClone(input),
		actor,
		createdAt: new Date().toISOString(),
	};
	appendAnsteelTeamEvent(
		cwd,
		state,
		{
			schemaVersion: 2,
			type: "process-resolution",
			role: actor,
			checkpointId: targetCheckpoint.id,
			issueId: issue.id,
			resolutionId: resolution.id,
			content: `Proposed ${resolution.outcome} resolution ${resolution.id} for ${issue.id}`,
			payload: { kind: "process-resolution", issueId: issue.id, resolution },
		},
		persistence,
	);
	return state.processIssues
		.find((item) => item.id === issue.id)!
		.resolutions.find((item) => item.id === resolution.id)!;
}

export function reviewAnsteelProcessResolution(
	cwd: string,
	state: AnsteelTeamState,
	reviewer: AnsteelRole,
	issueId: string,
	input: AnsteelProcessResolutionReviewInput,
	persistence?: AnsteelTeamPersistenceContext,
): AnsteelProcessIssue {
	assertRole(reviewer, "process resolution reviewer");
	const issue = state.processIssues.find((item) => item.id === issueId);
	if (!issue) throw new AnsteelTeamStateError(`Ansteel team has no process issue ${issueId}`);
	if (issue.author !== reviewer) {
		throw new AnsteelTeamStateError(
			`Ansteel team process issue ${issue.id} can only be reviewed by its issue author`,
		);
	}
	if (issue.status !== "resolution-proposed") {
		throw new AnsteelTeamStateError(`Ansteel team process issue ${issue.id} has no proposed resolution to review`);
	}
	const resolution = [...issue.resolutions].reverse().find((item) => item.review === undefined);
	if (!resolution) {
		throw new AnsteelTeamStateError(`Ansteel team process issue ${issue.id} has no unreviewed resolution`);
	}
	if (resolution.review !== undefined) {
		throw new AnsteelTeamStateError(`Ansteel team process resolution ${resolution.id} has already been reviewed`);
	}
	if (typeof input.reason !== "string" || input.reason.trim().length === 0) {
		throw new AnsteelTeamStateError("Ansteel team process resolution review requires a reason");
	}
	const review: NonNullable<AnsteelProcessResolution["review"]> = {
		reviewer,
		verdict: input.verdict,
		reason: input.reason.trim(),
		reviewedAt: new Date().toISOString(),
	};
	appendAnsteelTeamEvent(
		cwd,
		state,
		{
			schemaVersion: 2,
			type: "process-resolution-review",
			role: reviewer,
			checkpointId: issue.targetCheckpointId,
			issueId: issue.id,
			resolutionId: resolution.id,
			content: `Reviewed process resolution ${resolution.id}: ${review.verdict}`,
			payload: {
				kind: "process-resolution-review",
				issueId: issue.id,
				resolutionId: resolution.id,
				review,
			},
		},
		persistence,
	);
	return state.processIssues.find((item) => item.id === issue.id)!;
}
