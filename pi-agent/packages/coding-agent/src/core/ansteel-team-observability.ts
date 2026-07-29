import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	writeSync,
} from "node:fs";
import { join, resolve } from "node:path";

export const ANSTEEL_RUNTIME_REASON_CODES = [
	"provider-timeout",
	"provider-empty-public-output",
	"provider-rate-limited",
	"provider-authentication-failed",
	"tool-exit-nonzero",
	"tool-timeout",
	"tool-policy-denied",
	"process-orphaned",
	"lease-expired",
	"lease-owner-mismatch",
	"revision-drift",
	"diff-hash-mismatch",
	"blocking-process-issue-open",
	"event-chain-invalid",
	"event-fsync-failed",
	"artifact-missing",
	"state-projection-mismatch",
	"budget-exhausted",
	"no-governed-progress",
	"coordinator-restarted",
	"unclassified-runtime-error",
] as const;

export type AnsteelRuntimeReasonCode = (typeof ANSTEEL_RUNTIME_REASON_CODES)[number];

export interface AnsteelRunContext {
	runId: string;
	traceId: string;
	teamId: string;
	command: string;
	startedAt: string;
	resumedFromRunId?: string;
	resumedFromSequence?: number;
}

export interface AnsteelRuntimeArtifactRef {
	kind: string;
	sha256: string;
	storageId: string;
}

export interface AnsteelRuntimeLogEntry {
	schemaVersion: 1;
	timestampUtc: string;
	monotonicElapsedNs: string;
	sequence: number;
	level: "debug" | "info" | "warn" | "error" | "audit";
	eventName: string;
	outcome: "started" | "progress" | "succeeded" | "failed" | "cancelled" | "abandoned";
	reasonCode?: AnsteelRuntimeReasonCode;
	runId: string;
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	teamId: string;
	role?: "tech-lead" | "staff-engineer" | "qa-engineer" | "coordinator";
	sessionId?: string;
	taskId?: string;
	checkpointId?: string;
	issueId?: string;
	toolCallId?: string;
	providerRequestId?: string;
	processId?: string;
	leaseId?: string;
	revision?: number;
	diffHash?: string;
	causeEventId?: string;
	message: string;
	data: Record<string, unknown>;
	artifactRefs: AnsteelRuntimeArtifactRef[];
	previousHash: string | null;
	hash: string;
}

export type AnsteelRuntimeLogInput = Omit<
	AnsteelRuntimeLogEntry,
	| "schemaVersion"
	| "timestampUtc"
	| "monotonicElapsedNs"
	| "sequence"
	| "runId"
	| "traceId"
	| "spanId"
	| "teamId"
	| "artifactRefs"
	| "previousHash"
	| "hash"
> & {
	spanId?: string;
	artifacts?: Array<{ kind: string; content: string }>;
};

export interface AnsteelRuntimeLogger {
	readonly context: AnsteelRunContext;
	write(input: AnsteelRuntimeLogInput): AnsteelRuntimeLogEntry;
	close(): void;
}

export class AnsteelObservabilityError extends Error {
	readonly reasonCode: AnsteelRuntimeReasonCode;

	constructor(reasonCode: AnsteelRuntimeReasonCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "AnsteelObservabilityError";
		this.reasonCode = reasonCode;
	}
}

export function isAnsteelRuntimeReasonCode(value: string): value is AnsteelRuntimeReasonCode {
	return (ANSTEEL_RUNTIME_REASON_CODES as readonly string[]).includes(value);
}

export function createAnsteelRunContext(input: {
	teamId: string;
	command: string;
	now?: Date;
	resumedFromRunId?: string;
	resumedFromSequence?: number;
}): AnsteelRunContext {
	return {
		runId: `RUN-${randomUUID()}`,
		traceId: randomBytes(16).toString("hex"),
		teamId: input.teamId,
		command: input.command,
		startedAt: (input.now ?? new Date()).toISOString(),
		...(input.resumedFromRunId === undefined ? {} : { resumedFromRunId: input.resumedFromRunId }),
		...(input.resumedFromSequence === undefined ? {} : { resumedFromSequence: input.resumedFromSequence }),
	};
}

function getAnsteelTeamRuntimeDirectory(cwd: string): string {
	if (cwd.trim().length === 0) {
		throw new AnsteelObservabilityError("unclassified-runtime-error", "Ansteel observability requires a project directory");
	}
	return resolve(cwd, ".pi", "ansteel-team");
}

export function getAnsteelRuntimeLogDirectory(cwd: string): string {
	return join(getAnsteelTeamRuntimeDirectory(cwd), "logs");
}

export function getAnsteelRuntimeArtifactDirectory(cwd: string): string {
	return join(getAnsteelTeamRuntimeDirectory(cwd), "artifacts");
}

function assertRunId(runId: string): void {
	if (!/^RUN-[0-9a-f-]{36}$/i.test(runId)) {
		throw new AnsteelObservabilityError("unclassified-runtime-error", "Ansteel runtime run ID is invalid");
	}
}

function getAnsteelRuntimeLogPath(cwd: string, runId: string, segment = 1): string {
	assertRunId(runId);
	return join(getAnsteelRuntimeLogDirectory(cwd), `run-${runId}-${String(segment).padStart(4, "0")}.jsonl`);
}

const SENSITIVE_FIELD = /authorization|api[_-]?key|token|cookie|secret|password|private[_-]?key/i;

function redactString(value: string): string {
	return value
		.replace(/\bBearer\s+[^\s"',;]+/gi, "Bearer [REDACTED]")
		.replace(/\bsk-[A-Za-z0-9._-]+\b/g, "sk-[REDACTED]")
		.replace(
			/\b(API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|PRIVATE_KEY|SECRET|TOKEN)=([^\s]+)/gi,
			"$1=[REDACTED]",
		);
}

function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
	if (typeof value === "string") return redactString(value);
	if (Array.isArray(value)) return value.map((item) => redactValue(item, seen));
	if (typeof value !== "object" || value === null) return value;
	if (seen.has(value)) return "[Circular]";
	seen.add(value);
	const result = Object.create(null) as Record<string, unknown>;
	for (const [key, entry] of Object.entries(value)) {
		result[key] = SENSITIVE_FIELD.test(key) ? "[REDACTED]" : redactValue(entry, seen);
	}
	return result;
}

function redactRecord(value: Record<string, unknown>): Record<string, unknown> {
	return redactValue(value) as Record<string, unknown>;
}

function writeBuffer(fd: number, content: Buffer): void {
	let offset = 0;
	while (offset < content.length) offset += writeSync(fd, content, offset, content.length - offset);
}

function writeNewDurableFile(path: string, content: string): void {
	const fd = openSync(path, "wx");
	try {
		writeBuffer(fd, Buffer.from(content, "utf8"));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function storeArtifact(cwd: string, artifact: { kind: string; content: string }): AnsteelRuntimeArtifactRef {
	const content = redactString(artifact.content);
	const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
	const directory = getAnsteelRuntimeArtifactDirectory(cwd);
	mkdirSync(directory, { recursive: true });
	const storageId = join(directory, sha256);
	if (!existsSync(storageId)) {
		writeNewDurableFile(storageId, content);
	} else if (createHash("sha256").update(readFileSync(storageId)).digest("hex") !== sha256) {
		throw new AnsteelObservabilityError("artifact-missing", "Ansteel runtime artifact content does not match its hash");
	}
	return { kind: artifact.kind, sha256, storageId };
}

function hashRuntimeLogEntry(entry: Omit<AnsteelRuntimeLogEntry, "hash">): string {
	return createHash("sha256").update(JSON.stringify(entry), "utf8").digest("hex");
}

function parseRuntimeLogEntry(value: unknown): AnsteelRuntimeLogEntry {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new AnsteelObservabilityError("event-chain-invalid", "Ansteel runtime log entry must be an object");
	}
	const entry = value as AnsteelRuntimeLogEntry;
	if (entry.schemaVersion !== 1 || !Number.isSafeInteger(entry.sequence) || entry.sequence < 1) {
		throw new AnsteelObservabilityError("event-chain-invalid", "Ansteel runtime log entry has invalid metadata");
	}
	if (
		typeof entry.runId !== "string" ||
		typeof entry.traceId !== "string" ||
		typeof entry.spanId !== "string" ||
		typeof entry.hash !== "string"
	) {
		throw new AnsteelObservabilityError("event-chain-invalid", "Ansteel runtime log entry has invalid identifiers");
	}
	if (entry.reasonCode !== undefined && !isAnsteelRuntimeReasonCode(entry.reasonCode)) {
		throw new AnsteelObservabilityError("event-chain-invalid", "Ansteel runtime log entry has an invalid reason code");
	}
	return entry;
}

export function readAnsteelRuntimeLogs(cwd: string, runId: string): AnsteelRuntimeLogEntry[] {
	assertRunId(runId);
	const directory = getAnsteelRuntimeLogDirectory(cwd);
	if (!existsSync(directory)) return [];
	const prefix = `run-${runId}-`;
	const paths = readdirSync(directory)
		.filter((name) => name.startsWith(prefix) && name.endsWith(".jsonl"))
		.sort()
		.map((name) => join(directory, name));
	const entries: AnsteelRuntimeLogEntry[] = [];
	let previousHash: string | null = null;
	for (const path of paths) {
		const lines = readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.length > 0);
		for (const line of lines) {
			let raw: unknown;
			try {
				raw = JSON.parse(line);
			} catch (error) {
				throw new AnsteelObservabilityError("event-chain-invalid", "Ansteel runtime log contains invalid JSON", {
					cause: error,
				});
			}
			const entry = parseRuntimeLogEntry(raw);
			if (entry.runId !== runId || entry.sequence !== entries.length + 1 || entry.previousHash !== previousHash) {
				throw new AnsteelObservabilityError("event-chain-invalid", "Ansteel runtime log chain is not contiguous");
			}
			const { hash, ...unsigned } = entry;
			if (hash !== hashRuntimeLogEntry(unsigned)) {
				throw new AnsteelObservabilityError("event-chain-invalid", "Ansteel runtime log hash does not match");
			}
			entries.push(entry);
			previousHash = hash;
		}
	}
	return entries;
}

export function createAnsteelRuntimeLogger(cwd: string, context: AnsteelRunContext): AnsteelRuntimeLogger {
	assertRunId(context.runId);
	if (!/^[0-9a-f]{32}$/.test(context.traceId)) {
		throw new AnsteelObservabilityError("unclassified-runtime-error", "Ansteel runtime trace ID is invalid");
	}
	const directory = getAnsteelRuntimeLogDirectory(cwd);
	mkdirSync(directory, { recursive: true });
	const existing = readAnsteelRuntimeLogs(cwd, context.runId);
	let sequence = existing.length + 1;
	let previousHash = existing.at(-1)?.hash ?? null;
	const path = getAnsteelRuntimeLogPath(cwd, context.runId);
	const fd = openSync(path, "a");
	const startedAt = process.hrtime.bigint();
	let closed = false;

	return {
		context,
		write(input) {
			if (closed) {
				throw new AnsteelObservabilityError("event-fsync-failed", "Ansteel runtime logger is closed");
			}
			if (input.reasonCode !== undefined && !isAnsteelRuntimeReasonCode(input.reasonCode)) {
				throw new AnsteelObservabilityError("event-chain-invalid", "Ansteel runtime reason code is invalid");
			}
			const artifactRefs = (input.artifacts ?? []).map((artifact) => storeArtifact(cwd, artifact));
			const { artifacts: _artifacts, spanId: inputSpanId, data, ...fields } = input;
			const unsigned = {
				schemaVersion: 1 as const,
				timestampUtc: new Date().toISOString(),
				monotonicElapsedNs: (process.hrtime.bigint() - startedAt).toString(),
				sequence,
				...fields,
				runId: context.runId,
				traceId: context.traceId,
				spanId: inputSpanId ?? randomBytes(8).toString("hex"),
				teamId: context.teamId,
				message: redactString(input.message),
				data: redactRecord(data),
				artifactRefs,
				previousHash,
			};
			const entry: AnsteelRuntimeLogEntry = { ...unsigned, hash: hashRuntimeLogEntry(unsigned) };
			try {
				writeBuffer(fd, Buffer.from(`${JSON.stringify(entry)}\n`, "utf8"));
				fsyncSync(fd);
			} catch (error) {
				throw new AnsteelObservabilityError(
					"event-fsync-failed",
					"Ansteel runtime log could not be durably written",
					{ cause: error },
				);
			}
			sequence++;
			previousHash = entry.hash;
			return entry;
		},
		close() {
			if (closed) return;
			try {
				fsyncSync(fd);
			} finally {
				closeSync(fd);
				closed = true;
			}
		},
	};
}
