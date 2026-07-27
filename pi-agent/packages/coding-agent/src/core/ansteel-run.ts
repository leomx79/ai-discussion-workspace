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

const ANSTEEL_RUN_CHECKPOINT_VERSION = 3;

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
	return typeof action.role === "string" && typeof action.stage === "string";
}

function isWorkflowState(value: unknown): value is AnsteelRunWorkflowState {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const state = value as Partial<AnsteelRunWorkflowState>;
	return (
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
		transcript: state?.transcript.map((entry) => ({ ...entry })) ?? [],
		stageAudits: state?.stageAudits.map((audit) => ({ ...audit, events: audit.events.map((event) => ({ ...event })) })) ?? [],
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
	const now = options.now ?? new Date();
	const state: AnsteelRunCheckpointState = {
		...checkpoint.state,
		...(options.status === undefined ? {} : { status: options.status }),
		...(options.epoch === undefined ? {} : { epoch: options.epoch }),
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
