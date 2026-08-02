import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fstatSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { getCwdRelativePath, resolvePath } from "../utils/paths.ts";
import { ANSTEEL_ROLES, type AnsteelRole, DEFAULT_ANSTEEL_TEAM_TASK_OWNERS } from "./ansteel-discussion.ts";
import {
	type AnsteelTeamEventSignature,
	assertAnsteelTeamAuditManifestTeam,
	canonicalizeAnsteelAuditValue,
	createAnsteelTeamMerkleRoot,
	hashAnsteelAuditValue,
	signAnsteelTeamAuditEvent,
	verifyAnsteelTeamAuditEventSignatures,
} from "./ansteel-team-integrity.ts";
import {
	ANSTEEL_RUNTIME_REASON_CODES,
	type AnsteelIncidentProjectContextVerified,
	type AnsteelRuntimeLogEntry,
	type AnsteelRuntimeLogger,
	type AnsteelRuntimeLogInput,
	type AnsteelRuntimeReasonCode,
	type AnsteelRuntimeSpan,
	captureAnsteelRuntimeAnchorSnapshot,
	redactAnsteelSensitiveValue,
	verifyAnsteelRuntimeAnchorSnapshot,
	verifyAnsteelRuntimeLogIntegrity,
} from "./ansteel-team-observability.ts";
import { runAnsteelGovernedProcess } from "./ansteel-team-process.ts";

const ANSTEEL_TEAM_STATE_VERSION = 12;
// Local diffs and explicit anchor traffic share one bounded Git execution
// budget. In particular, an unavailable remote or credential helper must not
// leave the coordinator command waiting indefinitely.
const ANSTEEL_GIT_COMMAND_TIMEOUT_MS = 30_000;
// Old ledgers used a deterministic field projection with JSON.stringify. New
// records carry this explicit marker and are hashed through the mature JCS
// implementation in ansteel-team-integrity.ts. The marker makes the cutover
// replayable without silently changing historical event hashes.
const ANSTEEL_TEAM_EVENT_HASH_ALGORITHM = "sha256-jcs-v1" as const;
const mirroredTransitionLogIdsByLogger = new WeakMap<AnsteelRuntimeLogger, Set<string>>();
const MAX_PUBLIC_EVENT_CONTENT_LENGTH = 16_384;
const ANSTEEL_TEAM_TEST_TIMEOUT_MS = 60_000;
const ANSTEEL_TEAM_TEST_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;
const ANSTEEL_TEAM_DELIVERY_MANIFEST_MAX_BYTES = 64 * 1024;
const ANSTEEL_TEAM_DELIVERY_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
const ANSTEEL_TEAM_DELIVERY_ALLOWED_EXECUTABLES = new Set([
	"node",
	"node.exe",
	"npm",
	"npm.cmd",
	"npx",
	"npx.cmd",
	"pnpm",
	"pnpm.cmd",
	"yarn",
	"yarn.cmd",
	"bun",
	"bun.exe",
	"python",
	"python.exe",
	"pytest",
	"pytest.exe",
	"go",
	"go.exe",
	"cargo",
	"cargo.exe",
	"dotnet",
	"dotnet.exe",
	"mvn",
	"mvn.cmd",
	"gradlew",
	"gradlew.bat",
	"make",
	"make.exe",
]);
const ANSTEEL_TEAM_TEST_COMMAND_PREFIX =
	/^(?:npm (?:test|run (?:test|check|lint|typecheck)\b|exec -- (?:vitest|jest|tsc)\b)|npx (?:vitest|jest|tsc)\b|pnpm (?:test|run (?:test|check|lint|typecheck)\b)|yarn (?:test|run (?:test|check|lint|typecheck)\b)|bun test\b|vitest\b|jest\b|node --test\b|pytest\b|go test\b|cargo test\b|dotnet test\b|mvn test\b|(?:\.\/)?gradlew test\b|make test\b)/;

export type AnsteelTeamStatus = "active" | "stopped";

export type AnsteelCollaborationStatus =
	| "orienting"
	| "active"
	| "disputed"
	| "resolving"
	| "ready-for-verification"
	| "collaboration-complete"
	| "blocked";
export type AnsteelGovernanceStatus = "not-required" | "pending" | "approved" | "rejected";
export type AnsteelDeliveryStatus = "not-started" | "verifying" | "passed" | "failed";
export type AnsteelWorkflowStatus = "in-progress" | "blocked" | "completed";

export const ANSTEEL_STATE_TRANSITION_EVENT_NAMES = [
	"state.transition.attempted",
	"state.transition.applied",
	"state.transition.rejected",
] as const;

export type AnsteelStateTransitionEventName = (typeof ANSTEEL_STATE_TRANSITION_EVENT_NAMES)[number];
export type AnsteelStateObjectKind =
	| "team"
	| "role"
	| "challenge"
	| "task"
	| "milestone"
	| "checkpoint"
	| "process-issue"
	| "delivery-verification";

/**
 * 一条可持久化的状态机事实。attempt 与 result 记录共享同一个 transitionId；
 * 只有 applied 结果允许推进目标对象投影，rejected 只能留下失败证据而不能改状态。
 */
export interface AnsteelStateTransitionLog {
	logId: string;
	transitionId: string;
	eventName: AnsteelStateTransitionEventName;
	objectKind: AnsteelStateObjectKind;
	objectId: string;
	from: string | null;
	to: string;
	guard: string;
	guardResult: boolean;
	triggerEventId: string;
	reasonCode?: AnsteelRuntimeReasonCode;
	causeEventId?: string;
	createdAt: string;
}

/**
 * Read-only, mechanically derived status axes. They deliberately remain
 * separate from task approval: only a replayed current-revision delivery
 * receipt can derive delivery success from coordinator-owned evidence.
 */
export interface AnsteelTeamStatusAxes {
	collaborationStatus: AnsteelCollaborationStatus;
	governanceStatus: AnsteelGovernanceStatus;
	deliveryStatus: AnsteelDeliveryStatus;
	workflowStatus: AnsteelWorkflowStatus;
	reasons: {
		collaboration: string[];
		governance: string[];
		delivery: string[];
		workflow: string[];
	};
}

/**
 * Coordinator-assigned task categories make the intended division of labor
 * durable instead of relying on a role prompt or a human-readable description.
 */
export const ANSTEEL_TEAM_TASK_TYPES = ["architecture", "integration", "implementation", "verification"] as const;

export type AnsteelTeamTaskType = (typeof ANSTEEL_TEAM_TASK_TYPES)[number];

/** Default owner used when a caller omits a type and to detect cross-role exceptions. */
const DEFAULT_TASK_TYPE_BY_ROLE: Record<AnsteelRole, AnsteelTeamTaskType> = {
	"tech-lead": "architecture",
	"staff-engineer": "implementation",
	"qa-engineer": "verification",
};

/** Normal role for each explicit task type. Non-default assignments need a public reason. */
const DEFAULT_TASK_OWNER_BY_TYPE: Record<AnsteelTeamTaskType, AnsteelRole> = {
	architecture: "tech-lead",
	integration: "tech-lead",
	implementation: "staff-engineer",
	verification: "qa-engineer",
};

export type AnsteelTeamEventType =
	| "role-report"
	| "challenge"
	| "resolution"
	| "role-failure"
	| "task-assigned"
	| "tasks-assigned"
	| "task-claimed"
	| "task-submitted"
	| "task-collaboration"
	| "task-collaboration-returned"
	| "task-final-verification-requested"
	| "task-review"
	| "task-delivery-started"
	| "task-delivery-check"
	| "task-delivery-passed"
	| "task-delivery-failed"
	| "milestone-planned"
	| "milestone-submitted"
	| "milestone-collaboration"
	| "milestone-final-verification-requested"
	| "milestone-review"
	| "work-checkpoint"
	| "process-issue"
	| "process-resolution"
	| "process-resolution-review"
	| "action-assessed"
	| "action-review"
	| "runtime-recovery"
	/** A locally approved task has a verified Merkle root in a pushed Git receipt. */
	| "task-anchor"
	/** A locally approved milestone has a verified Merkle root in a pushed Git note. */
	| "milestone-anchor";

export type AnsteelTeamEventActor = AnsteelRole | "coordinator";

export interface AnsteelTeamRoleState {
	model: string;
	sessionFile: string;
	status: "idle" | "working" | "failed";
	transitionLogId: string;
}

export interface AnsteelTeamChallenge {
	id: string;
	raisedBy: AnsteelRole;
	targetRole: AnsteelRole;
	status: "open" | "resolved";
	transitionLogId: string;
}

export type AnsteelActionRisk = "green" | "yellow" | "red";
export type AnsteelCheckpointRisk = AnsteelActionRisk;
export type AnsteelCheckpointConfidence = "L1" | "L2" | "L3" | "L4";
export type AnsteelProcessIssueSeverity = "advisory" | "blocking" | "critical";
export type AnsteelProcessResolutionOutcome = "ACCEPTED" | "REFUTED" | "EXPERIMENT_REQUIRED" | "SCOPE_ESCALATION";
export type AnsteelActionKind =
	| "read"
	| "report"
	| "experiment"
	| "edit"
	| "write"
	| "test"
	| "commit"
	| "publish"
	| "decision";

export interface AnsteelGovernedAction {
	kind: AnsteelActionKind;
	target: string;
	version: string;
	computedRisk: AnsteelActionRisk;
	effectiveRisk: AnsteelActionRisk;
}

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
		kind: AnsteelActionKind;
		target: string;
		expectedResult: string;
	};
	risk: AnsteelCheckpointRisk;
	/** Coordinator-derived binding. Legacy checkpoints are superseded with `null` during v7 migration. */
	governedAction: AnsteelGovernedAction | null;
	confidence: AnsteelCheckpointConfidence;
	status: "active" | "superseded";
	transitionLogId: string;
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
	transitionLogId: string;
	resolutions: AnsteelProcessResolution[];
	createdAt: string;
}

export interface AnsteelActionReview {
	checkpointId: string;
	reviewer: AnsteelRole;
	action: Pick<AnsteelGovernedAction, "kind" | "target" | "version">;
	verdict: "approve" | "reject";
	reason: string;
	reviewedAt: string;
}

export type AnsteelActionReviewInput = Omit<AnsteelActionReview, "reviewer" | "reviewedAt">;

export interface AnsteelActionAssessment {
	action: AnsteelGovernedAction;
	checkpointId?: string;
	requiredReviewers: AnsteelRole[];
	approvedReviewers: AnsteelRole[];
	blockReason?: string;
}

export interface AnsteelActionFileIdentity {
	/** Filesystem device identity captured when the governed checkpoint was published. */
	dev: bigint;
	/** Non-zero file identity captured from the same open handle as the approved content hash. */
	ino: bigint;
	/** Lowercase SHA-256 captured from that same handle and approved by both peers. */
	sha256: string;
}

export type AnsteelWorkCheckpointInput = Omit<
	AnsteelWorkCheckpoint,
	"actor" | "governedAction" | "status" | "transitionLogId" | "createdAt" | "risk"
> & { risk?: AnsteelActionRisk };
export type AnsteelProcessIssueInput = Omit<
	AnsteelProcessIssue,
	"author" | "targetRole" | "status" | "transitionLogId" | "resolutions" | "createdAt"
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
	  }
	| { kind: "action-assessed"; assessment: AnsteelActionAssessment }
	| { kind: "action-review"; review: AnsteelActionReview }
	| { kind: "task-delivery-started"; verification: AnsteelTeamDeliveryVerification }
	| { kind: "task-delivery-check"; verificationId: string; check: AnsteelTeamDeliveryCheckEvidence }
	| {
			kind: "task-delivery-finished";
			verificationId: string;
			status: "passed" | "failed";
			completedAt: string;
			failureReason?: AnsteelTeamDeliveryFailureReason;
	  }
	| {
			kind: "runtime-recovery";
			runId: string;
			abandonedSpanCount: number;
			previousHeadHash: string | null;
			recoveredHeadHash: string;
			recoveredAt: string;
	  };

export interface AnsteelTeamTask {
	id: string;
	owner: AnsteelRole;
	type: AnsteelTeamTaskType;
	/** Required when the owner differs from the task type's default role. */
	assignmentReason?: string;
	files: string[];
	description: string;
	acceptanceCriteria: string;
	/** Immutable task IDs that must be approved before this task can be changed. */
	dependsOn: string[];
	/** `blocked` is coordinator-derived from `dependsOn`; roles cannot choose it. */
	status: "blocked" | "claimed" | "submitted" | "final-verification" | "revision-required" | "approved";
	transitionLogId: string;
	revision: number;
	testEvidence: AnsteelTeamTaskTestEvidence[];
	submissions: AnsteelTeamTaskSubmission[];
	collaborationUpdates: AnsteelTeamCollaborationUpdate[];
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

export type AnsteelTeamDeliveryFailureReason =
	| "check-failed"
	| "check-timeout"
	| "check-launch-failed"
	| "diff-drift"
	| "source-commit-drift"
	| "interrupted";

export interface AnsteelTeamDeliveryCheckEvidence {
	id: string;
	commandHash: string;
	outputHash: string;
	artifactHash: string;
	exitCode: number | null;
	timedOut: boolean;
	isError: boolean;
	startedAt: string;
	completedAt: string;
}

export interface AnsteelTeamDeliveryVerification {
	id: string;
	taskId: string;
	revision: number;
	diffHash: string;
	workspaceHash: string;
	sourceCommit: string;
	manifestHash: string;
	status: "verifying" | "passed" | "failed";
	transitionLogId: string;
	checks: AnsteelTeamDeliveryCheckEvidence[];
	startedAt: string;
	completedAt?: string;
	failureReason?: AnsteelTeamDeliveryFailureReason;
}

export interface AnsteelTeamDeliveryManifestCheck {
	id: string;
	executable: string;
	args: string[];
	timeoutMs: number;
}

export interface AnsteelTeamDeliveryManifest {
	version: 1;
	taskId: string;
	revision: number;
	checks: AnsteelTeamDeliveryManifestCheck[];
}

/**
 * Public, revision-bound collaboration material. It is deliberately not an
 * approval: both non-owners must publish one update before the coordinator can
 * begin the separate final-verification stage.
 */
export interface AnsteelTeamCollaborationUpdate {
	revision: number;
	collaborator: AnsteelRole;
	summary: string;
	evidenceRefs: string[];
	uncertainties: string[];
	publishedAt: string;
}

export type PublishAnsteelTeamCollaborationInput = Omit<
	AnsteelTeamCollaborationUpdate,
	"revision" | "collaborator" | "publishedAt"
>;

export interface AnsteelTeamMilestone {
	id: string;
	taskIds: string[];
	description: string;
	acceptanceCriteria: string;
	status: "blocked" | "ready" | "submitted" | "final-verification" | "revision-required" | "approved";
	transitionLogId: string;
	revision: number;
	testEvidence: AnsteelTeamTaskTestEvidence[];
	submissions: AnsteelTeamMilestoneSubmission[];
	collaborationUpdates: AnsteelTeamCollaborationUpdate[];
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

export type AnsteelTeamAnchorTargetKind = "task" | "milestone";

/** The reviewed work item represented by one immutable external receipt. */
export interface AnsteelTeamAnchorTarget {
	kind: AnsteelTeamAnchorTargetKind;
	id: string;
	revision: number;
}

/**
 * Content-addressed receipt stored in the remote Git note. It intentionally
 * omits local observation time and ref-object IDs, so a failed push can retry
 * the identical snapshot without replacing any historical receipt.
 */
export interface AnsteelTeamAnchorNote {
	schemaVersion: 3;
	anchorHash: string;
	teamId: string;
	target: AnsteelTeamAnchorTarget;
	eventRange: {
		firstSequence: number;
		lastSequence: number;
		eventCount: number;
	};
	merkle: {
		algorithm: "sha256-jcs-v1";
		leafCount: number;
		root: string;
	};
	signingManifestHash: string;
	runtimeLogIndexHash: string;
	/** Hash of the immutable runtime-index snapshot that proves the index state. */
	runtimeLogSnapshotHash: string;
	git: {
		commit: string;
		branch: string;
		remote: string;
		/** Credential-free identity of the remote endpoint, not the mutable alias. */
		remoteEndpoint: string;
		notesRef: string;
	};
}

/**
 * Structured receipt persisted in a signed ledger event after the remote ref
 * is checked. Keeping ref-object IDs here makes later remote re-verification
 * mechanical instead of relying on the human-readable event content.
 */
export interface AnsteelTeamExternalAnchor extends AnsteelTeamAnchorNote {
	anchoredAt: string;
	git: AnsteelTeamAnchorNote["git"] & {
		noteObject: string;
		remoteRefObject: string;
	};
}

/** Compatibility alias for callers that anchor a milestone specifically. */
export type AnsteelTeamMilestoneGitAnchor = AnsteelTeamExternalAnchor;
/** A task is anchored with the same receipt and verification contract. */
export type AnsteelTeamTaskGitAnchor = AnsteelTeamExternalAnchor;

export interface AnchorAnsteelTeamOptions {
	/** Defaults to origin. The command never discovers or substitutes another remote. */
	remote?: string;
}

export type AnchorAnsteelTeamMilestoneOptions = AnchorAnsteelTeamOptions;
export type AnchorAnsteelTeamTaskOptions = AnchorAnsteelTeamOptions;

export interface ClaimAnsteelTeamTaskInput {
	id: string;
	owner: AnsteelRole;
	/**
	 * Older in-process callers may omit the type; the owner-specific default is
	 * materialized before persistence. User and agent command schemas require it.
	 */
	type?: AnsteelTeamTaskType;
	assignmentReason?: string;
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
	transitionLogId: string;
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
	actionReviews: AnsteelActionReview[];
	deliveryVerifications: AnsteelTeamDeliveryVerification[];
	transitionLogs: AnsteelStateTransitionLog[];
	ledgerHeadHash: string | null;
}

export interface AnsteelTeamSharedBoard {
	teamId: string;
	currentGoal: string;
	teamStatus: AnsteelTeamStatus;
	axes: AnsteelTeamStatusAxes;
	roles: Record<
		AnsteelRole,
		{
			status: AnsteelTeamRoleState["status"];
			activeCheckpointId?: string;
			openIssueIds: string[];
		}
	>;
	tasks: Array<{
		id: string;
		owner: AnsteelRole;
		type: AnsteelTeamTaskType;
		assignmentReason?: string;
		status: AnsteelTeamTask["status"];
		deliveryStatus: AnsteelDeliveryStatus;
		dependsOn: string[];
	}>;
	activeCheckpoints: AnsteelWorkCheckpoint[];
	openProcessIssues: AnsteelProcessIssue[];
	recentToolFacts: Array<{ sequence: number; eventName: string; outcome: string; reasonCode?: string }>;
	counts: {
		activeCheckpoints: number;
		openProcessIssues: number;
		blockingProcessIssues: number;
		escalatedProcessIssues: number;
	};
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
	reasonCode?: "process-orphaned";
	payload?: AnsteelTeamPublicEventPayload;
	/** Coordinator-only structured evidence for a task or milestone anchor event. */
	anchor?: AnsteelTeamExternalAnchor;
	content: string;
}

export interface AnsteelTeamEvent extends AnsteelTeamEventInput {
	/** Absent only on the immutable JSON.stringify ledger prefix that predates JCS. */
	hashAlgorithm?: typeof ANSTEEL_TEAM_EVENT_HASH_ALGORITHM;
	sequence: number;
	createdAt: string;
	previousHash: string | null;
	hash: string;
	/** Absent only for the immutable hash-only prefix that predates the signing cutover. */
	signature?: AnsteelTeamEventSignature;
}

export interface AnsteelTeamPersistenceContext {
	logger: AnsteelRuntimeLogger;
	parentSpan?: AnsteelRuntimeSpan;
	toolCallId?: string;
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

function assertDeliveryVerificationId(id: unknown): asserts id is string {
	if (typeof id !== "string" || !/^DV-[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(id)) {
		throw new AnsteelTeamStateError("Ansteel team delivery verification IDs must use the DV-<UUID> form");
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

interface AnsteelMutableStateTarget {
	status: string;
	transitionLogId: string;
}

interface AnsteelStateTransitionOptions {
	guard: string;
	triggerEventId?: string;
	causeEventId?: string;
	reasonCode?: AnsteelRuntimeReasonCode;
	createdAt?: string;
	deterministicSeed?: string;
	from?: string | null;
	record?: boolean;
}

function getAnsteelStateObjectKey(kind: AnsteelStateObjectKind, objectId: string): string {
	return `${kind}\0${objectId}`;
}

function createAnsteelTransitionIdentity(seed?: string): string {
	return seed === undefined ? `ST-${randomUUID()}` : `ST-${createHash("sha256").update(seed, "utf8").digest("hex")}`;
}

function createAnsteelStateTransitionPair(
	kind: AnsteelStateObjectKind,
	objectId: string,
	from: string | null,
	to: string,
	guardResult: boolean,
	options: AnsteelStateTransitionOptions,
): [AnsteelStateTransitionLog, AnsteelStateTransitionLog] {
	const transitionId = createAnsteelTransitionIdentity(options.deterministicSeed);
	const triggerEventId = options.triggerEventId ?? `EV-${transitionId}`;
	const createdAt = options.createdAt ?? new Date().toISOString();
	const common = {
		transitionId,
		objectKind: kind,
		objectId,
		from,
		to,
		guard: options.guard,
		guardResult,
		triggerEventId,
		createdAt,
	};
	const attempted: AnsteelStateTransitionLog = {
		...common,
		logId: `${transitionId}-ATTEMPTED`,
		eventName: "state.transition.attempted",
		...(options.causeEventId === undefined ? {} : { causeEventId: options.causeEventId }),
	};
	const result: AnsteelStateTransitionLog = guardResult
		? {
				...common,
				logId: `${transitionId}-APPLIED`,
				eventName: "state.transition.applied",
				...(options.causeEventId === undefined ? {} : { causeEventId: options.causeEventId }),
			}
		: {
				...common,
				logId: `${transitionId}-REJECTED`,
				eventName: "state.transition.rejected",
				reasonCode: options.reasonCode ?? "unclassified-runtime-error",
				causeEventId: options.causeEventId ?? triggerEventId,
			};
	return [attempted, result];
}

/**
 * 应用一次状态机转换，并把目标对象绑定到对应的持久 applied 记录。事件重放时可以禁止
 * 再次插入记录，但重建对象必须保留同一个确定性 transitionLogId，确保实时写入与重放投影一致。
 */
function applyAnsteelStateTransition(
	state: AnsteelTeamState,
	target: AnsteelMutableStateTarget,
	kind: AnsteelStateObjectKind,
	objectId: string,
	to: string,
	options: AnsteelStateTransitionOptions,
): AnsteelStateTransitionLog {
	const from = options.from === undefined ? target.status : options.from;
	const [attempted, applied] = createAnsteelStateTransitionPair(kind, objectId, from, to, true, options);
	if (options.record !== false) state.transitionLogs.push(attempted, applied);
	target.status = to;
	target.transitionLogId = applied.logId;
	return applied;
}

/** 记录被拒绝的状态转换，但绝不推进目标对象投影。 */
function rejectAnsteelStateTransition(
	state: AnsteelTeamState,
	target: AnsteelMutableStateTarget,
	kind: AnsteelStateObjectKind,
	objectId: string,
	to: string,
	options: AnsteelStateTransitionOptions & { reasonCode: AnsteelRuntimeReasonCode },
): AnsteelStateTransitionLog {
	const from = options.from === undefined ? target.status : options.from;
	const [attempted, rejected] = createAnsteelStateTransitionPair(kind, objectId, from, to, false, options);
	state.transitionLogs.push(attempted, rejected);
	return rejected;
}

function rejectPersistedAnsteelStateTransition(
	projectDirectory: string,
	state: AnsteelTeamState,
	target: AnsteelMutableStateTarget,
	kind: AnsteelStateObjectKind,
	objectId: string,
	to: string,
	guard: string,
	reasonCode: AnsteelRuntimeReasonCode,
	message: string,
): never {
	rejectAnsteelStateTransition(state, target, kind, objectId, to, {
		guard,
		reasonCode,
		causeEventId: message,
	});
	saveAnsteelTeamState(projectDirectory, state);
	throw new AnsteelTeamStateError(message);
}

function assertAnsteelStateTransitionLogs(state: AnsteelTeamState): void {
	if (!Array.isArray(state.transitionLogs)) {
		throw new AnsteelTeamStateError("state-projection-mismatch: transition log is missing");
	}
	const targets = new Map<string, { status: string; transitionLogId: string }>();
	const addTarget = (kind: AnsteelStateObjectKind, objectId: string, target: AnsteelMutableStateTarget): void => {
		const key = getAnsteelStateObjectKey(kind, objectId);
		if (targets.has(key)) {
			throw new AnsteelTeamStateError(`state-projection-mismatch: duplicate state object ${kind} ${objectId}`);
		}
		targets.set(key, { status: target.status, transitionLogId: target.transitionLogId });
	};
	addTarget("team", state.id, state);
	for (const role of ANSTEEL_ROLES) addTarget("role", role, state.roles[role]);
	for (const challenge of state.openChallenges) addTarget("challenge", challenge.id, challenge);
	for (const task of state.tasks) addTarget("task", task.id, task);
	for (const milestone of state.milestones) addTarget("milestone", milestone.id, milestone);
	for (const checkpoint of state.workCheckpoints) addTarget("checkpoint", checkpoint.id, checkpoint);
	for (const issue of state.processIssues) addTarget("process-issue", issue.id, issue);
	for (const verification of state.deliveryVerifications) {
		addTarget("delivery-verification", verification.id, verification);
	}

	const projected = new Map<string, string | null>();
	const lastApplied = new Map<string, string>();
	const logIds = new Set<string>();
	for (let index = 0; index < state.transitionLogs.length; index += 2) {
		const attempted = state.transitionLogs[index];
		const result = state.transitionLogs[index + 1];
		if (!isRecord(attempted) || !isRecord(result)) {
			throw new AnsteelTeamStateError("state-projection-mismatch: transition log contains an incomplete pair");
		}
		for (const entry of [attempted, result]) {
			if (
				typeof entry.logId !== "string" ||
				!/^ST-[0-9a-f-]+-(?:ATTEMPTED|APPLIED|REJECTED)$/.test(entry.logId) ||
				typeof entry.transitionId !== "string" ||
				!/^ST-[0-9a-f-]+$/.test(entry.transitionId) ||
				!ANSTEEL_STATE_TRANSITION_EVENT_NAMES.includes(entry.eventName as AnsteelStateTransitionEventName) ||
				typeof entry.objectId !== "string" ||
				entry.objectId.length === 0 ||
				typeof entry.to !== "string" ||
				entry.to.length === 0 ||
				typeof entry.guard !== "string" ||
				entry.guard.length === 0 ||
				typeof entry.guardResult !== "boolean" ||
				typeof entry.triggerEventId !== "string" ||
				entry.triggerEventId.length === 0
			) {
				throw new AnsteelTeamStateError("state-projection-mismatch: transition log entry is invalid");
			}
			assertStateTimestamp(entry.createdAt, "transition time");
			if (entry.from !== null && typeof entry.from !== "string") {
				throw new AnsteelTeamStateError("state-projection-mismatch: transition source is invalid");
			}
			if (logIds.has(entry.logId)) {
				throw new AnsteelTeamStateError(`state-projection-mismatch: duplicate transition log ${entry.logId}`);
			}
			logIds.add(entry.logId);
		}
		if (
			attempted.eventName !== "state.transition.attempted" ||
			(result.eventName !== "state.transition.applied" && result.eventName !== "state.transition.rejected") ||
			attempted.transitionId !== result.transitionId ||
			attempted.objectKind !== result.objectKind ||
			attempted.objectId !== result.objectId ||
			attempted.from !== result.from ||
			attempted.to !== result.to ||
			attempted.guard !== result.guard ||
			attempted.guardResult !== result.guardResult ||
			attempted.triggerEventId !== result.triggerEventId
		) {
			throw new AnsteelTeamStateError("state-projection-mismatch: transition attempt and result do not match");
		}
		const key = getAnsteelStateObjectKey(result.objectKind, result.objectId);
		if (!targets.has(key)) {
			throw new AnsteelTeamStateError(
				`state-projection-mismatch: transition references missing ${result.objectKind} ${result.objectId}`,
			);
		}
		const current = projected.get(key) ?? null;
		if (result.from !== current) {
			throw new AnsteelTeamStateError(
				`state-projection-mismatch: transition ${result.transitionId} starts at ${String(result.from)} instead of ${String(current)}`,
			);
		}
		if (result.eventName === "state.transition.applied") {
			if (!result.guardResult || result.reasonCode !== undefined) {
				throw new AnsteelTeamStateError(
					"state-projection-mismatch: applied transition has an invalid guard result",
				);
			}
			projected.set(key, result.to);
			lastApplied.set(key, result.logId);
		} else {
			if (
				result.guardResult ||
				result.reasonCode === undefined ||
				!ANSTEEL_RUNTIME_REASON_CODES.includes(result.reasonCode as AnsteelRuntimeReasonCode) ||
				typeof result.causeEventId !== "string" ||
				result.causeEventId.length === 0
			) {
				throw new AnsteelTeamStateError("state-projection-mismatch: rejected transition lacks a stable cause");
			}
		}
	}

	for (const [key, target] of targets) {
		if (projected.get(key) !== target.status || lastApplied.get(key) !== target.transitionLogId) {
			throw new AnsteelTeamStateError(
				`state-projection-mismatch: ${key.replace("\0", " ")} disagrees with transition replay`,
			);
		}
	}
}

function initializeAnsteelStateTransitionBaseline(
	state: AnsteelTeamState,
	guard: "team-created" | "legacy-v11-migration-baseline",
	triggerEventId: string,
): void {
	state.transitionLogs = [];
	const createdAt = state.updatedAt;
	const initialize = (kind: AnsteelStateObjectKind, objectId: string, target: AnsteelMutableStateTarget): void => {
		const status = target.status;
		target.transitionLogId = "";
		applyAnsteelStateTransition(state, target, kind, objectId, status, {
			guard,
			triggerEventId,
			createdAt,
			from: null,
			deterministicSeed: `${state.id}\0${guard}\0${kind}\0${objectId}\0${status}`,
		});
	};
	initialize("team", state.id, state);
	for (const role of ANSTEEL_ROLES) initialize("role", role, state.roles[role]);
	for (const challenge of state.openChallenges) initialize("challenge", challenge.id, challenge);
	for (const task of state.tasks) initialize("task", task.id, task);
	for (const milestone of state.milestones) initialize("milestone", milestone.id, milestone);
	for (const checkpoint of state.workCheckpoints) initialize("checkpoint", checkpoint.id, checkpoint);
	for (const issue of state.processIssues) initialize("process-issue", issue.id, issue);
	for (const verification of state.deliveryVerifications) {
		initialize("delivery-verification", verification.id, verification);
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

function normalizeTaskAssignment(
	owner: AnsteelRole,
	type: unknown,
	assignmentReason: unknown,
): { type: AnsteelTeamTaskType; assignmentReason?: string } {
	const normalizedType = type === undefined ? DEFAULT_TASK_TYPE_BY_ROLE[owner] : type;
	if (typeof normalizedType !== "string" || !ANSTEEL_TEAM_TASK_TYPES.includes(normalizedType as AnsteelTeamTaskType)) {
		throw new AnsteelTeamStateError("Ansteel team task requires a valid task type");
	}
	if (
		assignmentReason !== undefined &&
		(typeof assignmentReason !== "string" || assignmentReason.trim().length === 0)
	) {
		throw new AnsteelTeamStateError("Ansteel team task assignment reason must be a non-empty string");
	}
	const taskType = normalizedType as AnsteelTeamTaskType;
	const reason = typeof assignmentReason === "string" ? assignmentReason.trim() : undefined;
	if (DEFAULT_TASK_OWNER_BY_TYPE[taskType] !== owner && reason === undefined) {
		throw new AnsteelTeamStateError(
			`Ansteel team ${taskType} task assigned to ${owner} requires a public assignment reason`,
		);
	}
	return {
		type: taskType,
		...(reason === undefined ? {} : { assignmentReason: reason }),
	};
}

function assertAnsteelTeamCollaborationUpdates(
	value: unknown,
	target: string,
	owner: AnsteelRole,
	currentRevision: number,
	submissionRevisions: ReadonlySet<number>,
): asserts value is AnsteelTeamCollaborationUpdate[] {
	if (!Array.isArray(value)) {
		throw new AnsteelTeamStateError(`Ansteel team ${target} has invalid collaboration updates`);
	}
	const seenCollaborators = new Set<string>();
	for (const rawUpdate of value) {
		if (!isRecord(rawUpdate)) {
			throw new AnsteelTeamStateError(`Ansteel team ${target} has invalid collaboration updates`);
		}
		const update = rawUpdate as unknown as AnsteelTeamCollaborationUpdate;
		if (!Number.isSafeInteger(update.revision) || update.revision < 1) {
			throw new AnsteelTeamStateError(`Ansteel team ${target} has invalid collaboration updates`);
		}
		if (update.revision > currentRevision || !submissionRevisions.has(update.revision)) {
			throw new AnsteelTeamStateError(
				`Ansteel team ${target} collaboration update references an unknown revision ${update.revision}`,
			);
		}
		assertRole(update.collaborator, `${target} collaboration collaborator`);
		if (update.collaborator === owner) {
			throw new AnsteelTeamStateError(`Ansteel team ${target} owner cannot publish a peer collaboration update`);
		}
		const key = `${update.revision}\0${update.collaborator}`;
		if (seenCollaborators.has(key)) {
			throw new AnsteelTeamStateError(
				`Ansteel team ${target} already has a ${update.collaborator} collaboration update for revision ${update.revision}`,
			);
		}
		seenCollaborators.add(key);
		assertNonEmptyStateString(update.summary, `${target} collaboration summary`);
		assertStateStringArray(update.evidenceRefs, `${target} collaboration evidence references`);
		if (update.evidenceRefs.length === 0) {
			throw new AnsteelTeamStateError(`Ansteel team ${target} collaboration update requires evidence references`);
		}
		assertStateStringArray(update.uncertainties, `${target} collaboration uncertainties`);
		assertStateTimestamp(update.publishedAt, `${target} collaboration publication time`);
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
		normalizeTaskAssignment(task.owner, task.type, task.assignmentReason);
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
			task.status !== "final-verification" &&
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
		assertAnsteelTeamCollaborationUpdates(
			task.collaborationUpdates,
			`task ${task.id}`,
			task.owner,
			task.revision,
			new Set(task.submissions.map((submission) => submission.revision)),
		);
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
	assertAnsteelTeamDeliveryVerifications(state);
	assertAnsteelTeamTaskDependencyGraph(state);
	assertAnsteelTeamMilestones(state);
	assertAnsteelPublicCollaborationState(state);
}

function assertAnsteelTeamDeliveryVerifications(state: AnsteelTeamState): void {
	if (!Array.isArray(state.deliveryVerifications)) {
		throw new AnsteelTeamStateError("Ansteel team state has invalid delivery verifications");
	}
	const tasksById = new Map(state.tasks.map((task) => [task.id, task]));
	const verificationIds = new Set<string>();
	const activeScopes = new Set<string>();
	for (const verification of state.deliveryVerifications) {
		if (!isRecord(verification)) throw new AnsteelTeamStateError("Ansteel team has an invalid delivery verification");
		assertDeliveryVerificationId(verification.id);
		if (verificationIds.has(verification.id)) {
			throw new AnsteelTeamStateError(`Ansteel team delivery verification ${verification.id} is duplicated`);
		}
		verificationIds.add(verification.id);
		assertTaskId(verification.taskId);
		const task = tasksById.get(verification.taskId);
		if (!task) {
			throw new AnsteelTeamStateError(
				`Ansteel team delivery verification ${verification.id} targets an unknown task`,
			);
		}
		if (!Number.isSafeInteger(verification.revision) || verification.revision < 1) {
			throw new AnsteelTeamStateError(
				`Ansteel team delivery verification ${verification.id} has an invalid revision`,
			);
		}
		if (verification.revision > task.revision) {
			throw new AnsteelTeamStateError(
				`Ansteel team delivery verification ${verification.id} targets a future task revision`,
			);
		}
		if (!task.submissions.some((submission) => submission.revision === verification.revision)) {
			throw new AnsteelTeamStateError(
				`Ansteel team delivery verification ${verification.id} has no matching task submission`,
			);
		}
		assertLedgerHash(verification.diffHash, "delivery diff hash", false);
		assertLedgerHash(verification.workspaceHash, "delivery workspace hash", false);
		assertLedgerHash(verification.manifestHash, "delivery manifest hash", false);
		if (typeof verification.sourceCommit !== "string" || !/^[0-9a-f]{40,64}$/i.test(verification.sourceCommit)) {
			throw new AnsteelTeamStateError(
				`Ansteel team delivery verification ${verification.id} has an invalid source commit`,
			);
		}
		if (verification.status !== "verifying" && verification.status !== "passed" && verification.status !== "failed") {
			throw new AnsteelTeamStateError(`Ansteel team delivery verification ${verification.id} has an invalid status`);
		}
		assertStateTimestamp(verification.startedAt, `delivery verification ${verification.id} start time`);
		if (!Array.isArray(verification.checks)) {
			throw new AnsteelTeamStateError(`Ansteel team delivery verification ${verification.id} has invalid checks`);
		}
		const checkIds = new Set<string>();
		for (const check of verification.checks) {
			if (!isRecord(check) || typeof check.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(check.id)) {
				throw new AnsteelTeamStateError(
					`Ansteel team delivery verification ${verification.id} has an invalid check`,
				);
			}
			if (checkIds.has(check.id)) {
				throw new AnsteelTeamStateError(
					`Ansteel team delivery verification ${verification.id} repeats check ${check.id}`,
				);
			}
			checkIds.add(check.id);
			assertLedgerHash(check.commandHash, "delivery command hash", false);
			assertLedgerHash(check.outputHash, "delivery output hash", false);
			assertLedgerHash(check.artifactHash, "delivery artifact hash", false);
			if (check.exitCode !== null && (!Number.isSafeInteger(check.exitCode) || check.exitCode < 0)) {
				throw new AnsteelTeamStateError(
					`Ansteel team delivery verification ${verification.id} has an invalid exit code`,
				);
			}
			if (typeof check.timedOut !== "boolean" || typeof check.isError !== "boolean") {
				throw new AnsteelTeamStateError(
					`Ansteel team delivery verification ${verification.id} has invalid check flags`,
				);
			}
			assertStateTimestamp(check.startedAt, `delivery check ${check.id} start time`);
			assertStateTimestamp(check.completedAt, `delivery check ${check.id} completion time`);
		}
		if (verification.status === "verifying") {
			if (verification.completedAt !== undefined || verification.failureReason !== undefined) {
				throw new AnsteelTeamStateError(
					`Ansteel team active delivery verification ${verification.id} has terminal fields`,
				);
			}
			const scope = `${verification.taskId}@${verification.revision}`;
			if (activeScopes.has(scope)) {
				throw new AnsteelTeamStateError(`Ansteel team has multiple active delivery verifications for ${scope}`);
			}
			activeScopes.add(scope);
		} else {
			assertStateTimestamp(verification.completedAt, `delivery verification ${verification.id} completion time`);
			if (verification.status === "passed") {
				if (
					verification.failureReason !== undefined ||
					verification.checks.length === 0 ||
					verification.checks.some((check) => check.isError)
				) {
					throw new AnsteelTeamStateError(
						`Ansteel team passed delivery verification ${verification.id} has invalid evidence`,
					);
				}
			} else if (
				verification.failureReason !== "check-failed" &&
				verification.failureReason !== "check-timeout" &&
				verification.failureReason !== "check-launch-failed" &&
				verification.failureReason !== "diff-drift" &&
				verification.failureReason !== "source-commit-drift" &&
				verification.failureReason !== "interrupted"
			) {
				throw new AnsteelTeamStateError(
					`Ansteel team failed delivery verification ${verification.id} has no stable reason`,
				);
			}
		}
	}
}

function getCurrentPassedDeliveryVerification(
	state: AnsteelTeamState,
	task: AnsteelTeamTask,
): AnsteelTeamDeliveryVerification | undefined {
	return [...state.deliveryVerifications].reverse().find(
		(verification) =>
			verification.taskId === task.id &&
			verification.revision === task.revision &&
			verification.status === "passed" &&
			verification.diffHash ===
				createHash("sha256")
					.update(task.submissions.at(-1)?.diff ?? "", "utf8")
					.digest("hex"),
	);
}

function isAnsteelTeamTaskDelivered(state: AnsteelTeamState, task: AnsteelTeamTask): boolean {
	return task.status === "approved" && getCurrentPassedDeliveryVerification(state, task) !== undefined;
}

function getAnsteelTeamTaskDeliveryStatus(state: AnsteelTeamState, task: AnsteelTeamTask): AnsteelDeliveryStatus {
	const current = state.deliveryVerifications.filter(
		(verification) => verification.taskId === task.id && verification.revision === task.revision,
	);
	if (current.some((verification) => verification.status === "verifying")) return "verifying";
	if (current.some((verification) => verification.status === "failed")) return "failed";
	return isAnsteelTeamTaskDelivered(state, task) ? "passed" : "not-started";
}

function assertAnsteelTeamTaskDependencyGraph(state: AnsteelTeamState): void {
	const tasks = state.tasks;
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
		const dependenciesApproved = task.dependsOn.every((dependency) =>
			isAnsteelTeamTaskDelivered(state, tasksById.get(dependency)!),
		);
		if (!dependenciesApproved && task.status !== "blocked") {
			throw new AnsteelTeamStateError(
				`Ansteel team task ${task.id} is unblocked before its dependencies pass delivery verification`,
			);
		}
		if (dependenciesApproved && task.status === "blocked") {
			throw new AnsteelTeamStateError(`Ansteel team task ${task.id} is blocked despite delivered dependencies`);
		}
	}
}

function reconcileAnsteelTeamTaskDependencies(
	state: AnsteelTeamState,
	eventContext?: { event: AnsteelTeamEvent; recordTransitions: boolean },
): void {
	const transitionOptions = (guard: string, suffix: string): AnsteelStateTransitionOptions => ({
		guard,
		...(eventContext === undefined
			? { causeEventId: state.ledgerHeadHash ?? undefined }
			: {
					triggerEventId: eventContext.event.hash,
					causeEventId: eventContext.event.hash,
					createdAt: eventContext.event.createdAt,
					deterministicSeed: `${eventContext.event.hash}\0${suffix}`,
					record: eventContext.recordTransitions,
				}),
	});
	const tasksById = new Map(state.tasks.map((task) => [task.id, task]));
	for (const task of state.tasks) {
		const dependenciesApproved = task.dependsOn.every((dependency) =>
			isAnsteelTeamTaskDelivered(state, tasksById.get(dependency)!),
		);
		if (!dependenciesApproved && task.status !== "blocked") {
			applyAnsteelStateTransition(state, task, "task", task.id, "blocked", {
				...transitionOptions("dependencies-delivered", `task\0${task.id}\0blocked`),
			});
			task.testEvidence = [];
		} else if (dependenciesApproved && task.status === "blocked") {
			applyAnsteelStateTransition(state, task, "task", task.id, "claimed", {
				...transitionOptions("dependencies-delivered", `task\0${task.id}\0claimed`),
			});
		}
	}
	for (const milestone of state.milestones) {
		const tasksApproved = milestone.taskIds.every((taskId) =>
			isAnsteelTeamTaskDelivered(state, tasksById.get(taskId)!),
		);
		if (!tasksApproved && milestone.status !== "blocked") {
			applyAnsteelStateTransition(state, milestone, "milestone", milestone.id, "blocked", {
				...transitionOptions("milestone-tasks-delivered", `milestone\0${milestone.id}\0blocked`),
			});
			milestone.testEvidence = [];
		} else if (tasksApproved && milestone.status === "blocked") {
			applyAnsteelStateTransition(state, milestone, "milestone", milestone.id, "ready", {
				...transitionOptions("milestone-tasks-delivered", `milestone\0${milestone.id}\0ready`),
			});
		}
	}
}

function assertAnsteelTeamMilestones(state: AnsteelTeamState): void {
	const tasks = state.tasks;
	const milestones = state.milestones;
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
			!Array.isArray(milestone.collaborationUpdates) ||
			!Array.isArray(milestone.reviews)
		) {
			throw new AnsteelTeamStateError(`Ansteel team milestone ${milestone.id} has invalid evidence`);
		}
		if (
			milestone.status !== "blocked" &&
			milestone.status !== "ready" &&
			milestone.status !== "submitted" &&
			milestone.status !== "final-verification" &&
			milestone.status !== "revision-required" &&
			milestone.status !== "approved"
		) {
			throw new AnsteelTeamStateError(`Ansteel team milestone ${milestone.id} has an invalid status`);
		}
		assertAnsteelTeamCollaborationUpdates(
			milestone.collaborationUpdates,
			`milestone ${milestone.id}`,
			"tech-lead",
			revision,
			new Set<number>(
				(milestone.submissions as Array<{ revision: number }>).map((submission) => submission.revision),
			),
		);
		const tasksApproved = milestone.taskIds.every((taskId) =>
			isAnsteelTeamTaskDelivered(state, tasksById.get(taskId)!),
		);
		if (!tasksApproved && milestone.status !== "blocked") {
			throw new AnsteelTeamStateError(
				`Ansteel team milestone ${milestone.id} is unblocked before its tasks pass delivery verification`,
			);
		}
		if (tasksApproved && milestone.status === "blocked") {
			throw new AnsteelTeamStateError(`Ansteel team milestone ${milestone.id} is blocked despite delivered tasks`);
		}
	}
}

function assertAnsteelPublicCollaborationState(
	state: AnsteelTeamState,
	options: { validateTransitionProjection?: boolean } = {},
): void {
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
			checkpoint.nextAction.kind !== "report" &&
			checkpoint.nextAction.kind !== "experiment" &&
			checkpoint.nextAction.kind !== "edit" &&
			checkpoint.nextAction.kind !== "write" &&
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
		if (checkpoint.governedAction === null) {
			if (checkpoint.status !== "superseded") {
				throw new AnsteelTeamStateError(
					`Ansteel team checkpoint ${checkpoint.id} without an action binding must be superseded`,
				);
			}
		} else {
			if (!isRecord(checkpoint.governedAction)) {
				throw new AnsteelTeamStateError(`Ansteel team checkpoint ${checkpoint.id} has an invalid action binding`);
			}
			assertNonEmptyStateString(checkpoint.governedAction.version, `checkpoint ${checkpoint.id} action version`);
			if (
				checkpoint.governedAction.kind !== checkpoint.nextAction.kind ||
				checkpoint.governedAction.target !== checkpoint.nextAction.target ||
				checkpoint.governedAction.effectiveRisk !== checkpoint.risk
			) {
				throw new AnsteelTeamStateError(
					`Ansteel team checkpoint ${checkpoint.id} action binding does not match its next action`,
				);
			}
			if (
				checkpoint.governedAction.computedRisk !== "green" &&
				checkpoint.governedAction.computedRisk !== "yellow" &&
				checkpoint.governedAction.computedRisk !== "red"
			) {
				throw new AnsteelTeamStateError(
					`Ansteel team checkpoint ${checkpoint.id} has an invalid computed action risk`,
				);
			}
			if (
				ANSTEEL_ACTION_RISK_ORDER[checkpoint.risk] <
				ANSTEEL_ACTION_RISK_ORDER[checkpoint.governedAction.computedRisk]
			) {
				throw new AnsteelTeamStateError(
					`Ansteel team checkpoint ${checkpoint.id} cannot downgrade its computed action risk`,
				);
			}
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
	if (!Array.isArray(state.actionReviews)) {
		throw new AnsteelTeamStateError("Ansteel team state has invalid action reviews");
	}
	const actionReviewers = new Set<string>();
	for (const review of state.actionReviews) {
		if (!isRecord(review)) {
			throw new AnsteelTeamStateError("Ansteel team state has invalid action review entries");
		}
		assertCheckpointId(review.checkpointId);
		const checkpoint = state.workCheckpoints.find((item) => item.id === review.checkpointId);
		if (!checkpoint) {
			throw new AnsteelTeamStateError(
				`Ansteel team action review references unknown checkpoint ${review.checkpointId}`,
			);
		}
		if (checkpoint.governedAction === null) {
			throw new AnsteelTeamStateError(
				`Ansteel team action review cannot reference legacy checkpoint ${review.checkpointId}`,
			);
		}
		assertRole(review.reviewer, `action review ${review.checkpointId} reviewer`);
		if (review.reviewer === checkpoint.actor) {
			throw new AnsteelTeamStateError(
				`Ansteel team checkpoint ${review.checkpointId} actor cannot review its own action`,
			);
		}
		const reviewerKey = `${review.checkpointId}\0${review.reviewer}`;
		if (actionReviewers.has(reviewerKey)) {
			throw new AnsteelTeamStateError(
				`Ansteel team ${review.reviewer} already reviewed checkpoint ${review.checkpointId}`,
			);
		}
		actionReviewers.add(reviewerKey);
		if (
			!isRecord(review.action) ||
			review.action.kind !== checkpoint.governedAction.kind ||
			review.action.target !== checkpoint.governedAction.target ||
			review.action.version !== checkpoint.governedAction.version
		) {
			throw new AnsteelTeamStateError(
				`Ansteel team action review for ${review.checkpointId} does not match its governed action`,
			);
		}
		if (review.verdict !== "approve" && review.verdict !== "reject") {
			throw new AnsteelTeamStateError(
				`Ansteel team action review for ${review.checkpointId} has an invalid verdict`,
			);
		}
		assertNonEmptyStateString(review.reason, `action review ${review.checkpointId} reason`);
		assertStateTimestamp(review.reviewedAt, `action review ${review.checkpointId} time`);
	}
	if (options.validateTransitionProjection !== false) assertAnsteelStateTransitionLogs(state);
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
		transitionLogId: "",
		createdAt: timestamp,
		updatedAt: timestamp,
		nextEventSequence: 1,
		roles: Object.fromEntries(
			ANSTEEL_ROLES.map((role) => [
				role,
				{
					model: options.roleModels[role],
					sessionFile: getAnsteelTeamRoleSessionPath(cwd, role),
					status: "idle",
					transitionLogId: "",
				},
			]),
		) as Record<AnsteelRole, AnsteelTeamRoleState>,
		taskOwners,
		openChallenges: [],
		tasks: [],
		milestones: [],
		workCheckpoints: [],
		processIssues: [],
		actionReviews: [],
		deliveryVerifications: [],
		transitionLogs: [],
		ledgerHeadHash: null,
	};
	initializeAnsteelStateTransitionBaseline(state, "team-created", `EV-TEAM-CREATED-${state.id}`);
	assertState(state);
	return state;
}

/** 由协调器独占写入的团队生命周期转换，供扩展运行时调用。 */
export function transitionAnsteelTeamStatus(
	state: AnsteelTeamState,
	to: AnsteelTeamStatus,
	guard: string,
	causeEventId?: string,
): void {
	applyAnsteelStateTransition(state, state, "team", state.id, to, {
		guard,
		...(causeEventId === undefined ? {} : { causeEventId }),
	});
}

/** 由协调器独占写入的角色会话转换，包围每一次 provider 阶段。 */
export function transitionAnsteelTeamRoleStatus(
	state: AnsteelTeamState,
	role: AnsteelRole,
	to: AnsteelTeamRoleState["status"],
	guard: string,
	causeEventId?: string,
): void {
	assertRole(role, "role transition target");
	applyAnsteelStateTransition(state, state.roles[role], "role", role, to, {
		guard,
		...(causeEventId === undefined ? {} : { causeEventId }),
	});
}

interface CanonicalProjectTarget {
	absolutePath: string;
	relativePath: string;
}

function resolveCanonicalProjectTarget(cwd: string, target: string): CanonicalProjectTarget | undefined {
	const projectDirectory = assertProjectDirectory(cwd);
	const lexicalTarget = resolvePath(target, projectDirectory);
	const lexicalRelative = getCwdRelativePath(lexicalTarget, projectDirectory);
	if (lexicalRelative === undefined) return undefined;

	let existingAncestor = lexicalTarget;
	const missingSegments: string[] = [];
	while (!existsSync(existingAncestor)) {
		const parent = dirname(existingAncestor);
		if (parent === existingAncestor) return undefined;
		missingSegments.unshift(basename(existingAncestor));
		existingAncestor = parent;
	}

	let canonicalProjectDirectory: string;
	let canonicalAncestor: string;
	try {
		canonicalProjectDirectory = realpathSync(projectDirectory);
		canonicalAncestor = realpathSync(existingAncestor);
	} catch {
		return undefined;
	}
	const absolutePath = resolvePath(join(canonicalAncestor, ...missingSegments));
	const relativePath = getCwdRelativePath(absolutePath, canonicalProjectDirectory);
	if (relativePath === undefined) return undefined;
	return { absolutePath, relativePath: relativePath.replace(/\\/g, "/") };
}

function requireCanonicalTaskFileTarget(
	cwd: string,
	file: unknown,
	options: { allowAbsolute: boolean },
): CanonicalProjectTarget {
	if (typeof file !== "string" || file.trim().length === 0 || (!options.allowAbsolute && isAbsolute(file))) {
		throw new AnsteelTeamStateError("Ansteel team task files must use non-empty project-relative paths");
	}
	let projectDirectory = cwd;
	if (options.allowAbsolute) {
		try {
			projectDirectory = realpathSync(assertProjectDirectory(cwd));
		} catch {
			throw new AnsteelTeamStateError("Ansteel team task files must stay inside the project");
		}
	}
	const resolved = resolveCanonicalProjectTarget(projectDirectory, file);
	if (resolved === undefined || resolved.relativePath === ".") {
		throw new AnsteelTeamStateError("Ansteel team task files must stay inside the project");
	}
	const normalizedPath = resolved.relativePath;
	const comparablePath = process.platform === "win32" ? normalizedPath.toLowerCase() : normalizedPath;
	if (comparablePath === ".pi" || comparablePath.startsWith(".pi/")) {
		throw new AnsteelTeamStateError("Ansteel team task files cannot modify team governance state");
	}
	return resolved;
}

function normalizeTaskFilePath(cwd: string, file: unknown): string {
	return requireCanonicalTaskFileTarget(cwd, file, { allowAbsolute: false }).relativePath;
}

export function resolveAnsteelTeamWritePath(cwd: string, file: unknown): string {
	return requireCanonicalTaskFileTarget(cwd, file, { allowAbsolute: false }).absolutePath;
}

export function revalidateAnsteelTeamWritePath(cwd: string, approvedAbsolutePath: unknown): string {
	if (
		typeof approvedAbsolutePath !== "string" ||
		approvedAbsolutePath.trim().length === 0 ||
		!isAbsolute(approvedAbsolutePath)
	) {
		throw new AnsteelTeamStateError("Ansteel team approved write path must be absolute");
	}
	const approvedPath = resolvePath(approvedAbsolutePath);
	let current: string;
	try {
		current = requireCanonicalTaskFileTarget(cwd, approvedPath, { allowAbsolute: true }).absolutePath;
	} catch {
		throw new AnsteelTeamStateError("Ansteel team write target changed after approval");
	}
	const comparableApproved = process.platform === "win32" ? approvedPath.toLowerCase() : approvedPath;
	const comparableCurrent = process.platform === "win32" ? current.toLowerCase() : current;
	if (comparableCurrent !== comparableApproved) {
		throw new AnsteelTeamStateError("Ansteel team write target changed after approval");
	}
	return current;
}

const ANSTEEL_ACTION_RISK_ORDER: Record<AnsteelActionRisk, number> = {
	green: 0,
	yellow: 1,
	red: 2,
};

function maxAnsteelActionRisk(left: AnsteelActionRisk, right: AnsteelActionRisk): AnsteelActionRisk {
	return ANSTEEL_ACTION_RISK_ORDER[left] >= ANSTEEL_ACTION_RISK_ORDER[right] ? left : right;
}

function getActionPath(args: unknown): string | undefined {
	if (!isRecord(args) || typeof args.path !== "string" || args.path.trim().length === 0) return undefined;
	return args.path.trim();
}

function isSensitiveActionTarget(cwd: string, target: string): boolean {
	const resolved = resolveCanonicalProjectTarget(cwd, target);
	if (resolved === undefined) return true;
	const normalizedTarget = resolved.relativePath.toLowerCase();
	return (
		normalizedTarget === ".git" ||
		normalizedTarget.startsWith(".git/") ||
		normalizedTarget === ".pi" ||
		normalizedTarget.startsWith(".pi/") ||
		normalizedTarget === ".github/workflows" ||
		normalizedTarget.startsWith(".github/workflows/") ||
		/(^|\/)(?:migrations?|security|permissions?|auth)(?:\/|$)/.test(normalizedTarget)
	);
}

export function classifyAnsteelTeamActionRisk(
	cwd: string,
	action: { toolName: string; args: unknown },
): AnsteelActionRisk {
	const toolName = action.toolName.trim().toLowerCase();
	const target = getActionPath(action.args);
	if (toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls") {
		return "green";
	}
	if (
		toolName === "delete" ||
		toolName === "remove" ||
		toolName === "commit" ||
		toolName === "push" ||
		toolName === "publish" ||
		toolName === "release"
	) {
		return "red";
	}
	if (toolName === "edit") {
		return target !== undefined && isSensitiveActionTarget(cwd, target) ? "red" : "yellow";
	}
	if (toolName === "write") {
		if (target === undefined || isSensitiveActionTarget(cwd, target)) return "red";
		return existsSync(resolvePath(target, cwd)) ? "red" : "yellow";
	}
	if (toolName === "bash") {
		const command =
			isRecord(action.args) && typeof action.args.command === "string" ? action.args.command.trim() : "";
		if (
			/(?:^|[;&|]\s*|\s)(?:git\s+(?:commit|push|tag)|rm(?:\s|$)|del(?:\s|$)|remove-item(?:\s|$)|move-item(?:\s|$)|chmod(?:\s|$)|chown(?:\s|$)|npm\s+publish|(?:pnpm|yarn)\s+publish)(?:\s|$)/i.test(
				command,
			)
		) {
			return "red";
		}
		if (
			!/[\r\n;&|><`$()]/.test(command) &&
			/^(?:git (?:diff|status|log|show|rev-parse|ls-files)\b|rg\b|grep\b|find\b|ls\b|pwd$|cat\b|head\b|tail\b|sed -n\b)/.test(
				command,
			)
		) {
			return "green";
		}
		return "yellow";
	}
	return "red";
}

function classifyCheckpointActionRisk(
	cwd: string,
	action: AnsteelWorkCheckpointInput["nextAction"],
): AnsteelActionRisk {
	if (action.kind === "read" || action.kind === "report") return "green";
	if (action.kind === "commit" || action.kind === "publish") return "red";
	if (action.kind === "edit" || action.kind === "write") {
		return classifyAnsteelTeamActionRisk(cwd, {
			toolName: action.kind,
			args: { path: action.target },
		});
	}
	return isSensitiveActionTarget(cwd, action.target) ? "red" : "yellow";
}

function getCheckpointActionVersion(
	cwd: string,
	state: AnsteelTeamState,
	checkpointId: string,
	taskId: string | undefined,
	action: AnsteelWorkCheckpointInput["nextAction"],
): string {
	const task = taskId === undefined ? undefined : state.tasks.find((item) => item.id === taskId);
	const taskVersion = task === undefined ? "unscoped" : `${task.id}@${task.revision}`;
	if (action.kind === "edit" || action.kind === "write") {
		const normalizedTarget = normalizeTaskFilePath(cwd, action.target);
		const resolvedTarget = resolvePath(normalizedTarget, cwd);
		if (!existsSync(resolvedTarget)) {
			return `${taskVersion};${normalizedTarget}@missing`;
		}
		let fd: number | undefined;
		try {
			// Bind review approval to the exact opened file object, not only its
			// contents. A same-content file reached through a swapped junction must
			// not satisfy an approval for the original project file.
			fd = openSync(resolvedTarget, "r");
			const stats = fstatSync(fd, { bigint: true });
			if (!stats.isFile() || stats.ino === 0n) {
				throw new Error("the target does not expose a stable regular-file identity");
			}
			const hash = createHash("sha256").update(readFileSync(fd)).digest("hex");
			return `${taskVersion};${normalizedTarget}@file:${stats.dev}:${stats.ino};sha256:${hash}`;
		} catch (error) {
			throw new AnsteelTeamStateError(
				`Ansteel team action target ${normalizedTarget} cannot be versioned: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	}
	if (action.kind === "commit" || action.kind === "publish") {
		const head = spawnSync("git", ["rev-parse", "HEAD"], {
			cwd,
			encoding: "utf8",
			windowsHide: true,
		});
		if (head.status !== 0 || head.stdout.trim().length === 0) {
			throw new AnsteelTeamStateError("Ansteel team Git action requires a verifiable current HEAD");
		}
		return `${taskVersion};git-head:${head.stdout.trim()}`;
	}
	return `${taskVersion};checkpoint:${checkpointId}`;
}

/**
 * Recover the immutable file identity embedded in an approved action version.
 * Missing targets and legacy content-only versions intentionally return no
 * identity, so governed mutation fails closed and requires a new checkpoint.
 */
export function getAnsteelTeamActionFileIdentity(version: string): AnsteelActionFileIdentity | undefined {
	const match = /@file:([0-9]+):([0-9]+);sha256:([0-9a-f]{64})$/i.exec(version);
	if (!match) return undefined;
	const dev = BigInt(match[1]!);
	const ino = BigInt(match[2]!);
	if (ino === 0n) return undefined;
	return { dev, ino, sha256: match[3]!.toLowerCase() };
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
		return `Ansteel team task ${task.id} is waiting for delivered dependencies: ${task.dependsOn.join(", ")}`;
	}
	if (task.status !== "claimed" && task.status !== "revision-required") {
		return `Ansteel team task ${task.id} is ${task.status}; code is frozen until peer review returns it for revision`;
	}
	return undefined;
}

function getAnsteelToolActionKind(toolName: string, args: unknown): AnsteelActionKind {
	const normalizedToolName = toolName.trim().toLowerCase();
	if (
		normalizedToolName === "read" ||
		normalizedToolName === "grep" ||
		normalizedToolName === "find" ||
		normalizedToolName === "ls"
	) {
		return "read";
	}
	if (normalizedToolName === "edit") return "edit";
	if (normalizedToolName === "write") return "write";
	if (normalizedToolName === "commit") return "commit";
	if (normalizedToolName === "push" || normalizedToolName === "publish" || normalizedToolName === "release") {
		return "publish";
	}
	if (normalizedToolName === "bash") {
		const command = isRecord(args) && typeof args.command === "string" ? args.command : "";
		if (/(?:^|\s)git\s+commit(?:\s|$)/i.test(command)) return "commit";
		if (/(?:^|\s)(?:git\s+push|npm\s+publish|(?:pnpm|yarn)\s+publish)(?:\s|$)/i.test(command)) {
			return "publish";
		}
		return "experiment";
	}
	return "decision";
}

function getAnsteelToolActionTarget(cwd: string, toolName: string, args: unknown): string {
	const kind = getAnsteelToolActionKind(toolName, args);
	const target = getActionPath(args);
	if (kind === "edit" || kind === "write") {
		return normalizeTaskFilePath(cwd, target);
	}
	if (target !== undefined) {
		const projectDirectory = assertProjectDirectory(cwd);
		const relativeTarget = getCwdRelativePath(resolvePath(target, projectDirectory), projectDirectory);
		return relativeTarget === undefined ? target : relativeTarget.replace(/\\/g, "/");
	}
	if (kind === "commit") return "git:commit";
	if (kind === "publish") return "git:publish";
	return toolName.trim().toLowerCase();
}

function getRequiredAnsteelActionReviewers(actor: AnsteelRole): AnsteelRole[] {
	return ANSTEEL_ROLES.filter((role) => role !== actor);
}

export function assessAnsteelTeamAction(
	cwd: string,
	state: AnsteelTeamState,
	role: AnsteelRole,
	input: { toolName: string; args: unknown },
): AnsteelActionAssessment {
	const projectDirectory = assertProjectDirectory(cwd);
	assertState(state);
	assertRole(role, "action actor");
	const computedRisk = classifyAnsteelTeamActionRisk(projectDirectory, input);
	const kind = getAnsteelToolActionKind(input.toolName, input.args);
	let target: string;
	try {
		target = getAnsteelToolActionTarget(projectDirectory, input.toolName, input.args);
	} catch (error) {
		const unresolvedTarget = getActionPath(input.args) ?? input.toolName.trim().toLowerCase();
		return {
			action: {
				kind,
				target: unresolvedTarget,
				version: "immediate",
				computedRisk,
				effectiveRisk: computedRisk,
			},
			requiredReviewers: getRequiredAnsteelActionReviewers(role),
			approvedReviewers: [],
			blockReason: error instanceof Error ? error.message : String(error),
		};
	}
	const immediateAction: AnsteelGovernedAction = {
		kind,
		target,
		version: "immediate",
		computedRisk,
		effectiveRisk: computedRisk,
	};
	if (computedRisk === "green") {
		return {
			action: immediateAction,
			requiredReviewers: [],
			approvedReviewers: [],
		};
	}

	if (kind === "edit" || kind === "write") {
		const writeBlockReason = getAnsteelTeamWriteBlockReason(projectDirectory, state, role, target);
		if (writeBlockReason !== undefined) {
			return {
				action: immediateAction,
				requiredReviewers: getRequiredAnsteelActionReviewers(role),
				approvedReviewers: [],
				blockReason: writeBlockReason,
			};
		}
	}

	const requiredReviewers = getRequiredAnsteelActionReviewers(role);
	const checkpoint = [...state.workCheckpoints]
		.reverse()
		.find(
			(item) =>
				item.actor === role &&
				item.status === "active" &&
				item.governedAction !== null &&
				item.governedAction.kind === kind &&
				item.governedAction.target === target,
		);
	if (!checkpoint?.governedAction) {
		return {
			action: immediateAction,
			requiredReviewers,
			approvedReviewers: [],
			blockReason: `Ansteel team ${computedRisk} action ${kind} ${target} requires an active checkpoint with the exact action binding`,
		};
	}

	const currentVersion = getCheckpointActionVersion(
		projectDirectory,
		state,
		checkpoint.id,
		checkpoint.taskId,
		checkpoint.nextAction,
	);
	const action: AnsteelGovernedAction = {
		kind,
		target,
		version: currentVersion,
		computedRisk,
		effectiveRisk: maxAnsteelActionRisk(computedRisk, checkpoint.risk),
	};
	const checkpointId = checkpoint.id;
	if (checkpoint.governedAction.version !== currentVersion) {
		return {
			action,
			checkpointId,
			requiredReviewers,
			approvedReviewers: [],
			blockReason: `Ansteel team checkpoint ${checkpointId} target version drift requires a replacement checkpoint`,
		};
	}
	if (ANSTEEL_ACTION_RISK_ORDER[checkpoint.governedAction.effectiveRisk] < ANSTEEL_ACTION_RISK_ORDER[computedRisk]) {
		return {
			action,
			checkpointId,
			requiredReviewers,
			approvedReviewers: [],
			blockReason: `Ansteel team checkpoint ${checkpointId} risk is lower than the mechanical ${computedRisk} classification`,
		};
	}
	const blockingIssue = state.processIssues.find(
		(issue) =>
			issue.targetCheckpointId === checkpointId &&
			issue.status !== "closed" &&
			(issue.severity === "blocking" || issue.severity === "critical"),
	);
	if (blockingIssue) {
		return {
			action,
			checkpointId,
			requiredReviewers,
			approvedReviewers: [],
			blockReason: `Ansteel team ${blockingIssue.severity} process issue ${blockingIssue.id} blocks checkpoint ${checkpointId}`,
		};
	}
	const matchingReviews = state.actionReviews.filter(
		(review) =>
			review.checkpointId === checkpointId &&
			review.action.kind === checkpoint.governedAction!.kind &&
			review.action.target === checkpoint.governedAction!.target &&
			review.action.version === checkpoint.governedAction!.version,
	);
	const rejectedReview = matchingReviews.find((review) => review.verdict === "reject");
	const approvedReviewers = matchingReviews
		.filter((review) => review.verdict === "approve")
		.map((review) => review.reviewer);
	if (rejectedReview) {
		return {
			action,
			checkpointId,
			requiredReviewers,
			approvedReviewers,
			blockReason: `Ansteel team ${rejectedReview.reviewer} rejected checkpoint ${checkpointId}: ${rejectedReview.reason}`,
		};
	}
	const missingReviewers = requiredReviewers.filter((reviewer) => !approvedReviewers.includes(reviewer));
	if (missingReviewers.length > 0) {
		return {
			action,
			checkpointId,
			requiredReviewers,
			approvedReviewers,
			blockReason: `Ansteel team checkpoint ${checkpointId} requires peer action reviews from ${missingReviewers.join(", ")}`,
		};
	}
	return {
		action,
		checkpointId,
		requiredReviewers,
		approvedReviewers,
	};
}

export function recordAnsteelTeamActionAssessment(
	cwd: string,
	state: AnsteelTeamState,
	actor: AnsteelRole,
	assessment: AnsteelActionAssessment,
	persistence?: AnsteelTeamPersistenceContext,
): AnsteelTeamEvent {
	assertRole(actor, "action assessment actor");
	return appendAnsteelTeamEvent(
		cwd,
		state,
		{
			schemaVersion: 2,
			type: "action-assessed",
			role: actor,
			...(assessment.checkpointId === undefined ? {} : { checkpointId: assessment.checkpointId }),
			content: `Assessed ${assessment.action.effectiveRisk} action ${assessment.action.kind} ${assessment.action.target}: ${
				assessment.blockReason === undefined ? "allowed" : "blocked"
			}`,
			payload: { kind: "action-assessed", assessment: structuredClone(assessment) },
		},
		persistence,
	);
}

export function isAnsteelTeamGovernancePath(cwd: string, file: unknown): boolean {
	if (typeof file !== "string" || file.trim().length === 0) return false;
	const teamDirectory = getAnsteelTeamDirectory(cwd);
	const resolvedFile = resolvePath(file, cwd);
	return resolvedFile === teamDirectory || getCwdRelativePath(resolvedFile, teamDirectory) !== undefined;
}

function claimAnsteelTeamTaskInState(
	projectDirectory: string,
	state: AnsteelTeamState,
	input: ClaimAnsteelTeamTaskInput,
	allowedOwners: readonly AnsteelRole[],
): AnsteelTeamTask {
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
	const assignment = normalizeTaskAssignment(input.owner, input.type, input.assignmentReason);
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
		...assignment,
		files,
		description: input.description.trim(),
		acceptanceCriteria: input.acceptanceCriteria.trim(),
		dependsOn: [...dependsOn],
		status: dependsOn.every((dependency) => {
			const dependencyTask = state.tasks.find((task) => task.id === dependency)!;
			return isAnsteelTeamTaskDelivered(state, dependencyTask);
		})
			? "claimed"
			: "blocked",
		transitionLogId: "",
		revision: 0,
		testEvidence: [],
		submissions: [],
		collaborationUpdates: [],
		reviews: [],
	};
	state.tasks.push(task);
	applyAnsteelStateTransition(state, task, "task", task.id, task.status, {
		guard: "task-claim-valid",
		from: null,
	});
	return task;
}

export function claimAnsteelTeamTask(
	cwd: string,
	state: AnsteelTeamState,
	input: ClaimAnsteelTeamTaskInput,
	allowedOwners: readonly AnsteelRole[] = DEFAULT_ANSTEEL_TEAM_TASK_OWNERS,
): AnsteelTeamTask {
	const projectDirectory = assertProjectDirectory(cwd);
	const task = claimAnsteelTeamTaskInState(projectDirectory, state, input, allowedOwners);
	saveAnsteelTeamState(projectDirectory, state);
	return task;
}

/**
 * Atomically claims a parallel batch. Every task is validated against a cloned
 * state first, so a duplicate ID, role-policy violation, dependency error, or
 * overlapping file leaves the caller's state and durable state unchanged.
 */
export function claimAnsteelTeamTasks(
	cwd: string,
	state: AnsteelTeamState,
	inputs: readonly ClaimAnsteelTeamTaskInput[],
	allowedOwners: readonly AnsteelRole[] = DEFAULT_ANSTEEL_TEAM_TASK_OWNERS,
): AnsteelTeamTask[] {
	const projectDirectory = assertProjectDirectory(cwd);
	const { preview, claimedIds } = prepareAnsteelTeamTaskBatch(projectDirectory, state, inputs, allowedOwners);
	// Persist the validated preview before publishing it to the live object. A
	// disk failure therefore cannot expose an in-memory half-commit.
	saveAnsteelTeamState(projectDirectory, preview);
	Object.assign(state, preview);
	return state.tasks.filter((task) => claimedIds.has(task.id));
}

function prepareAnsteelTeamTaskBatch(
	projectDirectory: string,
	state: AnsteelTeamState,
	inputs: readonly ClaimAnsteelTeamTaskInput[],
	allowedOwners: readonly AnsteelRole[],
): { preview: AnsteelTeamState; claimedIds: Set<string> } {
	assertState(state);
	if (!Array.isArray(inputs) || inputs.length < 2 || inputs.length > ANSTEEL_ROLES.length) {
		throw new AnsteelTeamStateError(
			`Ansteel team parallel task batch requires between 2 and ${ANSTEEL_ROLES.length} tasks`,
		);
	}
	const owners = inputs.map((input) => input.owner);
	if (new Set(owners).size !== owners.length) {
		throw new AnsteelTeamStateError("Ansteel team parallel task batch requires distinct task owners");
	}

	const preview = structuredClone(state);
	const claimed = inputs.map((input) => claimAnsteelTeamTaskInState(projectDirectory, preview, input, allowedOwners));
	if (claimed.some((task) => task.status !== "claimed")) {
		throw new AnsteelTeamStateError("Ansteel team parallel task batch requires every dependency to be approved");
	}
	return { preview, claimedIds: new Set(claimed.map((task) => task.id)) };
}

/**
 * Commits a parallel batch and its one public assignment event through the
 * existing pending-transaction protocol. Event validation happens before the
 * live state or durable state exposes any claimed task.
 */
export function assignAnsteelTeamTasks(
	cwd: string,
	state: AnsteelTeamState,
	inputs: readonly ClaimAnsteelTeamTaskInput[],
	allowedOwners: readonly AnsteelRole[] = DEFAULT_ANSTEEL_TEAM_TASK_OWNERS,
	persistence?: AnsteelTeamPersistenceContext,
): { tasks: AnsteelTeamTask[]; event: AnsteelTeamEvent } {
	const projectDirectory = assertProjectDirectory(cwd);
	const { preview, claimedIds } = prepareAnsteelTeamTaskBatch(projectDirectory, state, inputs, allowedOwners);
	const tasks = preview.tasks.filter((task) => claimedIds.has(task.id));
	const content = [
		`Assigned parallel task batch (${tasks.length} tasks):`,
		...tasks.map(
			(task) =>
				`- ${task.id} (${task.type}) -> ${task.owner}; status=${task.status}; dependencies=${
					task.dependsOn.length === 0 ? "none" : task.dependsOn.join(", ")
				}; files=${task.files.join(", ")}; assignment reason=${
					task.assignmentReason ?? "default role assignment"
				}; acceptance=${task.acceptanceCriteria}`,
		),
	].join("\n");
	const event = appendAnsteelTeamEvent(
		projectDirectory,
		preview,
		{ type: "tasks-assigned", role: "coordinator", content },
		persistence,
	);
	Object.assign(state, preview);
	return {
		tasks: state.tasks.filter((task) => claimedIds.has(task.id)),
		event,
	};
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
	const tasksApproved = input.taskIds.every((taskId) =>
		isAnsteelTeamTaskDelivered(state, state.tasks.find((task) => task.id === taskId)!),
	);
	const milestone: AnsteelTeamMilestone = {
		id: input.id,
		taskIds: [...input.taskIds],
		description: input.description.trim(),
		acceptanceCriteria: input.acceptanceCriteria.trim(),
		status: tasksApproved ? "ready" : "blocked",
		transitionLogId: "",
		revision: 0,
		testEvidence: [],
		submissions: [],
		collaborationUpdates: [],
		reviews: [],
	};
	state.milestones.push(milestone);
	applyAnsteelStateTransition(state, milestone, "milestone", milestone.id, milestone.status, {
		guard: "milestone-plan-valid",
		from: null,
	});
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
		throw new AnsteelTeamStateError(`Ansteel team milestone ${milestoneId} is waiting for delivered tasks`);
	}
	if (milestone.status !== "ready" && milestone.status !== "revision-required") {
		throw new AnsteelTeamStateError(`Ansteel team milestone ${milestoneId} cannot accept new integration evidence`);
	}
	return milestone;
}

export async function runAnsteelTeamMilestoneTest(
	cwd: string,
	state: AnsteelTeamState,
	role: AnsteelRole,
	milestoneId: string,
	command: string,
	persistence?: AnsteelTeamPersistenceContext,
): Promise<AnsteelTeamTaskTestEvidence> {
	const projectDirectory = assertProjectDirectory(cwd);
	assertState(state);
	const milestone = getMilestoneForIntegration(state, role, milestoneId);
	if (typeof command !== "string") throw new AnsteelTeamStateError("Ansteel team milestone tests require a command");
	const normalizedCommand = assertAllowedTaskTestCommand(command);
	const result = await runAnsteelGovernedProcess({
		command: normalizedCommand,
		args: [],
		cwd: projectDirectory,
		env: getAnsteelTeamDeliveryEnvironment(),
		shell: true,
		timeoutMs: ANSTEEL_TEAM_TEST_TIMEOUT_MS,
		maximumOutputBytes: ANSTEEL_TEAM_TEST_OUTPUT_MAX_BYTES,
		policy: "milestone-test",
		role,
		checkpointId: milestoneId,
		...(persistence?.toolCallId === undefined ? {} : { toolCallId: persistence.toolCallId }),
		...(persistence === undefined ? {} : { persistence }),
	});
	const diagnostic = result.launchError
		? `\n${result.launchError.message}`
		: result.timedOut
			? `\nProcess timed out after ${ANSTEEL_TEAM_TEST_TIMEOUT_MS}ms`
			: result.stdoutTruncated || result.stderrTruncated
				? "\nProcess output exceeded the governed collection boundary"
				: "";
	const evidence: AnsteelTeamTaskTestEvidence = {
		command: normalizedCommand,
		output: `${diagnostic}${result.stdout}${result.stderr}`.slice(0, MAX_PUBLIC_EVENT_CONTENT_LENGTH),
		isError:
			result.exitCode !== 0 ||
			result.launchError !== undefined ||
			result.timedOut ||
			result.stdoutTruncated ||
			result.stderrTruncated,
		completedAt: result.completedAt,
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
	assertRole(role, "milestone role");
	if (role !== "tech-lead")
		throw new AnsteelTeamStateError("Only Ansteel team tech-lead can submit milestone integration evidence");
	assertMilestoneId(milestoneId);
	const milestone = state.milestones.find((item) => item.id === milestoneId);
	if (!milestone) throw new AnsteelTeamStateError(`Ansteel team milestone ${milestoneId} does not exist`);
	if (milestone.status !== "ready" && milestone.status !== "revision-required") {
		const message =
			milestone.status === "blocked"
				? `Ansteel team milestone ${milestoneId} is waiting for delivered tasks`
				: `Ansteel team milestone ${milestoneId} cannot accept new integration evidence`;
		return rejectPersistedAnsteelStateTransition(
			projectDirectory,
			state,
			milestone,
			"milestone",
			milestone.id,
			"submitted",
			"milestone-submission-evidence-valid",
			"no-governed-progress",
			message,
		);
	}
	const test = [...milestone.testEvidence]
		.reverse()
		.find((evidence) => evidence.command === testCommand.trim() && !evidence.isError);
	if (!test) {
		return rejectPersistedAnsteelStateTransition(
			projectDirectory,
			state,
			milestone,
			"milestone",
			milestone.id,
			"submitted",
			"milestone-submission-evidence-valid",
			"no-governed-progress",
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
	applyAnsteelStateTransition(state, milestone, "milestone", milestone.id, "submitted", {
		guard: "milestone-submission-evidence-valid",
	});
	saveAnsteelTeamState(projectDirectory, state);
	return submission;
}

export interface AnsteelTeamFinalVerificationReadiness {
	ready: boolean;
	blockers: string[];
}

const ANSTEEL_MILESTONE_COLLABORATORS = ["staff-engineer", "qa-engineer"] as const satisfies readonly AnsteelRole[];

function createAnsteelTeamCollaborationUpdate(
	revision: number,
	collaborator: AnsteelRole,
	input: PublishAnsteelTeamCollaborationInput,
): AnsteelTeamCollaborationUpdate {
	if (!Number.isSafeInteger(revision) || revision < 1) {
		throw new AnsteelTeamStateError("Ansteel team collaboration updates require a submitted revision");
	}
	assertRole(collaborator, "collaboration collaborator");
	assertPublicContent(input.summary);
	assertStateStringArray(input.evidenceRefs, "collaboration evidence references");
	if (input.evidenceRefs.length === 0) {
		throw new AnsteelTeamStateError("Ansteel team collaboration updates require evidence references");
	}
	assertStateStringArray(input.uncertainties, "collaboration uncertainties");
	return {
		revision,
		collaborator,
		summary: input.summary.trim(),
		evidenceRefs: input.evidenceRefs.map((reference) => reference.trim()),
		uncertainties: input.uncertainties.map((uncertainty) => uncertainty.trim()),
		publishedAt: new Date().toISOString(),
	};
}

function getOpenBlockingProcessIssuesForTasks(
	state: AnsteelTeamState,
	taskIds: ReadonlySet<string>,
): AnsteelProcessIssue[] {
	const checkpointIds = new Set(
		state.workCheckpoints
			.filter((checkpoint) => checkpoint.taskId !== undefined && taskIds.has(checkpoint.taskId))
			.map((checkpoint) => checkpoint.id),
	);
	return state.processIssues.filter(
		(issue) =>
			checkpointIds.has(issue.targetCheckpointId) &&
			issue.status !== "closed" &&
			(issue.severity === "blocking" || issue.severity === "critical"),
	);
}

export function publishAnsteelTeamMilestoneCollaboration(
	cwd: string,
	state: AnsteelTeamState,
	collaborator: AnsteelRole,
	milestoneId: string,
	input: PublishAnsteelTeamCollaborationInput,
): AnsteelTeamCollaborationUpdate {
	const projectDirectory = assertProjectDirectory(cwd);
	assertState(state);
	assertRole(collaborator, "milestone collaborator");
	if (!ANSTEEL_MILESTONE_COLLABORATORS.includes(collaborator as (typeof ANSTEEL_MILESTONE_COLLABORATORS)[number])) {
		throw new AnsteelTeamStateError("Only Staff Engineer or QA Engineer can publish milestone collaboration updates");
	}
	assertMilestoneId(milestoneId);
	const milestone = state.milestones.find((item) => item.id === milestoneId);
	if (!milestone) throw new AnsteelTeamStateError(`Ansteel team milestone ${milestoneId} does not exist`);
	if (milestone.status !== "submitted") {
		throw new AnsteelTeamStateError(
			`Ansteel team milestone ${milestoneId} is ${milestone.status}; it is not accepting continuous collaboration updates`,
		);
	}
	if (!milestone.submissions.some((submission) => submission.revision === milestone.revision)) {
		throw new AnsteelTeamStateError(
			`Ansteel team milestone ${milestoneId} has no immutable integration evidence package`,
		);
	}
	if (
		milestone.collaborationUpdates.some(
			(update) => update.revision === milestone.revision && update.collaborator === collaborator,
		)
	) {
		throw new AnsteelTeamStateError(
			`Ansteel team milestone ${milestoneId} already has a ${collaborator} collaboration update for revision ${milestone.revision}`,
		);
	}
	const update = createAnsteelTeamCollaborationUpdate(milestone.revision, collaborator, input);
	milestone.collaborationUpdates.push(update);
	saveAnsteelTeamState(projectDirectory, state);
	return update;
}

export function getAnsteelTeamMilestoneFinalVerificationReadiness(
	cwd: string,
	state: AnsteelTeamState,
	milestoneId: string,
): AnsteelTeamFinalVerificationReadiness {
	assertProjectDirectory(cwd);
	assertState(state);
	assertMilestoneId(milestoneId);
	const milestone = state.milestones.find((item) => item.id === milestoneId);
	if (!milestone) throw new AnsteelTeamStateError(`Ansteel team milestone ${milestoneId} does not exist`);
	const blockers: string[] = [];
	if (milestone.status !== "submitted") {
		blockers.push(`milestone status is ${milestone.status}, not submitted`);
	}
	const submission = milestone.submissions.at(-1);
	if (!submission || submission.revision !== milestone.revision) {
		blockers.push("latest immutable integration evidence is missing");
	} else if (submission.test.isError) {
		blockers.push("latest immutable integration test did not succeed");
	}
	for (const collaborator of ANSTEEL_MILESTONE_COLLABORATORS) {
		if (
			!milestone.collaborationUpdates.some(
				(update) => update.revision === milestone.revision && update.collaborator === collaborator,
			)
		) {
			blockers.push(`missing continuous collaboration update from ${collaborator}`);
		}
	}
	for (const issue of getOpenBlockingProcessIssuesForTasks(state, new Set(milestone.taskIds))) {
		blockers.push(`open ${issue.severity} process issue ${issue.id}`);
	}
	return { ready: blockers.length === 0, blockers };
}

export function beginAnsteelTeamMilestoneFinalVerification(
	cwd: string,
	state: AnsteelTeamState,
	milestoneId: string,
): AnsteelTeamMilestoneSubmission {
	const projectDirectory = assertProjectDirectory(cwd);
	const readiness = getAnsteelTeamMilestoneFinalVerificationReadiness(projectDirectory, state, milestoneId);
	if (!readiness.ready) {
		const milestone = state.milestones.find((item) => item.id === milestoneId)!;
		rejectAnsteelStateTransition(state, milestone, "milestone", milestone.id, "final-verification", {
			guard: "milestone-final-verification-ready",
			reasonCode: readiness.blockers.some((blocker) => blocker.startsWith("open "))
				? "blocking-process-issue-open"
				: "no-governed-progress",
		});
		saveAnsteelTeamState(projectDirectory, state);
		throw new AnsteelTeamStateError(
			`Ansteel team milestone ${milestoneId} cannot begin final verification: ${readiness.blockers.join("; ")}`,
		);
	}
	const milestone = state.milestones.find((item) => item.id === milestoneId)!;
	const submission = milestone.submissions.at(-1)!;
	applyAnsteelStateTransition(state, milestone, "milestone", milestone.id, "final-verification", {
		guard: "milestone-final-verification-ready",
	});
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
	if (milestone.status !== "final-verification") {
		throw new AnsteelTeamStateError(`Ansteel team milestone ${milestoneId} is not in final verification`);
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
		applyAnsteelStateTransition(state, milestone, "milestone", milestone.id, "revision-required", {
			guard: "milestone-final-review-approved",
			causeEventId: `REVIEW-${review.reviewer}-${review.reviewedAt}`,
		});
		milestone.testEvidence = [];
	} else if (
		["staff-engineer", "qa-engineer"].every((role) =>
			milestone.reviews.some(
				(item) => item.revision === submission.revision && item.reviewer === role && item.verdict === "approve",
			),
		)
	) {
		applyAnsteelStateTransition(state, milestone, "milestone", milestone.id, "approved", {
			guard: "milestone-final-review-approved",
		});
	}
	saveAnsteelTeamState(projectDirectory, state);
	return review;
}

function assertAnsteelAnchorRemote(value: string): string {
	const remote = value.trim();
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(remote)) {
		throw new AnsteelTeamStateError("Ansteel team anchor remote name is invalid");
	}
	return remote;
}

/**
 * Bind the receipt to the credential-free remote endpoint rather than only its
 * local alias. Git remotes may contain a userinfo token or query credentials,
 * so the persisted identity deliberately keeps only the protocol, host, port,
 * and repository path. Local-path remotes are normalized to file URLs for the
 * deterministic Git fixtures and air-gapped deployments.
 */
function canonicalizeAnsteelAnchorRemoteEndpoint(cwd: string, raw: string): string {
	if (raw.length === 0 || raw.length > 4_096 || /[\r\n\0]/.test(raw)) {
		throw new AnsteelTeamStateError("Ansteel team anchor remote endpoint is invalid");
	}
	if (!/^[A-Za-z]:[\\/]/.test(raw)) {
		const scpLike = /^(?:[^@/:]+@)?([A-Za-z0-9][A-Za-z0-9.-]*):(.+)$/.exec(raw);
		if (scpLike) {
			const path = scpLike[2]!.replace(/^[\\/]+/, "").replace(/[\\/]+$/, "");
			if (path.length === 0 || /[?#]/.test(path)) {
				throw new AnsteelTeamStateError("Ansteel team anchor remote endpoint is invalid");
			}
			return `ssh://${scpLike[1]!.toLowerCase()}/${path.replaceAll("\\", "/")}`;
		}
	}
	if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw) || raw.startsWith("file:")) {
		try {
			const parsed = new URL(raw);
			const protocol = parsed.protocol.toLowerCase();
			const host = parsed.hostname.toLowerCase();
			if ((protocol !== "file:" && host.length === 0) || (parsed.username.length > 0 && protocol === "file:")) {
				throw new Error("invalid endpoint");
			}
			const port = parsed.port.length > 0 ? `:${parsed.port}` : "";
			const pathname = (parsed.pathname.replace(/\/+$/, "") || "/").replaceAll("\\", "/");
			return `${protocol}//${host}${port}${pathname}`;
		} catch {
			throw new AnsteelTeamStateError("Ansteel team anchor remote endpoint is invalid");
		}
	}
	return pathToFileURL(resolve(cwd, raw)).href;
}

/**
 * Git may assign one alias distinct fetch URLs and multiple push URLs.
 * Anchoring would then write evidence to an endpoint that verification never
 * reads, so this protocol accepts only one effective credential-free endpoint
 * across every configured fetch and push URL.
 */
function getAnsteelAnchorRemoteEndpoint(cwd: string, remote: string): string {
	const getEndpoints = (push: boolean): string[] => {
		const output = runAnsteelTeamGitCommand(
			cwd,
			["remote", "get-url", "--all", ...(push ? ["--push"] : []), remote],
			"verify anchor remote",
		);
		const endpoints = new Set(
			output
				.split(/\r?\n/)
				.map((value) => value.trim())
				.filter((value) => value.length > 0)
				.map((value) => canonicalizeAnsteelAnchorRemoteEndpoint(cwd, value)),
		);
		if (endpoints.size !== 1) {
			throw new AnsteelTeamStateError("Ansteel team anchor remote endpoints are not a single matching endpoint");
		}
		return [...endpoints];
	};
	const [fetchEndpoint] = getEndpoints(false);
	const [pushEndpoint] = getEndpoints(true);
	if (fetchEndpoint !== pushEndpoint) {
		throw new AnsteelTeamStateError("Ansteel team anchor remote endpoints are not a single matching endpoint");
	}
	return fetchEndpoint!;
}

function assertAnsteelAnchorRemoteEndpoint(value: unknown): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || /[\r\n\0]/.test(value)) {
		throw new AnsteelTeamStateError("Ansteel team anchor receipt has an invalid remote endpoint");
	}
	try {
		const parsed = new URL(value);
		if (
			(parsed.protocol !== "file:" && parsed.hostname.length === 0) ||
			parsed.username.length > 0 ||
			parsed.password.length > 0 ||
			parsed.search.length > 0 ||
			parsed.hash.length > 0
		) {
			throw new Error("invalid endpoint");
		}
	} catch {
		throw new AnsteelTeamStateError("Ansteel team anchor receipt has an invalid remote endpoint");
	}
}

interface ResolvedAnsteelAnchorTarget {
	target: AnsteelTeamAnchorTarget;
	anchorEventType: "task-anchor" | "milestone-anchor";
	approvalEventType: "task-review" | "milestone-review";
	requiredReviewers: readonly AnsteelRole[];
	approvalMarker: string;
}

function resolveAnsteelAnchorTarget(state: AnsteelTeamState, targetId: string): ResolvedAnsteelAnchorTarget {
	if (/^TASK-/.test(targetId)) {
		assertTaskId(targetId);
		const task = state.tasks.find((item) => item.id === targetId);
		if (!task) throw new AnsteelTeamStateError(`Ansteel team task ${targetId} does not exist`);
		if (task.status !== "approved" || task.revision < 1) {
			throw new AnsteelTeamStateError(`Ansteel team task ${targetId} must be approved before external anchoring`);
		}
		return {
			target: { kind: "task", id: task.id, revision: task.revision },
			anchorEventType: "task-anchor",
			approvalEventType: "task-review",
			requiredReviewers: ANSTEEL_ROLES.filter((role) => role !== task.owner),
			approvalMarker: `${task.id} revision ${task.revision}: APPROVE`,
		};
	}
	assertMilestoneId(targetId);
	const milestone = state.milestones.find((item) => item.id === targetId);
	if (!milestone) throw new AnsteelTeamStateError(`Ansteel team milestone ${targetId} does not exist`);
	if (milestone.status !== "approved" || milestone.revision < 1) {
		throw new AnsteelTeamStateError(`Ansteel team milestone ${targetId} must be approved before external anchoring`);
	}
	return {
		target: { kind: "milestone", id: milestone.id, revision: milestone.revision },
		anchorEventType: "milestone-anchor",
		approvalEventType: "milestone-review",
		requiredReviewers: ["staff-engineer", "qa-engineer"],
		approvalMarker: `${milestone.id} integration revision ${milestone.revision}: APPROVE`,
	};
}

function getAnsteelAnchorNotesRef(state: AnsteelTeamState, target: AnsteelTeamAnchorTarget): string {
	// The validated kind and ID give every completed task or milestone revision
	// its own immutable ref. A receipt can therefore never overwrite another
	// work item's historical note on the same source commit.
	return `refs/notes/ansteel/${state.id}/${target.kind}/${target.id}/${target.revision}`;
}

function assertAnsteelAnchorApprovalEvents(
	events: readonly AnsteelTeamEvent[],
	target: ResolvedAnsteelAnchorTarget,
): void {
	for (const reviewer of target.requiredReviewers) {
		const approved = events.some(
			(event) =>
				event.type === target.approvalEventType &&
				event.role === reviewer &&
				event.content.includes(target.approvalMarker),
		);
		if (!approved) {
			throw new AnsteelTeamStateError(
				`Ansteel team ${target.target.kind} ${target.target.id} requires a signed ${reviewer} approval event before external anchoring`,
			);
		}
	}
}

function readGitRefObject(cwd: string, ref: string): string {
	const object = runAnsteelTeamGitCommand(cwd, ["rev-parse", "--verify", ref], "read anchor Git ref").trim();
	if (!/^[0-9a-f]{40,64}$/i.test(object)) {
		throw new AnsteelTeamStateError("Ansteel team anchor Git ref does not resolve to an object ID");
	}
	return object;
}

function readRemoteGitRefObject(cwd: string, remote: string, ref: string): string {
	const output = runAnsteelTeamGitCommand(cwd, ["ls-remote", "--refs", remote, ref], "verify remote anchor ref");
	const line = output
		.split(/\r?\n/)
		.map((entry) => entry.trim())
		.find((entry) => entry.length > 0);
	if (!line) throw new AnsteelTeamStateError("Ansteel team remote anchor ref was not found after push");
	const [object, actualRef] = line.split(/\s+/);
	if (!object || actualRef !== ref || !/^[0-9a-f]{40,64}$/i.test(object)) {
		throw new AnsteelTeamStateError("Ansteel team remote anchor ref is malformed");
	}
	return object;
}

/**
 * A notes ref alone only proves receipt delivery. Fetch the recorded source
 * branch into a disposable local ref and require the anchored commit to remain
 * reachable from it, so a force-push that removes the anchored history is
 * detected without treating an ordinary fast-forward as tampering.
 */
function assertAnsteelRemoteAnchorCommitReachable(cwd: string, remote: string, branch: string, commit: string): void {
	const remoteBranchRef = `refs/heads/${branch}`;
	const advertisedCommit = readRemoteGitRefObject(cwd, remote, remoteBranchRef);
	const verificationRef = `refs/ansteel-verify/${createHash("sha256")
		.update(`${remote}\0${branch}\0${process.pid}\0${Date.now()}`)
		.digest("hex")}`;
	try {
		runAnsteelTeamGitCommand(
			cwd,
			["fetch", "--no-tags", remote, `+${remoteBranchRef}:${verificationRef}`],
			"fetch recorded anchor source branch",
		);
		if (readGitRefObject(cwd, verificationRef) !== advertisedCommit) {
			throw new AnsteelTeamStateError("Ansteel team remote anchor source branch changed during verification");
		}
		runAnsteelTeamGitCommand(
			cwd,
			["merge-base", "--is-ancestor", commit, verificationRef],
			"verify anchored commit remains reachable from the remote source branch",
		);
	} finally {
		// The verification ref is never evidence. Best-effort deletion is still
		// bounded and leaves a failure closed if the ref cannot be cleaned up.
		runAnsteelTeamGitCommand(cwd, ["update-ref", "-d", verificationRef], "clean anchor verification ref", [0, 1]);
	}
}

/**
 * Anchor a fully signed, approved task or milestone to an explicit Git remote.
 * Network traffic occurs only when the user invokes an anchor command; normal
 * approval, status, and task operations remain local.
 */
function anchorAnsteelTeamWorkUnit(
	cwd: string,
	state: AnsteelTeamState,
	targetId: string,
	options: AnchorAnsteelTeamOptions = {},
	persistence?: AnsteelTeamPersistenceContext,
): AnsteelTeamExternalAnchor {
	const projectDirectory = assertProjectDirectory(cwd);
	assertState(state);
	// Do not create a remote receipt from a caller-provided state until the
	// durable sequence, head hash, and signing manifest prove it is current.
	assertAnsteelTeamEventLedger(projectDirectory, state);
	const target = resolveAnsteelAnchorTarget(state, targetId);

	const events = listAnsteelTeamEvents(projectDirectory);
	if (events.length === 0)
		throw new AnsteelTeamStateError("Ansteel team external anchoring requires a non-empty event ledger");
	assertAnsteelAnchorApprovalEvents(events, target);
	const signing = verifyAnsteelTeamAuditEventSignatures(projectDirectory, events);
	if (signing.mode !== "fully-signed" || !signing.manifestHash) {
		throw new AnsteelTeamStateError(
			"Ansteel team external anchoring requires a fully signed ledger; legacy unsigned history cannot be claimed as signed",
		);
	}
	const runtimeIntegrity = verifyAnsteelRuntimeLogIntegrity(projectDirectory);
	const runtimeSnapshot = captureAnsteelRuntimeAnchorSnapshot(projectDirectory, runtimeIntegrity.indexHash);
	const workingTree = runAnsteelTeamGitCommand(
		projectDirectory,
		["status", "--porcelain=v1", "--untracked-files=all"],
		"verify anchor worktree",
	);
	if (workingTree.trim().length !== 0) {
		throw new AnsteelTeamStateError("Ansteel team external anchoring requires a clean Git worktree");
	}
	const branch = runAnsteelTeamGitCommand(
		projectDirectory,
		["symbolic-ref", "--quiet", "--short", "HEAD"],
		"verify anchor branch",
	).trim();
	if (branch.length === 0)
		throw new AnsteelTeamStateError("Ansteel team external anchoring requires a named Git branch");
	const commit = runAnsteelTeamGitCommand(
		projectDirectory,
		["rev-parse", "--verify", "HEAD"],
		"read anchor commit",
	).trim();
	if (!/^[0-9a-f]{40,64}$/i.test(commit)) {
		throw new AnsteelTeamStateError("Ansteel team external anchoring requires a verifiable Git HEAD");
	}
	const remote = assertAnsteelAnchorRemote(options.remote ?? "origin");
	const remoteEndpoint = getAnsteelAnchorRemoteEndpoint(projectDirectory, remote);
	const remoteCommit = readRemoteGitRefObject(projectDirectory, remote, `refs/heads/${branch}`);
	if (remoteCommit !== commit) {
		throw new AnsteelTeamStateError(
			"Ansteel team external anchoring requires the selected remote branch to contain the exact current HEAD",
		);
	}

	const merkle = createAnsteelTeamMerkleRoot(events.map((event) => event.hash));
	const notesRef = getAnsteelAnchorNotesRef(state, target.target);
	// The immutable receipt deliberately excludes a wall-clock timestamp. A push
	// failure can leave its local note behind; excluding a fresh timestamp makes
	// the identical ledger snapshot safely retryable without allowing a changed
	// snapshot to overwrite the existing note.
	const unsignedAnchor: Omit<AnsteelTeamAnchorNote, "anchorHash"> = {
		schemaVersion: 3 as const,
		teamId: state.id,
		target: target.target,
		eventRange: {
			firstSequence: events[0]!.sequence,
			lastSequence: events.at(-1)!.sequence,
			eventCount: events.length,
		},
		merkle: {
			algorithm: merkle.algorithm,
			leafCount: merkle.leafCount,
			root: merkle.root,
		},
		signingManifestHash: signing.manifestHash,
		runtimeLogIndexHash: runtimeSnapshot.indexHash,
		runtimeLogSnapshotHash: runtimeSnapshot.snapshotHash,
		git: {
			commit,
			branch,
			remote,
			remoteEndpoint,
			notesRef,
		},
	};
	const note: AnsteelTeamAnchorNote = {
		...unsignedAnchor,
		anchorHash: hashAnsteelAuditValue(unsignedAnchor),
	};
	const noteContent = canonicalizeAnsteelAuditValue(note);

	// Preflight key access before altering Git metadata. It intentionally signs
	// a non-persisted placeholder hash, which proves key-store readability but
	// cannot be replayed as a ledger signature.
	signAnsteelTeamAuditEvent(projectDirectory, state.id, {
		sequence: state.nextEventSequence,
		role: "coordinator",
		hash: "0".repeat(64),
	});
	const existingNote = runAnsteelTeamGitCommand(
		projectDirectory,
		["notes", `--ref=${notesRef}`, "show", commit],
		"read existing anchor note",
		[0, 1],
	);
	if (existingNote.trim().length > 0 && existingNote.trim() !== noteContent) {
		throw new AnsteelTeamStateError("Ansteel team anchor note already contains a different immutable receipt");
	}
	if (existingNote.trim().length === 0) {
		runAnsteelTeamGitCommand(
			projectDirectory,
			["notes", `--ref=${notesRef}`, "add", "-m", noteContent, commit],
			"write anchor Git note",
		);
	}
	runAnsteelTeamGitCommand(projectDirectory, ["push", remote, `${notesRef}:${notesRef}`], "push external anchor");
	// Re-read the configured endpoint and source branch after the write. This
	// closes the success path if a remote alias changes locally or an unprotected
	// server force-push removes the source commit while the notes ref is pushed.
	if (getAnsteelAnchorRemoteEndpoint(projectDirectory, remote) !== remoteEndpoint) {
		throw new AnsteelTeamStateError("Ansteel team anchor remote endpoint changed while anchoring was in progress");
	}
	assertAnsteelRemoteAnchorCommitReachable(projectDirectory, remote, branch, commit);
	const noteObject = readGitRefObject(projectDirectory, notesRef);
	const remoteRefObject = readRemoteGitRefObject(projectDirectory, remote, notesRef);
	if (noteObject !== remoteRefObject) {
		throw new AnsteelTeamStateError("Ansteel team remote anchor ref does not match the local note object");
	}
	const currentCommit = runAnsteelTeamGitCommand(
		projectDirectory,
		["rev-parse", "--verify", "HEAD"],
		"recheck anchor commit",
	).trim();
	if (currentCommit !== commit) {
		throw new AnsteelTeamStateError("Ansteel team Git HEAD changed while external anchoring was in progress");
	}

	const anchor: AnsteelTeamExternalAnchor = {
		...note,
		anchoredAt: new Date().toISOString(),
		git: { ...note.git, noteObject, remoteRefObject },
	};
	appendAnsteelTeamEvent(
		projectDirectory,
		state,
		{
			type: target.anchorEventType,
			role: "coordinator",
			anchor,
			content: [
				`${target.target.kind === "task" ? "Task" : "Milestone"} ${target.target.id} revision ${target.target.revision} externally anchored.`,
				`Anchor hash: ${anchor.anchorHash}`,
				`Merkle root: ${anchor.merkle.root}`,
				`Git commit: ${anchor.git.commit}`,
				`Git notes ref: ${anchor.git.notesRef}`,
				`Remote: ${anchor.git.remote}`,
			].join("\n"),
		},
		persistence,
	);
	return anchor;
}

export function anchorAnsteelTeamTask(
	cwd: string,
	state: AnsteelTeamState,
	taskId: string,
	options: AnchorAnsteelTeamTaskOptions = {},
	persistence?: AnsteelTeamPersistenceContext,
): AnsteelTeamTaskGitAnchor {
	return anchorAnsteelTeamWorkUnit(cwd, state, taskId, options, persistence);
}

export function anchorAnsteelTeamMilestone(
	cwd: string,
	state: AnsteelTeamState,
	milestoneId: string,
	options: AnchorAnsteelTeamMilestoneOptions = {},
	persistence?: AnsteelTeamPersistenceContext,
): AnsteelTeamMilestoneGitAnchor {
	return anchorAnsteelTeamWorkUnit(cwd, state, milestoneId, options, persistence);
}

/** Reconstruct the exact immutable note body from its observed ledger receipt. */
function getAnsteelAnchorNoteFromReceipt(anchor: AnsteelTeamExternalAnchor): AnsteelTeamAnchorNote {
	return {
		schemaVersion: anchor.schemaVersion,
		anchorHash: anchor.anchorHash,
		teamId: anchor.teamId,
		target: anchor.target,
		eventRange: anchor.eventRange,
		merkle: anchor.merkle,
		signingManifestHash: anchor.signingManifestHash,
		runtimeLogIndexHash: anchor.runtimeLogIndexHash,
		runtimeLogSnapshotHash: anchor.runtimeLogSnapshotHash,
		git: {
			commit: anchor.git.commit,
			branch: anchor.git.branch,
			remote: anchor.git.remote,
			remoteEndpoint: anchor.git.remoteEndpoint,
			notesRef: anchor.git.notesRef,
		},
	};
}

/**
 * Replays the signed local receipt and checks that the exact recorded Git note
 * object is still advertised by the named remote. This is intentionally a
 * separate explicit command because it performs a network read.
 */
export function verifyAnsteelTeamExternalAnchor(
	cwd: string,
	state: AnsteelTeamState,
	targetId: string,
	options: AnchorAnsteelTeamOptions = {},
): AnsteelTeamExternalAnchor {
	const projectDirectory = assertProjectDirectory(cwd);
	assertState(state);
	assertAnsteelTeamEventLedger(projectDirectory, state);
	const target = resolveAnsteelAnchorTarget(state, targetId).target;
	const events = listAnsteelTeamEvents(projectDirectory);
	const event = [...events]
		.reverse()
		.find(
			(candidate) =>
				candidate.anchor?.target.kind === target.kind &&
				candidate.anchor.target.id === target.id &&
				candidate.anchor.target.revision === target.revision,
		);
	if (!event?.anchor) {
		throw new AnsteelTeamStateError(
			`Ansteel team ${target.kind} ${target.id} revision ${target.revision} has no persisted external anchor receipt`,
		);
	}
	const anchor = event.anchor;
	const remote = assertAnsteelAnchorRemote(options.remote ?? anchor.git.remote);
	if (remote !== anchor.git.remote) {
		throw new AnsteelTeamStateError("Ansteel team anchor verification remote does not match the persisted receipt");
	}
	const remoteEndpoint = getAnsteelAnchorRemoteEndpoint(projectDirectory, remote);
	if (remoteEndpoint !== anchor.git.remoteEndpoint) {
		throw new AnsteelTeamStateError("Ansteel team anchor verification endpoint does not match the persisted receipt");
	}
	assertAnsteelRemoteAnchorCommitReachable(projectDirectory, remote, anchor.git.branch, anchor.git.commit);
	const remoteRefObject = readRemoteGitRefObject(projectDirectory, remote, anchor.git.notesRef);
	if (remoteRefObject !== anchor.git.remoteRefObject || remoteRefObject !== anchor.git.noteObject) {
		throw new AnsteelTeamStateError("Ansteel team remote anchor receipt no longer matches the signed ledger record");
	}
	if (readGitRefObject(projectDirectory, anchor.git.notesRef) !== remoteRefObject) {
		throw new AnsteelTeamStateError("Ansteel team local anchor note ref no longer matches the remote receipt");
	}
	const localNoteContent = runAnsteelTeamGitCommand(
		projectDirectory,
		["notes", `--ref=${anchor.git.notesRef}`, "show", anchor.git.commit],
		"read anchored Git note",
	);
	let observedNote: unknown;
	try {
		observedNote = JSON.parse(localNoteContent);
	} catch {
		throw new AnsteelTeamStateError("Ansteel team anchored Git note is not valid JSON");
	}
	if (
		canonicalizeAnsteelAuditValue(observedNote) !==
		canonicalizeAnsteelAuditValue(getAnsteelAnchorNoteFromReceipt(anchor))
	) {
		throw new AnsteelTeamStateError("Ansteel team remote Git note does not match the signed ledger receipt");
	}
	const signing = verifyAnsteelTeamAuditEventSignatures(projectDirectory, events);
	if (signing.mode !== "fully-signed" || signing.manifestHash !== anchor.signingManifestHash) {
		throw new AnsteelTeamStateError("Ansteel team signing manifest does not match the anchored receipt");
	}
	verifyAnsteelRuntimeAnchorSnapshot(projectDirectory, anchor.runtimeLogIndexHash, anchor.runtimeLogSnapshotHash);
	return anchor;
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

export async function runAnsteelTeamTaskTest(
	cwd: string,
	state: AnsteelTeamState,
	role: AnsteelRole,
	taskId: string,
	command: string,
	persistence?: AnsteelTeamPersistenceContext,
): Promise<AnsteelTeamTaskTestEvidence> {
	const projectDirectory = assertProjectDirectory(cwd);
	assertState(state);
	const task = getTaskForOwner(state, role, taskId);
	assertTaskCanBeChanged(task);
	if (typeof command !== "string") {
		throw new AnsteelTeamStateError("Ansteel team task tests require a command");
	}
	const normalizedCommand = assertAllowedTaskTestCommand(command);
	const result = await runAnsteelGovernedProcess({
		command: normalizedCommand,
		args: [],
		cwd: projectDirectory,
		env: getAnsteelTeamDeliveryEnvironment(),
		shell: true,
		timeoutMs: ANSTEEL_TEAM_TEST_TIMEOUT_MS,
		maximumOutputBytes: ANSTEEL_TEAM_TEST_OUTPUT_MAX_BYTES,
		policy: "task-test",
		role,
		taskId,
		...(persistence?.toolCallId === undefined ? {} : { toolCallId: persistence.toolCallId }),
		...(persistence === undefined ? {} : { persistence }),
	});
	const diagnostic = result.launchError
		? `\n${result.launchError.message}`
		: result.timedOut
			? `\nProcess timed out after ${ANSTEEL_TEAM_TEST_TIMEOUT_MS}ms`
			: result.stdoutTruncated || result.stderrTruncated
				? "\nProcess output exceeded the governed collection boundary"
				: "";
	const output = `${diagnostic}${result.stdout}${result.stderr}`;
	return recordAnsteelTeamTaskTestResult(projectDirectory, state, role, taskId, {
		command: normalizedCommand,
		output,
		isError:
			result.exitCode !== 0 ||
			result.launchError !== undefined ||
			result.timedOut ||
			result.stdoutTruncated ||
			result.stderrTruncated,
	});
}

function runGit(cwd: string, args: string[], allowedExitCodes: readonly number[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 4 * 1024 * 1024,
		timeout: ANSTEEL_GIT_COMMAND_TIMEOUT_MS,
		windowsHide: true,
	});
	if (result.error || result.status === null || !allowedExitCodes.includes(result.status)) {
		const reason = result.error?.message ?? result.stderr?.trim() ?? "unknown git failure";
		throw new AnsteelTeamStateError(`Ansteel team could not capture the task diff: ${reason}`);
	}
	return result.stdout;
}

/**
 * Git anchor operations deliberately suppress raw stderr. Remote URLs and
 * credential helpers can echo secrets on failure, while the runtime log still
 * records the stable command outcome through its normal redaction boundary.
 */
function runAnsteelTeamGitCommand(
	cwd: string,
	args: string[],
	operation: string,
	allowedExitCodes: readonly number[] = [0],
): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 4 * 1024 * 1024,
		timeout: ANSTEEL_GIT_COMMAND_TIMEOUT_MS,
		windowsHide: true,
	});
	if (result.error || result.status === null || !allowedExitCodes.includes(result.status)) {
		throw new AnsteelTeamStateError(`Ansteel team could not ${operation}`);
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

function getTaskCollaborationRoles(task: AnsteelTeamTask): AnsteelRole[] {
	return ANSTEEL_ROLES.filter((role) => role !== task.owner);
}

export function publishAnsteelTeamTaskCollaboration(
	cwd: string,
	state: AnsteelTeamState,
	collaborator: AnsteelRole,
	taskId: string,
	input: PublishAnsteelTeamCollaborationInput,
): AnsteelTeamCollaborationUpdate {
	const projectDirectory = assertProjectDirectory(cwd);
	assertState(state);
	assertRole(collaborator, "task collaborator");
	assertTaskId(taskId);
	const task = state.tasks.find((item) => item.id === taskId);
	if (!task) throw new AnsteelTeamStateError(`Ansteel team task ${taskId} does not exist`);
	if (task.status !== "submitted") {
		throw new AnsteelTeamStateError(
			`Ansteel team task ${taskId} is ${task.status}; it is not accepting continuous collaboration updates`,
		);
	}
	if (!getTaskCollaborationRoles(task).includes(collaborator)) {
		throw new AnsteelTeamStateError(`Ansteel team task ${taskId} owner cannot publish a peer collaboration update`);
	}
	if (!task.submissions.some((submission) => submission.revision === task.revision)) {
		throw new AnsteelTeamStateError(`Ansteel team task ${taskId} has no immutable evidence package`);
	}
	if (
		task.collaborationUpdates.some(
			(update) => update.revision === task.revision && update.collaborator === collaborator,
		)
	) {
		throw new AnsteelTeamStateError(
			`Ansteel team task ${taskId} already has a ${collaborator} collaboration update for revision ${task.revision}`,
		);
	}
	const update = createAnsteelTeamCollaborationUpdate(task.revision, collaborator, input);
	task.collaborationUpdates.push(update);
	saveAnsteelTeamState(projectDirectory, state);
	return update;
}

export function getAnsteelTeamTaskFinalVerificationReadiness(
	cwd: string,
	state: AnsteelTeamState,
	taskId: string,
): AnsteelTeamFinalVerificationReadiness {
	const projectDirectory = assertProjectDirectory(cwd);
	assertState(state);
	assertTaskId(taskId);
	const task = state.tasks.find((item) => item.id === taskId);
	if (!task) throw new AnsteelTeamStateError(`Ansteel team task ${taskId} does not exist`);
	const blockers: string[] = [];
	if (task.status !== "submitted") {
		blockers.push(`task status is ${task.status}, not submitted`);
	}
	const submission = task.submissions.at(-1);
	if (!submission || submission.revision !== task.revision) {
		blockers.push("latest immutable evidence package is missing");
	} else {
		if (submission.test.isError) blockers.push("latest immutable task test did not succeed");
		if (collectTaskDiff(projectDirectory, task) !== submission.diff) {
			blockers.push("current claimed-file diff differs from the immutable evidence package");
		}
	}
	for (const collaborator of getTaskCollaborationRoles(task)) {
		if (
			!task.collaborationUpdates.some(
				(update) => update.revision === task.revision && update.collaborator === collaborator,
			)
		) {
			blockers.push(`missing continuous collaboration update from ${collaborator}`);
		}
	}
	for (const issue of getOpenBlockingProcessIssuesForTasks(state, new Set([task.id]))) {
		blockers.push(`open ${issue.severity} process issue ${issue.id}`);
	}
	return { ready: blockers.length === 0, blockers };
}

export function returnAnsteelTeamTaskForCollaboration(
	cwd: string,
	state: AnsteelTeamState,
	taskId: string,
	reason: string,
): AnsteelTeamTask {
	const projectDirectory = assertProjectDirectory(cwd);
	assertState(state);
	assertTaskId(taskId);
	if (typeof reason !== "string" || reason.trim().length === 0) {
		throw new AnsteelTeamStateError("Ansteel team task collaboration return requires a reason");
	}
	const task = state.tasks.find((item) => item.id === taskId);
	if (!task) throw new AnsteelTeamStateError(`Ansteel team task ${taskId} does not exist`);
	if (task.status !== "submitted") {
		return rejectPersistedAnsteelStateTransition(
			projectDirectory,
			state,
			task,
			"task",
			task.id,
			"revision-required",
			"task-collaboration-return-recorded",
			"no-governed-progress",
			`Ansteel team task ${taskId} is ${task.status}; it cannot be returned for collaboration`,
		);
	}
	applyAnsteelStateTransition(state, task, "task", task.id, "revision-required", {
		guard: "task-collaboration-return-recorded",
		causeEventId: reason.trim(),
	});
	task.testEvidence = [];
	reconcileAnsteelTeamTaskDependencies(state);
	saveAnsteelTeamState(projectDirectory, state);
	return task;
}

export function beginAnsteelTeamTaskFinalVerification(
	cwd: string,
	state: AnsteelTeamState,
	taskId: string,
): AnsteelTeamTaskSubmission {
	const projectDirectory = assertProjectDirectory(cwd);
	const readiness = getAnsteelTeamTaskFinalVerificationReadiness(projectDirectory, state, taskId);
	if (!readiness.ready) {
		const task = state.tasks.find((item) => item.id === taskId)!;
		rejectAnsteelStateTransition(state, task, "task", task.id, "final-verification", {
			guard: "task-final-verification-ready",
			reasonCode: readiness.blockers.some((blocker) => blocker.startsWith("open "))
				? "blocking-process-issue-open"
				: readiness.blockers.some((blocker) => blocker.includes("diff differs"))
					? "diff-hash-mismatch"
					: "no-governed-progress",
		});
		saveAnsteelTeamState(projectDirectory, state);
		throw new AnsteelTeamStateError(
			`Ansteel team task ${taskId} cannot begin final verification: ${readiness.blockers.join("; ")}`,
		);
	}
	const task = state.tasks.find((item) => item.id === taskId)!;
	const submission = task.submissions.at(-1)!;
	applyAnsteelStateTransition(state, task, "task", task.id, "final-verification", {
		guard: "task-final-verification-ready",
	});
	saveAnsteelTeamState(projectDirectory, state);
	return submission;
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
				collaborationUpdates: task.collaborationUpdates.length,
				reviews: task.reviews.length,
				diffHash,
			}),
			"utf8",
		)
		.digest("hex");
}

/**
 * Fingerprints durable collaboration facts for the task's current revision.
 * This is intentionally separate from delivery progress: collaboration can
 * justify one bounded owner continuation, but it cannot manufacture delivery.
 */
export function getAnsteelTeamTaskCollaborationFingerprint(
	cwd: string,
	state: AnsteelTeamState,
	taskId: string,
): string {
	assertProjectDirectory(cwd);
	assertState(state);
	assertTaskId(taskId);
	const task = state.tasks.find((item) => item.id === taskId);
	if (!task) throw new AnsteelTeamStateError(`Ansteel team task ${taskId} does not exist`);

	const revisionPrefix = `${task.id}@${task.revision};`;
	const checkpoints = state.workCheckpoints
		.filter(
			(checkpoint) =>
				checkpoint.taskId === task.id && checkpoint.governedAction?.version.startsWith(revisionPrefix) === true,
		)
		.map((checkpoint) => ({ id: checkpoint.id, version: checkpoint.governedAction!.version }))
		.sort((left, right) => left.id.localeCompare(right.id));
	const checkpointIds = new Set(checkpoints.map((checkpoint) => checkpoint.id));
	const processIssues = state.processIssues
		.filter((issue) => checkpointIds.has(issue.targetCheckpointId))
		.map((issue) => ({
			id: issue.id,
			resolutions: issue.resolutions
				.map((resolution) => ({ id: resolution.id, reviewed: resolution.review !== undefined }))
				.sort((left, right) => left.id.localeCompare(right.id)),
		}))
		.sort((left, right) => left.id.localeCompare(right.id));
	const actionReviews = state.actionReviews
		.filter((review) => checkpointIds.has(review.checkpointId))
		.map((review) => ({ checkpointId: review.checkpointId, reviewer: review.reviewer }))
		.sort((left, right) =>
			`${left.checkpointId}\0${left.reviewer}`.localeCompare(`${right.checkpointId}\0${right.reviewer}`),
		);

	return createHash("sha256")
		.update(JSON.stringify({ checkpoints, processIssues, actionReviews }), "utf8")
		.digest("hex");
}

/**
 * 对当前 revision 中曾获得全部必要同伴批准的唯一任务动作绑定做指纹。指纹故意不包含
 * checkpoint ID 和 checkpoint 当前状态：替换或重命名同一个已批准动作不能伪造“新进展”，
 * 后续治理变化导致批准消失也不能被反向计算为前进。
 */
export function getAnsteelTeamTaskActionApprovalFingerprint(
	cwd: string,
	state: AnsteelTeamState,
	taskId: string,
): string {
	assertProjectDirectory(cwd);
	assertState(state);
	assertTaskId(taskId);
	const task = state.tasks.find((item) => item.id === taskId);
	if (!task) throw new AnsteelTeamStateError(`Ansteel team task ${taskId} does not exist`);

	const revisionPrefix = `${task.id}@${task.revision};`;
	const approvedBindings = new Set<string>();
	for (const checkpoint of state.workCheckpoints) {
		const action = checkpoint.governedAction;
		if (
			checkpoint.taskId !== task.id ||
			action === null ||
			!action.version.startsWith(revisionPrefix) ||
			action.effectiveRisk === "green"
		) {
			continue;
		}

		const reviews = state.actionReviews.filter(
			(review) =>
				review.checkpointId === checkpoint.id &&
				review.action.kind === action.kind &&
				review.action.target === action.target &&
				review.action.version === action.version,
		);
		if (reviews.some((review) => review.verdict === "reject")) continue;
		const requiredReviewers = getRequiredAnsteelActionReviewers(checkpoint.actor);
		if (
			!requiredReviewers.every((reviewer) =>
				reviews.some((review) => review.reviewer === reviewer && review.verdict === "approve"),
			)
		) {
			continue;
		}
		approvedBindings.add(JSON.stringify([checkpoint.actor, action.kind, action.target, action.version]));
	}

	return createHash("sha256")
		.update(JSON.stringify([...approvedBindings].sort()), "utf8")
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
	if (task.status !== "claimed" && task.status !== "revision-required") {
		return rejectPersistedAnsteelStateTransition(
			projectDirectory,
			state,
			task,
			"task",
			task.id,
			"submitted",
			"task-submission-evidence-valid",
			"no-governed-progress",
			`Ansteel team task ${task.id} is ${task.status}; it cannot be changed`,
		);
	}
	if (typeof testCommand !== "string" || testCommand.trim().length === 0) {
		throw new AnsteelTeamStateError("Ansteel team task submission requires the exact test command");
	}
	const test = [...task.testEvidence]
		.reverse()
		.find((evidence) => evidence.command === testCommand.trim() && !evidence.isError);
	if (!test) {
		return rejectPersistedAnsteelStateTransition(
			projectDirectory,
			state,
			task,
			"task",
			task.id,
			"submitted",
			"task-submission-evidence-valid",
			"no-governed-progress",
			`Ansteel team task ${task.id} requires a successful recorded result for ${testCommand.trim()}`,
		);
	}
	let diff: string;
	try {
		diff = captureTaskDiff(projectDirectory, task);
	} catch (error) {
		if (!(error instanceof AnsteelTeamStateError)) throw error;
		return rejectPersistedAnsteelStateTransition(
			projectDirectory,
			state,
			task,
			"task",
			task.id,
			"submitted",
			"task-submission-evidence-valid",
			error.message.includes("has no Git diff") ? "no-governed-progress" : "tool-exit-nonzero",
			error.message,
		);
	}
	const submission: AnsteelTeamTaskSubmission = {
		revision: task.revision + 1,
		submittedAt: new Date().toISOString(),
		diff,
		test: { ...test },
	};
	task.revision = submission.revision;
	task.submissions.push(submission);
	applyAnsteelStateTransition(state, task, "task", task.id, "submitted", {
		guard: "task-submission-evidence-valid",
	});
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
	if (task.status !== "final-verification") {
		throw new AnsteelTeamStateError(`Ansteel team task ${taskId} is not in final verification`);
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
		applyAnsteelStateTransition(state, task, "task", task.id, "revision-required", {
			guard: "task-final-review-recorded",
			causeEventId: `REVIEW-${review.reviewer}-${review.reviewedAt}`,
		});
		task.testEvidence = [];
	} else {
		const peerReviews = task.reviews.filter((item) => item.revision === submission.revision);
		const peerRoles = ANSTEEL_ROLES.filter((role) => role !== task.owner);
		if (peerRoles.every((role) => peerReviews.some((item) => item.reviewer === role && item.verdict === "approve"))) {
			applyAnsteelStateTransition(state, task, "task", task.id, "approved", {
				guard: "all-independent-task-reviews-approved",
			});
		}
	}
	reconcileAnsteelTeamTaskDependencies(state);
	saveAnsteelTeamState(projectDirectory, state);
	return review;
}

function hashAnsteelTeamTaskSubmissionDiff(task: AnsteelTeamTask): string {
	const submission = task.submissions.find((candidate) => candidate.revision === task.revision);
	if (!submission) throw new AnsteelTeamStateError(`Ansteel team task ${task.id} has no current submission`);
	return createHash("sha256").update(submission.diff, "utf8").digest("hex");
}

interface AnsteelTeamDeliveryWorkspaceSnapshot {
	hash: string;
	trackedDiffHash: string;
	untracked: Array<{ file: string; sha256: string }>;
}

/**
 * 只有将已签名公共账本重放并与持久状态核对成功后，才构造事故包中由项目层负责的上下文。
 * 运行记录只用于选择相关 task 身份；记录里缺失的 revision 必须保持缺失，不能用当前 revision
 * 冒充事故发生时的历史 revision。
 */
export function createAnsteelTeamIncidentProjectContext(
	cwd: string,
	state: AnsteelTeamState,
	runtimeEntries: readonly AnsteelRuntimeLogEntry[],
): AnsteelIncidentProjectContextVerified {
	assertState(state);
	const events = listAnsteelTeamEvents(cwd);
	const board = getAnsteelTeamSharedBoard(state, events, runtimeEntries);
	const taskRevisions = new Map<string, Set<number>>();
	for (const entry of runtimeEntries) {
		if (entry.taskId === undefined) continue;
		let revisions = taskRevisions.get(entry.taskId);
		if (revisions === undefined) {
			revisions = new Set<number>();
			taskRevisions.set(entry.taskId, revisions);
		}
		if (entry.revision !== undefined) revisions.add(entry.revision);
	}
	const taskIdentities = [...taskRevisions.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([taskId, revisions]) => {
			const task = state.tasks.find((candidate) => candidate.id === taskId);
			return {
				taskId,
				runtimeRevisions: [...revisions].sort((left, right) => left - right),
				...(task === undefined ? {} : { currentRevision: task.revision, currentStatus: task.status }),
			};
		});
	const relatedTaskIds = new Set(taskIdentities.map((task) => task.taskId));
	const checkpointCandidates =
		relatedTaskIds.size === 0
			? state.workCheckpoints
			: state.workCheckpoints.filter(
					(checkpoint) => checkpoint.taskId !== undefined && relatedTaskIds.has(checkpoint.taskId),
				);
	const checkpoint = [...checkpointCandidates]
		.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
		.at(-1);
	const checkpointEvent =
		checkpoint === undefined
			? undefined
			: [...events]
					.reverse()
					.find((event) => event.checkpointId === checkpoint.id && event.type === "work-checkpoint");
	const lastValidCheckpoint =
		checkpoint === undefined
			? null
			: {
					checkpointId: checkpoint.id,
					...(checkpoint.taskId === undefined ? {} : { taskId: checkpoint.taskId }),
					actor: checkpoint.actor,
					status: checkpoint.status,
					createdAt: checkpoint.createdAt,
					risk: checkpoint.risk,
					confidence: checkpoint.confidence,
					nextAction: redactAnsteelSensitiveValue(checkpoint.nextAction) as {
						kind: string;
						target: string;
						expectedResult: string;
					},
					checkpointHash: hashAnsteelAuditValue(checkpoint),
					...(checkpointEvent === undefined ? {} : { eventSequence: checkpointEvent.sequence }),
				};
	let workspace: AnsteelIncidentProjectContextVerified["workspace"];
	try {
		workspace = { status: "captured", ...captureAnsteelTeamDeliveryWorkspaceSnapshot(cwd) };
	} catch {
		// 非 Git 项目或暂时不可访问的 worktree 仍需要生成运行事故包。这里只记录稳定的
		// “workspace-snapshot-unavailable”机械事实，不嵌入平台相关命令输出，也不伪造工作区哈希。
		workspace = { status: "unavailable", reasonCode: "workspace-snapshot-unavailable" };
	}
	const relatedTask = taskIdentities
		.map((identity) => state.tasks.find((task) => task.id === identity.taskId))
		.find((task): task is AnsteelTeamTask => task !== undefined);
	const checkpointTask =
		checkpoint?.taskId === undefined ? undefined : state.tasks.find((task) => task.id === checkpoint.taskId);
	let recoveryEntry: AnsteelIncidentProjectContextVerified["recoveryEntry"];
	if (checkpoint !== undefined) {
		recoveryEntry = {
			kind: "checkpoint",
			command:
				checkpoint.taskId === undefined
					? "/ansteel-team start <existing-topic>"
					: `/ansteel-team task ${checkpoint.taskId}`,
			checkpointId: checkpoint.id,
			...(checkpoint.taskId === undefined ? {} : { taskId: checkpoint.taskId }),
			...(checkpointTask === undefined ? {} : { revision: checkpointTask.revision }),
		};
	} else if (relatedTask !== undefined) {
		recoveryEntry = {
			kind: "task-revision",
			command: `/ansteel-team task ${relatedTask.id}`,
			taskId: relatedTask.id,
			revision: relatedTask.revision,
		};
	} else if (state.status === "active") {
		recoveryEntry = { kind: "team-resume", command: "/ansteel-team start <existing-topic>" };
	} else {
		recoveryEntry = { kind: "manual", command: "/ansteel-team status --explain" };
	}
	return {
		availability: "verified",
		teamId: state.id,
		taskIdentities,
		publicAuditEventRange: {
			firstSequence: events[0]?.sequence ?? null,
			lastSequence: events.at(-1)?.sequence ?? null,
			eventCount: events.length,
			headHash: events.at(-1)?.hash ?? null,
			integrity: "verified",
		},
		teamState: {
			status: state.status,
			collaborationStatus: board.axes.collaborationStatus,
			governanceStatus: board.axes.governanceStatus,
			deliveryStatus: board.axes.deliveryStatus,
			workflowStatus: board.axes.workflowStatus,
		},
		lastValidCheckpoint,
		workspace,
		recoveryEntry,
	};
}

function captureAnsteelTeamDeliveryWorkspaceSnapshot(cwd: string): AnsteelTeamDeliveryWorkspaceSnapshot {
	// Coordinator audit state changes while verification is running and is not a
	// product input. Exclude only that private directory; every other tracked or
	// untracked project file remains part of the immutable workspace binding.
	// Exclude the directory entry itself, not only its descendants. Some Git
	// versions still traverse an untracked `.pi` directory when only `.pi/**`
	// is supplied, so the normalized TypeScript filter below is the second
	// boundary for coordinator-created audit files.
	const projectPathspec = [".", ":(top,exclude).pi"];
	const trackedDiff = runGit(cwd, ["diff", "--no-ext-diff", "--binary", "HEAD", "--", ...projectPathspec], [0]);
	const untrackedFiles = runGit(
		cwd,
		["ls-files", "--others", "--exclude-standard", "-z", "--", ...projectPathspec],
		[0],
	)
		.split("\0")
		.filter((file) => file.length > 0 && file !== ".pi" && !file.startsWith(".pi/"))
		.sort();
	const projectDirectory = realpathSync(assertProjectDirectory(cwd));
	const untracked = untrackedFiles.map((file) => {
		const absolutePath = realpathSync(resolvePath(file, projectDirectory));
		if (getCwdRelativePath(absolutePath, projectDirectory) === undefined || !statSync(absolutePath).isFile()) {
			throw new AnsteelTeamStateError("Ansteel team delivery verification found an unsafe untracked file");
		}
		return {
			file,
			sha256: createHash("sha256").update(readFileSync(absolutePath)).digest("hex"),
		};
	});
	const trackedDiffHash = createHash("sha256").update(trackedDiff, "utf8").digest("hex");
	return {
		hash: hashAnsteelAuditValue({ trackedDiffHash, untracked }),
		trackedDiffHash,
		untracked,
	};
}

function describeAnsteelTeamDeliveryWorkspaceDrift(
	before: AnsteelTeamDeliveryWorkspaceSnapshot,
	after: AnsteelTeamDeliveryWorkspaceSnapshot,
): string {
	const reasons: string[] = [];
	if (before.trackedDiffHash !== after.trackedDiffHash) reasons.push("tracked-diff");
	const beforeFiles = new Map(before.untracked.map((entry) => [entry.file, entry.sha256]));
	const afterFiles = new Map(after.untracked.map((entry) => [entry.file, entry.sha256]));
	for (const file of [...new Set([...beforeFiles.keys(), ...afterFiles.keys()])].sort()) {
		if (beforeFiles.get(file) !== afterFiles.get(file)) reasons.push(`untracked:${file}`);
	}
	return reasons.length === 0 ? "unclassified" : reasons.join(",");
}

function readAnsteelTeamDeliveryManifest(
	cwd: string,
	manifestPath: string,
): { manifest: AnsteelTeamDeliveryManifest; manifestHash: string } {
	if (typeof manifestPath !== "string" || !isAbsolute(manifestPath)) {
		throw new AnsteelTeamStateError("Ansteel team delivery manifest path must be absolute");
	}
	const projectDirectory = realpathSync(assertProjectDirectory(cwd));
	const resolvedManifestPath = realpathSync(resolve(manifestPath));
	if (getCwdRelativePath(resolvedManifestPath, projectDirectory) !== undefined) {
		throw new AnsteelTeamStateError("Ansteel team delivery manifest must remain outside the role project directory");
	}
	const manifestStat = statSync(resolvedManifestPath);
	if (
		!manifestStat.isFile() ||
		manifestStat.size < 2 ||
		manifestStat.size > ANSTEEL_TEAM_DELIVERY_MANIFEST_MAX_BYTES
	) {
		throw new AnsteelTeamStateError("Ansteel team delivery manifest has an invalid size");
	}
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(resolvedManifestPath, "utf8"));
	} catch {
		throw new AnsteelTeamStateError("Ansteel team delivery manifest is not valid JSON");
	}
	if (
		!isRecord(raw) ||
		Object.keys(raw).length !== 4 ||
		!["version", "taskId", "revision", "checks"].every((key) => Object.hasOwn(raw, key))
	) {
		throw new AnsteelTeamStateError("Ansteel team delivery manifest has an invalid schema");
	}
	if (raw.version !== 1) {
		throw new AnsteelTeamStateError("Ansteel team delivery manifest requires version 1");
	}
	assertTaskId(raw.taskId);
	if (typeof raw.revision !== "number" || !Number.isSafeInteger(raw.revision) || raw.revision < 1) {
		throw new AnsteelTeamStateError("Ansteel team delivery manifest has an invalid revision");
	}
	if (!Array.isArray(raw.checks) || raw.checks.length < 1 || raw.checks.length > 32) {
		throw new AnsteelTeamStateError("Ansteel team delivery manifest requires 1 to 32 checks");
	}
	const checkIds = new Set<string>();
	const checks = raw.checks.map((value) => {
		if (
			!isRecord(value) ||
			Object.keys(value).length !== 4 ||
			!["id", "executable", "args", "timeoutMs"].every((key) => Object.hasOwn(value, key)) ||
			typeof value.id !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.id)
		) {
			throw new AnsteelTeamStateError("Ansteel team delivery manifest has an invalid check schema");
		}
		if (checkIds.has(value.id))
			throw new AnsteelTeamStateError(`Ansteel team delivery check ${value.id} is duplicated`);
		checkIds.add(value.id);
		if (typeof value.executable !== "string" || value.executable.includes("\0")) {
			throw new AnsteelTeamStateError(`Ansteel team delivery check ${value.id} has an invalid executable`);
		}
		const executableName = basename(value.executable).toLowerCase();
		if (!ANSTEEL_TEAM_DELIVERY_ALLOWED_EXECUTABLES.has(executableName)) {
			throw new AnsteelTeamStateError(`Ansteel team delivery check ${value.id} executable is not allowed`);
		}
		if (
			!Array.isArray(value.args) ||
			value.args.length > 128 ||
			value.args.some((arg) => typeof arg !== "string" || arg.includes("\0") || arg.length > 4096)
		) {
			throw new AnsteelTeamStateError(`Ansteel team delivery check ${value.id} has invalid arguments`);
		}
		if (
			typeof value.timeoutMs !== "number" ||
			!Number.isSafeInteger(value.timeoutMs) ||
			value.timeoutMs < 1_000 ||
			value.timeoutMs > 21_600_000
		) {
			throw new AnsteelTeamStateError(`Ansteel team delivery check ${value.id} has an invalid timeout`);
		}
		return {
			id: value.id,
			executable: value.executable,
			args: [...value.args] as string[],
			timeoutMs: value.timeoutMs as number,
		};
	});
	const manifest: AnsteelTeamDeliveryManifest = {
		version: 1,
		taskId: raw.taskId,
		revision: raw.revision as number,
		checks,
	};
	return { manifest, manifestHash: hashAnsteelAuditValue(raw) };
}

function prepareAnsteelTeamDeliveryEvidenceDirectory(cwd: string, teamId: string, manifestPath: string): string {
	const projectDirectory = realpathSync(assertProjectDirectory(cwd));
	const scope = createHash("sha256").update(`${projectDirectory}\0${teamId}`, "utf8").digest("hex");
	const root = join(dirname(realpathSync(manifestPath)), ".ansteel-delivery-evidence");
	mkdirSync(root, { recursive: true });
	const canonicalRoot = realpathSync(root);
	if (getCwdRelativePath(canonicalRoot, projectDirectory) !== undefined) {
		throw new AnsteelTeamStateError("Ansteel team delivery evidence directory must remain outside the role project");
	}
	const directory = join(canonicalRoot, scope);
	mkdirSync(directory, { recursive: true });
	const canonicalDirectory = realpathSync(directory);
	if (getCwdRelativePath(canonicalDirectory, projectDirectory) !== undefined) {
		throw new AnsteelTeamStateError("Ansteel team delivery evidence directory must remain outside the role project");
	}
	return canonicalDirectory;
}

function getAnsteelTeamDeliveryEnvironment(): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = { CI: "1", NO_COLOR: "1" };
	for (const key of ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE"]) {
		if (process.env[key] !== undefined) environment[key] = process.env[key];
	}
	return environment;
}

function appendAnsteelTeamDeliveryTerminalEvent(
	cwd: string,
	state: AnsteelTeamState,
	verificationId: string,
	status: "passed" | "failed",
	failureReason: AnsteelTeamDeliveryFailureReason | undefined,
	persistence?: AnsteelTeamPersistenceContext,
): AnsteelTeamDeliveryVerification {
	const completedAt = new Date().toISOString();
	appendAnsteelTeamEvent(
		cwd,
		state,
		{
			schemaVersion: 2,
			type: status === "passed" ? "task-delivery-passed" : "task-delivery-failed",
			role: "coordinator",
			payload: {
				kind: "task-delivery-finished",
				verificationId,
				status,
				completedAt,
				...(failureReason === undefined ? {} : { failureReason }),
			},
			content:
				status === "passed"
					? `Delivery verification ${verificationId} passed.`
					: `Delivery verification ${verificationId} failed: ${failureReason}.`,
		},
		persistence,
	);
	return state.deliveryVerifications.find((verification) => verification.id === verificationId)!;
}

/**
 * Runs a coordinator-owned, project-external manifest without exposing its
 * commands or output to role sessions. Every durable success is bound to the
 * current task revision, frozen task diff, whole workspace and Git commit.
 */
export async function verifyAnsteelTeamTaskDelivery(
	cwd: string,
	state: AnsteelTeamState,
	taskId: string,
	manifestPath: string,
	persistence?: AnsteelTeamPersistenceContext,
): Promise<AnsteelTeamDeliveryVerification> {
	const projectDirectory = assertProjectDirectory(cwd);
	assertState(state);
	assertTaskId(taskId);
	const task = state.tasks.find((item) => item.id === taskId);
	if (!task) throw new AnsteelTeamStateError(`Ansteel team task ${taskId} does not exist`);
	if (task.status !== "approved") {
		throw new AnsteelTeamStateError(`Ansteel team task ${taskId} must be approved before delivery verification`);
	}
	const { manifest, manifestHash } = readAnsteelTeamDeliveryManifest(projectDirectory, manifestPath);
	if (manifest.taskId !== task.id || manifest.revision !== task.revision) {
		throw new AnsteelTeamStateError("Ansteel team delivery manifest does not match the current task revision");
	}

	const active = state.deliveryVerifications.find(
		(verification) =>
			verification.taskId === task.id &&
			verification.revision === task.revision &&
			verification.status === "verifying",
	);
	if (active) {
		appendAnsteelTeamDeliveryTerminalEvent(projectDirectory, state, active.id, "failed", "interrupted", persistence);
	}

	const diffHash = hashAnsteelTeamTaskSubmissionDiff(task);
	const currentDiffHash = createHash("sha256").update(collectTaskDiff(projectDirectory, task), "utf8").digest("hex");
	if (currentDiffHash !== diffHash) {
		throw new AnsteelTeamStateError("Ansteel team task diff drifted before delivery verification");
	}
	const workspaceSnapshot = captureAnsteelTeamDeliveryWorkspaceSnapshot(projectDirectory);
	const workspaceHash = workspaceSnapshot.hash;
	const sourceCommit = runAnsteelTeamGitCommand(
		projectDirectory,
		["rev-parse", "HEAD"],
		"read delivery commit",
	).trim();
	if (!/^[0-9a-f]{40,64}$/i.test(sourceCommit)) {
		throw new AnsteelTeamStateError("Ansteel team delivery verification requires a valid Git commit");
	}
	const evidenceDirectory = prepareAnsteelTeamDeliveryEvidenceDirectory(projectDirectory, state.id, manifestPath);

	const verification: AnsteelTeamDeliveryVerification = {
		id: `DV-${randomUUID().toUpperCase()}`,
		taskId: task.id,
		revision: task.revision,
		diffHash,
		workspaceHash,
		sourceCommit,
		manifestHash,
		status: "verifying",
		transitionLogId: "",
		checks: [],
		startedAt: new Date().toISOString(),
	};
	appendAnsteelTeamEvent(
		projectDirectory,
		state,
		{
			schemaVersion: 2,
			type: "task-delivery-started",
			role: "coordinator",
			payload: { kind: "task-delivery-started", verification },
			content: `Delivery verification ${verification.id} started for ${task.id} revision ${task.revision}.`,
		},
		persistence,
	);

	for (const check of manifest.checks) {
		const commandHash = hashAnsteelAuditValue({ executable: check.executable, args: check.args });
		const result = await runAnsteelGovernedProcess({
			command: check.executable,
			args: check.args,
			cwd: projectDirectory,
			env: getAnsteelTeamDeliveryEnvironment(),
			shell: false,
			timeoutMs: check.timeoutMs,
			maximumOutputBytes: ANSTEEL_TEAM_DELIVERY_OUTPUT_MAX_BYTES,
			policy: "delivery-check",
			role: "coordinator",
			taskId,
			...(persistence === undefined ? {} : { persistence }),
		});
		const startedAt = result.startedAt;
		const completedAt = result.completedAt;
		const timedOut = result.timedOut;
		const isError =
			result.launchError !== undefined ||
			timedOut ||
			result.exitCode !== 0 ||
			result.stdoutTruncated ||
			result.stderrTruncated;
		const output = {
			verificationId: verification.id,
			checkId: check.id,
			stdout: result.stdout,
			stderr: `${result.stderr}${result.launchError === undefined ? "" : `\n${result.launchError.message}`}`,
			stdoutBytes: result.stdoutBytes,
			stderrBytes: result.stderrBytes,
			stdoutTruncated: result.stdoutTruncated,
			stderrTruncated: result.stderrTruncated,
			stdoutHash: result.stdoutHash,
			stderrHash: result.stderrHash,
			exitCode: result.exitCode,
			timedOut,
			isError,
			startedAt,
			completedAt,
		};
		const outputHash = hashAnsteelAuditValue({ stdoutHash: output.stdoutHash, stderrHash: output.stderrHash });
		const artifactHash = hashAnsteelAuditValue(output);
		writeDurableTemporaryFile(
			join(evidenceDirectory, `${artifactHash}.json`),
			`${canonicalizeAnsteelAuditValue(output)}\n`,
		);
		const evidence: AnsteelTeamDeliveryCheckEvidence = {
			id: check.id,
			commandHash,
			outputHash,
			artifactHash,
			exitCode: result.exitCode,
			timedOut,
			isError,
			startedAt,
			completedAt,
		};
		appendAnsteelTeamEvent(
			projectDirectory,
			state,
			{
				schemaVersion: 2,
				type: "task-delivery-check",
				role: "coordinator",
				payload: { kind: "task-delivery-check", verificationId: verification.id, check: evidence },
				content: `Delivery verification ${verification.id} check ${check.id} ${isError ? "failed" : "passed"}.`,
			},
			persistence,
		);
		if (isError) {
			const reason: AnsteelTeamDeliveryFailureReason = timedOut
				? "check-timeout"
				: result.launchError === undefined
					? "check-failed"
					: "check-launch-failed";
			const failed = appendAnsteelTeamDeliveryTerminalEvent(
				projectDirectory,
				state,
				verification.id,
				"failed",
				reason,
				persistence,
			);
			throw new AnsteelTeamStateError(`Ansteel team delivery verification ${failed.id} failed: ${reason}`);
		}
		const postCheckDiffHash = createHash("sha256")
			.update(collectTaskDiff(projectDirectory, task), "utf8")
			.digest("hex");
		const taskDiffDrifted = postCheckDiffHash !== diffHash;
		const postCheckWorkspaceSnapshot = captureAnsteelTeamDeliveryWorkspaceSnapshot(projectDirectory);
		const workspaceDrifted = postCheckWorkspaceSnapshot.hash !== workspaceHash;
		if (taskDiffDrifted || workspaceDrifted) {
			appendAnsteelTeamDeliveryTerminalEvent(
				projectDirectory,
				state,
				verification.id,
				"failed",
				"diff-drift",
				persistence,
			);
			const driftScope = taskDiffDrifted
				? "task"
				: `workspace:${describeAnsteelTeamDeliveryWorkspaceDrift(workspaceSnapshot, postCheckWorkspaceSnapshot)}`;
			throw new AnsteelTeamStateError(
				`Ansteel team delivery verification ${verification.id} failed: diff-drift (${driftScope})`,
			);
		}
		const currentCommit = runAnsteelTeamGitCommand(
			projectDirectory,
			["rev-parse", "HEAD"],
			"recheck delivery commit",
		).trim();
		if (currentCommit !== sourceCommit) {
			appendAnsteelTeamDeliveryTerminalEvent(
				projectDirectory,
				state,
				verification.id,
				"failed",
				"source-commit-drift",
				persistence,
			);
			throw new AnsteelTeamStateError(
				`Ansteel team delivery verification ${verification.id} failed: source-commit-drift`,
			);
		}
	}
	return appendAnsteelTeamDeliveryTerminalEvent(
		projectDirectory,
		state,
		verification.id,
		"passed",
		undefined,
		persistence,
	);
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
	assertAnsteelTeamAuditManifestTeam(cwd, state.id);
	const last = events.at(-1);
	if (last?.hash !== event.hash) {
		if (event.sequence !== events.length + 1 || event.previousHash !== (last?.hash ?? null)) {
			throw new AnsteelTeamStateError("Ansteel team transaction does not continue the event ledger");
		}
		// A transaction survives crashes between its durable prepare record and
		// ledger append. Verify the prepared signature before recovery so an
		// attacker cannot inject an unsigned or role-forged final line.
		verifyAnsteelTeamAuditEventSignatures(cwd, [...events, event]);
		assertAnsteelTeamAnchorEventRanges([...events, event]);
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
	saveAnsteelTeamState(cwd, state, persistence);
	unlinkSync(path);
}

function getAnsteelTeamDirectoryFromStatePath(path: string): string {
	return resolvePath(join(path, ".."));
}

function readPersistedAnsteelTransitionLogIds(path: string): Set<string> {
	if (!existsSync(path)) return new Set();
	try {
		const value = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(value) || !Array.isArray(value.transitionLogs)) return new Set();
		return new Set(
			value.transitionLogs.flatMap((entry) =>
				isRecord(entry) && typeof entry.logId === "string" ? [entry.logId] : [],
			),
		);
	} catch {
		// 正常状态写入路径会在加载时报告损坏的持久状态；这里把它视为“没有已镜像 ID”，
		// 不会隐藏新的 transition，最多导致后续严格校验再次发现同一损坏。
		return new Set();
	}
}

function createAnsteelStateTransitionRuntimeInput(
	state: AnsteelTeamState,
	entry: AnsteelStateTransitionLog,
): AnsteelRuntimeLogInput {
	const verification =
		entry.objectKind === "delivery-verification"
			? state.deliveryVerifications.find((item) => item.id === entry.objectId)
			: undefined;
	return {
		level: entry.eventName === "state.transition.rejected" ? "warn" : "audit",
		eventName: entry.eventName,
		outcome:
			entry.eventName === "state.transition.attempted"
				? "progress"
				: entry.eventName === "state.transition.applied"
					? "succeeded"
					: "failed",
		role:
			entry.objectKind === "role" && ANSTEEL_ROLES.includes(entry.objectId as AnsteelRole)
				? (entry.objectId as AnsteelRole)
				: "coordinator",
		...(entry.objectKind === "task" ? { taskId: entry.objectId } : {}),
		...(entry.objectKind === "checkpoint" ? { checkpointId: entry.objectId } : {}),
		...(entry.objectKind === "process-issue" ? { issueId: entry.objectId } : {}),
		...(verification === undefined ? {} : { taskId: verification.taskId, revision: verification.revision }),
		...(entry.reasonCode === undefined ? {} : { reasonCode: entry.reasonCode }),
		...(entry.causeEventId === undefined ? {} : { causeEventId: entry.causeEventId }),
		message: `${entry.objectKind} ${entry.objectId} transition ${entry.eventName.split(".").at(-1)}`,
		data: {
			transitionLogId: entry.logId,
			transitionId: entry.transitionId,
			objectKind: entry.objectKind,
			objectId: entry.objectId,
			from: entry.from,
			to: entry.to,
			guard: entry.guard,
			guardResult: entry.guardResult,
			triggerEventId: entry.triggerEventId,
		},
	};
}

export function saveAnsteelTeamState(
	cwd: string,
	state: AnsteelTeamState,
	persistence?: AnsteelTeamPersistenceContext,
): void {
	assertProjectDirectory(cwd);
	assertState(state);
	assertAnsteelTeamEventLedger(cwd, state);
	const statePath = getAnsteelTeamStatePath(cwd);
	if (persistence !== undefined) {
		let persistedLogIds = mirroredTransitionLogIdsByLogger.get(persistence.logger);
		if (persistedLogIds === undefined) {
			persistedLogIds = readPersistedAnsteelTransitionLogIds(statePath);
			mirroredTransitionLogIdsByLogger.set(persistence.logger, persistedLogIds);
		}
		const pendingTransitions = state.transitionLogs.filter((entry) => !persistedLogIds.has(entry.logId));
		if (pendingTransitions.length > 0) {
			persistence.logger.writeBatch(
				pendingTransitions.map((entry) => createAnsteelStateTransitionRuntimeInput(state, entry)),
			);
			for (const entry of pendingTransitions) persistedLogIds.add(entry.logId);
		}
	}
	writeAnsteelTeamState(statePath, state, persistence);
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
		state = { ...state, version: 7, workCheckpoints: [], processIssues: [] };
	}
	if (state.version === 7) {
		state = {
			...state,
			// Advance exactly one schema version so later migrations cannot be skipped when the current version grows.
			version: 8,
			workCheckpoints: Array.isArray(state.workCheckpoints)
				? state.workCheckpoints.map((checkpoint) =>
						isRecord(checkpoint) ? { ...checkpoint, status: "superseded", governedAction: null } : checkpoint,
					)
				: state.workCheckpoints,
			actionReviews: [],
		};
	}
	if (state.version === 8) {
		state = {
			...state,
			version: 9,
			tasks: Array.isArray(state.tasks)
				? state.tasks.map((task) =>
						isRecord(task) && typeof task.owner === "string" && ANSTEEL_ROLES.includes(task.owner as AnsteelRole)
							? { ...task, type: DEFAULT_TASK_TYPE_BY_ROLE[task.owner as AnsteelRole] }
							: task,
					)
				: state.tasks,
		};
	}
	if (state.version === 9) {
		state = {
			...state,
			version: 10,
			tasks: Array.isArray(state.tasks)
				? state.tasks.map((task) =>
						isRecord(task)
							? {
									...task,
									// v9 submitted work entered immediate peer review. Preserve that
									// legacy interpretation instead of falsely claiming new
									// continuous-collaboration evidence exists.
									status: task.status === "submitted" ? "final-verification" : task.status,
									collaborationUpdates: [],
								}
							: task,
					)
				: state.tasks,
			milestones: Array.isArray(state.milestones)
				? state.milestones.map((milestone) =>
						isRecord(milestone)
							? {
									...milestone,
									status: milestone.status === "submitted" ? "final-verification" : milestone.status,
									collaborationUpdates: [],
								}
							: milestone,
					)
				: state.milestones,
		};
	}
	if (state.version === 10) {
		state = {
			...state,
			version: 11,
			deliveryVerifications: [],
			// A v10 approval proves governance only. Without a current revision's
			// delivery receipt it cannot keep dependent work or milestones unlocked.
			tasks: Array.isArray(state.tasks)
				? state.tasks.map((task) =>
						isRecord(task) && Array.isArray(task.dependsOn) && task.dependsOn.length > 0
							? { ...task, status: "blocked", testEvidence: [] }
							: task,
					)
				: state.tasks,
			milestones: Array.isArray(state.milestones)
				? state.milestones.map((milestone) =>
						isRecord(milestone) ? { ...milestone, status: "blocked", testEvidence: [] } : milestone,
					)
				: state.milestones,
		};
	}
	if (state.version === 11) {
		const migrated = {
			...state,
			version: ANSTEEL_TEAM_STATE_VERSION,
			transitionLogId: "",
			transitionLogs: [],
			roles: isRecord(state.roles)
				? Object.fromEntries(
						Object.entries(state.roles).map(([role, roleState]) => [
							role,
							isRecord(roleState) ? { ...roleState, transitionLogId: "" } : roleState,
						]),
					)
				: state.roles,
			openChallenges: Array.isArray(state.openChallenges)
				? state.openChallenges.map((challenge) =>
						isRecord(challenge) ? { ...challenge, transitionLogId: "" } : challenge,
					)
				: state.openChallenges,
			tasks: Array.isArray(state.tasks)
				? state.tasks.map((task) => (isRecord(task) ? { ...task, transitionLogId: "" } : task))
				: state.tasks,
			milestones: Array.isArray(state.milestones)
				? state.milestones.map((milestone) =>
						isRecord(milestone) ? { ...milestone, transitionLogId: "" } : milestone,
					)
				: state.milestones,
			workCheckpoints: Array.isArray(state.workCheckpoints)
				? state.workCheckpoints.map((checkpoint) =>
						isRecord(checkpoint) ? { ...checkpoint, transitionLogId: "" } : checkpoint,
					)
				: state.workCheckpoints,
			processIssues: Array.isArray(state.processIssues)
				? state.processIssues.map((issue) => (isRecord(issue) ? { ...issue, transitionLogId: "" } : issue))
				: state.processIssues,
			deliveryVerifications: Array.isArray(state.deliveryVerifications)
				? state.deliveryVerifications.map((verification) =>
						isRecord(verification) ? { ...verification, transitionLogId: "" } : verification,
					)
				: state.deliveryVerifications,
		} as unknown as AnsteelTeamState;
		initializeAnsteelStateTransitionBaseline(migrated, "legacy-v11-migration-baseline", "MIGRATION-V12");
		state = migrated as unknown as Record<string, unknown>;
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
		type === "process-resolution-review" ||
		type === "action-assessed" ||
		type === "action-review" ||
		type === "runtime-recovery" ||
		type === "task-delivery-started" ||
		type === "task-delivery-check" ||
		type === "task-delivery-passed" ||
		type === "task-delivery-failed"
	);
}

function assertAnsteelTeamPublicEventEnvelope(event: AnsteelTeamEvent): void {
	if (event.schemaVersion !== 2) {
		throw new AnsteelTeamStateError("Ansteel team public collaboration events require schema version 2");
	}
	if (!isRecord(event.payload)) {
		throw new AnsteelTeamStateError("Ansteel team public collaboration events require a structured payload");
	}
	if (event.type === "runtime-recovery") {
		if (
			event.role !== "coordinator" ||
			event.reasonCode !== "process-orphaned" ||
			event.payload.kind !== "runtime-recovery" ||
			typeof event.payload.runId !== "string" ||
			!/^RUN-[0-9a-f-]{36}$/i.test(event.payload.runId) ||
			!Number.isSafeInteger(event.payload.abandonedSpanCount) ||
			event.payload.abandonedSpanCount < 1 ||
			typeof event.payload.recoveredAt !== "string" ||
			Number.isNaN(Date.parse(event.payload.recoveredAt))
		) {
			throw new AnsteelTeamStateError("Ansteel team runtime-recovery event has an invalid payload");
		}
		assertLedgerHash(event.payload.previousHeadHash, "runtime recovery previous head hash", true);
		assertLedgerHash(event.payload.recoveredHeadHash, "runtime recovery recovered head hash", false);
		return;
	}
	if (
		event.type === "task-delivery-started" ||
		event.type === "task-delivery-check" ||
		event.type === "task-delivery-passed" ||
		event.type === "task-delivery-failed"
	) {
		if (event.role !== "coordinator" || event.reasonCode !== undefined) {
			throw new AnsteelTeamStateError("Ansteel team delivery events require the coordinator actor");
		}
		if (event.type === "task-delivery-started") {
			if (
				event.payload.kind !== "task-delivery-started" ||
				!isRecord(event.payload.verification) ||
				event.payload.verification.status !== "verifying"
			) {
				throw new AnsteelTeamStateError("Ansteel team delivery-started event has an invalid payload");
			}
			return;
		}
		if (event.type === "task-delivery-check") {
			if (
				event.payload.kind !== "task-delivery-check" ||
				typeof event.payload.verificationId !== "string" ||
				!isRecord(event.payload.check)
			) {
				throw new AnsteelTeamStateError("Ansteel team delivery-check event has an invalid payload");
			}
			return;
		}
		if (
			event.payload.kind !== "task-delivery-finished" ||
			typeof event.payload.verificationId !== "string" ||
			(event.payload.status !== "passed" && event.payload.status !== "failed") ||
			(event.type === "task-delivery-passed") !== (event.payload.status === "passed")
		) {
			throw new AnsteelTeamStateError("Ansteel team delivery terminal event has an invalid payload");
		}
		return;
	}
	if (event.role === "coordinator") {
		throw new AnsteelTeamStateError("Ansteel team public collaboration events require a role actor");
	}
	if (event.reasonCode !== undefined) {
		throw new AnsteelTeamStateError("Ansteel team public collaboration events cannot claim a runtime reason code");
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
	if (event.type === "action-assessed") {
		if (
			event.payload.kind !== "action-assessed" ||
			!isRecord(event.payload.assessment) ||
			event.payload.assessment.checkpointId !== event.checkpointId
		) {
			throw new AnsteelTeamStateError("Ansteel team action-assessed event identity does not match its payload");
		}
		return;
	}
	if (event.type === "action-review") {
		assertCheckpointId(event.checkpointId);
		if (
			event.payload.kind !== "action-review" ||
			!isRecord(event.payload.review) ||
			event.payload.review.checkpointId !== event.checkpointId ||
			event.payload.review.reviewer !== event.role
		) {
			throw new AnsteelTeamStateError("Ansteel team action-review event identity does not match its payload");
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

function assertAnsteelGitObjectId(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || !/^[0-9a-f]{40,64}$/i.test(value)) {
		throw new AnsteelTeamStateError(`Ansteel team anchor ${field} must be a Git object ID`);
	}
}

function parseAnsteelTeamExternalAnchor(value: unknown): AnsteelTeamExternalAnchor {
	if (!isRecord(value) || value.schemaVersion !== 3) {
		throw new AnsteelTeamStateError("Ansteel team anchor receipt has an invalid schema version");
	}
	if (typeof value.teamId !== "string" || value.teamId.trim().length === 0 || value.teamId.length > 256) {
		throw new AnsteelTeamStateError("Ansteel team anchor receipt has an invalid team ID");
	}
	const teamId = value.teamId;
	if (!isRecord(value.target)) throw new AnsteelTeamStateError("Ansteel team anchor receipt has an invalid target");
	const target = value.target;
	if (target.kind !== "task" && target.kind !== "milestone") {
		throw new AnsteelTeamStateError("Ansteel team anchor receipt has an invalid target kind");
	}
	if (target.kind === "task") assertTaskId(target.id);
	else assertMilestoneId(target.id);
	if (typeof target.revision !== "number" || !Number.isSafeInteger(target.revision) || target.revision < 1) {
		throw new AnsteelTeamStateError("Ansteel team anchor receipt has an invalid target revision");
	}
	const targetRevision = target.revision as number;
	if (!isRecord(value.eventRange))
		throw new AnsteelTeamStateError("Ansteel team anchor receipt has an invalid event range");
	const eventRange = value.eventRange;
	if (
		typeof eventRange.firstSequence !== "number" ||
		typeof eventRange.lastSequence !== "number" ||
		typeof eventRange.eventCount !== "number" ||
		!Number.isSafeInteger(eventRange.firstSequence) ||
		!Number.isSafeInteger(eventRange.lastSequence) ||
		!Number.isSafeInteger(eventRange.eventCount) ||
		eventRange.firstSequence < 1 ||
		eventRange.lastSequence < eventRange.firstSequence ||
		eventRange.eventCount !== eventRange.lastSequence - eventRange.firstSequence + 1
	) {
		throw new AnsteelTeamStateError("Ansteel team anchor receipt has an invalid event range");
	}
	const firstSequence = eventRange.firstSequence as number;
	const lastSequence = eventRange.lastSequence as number;
	const eventCount = eventRange.eventCount as number;
	if (!isRecord(value.merkle) || value.merkle.algorithm !== "sha256-jcs-v1") {
		throw new AnsteelTeamStateError("Ansteel team anchor receipt has an invalid Merkle description");
	}
	if (!Number.isSafeInteger(value.merkle.leafCount) || value.merkle.leafCount !== eventRange.eventCount) {
		throw new AnsteelTeamStateError("Ansteel team anchor receipt Merkle leaf count does not match its event range");
	}
	const leafCount = value.merkle.leafCount as number;
	assertLedgerHash(value.merkle.root, "anchor Merkle root", false);
	assertLedgerHash(value.signingManifestHash, "anchor signing manifest hash", false);
	assertLedgerHash(value.runtimeLogIndexHash, "anchor runtime log index hash", false);
	assertLedgerHash(value.runtimeLogSnapshotHash, "anchor runtime snapshot hash", false);
	if (!isRecord(value.git)) throw new AnsteelTeamStateError("Ansteel team anchor receipt has invalid Git metadata");
	const git = value.git;
	assertAnsteelGitObjectId(git.commit, "commit");
	if (typeof git.branch !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(git.branch)) {
		throw new AnsteelTeamStateError("Ansteel team anchor receipt has an invalid Git branch");
	}
	if (typeof git.remote !== "string") {
		throw new AnsteelTeamStateError("Ansteel team anchor receipt has an invalid Git remote");
	}
	const remote = assertAnsteelAnchorRemote(git.remote);
	assertAnsteelAnchorRemoteEndpoint(git.remoteEndpoint);
	const remoteEndpoint = git.remoteEndpoint;
	if (
		typeof git.notesRef !== "string" ||
		git.notesRef !== `refs/notes/ansteel/${teamId}/${target.kind}/${target.id}/${targetRevision}`
	) {
		throw new AnsteelTeamStateError("Ansteel team anchor receipt has an invalid Git notes ref");
	}
	assertAnsteelGitObjectId(git.noteObject, "local notes ref");
	assertAnsteelGitObjectId(git.remoteRefObject, "remote notes ref");
	if (git.noteObject !== git.remoteRefObject) {
		throw new AnsteelTeamStateError("Ansteel team anchor receipt has mismatched local and remote note objects");
	}
	assertStateTimestamp(value.anchoredAt, "anchor observation time");
	assertLedgerHash(value.anchorHash, "anchor hash", false);
	const noteInput: Omit<AnsteelTeamAnchorNote, "anchorHash"> = {
		schemaVersion: 3,
		teamId,
		target: { kind: target.kind, id: target.id, revision: targetRevision },
		eventRange: {
			firstSequence,
			lastSequence,
			eventCount,
		},
		merkle: { algorithm: "sha256-jcs-v1", leafCount, root: value.merkle.root },
		signingManifestHash: value.signingManifestHash,
		runtimeLogIndexHash: value.runtimeLogIndexHash,
		runtimeLogSnapshotHash: value.runtimeLogSnapshotHash,
		git: { commit: git.commit, branch: git.branch, remote, remoteEndpoint, notesRef: git.notesRef },
	};
	if (hashAnsteelAuditValue(noteInput) !== value.anchorHash) {
		throw new AnsteelTeamStateError("Ansteel team anchor receipt hash does not match its structured fields");
	}
	return {
		...noteInput,
		anchorHash: value.anchorHash,
		anchoredAt: value.anchoredAt,
		git: { ...noteInput.git, noteObject: git.noteObject, remoteRefObject: git.remoteRefObject },
	};
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
		event.type !== "tasks-assigned" &&
		event.type !== "task-claimed" &&
		event.type !== "task-submitted" &&
		event.type !== "task-collaboration" &&
		event.type !== "task-collaboration-returned" &&
		event.type !== "task-final-verification-requested" &&
		event.type !== "task-review" &&
		event.type !== "task-delivery-started" &&
		event.type !== "task-delivery-check" &&
		event.type !== "task-delivery-passed" &&
		event.type !== "task-delivery-failed" &&
		event.type !== "milestone-planned" &&
		event.type !== "milestone-submitted" &&
		event.type !== "milestone-collaboration" &&
		event.type !== "milestone-final-verification-requested" &&
		event.type !== "milestone-review" &&
		event.type !== "work-checkpoint" &&
		event.type !== "process-issue" &&
		event.type !== "process-resolution" &&
		event.type !== "process-resolution-review" &&
		event.type !== "action-assessed" &&
		event.type !== "action-review" &&
		event.type !== "runtime-recovery" &&
		event.type !== "task-anchor" &&
		event.type !== "milestone-anchor"
	) {
		throw new AnsteelTeamStateError("Ansteel team event has an invalid type");
	}
	if (event.schemaVersion !== undefined && event.schemaVersion !== 1 && event.schemaVersion !== 2) {
		throw new AnsteelTeamStateError("Ansteel team event has an invalid schema version");
	}
	if (event.hashAlgorithm !== undefined && event.hashAlgorithm !== ANSTEEL_TEAM_EVENT_HASH_ALGORITHM) {
		throw new AnsteelTeamStateError("Ansteel team event has an invalid hash algorithm");
	}
	const isPublicCollaborationEvent = isAnsteelPublicCollaborationEventType(event.type);
	if (event.role === "coordinator") {
		if (
			event.type !== "task-assigned" &&
			event.type !== "tasks-assigned" &&
			event.type !== "task-collaboration-returned" &&
			event.type !== "task-final-verification-requested" &&
			event.type !== "task-delivery-started" &&
			event.type !== "task-delivery-check" &&
			event.type !== "task-delivery-passed" &&
			event.type !== "task-delivery-failed" &&
			event.type !== "milestone-final-verification-requested" &&
			event.type !== "runtime-recovery" &&
			event.type !== "task-anchor" &&
			event.type !== "milestone-anchor"
		) {
			throw new AnsteelTeamStateError(
				"Ansteel team coordinator can only record task assignment, final-verification, collaboration-return, delivery verification, runtime-recovery, task-anchor, or milestone-anchor events",
			);
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
	if (event.type === "tasks-assigned") {
		if (event.role !== "coordinator") {
			throw new AnsteelTeamStateError("Ansteel team tasks-assigned events require the coordinator actor");
		}
		if (event.targetRole !== undefined) {
			throw new AnsteelTeamStateError("Ansteel team tasks-assigned events cannot name one target role");
		}
	}
	if (isPublicCollaborationEvent) {
		assertAnsteelTeamPublicEventEnvelope(event);
	} else if (
		event.schemaVersion === 2 ||
		event.checkpointId !== undefined ||
		event.issueId !== undefined ||
		event.resolutionId !== undefined ||
		event.reasonCode !== undefined ||
		event.payload !== undefined
	) {
		throw new AnsteelTeamStateError("Ansteel team schema version 2 is reserved for public collaboration events");
	}
	const isAnchorEvent = event.type === "task-anchor" || event.type === "milestone-anchor";
	if (isAnchorEvent) {
		if (event.role !== "coordinator" || event.anchor === undefined) {
			throw new AnsteelTeamStateError("Ansteel team anchor events require a coordinator structured receipt");
		}
		const anchor = parseAnsteelTeamExternalAnchor(event.anchor);
		if (anchor.target.kind === "task" && event.type !== "task-anchor") {
			throw new AnsteelTeamStateError("Ansteel team task anchor receipt has the wrong event type");
		}
		if (anchor.target.kind === "milestone" && event.type !== "milestone-anchor") {
			throw new AnsteelTeamStateError("Ansteel team milestone anchor receipt has the wrong event type");
		}
	} else if (event.anchor !== undefined) {
		throw new AnsteelTeamStateError("Ansteel team only permits structured anchor data on anchor events");
	}
	return {
		...(event.hashAlgorithm === undefined ? {} : { hashAlgorithm: event.hashAlgorithm }),
		sequence: event.sequence,
		type: event.type,
		role: event.role,
		...(event.targetRole === undefined ? {} : { targetRole: event.targetRole }),
		...(event.challengeId === undefined ? {} : { challengeId: event.challengeId }),
		...(event.schemaVersion === undefined ? {} : { schemaVersion: event.schemaVersion }),
		...(event.checkpointId === undefined ? {} : { checkpointId: event.checkpointId }),
		...(event.issueId === undefined ? {} : { issueId: event.issueId }),
		...(event.resolutionId === undefined ? {} : { resolutionId: event.resolutionId }),
		...(event.reasonCode === undefined ? {} : { reasonCode: event.reasonCode }),
		...(event.payload === undefined ? {} : { payload: structuredClone(event.payload) }),
		...(event.anchor === undefined ? {} : { anchor: parseAnsteelTeamExternalAnchor(event.anchor) }),
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
	return {
		...fields,
		previousHash,
		hash,
		...(value.signature === undefined
			? {}
			: { signature: structuredClone(value.signature) as AnsteelTeamEventSignature }),
	};
}

/**
 * Produces the exact signed-event representation supplied to the JCS library.
 * `hash` and `signature` are intentionally excluded: the hash identifies the
 * finalized event body and the signature authenticates that resulting hash.
 */
function getAnsteelTeamJcsEventHashInput(event: Omit<AnsteelTeamEvent, "hash" | "signature">): Record<string, unknown> {
	return {
		hashAlgorithm: ANSTEEL_TEAM_EVENT_HASH_ALGORITHM,
		sequence: event.sequence,
		type: event.type,
		role: event.role,
		...(event.targetRole === undefined ? {} : { targetRole: event.targetRole }),
		...(event.challengeId === undefined ? {} : { challengeId: event.challengeId }),
		...(event.schemaVersion === undefined ? {} : { schemaVersion: event.schemaVersion }),
		...(event.checkpointId === undefined ? {} : { checkpointId: event.checkpointId }),
		...(event.issueId === undefined ? {} : { issueId: event.issueId }),
		...(event.resolutionId === undefined ? {} : { resolutionId: event.resolutionId }),
		...(event.reasonCode === undefined ? {} : { reasonCode: event.reasonCode }),
		...(event.payload === undefined ? {} : { payload: event.payload }),
		...(event.anchor === undefined ? {} : { anchor: event.anchor }),
		content: event.content,
		createdAt: event.createdAt,
		previousHash: event.previousHash,
	};
}

function hashAnsteelTeamEvent(event: Omit<AnsteelTeamEvent, "hash">): string {
	if (event.hashAlgorithm === ANSTEEL_TEAM_EVENT_HASH_ALGORITHM) {
		return hashAnsteelAuditValue(getAnsteelTeamJcsEventHashInput(event));
	}
	if (event.hashAlgorithm !== undefined) {
		throw new AnsteelTeamStateError("Ansteel team event has an unsupported hash algorithm");
	}
	if (event.schemaVersion === 2 && event.type === "runtime-recovery") {
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
					reasonCode: event.reasonCode ?? null,
					payload: event.payload ?? null,
					content: event.content,
					createdAt: event.createdAt,
					previousHash: event.previousHash,
				}),
				"utf8",
			)
			.digest("hex");
	}
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

function assertAnsteelTeamAnchorEventRanges(events: readonly AnsteelTeamEvent[]): void {
	for (const event of events) {
		if (event.type !== "task-anchor" && event.type !== "milestone-anchor") continue;
		const anchor = event.anchor;
		if (!anchor) throw new AnsteelTeamStateError("Ansteel team anchor event is missing its structured receipt");
		if (
			anchor.eventRange.firstSequence !== 1 ||
			anchor.eventRange.lastSequence !== event.sequence - 1 ||
			anchor.eventRange.eventCount !== event.sequence - 1
		) {
			throw new AnsteelTeamStateError(
				"Ansteel team anchor receipt does not cover its immutable preceding event range",
			);
		}
		const coveredEvents = events.slice(anchor.eventRange.firstSequence - 1, anchor.eventRange.lastSequence);
		const merkle = createAnsteelTeamMerkleRoot(coveredEvents.map((covered) => covered.hash));
		if (merkle.root !== anchor.merkle.root || merkle.leafCount !== anchor.merkle.leafCount) {
			throw new AnsteelTeamStateError("Ansteel team anchor receipt Merkle root does not match its event range");
		}
	}
}

export function listAnsteelTeamEvents(cwd: string): AnsteelTeamEvent[] {
	const events = readAnsteelTeamEventLedger(cwd).map((event) => parseAnsteelTeamEvent(event));
	let previousHash: string | null = null;
	let sawJcsHash = false;
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
		if (events[index].hashAlgorithm === ANSTEEL_TEAM_EVENT_HASH_ALGORITHM) {
			sawJcsHash = true;
		} else if (sawJcsHash) {
			throw new AnsteelTeamStateError("Ansteel team event ledger has a legacy hash after the JCS cutover");
		}
		previousHash = events[index].hash;
	}
	// Legacy events remain readable, but the first signed event establishes an
	// irreversible cutover: every later event must verify under its own actor's
	// coordinator-held Ed25519 key.
	verifyAnsteelTeamAuditEventSignatures(cwd, events);
	assertAnsteelTeamAnchorEventRanges(events);
	return events;
}

function assertAnsteelTeamEventLedger(cwd: string, state: AnsteelTeamState): void {
	const events = listAnsteelTeamEvents(cwd);
	assertAnsteelTeamAuditManifestTeam(cwd, state.id);
	for (const event of events) {
		if (event.anchor !== undefined && event.anchor.teamId !== state.id) {
			throw new AnsteelTeamStateError("Ansteel team anchor receipt belongs to a different persisted team");
		}
	}
	const ledgerHeadHash = events.at(-1)?.hash ?? null;
	if (state.ledgerHeadHash !== ledgerHeadHash) {
		throw new AnsteelTeamStateError("Ansteel team ledger head hash does not match the event chain");
	}
	if (state.nextEventSequence !== events.length + 1) {
		throw new AnsteelTeamStateError("Ansteel team next event sequence does not match the event ledger");
	}
}

function applyAnsteelTeamEvent(
	state: AnsteelTeamState,
	event: AnsteelTeamEvent,
	options: { recordTransitions?: boolean } = {},
): void {
	const recordTransitions = options.recordTransitions !== false;
	const transition = (
		target: AnsteelMutableStateTarget,
		kind: AnsteelStateObjectKind,
		objectId: string,
		to: string,
		guard: string,
		suffix: string,
		from?: string | null,
	): void => {
		applyAnsteelStateTransition(state, target, kind, objectId, to, {
			guard,
			triggerEventId: event.hash,
			createdAt: event.createdAt,
			deterministicSeed: `${event.hash}\0${suffix}`,
			record: recordTransitions,
			...(from === undefined ? {} : { from }),
		});
	};
	if (event.type === "challenge") {
		if (state.openChallenges.some((challenge) => challenge.id === event.challengeId)) {
			throw new AnsteelTeamStateError(`Ansteel team challenge ${event.challengeId} already exists`);
		}
		const challenge: AnsteelTeamChallenge = {
			id: event.challengeId!,
			raisedBy: event.role as AnsteelRole,
			targetRole: event.targetRole!,
			status: "open",
			transitionLogId: "",
		};
		state.openChallenges.push(challenge);
		transition(challenge, "challenge", challenge.id, "open", "challenge-valid", `challenge\0${challenge.id}`, null);
	}
	if (event.type === "resolution") {
		const challenge = state.openChallenges.find((item) => item.id === event.challengeId && item.status === "open");
		if (!challenge) throw new AnsteelTeamStateError(`Ansteel team has no open challenge ${event.challengeId}`);
		if (challenge.targetRole !== event.role) {
			throw new AnsteelTeamStateError(
				`Ansteel team challenge ${event.challengeId} must be resolved by ${challenge.targetRole}`,
			);
		}
		transition(
			challenge,
			"challenge",
			challenge.id,
			"resolved",
			"challenge-resolution-authorized",
			`challenge\0${challenge.id}\0resolved`,
		);
	}
	if (event.schemaVersion !== 2 || event.payload === undefined) return;
	const payload = event.payload;
	if (payload.kind === "work-checkpoint") {
		const checkpoint = structuredClone(payload.checkpoint);
		checkpoint.transitionLogId = "";
		if (checkpoint.governedAction === undefined) {
			checkpoint.governedAction = null;
			checkpoint.status = "superseded";
		}
		if (checkpoint.supersedesCheckpointId !== undefined) {
			const superseded = state.workCheckpoints.find((item) => item.id === checkpoint.supersedesCheckpointId);
			if (!superseded) {
				throw new AnsteelTeamStateError(
					`Ansteel team checkpoint ${checkpoint.id} supersedes unknown checkpoint ${checkpoint.supersedesCheckpointId}`,
				);
			}
			transition(
				superseded,
				"checkpoint",
				superseded.id,
				"superseded",
				"checkpoint-supersession-valid",
				`checkpoint\0${superseded.id}\0superseded`,
			);
		}
		state.workCheckpoints.push(checkpoint);
		transition(
			checkpoint,
			"checkpoint",
			checkpoint.id,
			checkpoint.status,
			"checkpoint-publication-valid",
			`checkpoint\0${checkpoint.id}\0created`,
			null,
		);
		return;
	}
	if (payload.kind === "process-issue") {
		const issue = structuredClone(payload.issue);
		issue.transitionLogId = "";
		state.processIssues.push(issue);
		transition(issue, "process-issue", issue.id, issue.status, "process-issue-valid", `issue\0${issue.id}`, null);
		return;
	}
	if (payload.kind === "action-review") {
		state.actionReviews.push(structuredClone(payload.review));
		return;
	}
	if (payload.kind === "action-assessed") return;
	if (payload.kind === "runtime-recovery") return;
	if (payload.kind === "task-delivery-started") {
		const verification = structuredClone(payload.verification);
		verification.transitionLogId = "";
		state.deliveryVerifications.push(verification);
		transition(
			verification,
			"delivery-verification",
			verification.id,
			"verifying",
			"delivery-preflight-valid",
			`delivery\0${verification.id}\0verifying`,
			null,
		);
		return;
	}
	if (payload.kind === "task-delivery-check") {
		const verification = state.deliveryVerifications.find((item) => item.id === payload.verificationId);
		if (!verification || verification.status !== "verifying") {
			throw new AnsteelTeamStateError(`Ansteel team has no active delivery verification ${payload.verificationId}`);
		}
		if (verification.checks.some((check) => check.id === payload.check.id)) {
			throw new AnsteelTeamStateError(
				`Ansteel team delivery verification ${payload.verificationId} already recorded check ${payload.check.id}`,
			);
		}
		verification.checks.push(structuredClone(payload.check));
		return;
	}
	if (payload.kind === "task-delivery-finished") {
		const verification = state.deliveryVerifications.find((item) => item.id === payload.verificationId);
		if (!verification || verification.status !== "verifying") {
			throw new AnsteelTeamStateError(`Ansteel team has no active delivery verification ${payload.verificationId}`);
		}
		transition(
			verification,
			"delivery-verification",
			verification.id,
			payload.status,
			"delivery-checks-complete",
			`delivery\0${verification.id}\0${payload.status}`,
		);
		verification.completedAt = payload.completedAt;
		if (payload.failureReason !== undefined) verification.failureReason = payload.failureReason;
		const task = state.tasks.find((item) => item.id === verification.taskId);
		if (!task || verification.revision > task.revision) {
			throw new AnsteelTeamStateError(
				`Ansteel team delivery verification ${verification.id} no longer matches its task revision`,
			);
		}
		// 共享工作板重放从最新任务快照开始，而 delivery 事件会保留更早的所有 revision。
		// 历史终态回执继续可审计，但不能把当前任务或依赖关系回滚到已经过时的生命周期状态。
		if (verification.revision < task.revision) return;
		if (payload.status === "failed" && payload.failureReason !== "interrupted") {
			transition(
				task,
				"task",
				task.id,
				"revision-required",
				"delivery-verification-passed",
				`task\0${task.id}\0delivery-failed`,
			);
			task.testEvidence = [];
		}
		reconcileAnsteelTeamTaskDependencies(state, { event, recordTransitions });
		return;
	}
	const issue = state.processIssues.find((item) => item.id === payload.issueId);
	if (!issue) {
		throw new AnsteelTeamStateError(`Ansteel team has no process issue ${payload.issueId}`);
	}
	if (payload.kind === "process-resolution") {
		issue.resolutions.push(structuredClone(payload.resolution));
		const to = payload.resolution.outcome === "SCOPE_ESCALATION" ? "escalated" : "resolution-proposed";
		transition(issue, "process-issue", issue.id, to, "process-resolution-valid", `issue\0${issue.id}\0${to}`);
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
		transition(
			issue,
			"process-issue",
			issue.id,
			"open",
			"process-resolution-review-valid",
			`issue\0${issue.id}\0open`,
		);
	} else if (resolution.outcome === "SCOPE_ESCALATION") {
		transition(
			issue,
			"process-issue",
			issue.id,
			"escalated",
			"process-resolution-review-valid",
			`issue\0${issue.id}\0escalated`,
		);
	} else {
		transition(
			issue,
			"process-issue",
			issue.id,
			"closed",
			"process-resolution-review-valid",
			`issue\0${issue.id}\0closed`,
		);
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
	// Public collaboration events are durable and rendered to every role. Apply
	// one recursive redaction boundary before hashing, replaying, or persisting
	// any model/provider-authored payload so no caller can bypass sanitization.
	const redactedCandidate = redactAnsteelSensitiveValue(input) as AnsteelTeamEventInput & { signature?: unknown };
	// A caller can never supply a signature. The coordinator creates it only
	// after the immutable event hash and sequence have been assigned.
	const { signature: _untrustedSignature, ...redactedInput } = redactedCandidate;
	const unsignedEvent = {
		...redactedInput,
		hashAlgorithm: ANSTEEL_TEAM_EVENT_HASH_ALGORITHM,
		sequence: state.nextEventSequence,
		createdAt: new Date().toISOString(),
		previousHash: state.ledgerHeadHash,
	};
	const hash = hashAnsteelTeamEvent(unsignedEvent);
	const signature = signAnsteelTeamAuditEvent(cwd, state.id, {
		sequence: unsignedEvent.sequence,
		role: unsignedEvent.role,
		hash,
	});
	const event = parseAnsteelTeamEvent({
		...unsignedEvent,
		hash,
		signature,
	});
	// Validate the new receipt against the exact pre-append range before any
	// pending transaction or durable line is written. This gives anchor events
	// the same fail-closed persistence boundary as their signatures.
	if (event.anchor !== undefined) {
		assertAnsteelTeamAnchorEventRanges([...listAnsteelTeamEvents(cwd), event]);
	}
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
	const nextAction = structuredClone(input.nextAction);
	if (nextAction.kind === "edit" || nextAction.kind === "write") {
		nextAction.target = normalizeTaskFilePath(cwd, nextAction.target);
	}
	const computedRisk = classifyCheckpointActionRisk(cwd, nextAction);
	// risk 可由协调器按动作类型机械推导（只升不降）；模型省略时使用计算风险。
	const effectiveRisk = input.risk === undefined ? computedRisk : maxAnsteelActionRisk(computedRisk, input.risk);
	const checkpoint: AnsteelWorkCheckpoint = {
		...structuredClone(input),
		nextAction,
		risk: effectiveRisk,
		governedAction: {
			kind: nextAction.kind,
			target: nextAction.target,
			version: getCheckpointActionVersion(cwd, state, input.id, input.taskId, nextAction),
			computedRisk,
			effectiveRisk,
		},
		actor,
		status: "active",
		transitionLogId: "",
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

export function reviewAnsteelTeamAction(
	cwd: string,
	state: AnsteelTeamState,
	reviewer: AnsteelRole,
	input: AnsteelActionReviewInput,
	persistence?: AnsteelTeamPersistenceContext,
): AnsteelActionReview {
	assertRole(reviewer, "action reviewer");
	const checkpoint = state.workCheckpoints.find((item) => item.id === input.checkpointId);
	if (!checkpoint) {
		throw new AnsteelTeamStateError(`Ansteel team action review references unknown checkpoint ${input.checkpointId}`);
	}
	if (checkpoint.status !== "active" || checkpoint.governedAction === null) {
		throw new AnsteelTeamStateError(`Ansteel team checkpoint ${checkpoint.id} is not active for action review`);
	}
	if (checkpoint.actor === reviewer) {
		throw new AnsteelTeamStateError(`Ansteel team checkpoint ${checkpoint.id} actor cannot review its own action`);
	}
	if (
		input.action.kind !== checkpoint.governedAction.kind ||
		input.action.target !== checkpoint.governedAction.target ||
		input.action.version !== checkpoint.governedAction.version
	) {
		throw new AnsteelTeamStateError(
			`Ansteel team action review for ${checkpoint.id} does not match its governed action`,
		);
	}
	if (state.actionReviews.some((review) => review.checkpointId === checkpoint.id && review.reviewer === reviewer)) {
		throw new AnsteelTeamStateError(`Ansteel team ${reviewer} already reviewed checkpoint ${checkpoint.id}`);
	}
	if (typeof input.reason !== "string" || input.reason.trim().length === 0) {
		throw new AnsteelTeamStateError("Ansteel team action review requires a reason");
	}
	const review: AnsteelActionReview = {
		checkpointId: checkpoint.id,
		reviewer,
		action: structuredClone(input.action),
		verdict: input.verdict,
		reason: input.reason.trim(),
		reviewedAt: new Date().toISOString(),
	};
	appendAnsteelTeamEvent(
		cwd,
		state,
		{
			schemaVersion: 2,
			type: "action-review",
			role: reviewer,
			checkpointId: checkpoint.id,
			content: `Reviewed governed action for ${checkpoint.id}: ${review.verdict}`,
			payload: { kind: "action-review", review },
		},
		persistence,
	);
	return state.actionReviews.find((item) => item.checkpointId === checkpoint.id && item.reviewer === reviewer)!;
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
		transitionLogId: "",
		resolutions: [],
		createdAt: new Date().toISOString(),
	};
	const targetTask =
		checkpoint.taskId === undefined ? undefined : state.tasks.find((task) => task.id === checkpoint.taskId);
	if (
		targetTask?.status === "final-verification" &&
		(issue.severity === "blocking" || issue.severity === "critical")
	) {
		throw new AnsteelTeamStateError(
			`Ansteel team task ${targetTask.id} is in final verification; use ansteel_review_task to reject its immutable evidence package`,
		);
	}
	if (targetTask?.status === "submitted" && (issue.severity === "blocking" || issue.severity === "critical")) {
		// A structured blocking challenge is continuous collaboration, not a final
		// review. It revokes the frozen work package before final verification.
		applyAnsteelStateTransition(state, targetTask, "task", targetTask.id, "revision-required", {
			guard: "no-open-blocking-process-issue",
			causeEventId: issue.id,
		});
		targetTask.testEvidence = [];
		reconcileAnsteelTeamTaskDependencies(state);
	}
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

function throwAnsteelStateProjectionMismatch(detail: string): never {
	throw new AnsteelTeamStateError(`state-projection-mismatch: ${detail}`);
}

function hasCompletedTaskCollaboration(task: AnsteelTeamTask): boolean {
	if (task.revision < 1 || !task.submissions.some((submission) => submission.revision === task.revision)) return false;
	return ANSTEEL_ROLES.filter((role) => role !== task.owner).every((collaborator) =>
		task.collaborationUpdates.some(
			(update) => update.revision === task.revision && update.collaborator === collaborator,
		),
	);
}

function hasCompletedMilestoneCollaboration(milestone: AnsteelTeamMilestone): boolean {
	if (
		milestone.revision < 1 ||
		!milestone.submissions.some((submission) => submission.revision === milestone.revision)
	) {
		return false;
	}
	return (["staff-engineer", "qa-engineer"] as const).every((collaborator) =>
		milestone.collaborationUpdates.some(
			(update) => update.revision === milestone.revision && update.collaborator === collaborator,
		),
	);
}

function hasRejectedTaskFinalVerification(task: AnsteelTeamTask): boolean {
	return task.reviews.some((review) => review.revision === task.revision && review.verdict === "reject");
}

function hasRejectedMilestoneFinalVerification(milestone: AnsteelTeamMilestone): boolean {
	return milestone.reviews.some((review) => review.revision === milestone.revision && review.verdict === "reject");
}

function getActiveNonGreenGovernedCheckpoints(state: AnsteelTeamState): AnsteelWorkCheckpoint[] {
	return state.workCheckpoints.filter((checkpoint) => {
		if (
			checkpoint.status !== "active" ||
			checkpoint.governedAction === null ||
			checkpoint.governedAction.effectiveRisk === "green"
		) {
			return false;
		}
		// 协调器创建带 revision 的工作前，真实的无作用域决策仍应显示为待治理。任务一旦存在，
		// 不绑定 task 的 checkpoint 只能作为公共上下文：既不能授权任务动作，也不能让已交付
		// revision 永久停留在 pending。
		if (checkpoint.taskId === undefined) return state.tasks.length === 0 && state.milestones.length === 0;
		const task = state.tasks.find((item) => item.id === checkpoint.taskId);
		return task !== undefined && checkpoint.governedAction.version.startsWith(`${task.id}@${task.revision};`);
	});
}

function getCheckpointActionReviews(state: AnsteelTeamState, checkpoint: AnsteelWorkCheckpoint): AnsteelActionReview[] {
	if (checkpoint.governedAction === null) return [];
	return state.actionReviews.filter(
		(review) =>
			review.checkpointId === checkpoint.id &&
			review.action.kind === checkpoint.governedAction!.kind &&
			review.action.target === checkpoint.governedAction!.target &&
			review.action.version === checkpoint.governedAction!.version,
	);
}

function getRecordedAnsteelDeliveryStatus(state: AnsteelTeamState): AnsteelDeliveryStatus {
	const taskStatuses = state.tasks.map((task) => getAnsteelTeamTaskDeliveryStatus(state, task));
	if (taskStatuses.includes("verifying")) return "verifying";
	if (taskStatuses.includes("failed")) return "failed";
	if (
		state.tasks.length > 0 &&
		state.tasks.every((task) => isAnsteelTeamTaskDelivered(state, task)) &&
		state.milestones.every((milestone) => milestone.status === "approved")
	) {
		return "passed";
	}
	return "not-started";
}

/**
 * Computes the protocol's three independent axes from persisted facts only.
 * In particular, delivery remains `not-started` until a later trusted delivery
 * evidence mechanism exists; approval, action confirmation, and prose cannot
 * manufacture a delivery result here.
 */
export function getAnsteelTeamStatusAxes(state: AnsteelTeamState): AnsteelTeamStatusAxes {
	assertState(state);
	const openIssues = state.processIssues.filter((issue) => issue.status !== "closed");
	const blockingIssues = openIssues.filter((issue) => issue.severity === "blocking" || issue.severity === "critical");
	const escalatedIssues = openIssues.filter((issue) => issue.status === "escalated");
	const failedRoles = ANSTEEL_ROLES.filter((role) => state.roles[role].status === "failed");
	const tasksInFinalVerificationWithCollaboration = state.tasks.filter(
		(task) => task.status === "final-verification" && hasCompletedTaskCollaboration(task),
	);
	const milestonesInFinalVerificationWithCollaboration = state.milestones.filter(
		(milestone) => milestone.status === "final-verification" && hasCompletedMilestoneCollaboration(milestone),
	);
	const completedOrFinalItemsMissingCollaboration = [
		...state.tasks
			.filter(
				(task) =>
					(task.status === "approved" || task.status === "final-verification") &&
					!hasCompletedTaskCollaboration(task),
			)
			.map((task) => `task ${task.id}`),
		...state.milestones
			.filter(
				(milestone) =>
					(milestone.status === "approved" || milestone.status === "final-verification") &&
					!hasCompletedMilestoneCollaboration(milestone),
			)
			.map((milestone) => `milestone ${milestone.id}`),
	];
	const finalVerificationRejected =
		state.tasks.some(hasRejectedTaskFinalVerification) ||
		state.milestones.some(hasRejectedMilestoneFinalVerification);
	const hasWork = state.tasks.length > 0 || state.milestones.length > 0;
	const collaborationComplete =
		hasWork &&
		state.openChallenges.every((challenge) => challenge.status === "resolved") &&
		openIssues.length === 0 &&
		state.tasks.every((task) => task.status === "approved" && hasCompletedTaskCollaboration(task)) &&
		state.milestones.every(
			(milestone) => milestone.status === "approved" && hasCompletedMilestoneCollaboration(milestone),
		);
	const collaborationReasons: string[] = [];
	let collaborationStatus: AnsteelCollaborationStatus;
	// Safety and dispute facts take precedence over ordinary lifecycle phases. A
	// stopped team, failed role, escalated issue, open challenge, or current
	// final-review rejection must never be hidden by a later-looking status.
	if (state.status === "stopped") {
		collaborationStatus = "blocked";
		collaborationReasons.push("team is stopped");
	} else if (failedRoles.length > 0) {
		collaborationStatus = "blocked";
		collaborationReasons.push(`failed role sessions: ${failedRoles.join(", ")}`);
	} else if (escalatedIssues.length > 0) {
		collaborationStatus = "blocked";
		collaborationReasons.push(`escalated process issues: ${escalatedIssues.map((issue) => issue.id).join(", ")}`);
	} else if (
		blockingIssues.length > 0 ||
		state.openChallenges.some((challenge) => challenge.status === "open") ||
		finalVerificationRejected
	) {
		collaborationStatus = "disputed";
		if (blockingIssues.length > 0) {
			collaborationReasons.push(
				`open blocking process issues: ${blockingIssues.map((issue) => issue.id).join(", ")}`,
			);
		}
		const openChallenges = state.openChallenges.filter((challenge) => challenge.status === "open");
		if (openChallenges.length > 0) {
			collaborationReasons.push(
				`open role challenges: ${openChallenges.map((challenge) => challenge.id).join(", ")}`,
			);
		}
		if (finalVerificationRejected) {
			collaborationReasons.push("a current final verification recorded REJECT and requires a new revision");
		}
	} else if (openIssues.some((issue) => issue.status === "resolution-proposed")) {
		collaborationStatus = "resolving";
		collaborationReasons.push("a public process-resolution proposal awaits the issue author's review");
	} else if (completedOrFinalItemsMissingCollaboration.length > 0) {
		// v9 migration deliberately preserves final-review eligibility but supplies
		// no invented collaboration updates. Keep that legacy work active and name
		// the missing evidence instead of displaying a false ready/completed phase.
		collaborationStatus = "active";
		collaborationReasons.push(
			`current final or approved items lack continuous collaboration evidence: ${completedOrFinalItemsMissingCollaboration.join(", ")}`,
		);
	} else if (
		tasksInFinalVerificationWithCollaboration.length > 0 ||
		milestonesInFinalVerificationWithCollaboration.length > 0
	) {
		collaborationStatus = "ready-for-verification";
		collaborationReasons.push(
			"public collaboration is complete for at least one current revision; final verification is pending",
		);
	} else if (collaborationComplete) {
		collaborationStatus = "collaboration-complete";
		collaborationReasons.push(
			"every current task and milestone has required public collaboration evidence and final approval",
		);
	} else if (!hasWork && state.workCheckpoints.length === 0 && openIssues.length === 0) {
		collaborationStatus = "orienting";
		collaborationReasons.push("no governed task, milestone, checkpoint, or process issue exists yet");
	} else {
		collaborationStatus = "active";
		collaborationReasons.push("governed work remains active without an unresolved high-severity dispute");
	}

	const nonGreenCheckpoints = getActiveNonGreenGovernedCheckpoints(state);
	const actionReviewStates = nonGreenCheckpoints.map((checkpoint) => {
		const reviews = getCheckpointActionReviews(state, checkpoint);
		const requiredReviewers = ANSTEEL_ROLES.filter((role) => role !== checkpoint.actor);
		return {
			checkpoint,
			rejected: reviews.some((review) => review.verdict === "reject"),
			complete: requiredReviewers.every((role) =>
				reviews.some((review) => review.reviewer === role && review.verdict === "approve"),
			),
		};
	});
	// Non-green actions may be recorded for a scope decision or a standalone
	// operation, so their governance requirement is independent of task and
	// milestone ownership. Empty task arrays are deliberately approved only
	// after every currently active non-green action has its required peer review.
	const hasGovernanceRequirement = hasWork || actionReviewStates.length > 0;
	const allWorkApproved =
		state.tasks.every((task) => task.status === "approved") &&
		state.milestones.every((milestone) => milestone.status === "approved");
	const governanceReasons: string[] = [];
	let governanceStatus: AnsteelGovernanceStatus;
	if (finalVerificationRejected || actionReviewStates.some((entry) => entry.rejected)) {
		governanceStatus = "rejected";
		if (finalVerificationRejected) governanceReasons.push("a current final verification recorded REJECT");
		const rejectedActions = actionReviewStates.filter((entry) => entry.rejected).map((entry) => entry.checkpoint.id);
		if (rejectedActions.length > 0)
			governanceReasons.push(`rejected governed actions: ${rejectedActions.join(", ")}`);
	} else if (!hasGovernanceRequirement) {
		governanceStatus = "not-required";
		governanceReasons.push("no task, milestone, or active non-green action currently requires governance");
	} else if (allWorkApproved && actionReviewStates.every((entry) => entry.complete)) {
		governanceStatus = "approved";
		governanceReasons.push(
			"all current task and milestone final approvals and active non-green action confirmations are complete",
		);
	} else {
		governanceStatus = "pending";
		if (!allWorkApproved && hasWork)
			governanceReasons.push("at least one task or milestone has not received its final approval");
		const pendingActions = actionReviewStates.filter((entry) => !entry.complete).map((entry) => entry.checkpoint.id);
		if (pendingActions.length > 0)
			governanceReasons.push(`pending governed action confirmations: ${pendingActions.join(", ")}`);
	}

	const deliveryStatus = getRecordedAnsteelDeliveryStatus(state);
	const deliveryReasons =
		deliveryStatus === "passed"
			? ["every current task revision has trusted delivery evidence and every milestone is approved"]
			: deliveryStatus === "verifying"
				? ["a coordinator-owned delivery verification is running"]
				: deliveryStatus === "failed"
					? ["a current task revision has a failed trusted delivery verification"]
					: [
							"no trusted, replayable delivery-verification evidence set is complete; task, milestone, and action approval are not delivery evidence",
						];
	const workflowReasons: string[] = [];
	let workflowStatus: AnsteelWorkflowStatus;
	if (collaborationStatus === "blocked" || collaborationStatus === "disputed") {
		workflowStatus = "blocked";
		workflowReasons.push("collaboration is blocked or disputed by unresolved durable facts");
		if (governanceStatus === "rejected") {
			workflowReasons.push("governance also contains a durable rejection");
		}
	} else if (governanceStatus === "rejected") {
		// A non-green action can be rejected even when no task-level disagreement
		// exists. That durable governance veto must block the workflow instead of
		// looking like ordinary work still in progress.
		workflowStatus = "blocked";
		workflowReasons.push("governance contains a durable rejection");
	} else if (
		collaborationStatus === "collaboration-complete" &&
		(governanceStatus === "approved" || governanceStatus === "not-required") &&
		deliveryStatus === "passed"
	) {
		workflowStatus = "completed";
		workflowReasons.push("collaboration, governance, and trusted delivery verification are complete");
	} else {
		workflowStatus = "in-progress";
		if (collaborationStatus !== "collaboration-complete") workflowReasons.push("collaboration is not complete");
		if (governanceStatus !== "approved" && governanceStatus !== "not-required")
			workflowReasons.push("governance is not complete");
		workflowReasons.push(
			deliveryStatus === "failed"
				? "delivery verification failed"
				: deliveryStatus === "verifying"
					? "delivery verification is still running"
					: "delivery verification has not started",
		);
	}

	return {
		collaborationStatus,
		governanceStatus,
		deliveryStatus,
		workflowStatus,
		reasons: {
			collaboration: collaborationReasons,
			governance: governanceReasons,
			delivery: deliveryReasons,
			workflow: workflowReasons,
		},
	};
}

export function getAnsteelTeamSharedBoard(
	state: AnsteelTeamState,
	events: readonly AnsteelTeamEvent[],
	runtimeEntries: readonly AnsteelRuntimeLogEntry[] = [],
): AnsteelTeamSharedBoard {
	let parsedEvents: AnsteelTeamEvent[];
	try {
		assertState(state);
		parsedEvents = events.map((event) => parseAnsteelTeamEvent(event));
		let previousHash: string | null = null;
		for (let index = 0; index < parsedEvents.length; index++) {
			const event = parsedEvents[index];
			if (event.sequence !== index + 1) {
				throw new AnsteelTeamStateError("event sequence is not contiguous");
			}
			if (event.previousHash !== previousHash) {
				throw new AnsteelTeamStateError("event previous hash is invalid");
			}
			if (event.hash !== hashAnsteelTeamEvent(event)) {
				throw new AnsteelTeamStateError("event hash does not match its content");
			}
			previousHash = event.hash;
		}
		if (state.ledgerHeadHash !== previousHash || state.nextEventSequence !== parsedEvents.length + 1) {
			throw new AnsteelTeamStateError("state ledger cursor does not match the supplied events");
		}
	} catch (error) {
		throwAnsteelStateProjectionMismatch(error instanceof Error ? error.message : String(error));
	}

	const replayedState = structuredClone(state);
	replayedState.workCheckpoints = [];
	replayedState.processIssues = [];
	replayedState.actionReviews = [];
	// Delivery evidence is itself projected from signed v2 events. Starting
	// from the persisted array would apply every receipt twice and make a valid
	// second verification fail as a false state-projection mismatch.
	replayedState.deliveryVerifications = [];
	try {
		for (const event of parsedEvents) {
			if (event.schemaVersion === 2 && isAnsteelPublicCollaborationEventType(event.type)) {
				applyAnsteelTeamEvent(replayedState, event, { recordTransitions: false });
			}
		}
		assertAnsteelPublicCollaborationState(replayedState, { validateTransitionProjection: false });
	} catch (error) {
		throwAnsteelStateProjectionMismatch(error instanceof Error ? error.message : String(error));
	}
	if (
		!isDeepStrictEqual(replayedState.workCheckpoints, state.workCheckpoints) ||
		!isDeepStrictEqual(replayedState.processIssues, state.processIssues) ||
		!isDeepStrictEqual(replayedState.actionReviews, state.actionReviews) ||
		!isDeepStrictEqual(replayedState.deliveryVerifications, state.deliveryVerifications)
	) {
		throwAnsteelStateProjectionMismatch("persisted collaboration or delivery state does not match event replay");
	}

	const activeCheckpoints = state.workCheckpoints.filter((checkpoint) => checkpoint.status === "active");
	const openProcessIssues = state.processIssues.filter((issue) => issue.status !== "closed");
	const roles = Object.fromEntries(
		ANSTEEL_ROLES.map((role) => {
			const activeCheckpoint = [...activeCheckpoints].reverse().find((checkpoint) => checkpoint.actor === role);
			return [
				role,
				{
					status: state.roles[role].status,
					...(activeCheckpoint === undefined ? {} : { activeCheckpointId: activeCheckpoint.id }),
					openIssueIds: openProcessIssues.filter((issue) => issue.targetRole === role).map((issue) => issue.id),
				},
			];
		}),
	) as AnsteelTeamSharedBoard["roles"];
	const recentToolFacts = runtimeEntries
		.filter((entry) => entry.toolCallId !== undefined || entry.eventName.startsWith("tool."))
		.slice(-10)
		.map((entry) => ({
			sequence: entry.sequence,
			eventName: entry.eventName,
			outcome: entry.outcome,
			...(entry.reasonCode === undefined ? {} : { reasonCode: entry.reasonCode }),
		}));

	return {
		teamId: state.id,
		currentGoal: state.topic,
		teamStatus: state.status,
		axes: getAnsteelTeamStatusAxes(state),
		roles,
		tasks: state.tasks.map((task) => ({
			id: task.id,
			owner: task.owner,
			type: task.type,
			...(task.assignmentReason === undefined ? {} : { assignmentReason: task.assignmentReason }),
			status: task.status,
			deliveryStatus: getAnsteelTeamTaskDeliveryStatus(state, task),
			dependsOn: [...task.dependsOn],
		})),
		activeCheckpoints: structuredClone(activeCheckpoints),
		openProcessIssues: structuredClone(openProcessIssues),
		recentToolFacts,
		counts: {
			activeCheckpoints: activeCheckpoints.length,
			openProcessIssues: openProcessIssues.length,
			blockingProcessIssues: openProcessIssues.filter(
				(issue) => issue.severity === "blocking" || issue.severity === "critical",
			).length,
			escalatedProcessIssues: openProcessIssues.filter((issue) => issue.status === "escalated").length,
		},
	};
}
