import type { ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { spawnProcess, waitForChildProcess } from "../utils/child-process.ts";
import { killProcessTree } from "../utils/shell.ts";
import type { AnsteelRole } from "./ansteel-discussion.ts";
import { hashAnsteelAuditValue } from "./ansteel-team-integrity.ts";
import type { AnsteelRuntimeLogger, AnsteelRuntimeSpan } from "./ansteel-team-observability.ts";

const DEFAULT_ANSTEEL_PROCESS_HEARTBEAT_MS = 30_000;

class BoundedProcessOutput {
	readonly chunks: Buffer[] = [];
	readonly maximumBytes: number;
	readonly hash = createHash("sha256");
	storedBytes = 0;
	totalBytes = 0;

	constructor(maximumBytes: number) {
		this.maximumBytes = maximumBytes;
	}

	append(chunk: Buffer | string): void {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		this.hash.update(buffer);
		this.totalBytes += buffer.length;
		const remaining = this.maximumBytes - this.storedBytes;
		if (remaining <= 0) return;
		const stored = buffer.length <= remaining ? buffer : buffer.subarray(0, remaining);
		this.chunks.push(stored);
		this.storedBytes += stored.length;
	}

	toString(): string {
		return Buffer.concat(this.chunks, this.storedBytes).toString("utf8");
	}

	get truncated(): boolean {
		return this.totalBytes > this.storedBytes;
	}

	digest(): string {
		return this.hash.digest("hex");
	}
}

export interface AnsteelGovernedProcessPersistence {
	logger: AnsteelRuntimeLogger;
	parentSpan?: AnsteelRuntimeSpan;
	causeEventId?: string;
}

export interface AnsteelGovernedProcessOptions {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	shell: boolean;
	timeoutMs: number;
	maximumOutputBytes: number;
	policy: "task-test" | "milestone-test" | "delivery-check";
	role?: AnsteelRole | "coordinator";
	taskId?: string;
	checkpointId?: string;
	toolCallId?: string;
	persistence?: AnsteelGovernedProcessPersistence;
	heartbeatIntervalMs?: number;
}

export interface AnsteelGovernedProcessResult {
	processId: string;
	pid?: number;
	stdout: string;
	stderr: string;
	stdoutBytes: number;
	stderrBytes: number;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	stdoutHash: string;
	stderrHash: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	launchError?: Error;
	startedAt: string;
	completedAt: string;
	durationMs: number;
	lastProgressAt: string;
}

function getProcessObservationFields(options: AnsteelGovernedProcessOptions, processId: string) {
	return {
		role: options.role ?? "coordinator",
		processId,
		...(options.taskId === undefined ? {} : { taskId: options.taskId }),
		...(options.checkpointId === undefined ? {} : { checkpointId: options.checkpointId }),
		...(options.toolCallId === undefined ? {} : { toolCallId: options.toolCallId }),
		...(options.persistence?.causeEventId === undefined ? {} : { causeEventId: options.persistence.causeEventId }),
	};
}

/**
 * Runs every governed task, milestone, and delivery subprocess through one
 * lifecycle boundary. The process is spawned before process.spawned is
 * persisted so the event always carries an OS-issued PID; Node cannot deliver
 * its exit callback until this synchronous setup has completed.
 */
export async function runAnsteelGovernedProcess(
	options: AnsteelGovernedProcessOptions,
): Promise<AnsteelGovernedProcessResult> {
	if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
		throw new Error("Ansteel governed process requires a positive timeout");
	}
	if (!Number.isSafeInteger(options.maximumOutputBytes) || options.maximumOutputBytes <= 0) {
		throw new Error("Ansteel governed process requires a positive output boundary");
	}
	const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_ANSTEEL_PROCESS_HEARTBEAT_MS;
	if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs <= 0) {
		throw new Error("Ansteel governed process requires a positive heartbeat interval");
	}

	const processId = `PROC-${randomUUID().toUpperCase()}`;
	const startedAt = new Date().toISOString();
	const startedMonotonic = process.hrtime.bigint();
	let lastProgressAt = startedAt;
	let child: ChildProcess;
	try {
		child = spawnProcess(options.command, options.args, {
			cwd: options.cwd,
			detached: process.platform !== "win32",
			env: options.env,
			shell: options.shell,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
	} catch (error) {
		const completedAt = new Date().toISOString();
		return {
			processId,
			stdout: "",
			stderr: "",
			stdoutBytes: 0,
			stderrBytes: 0,
			stdoutTruncated: false,
			stderrTruncated: false,
			stdoutHash: createHash("sha256").digest("hex"),
			stderrHash: createHash("sha256").digest("hex"),
			exitCode: null,
			signal: null,
			timedOut: false,
			launchError: error instanceof Error ? error : new Error(String(error)),
			startedAt,
			completedAt,
			durationMs: Number(process.hrtime.bigint() - startedMonotonic) / 1_000_000,
			lastProgressAt,
		};
	}

	const stdout = new BoundedProcessOutput(options.maximumOutputBytes);
	const stderr = new BoundedProcessOutput(options.maximumOutputBytes);
	const recordProgress = (output: BoundedProcessOutput, chunk: Buffer | string): void => {
		output.append(chunk);
		lastProgressAt = new Date().toISOString();
	};
	child.stdout?.on("data", (chunk: Buffer | string) => recordProgress(stdout, chunk));
	child.stderr?.on("data", (chunk: Buffer | string) => recordProgress(stderr, chunk));

	const pid = child.pid;
	const observationFields = getProcessObservationFields(options, processId);
	const commandHash = hashAnsteelAuditValue({ command: options.command, args: options.args, shell: options.shell });
	const cwdHash = hashAnsteelAuditValue(options.cwd);
	const processSpan =
		pid === undefined || options.persistence === undefined
			? undefined
			: options.persistence.logger.startSpan("process", {
					...observationFields,
					parent: options.persistence.parentSpan,
					message: `Governed ${options.policy} process spawned`,
					data: {
						pid,
						policy: options.policy,
						commandHash,
						cwdHash,
						shell: options.shell,
						argumentCount: options.args.length,
						timeoutMs: options.timeoutMs,
						maximumOutputBytes: options.maximumOutputBytes,
						startedAt,
					},
				});

	let timedOut = false;
	let signal: NodeJS.Signals | null = null;
	let observationError: unknown;
	child.once("exit", (_code, exitSignal) => {
		signal = exitSignal;
	});
	const timeout = setTimeout(() => {
		timedOut = true;
		if (pid !== undefined) killProcessTree(pid);
	}, options.timeoutMs);
	const heartbeat =
		processSpan === undefined
			? undefined
			: setInterval(() => {
					try {
						const elapsedMs = Number(process.hrtime.bigint() - startedMonotonic) / 1_000_000;
						const progressData = {
							pid,
							policy: options.policy,
							elapsedMs,
							stdoutBytes: stdout.totalBytes,
							stderrBytes: stderr.totalBytes,
							lastProgressAt,
						};
						const parentToolSpan = options.toolCallId === undefined ? undefined : options.persistence!.parentSpan;
						options.persistence!.logger.writeBatch([
							{
								level: "info",
								eventName: "process.heartbeat",
								outcome: "progress",
								...observationFields,
								spanId: processSpan.spanId,
								...(processSpan.parentSpanId === undefined ? {} : { parentSpanId: processSpan.parentSpanId }),
								message: `Governed ${options.policy} process is still running`,
								data: progressData,
							},
							...(parentToolSpan === undefined
								? []
								: [
										{
											level: "info" as const,
											eventName: "tool.call.progress",
											outcome: "progress" as const,
											role: options.role ?? "coordinator",
											...(options.taskId === undefined ? {} : { taskId: options.taskId }),
											...(options.checkpointId === undefined ? {} : { checkpointId: options.checkpointId }),
											toolCallId: options.toolCallId!,
											processId,
											spanId: parentToolSpan.spanId,
											...(parentToolSpan.parentSpanId === undefined
												? {}
												: { parentSpanId: parentToolSpan.parentSpanId }),
											message: `Governed ${options.policy} tool call is still running`,
											data: { ...progressData, sourceEventName: "process.heartbeat" },
										},
									]),
						]);
					} catch (error) {
						observationError = error;
						if (pid !== undefined) killProcessTree(pid);
					}
				}, heartbeatIntervalMs);

	let exitCode: number | null = null;
	let launchError: Error | undefined;
	try {
		exitCode = await waitForChildProcess(child);
	} catch (error) {
		launchError = error instanceof Error ? error : new Error(String(error));
	} finally {
		clearTimeout(timeout);
		if (heartbeat !== undefined) clearInterval(heartbeat);
	}
	if (observationError !== undefined) throw observationError;

	const completedAt = new Date().toISOString();
	const durationMs = Number(process.hrtime.bigint() - startedMonotonic) / 1_000_000;
	const stdoutText = stdout.toString();
	const stderrText = stderr.toString();
	const stdoutHash = stdout.digest();
	const stderrHash = stderr.digest();
	const outputBoundaryExceeded = stdout.truncated || stderr.truncated;
	const succeeded = launchError === undefined && !timedOut && !outputBoundaryExceeded && exitCode === 0;
	const reasonCode = timedOut
		? ("tool-timeout" as const)
		: outputBoundaryExceeded
			? ("budget-exhausted" as const)
			: launchError === undefined
				? ("tool-exit-nonzero" as const)
				: ("unclassified-runtime-error" as const);
	if (processSpan !== undefined) {
		processSpan.end({
			outcome: succeeded ? "succeeded" : timedOut ? "cancelled" : "failed",
			...(succeeded ? {} : { reasonCode }),
			message: `Governed ${options.policy} process ${succeeded ? "completed" : timedOut ? "timed out" : "failed"}`,
			data: {
				pid,
				policy: options.policy,
				commandHash,
				cwdHash,
				exitCode,
				signal,
				timedOut,
				durationMs,
				lastProgressAt,
				stdoutBytes: stdout.totalBytes,
				stderrBytes: stderr.totalBytes,
				stdoutTruncated: stdout.truncated,
				stderrTruncated: stderr.truncated,
				stdoutHash,
				stderrHash,
			},
		});
	}

	return {
		processId,
		...(pid === undefined ? {} : { pid }),
		stdout: stdoutText,
		stderr: stderrText,
		stdoutBytes: stdout.totalBytes,
		stderrBytes: stderr.totalBytes,
		stdoutTruncated: stdout.truncated,
		stderrTruncated: stderr.truncated,
		stdoutHash,
		stderrHash,
		exitCode,
		signal,
		timedOut,
		...(launchError === undefined ? {} : { launchError }),
		startedAt,
		completedAt,
		durationMs,
		lastProgressAt,
	};
}
