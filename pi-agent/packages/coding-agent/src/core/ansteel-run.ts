import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AnsteelRole } from "./ansteel-discussion.ts";

const ANSTEEL_RUN_CHECKPOINT_VERSION = 1;

export type AnsteelRunCheckpointStatus = "active" | "completed" | "failed";

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
	createdAt: string;
	updatedAt: string;
	roleModels: Record<AnsteelRole, string>;
	events: AnsteelRunCheckpointEvent[];
}

export interface AnsteelRunCheckpoint {
	path: string;
	state: AnsteelRunCheckpointState;
}

export interface CreateAnsteelRunCheckpointOptions {
	cwd: string;
	topic: string;
	roleModels: Record<AnsteelRole, string>;
	now?: Date;
}

export interface UpdateAnsteelRunCheckpointOptions {
	status?: AnsteelRunCheckpointStatus;
	event?: Omit<AnsteelRunCheckpointEvent, "createdAt">;
	now?: Date;
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
	if (
		typeof state.id !== "string" ||
		state.id.length === 0 ||
		typeof state.topic !== "string" ||
		state.topic.length === 0
	) {
		throw new Error("Ansteel run checkpoint requires an ID and topic");
	}
	if (state.status !== "active" && state.status !== "completed" && state.status !== "failed") {
		throw new Error("Ansteel run checkpoint has an invalid status");
	}
	if (!state.roleModels || typeof state.roleModels !== "object" || !Array.isArray(state.events)) {
		throw new Error("Ansteel run checkpoint has invalid role models or events");
	}
}

function writeCheckpoint(path: string, state: AnsteelRunCheckpointState): void {
	const temporaryPath = `${path}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(state, null, "\t")}\n`, "utf8");
	renameSync(temporaryPath, path);
}

export function getAnsteelRunDirectory(cwd: string): string {
	return join(cwd, ".pi", "ansteel-runs");
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
		status: "active",
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
