import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type Span as OpenTelemetrySpan, ROOT_CONTEXT, SpanStatusCode, trace } from "@opentelemetry/api";
import {
	BasicTracerProvider,
	type ReadableSpan,
	SimpleSpanProcessor,
	type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import lockfile from "proper-lockfile";
import { canonicalizeAnsteelAuditValue, hashAnsteelAuditValue } from "./ansteel-team-integrity.ts";

const ANSTEEL_RUNTIME_LOG_LOCK_STALE_MS = 300_000;
const ANSTEEL_RUNTIME_LOG_LOCK_UPDATE_MS = 10_000;
const ANSTEEL_RUNTIME_INDEX_LOCK_STALE_MS = 300_000;
const ANSTEEL_RUNTIME_INDEX_LOCK_UPDATE_MS = 10_000;
const ANSTEEL_RUNTIME_INDEX_SCHEMA_VERSION = 1;

const ANSTEEL_RUNTIME_INDEX_SELECTOR_FIELDS = [
	"traceId",
	"taskId",
	"checkpointId",
	"issueId",
	"toolCallId",
	"providerRequestId",
	"processId",
	"leaseId",
	"causeEventId",
	"eventName",
] as const;

type AnsteelRuntimeIndexSelectorField = (typeof ANSTEEL_RUNTIME_INDEX_SELECTOR_FIELDS)[number];

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

export interface AnsteelRuntimeRecoveryResult {
	runId: string;
	abandonedSpanCount: number;
	previousHeadHash: string | null;
	recoveredHeadHash: string | null;
}

interface AnsteelRuntimeIndexSegment {
	fileName: string;
	sha256: string;
}

interface AnsteelRuntimeIndexRun {
	runId: string;
	segments: AnsteelRuntimeIndexSegment[];
	logChainHeadHash: string | null;
}

interface AnsteelRuntimeIndexUnsigned {
	schemaVersion: typeof ANSTEEL_RUNTIME_INDEX_SCHEMA_VERSION;
	runs: Record<string, AnsteelRuntimeIndexRun>;
	associations: Record<string, string[]>;
}

interface AnsteelRuntimeIndex extends AnsteelRuntimeIndexUnsigned {
	indexHash: string;
}

/**
 * A strict verification result. Unlike list/trace, this path never rebuilds a
 * damaged index: callers use it before creating an external audit anchor.
 */
export interface AnsteelRuntimeLogIntegrity {
	indexHash: string;
	runCount: number;
	segmentCount: number;
}

/** A content-addressed snapshot receipt for runtime evidence at anchor time. */
export interface AnsteelRuntimeAnchorSnapshotReceipt {
	indexHash: string;
	snapshotHash: string;
}

interface AnsteelRuntimeAnchorSnapshotUnsigned {
	schemaVersion: 1;
	runtimeLogIndexHash: string;
	indexContent: string;
	segmentByteLengths: Array<{
		fileName: string;
		byteLength: number;
	}>;
}

interface AnsteelRuntimeAnchorSnapshot extends AnsteelRuntimeAnchorSnapshotUnsigned {
	snapshotHash: string;
}

type AnsteelRuntimeIndexRebuildReason =
	| "missing"
	| "json-invalid"
	| "schema-invalid"
	| "hash-invalid"
	| "log-state-mismatch";

class AnsteelRuntimeIndexRebuildRequired extends Error {
	readonly rebuildReason: AnsteelRuntimeIndexRebuildReason;

	constructor(rebuildReason: AnsteelRuntimeIndexRebuildReason, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "AnsteelRuntimeIndexRebuildRequired";
		this.rebuildReason = rebuildReason;
	}
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

export function getAnsteelRuntimeIndexPath(cwd: string): string {
	return join(getAnsteelTeamRuntimeDirectory(cwd), "run-index.json");
}

/** Stored outside mutable index rotation paths under its own content hash. */
export function getAnsteelRuntimeAnchorSnapshotPath(cwd: string, snapshotHash: string): string {
	if (!/^[0-9a-f]{64}$/i.test(snapshotHash)) {
		throw new AnsteelObservabilityError(
			"unclassified-runtime-error",
			"Ansteel runtime anchor snapshot hash is invalid",
		);
	}
	return join(getAnsteelTeamRuntimeDirectory(cwd), "anchor-index-snapshots", `${snapshotHash.toLowerCase()}.json`);
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

/**
 * Remove credentials before text crosses either the runtime-log boundary or
 * the public collaboration/UI boundary. The assignment rule accepts `=` and
 * `:` plus quoted JSON keys/values; scheme credentials are handled first so an
 * `Authorization: Basic <value>` suffix cannot survive a shorter key match.
 */
export function redactAnsteelSensitiveText(value: string): string {
	return value
		.replace(
			/((?:"|')?([A-Za-z_][A-Za-z0-9_-]*)(?:"|')?\s*[:=]\s*)((?:Bearer|Basic)\s+[^\s"',;}\]]+|"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
			(match, prefix: string, key: string) => (SENSITIVE_FIELD.test(key) ? `${prefix}[REDACTED]` : match),
		)
		.replace(/\b(Bearer|Basic)\s+[^\s"',;}\]]+/gi, "$1 [REDACTED]")
		.replace(/\bsk-[A-Za-z0-9._-]+\b/g, "sk-[REDACTED]");
}

export function redactAnsteelSensitiveValue(value: unknown, seen = new WeakSet<object>()): unknown {
	if (typeof value === "string") return redactAnsteelSensitiveText(value);
	if (Array.isArray(value)) return value.map((item) => redactAnsteelSensitiveValue(item, seen));
	if (typeof value !== "object" || value === null) return value;
	if (seen.has(value)) return "[Circular]";
	seen.add(value);
	const result = Object.create(null) as Record<string, unknown>;
	for (const [key, entry] of Object.entries(value)) {
		result[key] = SENSITIVE_FIELD.test(key) ? "[REDACTED]" : redactAnsteelSensitiveValue(entry, seen);
	}
	return result;
}

function redactRecord(value: Record<string, unknown>): Record<string, unknown> {
	return redactAnsteelSensitiveValue(value) as Record<string, unknown>;
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
	const content = redactAnsteelSensitiveText(artifact.content);
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
	const candidateNames = readdirSync(directory).filter((name) => name.startsWith(prefix) && name.endsWith(".jsonl"));
	const segmentNamePattern = new RegExp(`^run-${runId}-\\d{4}\\.jsonl$`, "i");
	if (candidateNames.some((name) => !segmentNamePattern.test(name))) {
		throw new AnsteelObservabilityError(
			"event-chain-invalid",
			`Ansteel runtime run ${runId} contains a log segment outside the indexed namespace`,
		);
	}
	const paths = candidateNames.sort().map((name) => join(directory, name));
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function getRuntimeLogSegments(cwd: string): Map<string, string[]> {
	const directory = getAnsteelRuntimeLogDirectory(cwd);
	const segments = new Map<string, string[]>();
	if (!existsSync(directory)) return segments;
	for (const fileName of readdirSync(directory).sort()) {
		const candidate = /^run-(RUN-[0-9a-f-]{36})-(.+)\.jsonl$/i.exec(fileName);
		if (candidate?.[1] !== undefined && !/^\d{4}$/.test(candidate[2] ?? "")) {
			throw new AnsteelObservabilityError(
				"event-chain-invalid",
				`Ansteel runtime run ${candidate[1]} contains a log segment outside the indexed namespace`,
			);
		}
		const match = /^run-(RUN-[0-9a-f-]{36})-(\d{4})\.jsonl$/i.exec(fileName);
		if (!match?.[1]) continue;
		const path = join(directory, fileName);
		// A logger creates its segment before the first record. Empty active
		// segments are not historical runs and are indexed after their first fsync.
		if (statSync(path).size === 0) continue;
		const runSegments = segments.get(match[1]);
		if (runSegments === undefined) segments.set(match[1], [fileName]);
		else runSegments.push(fileName);
	}
	return segments;
}

function hashRuntimeIndexSelector(field: AnsteelRuntimeIndexSelectorField, value: string): string {
	return createHash("sha256").update(`${field}\0${value}`, "utf8").digest("hex");
}

function getRuntimeEntrySelector(
	entry: AnsteelRuntimeLogEntry,
	field: AnsteelRuntimeIndexSelectorField,
): string | undefined {
	return field === "eventName" ? entry.eventName : entry[field];
}

function createRuntimeIndexRun(
	cwd: string,
	runId: string,
	fileNames: readonly string[],
): { run: AnsteelRuntimeIndexRun; entries: AnsteelRuntimeLogEntry[] } {
	const entries = readAnsteelRuntimeLogs(cwd, runId);
	if (entries.length === 0) {
		throw new AnsteelObservabilityError(
			"event-chain-invalid",
			`Ansteel runtime run ${runId} has persisted segments without any valid records`,
		);
	}
	const directory = getAnsteelRuntimeLogDirectory(cwd);
	return {
		run: {
			runId,
			segments: [...fileNames].sort().map((fileName) => ({
				fileName,
				sha256: createHash("sha256")
					.update(readFileSync(join(directory, fileName)))
					.digest("hex"),
			})),
			logChainHeadHash: entries.at(-1)?.hash ?? null,
		},
		entries,
	};
}

function normalizeRuntimeIndexUnsigned(
	runs: Record<string, AnsteelRuntimeIndexRun>,
	associations: Record<string, string[]>,
): AnsteelRuntimeIndexUnsigned {
	const normalizedRuns: Record<string, AnsteelRuntimeIndexRun> = {};
	for (const runId of Object.keys(runs).sort()) {
		const run = runs[runId]!;
		normalizedRuns[runId] = {
			runId,
			segments: [...run.segments]
				.sort((left, right) => left.fileName.localeCompare(right.fileName))
				.map((segment) => ({ fileName: segment.fileName, sha256: segment.sha256 })),
			logChainHeadHash: run.logChainHeadHash,
		};
	}
	const normalizedAssociations: Record<string, string[]> = {};
	for (const selectorHash of Object.keys(associations).sort()) {
		normalizedAssociations[selectorHash] = [...new Set(associations[selectorHash])].sort();
	}
	return {
		schemaVersion: ANSTEEL_RUNTIME_INDEX_SCHEMA_VERSION,
		runs: normalizedRuns,
		associations: normalizedAssociations,
	};
}

function signRuntimeIndex(unsigned: AnsteelRuntimeIndexUnsigned): AnsteelRuntimeIndex {
	const normalized = normalizeRuntimeIndexUnsigned(unsigned.runs, unsigned.associations);
	return {
		...normalized,
		indexHash: createHash("sha256").update(JSON.stringify(normalized), "utf8").digest("hex"),
	};
}

function buildRuntimeIndex(cwd: string): AnsteelRuntimeIndex {
	const runs: Record<string, AnsteelRuntimeIndexRun> = {};
	const associationSets = new Map<string, Set<string>>();
	for (const [runId, fileNames] of [...getRuntimeLogSegments(cwd).entries()].sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		const indexedRun = createRuntimeIndexRun(cwd, runId, fileNames);
		runs[runId] = indexedRun.run;
		for (const entry of indexedRun.entries) {
			for (const field of ANSTEEL_RUNTIME_INDEX_SELECTOR_FIELDS) {
				const value = getRuntimeEntrySelector(entry, field);
				if (value === undefined) continue;
				const selectorHash = hashRuntimeIndexSelector(field, value);
				const runIds = associationSets.get(selectorHash);
				if (runIds === undefined) associationSets.set(selectorHash, new Set([runId]));
				else runIds.add(runId);
			}
		}
	}
	const associations = Object.fromEntries(
		[...associationSets.entries()].map(([selectorHash, runIds]) => [selectorHash, [...runIds]]),
	);
	return signRuntimeIndex({
		schemaVersion: ANSTEEL_RUNTIME_INDEX_SCHEMA_VERSION,
		runs,
		associations,
	});
}

function parseRuntimeIndex(cwd: string): AnsteelRuntimeIndex {
	const path = getAnsteelRuntimeIndexPath(cwd);
	if (!existsSync(path)) {
		throw new AnsteelRuntimeIndexRebuildRequired("missing", "Ansteel runtime index is missing");
	}
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new AnsteelRuntimeIndexRebuildRequired("json-invalid", "Ansteel runtime index is not valid JSON", {
			cause: error,
		});
	}
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["schemaVersion", "runs", "associations", "indexHash"]) ||
		value.schemaVersion !== ANSTEEL_RUNTIME_INDEX_SCHEMA_VERSION
	) {
		throw new AnsteelRuntimeIndexRebuildRequired("schema-invalid", "Ansteel runtime index has an unsupported schema");
	}
	if (
		!isRecord(value.runs) ||
		!isRecord(value.associations) ||
		typeof value.indexHash !== "string" ||
		!/^[0-9a-f]{64}$/.test(value.indexHash)
	) {
		throw new AnsteelRuntimeIndexRebuildRequired("schema-invalid", "Ansteel runtime index shape is invalid");
	}
	const runs: Record<string, AnsteelRuntimeIndexRun> = {};
	for (const [runId, rawRun] of Object.entries(value.runs)) {
		try {
			assertRunId(runId);
		} catch (error) {
			throw new AnsteelRuntimeIndexRebuildRequired(
				"schema-invalid",
				"Ansteel runtime index contains an invalid run ID",
				{ cause: error },
			);
		}
		if (
			!isRecord(rawRun) ||
			!hasExactKeys(rawRun, ["runId", "segments", "logChainHeadHash"]) ||
			rawRun.runId !== runId ||
			!Array.isArray(rawRun.segments) ||
			(rawRun.logChainHeadHash !== null &&
				(typeof rawRun.logChainHeadHash !== "string" || !/^[0-9a-f]{64}$/.test(rawRun.logChainHeadHash)))
		) {
			throw new AnsteelRuntimeIndexRebuildRequired(
				"schema-invalid",
				"Ansteel runtime index contains an invalid run record",
			);
		}
		const segments = rawRun.segments.map((rawSegment) => {
			if (
				!isRecord(rawSegment) ||
				!hasExactKeys(rawSegment, ["fileName", "sha256"]) ||
				typeof rawSegment.fileName !== "string" ||
				!new RegExp(`^run-${runId}-\\d{4}\\.jsonl$`, "i").test(rawSegment.fileName) ||
				typeof rawSegment.sha256 !== "string" ||
				!/^[0-9a-f]{64}$/.test(rawSegment.sha256)
			) {
				throw new AnsteelRuntimeIndexRebuildRequired(
					"schema-invalid",
					"Ansteel runtime index contains an invalid segment record",
				);
			}
			return { fileName: rawSegment.fileName, sha256: rawSegment.sha256 };
		});
		runs[runId] = {
			runId,
			segments,
			logChainHeadHash: rawRun.logChainHeadHash as string | null,
		};
	}
	const associations: Record<string, string[]> = {};
	for (const [selectorHash, rawRunIds] of Object.entries(value.associations)) {
		if (
			!/^[0-9a-f]{64}$/.test(selectorHash) ||
			!Array.isArray(rawRunIds) ||
			rawRunIds.some((runId) => typeof runId !== "string" || runs[runId] === undefined)
		) {
			throw new AnsteelRuntimeIndexRebuildRequired(
				"schema-invalid",
				"Ansteel runtime index contains an invalid association",
			);
		}
		associations[selectorHash] = rawRunIds as string[];
	}
	const signed = signRuntimeIndex({
		schemaVersion: ANSTEEL_RUNTIME_INDEX_SCHEMA_VERSION,
		runs,
		associations,
	});
	if (signed.indexHash !== value.indexHash) {
		throw new AnsteelRuntimeIndexRebuildRequired("hash-invalid", "Ansteel runtime index hash does not match");
	}
	return signed;
}

function writeRuntimeIndexAtomic(cwd: string, index: AnsteelRuntimeIndex): void {
	const path = getAnsteelRuntimeIndexPath(cwd);
	const directory = getAnsteelTeamRuntimeDirectory(cwd);
	mkdirSync(directory, { recursive: true });
	const temporaryPath = join(directory, `.run-index-${process.pid}-${randomUUID()}.tmp`);
	try {
		writeNewDurableFile(temporaryPath, `${JSON.stringify(index)}\n`);
		renameSync(temporaryPath, path);
	} catch (error) {
		throw new AnsteelObservabilityError(
			"event-fsync-failed",
			"Ansteel runtime index could not be atomically replaced",
			{ cause: error },
		);
	} finally {
		if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
	}
}

interface PendingRuntimeIndexRebuildAudit {
	runId: string;
	traceId: string;
	spanId: string;
	rebuildReason: AnsteelRuntimeIndexRebuildReason;
	rebuiltAt: string;
	sourceRunCount: number;
	startHash: string;
}

function startRuntimeIndexRebuildAudit(
	cwd: string,
	rebuildReason: AnsteelRuntimeIndexRebuildReason,
	sourceRunCount: number,
): PendingRuntimeIndexRebuildAudit {
	const rebuiltAt = new Date().toISOString();
	const runId = `RUN-${randomUUID()}`;
	const traceId = randomBytes(16).toString("hex");
	const spanId = randomBytes(8).toString("hex");
	const unsigned = {
		schemaVersion: 1 as const,
		timestampUtc: rebuiltAt,
		monotonicElapsedNs: "0",
		sequence: 1,
		level: "audit" as const,
		eventName: "runtime-index-rebuilt",
		outcome: "started" as const,
		runId,
		traceId,
		spanId,
		teamId: "ansteel-runtime-index",
		role: "coordinator" as const,
		message: "Ansteel runtime index rebuild started from verified runtime logs",
		data: {
			rebuildReason,
			rebuiltAt,
			sourceRunCount,
		},
		artifactRefs: [],
		previousHash: null,
	};
	const entry: AnsteelRuntimeLogEntry = { ...unsigned, hash: hashRuntimeLogEntry(unsigned) };
	mkdirSync(getAnsteelRuntimeLogDirectory(cwd), { recursive: true });
	try {
		writeNewDurableFile(getAnsteelRuntimeLogPath(cwd, runId), `${JSON.stringify(entry)}\n`);
	} catch (error) {
		throw new AnsteelObservabilityError(
			"event-fsync-failed",
			"Ansteel runtime index rebuild audit could not be started",
			{ cause: error },
		);
	}
	return { runId, traceId, spanId, rebuildReason, rebuiltAt, sourceRunCount, startHash: entry.hash };
}

function completeRuntimeIndexRebuildAudit(
	cwd: string,
	audit: PendingRuntimeIndexRebuildAudit,
	rebuiltIndexHash: string,
): void {
	const unsigned = {
		schemaVersion: 1 as const,
		timestampUtc: new Date().toISOString(),
		monotonicElapsedNs: "0",
		sequence: 2,
		level: "audit" as const,
		eventName: "runtime-index-rebuilt",
		outcome: "succeeded" as const,
		runId: audit.runId,
		traceId: audit.traceId,
		spanId: audit.spanId,
		teamId: "ansteel-runtime-index",
		role: "coordinator" as const,
		message: "Ansteel runtime index was mechanically rebuilt from verified runtime logs",
		data: {
			rebuildReason: audit.rebuildReason,
			rebuiltAt: audit.rebuiltAt,
			sourceRunCount: audit.sourceRunCount,
			rebuiltIndexHash,
		},
		artifactRefs: [],
		previousHash: audit.startHash,
	};
	const entry: AnsteelRuntimeLogEntry = { ...unsigned, hash: hashRuntimeLogEntry(unsigned) };
	const path = getAnsteelRuntimeLogPath(cwd, audit.runId);
	let fd: number | undefined;
	try {
		fd = openSync(path, "a");
		writeBuffer(fd, Buffer.from(`${JSON.stringify(entry)}\n`, "utf8"));
		fsyncSync(fd);
	} catch (error) {
		throw new AnsteelObservabilityError(
			"event-fsync-failed",
			"Ansteel runtime index rebuild audit could not be completed",
			{ cause: error },
		);
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function assertRuntimeHistoryContainsIndexedHeads(cwd: string, index: AnsteelRuntimeIndex): void {
	const actualSegments = getRuntimeLogSegments(cwd);
	for (const run of Object.values(index.runs)) {
		if (actualSegments.get(run.runId) === undefined) {
			throw new AnsteelObservabilityError(
				"event-chain-invalid",
				`No verifiable historical runtime run exists because every indexed segment for ${run.runId} is missing`,
			);
		}
		if (run.logChainHeadHash === null) continue;
		const entries = readAnsteelRuntimeLogs(cwd, run.runId);
		if (!entries.some((entry) => entry.hash === run.logChainHeadHash)) {
			throw new AnsteelObservabilityError(
				"event-chain-invalid",
				`Ansteel runtime history for ${run.runId} no longer contains its indexed chain head`,
			);
		}
	}
}

function validateRuntimeIndexAgainstLogs(cwd: string, index: AnsteelRuntimeIndex): void {
	const actual = buildRuntimeIndex(cwd);
	if (actual.indexHash !== index.indexHash) {
		assertRuntimeHistoryContainsIndexedHeads(cwd, index);
		throw new AnsteelRuntimeIndexRebuildRequired(
			"log-state-mismatch",
			"Ansteel runtime index does not match the verified runtime logs",
		);
	}
}

function validateRuntimeIndexSegmentSet(cwd: string, index: AnsteelRuntimeIndex): void {
	const actual = [...getRuntimeLogSegments(cwd).values()].flat().sort();
	const indexed = Object.values(index.runs)
		.flatMap((run) => run.segments.map((segment) => segment.fileName))
		.sort();
	if (JSON.stringify(actual) !== JSON.stringify(indexed)) {
		assertRuntimeHistoryContainsIndexedHeads(cwd, index);
		throw new AnsteelRuntimeIndexRebuildRequired(
			"log-state-mismatch",
			"Ansteel runtime log segment set does not match its index",
		);
	}
	const directory = getAnsteelRuntimeLogDirectory(cwd);
	for (const run of Object.values(index.runs)) {
		for (const segment of run.segments) {
			const actualHash = createHash("sha256")
				.update(readFileSync(join(directory, segment.fileName)))
				.digest("hex");
			if (actualHash !== segment.sha256) {
				assertRuntimeHistoryContainsIndexedHeads(cwd, index);
				throw new AnsteelRuntimeIndexRebuildRequired(
					"log-state-mismatch",
					"Ansteel runtime log segment hash does not match its index",
				);
			}
		}
	}
}

function readOrRebuildRuntimeIndexLocked(cwd: string, fullValidation: boolean): AnsteelRuntimeIndex {
	try {
		const index = parseRuntimeIndex(cwd);
		if (fullValidation) validateRuntimeIndexAgainstLogs(cwd, index);
		else validateRuntimeIndexSegmentSet(cwd, index);
		return index;
	} catch (error) {
		if (!(error instanceof AnsteelRuntimeIndexRebuildRequired)) throw error;
		const rebuilt = buildRuntimeIndex(cwd);
		if (error.rebuildReason === "missing" && Object.keys(rebuilt.runs).length === 0) {
			writeRuntimeIndexAtomic(cwd, rebuilt);
			return rebuilt;
		}
		const audit = startRuntimeIndexRebuildAudit(cwd, error.rebuildReason, Object.keys(rebuilt.runs).length);
		const started = buildRuntimeIndex(cwd);
		writeRuntimeIndexAtomic(cwd, started);
		completeRuntimeIndexRebuildAudit(cwd, audit, started.indexHash);
		const completed = buildRuntimeIndex(cwd);
		writeRuntimeIndexAtomic(cwd, completed);
		return completed;
	}
}

/**
 * Verify every indexed segment and every in-segment hash chain without the
 * normal recovery behavior. A missing, altered, or stale index is evidence of
 * an integrity failure here, not an invitation to silently regenerate it.
 */
export function verifyAnsteelRuntimeLogIntegrity(cwd: string): AnsteelRuntimeLogIntegrity {
	return withRuntimeIndexLock(cwd, () => {
		try {
			const index = parseRuntimeIndex(cwd);
			validateRuntimeIndexAgainstLogs(cwd, index);
			return {
				indexHash: index.indexHash,
				runCount: Object.keys(index.runs).length,
				segmentCount: Object.values(index.runs).reduce((count, run) => count + run.segments.length, 0),
			};
		} catch (error) {
			if (error instanceof AnsteelRuntimeIndexRebuildRequired) {
				throw new AnsteelObservabilityError(
					"event-chain-invalid",
					`Ansteel runtime log integrity verification failed: ${error.message}`,
					{ cause: error },
				);
			}
			throw error;
		}
	});
}

interface AnsteelRuntimeAnchorSnapshotSegment {
	runId: string;
	fileName: string;
	sha256: string;
	logChainHeadHash: string | null;
}

function throwRuntimeAnchorSnapshotError(message: string): never {
	throw new AnsteelObservabilityError("event-chain-invalid", `Ansteel runtime anchor snapshot ${message}`);
}

function parseRuntimeAnchorSnapshotIndex(
	indexContent: string,
	expectedIndexHash: string,
): AnsteelRuntimeAnchorSnapshotSegment[] {
	let value: unknown;
	try {
		value = JSON.parse(indexContent);
	} catch {
		return throwRuntimeAnchorSnapshotError("contains invalid indexed runtime evidence");
	}
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["schemaVersion", "runs", "associations", "indexHash"]) ||
		value.schemaVersion !== ANSTEEL_RUNTIME_INDEX_SCHEMA_VERSION ||
		value.indexHash !== expectedIndexHash ||
		!isRecord(value.runs) ||
		!isRecord(value.associations)
	) {
		return throwRuntimeAnchorSnapshotError("does not match the anchored runtime index");
	}
	const segments: AnsteelRuntimeAnchorSnapshotSegment[] = [];
	for (const [runId, rawRun] of Object.entries(value.runs)) {
		try {
			assertRunId(runId);
		} catch {
			return throwRuntimeAnchorSnapshotError("contains an invalid runtime run");
		}
		if (
			!isRecord(rawRun) ||
			!hasExactKeys(rawRun, ["runId", "segments", "logChainHeadHash"]) ||
			rawRun.runId !== runId ||
			!Array.isArray(rawRun.segments) ||
			(rawRun.logChainHeadHash !== null &&
				(typeof rawRun.logChainHeadHash !== "string" || !/^[0-9a-f]{64}$/i.test(rawRun.logChainHeadHash)))
		) {
			return throwRuntimeAnchorSnapshotError("contains an invalid indexed runtime run");
		}
		for (const rawSegment of rawRun.segments) {
			if (
				!isRecord(rawSegment) ||
				!hasExactKeys(rawSegment, ["fileName", "sha256"]) ||
				typeof rawSegment.fileName !== "string" ||
				!new RegExp(`^run-${runId}-\\d{4}\\.jsonl$`, "i").test(rawSegment.fileName) ||
				typeof rawSegment.sha256 !== "string" ||
				!/^[0-9a-f]{64}$/i.test(rawSegment.sha256)
			) {
				return throwRuntimeAnchorSnapshotError("contains an invalid indexed runtime segment");
			}
			segments.push({
				runId,
				fileName: rawSegment.fileName,
				sha256: rawSegment.sha256,
				logChainHeadHash: rawRun.logChainHeadHash,
			});
		}
	}
	return segments.sort((left, right) => left.fileName.localeCompare(right.fileName));
}

function parseRuntimeAnchorSnapshot(
	content: string,
	expectedIndexHash: string,
	expectedSnapshotHash?: string,
): { snapshot: AnsteelRuntimeAnchorSnapshot; segments: AnsteelRuntimeAnchorSnapshotSegment[] } {
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch {
		return throwRuntimeAnchorSnapshotError("file is not valid JSON");
	}
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"schemaVersion",
			"runtimeLogIndexHash",
			"indexContent",
			"segmentByteLengths",
			"snapshotHash",
		]) ||
		value.schemaVersion !== 1 ||
		value.runtimeLogIndexHash !== expectedIndexHash ||
		typeof value.indexContent !== "string" ||
		!Array.isArray(value.segmentByteLengths) ||
		typeof value.snapshotHash !== "string" ||
		!/^[0-9a-f]{64}$/i.test(value.snapshotHash)
	) {
		return throwRuntimeAnchorSnapshotError("has an invalid schema");
	}
	const segmentByteLengths = value.segmentByteLengths.map((entry) => {
		if (
			!isRecord(entry) ||
			!hasExactKeys(entry, ["fileName", "byteLength"]) ||
			typeof entry.fileName !== "string" ||
			typeof entry.byteLength !== "number" ||
			!Number.isSafeInteger(entry.byteLength) ||
			entry.byteLength < 0
		) {
			return throwRuntimeAnchorSnapshotError("has an invalid segment boundary");
		}
		return { fileName: entry.fileName, byteLength: entry.byteLength };
	});
	const unsigned: AnsteelRuntimeAnchorSnapshotUnsigned = {
		schemaVersion: 1,
		runtimeLogIndexHash: expectedIndexHash,
		indexContent: value.indexContent,
		segmentByteLengths,
	};
	const computedSnapshotHash = hashAnsteelAuditValue(unsigned);
	if (
		computedSnapshotHash !== value.snapshotHash ||
		(expectedSnapshotHash !== undefined && computedSnapshotHash !== expectedSnapshotHash)
	) {
		return throwRuntimeAnchorSnapshotError("hash does not match the anchored receipt");
	}
	const segments = parseRuntimeAnchorSnapshotIndex(value.indexContent, expectedIndexHash);
	const expectedFiles = segments.map((segment) => segment.fileName);
	const actualFiles = segmentByteLengths.map((segment) => segment.fileName).sort();
	if (
		new Set(actualFiles).size !== actualFiles.length ||
		JSON.stringify(actualFiles) !== JSON.stringify([...expectedFiles].sort())
	) {
		return throwRuntimeAnchorSnapshotError("segment boundaries do not match the anchored index");
	}
	return {
		snapshot: { ...unsigned, snapshotHash: computedSnapshotHash },
		segments,
	};
}

function validateRuntimeAnchorSnapshotHistory(
	cwd: string,
	snapshot: AnsteelRuntimeAnchorSnapshot,
	segments: readonly AnsteelRuntimeAnchorSnapshotSegment[],
): void {
	const lengths = new Map(snapshot.segmentByteLengths.map((segment) => [segment.fileName, segment.byteLength]));
	const directory = getAnsteelRuntimeLogDirectory(cwd);
	for (const segment of segments) {
		const path = join(directory, segment.fileName);
		if (!existsSync(path)) throwRuntimeAnchorSnapshotError(`segment ${segment.fileName} is missing`);
		const content = readFileSync(path);
		const byteLength = lengths.get(segment.fileName)!;
		if (content.length < byteLength) {
			throwRuntimeAnchorSnapshotError(`segment ${segment.fileName} was truncated after anchoring`);
		}
		const prefixHash = createHash("sha256").update(content.subarray(0, byteLength)).digest("hex");
		if (prefixHash !== segment.sha256) {
			throwRuntimeAnchorSnapshotError(`segment ${segment.fileName} no longer has its anchored prefix`);
		}
	}
	const segmentsByRun = new Map<string, AnsteelRuntimeAnchorSnapshotSegment[]>();
	for (const segment of segments) {
		const runSegments = segmentsByRun.get(segment.runId);
		if (runSegments === undefined) segmentsByRun.set(segment.runId, [segment]);
		else runSegments.push(segment);
	}
	for (const [runId, runSegments] of segmentsByRun) {
		const head = runSegments[0]?.logChainHeadHash;
		if (head === null || head === undefined) continue;
		let entries: AnsteelRuntimeLogEntry[];
		try {
			entries = readAnsteelRuntimeLogs(cwd, runId);
		} catch (error) {
			throw new AnsteelObservabilityError(
				"event-chain-invalid",
				`Ansteel runtime anchor snapshot cannot verify ${runId}`,
				{ cause: error },
			);
		}
		if (!entries.some((entry) => entry.hash === head)) {
			throwRuntimeAnchorSnapshotError(`run ${runId} no longer contains its anchored chain head`);
		}
	}
}

/**
 * Captures the strict current runtime index into an immutable, content-addressed
 * local snapshot. The returned hash is included in the remote anchor receipt.
 */
export function captureAnsteelRuntimeAnchorSnapshot(
	cwd: string,
	expectedIndexHash: string,
): AnsteelRuntimeAnchorSnapshotReceipt {
	if (!/^[0-9a-f]{64}$/i.test(expectedIndexHash)) {
		throw new AnsteelObservabilityError("event-chain-invalid", "Ansteel runtime anchor index hash is invalid");
	}
	return withRuntimeIndexLock(cwd, () => {
		let index: AnsteelRuntimeIndex;
		try {
			index = parseRuntimeIndex(cwd);
			validateRuntimeIndexAgainstLogs(cwd, index);
		} catch (error) {
			if (error instanceof AnsteelRuntimeIndexRebuildRequired) {
				throw new AnsteelObservabilityError(
					"event-chain-invalid",
					`Ansteel runtime log integrity verification failed: ${error.message}`,
					{ cause: error },
				);
			}
			throw error;
		}
		if (index.indexHash !== expectedIndexHash) {
			throw new AnsteelObservabilityError(
				"event-chain-invalid",
				"Ansteel runtime index changed while creating an anchor snapshot",
			);
		}
		const indexContent = readFileSync(getAnsteelRuntimeIndexPath(cwd), "utf8");
		const segments = parseRuntimeAnchorSnapshotIndex(indexContent, expectedIndexHash);
		const segmentByteLengths = segments.map((segment) => {
			const content = readFileSync(join(getAnsteelRuntimeLogDirectory(cwd), segment.fileName));
			if (createHash("sha256").update(content).digest("hex") !== segment.sha256) {
				throwRuntimeAnchorSnapshotError(`segment ${segment.fileName} changed while creating the snapshot`);
			}
			return { fileName: segment.fileName, byteLength: content.length };
		});
		const unsigned: AnsteelRuntimeAnchorSnapshotUnsigned = {
			schemaVersion: 1,
			runtimeLogIndexHash: expectedIndexHash,
			indexContent,
			segmentByteLengths,
		};
		const snapshot: AnsteelRuntimeAnchorSnapshot = {
			...unsigned,
			snapshotHash: hashAnsteelAuditValue(unsigned),
		};
		const path = getAnsteelRuntimeAnchorSnapshotPath(cwd, snapshot.snapshotHash);
		mkdirSync(dirname(path), { recursive: true });
		const content = canonicalizeAnsteelAuditValue(snapshot);
		if (!existsSync(path)) {
			try {
				writeNewDurableFile(path, content);
			} catch (error) {
				if (!existsSync(path)) {
					throw new AnsteelObservabilityError(
						"event-fsync-failed",
						"Ansteel runtime anchor snapshot could not be persisted",
						{ cause: error },
					);
				}
			}
		}
		const persisted = parseRuntimeAnchorSnapshot(
			readFileSync(path, "utf8"),
			expectedIndexHash,
			snapshot.snapshotHash,
		);
		validateRuntimeAnchorSnapshotHistory(cwd, persisted.snapshot, persisted.segments);
		return { indexHash: expectedIndexHash, snapshotHash: snapshot.snapshotHash };
	});
}

/** Replays the immutable runtime evidence captured by one remote anchor receipt. */
export function verifyAnsteelRuntimeAnchorSnapshot(
	cwd: string,
	expectedIndexHash: string,
	expectedSnapshotHash: string,
): void {
	if (!/^[0-9a-f]{64}$/i.test(expectedIndexHash) || !/^[0-9a-f]{64}$/i.test(expectedSnapshotHash)) {
		throw new AnsteelObservabilityError("event-chain-invalid", "Ansteel runtime anchor receipt hashes are invalid");
	}
	withRuntimeIndexLock(cwd, () => {
		const path = getAnsteelRuntimeAnchorSnapshotPath(cwd, expectedSnapshotHash);
		if (!existsSync(path)) throwRuntimeAnchorSnapshotError("file is missing");
		const parsed = parseRuntimeAnchorSnapshot(readFileSync(path, "utf8"), expectedIndexHash, expectedSnapshotHash);
		validateRuntimeAnchorSnapshotHistory(cwd, parsed.snapshot, parsed.segments);
	});
}

function replaceRuntimeIndexRunLocked(cwd: string, index: AnsteelRuntimeIndex, runId: string): AnsteelRuntimeIndex {
	const fileNames = getRuntimeLogSegments(cwd).get(runId);
	if (fileNames === undefined) {
		throw new AnsteelObservabilityError(
			"event-chain-invalid",
			`Ansteel runtime run ${runId} has no durable log segment after a write`,
		);
	}
	const indexedRun = createRuntimeIndexRun(cwd, runId, fileNames);
	const runs = { ...index.runs, [runId]: indexedRun.run };
	const associations: Record<string, string[]> = {};
	for (const [selectorHash, indexedRunIds] of Object.entries(index.associations)) {
		const retainedRunIds = indexedRunIds.filter((indexedRunId) => indexedRunId !== runId);
		if (retainedRunIds.length > 0) associations[selectorHash] = retainedRunIds;
	}
	for (const entry of indexedRun.entries) {
		for (const field of ANSTEEL_RUNTIME_INDEX_SELECTOR_FIELDS) {
			const value = getRuntimeEntrySelector(entry, field);
			if (value === undefined) continue;
			const selectorHash = hashRuntimeIndexSelector(field, value);
			const runIds = associations[selectorHash] ?? [];
			if (!runIds.includes(runId)) runIds.push(runId);
			associations[selectorHash] = runIds;
		}
	}
	return signRuntimeIndex({
		schemaVersion: ANSTEEL_RUNTIME_INDEX_SCHEMA_VERSION,
		runs,
		associations,
	});
}

function withRuntimeIndexLock<T>(cwd: string, action: () => T): T {
	const path = getAnsteelRuntimeIndexPath(cwd);
	mkdirSync(getAnsteelTeamRuntimeDirectory(cwd), { recursive: true });
	let releaseIndexLock: (() => void) | undefined;
	try {
		releaseIndexLock = lockfile.lockSync(path, {
			realpath: false,
			stale: ANSTEEL_RUNTIME_INDEX_LOCK_STALE_MS,
			update: ANSTEEL_RUNTIME_INDEX_LOCK_UPDATE_MS,
		});
	} catch (error) {
		throw new AnsteelObservabilityError("event-fsync-failed", "Ansteel runtime index lock could not be acquired", {
			cause: error,
		});
	}
	try {
		return action();
	} finally {
		releaseIndexLock();
	}
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
	terminalOutcome?: AnsteelRuntimeLogEntry["outcome"];
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

function getRuntimeTerminalOutcome(
	entries: readonly AnsteelRuntimeLogEntry[],
): AnsteelRuntimeLogEntry["outcome"] | undefined {
	const rootStarts = entries.filter(
		(entry) => entry.eventName === "run.started" && entry.outcome === "started" && entry.parentSpanId === undefined,
	);
	if (rootStarts.length !== 1) return undefined;
	const rootStart = rootStarts[0]!;
	const terminals = entries.filter(
		(entry) =>
			entry.sequence > rootStart.sequence &&
			entry.eventName === rootStart.eventName &&
			entry.spanId === rootStart.spanId &&
			entry.parentSpanId === rootStart.parentSpanId &&
			(entry.outcome === "succeeded" ||
				entry.outcome === "failed" ||
				entry.outcome === "cancelled" ||
				entry.outcome === "abandoned"),
	);
	return terminals.length === 1 ? terminals[0]!.outcome : undefined;
}

export function listAnsteelRuntimeRuns(cwd: string): AnsteelRuntimeRunSummary[] {
	return withRuntimeIndexLock(cwd, () => {
		const index = readOrRebuildRuntimeIndexLocked(cwd, true);
		return Object.keys(index.runs)
			.map((runId) => {
				const entries = readAnsteelRuntimeLogs(cwd, runId);
				const first = entries[0];
				const last = entries.at(-1);
				const terminalOutcome = getRuntimeTerminalOutcome(entries);
				return {
					runId,
					...(first?.traceId === undefined ? {} : { traceId: first.traceId }),
					...(first?.teamId === undefined ? {} : { teamId: first.teamId }),
					...(first?.timestampUtc === undefined ? {} : { startedAt: first.timestampUtc }),
					...(last?.timestampUtc === undefined ? {} : { endedAt: last.timestampUtc }),
					entryCount: entries.length,
					...(last?.outcome === undefined ? {} : { lastOutcome: last.outcome }),
					...(terminalOutcome === undefined ? {} : { terminalOutcome }),
				};
			})
			.sort(
				(left, right) =>
					(left.startedAt ?? "").localeCompare(right.startedAt ?? "") || left.runId.localeCompare(right.runId),
			);
	});
}

export function traceAnsteelTeamRuntime(cwd: string, selector: string): AnsteelRuntimeLogEntry[] {
	const normalized = selector.trim();
	if (normalized.length === 0) {
		throw new AnsteelObservabilityError("unclassified-runtime-error", "Ansteel runtime trace selector is required");
	}
	return withRuntimeIndexLock(cwd, () => {
		// The signed index and every referenced segment hash are verified first;
		// only candidate runs are then parsed and chain-validated.
		const index = readOrRebuildRuntimeIndexLocked(cwd, false);
		const candidateRunIds = new Set<string>();
		if (index.runs[normalized] !== undefined) candidateRunIds.add(normalized);
		for (const field of ANSTEEL_RUNTIME_INDEX_SELECTOR_FIELDS) {
			for (const runId of index.associations[hashRuntimeIndexSelector(field, normalized)] ?? []) {
				candidateRunIds.add(runId);
			}
		}
		const results: AnsteelRuntimeLogEntry[] = [];
		for (const runId of candidateRunIds) {
			const entries = readAnsteelRuntimeLogs(cwd, runId);
			if (runId === normalized || entries[0]?.traceId === normalized) {
				results.push(...entries);
				continue;
			}
			results.push(
				...entries.filter((entry) =>
					ANSTEEL_RUNTIME_INDEX_SELECTOR_FIELDS.some(
						(field) => getRuntimeEntrySelector(entry, field) === normalized,
					),
				),
			);
		}
		return results.sort(
			(left, right) =>
				left.timestampUtc.localeCompare(right.timestampUtc) ||
				left.runId.localeCompare(right.runId) ||
				left.sequence - right.sequence,
		);
	});
}

function getOrphanedRuntimeSpans(entries: readonly AnsteelRuntimeLogEntry[]): AnsteelRuntimeLogEntry[] {
	const openSpans = new Map<string, AnsteelRuntimeLogEntry[]>();
	for (const entry of entries) {
		const key = `${entry.spanId}\0${entry.eventName}\0${entry.parentSpanId ?? ""}`;
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

export async function abandonOrphanedAnsteelTeamRun(cwd: string, runId: string): Promise<AnsteelRuntimeRecoveryResult> {
	const observedEntries = readAnsteelRuntimeLogs(cwd, runId);
	const observedHeadHash = observedEntries.at(-1)?.hash ?? null;
	if (getOrphanedRuntimeSpans(observedEntries).length === 0) {
		return {
			runId,
			abandonedSpanCount: 0,
			previousHeadHash: observedHeadHash,
			recoveredHeadHash: observedHeadHash,
		};
	}
	const first = observedEntries[0]!;
	const logger = createAnsteelRuntimeLogger(cwd, {
		runId,
		traceId: first.traceId,
		teamId: first.teamId,
		command: typeof first.data.command === "string" ? first.data.command : "recovered interrupted command",
		startedAt: first.timestampUtc,
	});
	let abandonedSpanCount = 0;
	let previousHeadHash = observedHeadHash;
	let recoveredHeadHash = observedHeadHash;
	try {
		// The run lock is now held. Re-read the chain so recovery never appends
		// from a stale sequence/hash snapshot.
		const lockedEntries = readAnsteelRuntimeLogs(cwd, runId);
		previousHeadHash = lockedEntries.at(-1)?.hash ?? null;
		const orphanedSpans = getOrphanedRuntimeSpans(lockedEntries);
		if (orphanedSpans.length === 0) {
			recoveredHeadHash = previousHeadHash;
			return {
				runId,
				abandonedSpanCount: 0,
				previousHeadHash,
				recoveredHeadHash,
			};
		}
		abandonedSpanCount = orphanedSpans.length;
		for (const start of orphanedSpans) {
			const recovered = logger.write({
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
			recoveredHeadHash = recovered.hash;
		}
		await logger.forceFlush();
	} finally {
		logger.close();
	}
	return {
		runId,
		abandonedSpanCount,
		previousHeadHash,
		recoveredHeadHash,
	};
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
	const runLockPath = getAnsteelRuntimeLogPath(cwd, context.runId);
	let releaseRunLock: (() => void) | undefined;
	try {
		releaseRunLock = lockfile.lockSync(runLockPath, {
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
		const lastSegment = getRuntimeLogSegments(cwd).get(context.runId)?.at(-1);
		const appendPath = lastSegment === undefined ? runLockPath : join(directory, lastSegment);
		fd = openSync(appendPath, "a");
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
			message: redactAnsteelSensitiveText(input.message),
			data: redactRecord(data),
			artifactRefs,
			previousHash,
		};
		const entry: AnsteelRuntimeLogEntry = { ...unsigned, hash: hashRuntimeLogEntry(unsigned) };
		withRuntimeIndexLock(cwd, () => {
			const index = readOrRebuildRuntimeIndexLocked(cwd, false);
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
			// The record is already durable. Advance the in-process chain even
			// when the subsequent index replacement fails so a retry cannot
			// duplicate its sequence or previousHash.
			sequence++;
			previousHash = entry.hash;
			writeRuntimeIndexAtomic(cwd, replaceRuntimeIndexRunLocked(cwd, index, context.runId));
		});
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
