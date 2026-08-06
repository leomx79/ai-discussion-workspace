import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	AnsteelAdaptiveBudgetEvent,
	AnsteelBudgetLedgerEntry,
	AnsteelChallengeLedgerEntry,
	AnsteelDiscussionStage,
	AnsteelProviderFallbackEvent,
	AnsteelRevisionRound,
	AnsteelRole,
	AnsteelStageAudit,
	AnsteelTranscriptEntry,
} from "./ansteel-discussion.ts";

const ANSTEEL_RUN_CHECKPOINT_VERSION = 5;

export type AnsteelRunCheckpointStatus =
	| "ready-to-resume"
	| "waiting-provider"
	| "blocked"
	| "expired"
	| "completed"
	| "failed";

export interface AnsteelNextAction {
	role: AnsteelRole;
	stage: AnsteelDiscussionStage;
	round?: number;
	formatRepair?: true;
}

export interface AnsteelRunCheckpointEvent {
	type: "stage" | "provider-fallback" | "completed" | "failed";
	createdAt: string;
	role?: AnsteelRole;
	stage?: string;
	detail?: string;
}

export interface AnsteelRunCheckpointState {
	version: number;
	id: string;
	topic: string;
	status: AnsteelRunCheckpointStatus;
	reviewRoot: string;
	evidencePackageHash: string;
	evidenceManifest?: AnsteelEvidenceManifest;
	configFingerprint: string;
	projectStartedAt: number;
	hardProjectDeadline: number;
	epochStartedAt: number;
	epoch: number;
	nextAction?: AnsteelNextAction;
	workflowState: AnsteelRunWorkflowState;
	createdAt: string;
	updatedAt: string;
	roleModels: Record<AnsteelRole, string>;
	events: AnsteelRunCheckpointEvent[];
}

/** The bounded file selection captured at epoch zero, excluding file content and provider data. */
export interface AnsteelEvidenceManifest {
	paths: string[];
	eligibleFileCount: number;
}

/** Serializable coordinator-owned state; it contains no provider payload, tool arguments, output, or credentials. */
export interface AnsteelRunWorkflowState {
	/** Durable project-wide tool consumption, updated before each tool execution. */
	projectToolCallsUsed: number;
	transcript: AnsteelTranscriptEntry[];
	stageAudits: AnsteelStageAudit[];
	budgetLedger: AnsteelBudgetLedgerEntry[];
	adaptiveBudgetEvents: AnsteelAdaptiveBudgetEvent[];
	challengeLedger: AnsteelChallengeLedgerEntry[];
	revisionRounds: AnsteelRevisionRound[];
	providerFallbacks: AnsteelProviderFallbackEvent[];
	immutableLedgerSummary?: string;
	consensus?: string;
}

export interface AnsteelRunCheckpoint {
	path: string;
	state: AnsteelRunCheckpointState;
}

export interface CreateAnsteelRunCheckpointOptions {
	cwd: string;
	topic: string;
	roleModels: Record<AnsteelRole, string>;
	reviewRoot: string;
	evidencePackageHash: string;
	evidenceManifest?: AnsteelEvidenceManifest;
	configFingerprint: string;
	projectStartedAt: number;
	hardProjectDeadline: number;
	nextAction: AnsteelNextAction;
	workflowState?: AnsteelRunWorkflowState;
	now?: Date;
}

export interface UpdateAnsteelRunCheckpointOptions {
	status?: AnsteelRunCheckpointStatus;
	event?: Omit<AnsteelRunCheckpointEvent, "createdAt">;
	epoch?: number;
	epochStartedAt?: number;
	nextAction?: AnsteelNextAction;
	workflowState?: AnsteelRunWorkflowState;
	now?: Date;
}

export interface AnsteelRunResumeIdentity {
	reviewRoot: string;
	evidencePackageHash: string;
	configFingerprint: string;
	roleModels: Record<AnsteelRole, string>;
}

function createRunId(now: Date): string {
	return `ansteel-run-${now.toISOString().replace(/[:.]/g, "-")}`;
}

function assertCheckpointState(value: unknown): asserts value is AnsteelRunCheckpointState {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Ansteel run checkpoint must be a JSON object");
	}
	const state = value as Partial<AnsteelRunCheckpointState>;
	if (state.version !== ANSTEEL_RUN_CHECKPOINT_VERSION) {
		throw new Error(`Unsupported Ansteel run checkpoint version: ${String(state.version)}`);
	}
	const epoch = typeof state.epoch === "number" && Number.isInteger(state.epoch) ? state.epoch : -1;
	if (
		typeof state.id !== "string" ||
		state.id.length === 0 ||
		typeof state.topic !== "string" ||
		state.topic.length === 0
	) {
		throw new Error("Ansteel run checkpoint requires an ID and topic");
	}
	if (
		state.status !== "ready-to-resume" &&
		state.status !== "waiting-provider" &&
		state.status !== "blocked" &&
		state.status !== "expired" &&
		state.status !== "completed" &&
		state.status !== "failed"
	) {
		throw new Error("Ansteel run checkpoint has an invalid status");
	}
	if (
		typeof state.reviewRoot !== "string" ||
		state.reviewRoot.length === 0 ||
		!isHash(state.evidencePackageHash) ||
		!isHash(state.configFingerprint) ||
		epoch < 0
	) {
		throw new Error("Ansteel run checkpoint has invalid immutable recovery metadata");
	}
	if (
		typeof state.projectStartedAt !== "number" ||
		!Number.isFinite(state.projectStartedAt) ||
		typeof state.hardProjectDeadline !== "number" ||
		!Number.isFinite(state.hardProjectDeadline) ||
		state.hardProjectDeadline < state.projectStartedAt
	) {
		throw new Error("Ansteel run checkpoint has an invalid project deadline");
	}
	if (
		typeof state.epochStartedAt !== "number" ||
		!Number.isFinite(state.epochStartedAt) ||
		state.epochStartedAt < state.projectStartedAt ||
		state.epochStartedAt > state.hardProjectDeadline
	) {
		throw new Error("Ansteel run checkpoint has an invalid epoch start time");
	}
	if (state.evidenceManifest !== undefined && !isEvidenceManifest(state.evidenceManifest)) {
		throw new Error("Ansteel run checkpoint has an invalid evidence manifest");
	}
	if (state.status === "ready-to-resume" || state.status === "waiting-provider" || state.status === "blocked") {
		if (!isNextAction(state.nextAction)) throw new Error("Ansteel resumable checkpoint requires a next action");
	}
	if (!state.roleModels || typeof state.roleModels !== "object" || !Array.isArray(state.events)) {
		throw new Error("Ansteel run checkpoint has invalid role models or events");
	}
	if (!isWorkflowState(state.workflowState)) throw new Error("Ansteel run checkpoint has invalid workflow state");
}

function isEvidenceManifest(value: unknown): value is AnsteelEvidenceManifest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const manifest = value as Partial<AnsteelEvidenceManifest>;
	return (
		Array.isArray(manifest.paths) &&
		manifest.paths.length <= 24 &&
		manifest.paths.every((path) => typeof path === "string") &&
		typeof manifest.eligibleFileCount === "number" &&
		Number.isInteger(manifest.eligibleFileCount) &&
		manifest.eligibleFileCount >= manifest.paths.length
	);
}

function isHash(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function isNextAction(value: unknown): value is AnsteelNextAction {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const action = value as Partial<AnsteelNextAction>;
	return (
		isAnsteelRoleStagePair(action.role, action.stage) &&
		(action.stage === "architecture" ||
			action.stage === "staff-critique" ||
			action.stage === "qa-critique" ||
			action.stage === "tech-lead-cross-examination" ||
			action.stage === "staff-cross-examination" ||
			action.stage === "qa-cross-examination" ||
			action.stage === "architecture-revision" ||
			action.stage === "staff-revision" ||
			action.stage === "qa-revision" ||
			action.stage === "tech-lead-verification" ||
			action.stage === "staff-verification" ||
			action.stage === "qa-verification" ||
			action.stage === "consensus" ||
			action.stage === "staff-sign-off" ||
			action.stage === "qa-sign-off") &&
		(action.round === undefined || (Number.isInteger(action.round) && action.round > 0)) &&
		(action.formatRepair === undefined || action.formatRepair === true)
	);
}

function isAnsteelRoleStagePair(role: unknown, stage: unknown): boolean {
	if (role === "tech-lead") {
		return (
			stage === "architecture" ||
			stage === "tech-lead-cross-examination" ||
			stage === "architecture-revision" ||
			stage === "tech-lead-verification" ||
			stage === "consensus"
		);
	}
	if (role === "staff-engineer") {
		return (
			stage === "staff-critique" ||
			stage === "staff-cross-examination" ||
			stage === "staff-revision" ||
			stage === "staff-verification" ||
			stage === "staff-sign-off"
		);
	}
	if (role === "qa-engineer") {
		return (
			stage === "qa-critique" ||
			stage === "qa-cross-examination" ||
			stage === "qa-revision" ||
			stage === "qa-verification" ||
			stage === "qa-sign-off"
		);
	}
	return false;
}

function isWorkflowState(value: unknown): value is AnsteelRunWorkflowState {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const state = value as Partial<AnsteelRunWorkflowState>;
	return (
		typeof state.projectToolCallsUsed === "number" &&
		Number.isInteger(state.projectToolCallsUsed) &&
		state.projectToolCallsUsed >= 0 &&
		Array.isArray(state.transcript) &&
		Array.isArray(state.stageAudits) &&
		Array.isArray(state.budgetLedger) &&
		Array.isArray(state.adaptiveBudgetEvents) &&
		Array.isArray(state.challengeLedger) &&
		Array.isArray(state.revisionRounds) &&
		Array.isArray(state.providerFallbacks)
	);
}

function cloneWorkflowState(state: AnsteelRunWorkflowState | undefined): AnsteelRunWorkflowState {
	return {
		projectToolCallsUsed: state?.projectToolCallsUsed ?? 0,
		transcript: state?.transcript.map((entry) => ({ ...entry })) ?? [],
		stageAudits:
			state?.stageAudits.map((audit) => ({ ...audit, events: audit.events.map((event) => ({ ...event })) })) ?? [],
		budgetLedger: state?.budgetLedger.map((entry) => ({ ...entry })) ?? [],
		adaptiveBudgetEvents: state?.adaptiveBudgetEvents.map((event) => ({ ...event })) ?? [],
		challengeLedger: state?.challengeLedger.map((entry) => ({ ...entry })) ?? [],
		revisionRounds: state?.revisionRounds.map((round) => ({ ...round })) ?? [],
		providerFallbacks: state?.providerFallbacks.map((event) => ({ ...event })) ?? [],
		...(state?.immutableLedgerSummary === undefined ? {} : { immutableLedgerSummary: state.immutableLedgerSummary }),
		...(state?.consensus === undefined ? {} : { consensus: state.consensus }),
	};
}

function writeCheckpoint(path: string, state: AnsteelRunCheckpointState): void {
	const temporaryPath = `${path}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(state, null, "\t")}\n`, "utf8");
	renameSync(temporaryPath, path);
}

export function getAnsteelRunDirectory(cwd: string): string {
	return join(cwd, ".pi", "ansteel-runs");
}

/** Resolves only a generated run ID, never an arbitrary checkpoint path. */
export function getAnsteelRunCheckpointPath(cwd: string, runId: string): string {
	if (!/^ansteel-run-[A-Za-z0-9-]+$/.test(runId)) {
		throw new Error("Ansteel resume requires a safe Ansteel run ID");
	}
	return join(getAnsteelRunDirectory(cwd), runId, "checkpoint.json");
}

/** Refuses resume if the durable coordinator state no longer represents this exact review boundary. */
export function validateAnsteelRunCheckpointForResume(
	state: AnsteelRunCheckpointState,
	expected: AnsteelRunResumeIdentity,
): void {
	if (state.status !== "ready-to-resume" && state.status !== "waiting-provider" && state.status !== "blocked") {
		throw new Error(`Ansteel run checkpoint is not resumable from status ${state.status}`);
	}
	if (state.reviewRoot !== expected.reviewRoot) throw new Error("Ansteel resume review root changed");
	if (state.evidencePackageHash !== expected.evidencePackageHash) {
		throw new Error("Ansteel resume evidence package changed");
	}
	if (state.configFingerprint !== expected.configFingerprint) throw new Error("Ansteel resume configuration changed");
	for (const role of ["tech-lead", "staff-engineer", "qa-engineer"] as const) {
		if (state.roleModels[role] !== expected.roleModels[role]) {
			throw new Error(`Ansteel resume role model changed: ${role}`);
		}
	}
	if (!isNextAction(state.nextAction)) throw new Error("Ansteel resumable checkpoint requires a next action");
}

export function createAnsteelRunCheckpoint(options: CreateAnsteelRunCheckpointOptions): AnsteelRunCheckpoint {
	const topic = options.topic.trim();
	if (topic.length === 0) throw new Error("Ansteel run checkpoint requires a topic");
	const now = options.now ?? new Date();
	const id = createRunId(now);
	const directory = join(getAnsteelRunDirectory(options.cwd), id);
	const path = join(directory, "checkpoint.json");
	if (existsSync(path)) throw new Error(`Ansteel run checkpoint already exists: ${id}`);
	mkdirSync(directory, { recursive: true });
	const state: AnsteelRunCheckpointState = {
		version: ANSTEEL_RUN_CHECKPOINT_VERSION,
		id,
		topic,
		status: "ready-to-resume",
		reviewRoot: options.reviewRoot,
		evidencePackageHash: options.evidencePackageHash,
		...(options.evidenceManifest === undefined
			? {}
			: {
					evidenceManifest: {
						paths: [...options.evidenceManifest.paths],
						eligibleFileCount: options.evidenceManifest.eligibleFileCount,
					},
				}),
		configFingerprint: options.configFingerprint,
		projectStartedAt: options.projectStartedAt,
		hardProjectDeadline: options.hardProjectDeadline,
		epochStartedAt: options.projectStartedAt,
		epoch: 0,
		nextAction: { ...options.nextAction },
		workflowState: cloneWorkflowState(options.workflowState),
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
		roleModels: { ...options.roleModels },
		events: [],
	};
	writeCheckpoint(path, state);
	return { path, state };
}

export function loadAnsteelRunCheckpoint(path: string): AnsteelRunCheckpointState {
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	assertCheckpointState(value);
	return value;
}

/** Appends redacted coordinator state and atomically replaces the current checkpoint file. */
export function updateAnsteelRunCheckpoint(
	checkpoint: AnsteelRunCheckpoint,
	options: UpdateAnsteelRunCheckpointOptions,
): AnsteelRunCheckpointState {
	if (options.nextAction !== undefined && !isNextAction(options.nextAction)) {
		throw new Error("Ansteel run checkpoint has an invalid next action");
	}
	if (
		options.status !== undefined &&
		!isAnsteelTerminalCheckpointStatus(checkpoint.state.status) &&
		!isAllowedAnsteelCheckpointTransition(checkpoint.state.status, options.status)
	) {
		throw new Error(`Ansteel run checkpoint cannot transition from ${checkpoint.state.status} to ${options.status}`);
	}
	if (
		options.status !== undefined &&
		isAnsteelTerminalCheckpointStatus(checkpoint.state.status) &&
		options.status !== checkpoint.state.status
	) {
		throw new Error(`Ansteel run checkpoint cannot transition from terminal status ${checkpoint.state.status}`);
	}
	if (
		isAnsteelTerminalCheckpointStatus(checkpoint.state.status) &&
		(options.event !== undefined ||
			options.epoch !== undefined ||
			options.epochStartedAt !== undefined ||
			options.nextAction !== undefined ||
			options.workflowState !== undefined)
	) {
		throw new Error("Ansteel terminal checkpoint cannot be modified");
	}
	const now = options.now ?? new Date();
	const state: AnsteelRunCheckpointState = {
		...checkpoint.state,
		...(options.status === undefined ? {} : { status: options.status }),
		...(options.epoch === undefined ? {} : { epoch: options.epoch }),
		...(options.epochStartedAt === undefined ? {} : { epochStartedAt: options.epochStartedAt }),
		...(options.nextAction === undefined ? {} : { nextAction: { ...options.nextAction } }),
		...(options.workflowState === undefined ? {} : { workflowState: cloneWorkflowState(options.workflowState) }),
		updatedAt: now.toISOString(),
		events:
			options.event === undefined
				? [...checkpoint.state.events]
				: [...checkpoint.state.events, { ...options.event, createdAt: now.toISOString() }],
	};
	writeCheckpoint(checkpoint.path, state);
	checkpoint.state = state;
	return state;
}

function isAnsteelTerminalCheckpointStatus(status: AnsteelRunCheckpointStatus): boolean {
	return status === "expired" || status === "completed" || status === "failed";
}

function isAllowedAnsteelCheckpointTransition(
	from: AnsteelRunCheckpointStatus,
	to: AnsteelRunCheckpointStatus,
): boolean {
	if (from === to) return true;
	if (from === "ready-to-resume")
		return to === "waiting-provider" || to === "blocked" || to === "expired" || to === "completed" || to === "failed";
	if (from === "waiting-provider")
		return to === "ready-to-resume" || to === "blocked" || to === "expired" || to === "failed";
	if (from === "blocked") return to === "ready-to-resume" || to === "expired" || to === "failed";
	return false;
}
