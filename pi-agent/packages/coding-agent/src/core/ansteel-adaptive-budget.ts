import type { AnsteelDiscussionStage, AnsteelRole } from "./ansteel-discussion.ts";

export interface AnsteelAdaptiveBudgetPolicyInput {
	enabled?: boolean;
	projectTimeoutMs?: number;
	maxProjectToolCalls?: number;
	timeExtensionMs?: number;
	toolExtensionCalls?: number;
	maxBlockedRequestsPerStage?: number;
	maxDuplicateRequestsPerStage?: number;
	protectedVerificationTimeMs?: number;
	protectedVerificationToolCalls?: number;
	epochTimeoutMs?: number;
}

export interface AnsteelAdaptiveBudgetPolicy {
	enabled: boolean;
	projectTimeoutMs: number;
	maxProjectToolCalls: number;
	timeExtensionMs: number;
	toolExtensionCalls: number;
	maxBlockedRequestsPerStage: number;
	maxDuplicateRequestsPerStage: number;
	protectedVerificationTimeMs: number;
	protectedVerificationToolCalls: number;
	epochTimeoutMs: number;
}

export type AnsteelAdaptiveBudgetAction =
	| "grant-time"
	| "grant-tools"
	| "deny-time"
	| "deny-tools"
	| "penalize-blocked"
	| "penalize-duplicate";

export interface AnsteelAdaptiveBudgetEvent {
	role: AnsteelRole;
	stage: AnsteelDiscussionStage;
	action: AnsteelAdaptiveBudgetAction;
	requested?: { timeMs?: number; toolCalls?: number };
	granted?: { timeMs?: number; toolCalls?: number };
	evidenceProgressCount: number;
	unresolvedChallengeCount: number;
	remainingProjectTimeMs: number;
	remainingProjectToolCalls: number;
	reason: string;
}

export interface AnsteelAdaptiveBudgetState {
	projectStartedAt: number;
	hardProjectDeadline: number;
	remainingProjectToolCalls: number;
	remainingProjectTimeMs: number;
	stage: AnsteelDiscussionStage;
	role: AnsteelRole;
	stageBaseTimeoutMs: number;
	stageGrantedTimeoutMs: number;
	stageHardTimeoutMs: number;
	stageBaseToolCalls: number;
	stageGrantedToolCalls: number;
	stageHardToolCalls: number;
	evidenceProgressCount: number;
	duplicateOperationCount: number;
	blockedRequestCount: number;
	unresolvedChallengeCount: number;
	requiredOutputPending: boolean;
	allocationEvents: AnsteelAdaptiveBudgetEvent[];
}

const MAX_POLICY_VALUE = 2_147_483_647;
const MANDATORY_VERIFICATION_GATE_COUNT = 5;
const MAXIMUM_MANDATORY_VERIFICATION_GATE_COUNT = MANDATORY_VERIFICATION_GATE_COUNT * 2;

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
	const resolved = value ?? fallback;
	if (!Number.isInteger(resolved) || resolved <= 0 || resolved > MAX_POLICY_VALUE) {
		throw new Error(`Ansteel adaptive budget ${name} must be a positive bounded integer`);
	}
	return resolved;
}

/** Parses only coordinator-controlled limits; role text cannot alter this policy. */
export function createAnsteelAdaptiveBudgetPolicy(
	input: AnsteelAdaptiveBudgetPolicyInput = {},
): AnsteelAdaptiveBudgetPolicy {
	if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
		throw new Error("Ansteel adaptive budget enabled must be a boolean");
	}
	const projectTimeoutMs = positiveInteger(input.projectTimeoutMs, 3_600_000, "projectTimeoutMs");
	const protectedVerificationTimeMs = positiveInteger(
		input.protectedVerificationTimeMs,
		360_000,
		"protectedVerificationTimeMs",
	);
	if (protectedVerificationTimeMs >= projectTimeoutMs) {
		throw new Error("Ansteel adaptive budget protectedVerificationTimeMs must be below projectTimeoutMs");
	}
	const maxProjectToolCalls = positiveInteger(input.maxProjectToolCalls, 96, "maxProjectToolCalls");
	const protectedVerificationToolCalls = positiveInteger(
		input.protectedVerificationToolCalls,
		24,
		"protectedVerificationToolCalls",
	);
	if (protectedVerificationToolCalls >= maxProjectToolCalls) {
		throw new Error("Ansteel adaptive budget protectedVerificationToolCalls must be below maxProjectToolCalls");
	}
	if (protectedVerificationToolCalls < MAXIMUM_MANDATORY_VERIFICATION_GATE_COUNT) {
		throw new Error(
			`Ansteel adaptive budget protectedVerificationToolCalls must reserve at least ${MAXIMUM_MANDATORY_VERIFICATION_GATE_COUNT} tool calls for mandatory verification and final sign-off`,
		);
	}
	return {
		enabled: input.enabled === true,
		projectTimeoutMs,
		maxProjectToolCalls,
		timeExtensionMs: positiveInteger(input.timeExtensionMs, 30_000, "timeExtensionMs"),
		toolExtensionCalls: positiveInteger(input.toolExtensionCalls, 4, "toolExtensionCalls"),
		maxBlockedRequestsPerStage: positiveInteger(input.maxBlockedRequestsPerStage, 2, "maxBlockedRequestsPerStage"),
		maxDuplicateRequestsPerStage: positiveInteger(input.maxDuplicateRequestsPerStage, 2, "maxDuplicateRequestsPerStage"),
		protectedVerificationTimeMs,
		protectedVerificationToolCalls,
		epochTimeoutMs: positiveInteger(input.epochTimeoutMs, 600_000, "epochTimeoutMs"),
	};
}

/** Creates the coordinator-owned state for one stage without consuming any shared resource. */
export function createAnsteelAdaptiveBudgetState(options: {
	policy: AnsteelAdaptiveBudgetPolicy;
	role: AnsteelRole;
	stage: AnsteelDiscussionStage;
	stageBaseTimeoutMs: number;
	stageHardTimeoutMs: number;
	stageBaseToolCalls: number;
	stageHardToolCalls: number;
	unresolvedChallengeCount: number;
	requiredOutputPending?: boolean;
	projectStartedAt?: number;
	hardProjectDeadline?: number;
	now?: number;
}): AnsteelAdaptiveBudgetState {
	const now = options.now ?? Date.now();
	const projectStartedAt = options.projectStartedAt ?? now;
	const hardProjectDeadline = options.hardProjectDeadline ?? projectStartedAt + options.policy.projectTimeoutMs;
	if (!Number.isFinite(projectStartedAt) || !Number.isFinite(hardProjectDeadline) || hardProjectDeadline < projectStartedAt) {
		throw new Error("Ansteel adaptive budget project deadline must be a finite time after project start");
	}
	return {
		projectStartedAt,
		hardProjectDeadline,
		remainingProjectToolCalls: options.policy.maxProjectToolCalls,
		remainingProjectTimeMs: Math.max(0, hardProjectDeadline - now),
		stage: options.stage,
		role: options.role,
		stageBaseTimeoutMs: options.stageBaseTimeoutMs,
		stageGrantedTimeoutMs: options.stageBaseTimeoutMs,
		stageHardTimeoutMs: options.stageHardTimeoutMs,
		stageBaseToolCalls: options.stageBaseToolCalls,
		stageGrantedToolCalls: options.stageBaseToolCalls,
		stageHardToolCalls: options.stageHardToolCalls,
		evidenceProgressCount: 0,
		duplicateOperationCount: 0,
		blockedRequestCount: 0,
		unresolvedChallengeCount: options.unresolvedChallengeCount,
		requiredOutputPending: options.requiredOutputPending ?? true,
		allocationEvents: [],
	};
}

/** Records coordinator-observed evidence state; model prose is never accepted as a progress signal. */
export function recordAnsteelAdaptiveEvidence(
	state: AnsteelAdaptiveBudgetState,
	kind: "new" | "duplicate" | "blocked",
): void {
	if (kind === "new") state.evidenceProgressCount++;
	if (kind === "duplicate") state.duplicateOperationCount++;
	if (kind === "blocked") state.blockedRequestCount++;
}

function appendAllocationEvent(
	state: AnsteelAdaptiveBudgetState,
	event: AnsteelAdaptiveBudgetEvent,
): AnsteelAdaptiveBudgetEvent {
	state.allocationEvents.push(event);
	return event;
}

/** Makes one deterministic extension decision without changing any hard ceiling. */
export function decideAnsteelAdaptiveAllocation(options: {
	state: AnsteelAdaptiveBudgetState;
	policy: AnsteelAdaptiveBudgetPolicy;
	kind: "time" | "tools";
	now?: number;
}): AnsteelAdaptiveBudgetEvent {
	const { state, policy, kind } = options;
	state.remainingProjectTimeMs = Math.max(0, state.hardProjectDeadline - (options.now ?? Date.now()));
	const requested = kind === "time" ? { timeMs: policy.timeExtensionMs } : { toolCalls: policy.toolExtensionCalls };
	const deny = (reason: string): AnsteelAdaptiveBudgetEvent =>
		appendAllocationEvent(state, {
			role: state.role,
			stage: state.stage,
			action: kind === "time" ? "deny-time" : "deny-tools",
			requested,
			evidenceProgressCount: state.evidenceProgressCount,
			unresolvedChallengeCount: state.unresolvedChallengeCount,
			remainingProjectTimeMs: state.remainingProjectTimeMs,
			remainingProjectToolCalls: state.remainingProjectToolCalls,
			reason,
		});

	if (!policy.enabled) return deny("Adaptive budget policy is disabled.");
	if (state.evidenceProgressCount === 0) return deny("No coordinator-observed new evidence exists for this stage.");
	if (state.unresolvedChallengeCount === 0 && !state.requiredOutputPending) {
		return deny("The stage has no unresolved governance obligation or required output.");
	}
	if (state.blockedRequestCount > policy.maxBlockedRequestsPerStage) {
		return deny("Blocked-request threshold prevents further allocation.");
	}
	if (state.duplicateOperationCount > policy.maxDuplicateRequestsPerStage) {
		return deny("Duplicate-request threshold prevents further allocation.");
	}

	if (kind === "time") {
		const granted = Math.min(
			policy.timeExtensionMs,
			state.stageHardTimeoutMs - state.stageGrantedTimeoutMs,
			state.remainingProjectTimeMs - policy.protectedVerificationTimeMs,
		);
		if (granted <= 0) return deny("Stage hard timeout or protected project reserve prevents further time allocation.");
		state.stageGrantedTimeoutMs += granted;
		return appendAllocationEvent(state, {
			role: state.role,
			stage: state.stage,
			action: "grant-time",
			requested,
			granted: { timeMs: granted },
			evidenceProgressCount: state.evidenceProgressCount,
			unresolvedChallengeCount: state.unresolvedChallengeCount,
			remainingProjectTimeMs: state.remainingProjectTimeMs,
			remainingProjectToolCalls: state.remainingProjectToolCalls,
			reason: "New evidence supports unresolved governance work.",
		});
	}

	const granted = Math.min(
		policy.toolExtensionCalls,
		state.stageHardToolCalls - state.stageGrantedToolCalls,
		state.remainingProjectToolCalls - policy.protectedVerificationToolCalls,
	);
	if (granted <= 0) return deny("Stage hard tool limit or protected project reserve prevents further tool allocation.");
	state.stageGrantedToolCalls += granted;
	state.remainingProjectToolCalls -= granted;
	return appendAllocationEvent(state, {
		role: state.role,
		stage: state.stage,
		action: "grant-tools",
		requested,
		granted: { toolCalls: granted },
		evidenceProgressCount: state.evidenceProgressCount,
		unresolvedChallengeCount: state.unresolvedChallengeCount,
		remainingProjectTimeMs: state.remainingProjectTimeMs,
		remainingProjectToolCalls: state.remainingProjectToolCalls,
		reason: "New evidence supports unresolved governance work.",
	});
}
