import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Span as OpenTelemetrySpan, ROOT_CONTEXT, SpanStatusCode, trace } from "@opentelemetry/api";
import {
	BasicTracerProvider,
	type ReadableSpan,
	SimpleSpanProcessor,
	type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import lockfile from "proper-lockfile";

const ANSTEEL_RUNTIME_LOG_LOCK_STALE_MS = 300_000;
const ANSTEEL_RUNTIME_LOG_LOCK_UPDATE_MS = 10_000;

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

export interface AnsteelRuntimeSpanEndInput {
	outcome: "succeeded" | "failed" | "cancelled" | "abandoned";
	reasonCode?: AnsteelRuntimeReasonCode;
	message: string;
	data?: Record<string, unknown>;
	artifacts?: Array<{ kind: string; content: string }>;
}

export interface AnsteelRuntimeSpan {
	readonly traceId: string;
	readonly spanId: string;
	readonly parentSpanId?: string;
	end(input: AnsteelRuntimeSpanEndInput): void;
}

export interface AnsteelRuntimeSpanStartOptions {
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
	parent?: AnsteelRuntimeSpan;
	message?: string;
	data?: Record<string, unknown>;
}

export interface AnsteelRuntimeLogger {
	readonly context: AnsteelRunContext;
	write(input: AnsteelRuntimeLogInput): AnsteelRuntimeLogEntry;
	startSpan(eventName: string, options?: AnsteelRuntimeSpanStartOptions): AnsteelRuntimeSpan;
	forceFlush(): Promise<void>;
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
		throw new AnsteelObservabilityError(
			"unclassified-runtime-error",
			"Ansteel observability requires a project directory",
		);
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
		.replace(/\b(API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|PRIVATE_KEY|SECRET|TOKEN)=([^\s]+)/gi, "$1=[REDACTED]");
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
		throw new AnsteelObservabilityError(
			"artifact-missing",
			"Ansteel runtime artifact content does not match its hash",
		);
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
		throw new AnsteelObservabilityError(
			"event-chain-invalid",
			"Ansteel runtime log entry has an invalid reason code",
		);
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

export interface AnsteelRuntimeDiagnosisIssue {
	reasonCode: AnsteelRuntimeReasonCode;
	message: string;
	entrySequence?: number;
	artifact?: AnsteelRuntimeArtifactRef;
}

export interface AnsteelRuntimeDiagnosis {
	runId: string;
	traceId?: string;
	healthy: boolean;
	rootCause?: AnsteelRuntimeLogEntry;
	issues: AnsteelRuntimeDiagnosisIssue[];
	entryCount: number;
}

export interface AnsteelRuntimeRunSummary {
	runId: string;
	traceId?: string;
	teamId?: string;
	startedAt?: string;
	endedAt?: string;
	entryCount: number;
	lastOutcome?: AnsteelRuntimeLogEntry["outcome"];
}

export interface AnsteelIncidentBundle {
	storageId: string;
	sha256: string;
	manifest: {
		schemaVersion: 1;
		runId: string;
		traceId?: string;
		createdAt: string;
		healthy: boolean;
		rootCause?: AnsteelRuntimeLogEntry;
		issues: AnsteelRuntimeDiagnosisIssue[];
		logHashes: string[];
		artifactRefs: AnsteelRuntimeArtifactRef[];
	};
}

export function listAnsteelRuntimeRuns(cwd: string): AnsteelRuntimeRunSummary[] {
	const directory = getAnsteelRuntimeLogDirectory(cwd);
	if (!existsSync(directory)) return [];
	const runIds = new Set<string>();
	for (const name of readdirSync(directory)) {
		const match = /^run-(RUN-[0-9a-f-]{36})-\d{4}\.jsonl$/i.exec(name);
		if (match?.[1]) runIds.add(match[1]);
	}
	return [...runIds]
		.map((runId) => {
			const entries = readAnsteelRuntimeLogs(cwd, runId);
			const first = entries[0];
			const last = entries.at(-1);
			return {
				runId,
				...(first?.traceId === undefined ? {} : { traceId: first.traceId }),
				...(first?.teamId === undefined ? {} : { teamId: first.teamId }),
				...(first?.timestampUtc === undefined ? {} : { startedAt: first.timestampUtc }),
				...(last?.timestampUtc === undefined ? {} : { endedAt: last.timestampUtc }),
				entryCount: entries.length,
				...(last?.outcome === undefined ? {} : { lastOutcome: last.outcome }),
			};
		})
		.sort((left, right) => (left.startedAt ?? "").localeCompare(right.startedAt ?? ""));
}

export function traceAnsteelTeamRuntime(cwd: string, selector: string): AnsteelRuntimeLogEntry[] {
	const normalized = selector.trim();
	if (normalized.length === 0) {
		throw new AnsteelObservabilityError("unclassified-runtime-error", "Ansteel runtime trace selector is required");
	}
	const results: AnsteelRuntimeLogEntry[] = [];
	for (const run of listAnsteelRuntimeRuns(cwd)) {
		const entries = readAnsteelRuntimeLogs(cwd, run.runId);
		if (run.runId === normalized || run.traceId === normalized) {
			results.push(...entries);
			continue;
		}
		results.push(
			...entries.filter(
				(entry) =>
					entry.taskId === normalized ||
					entry.checkpointId === normalized ||
					entry.issueId === normalized ||
					entry.toolCallId === normalized ||
					entry.providerRequestId === normalized ||
					entry.processId === normalized ||
					entry.leaseId === normalized ||
					entry.causeEventId === normalized,
			),
		);
	}
	return results.sort(
		(left, right) => left.timestampUtc.localeCompare(right.timestampUtc) || left.sequence - right.sequence,
	);
}

function getOrphanedRuntimeSpans(entries: readonly AnsteelRuntimeLogEntry[]): AnsteelRuntimeLogEntry[] {
	const openSpans = new Map<string, AnsteelRuntimeLogEntry[]>();
	for (const entry of entries) {
		const key = `${entry.spanId}\0${entry.eventName}`;
		if (entry.outcome === "started") {
			const starts = openSpans.get(key);
			if (starts === undefined) openSpans.set(key, [entry]);
			else starts.push(entry);
			continue;
		}
		if (
			entry.outcome === "succeeded" ||
			entry.outcome === "failed" ||
			entry.outcome === "cancelled" ||
			entry.outcome === "abandoned"
		) {
			openSpans.delete(key);
		}
	}
	return [...openSpans.values()].flat();
}

export async function abandonOrphanedAnsteelTeamRun(cwd: string, runId: string): Promise<number> {
	const observedEntries = readAnsteelRuntimeLogs(cwd, runId);
	if (getOrphanedRuntimeSpans(observedEntries).length === 0) return 0;
	const first = observedEntries[0]!;
	const logger = createAnsteelRuntimeLogger(cwd, {
		runId,
		traceId: first.traceId,
		teamId: first.teamId,
		command: typeof first.data.command === "string" ? first.data.command : "recovered interrupted command",
		startedAt: first.timestampUtc,
	});
	let abandonedSpanCount = 0;
	try {
		// The run lock is now held. Re-read the chain so recovery never appends
		// from a stale sequence/hash snapshot.
		const orphanedSpans = getOrphanedRuntimeSpans(readAnsteelRuntimeLogs(cwd, runId));
		if (orphanedSpans.length === 0) return 0;
		abandonedSpanCount = orphanedSpans.length;
		for (const start of orphanedSpans) {
			logger.write({
				level: "error",
				eventName: start.eventName,
				outcome: "abandoned",
				reasonCode: "process-orphaned",
				spanId: start.spanId,
				...(start.parentSpanId === undefined ? {} : { parentSpanId: start.parentSpanId }),
				...(start.role === undefined ? {} : { role: start.role }),
				...(start.sessionId === undefined ? {} : { sessionId: start.sessionId }),
				...(start.taskId === undefined ? {} : { taskId: start.taskId }),
				...(start.checkpointId === undefined ? {} : { checkpointId: start.checkpointId }),
				...(start.issueId === undefined ? {} : { issueId: start.issueId }),
				...(start.toolCallId === undefined ? {} : { toolCallId: start.toolCallId }),
				...(start.providerRequestId === undefined ? {} : { providerRequestId: start.providerRequestId }),
				...(start.processId === undefined ? {} : { processId: start.processId }),
				...(start.leaseId === undefined ? {} : { leaseId: start.leaseId }),
				...(start.revision === undefined ? {} : { revision: start.revision }),
				...(start.diffHash === undefined ? {} : { diffHash: start.diffHash }),
				causeEventId: start.causeEventId ?? start.hash,
				message: "Ansteel runtime span was abandoned during coordinator recovery",
				data: {
					recoveredFromSequence: start.sequence,
					recoveredFromEventHash: start.hash,
				},
			});
		}
		await logger.forceFlush();
	} finally {
		logger.close();
	}
	return abandonedSpanCount;
}

export function diagnoseAnsteelTeamRun(cwd: string, runId: string): AnsteelRuntimeDiagnosis {
	let entries: AnsteelRuntimeLogEntry[];
	try {
		entries = readAnsteelRuntimeLogs(cwd, runId);
	} catch (error) {
		return {
			runId,
			healthy: false,
			issues: [
				{
					reasonCode: error instanceof AnsteelObservabilityError ? error.reasonCode : "event-chain-invalid",
					message: error instanceof Error ? error.message : String(error),
				},
			],
			entryCount: 0,
		};
	}
	if (entries.length === 0) {
		return {
			runId,
			healthy: false,
			issues: [
				{
					reasonCode: "artifact-missing",
					message: `Ansteel runtime run ${runId} has no persisted logs`,
				},
			],
			entryCount: 0,
		};
	}
	const issues: AnsteelRuntimeDiagnosisIssue[] = [];
	for (const entry of entries) {
		for (const artifact of entry.artifactRefs) {
			const actualHash = existsSync(artifact.storageId)
				? createHash("sha256").update(readFileSync(artifact.storageId)).digest("hex")
				: undefined;
			if (actualHash !== artifact.sha256) {
				issues.push({
					reasonCode: "artifact-missing",
					message: `Ansteel runtime artifact ${artifact.sha256} is missing or does not match`,
					entrySequence: entry.sequence,
					artifact,
				});
			}
		}
	}
	const orphanedSpans = getOrphanedRuntimeSpans(entries);
	if (orphanedSpans.length > 0) {
		issues.push({
			reasonCode: "process-orphaned",
			message: `Ansteel runtime run ${runId} has ${orphanedSpans.length} span(s) without a valid terminal record`,
			entrySequence: orphanedSpans[0]!.sequence,
		});
	}
	const rootCause = entries.find(
		(entry) => entry.outcome === "failed" || entry.outcome === "abandoned" || entry.outcome === "cancelled",
	);
	return {
		runId,
		...(entries[0]?.traceId === undefined ? {} : { traceId: entries[0].traceId }),
		healthy: rootCause === undefined && issues.length === 0,
		...(rootCause === undefined ? {} : { rootCause }),
		issues,
		entryCount: entries.length,
	};
}

export function formatAnsteelTeamDiagnosis(diagnosis: AnsteelRuntimeDiagnosis): string {
	const lines = [
		`Run: ${diagnosis.runId}`,
		`Health: ${diagnosis.healthy ? "healthy" : "unhealthy"}`,
		`Entries: ${diagnosis.entryCount}`,
	];
	if (diagnosis.traceId) lines.push(`Trace: ${diagnosis.traceId}`);
	if (diagnosis.rootCause) {
		lines.push(
			`Root cause: ${diagnosis.rootCause.reasonCode ?? "unclassified-runtime-error"} at ${diagnosis.rootCause.eventName} sequence ${diagnosis.rootCause.sequence}`,
		);
	}
	for (const issue of diagnosis.issues) lines.push(`Issue: ${issue.reasonCode} - ${issue.message}`);
	return lines.join("\n");
}

export function createAnsteelTeamIncidentBundle(cwd: string, runId: string): AnsteelIncidentBundle {
	const diagnosis = diagnoseAnsteelTeamRun(cwd, runId);
	const entries = readAnsteelRuntimeLogs(cwd, runId);
	const artifactRefs = new Map<string, AnsteelRuntimeArtifactRef>();
	for (const entry of entries) {
		for (const artifact of entry.artifactRefs) artifactRefs.set(`${artifact.kind}:${artifact.sha256}`, artifact);
	}
	const manifest: AnsteelIncidentBundle["manifest"] = {
		schemaVersion: 1,
		runId,
		...(diagnosis.traceId === undefined ? {} : { traceId: diagnosis.traceId }),
		createdAt: new Date().toISOString(),
		healthy: diagnosis.healthy,
		...(diagnosis.rootCause === undefined ? {} : { rootCause: diagnosis.rootCause }),
		issues: diagnosis.issues,
		logHashes: entries.map((entry) => entry.hash),
		artifactRefs: [...artifactRefs.values()],
	};
	const content = `${JSON.stringify(manifest, null, "\t")}\n`;
	const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
	const directory = join(getAnsteelTeamRuntimeDirectory(cwd), "incidents");
	mkdirSync(directory, { recursive: true });
	const storageId = join(directory, `incident-${runId}-${sha256}.json`);
	if (!existsSync(storageId)) writeNewDurableFile(storageId, content);
	return { storageId, sha256, manifest };
}

interface PendingSpanEnd {
	eventName: string;
	fields: Omit<AnsteelRuntimeSpanStartOptions, "parent" | "message" | "data">;
	parentSpanId?: string;
	input: AnsteelRuntimeSpanEndInput;
}

class AnsteelRuntimeSpanExporter implements SpanExporter {
	private readonly pendingEnds: Map<string, PendingSpanEnd>;
	private readonly writeEntry: (input: AnsteelRuntimeLogInput) => AnsteelRuntimeLogEntry;

	constructor(
		pendingEnds: Map<string, PendingSpanEnd>,
		writeEntry: (input: AnsteelRuntimeLogInput) => AnsteelRuntimeLogEntry,
	) {
		this.pendingEnds = pendingEnds;
		this.writeEntry = writeEntry;
	}

	export(spans: ReadableSpan[], resultCallback: (result: { code: number; error?: Error }) => void): void {
		try {
			for (const span of spans) {
				const spanId = span.spanContext().spanId;
				const pending = this.pendingEnds.get(spanId);
				if (!pending) continue;
				this.writeEntry({
					level: pending.input.outcome === "failed" ? "error" : "info",
					eventName: pending.eventName,
					outcome: pending.input.outcome,
					...(pending.input.reasonCode === undefined ? {} : { reasonCode: pending.input.reasonCode }),
					...pending.fields,
					spanId,
					...(pending.parentSpanId === undefined ? {} : { parentSpanId: pending.parentSpanId }),
					message: pending.input.message,
					data: pending.input.data ?? {},
					artifacts: pending.input.artifacts,
				});
				this.pendingEnds.delete(spanId);
			}
			resultCallback({ code: 0 });
		} catch (error) {
			resultCallback({
				code: 1,
				error: error instanceof Error ? error : new Error(String(error)),
			});
		}
	}

	async shutdown(): Promise<void> {}

	async forceFlush(): Promise<void> {}
}

export function createAnsteelRuntimeLogger(cwd: string, context: AnsteelRunContext): AnsteelRuntimeLogger {
	assertRunId(context.runId);
	if (!/^[0-9a-f]{32}$/.test(context.traceId)) {
		throw new AnsteelObservabilityError("unclassified-runtime-error", "Ansteel runtime trace ID is invalid");
	}
	const directory = getAnsteelRuntimeLogDirectory(cwd);
	mkdirSync(directory, { recursive: true });
	const path = getAnsteelRuntimeLogPath(cwd, context.runId);
	let releaseRunLock: (() => void) | undefined;
	try {
		releaseRunLock = lockfile.lockSync(path, {
			realpath: false,
			stale: ANSTEEL_RUNTIME_LOG_LOCK_STALE_MS,
			update: ANSTEEL_RUNTIME_LOG_LOCK_UPDATE_MS,
		});
	} catch (error) {
		const code =
			typeof error === "object" && error !== null && "code" in error
				? String((error as { code?: unknown }).code)
				: undefined;
		throw new AnsteelObservabilityError(
			code === "ELOCKED" ? "lease-owner-mismatch" : "event-fsync-failed",
			code === "ELOCKED"
				? `Ansteel runtime run ${context.runId} is still owned by another writer`
				: `Ansteel runtime run ${context.runId} lock could not be acquired`,
			{ cause: error },
		);
	}
	let existing: AnsteelRuntimeLogEntry[];
	let fd: number;
	try {
		existing = readAnsteelRuntimeLogs(cwd, context.runId);
		fd = openSync(path, "a");
	} catch (error) {
		releaseRunLock();
		throw error;
	}
	let sequence = existing.length + 1;
	let previousHash = existing.at(-1)?.hash ?? null;
	const startedAt = process.hrtime.bigint();
	let closed = false;

	const write = (input: AnsteelRuntimeLogInput): AnsteelRuntimeLogEntry => {
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
			throw new AnsteelObservabilityError("event-fsync-failed", "Ansteel runtime log could not be durably written", {
				cause: error,
			});
		}
		sequence++;
		previousHash = entry.hash;
		return entry;
	};

	const pendingEnds = new Map<string, PendingSpanEnd>();
	const exporter = new AnsteelRuntimeSpanExporter(pendingEnds, write);
	const provider = new BasicTracerProvider({
		idGenerator: {
			generateTraceId: () => context.traceId,
			generateSpanId: () => randomBytes(8).toString("hex"),
		},
		spanProcessors: [new SimpleSpanProcessor(exporter)],
	});
	const tracer = provider.getTracer("ansteel-team", "1");

	const startSpan = (eventName: string, options: AnsteelRuntimeSpanStartOptions = {}): AnsteelRuntimeSpan => {
		if (closed) {
			throw new AnsteelObservabilityError("event-fsync-failed", "Ansteel runtime logger is closed");
		}
		const parentSpan = options.parent as
			| (AnsteelRuntimeSpan & { readonly openTelemetrySpan?: OpenTelemetrySpan })
			| undefined;
		const parentContext =
			parentSpan?.openTelemetrySpan === undefined
				? ROOT_CONTEXT
				: trace.setSpan(ROOT_CONTEXT, parentSpan.openTelemetrySpan);
		const openTelemetrySpan = tracer.startSpan(eventName, undefined, parentContext);
		const spanContext = openTelemetrySpan.spanContext();
		const parentSpanId = options.parent?.spanId;
		const { parent: _parent, message, data, ...fields } = options;
		write({
			level: "info",
			eventName,
			outcome: "started",
			...fields,
			spanId: spanContext.spanId,
			...(parentSpanId === undefined ? {} : { parentSpanId }),
			message: message ?? `${eventName} started`,
			data: data ?? {},
		});
		let ended = false;
		const runtimeSpan: AnsteelRuntimeSpan & { readonly openTelemetrySpan: OpenTelemetrySpan } = {
			traceId: spanContext.traceId,
			spanId: spanContext.spanId,
			...(parentSpanId === undefined ? {} : { parentSpanId }),
			openTelemetrySpan,
			end(input) {
				if (ended) {
					throw new AnsteelObservabilityError(
						"event-chain-invalid",
						`Ansteel runtime span ${eventName} already ended`,
					);
				}
				ended = true;
				pendingEnds.set(spanContext.spanId, { eventName, fields, parentSpanId, input });
				openTelemetrySpan.setStatus({
					code: input.outcome === "failed" ? SpanStatusCode.ERROR : SpanStatusCode.OK,
					message: input.message,
				});
				openTelemetrySpan.end();
			},
		};
		return runtimeSpan;
	};

	return {
		context,
		write,
		startSpan,
		forceFlush: () => provider.forceFlush(),
		close() {
			if (closed) return;
			try {
				fsyncSync(fd);
			} finally {
				try {
					closeSync(fd);
				} finally {
					closed = true;
					releaseRunLock();
				}
			}
		},
	};
}
