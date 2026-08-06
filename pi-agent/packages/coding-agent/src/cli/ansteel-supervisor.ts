import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isBunBinary } from "../config.ts";
import {
	type AnsteelRunCheckpointStatus,
	getAnsteelRunCheckpointPath,
	loadAnsteelRunCheckpoint,
} from "../core/ansteel-run.ts";
import { parseArgs } from "./args.ts";

export type AnsteelEpochCall = { kind: "new"; topic: string } | { kind: "resume"; runId: string };

export interface AnsteelEpochSupervisorOptions {
	topic?: string;
	resumeRunId?: string;
	maxEpochs: number;
	cwd?: string;
	listRunIds?: () => string[];
	loadCheckpoint?: (runId: string) => { id: string; status: AnsteelRunCheckpointStatus | string };
	onRunId?: (runId: string) => void;
	onEpochStarted?: (pid: number) => void;
	runEpoch: (call: AnsteelEpochCall, onEpochStarted?: (pid: number) => void) => Promise<number>;
}

export interface AnsteelEpochSupervisorResult {
	outcome: "terminal" | "limit-reached" | "child-failed" | "invalid-checkpoint";
	runId?: string;
	epochsStarted: number;
	exitCode: number;
}

export interface AnsteelSupervisorLockOwner {
	version: 2;
	pid: number;
	startedAt: string;
	runId?: string;
	epochState: "idle" | "starting" | "running";
	epochPid?: number;
}

interface AnsteelLegacySupervisorLockOwner {
	version: 1;
	pid: number;
	startedAt: string;
	runId?: string;
}

type StoredAnsteelSupervisorLock = AnsteelSupervisorLockOwner | AnsteelLegacySupervisorLockOwner;
type AnsteelSupervisorLockPatch = Partial<Pick<AnsteelSupervisorLockOwner, "runId" | "epochState" | "epochPid">>;

export interface AnsteelEpochSupervisorWithLockOptions extends AnsteelEpochSupervisorOptions {
	isProcessAlive?: (pid: number) => boolean;
	supervisorPid?: number;
	now?: () => Date;
}

export interface AnsteelSupervisorCliOptions {
	args: readonly string[];
	cwd: string;
	spawnEpoch?: (childArgs: readonly string[], onEpochStarted?: (pid: number) => void) => Promise<number>;
}

/** Runs bounded review epochs until their durable checkpoint reaches a terminal state. */
export async function runAnsteelEpochSupervisor(
	options: AnsteelEpochSupervisorOptions,
): Promise<AnsteelEpochSupervisorResult> {
	const cwd = options.cwd ?? process.cwd();
	const listRunIds =
		options.listRunIds ??
		(() => {
			try {
				return readdirSync(join(cwd, ".pi", "ansteel-runs"));
			} catch (error) {
				if (getErrorCode(error) === "ENOENT") return [];
				throw error;
			}
		});
	const loadCheckpoint =
		options.loadCheckpoint ?? ((runId: string) => loadAnsteelRunCheckpoint(getAnsteelRunCheckpointPath(cwd, runId)));
	let runId = options.resumeRunId;
	let notifiedRunId: string | undefined;
	const notifyRunId = (id: string) => {
		if (id === notifiedRunId) return;
		notifiedRunId = id;
		options.onRunId?.(id);
	};
	if (runId !== undefined) notifyRunId(runId);

	for (let epoch = 0; epoch < options.maxEpochs; epoch++) {
		const before = runId === undefined ? new Set(listRunIds()) : undefined;
		if (runId === undefined && options.topic === undefined) {
			throw new Error("Ansteel epoch supervisor requires a topic for a new run");
		}
		const exitCode = await options.runEpoch(
			runId === undefined ? { kind: "new", topic: options.topic! } : { kind: "resume", runId },
			options.onEpochStarted,
		);
		if (exitCode !== 0) return { outcome: "child-failed", runId, epochsStarted: epoch + 1, exitCode };
		if (runId === undefined) {
			runId = getOnlyNewRunId(before!, listRunIds());
			notifyRunId(runId);
		}

		let checkpoint: { id: string; status: AnsteelRunCheckpointStatus | string };
		try {
			checkpoint = loadCheckpoint(runId);
		} catch {
			return { outcome: "invalid-checkpoint", runId, epochsStarted: epoch + 1, exitCode: 1 };
		}
		if (checkpoint.id !== runId) {
			return { outcome: "invalid-checkpoint", runId, epochsStarted: epoch + 1, exitCode: 1 };
		}
		if (checkpoint.status === "ready-to-resume") continue;
		if (checkpoint.status === "completed" || checkpoint.status === "failed" || checkpoint.status === "expired") {
			return { outcome: "terminal", runId, epochsStarted: epoch + 1, exitCode: 0 };
		}
		return { outcome: "invalid-checkpoint", runId, epochsStarted: epoch + 1, exitCode: 1 };
	}

	return { outcome: "limit-reached", runId, epochsStarted: options.maxEpochs, exitCode: 1 };
}

/** Owns a project lock for the duration of checkpoint-driven epoch supervision. */
export async function runAnsteelEpochSupervisorWithLock(
	options: AnsteelEpochSupervisorWithLockOptions,
): Promise<AnsteelEpochSupervisorResult> {
	const cwd = options.cwd ?? process.cwd();
	const lockPath = join(cwd, ".pi", "ansteel-supervisor.lock");
	const owner: AnsteelSupervisorLockOwner = {
		version: 2,
		pid: options.supervisorPid ?? process.pid,
		startedAt: (options.now ?? (() => new Date()))().toISOString(),
		epochState: "idle",
	};
	const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;

	acquireSupervisorLock(lockPath, owner, isProcessAlive);
	try {
		return await runAnsteelEpochSupervisor({
			...options,
			runEpoch: async (call, onEpochStarted) => {
				markSupervisorEpochStarting(lockPath, owner);
				try {
					return await options.runEpoch(call, onEpochStarted);
				} finally {
					clearSupervisorLockEpochPid(lockPath, owner);
				}
			},
			onRunId: (runId) => {
				updateSupervisorLockRunId(lockPath, owner, runId);
				options.onRunId?.(runId);
			},
			onEpochStarted: (pid) => {
				markSupervisorEpochRunning(lockPath, owner, pid);
				options.onEpochStarted?.(pid);
			},
		});
	} finally {
		releaseSupervisorLock(lockPath, owner);
	}
}

/** Translates supervision arguments into fresh short-lived Ansteel CLI child processes. */
export async function runAnsteelSupervisorCli(
	options: AnsteelSupervisorCliOptions,
): Promise<AnsteelEpochSupervisorResult> {
	const parsed = parseArgs([...options.args]);
	if (parsed.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
		throw new Error(
			parsed.diagnostics
				.filter((diagnostic) => diagnostic.type === "error")
				.map((diagnostic) => diagnostic.message)
				.join("; "),
		);
	}
	const maxEpochs = parsed.ansteelSuperviseMaxEpochs ?? 64;
	const topic = parsed.ansteelSupervise;
	const resumeRunId = parsed.ansteelSuperviseResume;
	if (topic === undefined && resumeRunId === undefined) {
		throw new Error("Ansteel supervisor requires a topic or a resumable run ID");
	}
	const spawnEpoch = options.spawnEpoch ?? createSubprocessEpochSpawner(options.cwd);

	return await runAnsteelEpochSupervisorWithLock({
		cwd: options.cwd,
		maxEpochs,
		...(topic === undefined ? {} : { topic }),
		...(resumeRunId === undefined ? {} : { resumeRunId }),
		runEpoch: async (call, onEpochStarted) =>
			await spawnEpoch(createAnsteelEpochChildArgs(options.args, call), onEpochStarted),
	});
}

function getOnlyNewRunId(before: ReadonlySet<string>, after: readonly string[]): string {
	const newRunIds = after.filter((runId) => !before.has(runId));
	if (newRunIds.length !== 1) {
		throw new Error(
			`Ansteel epoch supervisor expected exactly one new Ansteel run ID, found ${newRunIds.length}: ${newRunIds.join(", ") || "none"}`,
		);
	}
	return newRunIds[0]!;
}

function createAnsteelEpochChildArgs(args: readonly string[], call: AnsteelEpochCall): string[] {
	const childArgs = [...getCliEntrypointArgs(), ...removeSupervisorArgs(args)];
	if (call.kind === "new") {
		childArgs.push("--ansteel", call.topic);
	} else {
		childArgs.push("--ansteel-resume", call.runId);
	}
	return childArgs;
}

function removeSupervisorArgs(args: readonly string[]): string[] {
	const result: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const argument = args[index]!;
		if (
			argument === "--ansteel-supervise" ||
			argument === "--ansteel-supervise-resume" ||
			argument === "--ansteel-supervise-max-epochs"
		) {
			index++;
			continue;
		}
		result.push(argument);
	}
	return result;
}

function getCliEntrypointArgs(): string[] {
	if (isBunBinary) return [];
	const entrypoint = process.argv[1];
	if (entrypoint === undefined || !existsSync(entrypoint)) {
		throw new Error("Ansteel supervisor cannot locate the current Node CLI entrypoint");
	}
	return [entrypoint];
}

function createSubprocessEpochSpawner(
	cwd: string,
): (childArgs: readonly string[], onEpochStarted?: (pid: number) => void) => Promise<number> {
	return async (childArgs, onEpochStarted) =>
		await new Promise<number>((resolve, reject) => {
			const child = spawn(process.execPath, [...childArgs], { cwd, env: process.env, stdio: "inherit" });
			let startupFailure: unknown;
			child.once("error", (error) => {
				if (startupFailure === undefined) reject(error);
			});
			child.once("close", (code) => {
				if (startupFailure !== undefined) reject(startupFailure);
				else resolve(code ?? 1);
			});
			if (onEpochStarted === undefined) return;
			if (child.pid === undefined) {
				reject(new Error("Ansteel supervisor child process has no PID"));
				return;
			}
			try {
				onEpochStarted(child.pid);
			} catch (error) {
				startupFailure = error;
				child.kill();
			}
		});
}

function acquireSupervisorLock(
	lockPath: string,
	owner: AnsteelSupervisorLockOwner,
	isProcessAlive: (pid: number) => boolean,
): void {
	mkdirSync(dirname(lockPath), { recursive: true });
	try {
		writeFileSync(lockPath, JSON.stringify(owner), { encoding: "utf8", flag: "wx" });
		return;
	} catch (error) {
		if (getErrorCode(error) !== "EEXIST")
			throw new Error(`Ansteel supervisor lock cannot be created: ${formatError(error)}`);
	}

	const existingOwner = readSupervisorLock(lockPath);
	let isAlive: boolean;
	try {
		isAlive = isProcessAlive(existingOwner.pid);
	} catch (error) {
		throw new Error(`Ansteel supervisor lock owner cannot be verified: ${formatError(error)}`);
	}
	if (isAlive !== false) {
		throw new Error(`Ansteel supervisor already owns this project (PID ${existingOwner.pid})`);
	}
	if (existingOwner.version === 1) {
		throw new Error("Ansteel supervisor legacy lock cannot be safely recovered");
	}
	if (existingOwner.epochState === "starting") {
		throw new Error("Ansteel supervisor epoch startup cannot be safely recovered");
	}
	if (existingOwner.epochState === "running") {
		let isEpochAlive: boolean;
		try {
			isEpochAlive = isProcessAlive(existingOwner.epochPid!);
		} catch (error) {
			throw new Error(`Ansteel supervisor epoch child cannot be verified: ${formatError(error)}`);
		}
		if (isEpochAlive !== false) {
			throw new Error(`Ansteel supervisor epoch child still owns this project (PID ${existingOwner.epochPid!})`);
		}
	}

	try {
		unlinkSync(lockPath);
	} catch (error) {
		throw new Error(`Ansteel supervisor lock orphan cannot be removed: ${formatError(error)}`);
	}
	try {
		writeFileSync(lockPath, JSON.stringify(owner), { encoding: "utf8", flag: "wx" });
	} catch (error) {
		if (getErrorCode(error) === "EEXIST") {
			throw new Error("Ansteel supervisor lock changed while taking over an orphaned lock");
		}
		throw new Error(`Ansteel supervisor lock cannot be recreated: ${formatError(error)}`);
	}
}

function releaseSupervisorLock(lockPath: string, owner: AnsteelSupervisorLockOwner): void {
	let currentOwner: StoredAnsteelSupervisorLock;
	try {
		currentOwner = readSupervisorLock(lockPath);
	} catch (error) {
		if (getErrorCode(error) === "ENOENT") return;
		throw error;
	}
	if (
		currentOwner.version !== owner.version ||
		currentOwner.pid !== owner.pid ||
		currentOwner.startedAt !== owner.startedAt
	) {
		throw new Error("Ansteel supervisor lock ownership changed before release");
	}
	try {
		unlinkSync(lockPath);
	} catch (error) {
		if (getErrorCode(error) !== "ENOENT")
			throw new Error(`Ansteel supervisor lock cannot be released: ${formatError(error)}`);
	}
}

function updateSupervisorLockRunId(lockPath: string, owner: AnsteelSupervisorLockOwner, runId: string): void {
	if (owner.runId === runId) return;
	updateSupervisorLock(lockPath, owner, { runId });
}

function markSupervisorEpochStarting(lockPath: string, owner: AnsteelSupervisorLockOwner): void {
	if (owner.epochState !== "idle") {
		throw new Error("Ansteel supervisor lock has an uncleared epoch state");
	}
	updateSupervisorLock(lockPath, owner, { epochState: "starting", epochPid: undefined });
}

function markSupervisorEpochRunning(lockPath: string, owner: AnsteelSupervisorLockOwner, epochPid: number): void {
	if (owner.epochState !== "starting") {
		throw new Error("Ansteel supervisor lock has no epoch startup claim");
	}
	updateSupervisorLock(lockPath, owner, { epochState: "running", epochPid });
}

function clearSupervisorLockEpochPid(lockPath: string, owner: AnsteelSupervisorLockOwner): void {
	if (owner.epochState === "idle") return;
	updateSupervisorLock(lockPath, owner, { epochState: "idle", epochPid: undefined });
}

function updateSupervisorLock(
	lockPath: string,
	owner: AnsteelSupervisorLockOwner,
	patch: AnsteelSupervisorLockPatch,
): void {
	const nextOwner: AnsteelSupervisorLockOwner = { ...owner, ...patch };
	const temporaryPath = `${lockPath}.${owner.pid}.tmp`;
	writeFileSync(temporaryPath, JSON.stringify(nextOwner), "utf8");
	try {
		const currentOwner = readSupervisorLock(lockPath);
		if (
			currentOwner.version !== owner.version ||
			currentOwner.pid !== owner.pid ||
			currentOwner.startedAt !== owner.startedAt
		) {
			throw new Error("Ansteel supervisor lock ownership changed before run ID update");
		}
		renameSync(temporaryPath, lockPath);
		Object.assign(owner, patch);
	} catch (error) {
		try {
			unlinkSync(temporaryPath);
		} catch (cleanupError) {
			if (getErrorCode(cleanupError) !== "ENOENT") throw cleanupError;
		}
		throw error;
	}
}

function readSupervisorLock(lockPath: string): StoredAnsteelSupervisorLock {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(lockPath, "utf8"));
	} catch (error) {
		if (getErrorCode(error) === "ENOENT") throw error;
		throw new Error(`Ansteel supervisor lock is invalid and was not removed: ${formatError(error)}`);
	}
	if (!isStoredSupervisorLock(value)) {
		throw new Error("Ansteel supervisor lock is invalid and was not removed");
	}
	return value;
}

function isStoredSupervisorLock(value: unknown): value is StoredAnsteelSupervisorLock {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const owner = value as Record<string, unknown>;
	return (
		typeof owner.pid === "number" &&
		Number.isInteger(owner.pid) &&
		owner.pid >= 0 &&
		typeof owner.startedAt === "string" &&
		isIsoTimestamp(owner.startedAt) &&
		(owner.runId === undefined || typeof owner.runId === "string") &&
		((owner.version === 1 && owner.epochState === undefined && owner.epochPid === undefined) ||
			(owner.version === 2 && isValidSupervisorEpochState(owner)))
	);
}

function isValidSupervisorEpochState(owner: Record<string, unknown>): boolean {
	const hasValidEpochPid =
		typeof owner.epochPid === "number" && Number.isInteger(owner.epochPid) && owner.epochPid >= 0;
	return (
		(owner.epochState === "idle" && owner.epochPid === undefined) ||
		(owner.epochState === "starting" && owner.epochPid === undefined) ||
		(owner.epochState === "running" && hasValidEpochPid)
	);
}

function isIsoTimestamp(value: string): boolean {
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function defaultIsProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (getErrorCode(error) === "ESRCH") return false;
		throw error;
	}
}

function getErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
