import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as nodeFs from "node:fs";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmdirSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { arch, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { type Span as OpenTelemetrySpan, ROOT_CONTEXT, SpanStatusCode, trace } from "@opentelemetry/api";
import {
	BasicTracerProvider,
	type ReadableSpan,
	SimpleSpanProcessor,
	type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import lockfile from "proper-lockfile";
import { type TSchema, Type } from "typebox";
import { Compile } from "typebox/compile";
import { VERSION } from "../config.ts";
import { canonicalizeAnsteelAuditValue, hashAnsteelAuditValue } from "./ansteel-team-integrity.ts";

const ANSTEEL_RUNTIME_LOG_LOCK_STALE_MS = 300_000;
const ANSTEEL_RUNTIME_LOG_LOCK_UPDATE_MS = 10_000;
const ANSTEEL_RUNTIME_INDEX_LOCK_STALE_MS = 300_000;
const ANSTEEL_RUNTIME_INDEX_LOCK_UPDATE_MS = 10_000;
const ANSTEEL_RUNTIME_LEASE_AUDIT_GATE_STALE_MS = 30_000;
const ANSTEEL_RUNTIME_LEASE_AUDIT_GATE_UPDATE_MS = 5_000;
const ANSTEEL_RUNTIME_LOCK_CONTENTION_TIMEOUT_MS = 5_000;
const ANSTEEL_RUNTIME_LOCK_CONTENTION_RETRY_MS = 10;
const ANSTEEL_RUNTIME_INDEX_SCHEMA_VERSION = 1;
const ANSTEEL_TEAM_EXTENSION_VERSION = "3.3";
const ANSTEEL_RUNTIME_GIT_TIMEOUT_MS = 5_000;
const ANSTEEL_RUNTIME_DIAGNOSTIC_COMMAND = /^(?:board|status|trace|doctor|incident)(?:\s|$)/;
const ANSTEEL_RUNTIME_LOCK_OWNER_SCHEMA_VERSION = 1;
export const ANSTEEL_RUNTIME_EVENT_CATALOG_VERSION = 1 as const;

interface AnsteelRuntimeLockOwner {
	schemaVersion: typeof ANSTEEL_RUNTIME_LOCK_OWNER_SCHEMA_VERSION;
	ownerId: string;
	pid: number;
	processStartedAtUtc: string;
	executableHash: string;
	commandHash: string;
	workingDirectoryHash: string;
	lockKind: "index" | "run" | "audit-gate";
	acquiredAtUtc: string;
}

const CURRENT_PROCESS_STARTED_AT_UTC = new Date(Date.now() - process.uptime() * 1000).toISOString();
const ANSTEEL_RUNTIME_LOCK_RETRY_SIGNAL = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function isAnsteelRuntimeLockContention(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		String((error as { code?: unknown }).code) === "ELOCKED"
	);
}

/**
 * proper-lockfile 的同步 API 不支持 retries。这里使用单调时钟和 Atomics.wait 做很短的同步等待，
 * 只吸收另一个进程正在完成 fsync、索引替换或 lease 释放回执的正常竞争窗口。等待有明确上限，
 * 超时后仍把原始 ELOCKED 交给上层失败关闭；因此真实泄漏、活 owner 或权限问题不会被掩盖。
 */
function waitForAnsteelRuntimeLockRetry(deadline: number): boolean {
	const remainingMs = deadline - performance.now();
	if (remainingMs <= 0) return false;
	Atomics.wait(
		ANSTEEL_RUNTIME_LOCK_RETRY_SIGNAL,
		0,
		0,
		Math.min(ANSTEEL_RUNTIME_LOCK_CONTENTION_RETRY_MS, remainingMs),
	);
	return true;
}

function acquireAnsteelRuntimeAuditGate(gatePath: string, deadline: number): () => void {
	for (;;) {
		let release: (() => void) | undefined;
		try {
			release = lockfile.lockSync(gatePath, {
				realpath: false,
				stale: ANSTEEL_RUNTIME_LEASE_AUDIT_GATE_STALE_MS,
				update: ANSTEEL_RUNTIME_LEASE_AUDIT_GATE_UPDATE_MS,
			});
		} catch (error) {
			if (!isAnsteelRuntimeLockContention(error)) throw error;
			// 宿主可能在“已取得门、尚未完成索引或 lease 回执”时被强杀。审计门也写入和
			// run/index 锁相同强度的私有 owner 记录；只有 PID 明确不存在时才提前删除空锁目录。
			// 无 owner、元数据损坏、活 PID 或权限不确定仍继续视为被占用，最终有界失败关闭。
			if (recoverDeadAnsteelRuntimeLock(gatePath, "audit-gate") !== undefined) continue;
			if (!waitForAnsteelRuntimeLockRetry(deadline)) throw error;
			continue;
		}

		const owner = createAnsteelRuntimeLockOwner("audit-gate");
		const ownerPath = getAnsteelRuntimeLockOwnerPath(gatePath);
		try {
			if (existsSync(ownerPath)) unlinkSync(ownerPath);
			writeNewDurableFile(ownerPath, `${JSON.stringify(owner)}\n`);
		} catch (error) {
			release();
			throw error;
		}
		let released = false;
		return () => {
			if (released) return;
			try {
				// Remove this identity while the OS lock is still held. Releasing first lets the next gate owner
				// replace the sidecar between our read and unlink, which can either raise ENOENT or delete its identity.
				const currentOwner = readAnsteelRuntimeLockOwner(gatePath);
				if (currentOwner?.ownerId === owner.ownerId) unlinkSync(ownerPath);
			} finally {
				release!();
				released = true;
			}
		};
	}
}

function getAnsteelRuntimeLockOwnerPath(path: string): string {
	return `${path}.lock-owner.json`;
}

function getAnsteelRuntimeLockDirectoryPath(path: string): string {
	return `${path}.lock`;
}

function getAnsteelRuntimeLeaseAuditGatePath(path: string): string {
	return `${path}.lease-audit-gate`;
}

function createAnsteelRuntimeLockOwner(lockKind: AnsteelRuntimeLockOwner["lockKind"]): AnsteelRuntimeLockOwner {
	return {
		schemaVersion: ANSTEEL_RUNTIME_LOCK_OWNER_SCHEMA_VERSION,
		ownerId: randomUUID(),
		pid: process.pid,
		processStartedAtUtc: CURRENT_PROCESS_STARTED_AT_UTC,
		executableHash: hashAnsteelAuditValue(process.execPath),
		commandHash: hashAnsteelAuditValue(process.argv),
		workingDirectoryHash: hashAnsteelAuditValue(process.cwd()),
		lockKind,
		acquiredAtUtc: new Date().toISOString(),
	};
}

function parseAnsteelRuntimeLockOwner(value: unknown): AnsteelRuntimeLockOwner | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const owner = value as Record<string, unknown>;
	if (
		owner.schemaVersion !== ANSTEEL_RUNTIME_LOCK_OWNER_SCHEMA_VERSION ||
		typeof owner.ownerId !== "string" ||
		!Number.isSafeInteger(owner.pid) ||
		(owner.pid as number) <= 0 ||
		typeof owner.processStartedAtUtc !== "string" ||
		Number.isNaN(Date.parse(owner.processStartedAtUtc)) ||
		typeof owner.executableHash !== "string" ||
		!/^[0-9a-f]{64}$/.test(owner.executableHash) ||
		typeof owner.commandHash !== "string" ||
		!/^[0-9a-f]{64}$/.test(owner.commandHash) ||
		typeof owner.workingDirectoryHash !== "string" ||
		!/^[0-9a-f]{64}$/.test(owner.workingDirectoryHash) ||
		(owner.lockKind !== "index" && owner.lockKind !== "run" && owner.lockKind !== "audit-gate") ||
		typeof owner.acquiredAtUtc !== "string" ||
		Number.isNaN(Date.parse(owner.acquiredAtUtc))
	) {
		return undefined;
	}
	return owner as unknown as AnsteelRuntimeLockOwner;
}

function isProcessDefinitelyAbsent(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			String((error as { code?: unknown }).code) === "ESRCH"
		);
	}
}

/**
 * 进程崩溃后，proper-lockfile 的锁目录可能一直残留到 stale 周期结束。
 * 只有协调器写入的 owner 记录格式完整，并且操作系统能够明确证明记录的 PID
 * 已不存在时，才允许提前回收该锁。PID 仍存活或被复用、元数据缺失、访问被拒绝、
 * owner 记录损坏等情况一律保持锁定，避免把“不确定”误判为“无人占用”。
 */
function readAnsteelRuntimeLockOwner(path: string): AnsteelRuntimeLockOwner | undefined {
	const ownerPath = getAnsteelRuntimeLockOwnerPath(path);
	if (!existsSync(ownerPath)) return undefined;
	try {
		return parseAnsteelRuntimeLockOwner(JSON.parse(readFileSync(ownerPath, "utf8")));
	} catch {
		return undefined;
	}
}

function recoverDeadAnsteelRuntimeLock(
	path: string,
	lockKind: AnsteelRuntimeLockOwner["lockKind"],
): AnsteelRuntimeLockOwner | undefined {
	const ownerPath = getAnsteelRuntimeLockOwnerPath(path);
	const lockDirectoryPath = getAnsteelRuntimeLockDirectoryPath(path);
	if (!existsSync(ownerPath) || !existsSync(lockDirectoryPath)) return undefined;
	const owner = readAnsteelRuntimeLockOwner(path);
	if (owner?.lockKind !== lockKind || !isProcessDefinitelyAbsent(owner.pid)) return undefined;
	try {
		// proper-lockfile 按契约只拥有一个空锁目录。这里故意拒绝递归删除：
		// 一旦目录中出现意外文件或上游格式变化，恢复动作必须失败关闭，不能扩大删除范围。
		rmdirSync(lockDirectoryPath);
		unlinkSync(ownerPath);
		return owner;
	} catch {
		return undefined;
	}
}

interface AnsteelRuntimeLockReleaseReceipt {
	releasedAtUtc: string;
	renewalCount: number;
}

interface AnsteelRuntimeLockHandle {
	owner: AnsteelRuntimeLockOwner;
	previousOwner?: AnsteelRuntimeLockOwner;
	resourceHash: string;
	assertOwned(): void;
	setRenewedListener(listener: (renewedAtUtc: string, renewalCount: number) => void): void;
	release(onReleased?: (receipt: AnsteelRuntimeLockReleaseReceipt) => void): void;
}

function acquireAnsteelRuntimeLock(
	path: string,
	lockKind: AnsteelRuntimeLockOwner["lockKind"],
	stale: number,
	update: number,
): AnsteelRuntimeLockHandle {
	const deadline = performance.now() + ANSTEEL_RUNTIME_LOCK_CONTENTION_TIMEOUT_MS;
	for (;;) {
		let owned = false;
		let renewalCount = 0;
		let renewedListener: ((renewedAtUtc: string, renewalCount: number) => void) | undefined;
		let compromisedError: Error | undefined;
		const leaseFs = {
			...nodeFs,
			utimesSync(target: nodeFs.PathLike, atime: string | number | Date, mtime: string | number | Date): void {
				nodeFs.utimesSync(target, atime, mtime);
				if (!owned) return;
				renewalCount++;
				const completedRenewalCount = renewalCount;
				const renewedAtUtc = new Date().toISOString();
				queueMicrotask(() => renewedListener?.(renewedAtUtc, completedRenewalCount));
			},
		};
		const acquire = (): (() => void) =>
			lockfile.lockSync(path, {
				realpath: false,
				stale,
				update,
				fs: leaseFs,
				onCompromised(error) {
					owned = false;
					compromisedError = error;
				},
			});
		// 所有协作写入者在替换 owner 旁路文件或释放 run 锁前，都必须通过这个短生命周期审计门。
		// 它封住“旧 owner 已释放操作系统锁，但释放回执尚未持久化”的竞态窗口，防止新 owner
		// 在缺少可追溯交接事实时接管同一条运行链。
		const gatePath = getAnsteelRuntimeLeaseAuditGatePath(path);
		let releaseAuditGate: (() => void) | undefined;
		let retryContention = false;
		let contentionError: unknown;
		try {
			releaseAuditGate = acquireAnsteelRuntimeAuditGate(gatePath, deadline);
			const previousOwner = readAnsteelRuntimeLockOwner(path);
			let release: (() => void) | undefined;
			try {
				release = acquire();
			} catch (error) {
				if (!isAnsteelRuntimeLockContention(error) || recoverDeadAnsteelRuntimeLock(path, lockKind) === undefined) {
					throw error;
				}
				release = acquire();
			}
			owned = true;
			const ownerPath = getAnsteelRuntimeLockOwnerPath(path);
			const owner = createAnsteelRuntimeLockOwner(lockKind);
			try {
				if (existsSync(ownerPath)) unlinkSync(ownerPath);
				writeNewDurableFile(ownerPath, `${JSON.stringify(owner)}\n`);
			} catch (error) {
				owned = false;
				release();
				throw error;
			}
			let released = false;
			return {
				owner,
				...(previousOwner === undefined || previousOwner.ownerId === owner.ownerId ? {} : { previousOwner }),
				resourceHash: hashAnsteelAuditValue(resolve(path).replace(/\\/g, "/")),
				assertOwned() {
					if (!owned || compromisedError !== undefined) {
						throw new AnsteelObservabilityError(
							"lease-owner-mismatch",
							"Ansteel runtime lease is no longer owned by this writer",
							compromisedError === undefined ? undefined : { cause: compromisedError },
						);
					}
				},
				setRenewedListener(listener) {
					renewedListener = listener;
				},
				release(onReleased) {
					if (released) return;
					const releaseGate = acquireAnsteelRuntimeAuditGate(
						gatePath,
						performance.now() + ANSTEEL_RUNTIME_LOCK_CONTENTION_TIMEOUT_MS,
					);
					try {
						if (!owned || compromisedError !== undefined) {
							throw new AnsteelObservabilityError(
								"lease-owner-mismatch",
								"Ansteel runtime lease cannot be released because ownership was lost",
								compromisedError === undefined ? undefined : { cause: compromisedError },
							);
						}
						// 只有操作系统锁实际消失后，才允许生成成功释放回执。回执 fsync 完成前持续持有
						// 审计门，因此新 owner 不可能插入“锁已释放”和“回执已落盘”两个事实之间。
						release!();
						owned = false;
						released = true;
						const receipt = { releasedAtUtc: new Date().toISOString(), renewalCount };
						onReleased?.(receipt);
						const currentOwner = readAnsteelRuntimeLockOwner(path);
						if (currentOwner?.ownerId === owner.ownerId) unlinkSync(getAnsteelRuntimeLockOwnerPath(path));
					} finally {
						releaseGate();
					}
				},
			};
		} catch (error) {
			// 资源锁被另一个活进程持有时，绝不能拿着审计门等待：旧 owner 释放资源也必须
			// 经过同一扇门。这里只记录需要重试，finally 先释放门，再在循环尾部短暂等待，
			// 从结构上排除“竞争者持门等资源、owner 持资源等门”的跨进程死锁。
			if (isAnsteelRuntimeLockContention(error) && performance.now() < deadline) {
				retryContention = true;
				contentionError = error;
			} else throw error;
		} finally {
			releaseAuditGate?.();
		}
		if (!retryContention || !waitForAnsteelRuntimeLockRetry(deadline)) {
			throw contentionError;
		}
	}
}

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
	"secret-detected",
	"no-governed-progress",
	"coordinator-restarted",
	"unclassified-runtime-error",
] as const;

export type AnsteelRuntimeReasonCode = (typeof ANSTEEL_RUNTIME_REASON_CODES)[number];

export type AnsteelRuntimeOutcome = "started" | "progress" | "succeeded" | "failed" | "cancelled" | "abandoned";

export const ANSTEEL_PROTOCOL_RUNTIME_EVENT_NAMES = [
	"run.started",
	"run.resumed",
	"run.completed",
	"run.failed",
	"role.session.started",
	"role.session.output",
	"role.session.truncated",
	"role.session.ended",
	"provider.request.started",
	"provider.request.retry",
	"provider.request.completed",
	"tool.call.started",
	"tool.call.progress",
	"tool.call.completed",
	"process.spawned",
	"process.heartbeat",
	"process.exited",
	"process.orphan-detected",
	"state.transition.attempted",
	"state.transition.applied",
	"state.transition.rejected",
	"lease.acquired",
	"lease.renewed",
	"lease.expired",
	"lease.released",
	"event.appended",
	"event.fsync.completed",
	"event.chain.invalid",
	"artifact.stored",
	"artifact.verified",
	"artifact.missing",
	"budget.reserved",
	"budget.consumed",
	"budget.exhausted",
	"security.access-denied",
	"security.redaction-applied",
	"security.secret-detected",
] as const;

const ANSTEEL_RUNTIME_SPAN_OUTCOMES = ["started", "succeeded", "failed", "cancelled", "abandoned"] as const;
const ANSTEEL_RUNTIME_TERMINAL_OUTCOMES = ["succeeded", "failed", "cancelled", "abandoned"] as const;

/**
 * v1 事件目录是强制白名单，不是说明性文档。它同时覆盖协议规定的 37 个事件和已经跨越
 * 持久化边界的稳定内部事件。新增事件名必须显式修改目录与测试，防止拼写错误或临时杜撰的
 * 遥测字段静默进入审计证据。
 */
export const ANSTEEL_RUNTIME_EVENT_CATALOG = {
	"run.started": ["started"],
	"run.resumed": ["progress"],
	"run.completed": ["succeeded"],
	"run.failed": ["failed", "cancelled", "abandoned"],
	"role.session.started": ["started"],
	"role.session.output": ["progress"],
	"role.session.truncated": ["progress", "failed"],
	"role.session.ended": ANSTEEL_RUNTIME_TERMINAL_OUTCOMES,
	"provider.request.started": ["started"],
	"provider.request.retry": ["progress"],
	"provider.request.completed": ANSTEEL_RUNTIME_TERMINAL_OUTCOMES,
	"tool.call.started": ["started"],
	"tool.call.progress": ["progress"],
	"tool.call.completed": ANSTEEL_RUNTIME_TERMINAL_OUTCOMES,
	"process.spawned": ["started"],
	"process.heartbeat": ["progress"],
	"process.exited": ANSTEEL_RUNTIME_TERMINAL_OUTCOMES,
	"process.orphan-detected": ["abandoned"],
	"state.transition.attempted": ["progress"],
	"state.transition.applied": ["succeeded"],
	"state.transition.rejected": ["failed"],
	"lease.acquired": ["succeeded"],
	"lease.renewed": ["progress"],
	"lease.expired": ["failed"],
	"lease.released": ["succeeded"],
	"event.appended": ["succeeded"],
	"event.fsync.completed": ["succeeded"],
	"event.chain.invalid": ["failed"],
	"artifact.stored": ["succeeded"],
	"artifact.verified": ["succeeded"],
	"artifact.missing": ["failed"],
	"budget.reserved": ["progress"],
	"budget.consumed": ["progress"],
	"budget.exhausted": ["failed"],
	"security.access-denied": ["failed"],
	"security.redaction-applied": ["succeeded"],
	"security.secret-detected": ["failed"],
	"runtime-index-rebuilt": ANSTEEL_RUNTIME_SPAN_OUTCOMES,
	"state.persisted": ["succeeded"],
	"transaction.persisted": ["succeeded"],
	"event.ledger.rewritten": ["succeeded"],
	"action.assess": ANSTEEL_RUNTIME_SPAN_OUTCOMES,
	"action.review": ANSTEEL_RUNTIME_SPAN_OUTCOMES,
	"checkpoint.publish": ANSTEEL_RUNTIME_SPAN_OUTCOMES,
	"milestone.collaboration.publish": ANSTEEL_RUNTIME_SPAN_OUTCOMES,
	"milestone.create": ANSTEEL_RUNTIME_SPAN_OUTCOMES,
	"milestone.final-verification.begin": ANSTEEL_RUNTIME_SPAN_OUTCOMES,
	"milestone.review": ANSTEEL_RUNTIME_SPAN_OUTCOMES,
	"milestone.submit": ANSTEEL_RUNTIME_SPAN_OUTCOMES,
	"process.issue": ANSTEEL_RUNTIME_SPAN_OUTCOMES,
	"process.resolve": ANSTEEL_RUNTIME_SPAN_OUTCOMES,
	"process.review": ANSTEEL_RUNTIME_SPAN_OUTCOMES,
	"task.claim": ANSTEEL_RUNTIME_SPAN_OUTCOMES,
	"task.claim.parallel": ANSTEEL_RUNTIME_SPAN_OUTCOMES,
	"task.collaboration.publish": ANSTEEL_RUNTIME_SPAN_OUTCOMES,
	"task.collaboration.return": ANSTEEL_RUNTIME_SPAN_OUTCOMES,
	"task.final-verification.begin": ANSTEEL_RUNTIME_SPAN_OUTCOMES,
	"task.review": ANSTEEL_RUNTIME_SPAN_OUTCOMES,
	"task.submit": ANSTEEL_RUNTIME_SPAN_OUTCOMES,
	// 这些通用 task 事件目前保留给确定性的日志段/索引夹具和后续任务进度接线；
	// 生产编排当前使用上方粒度更细的 task 操作 span，避免同一动作出现两套含义重叠的事实。
	"task.started": ["started"],
	"task.progress": ["progress"],
	"task.completed": ANSTEEL_RUNTIME_TERMINAL_OUTCOMES,
} as const satisfies Record<string, readonly AnsteelRuntimeOutcome[]>;

export type AnsteelRuntimeEventName = keyof typeof ANSTEEL_RUNTIME_EVENT_CATALOG;

const strictRuntimeDataObject = (properties: Record<string, TSchema>): TSchema =>
	Type.Object(properties, { additionalProperties: false });
const runtimeDataUnion = (...schemas: TSchema[]): TSchema => Type.Union(schemas);
const runtimeNonEmptyString = Type.String({ minLength: 1 });
const runtimeSha256 = Type.String({ pattern: "^[0-9a-f]{64}$" });
const runtimeUtcTimestamp = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
const runtimeInteger = Type.Integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER });
const runtimeNonNegativeInteger = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const runtimePositiveInteger = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const runtimeNonNegativeNumber = Type.Number({ minimum: 0 });
const runtimeNullableInteger = Type.Union([runtimeInteger, Type.Null()]);
const runtimeNullableNonNegativeInteger = Type.Union([runtimeNonNegativeInteger, Type.Null()]);
const runtimeNullableNonNegativeNumber = Type.Union([runtimeNonNegativeNumber, Type.Null()]);
const runtimeNullableString = Type.Union([runtimeNonEmptyString, Type.Null()]);
const runtimeEmptyData = strictRuntimeDataObject({});
const runtimeRecoveryData = strictRuntimeDataObject({
	recoveredFromSequence: runtimePositiveInteger,
	recoveredFromEventHash: runtimeSha256,
});
const runtimeCommandData = strictRuntimeDataObject({ command: runtimeNonEmptyString });
const runtimeExitCodeData = strictRuntimeDataObject({ exitCode: runtimeInteger });
const runtimeVerdictData = strictRuntimeDataObject({ verdict: runtimeNonEmptyString });
const runtimeRevisionData = strictRuntimeDataObject({ revision: runtimePositiveInteger });
const runtimeEnvironmentSchema = strictRuntimeDataObject({
	productVersion: runtimeNonEmptyString,
	extensionVersion: runtimeNonEmptyString,
	gitCommit: runtimeNullableString,
	configStatus: Type.Union([Type.Literal("missing"), Type.Literal("parsed"), Type.Literal("invalid")]),
	configFingerprint: runtimeSha256,
	featureFlags: Type.Record(
		Type.String(),
		Type.Union([
			Type.Boolean(),
			Type.Number(),
			runtimeNonEmptyString,
			Type.Array(runtimeNonEmptyString, { uniqueItems: true }),
		]),
	),
	nodeVersion: runtimeNonEmptyString,
	osPlatform: runtimeNonEmptyString,
	osRelease: runtimeNonEmptyString,
	architecture: runtimeNonEmptyString,
	projectRootId: runtimeSha256,
	enabledEnvironmentVariables: Type.Array(runtimeNonEmptyString, { uniqueItems: true }),
	environmentFingerprint: runtimeSha256,
});

const runtimeRunStartedData = strictRuntimeDataObject({
	command: runtimeNonEmptyString,
	runtimeEnvironment: runtimeEnvironmentSchema,
	resumedFromRunId: Type.Optional(runtimeNonEmptyString),
	resumedFromSequence: Type.Optional(runtimePositiveInteger),
});
const runtimeProviderRequestBaseFields = {
	requestRound: Type.Optional(runtimePositiveInteger),
	retryCount: Type.Optional(runtimeNonNegativeInteger),
	timeoutStage: Type.Optional(runtimeNonEmptyString),
	timeoutMs: Type.Optional(runtimeNonNegativeInteger),
	configurationIdentity: Type.Optional(runtimeNonEmptyString),
	provider: Type.Optional(runtimeNonEmptyString),
	model: Type.Optional(runtimeNonEmptyString),
};
const runtimeProviderRequestStartedData = strictRuntimeDataObject(runtimeProviderRequestBaseFields);
const runtimeProviderRequestCompletedData = strictRuntimeDataObject({
	...runtimeProviderRequestBaseFields,
	durationMs: Type.Optional(runtimeNonNegativeInteger),
	firstTokenLatencyMs: Type.Optional(runtimeNullableNonNegativeNumber),
	inputTokens: Type.Optional(runtimeNullableNonNegativeInteger),
	outputTokens: Type.Optional(runtimeNullableNonNegativeInteger),
	maxTokens: Type.Optional(runtimeNonNegativeInteger),
	tokenCountsAvailable: Type.Optional(Type.Boolean()),
	outputLength: Type.Optional(runtimeNonNegativeInteger),
	publicOutputEmpty: Type.Optional(Type.Boolean()),
	httpStatus: Type.Optional(Type.Union([Type.Integer({ minimum: 100, maximum: 599 }), Type.Null()])),
	sdkErrorCategory: Type.Optional(runtimeNullableString),
});
const runtimeToolCallBaseFields = {
	command: Type.Optional(runtimeNonEmptyString),
	toolName: Type.Optional(runtimeNonEmptyString),
	denialBoundary: Type.Optional(runtimeNonEmptyString),
};
const runtimeToolCallStartedData = strictRuntimeDataObject(runtimeToolCallBaseFields);
const runtimeToolCallCompletedData = strictRuntimeDataObject({
	...runtimeToolCallBaseFields,
	exitCode: Type.Optional(runtimeInteger),
	stdout: Type.Optional(Type.String()),
});
const runtimeProcessSpawnedData = strictRuntimeDataObject({
	pid: runtimePositiveInteger,
	policy: runtimeNonEmptyString,
	commandHash: runtimeSha256,
	cwdHash: runtimeSha256,
	shell: Type.Boolean(),
	argumentCount: runtimeNonNegativeInteger,
	timeoutMs: runtimePositiveInteger,
	maximumOutputBytes: runtimePositiveInteger,
	startedAt: runtimeUtcTimestamp,
});
const runtimeProcessProgressData = strictRuntimeDataObject({
	pid: runtimePositiveInteger,
	policy: runtimeNonEmptyString,
	elapsedMs: runtimeNonNegativeNumber,
	stdoutBytes: runtimeNonNegativeInteger,
	stderrBytes: runtimeNonNegativeInteger,
	lastProgressAt: runtimeUtcTimestamp,
});
const runtimeProcessExitedData = strictRuntimeDataObject({
	pid: runtimePositiveInteger,
	policy: runtimeNonEmptyString,
	commandHash: runtimeSha256,
	cwdHash: runtimeSha256,
	exitCode: runtimeNullableInteger,
	signal: runtimeNullableString,
	timedOut: Type.Boolean(),
	durationMs: runtimeNonNegativeNumber,
	lastProgressAt: runtimeUtcTimestamp,
	stdoutBytes: runtimeNonNegativeInteger,
	stderrBytes: runtimeNonNegativeInteger,
	stdoutTruncated: Type.Boolean(),
	stderrTruncated: Type.Boolean(),
	stdoutHash: runtimeSha256,
	stderrHash: runtimeSha256,
});
const runtimeTransitionData = strictRuntimeDataObject({
	transitionLogId: runtimeNonEmptyString,
	transitionId: runtimeNonEmptyString,
	objectKind: Type.Union([
		Type.Literal("team"),
		Type.Literal("role"),
		Type.Literal("challenge"),
		Type.Literal("task"),
		Type.Literal("milestone"),
		Type.Literal("checkpoint"),
		Type.Literal("process-issue"),
		Type.Literal("delivery-verification"),
	]),
	objectId: runtimeNonEmptyString,
	from: runtimeNullableString,
	to: runtimeNonEmptyString,
	guard: runtimeNonEmptyString,
	guardResult: Type.Boolean(),
	triggerEventId: runtimeNonEmptyString,
});
const runtimeArtifactStorageData = strictRuntimeDataObject({
	resourceKind: Type.Literal("content-addressed-artifact"),
	sourceSequence: runtimePositiveInteger,
	artifactKind: runtimeNonEmptyString,
	sha256: runtimeSha256,
	contentByteLength: runtimeNonNegativeInteger,
	storageResult: Type.Union([Type.Literal("created"), Type.Literal("deduplicated-and-verified")]),
});
const runtimeArtifactAuditData = strictRuntimeDataObject({
	resourceKind: Type.Literal("content-addressed-artifact"),
	sourceRunId: runtimeNonEmptyString,
	sourceSequence: runtimePositiveInteger,
	artifactKind: runtimeNonEmptyString,
	sha256: runtimeSha256,
	verificationResult: Type.Union([
		Type.Literal("verified"),
		Type.Literal("missing"),
		Type.Literal("hash-mismatch"),
		Type.Literal("unreadable"),
	]),
	actualHash: Type.Optional(runtimeSha256),
});
const runtimeSecurityRedactionData = strictRuntimeDataObject({
	sourceEventName: runtimeNonEmptyString,
	sourceSequence: runtimePositiveInteger,
	redactionBoundary: Type.Literal("runtime-persistence"),
	findingCount: runtimePositiveInteger,
	sensitiveFieldCount: runtimeNonNegativeInteger,
	sensitiveTextMatchCount: runtimeNonNegativeInteger,
	surfaces: Type.Array(Type.Union([Type.Literal("message"), Type.Literal("data"), Type.Literal("artifact")]), {
		minItems: 1,
		uniqueItems: true,
	}),
});
const runtimeBudgetBase = {
	resourceKind: Type.Literal("read-only-tool-calls"),
	used: runtimeNonNegativeInteger,
	limit: runtimeNonNegativeInteger,
	remaining: runtimeNonNegativeInteger,
};

/**
 * v1 data schema 目录与事件名称/结果目录共同构成持久化协议。每个对象默认拒绝未知字段；
 * 需要兼容多种真实生命周期形态时使用显式 union，不能用任意 Record 绕过版本治理。
 */
export const ANSTEEL_RUNTIME_EVENT_DATA_SCHEMAS = {
	"run.started": runtimeRunStartedData,
	"run.resumed": strictRuntimeDataObject({
		resumedFromRunId: runtimeNonEmptyString,
		resumedFromSequence: runtimePositiveInteger,
	}),
	"run.completed": runtimeCommandData,
	"run.failed": runtimeDataUnion(runtimeCommandData, runtimeRecoveryData),
	"role.session.started": runtimeEmptyData,
	"role.session.output": strictRuntimeDataObject({
		outputLength: runtimePositiveInteger,
		publicOutputEmpty: Type.Literal(false),
	}),
	"role.session.truncated": strictRuntimeDataObject({
		truncationBoundary: Type.Literal("provider-output"),
		stopReason: Type.Literal("length"),
		elapsedMs: Type.Optional(runtimeNonNegativeNumber),
	}),
	"role.session.ended": runtimeDataUnion(
		runtimeEmptyData,
		strictRuntimeDataObject({ outputLength: runtimePositiveInteger }),
		runtimeRecoveryData,
	),
	"provider.request.started": runtimeProviderRequestStartedData,
	"provider.request.retry": strictRuntimeDataObject({
		retryBoundary: Type.Literal("agent-session"),
		attempt: runtimePositiveInteger,
		maxAttempts: runtimePositiveInteger,
		delayMs: runtimeNonNegativeInteger,
	}),
	"provider.request.completed": runtimeDataUnion(runtimeProviderRequestCompletedData, runtimeRecoveryData),
	"tool.call.started": runtimeToolCallStartedData,
	"tool.call.progress": strictRuntimeDataObject({
		pid: runtimePositiveInteger,
		policy: runtimeNonEmptyString,
		elapsedMs: runtimeNonNegativeNumber,
		stdoutBytes: runtimeNonNegativeInteger,
		stderrBytes: runtimeNonNegativeInteger,
		lastProgressAt: runtimeUtcTimestamp,
		sourceEventName: Type.Literal("process.heartbeat"),
	}),
	"tool.call.completed": runtimeDataUnion(runtimeToolCallCompletedData, runtimeRecoveryData),
	"process.spawned": runtimeProcessSpawnedData,
	"process.heartbeat": runtimeProcessProgressData,
	"process.exited": runtimeDataUnion(runtimeProcessExitedData, runtimeRecoveryData),
	"process.orphan-detected": strictRuntimeDataObject({
		recoveredFromSequence: runtimePositiveInteger,
		recoveredFromEventHash: runtimeSha256,
		pid: Type.Union([runtimePositiveInteger, Type.Null()]),
	}),
	"state.transition.attempted": runtimeTransitionData,
	"state.transition.applied": runtimeTransitionData,
	"state.transition.rejected": runtimeTransitionData,
	"lease.acquired": strictRuntimeDataObject({
		resourceKind: Type.Literal("runtime-run"),
		resourceHash: runtimeSha256,
		lockKind: Type.Literal("run"),
		ownerPid: runtimePositiveInteger,
		ownerProcessStartedAtUtc: runtimeUtcTimestamp,
		ownerExecutableHash: runtimeSha256,
		ownerCommandHash: runtimeSha256,
		ownerWorkingDirectoryHash: runtimeSha256,
		acquiredAtUtc: runtimeUtcTimestamp,
		staleAfterMs: runtimePositiveInteger,
		renewEveryMs: runtimePositiveInteger,
		expiresAtUtc: runtimeUtcTimestamp,
	}),
	"lease.renewed": strictRuntimeDataObject({
		resourceKind: Type.Literal("runtime-run"),
		resourceHash: runtimeSha256,
		ownerPid: runtimePositiveInteger,
		renewedAtUtc: runtimeUtcTimestamp,
		renewalCount: runtimePositiveInteger,
		expiresAtUtc: runtimeUtcTimestamp,
	}),
	"lease.expired": strictRuntimeDataObject({
		resourceKind: Type.Literal("runtime-run"),
		resourceHash: runtimeSha256,
		lockKind: Type.Literal("run"),
		ownerPid: runtimePositiveInteger,
		ownerProcessStartedAtUtc: runtimeUtcTimestamp,
		ownerExecutableHash: runtimeSha256,
		ownerCommandHash: runtimeSha256,
		ownerWorkingDirectoryHash: runtimeSha256,
		acquiredAtUtc: runtimeUtcTimestamp,
		detectedAtUtc: runtimeUtcTimestamp,
		replacementLeaseId: runtimeNonEmptyString,
	}),
	"lease.released": strictRuntimeDataObject({
		resourceKind: Type.Literal("runtime-run"),
		resourceHash: runtimeSha256,
		ownerPid: runtimePositiveInteger,
		releasedAtUtc: runtimeUtcTimestamp,
		renewalCount: runtimeNonNegativeInteger,
		heldDurationMs: runtimeNonNegativeInteger,
	}),
	"event.appended": runtimeDataUnion(
		strictRuntimeDataObject({
			eventSequence: runtimePositiveInteger,
			eventType: runtimeNonEmptyString,
			eventHash: runtimeSha256,
		}),
		strictRuntimeDataObject({ eventSequence: runtimePositiveInteger, recovered: Type.Literal(true) }),
	),
	"event.fsync.completed": strictRuntimeDataObject({
		eventSequence: runtimePositiveInteger,
		recovered: Type.Optional(Type.Literal(true)),
	}),
	"event.chain.invalid": strictRuntimeDataObject({
		resourceKind: Type.Literal("runtime-log-chain"),
		sourceRunId: runtimeNonEmptyString,
		verificationBoundary: Type.Literal("diagnostic-target-read"),
	}),
	"artifact.stored": runtimeArtifactStorageData,
	"artifact.verified": runtimeDataUnion(runtimeArtifactStorageData, runtimeArtifactAuditData),
	"artifact.missing": runtimeDataUnion(
		strictRuntimeDataObject({
			resourceKind: Type.Literal("runtime-log"),
			sourceRunId: runtimeNonEmptyString,
			verificationResult: Type.Literal("missing"),
		}),
		runtimeArtifactAuditData,
	),
	"budget.reserved": strictRuntimeDataObject(runtimeBudgetBase),
	"budget.consumed": strictRuntimeDataObject({ ...runtimeBudgetBase, toolName: runtimeNonEmptyString }),
	"budget.exhausted": strictRuntimeDataObject({ ...runtimeBudgetBase, toolName: runtimeNonEmptyString }),
	"security.access-denied": strictRuntimeDataObject({
		sourceEventName: Type.Literal("tool.call.completed"),
		sourceSequence: runtimePositiveInteger,
		denialBoundary: runtimeNonEmptyString,
	}),
	"security.redaction-applied": runtimeSecurityRedactionData,
	"security.secret-detected": runtimeSecurityRedactionData,
	"runtime-index-rebuilt": runtimeDataUnion(
		strictRuntimeDataObject({
			rebuildReason: Type.Union([
				Type.Literal("missing"),
				Type.Literal("json-invalid"),
				Type.Literal("schema-invalid"),
				Type.Literal("hash-invalid"),
				Type.Literal("log-state-mismatch"),
			]),
			rebuiltAt: runtimeUtcTimestamp,
			sourceRunCount: runtimeNonNegativeInteger,
			rebuiltIndexHash: Type.Optional(runtimeSha256),
		}),
		runtimeRecoveryData,
	),
	"state.persisted": strictRuntimeDataObject({
		status: runtimeNonEmptyString,
		version: runtimePositiveInteger,
		nextEventSequence: runtimePositiveInteger,
	}),
	"transaction.persisted": strictRuntimeDataObject({ eventSequence: runtimePositiveInteger }),
	"event.ledger.rewritten": strictRuntimeDataObject({ eventCount: runtimeNonNegativeInteger }),
	"action.assess": runtimeDataUnion(strictRuntimeDataObject({ toolName: runtimeNonEmptyString }), runtimeRecoveryData),
	"action.review": runtimeDataUnion(
		strictRuntimeDataObject({
			verdict: runtimeNonEmptyString,
			actionKind: runtimeNonEmptyString,
			target: runtimeNonEmptyString,
		}),
		runtimeRecoveryData,
	),
	"checkpoint.publish": runtimeDataUnion(runtimeEmptyData, runtimeRecoveryData),
	"milestone.collaboration.publish": runtimeDataUnion(runtimeEmptyData, runtimeRecoveryData),
	"milestone.create": runtimeDataUnion(runtimeEmptyData, runtimeRecoveryData),
	"milestone.final-verification.begin": runtimeDataUnion(runtimeRevisionData, runtimeRecoveryData),
	"milestone.review": runtimeDataUnion(runtimeVerdictData, runtimeRecoveryData),
	"milestone.submit": runtimeDataUnion(runtimeEmptyData, runtimeRecoveryData),
	"process.issue": runtimeDataUnion(runtimeEmptyData, runtimeRecoveryData),
	"process.resolve": runtimeDataUnion(
		strictRuntimeDataObject({ outcome: runtimeNonEmptyString }),
		runtimeRecoveryData,
	),
	"process.review": runtimeDataUnion(runtimeVerdictData, runtimeRecoveryData),
	"task.claim": runtimeDataUnion(runtimeEmptyData, runtimeRecoveryData),
	"task.claim.parallel": runtimeDataUnion(
		strictRuntimeDataObject({
			taskIds: Type.Array(runtimeNonEmptyString, { minItems: 1, uniqueItems: true }),
		}),
		runtimeRecoveryData,
	),
	"task.collaboration.publish": runtimeDataUnion(runtimeEmptyData, runtimeRecoveryData),
	"task.collaboration.return": runtimeDataUnion(
		strictRuntimeDataObject({ reason: runtimeNonEmptyString }),
		runtimeRecoveryData,
	),
	"task.final-verification.begin": runtimeDataUnion(runtimeRevisionData, runtimeRecoveryData),
	"task.review": runtimeDataUnion(runtimeVerdictData, runtimeRecoveryData),
	"task.submit": runtimeDataUnion(runtimeEmptyData, runtimeRecoveryData),
	"task.started": runtimeDataUnion(runtimeEmptyData, runtimeCommandData),
	"task.progress": runtimeDataUnion(runtimeEmptyData, runtimeCommandData),
	"task.completed": runtimeDataUnion(runtimeEmptyData, runtimeExitCodeData, runtimeRecoveryData),
} as const satisfies Record<AnsteelRuntimeEventName, TSchema>;

const ANSTEEL_RUNTIME_EVENT_DATA_VALIDATORS = Object.fromEntries(
	Object.entries(ANSTEEL_RUNTIME_EVENT_DATA_SCHEMAS).map(([eventName, schema]) => [eventName, Compile(schema)]),
) as Record<AnsteelRuntimeEventName, ReturnType<typeof Compile>>;

const ANSTEEL_RUNTIME_RECOVERY_EVENT_NAMES = new Set<AnsteelRuntimeEventName>([
	"run.failed",
	"role.session.ended",
	"provider.request.completed",
	"tool.call.completed",
	"process.exited",
	"runtime-index-rebuilt",
	"action.assess",
	"action.review",
	"checkpoint.publish",
	"milestone.collaboration.publish",
	"milestone.create",
	"milestone.final-verification.begin",
	"milestone.review",
	"milestone.submit",
	"process.issue",
	"process.resolve",
	"process.review",
	"task.claim",
	"task.claim.parallel",
	"task.collaboration.publish",
	"task.collaboration.return",
	"task.final-verification.begin",
	"task.review",
	"task.submit",
	"task.completed",
]);

function assertRuntimeUtcTimestamp(value: unknown, field: string, eventName: string): void {
	if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
		throw new AnsteelObservabilityError(
			"event-chain-invalid",
			`Ansteel runtime event ${eventName} data field ${field} must be a canonical UTC timestamp`,
		);
	}
}

function assertAnsteelRuntimeEventData(eventName: string, outcome: string, data: unknown): void {
	const validator = ANSTEEL_RUNTIME_EVENT_DATA_VALIDATORS[eventName as AnsteelRuntimeEventName];
	if (validator === undefined || !validator.Check(data)) {
		const error = validator?.Errors(data)[0];
		const path = error?.instancePath ? error.instancePath.replace(/^\//, "data.").replace(/\//g, ".") : "data";
		throw new AnsteelObservabilityError(
			"event-chain-invalid",
			`Ansteel runtime event ${eventName} data schema rejects ${path}${error === undefined ? "" : `: ${error.message}`}`,
		);
	}
	const record = data as Record<string, unknown>;
	const hasRecoveryReceipt = Object.hasOwn(record, "recoveredFromSequence");
	if (ANSTEEL_RUNTIME_RECOVERY_EVENT_NAMES.has(eventName as AnsteelRuntimeEventName)) {
		if ((outcome === "abandoned") !== hasRecoveryReceipt) {
			throw new AnsteelObservabilityError(
				"event-chain-invalid",
				`Ansteel runtime event ${eventName} data recovery receipt does not match outcome ${outcome}`,
			);
		}
	}
	if (eventName === "run.started") {
		const hasResumedRun = Object.hasOwn(record, "resumedFromRunId");
		const hasResumedSequence = Object.hasOwn(record, "resumedFromSequence");
		if (hasResumedRun !== hasResumedSequence) {
			throw new AnsteelObservabilityError(
				"event-chain-invalid",
				"Ansteel runtime run.started data must include both resume coordinates or neither",
			);
		}
	}
	if (eventName.startsWith("state.transition.")) {
		if (eventName === "state.transition.applied" && record.guardResult !== true) {
			throw new AnsteelObservabilityError(
				"event-chain-invalid",
				"Ansteel runtime applied transition data must have guardResult true",
			);
		}
		if (eventName === "state.transition.rejected" && record.guardResult !== false) {
			throw new AnsteelObservabilityError(
				"event-chain-invalid",
				"Ansteel runtime rejected transition data must have guardResult false",
			);
		}
	}
	if (eventName.startsWith("budget.")) {
		const used = record.used as number;
		const limit = record.limit as number;
		const remaining = record.remaining as number;
		if (used + remaining !== limit || (eventName === "budget.exhausted" && remaining !== 0)) {
			throw new AnsteelObservabilityError(
				"event-chain-invalid",
				`Ansteel runtime event ${eventName} data has inconsistent budget counters`,
			);
		}
	}
	if (eventName === "provider.request.retry" && (record.attempt as number) > (record.maxAttempts as number)) {
		throw new AnsteelObservabilityError(
			"event-chain-invalid",
			"Ansteel runtime provider retry attempt exceeds maxAttempts",
		);
	}
	if (eventName === "provider.request.started" || eventName === "provider.request.completed") {
		const configurationFields = ["configurationIdentity", "provider", "model", "timeoutMs"];
		const configuredCount = configurationFields.filter((field) => Object.hasOwn(record, field)).length;
		if (configuredCount !== 0 && configuredCount !== configurationFields.length) {
			throw new AnsteelObservabilityError(
				"event-chain-invalid",
				`Ansteel runtime event ${eventName} data must include the complete provider configuration identity`,
			);
		}
		if (
			record.tokenCountsAvailable === true &&
			(typeof record.inputTokens !== "number" || typeof record.outputTokens !== "number")
		) {
			throw new AnsteelObservabilityError(
				"event-chain-invalid",
				`Ansteel runtime event ${eventName} data cannot claim available null token counts`,
			);
		}
		if (record.tokenCountsAvailable === false && (record.inputTokens !== null || record.outputTokens !== null)) {
			throw new AnsteelObservabilityError(
				"event-chain-invalid",
				`Ansteel runtime event ${eventName} data must use null token counts when unavailable`,
			);
		}
		if (
			typeof record.firstTokenLatencyMs === "number" &&
			typeof record.durationMs === "number" &&
			record.firstTokenLatencyMs > record.durationMs
		) {
			throw new AnsteelObservabilityError(
				"event-chain-invalid",
				`Ansteel runtime event ${eventName} data first-token latency exceeds total duration`,
			);
		}
	}
	if (eventName === "security.secret-detected" || eventName === "security.redaction-applied") {
		if (record.findingCount !== (record.sensitiveFieldCount as number) + (record.sensitiveTextMatchCount as number)) {
			throw new AnsteelObservabilityError(
				"event-chain-invalid",
				`Ansteel runtime event ${eventName} data has inconsistent redaction counters`,
			);
		}
	}
	if (eventName === "artifact.stored" && record.storageResult !== "created") {
		throw new AnsteelObservabilityError(
			"event-chain-invalid",
			"Ansteel runtime artifact.stored data must describe newly created storage",
		);
	}
	if (
		eventName === "artifact.verified" &&
		Object.hasOwn(record, "storageResult") &&
		record.storageResult !== "deduplicated-and-verified"
	) {
		throw new AnsteelObservabilityError(
			"event-chain-invalid",
			"Ansteel runtime artifact.verified storage data must describe verified deduplication",
		);
	}
	if (
		eventName === "artifact.verified" &&
		Object.hasOwn(record, "verificationResult") &&
		record.verificationResult !== "verified"
	) {
		throw new AnsteelObservabilityError(
			"event-chain-invalid",
			"Ansteel runtime artifact.verified audit data must report verificationResult verified",
		);
	}
	if (
		eventName === "artifact.missing" &&
		Object.hasOwn(record, "artifactKind") &&
		record.verificationResult === "verified"
	) {
		throw new AnsteelObservabilityError(
			"event-chain-invalid",
			"Ansteel runtime artifact.missing audit data cannot report verificationResult verified",
		);
	}
	if (Object.hasOwn(record, "verificationResult") && Object.hasOwn(record, "artifactKind")) {
		const expectsActualHash =
			record.verificationResult === "verified" || record.verificationResult === "hash-mismatch";
		if (expectsActualHash !== Object.hasOwn(record, "actualHash")) {
			throw new AnsteelObservabilityError(
				"event-chain-invalid",
				`Ansteel runtime event ${eventName} artifact audit data has an inconsistent actualHash`,
			);
		}
	}
	if (eventName === "process.exited" && outcome !== "abandoned") {
		if (
			outcome === "succeeded" &&
			(record.exitCode !== 0 ||
				record.timedOut !== false ||
				record.stdoutTruncated !== false ||
				record.stderrTruncated !== false)
		) {
			throw new AnsteelObservabilityError(
				"event-chain-invalid",
				"Ansteel runtime successful process exit data contradicts its exit or output facts",
			);
		}
		if (outcome === "cancelled" && record.timedOut !== true) {
			throw new AnsteelObservabilityError(
				"event-chain-invalid",
				"Ansteel runtime cancelled process exit data must describe a timed-out process",
			);
		}
	}
	if (eventName === "runtime-index-rebuilt") {
		if (outcome === "succeeded" && !Object.hasOwn(record, "rebuiltIndexHash")) {
			throw new AnsteelObservabilityError(
				"event-chain-invalid",
				"Ansteel runtime successful index rebuild data requires rebuiltIndexHash",
			);
		}
		if (outcome !== "succeeded" && Object.hasOwn(record, "rebuiltIndexHash")) {
			throw new AnsteelObservabilityError(
				"event-chain-invalid",
				`Ansteel runtime ${outcome} index rebuild data cannot claim a rebuiltIndexHash`,
			);
		}
	}
	for (const field of [
		"startedAt",
		"lastProgressAt",
		"ownerProcessStartedAtUtc",
		"acquiredAtUtc",
		"expiresAtUtc",
		"renewedAtUtc",
		"detectedAtUtc",
		"releasedAtUtc",
		"rebuiltAt",
	]) {
		if (Object.hasOwn(record, field)) assertRuntimeUtcTimestamp(record[field], field, eventName);
	}
	if (eventName === "lease.acquired") {
		if ((record.renewEveryMs as number) >= (record.staleAfterMs as number)) {
			throw new AnsteelObservabilityError(
				"event-chain-invalid",
				"Ansteel runtime lease renewal interval must be shorter than its stale boundary",
			);
		}
		if (
			Date.parse(record.expiresAtUtc as string) - Date.parse(record.acquiredAtUtc as string) !==
			record.staleAfterMs
		) {
			throw new AnsteelObservabilityError(
				"event-chain-invalid",
				"Ansteel runtime lease expiry does not match its acquired time and stale boundary",
			);
		}
		if (Date.parse(record.ownerProcessStartedAtUtc as string) > Date.parse(record.acquiredAtUtc as string)) {
			throw new AnsteelObservabilityError(
				"event-chain-invalid",
				"Ansteel runtime lease owner process cannot start after lease acquisition",
			);
		}
	}
	if (
		eventName === "lease.renewed" &&
		Date.parse(record.expiresAtUtc as string) - Date.parse(record.renewedAtUtc as string) !==
			ANSTEEL_RUNTIME_LOG_LOCK_STALE_MS
	) {
		throw new AnsteelObservabilityError(
			"event-chain-invalid",
			"Ansteel runtime renewed lease expiry does not match the governed stale boundary",
		);
	}
	if (
		eventName === "lease.expired" &&
		(Date.parse(record.ownerProcessStartedAtUtc as string) > Date.parse(record.acquiredAtUtc as string) ||
			Date.parse(record.acquiredAtUtc as string) > Date.parse(record.detectedAtUtc as string))
	) {
		throw new AnsteelObservabilityError(
			"event-chain-invalid",
			"Ansteel runtime expired lease data has non-monotonic lifecycle timestamps",
		);
	}
}

export function isAnsteelRuntimeEventCombination(eventName: string, outcome: string): boolean {
	const allowed = (ANSTEEL_RUNTIME_EVENT_CATALOG as Record<string, readonly string[]>)[eventName];
	return allowed?.includes(outcome) ?? false;
}

export interface AnsteelRunContext {
	runId: string;
	traceId: string;
	teamId: string;
	command: string;
	startedAt: string;
	resumedFromRunId?: string;
	resumedFromSequence?: number;
}

export interface AnsteelRuntimeEnvironmentFingerprint {
	productVersion: string;
	extensionVersion: string;
	gitCommit: string | null;
	configStatus: "missing" | "parsed" | "invalid";
	configFingerprint: string;
	featureFlags: Record<string, boolean | number | string | string[]>;
	nodeVersion: string;
	osPlatform: string;
	osRelease: string;
	architecture: string;
	projectRootId: string;
	enabledEnvironmentVariables: string[];
	environmentFingerprint: string;
}

export interface AnsteelRuntimeArtifactRef {
	kind: string;
	sha256: string;
	storageId: string;
}

export interface AnsteelRuntimeLogEntry {
	schemaVersion: 1;
	/** 仅在事件目录开始强制校验之前写入的旧 schema-v1 记录中允许缺失。 */
	eventCatalogVersion?: typeof ANSTEEL_RUNTIME_EVENT_CATALOG_VERSION;
	timestampUtc: string;
	monotonicElapsedNs: string;
	sequence: number;
	level: "debug" | "info" | "warn" | "error" | "audit";
	eventName: string;
	outcome: AnsteelRuntimeOutcome;
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
	| "eventCatalogVersion"
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
	writeBatch(inputs: readonly AnsteelRuntimeLogInput[]): AnsteelRuntimeLogEntry[];
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
	traceId?: string;
	resumedFromRunId?: string;
	resumedFromSequence?: number;
}): AnsteelRunContext {
	return {
		runId: `RUN-${randomUUID()}`,
		traceId: input.traceId ?? randomBytes(16).toString("hex"),
		teamId: input.teamId,
		command: input.command,
		startedAt: (input.now ?? new Date()).toISOString(),
		...(input.resumedFromRunId === undefined ? {} : { resumedFromRunId: input.resumedFromRunId }),
		...(input.resumedFromSequence === undefined ? {} : { resumedFromSequence: input.resumedFromSequence }),
	};
}

/**
 * 只从同一持久团队最近一次业务操作命令恢复。只读诊断命令即使紧邻 Pi 重启前执行，
 * 也不能成为后续工作的因果父节点，否则 status/trace/doctor/incident 会污染真实执行链。
 */
export function createAnsteelResumedRunContext(
	cwd: string,
	input: { teamId: string; command: string; now?: Date; taskId?: string },
): AnsteelRunContext {
	const resumePoint = listAnsteelRuntimeRuns(cwd)
		.filter((run) => run.teamId === input.teamId)
		.map((run) => ({ run, entries: readAnsteelRuntimeLogs(cwd, run.runId) }))
		.filter(({ entries }) => {
			const command = entries.find(
				(entry) =>
					entry.eventName === "run.started" && entry.outcome === "started" && entry.parentSpanId === undefined,
			)?.data.command;
			return (
				typeof command === "string" &&
				!ANSTEEL_RUNTIME_DIAGNOSTIC_COMMAND.test(command) &&
				(input.taskId === undefined ||
					command === `task ${input.taskId}` ||
					entries.some((entry) => entry.taskId === input.taskId))
			);
		})
		.at(-1);
	if (resumePoint === undefined) return createAnsteelRunContext(input);
	const lastEntry = resumePoint.entries.at(-1);
	if (lastEntry === undefined || resumePoint.run.traceId === undefined) return createAnsteelRunContext(input);
	return createAnsteelRunContext({
		teamId: input.teamId,
		command: input.command,
		...(input.now === undefined ? {} : { now: input.now }),
		traceId: resumePoint.run.traceId,
		resumedFromRunId: resumePoint.run.runId,
		resumedFromSequence: lastEntry.sequence,
	});
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

// 匹配可能携带凭据的字段名，包括 provider 前缀、snake_case、kebab-case 和常见 camelCase。
// 末尾锚点刻意排除 inputTokens、maxTokens、tokenCountsAvailable 等无敏感值的正常遥测字段。
const SENSITIVE_FIELD_SUFFIX =
	/(?:^|_)(?:authorization|api_?key|(?:access|refresh|session|security|id|auth)?_?token|cookie|(?:client_?)?secret(?:_?(?:access_?)?(?:key|value))?|password(?:_?hash)?|private_?key|credentials?)$/;

function isAnsteelSensitiveFieldName(key: string): boolean {
	const normalized = key
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/-/g, "_")
		.toLowerCase();
	return SENSITIVE_FIELD_SUFFIX.test(normalized);
}

export interface AnsteelSensitiveRedactionResult<T> {
	value: T;
	findingCount: number;
	sensitiveFieldCount: number;
	sensitiveTextMatchCount: number;
}

interface MutableAnsteelSensitiveRedactionSummary {
	findingCount: number;
	sensitiveFieldCount: number;
	sensitiveTextMatchCount: number;
}

function isRedactionMarker(value: unknown): boolean {
	return typeof value === "string" && /^\[?REDACTED\]?$/i.test(value.trim().replace(/^['"]|['"]$/g, ""));
}

function redactAnsteelSensitiveTextInto(value: string, summary: MutableAnsteelSensitiveRedactionSummary): string {
	return value
		.replace(
			/((?:"|')?([A-Za-z_][A-Za-z0-9_-]*)(?:"|')?\s*[:=]\s*)((?:Bearer|Basic)\s+[^\s"',;}\]]+|"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
			(match, prefix: string, key: string, credential: string) => {
				if (!isAnsteelSensitiveFieldName(key) || isRedactionMarker(credential) || /^\[REDACTED/i.test(credential)) {
					return match;
				}
				summary.findingCount++;
				summary.sensitiveTextMatchCount++;
				return `${prefix}[REDACTED]`;
			},
		)
		.replace(/\b(Bearer|Basic)\s+([^\s"',;}]+)/gi, (match, scheme: string, credential: string) => {
			if (isRedactionMarker(credential) || /^\[REDACTED/i.test(credential)) return match;
			summary.findingCount++;
			summary.sensitiveTextMatchCount++;
			return `${scheme} [REDACTED]`;
		})
		.replace(/\bsk-[A-Za-z0-9._-]+\b/g, (match) => {
			if (match === "sk-[REDACTED]") return match;
			summary.findingCount++;
			summary.sensitiveTextMatchCount++;
			return "sk-[REDACTED]";
		});
}

function redactAnsteelSensitiveValueInto(
	value: unknown,
	summary: MutableAnsteelSensitiveRedactionSummary,
	seen: WeakSet<object>,
): unknown {
	if (typeof value === "string") return redactAnsteelSensitiveTextInto(value, summary);
	if (Array.isArray(value)) return value.map((item) => redactAnsteelSensitiveValueInto(item, summary, seen));
	if (typeof value !== "object" || value === null) return value;
	if (seen.has(value)) return "[Circular]";
	seen.add(value);
	const result = Object.create(null) as Record<string, unknown>;
	for (const [key, entry] of Object.entries(value)) {
		if (isAnsteelSensitiveFieldName(key)) {
			result[key] = "[REDACTED]";
			if (!isRedactionMarker(entry)) {
				summary.findingCount++;
				summary.sensitiveFieldCount++;
			}
			continue;
		}
		result[key] = redactAnsteelSensitiveValueInto(entry, summary, seen);
	}
	return result;
}

/**
 * 同时返回脱敏后的安全文本和“仅计数”的发现摘要。摘要绝不包含命中值、字段路径，
 * 也不保存可能被用作低熵秘密离线猜测 Oracle 的可逆或稳定哈希。
 */
export function inspectAndRedactAnsteelSensitiveText(value: string): AnsteelSensitiveRedactionResult<string> {
	const summary: MutableAnsteelSensitiveRedactionSummary = {
		findingCount: 0,
		sensitiveFieldCount: 0,
		sensitiveTextMatchCount: 0,
	};
	return { value: redactAnsteelSensitiveTextInto(value, summary), ...summary };
}

/** 对结构化值递归执行同一套“仅计数、不泄漏命中内容”的安全扫描。 */
export function inspectAndRedactAnsteelSensitiveValue(value: unknown): AnsteelSensitiveRedactionResult<unknown> {
	const summary: MutableAnsteelSensitiveRedactionSummary = {
		findingCount: 0,
		sensitiveFieldCount: 0,
		sensitiveTextMatchCount: 0,
	};
	return { value: redactAnsteelSensitiveValueInto(value, summary, new WeakSet<object>()), ...summary };
}

/**
 * 文本跨越运行日志或公共协作/UI 边界之前先移除凭据。赋值规则同时识别 `=`、`:` 和带引号的
 * JSON 键值；认证 scheme 必须优先处理，避免 `Authorization: Basic <value>` 的尾部凭据因较短
 * 字段规则先命中而残留。
 */
export function redactAnsteelSensitiveText(value: string): string {
	return inspectAndRedactAnsteelSensitiveText(value).value;
}

export function redactAnsteelSensitiveValue(value: unknown): unknown {
	return inspectAndRedactAnsteelSensitiveValue(value).value;
}

function redactRecord(value: Record<string, unknown>): Record<string, unknown> {
	return redactAnsteelSensitiveValue(value) as Record<string, unknown>;
}

function readAnsteelRuntimeConfiguration(cwd: string): {
	status: AnsteelRuntimeEnvironmentFingerprint["configStatus"];
	fingerprint: string;
	featureFlags: AnsteelRuntimeEnvironmentFingerprint["featureFlags"];
} {
	const path = join(resolve(cwd), ".pi", "ansteel.json");
	if (!existsSync(path)) {
		return {
			status: "missing",
			fingerprint: hashAnsteelAuditValue({ status: "missing" }),
			featureFlags: {},
		};
	}
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		// 非法配置只对“invalid”状态做指纹，不哈希任意损坏文本；否则其中夹带的凭据可能把
		// 配置指纹变成可离线枚举的密码 Oracle。
		return {
			status: "invalid",
			fingerprint: hashAnsteelAuditValue({ status: "invalid" }),
			featureFlags: {},
		};
	}
	const record = isRecord(value) ? value : {};
	const adaptiveBudgetPolicy = isRecord(record.adaptiveBudgetPolicy) ? record.adaptiveBudgetPolicy : undefined;
	const taskOwners = Array.isArray(record.teamTaskOwners)
		? record.teamTaskOwners.filter((role): role is string => typeof role === "string")
		: [];
	const featureFlags: AnsteelRuntimeEnvironmentFingerprint["featureFlags"] = {
		allowProviderFallback: record.allowProviderFallback === true,
		allowSingleModel: record.allowSingleModel === true,
		adaptiveBudget: adaptiveBudgetPolicy?.enabled === true,
		reviewRoot: record.reviewRoot === "git-root" ? "git-root" : "cwd",
		teamTaskOwners: taskOwners,
	};
	for (const field of ["teamTaskMaxEpochs", "teamTaskMaxNoProgressEpochs", "stageTimeoutMs", "maxToolCallsPerStage"]) {
		const fieldValue = record[field];
		if (typeof fieldValue === "number" && Number.isFinite(fieldValue)) featureFlags[field] = fieldValue;
	}
	return {
		status: "parsed",
		fingerprint: hashAnsteelAuditValue(redactAnsteelSensitiveValue(value)),
		featureFlags,
	};
}

function readAnsteelGitCommit(cwd: string): string | null {
	const result = spawnSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
		encoding: "utf8",
		timeout: ANSTEEL_RUNTIME_GIT_TIMEOUT_MS,
		windowsHide: true,
	});
	const commit = result.status === 0 ? result.stdout.trim().toLowerCase() : "";
	return /^[0-9a-f]{40,64}$/.test(commit) ? commit : null;
}

/** 为一次根执行构造不可变、无凭据的环境描述。 */
export function createAnsteelRuntimeEnvironmentFingerprint(cwd: string): AnsteelRuntimeEnvironmentFingerprint {
	const configuration = readAnsteelRuntimeConfiguration(cwd);
	let canonicalRoot = resolve(cwd);
	try {
		canonicalRoot = realpathSync(canonicalRoot);
	} catch {
		// 日志器会在其他边界拒绝不可用的项目目录；这里保留规范化失败前的 resolve 结果，
		// 仍可为同一失败环境生成确定性指纹，而不把原始路径写入日志。
	}
	canonicalRoot = canonicalRoot.replace(/\\/g, "/");
	if (process.platform === "win32") canonicalRoot = canonicalRoot.toLowerCase();
	const unsigned = {
		productVersion: VERSION,
		extensionVersion: ANSTEEL_TEAM_EXTENSION_VERSION,
		gitCommit: readAnsteelGitCommit(cwd),
		configStatus: configuration.status,
		configFingerprint: configuration.fingerprint,
		featureFlags: configuration.featureFlags,
		nodeVersion: process.version,
		osPlatform: platform(),
		osRelease: release(),
		architecture: arch(),
		projectRootId: createHash("sha256").update(canonicalRoot, "utf8").digest("hex"),
		enabledEnvironmentVariables: Object.keys(process.env)
			.filter((name) => name.startsWith("ANSTEEL_") || name === "PI_OFFLINE" || name === "PI_SKIP_VERSION_CHECK")
			.sort(),
	};
	return { ...unsigned, environmentFingerprint: hashAnsteelAuditValue(unsigned) };
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

interface AnsteelStoredArtifact {
	ref: AnsteelRuntimeArtifactRef;
	storageResult: "created" | "deduplicated-and-verified";
	contentByteLength: number;
}

interface AnsteelArtifactInspection {
	verificationResult: "verified" | "missing" | "hash-mismatch" | "unreadable";
	actualHash?: string;
}

function storeArtifact(cwd: string, artifact: { kind: string; content: string }): AnsteelStoredArtifact {
	const content = redactAnsteelSensitiveText(artifact.content);
	const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
	const directory = getAnsteelRuntimeArtifactDirectory(cwd);
	mkdirSync(directory, { recursive: true });
	const storageId = join(directory, sha256);
	let storageResult: AnsteelStoredArtifact["storageResult"];
	if (!existsSync(storageId)) {
		writeNewDurableFile(storageId, content);
		storageResult = "created";
	} else {
		const inspection = inspectAnsteelRuntimeArtifact({ kind: artifact.kind, sha256, storageId });
		if (inspection.verificationResult !== "verified") {
			throw new AnsteelObservabilityError(
				"artifact-missing",
				"Ansteel runtime artifact content does not match its hash",
			);
		}
		storageResult = "deduplicated-and-verified";
	}
	return {
		ref: { kind: artifact.kind, sha256, storageId },
		storageResult,
		contentByteLength: Buffer.byteLength(content, "utf8"),
	};
}

function inspectAnsteelRuntimeArtifact(artifact: AnsteelRuntimeArtifactRef): AnsteelArtifactInspection {
	if (!existsSync(artifact.storageId)) return { verificationResult: "missing" };
	try {
		const actualHash = createHash("sha256").update(readFileSync(artifact.storageId)).digest("hex");
		return actualHash === artifact.sha256
			? { verificationResult: "verified", actualHash }
			: { verificationResult: "hash-mismatch", actualHash };
	} catch {
		return { verificationResult: "unreadable" };
	}
}

function hashRuntimeLogEntry(entry: Omit<AnsteelRuntimeLogEntry, "hash">): string {
	return createHash("sha256").update(JSON.stringify(entry), "utf8").digest("hex");
}

function assertAnsteelRuntimeEventCombination(eventName: unknown, outcome: unknown): asserts eventName is string {
	if (
		typeof eventName !== "string" ||
		typeof outcome !== "string" ||
		!isAnsteelRuntimeEventCombination(eventName, outcome)
	) {
		throw new AnsteelObservabilityError(
			"event-chain-invalid",
			`Ansteel runtime event catalog rejects ${String(eventName)} with outcome ${String(outcome)}`,
		);
	}
}

function parseRuntimeLogEntry(value: unknown): AnsteelRuntimeLogEntry {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new AnsteelObservabilityError("event-chain-invalid", "Ansteel runtime log entry must be an object");
	}
	const entry = value as AnsteelRuntimeLogEntry;
	if (entry.schemaVersion !== 1 || !Number.isSafeInteger(entry.sequence) || entry.sequence < 1) {
		throw new AnsteelObservabilityError("event-chain-invalid", "Ansteel runtime log entry has invalid metadata");
	}
	const catalogVersion = (value as Record<string, unknown>).eventCatalogVersion;
	if (catalogVersion !== undefined && catalogVersion !== ANSTEEL_RUNTIME_EVENT_CATALOG_VERSION) {
		throw new AnsteelObservabilityError(
			"event-chain-invalid",
			`Ansteel runtime event catalog version ${String(catalogVersion)} is unsupported`,
		);
	}
	if (catalogVersion === ANSTEEL_RUNTIME_EVENT_CATALOG_VERSION) {
		assertAnsteelRuntimeEventCombination(entry.eventName, entry.outcome);
		assertAnsteelRuntimeEventData(entry.eventName, entry.outcome, entry.data);
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
		eventCatalogVersion: ANSTEEL_RUNTIME_EVENT_CATALOG_VERSION,
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
	assertAnsteelRuntimeEventData(unsigned.eventName, unsigned.outcome, unsigned.data);
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
		eventCatalogVersion: ANSTEEL_RUNTIME_EVENT_CATALOG_VERSION,
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
	assertAnsteelRuntimeEventData(unsigned.eventName, unsigned.outcome, unsigned.data);
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
	let indexLock: AnsteelRuntimeLockHandle | undefined;
	try {
		indexLock = acquireAnsteelRuntimeLock(
			path,
			"index",
			ANSTEEL_RUNTIME_INDEX_LOCK_STALE_MS,
			ANSTEEL_RUNTIME_INDEX_LOCK_UPDATE_MS,
		);
	} catch (error) {
		throw new AnsteelObservabilityError("event-fsync-failed", "Ansteel runtime index lock could not be acquired", {
			cause: error,
		});
	}
	try {
		return action();
	} finally {
		indexLock.release();
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

export interface AnsteelIncidentEventRef {
	sequence: number;
	timestampUtc: string;
	eventName: string;
	outcome: AnsteelRuntimeOutcome;
	reasonCode?: AnsteelRuntimeReasonCode;
	spanId: string;
	parentSpanId?: string;
	causeEventId?: string;
	hash: string;
}

export interface AnsteelIncidentSpanNode {
	spanId: string;
	parentSpanId?: string;
	eventSequences: number[];
	childSpanIds: string[];
	startEvent?: AnsteelIncidentEventRef;
	terminalEvent?: AnsteelIncidentEventRef;
}

export interface AnsteelIncidentTaskIdentity {
	taskId: string;
	runtimeRevisions: number[];
	currentRevision?: number;
	currentStatus?: string;
}

export interface AnsteelIncidentProjectContextVerified {
	availability: "verified";
	teamId: string;
	taskIdentities: AnsteelIncidentTaskIdentity[];
	publicAuditEventRange: {
		firstSequence: number | null;
		lastSequence: number | null;
		eventCount: number;
		headHash: string | null;
		integrity: "verified";
	};
	teamState: {
		status: string;
		collaborationStatus: string;
		governanceStatus: string;
		deliveryStatus: string;
		workflowStatus: string;
	};
	lastValidCheckpoint: {
		checkpointId: string;
		taskId?: string;
		actor: string;
		status: string;
		createdAt: string;
		risk: string;
		confidence: string;
		nextAction: { kind: string; target: string; expectedResult: string };
		checkpointHash: string;
		eventSequence?: number;
	} | null;
	workspace:
		| {
				status: "captured";
				hash: string;
				trackedDiffHash: string;
				untracked: Array<{ file: string; sha256: string }>;
		  }
		| { status: "unavailable"; reasonCode: "workspace-snapshot-unavailable" };
	recoveryEntry: {
		kind: "checkpoint" | "task-revision" | "team-resume" | "manual";
		command: string;
		checkpointId?: string;
		taskId?: string;
		revision?: number;
	};
}

export interface AnsteelIncidentProjectContextUnavailable {
	availability: "unavailable";
	reasonCode: "team-state-missing" | "team-integrity-unavailable";
}

/**
 * 可观测性层拥有事故包 schema，团队层拥有生成“已验证项目上下文”所需的状态事实。
 * 通过显式参数传入上下文，可以保持现有 team -> observability 单向运行时依赖，避免循环导入；
 * 同时，纯运行故障在没有团队状态时能够如实标记上下文缺失，而不是伪造任务或 revision。
 */
export type AnsteelIncidentProjectContext =
	| AnsteelIncidentProjectContextVerified
	| AnsteelIncidentProjectContextUnavailable;

export interface AnsteelIncidentBundle {
	storageId: string;
	sha256: string;
	manifest: {
		schemaVersion: 2;
		evidenceModel: "mechanical-facts-only";
		run: {
			runId: string;
			traceId?: string;
			teamId?: string;
			startedAt?: string;
			endedAt?: string;
			terminalOutcome?: AnsteelRuntimeOutcome;
		};
		healthy: boolean;
		rootCause?: AnsteelRuntimeLogEntry;
		propagationEvents: AnsteelIncidentEventRef[];
		finalRuntimeState: {
			terminalEvent?: AnsteelIncidentEventRef;
			lastObservedEvent?: AnsteelIncidentEventRef;
		};
		issues: AnsteelRuntimeDiagnosisIssue[];
		spanTree: { rootSpanIds: string[]; nodes: AnsteelIncidentSpanNode[] };
		logSegments: Array<{
			fileName: string;
			expectedSha256?: string;
			actualSha256?: string;
			byteLength?: number;
			verificationResult: "verified" | "missing" | "hash-mismatch" | "unindexed";
		}>;
		artifactRefs: AnsteelRuntimeArtifactRef[];
		configurationSummary: {
			runtimeEnvironment?: {
				productVersion: string;
				extensionVersion: string;
				gitCommit: string | null;
				configStatus: string;
				configFingerprint: string;
				environmentFingerprint: string;
				featureFlags: Record<string, boolean | number | string | string[]>;
				enabledEnvironmentVariables: string[];
			};
			providers: Array<{
				providerRequestId: string;
				role?: AnsteelRuntimeLogEntry["role"];
				provider: string;
				model: string;
				configurationIdentity: string;
				timeoutMs: number | null;
				retryCount: number;
			}>;
			tools: Array<{
				toolCallId: string;
				role?: AnsteelRuntimeLogEntry["role"];
				toolName: string;
				policyBoundary: string;
			}>;
		};
		integrity: {
			runtimeEventChain: {
				status: "verified" | "failed";
				entryCount: number;
				headHash?: string;
				reasonCode?: AnsteelRuntimeReasonCode;
				message?: string;
			};
			logSegments: { status: "verified" | "failed"; runIndexHash?: string };
			artifacts: {
				status: "verified" | "failed" | "unavailable";
				verifiedCount: number;
				missingCount: number;
				results: Array<{
					kind: string;
					sha256: string;
					verificationResult: "verified" | "missing" | "hash-mismatch";
					actualHash?: string;
				}>;
			};
		};
		projectContext: AnsteelIncidentProjectContext;
	};
}

function getAnsteelRuntimeSpanStartEventName(spanName: string): string {
	switch (spanName) {
		case "run":
		case "run.started":
			return "run.started";
		case "role.session":
		case "role.session.started":
			return "role.session.started";
		case "provider.request":
		case "provider.request.started":
			return "provider.request.started";
		case "tool.call":
		case "tool.call.started":
			return "tool.call.started";
		case "process":
		case "process.spawned":
			return "process.spawned";
		case "task":
		case "task.started":
			return "task.started";
		default:
			return spanName;
	}
}

function getAnsteelRuntimeSpanTerminalEventName(
	startEventName: string,
	outcome: AnsteelRuntimeSpanEndInput["outcome"],
): string {
	switch (startEventName) {
		case "run.started":
			return outcome === "succeeded" ? "run.completed" : "run.failed";
		case "role.session.started":
			return "role.session.ended";
		case "provider.request.started":
			return "provider.request.completed";
		case "tool.call.started":
			return "tool.call.completed";
		case "process.spawned":
			return "process.exited";
		case "task.started":
			return "task.completed";
		default:
			return startEventName;
	}
}

function isAnsteelRuntimeTerminalOutcome(
	outcome: AnsteelRuntimeOutcome,
): outcome is AnsteelRuntimeSpanEndInput["outcome"] {
	return (ANSTEEL_RUNTIME_TERMINAL_OUTCOMES as readonly AnsteelRuntimeOutcome[]).includes(outcome);
}

function isAnsteelRuntimeTerminalForStart(start: AnsteelRuntimeLogEntry, terminal: AnsteelRuntimeLogEntry): boolean {
	if (
		terminal.sequence <= start.sequence ||
		terminal.spanId !== start.spanId ||
		terminal.parentSpanId !== start.parentSpanId ||
		!isAnsteelRuntimeTerminalOutcome(terminal.outcome)
	) {
		return false;
	}
	const expectedEventName =
		start.eventCatalogVersion === ANSTEEL_RUNTIME_EVENT_CATALOG_VERSION
			? getAnsteelRuntimeSpanTerminalEventName(start.eventName, terminal.outcome)
			: start.eventName;
	return terminal.eventName === expectedEventName;
}

function getRuntimeTerminalOutcome(
	entries: readonly AnsteelRuntimeLogEntry[],
): AnsteelRuntimeLogEntry["outcome"] | undefined {
	const rootStarts = entries.filter(
		(entry) => entry.eventName === "run.started" && entry.outcome === "started" && entry.parentSpanId === undefined,
	);
	if (rootStarts.length !== 1) return undefined;
	const rootStart = rootStarts[0]!;
	const terminals = entries.filter((entry) => isAnsteelRuntimeTerminalForStart(rootStart, entry));
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
				let lastOperational: AnsteelRuntimeLogEntry | undefined;
				for (let index = entries.length - 1; index >= 0; index--) {
					const entry = entries[index]!;
					// 成功的 lease/artifact/security 生命周期回执描述的是审计底座，而不是它们保护的
					// 业务命令结果。跳过这些回执，确保释放锁、存储产物或成功脱敏后，最后业务终态仍可见。
					if (
						entry.eventName.startsWith("lease.") ||
						entry.eventName.startsWith("artifact.") ||
						entry.eventName.startsWith("security.")
					) {
						continue;
					}
					lastOperational = entry;
					break;
				}
				const terminalOutcome = getRuntimeTerminalOutcome(entries);
				return {
					runId,
					...(first?.traceId === undefined ? {} : { traceId: first.traceId }),
					...(first?.teamId === undefined ? {} : { teamId: first.teamId }),
					...(first?.timestampUtc === undefined ? {} : { startedAt: first.timestampUtc }),
					...(last?.timestampUtc === undefined ? {} : { endedAt: last.timestampUtc }),
					entryCount: entries.length,
					...(lastOperational?.outcome === undefined ? {} : { lastOutcome: lastOperational.outcome }),
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
		const key = `${entry.spanId}\0${entry.parentSpanId ?? ""}`;
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
			const starts = openSpans.get(key);
			if (starts === undefined) continue;
			const remaining = starts.filter((start) => !isAnsteelRuntimeTerminalForStart(start, entry));
			if (remaining.length === 0) openSpans.delete(key);
			else openSpans.set(key, remaining);
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
	const observedRoot = observedEntries.find(
		(entry) => entry.eventName === "run.started" && entry.outcome === "started" && entry.parentSpanId === undefined,
	);
	const logger = createAnsteelRuntimeLogger(
		cwd,
		{
			runId,
			traceId: first.traceId,
			teamId: first.teamId,
			command:
				typeof observedRoot?.data.command === "string"
					? observedRoot.data.command
					: "recovered interrupted command",
			startedAt: first.timestampUtc,
		},
		{ auditRunLease: true },
	);
	let abandonedSpanCount = 0;
	const previousHeadHash = observedHeadHash;
	let recoveredHeadHash = observedHeadHash;
	try {
		// The run lock is now held. Re-read the chain so recovery never appends
		// from a stale sequence/hash snapshot.
		const lockedEntries = readAnsteelRuntimeLogs(cwd, runId);
		const orphanedSpans = getOrphanedRuntimeSpans(lockedEntries);
		if (orphanedSpans.length === 0) {
			recoveredHeadHash = lockedEntries.at(-1)?.hash ?? previousHeadHash;
			return {
				runId,
				abandonedSpanCount: 0,
				previousHeadHash,
				recoveredHeadHash,
			};
		}
		abandonedSpanCount = orphanedSpans.length;
		for (const start of orphanedSpans) {
			if (
				start.eventCatalogVersion === ANSTEEL_RUNTIME_EVENT_CATALOG_VERSION &&
				start.eventName === "process.spawned"
			) {
				logger.write({
					level: "error",
					eventName: "process.orphan-detected",
					outcome: "abandoned",
					reasonCode: "process-orphaned",
					spanId: start.spanId,
					...(start.parentSpanId === undefined ? {} : { parentSpanId: start.parentSpanId }),
					...(start.role === undefined ? {} : { role: start.role }),
					...(start.taskId === undefined ? {} : { taskId: start.taskId }),
					...(start.checkpointId === undefined ? {} : { checkpointId: start.checkpointId }),
					...(start.toolCallId === undefined ? {} : { toolCallId: start.toolCallId }),
					...(start.processId === undefined ? {} : { processId: start.processId }),
					causeEventId: start.hash,
					message: "Ansteel governed subprocess was orphaned when its coordinator stopped",
					data: {
						recoveredFromSequence: start.sequence,
						recoveredFromEventHash: start.hash,
						pid: start.data.pid ?? null,
					},
				});
			}
			const recovered = logger.write({
				level: "error",
				eventName:
					start.eventCatalogVersion === ANSTEEL_RUNTIME_EVENT_CATALOG_VERSION
						? getAnsteelRuntimeSpanTerminalEventName(start.eventName, "abandoned")
						: start.eventName,
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
	recoveredHeadHash = readAnsteelRuntimeLogs(cwd, runId).at(-1)?.hash ?? recoveredHeadHash;
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
			const inspection = inspectAnsteelRuntimeArtifact(artifact);
			if (inspection.verificationResult !== "verified") {
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

/**
 * 从磁盘重新读取目标 run 引用的每个产物，并把机械校验结果写入调用方独立的诊断 run。
 * 校验事件与被校验证据分离，避免检查动作反过来修改目标 run；生命周期事件只携带哈希和
 * source run/sequence 坐标，不允许形成自引用。
 */
export function auditAnsteelRuntimeArtifacts(
	cwd: string,
	runId: string,
	logger: AnsteelRuntimeLogger,
): { verifiedCount: number; missingCount: number } {
	let entries: AnsteelRuntimeLogEntry[];
	try {
		entries = readAnsteelRuntimeLogs(cwd, runId);
	} catch (error) {
		if (error instanceof AnsteelObservabilityError && error.reasonCode === "event-chain-invalid") {
			// 损坏的目标链不能为自身损坏作证。把机械读取失败写入调用方独立的 doctor/incident
			// 诊断 run；除用户提供且已校验格式的 runId 外，不信任也不复制目标记录中的任何字段。
			logger.write({
				level: "error",
				eventName: "event.chain.invalid",
				outcome: "failed",
				reasonCode: "event-chain-invalid",
				role: "coordinator",
				message: `Ansteel runtime chain verification failed for ${runId}`,
				data: {
					resourceKind: "runtime-log-chain",
					sourceRunId: runId,
					verificationBoundary: "diagnostic-target-read",
				},
			});
		}
		throw error;
	}
	if (entries.length === 0) {
		logger.write({
			level: "error",
			eventName: "artifact.missing",
			outcome: "failed",
			reasonCode: "artifact-missing",
			role: "coordinator",
			message: `Ansteel runtime run ${runId} has no persisted log artifact`,
			data: { resourceKind: "runtime-log", sourceRunId: runId, verificationResult: "missing" },
		});
		return { verifiedCount: 0, missingCount: 1 };
	}
	let verifiedCount = 0;
	let missingCount = 0;
	for (const entry of entries) {
		for (const artifact of entry.artifactRefs) {
			const inspection = inspectAnsteelRuntimeArtifact(artifact);
			const verified = inspection.verificationResult === "verified";
			if (verified) verifiedCount++;
			else missingCount++;
			logger.write({
				level: verified ? "audit" : "error",
				eventName: verified ? "artifact.verified" : "artifact.missing",
				outcome: verified ? "succeeded" : "failed",
				...(verified ? {} : { reasonCode: "artifact-missing" as const }),
				role: "coordinator",
				...(entry.taskId === undefined ? {} : { taskId: entry.taskId }),
				...(entry.checkpointId === undefined ? {} : { checkpointId: entry.checkpointId }),
				...(entry.issueId === undefined ? {} : { issueId: entry.issueId }),
				...(entry.toolCallId === undefined ? {} : { toolCallId: entry.toolCallId }),
				...(entry.providerRequestId === undefined ? {} : { providerRequestId: entry.providerRequestId }),
				...(entry.processId === undefined ? {} : { processId: entry.processId }),
				...(entry.revision === undefined ? {} : { revision: entry.revision }),
				...(entry.diffHash === undefined ? {} : { diffHash: entry.diffHash }),
				causeEventId: entry.hash,
				message: verified
					? `Ansteel runtime artifact ${artifact.sha256} was verified`
					: `Ansteel runtime artifact ${artifact.sha256} is missing or does not match`,
				data: {
					resourceKind: "content-addressed-artifact",
					sourceRunId: runId,
					sourceSequence: entry.sequence,
					artifactKind: artifact.kind,
					sha256: artifact.sha256,
					verificationResult: inspection.verificationResult,
					...(inspection.actualHash === undefined ? {} : { actualHash: inspection.actualHash }),
				},
			});
		}
	}
	return { verifiedCount, missingCount };
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

function toAnsteelIncidentEventRef(entry: AnsteelRuntimeLogEntry): AnsteelIncidentEventRef {
	return {
		sequence: entry.sequence,
		timestampUtc: entry.timestampUtc,
		eventName: entry.eventName,
		outcome: entry.outcome,
		...(entry.reasonCode === undefined ? {} : { reasonCode: entry.reasonCode }),
		spanId: entry.spanId,
		...(entry.parentSpanId === undefined ? {} : { parentSpanId: entry.parentSpanId }),
		...(entry.causeEventId === undefined ? {} : { causeEventId: entry.causeEventId }),
		hash: entry.hash,
	};
}

function createAnsteelIncidentSpanTree(
	entries: readonly AnsteelRuntimeLogEntry[],
): AnsteelIncidentBundle["manifest"]["spanTree"] {
	const grouped = new Map<string, AnsteelRuntimeLogEntry[]>();
	for (const entry of entries) {
		const group = grouped.get(entry.spanId);
		if (group === undefined) grouped.set(entry.spanId, [entry]);
		else group.push(entry);
	}
	const nodes = [...grouped.entries()]
		.map(([spanId, spanEntries]): AnsteelIncidentSpanNode => {
			const ordered = [...spanEntries].sort((left, right) => left.sequence - right.sequence);
			const parentSpanId = ordered.find((entry) => entry.parentSpanId !== undefined)?.parentSpanId;
			const start = ordered.find((entry) => entry.outcome === "started");
			const terminal = [...ordered]
				.reverse()
				.find(
					(entry) =>
						entry.outcome === "succeeded" ||
						entry.outcome === "failed" ||
						entry.outcome === "cancelled" ||
						entry.outcome === "abandoned",
				);
			return {
				spanId,
				...(parentSpanId === undefined ? {} : { parentSpanId }),
				eventSequences: ordered.map((entry) => entry.sequence),
				childSpanIds: [],
				...(start === undefined ? {} : { startEvent: toAnsteelIncidentEventRef(start) }),
				...(terminal === undefined ? {} : { terminalEvent: toAnsteelIncidentEventRef(terminal) }),
			};
		})
		.sort(
			(left, right) => left.eventSequences[0]! - right.eventSequences[0]! || left.spanId.localeCompare(right.spanId),
		);
	const byId = new Map(nodes.map((node) => [node.spanId, node]));
	for (const node of nodes) {
		if (node.parentSpanId === undefined) continue;
		byId.get(node.parentSpanId)?.childSpanIds.push(node.spanId);
	}
	for (const node of nodes) {
		node.childSpanIds.sort(
			(left, right) =>
				byId.get(left)!.eventSequences[0]! - byId.get(right)!.eventSequences[0]! || left.localeCompare(right),
		);
	}
	return {
		rootSpanIds: nodes
			.filter((node) => node.parentSpanId === undefined || !byId.has(node.parentSpanId))
			.map((node) => node.spanId),
		nodes,
	};
}

function inspectAnsteelIncidentLogSegments(
	cwd: string,
	runId: string,
): {
	segments: AnsteelIncidentBundle["manifest"]["logSegments"];
	status: "verified" | "failed";
	runIndexHash?: string;
} {
	const directory = getAnsteelRuntimeLogDirectory(cwd);
	const prefix = `run-${runId}-`;
	const actualNames = existsSync(directory)
		? readdirSync(directory)
				.filter((name) => name.startsWith(prefix) && name.endsWith(".jsonl"))
				.sort()
		: [];
	let index: AnsteelRuntimeIndex | undefined;
	try {
		index = parseRuntimeIndex(cwd);
	} catch {
		// 即使索引不可用，清单仍记录原始日志段的字节哈希，便于取证比对；但这些未被索引
		// 绑定的字节绝不解析为可信事件，也不能提供 task、revision 或 trace 身份。
	}
	const expected = new Map((index?.runs[runId]?.segments ?? []).map((segment) => [segment.fileName, segment.sha256]));
	const names = [...new Set([...actualNames, ...expected.keys()])].sort();
	const segments = names.map((fileName) => {
		const expectedSha256 = expected.get(fileName);
		const path = join(directory, fileName);
		if (!existsSync(path)) {
			return {
				fileName,
				...(expectedSha256 === undefined ? {} : { expectedSha256 }),
				verificationResult: "missing" as const,
			};
		}
		const content = readFileSync(path);
		const actualSha256 = createHash("sha256").update(content).digest("hex");
		return {
			fileName,
			...(expectedSha256 === undefined ? {} : { expectedSha256 }),
			actualSha256,
			byteLength: content.length,
			verificationResult:
				expectedSha256 === undefined
					? ("unindexed" as const)
					: expectedSha256 === actualSha256
						? ("verified" as const)
						: ("hash-mismatch" as const),
		};
	});
	const status =
		index !== undefined &&
		index.runs[runId] !== undefined &&
		segments.length > 0 &&
		segments.every((segment) => segment.verificationResult === "verified")
			? "verified"
			: "failed";
	const indexedRun = index?.runs[runId];
	return {
		segments,
		status,
		// 只绑定目标 run 的索引切片。incident 命令自身会产生独立诊断
		// run；若使用全局索引哈希，同一目标证据会因无关诊断记录而失去
		// 内容寻址稳定性。
		...(indexedRun === undefined ? {} : { runIndexHash: hashAnsteelAuditValue(indexedRun) }),
	};
}

function readAnsteelIncidentRuntimeEnvironment(
	entries: readonly AnsteelRuntimeLogEntry[],
): AnsteelIncidentBundle["manifest"]["configurationSummary"]["runtimeEnvironment"] {
	const root = entries.find(
		(entry) => entry.eventName === "run.started" && entry.outcome === "started" && entry.parentSpanId === undefined,
	);
	const value = root?.data.runtimeEnvironment;
	if (!isRecord(value)) return undefined;
	if (
		typeof value.productVersion !== "string" ||
		typeof value.extensionVersion !== "string" ||
		(value.gitCommit !== null && typeof value.gitCommit !== "string") ||
		typeof value.configStatus !== "string" ||
		typeof value.configFingerprint !== "string" ||
		typeof value.environmentFingerprint !== "string" ||
		!isRecord(value.featureFlags) ||
		!Array.isArray(value.enabledEnvironmentVariables) ||
		!value.enabledEnvironmentVariables.every((name) => typeof name === "string")
	) {
		return undefined;
	}
	const featureFlags: Record<string, boolean | number | string | string[]> = {};
	for (const [name, featureValue] of Object.entries(value.featureFlags)) {
		if (
			typeof featureValue === "boolean" ||
			typeof featureValue === "number" ||
			typeof featureValue === "string" ||
			(Array.isArray(featureValue) && featureValue.every((item) => typeof item === "string"))
		) {
			featureFlags[name] = featureValue as boolean | number | string | string[];
		}
	}
	return {
		productVersion: value.productVersion,
		extensionVersion: value.extensionVersion,
		gitCommit: value.gitCommit,
		configStatus: value.configStatus,
		configFingerprint: value.configFingerprint,
		environmentFingerprint: value.environmentFingerprint,
		featureFlags,
		enabledEnvironmentVariables: [...value.enabledEnvironmentVariables].sort() as string[],
	};
}

function createAnsteelIncidentConfigurationSummary(
	entries: readonly AnsteelRuntimeLogEntry[],
): AnsteelIncidentBundle["manifest"]["configurationSummary"] {
	const providers = entries
		.filter(
			(entry) =>
				entry.eventName === "provider.request.started" &&
				entry.outcome === "started" &&
				entry.providerRequestId !== undefined,
		)
		.map((start) => {
			const related = entries.filter((entry) => entry.providerRequestId === start.providerRequestId);
			const retryCount = related.reduce((count, entry) => {
				const attempt = typeof entry.data.attempt === "number" ? entry.data.attempt : 0;
				const terminalCount = typeof entry.data.retryCount === "number" ? entry.data.retryCount : 0;
				return Math.max(count, attempt, terminalCount);
			}, 0);
			return {
				providerRequestId: start.providerRequestId!,
				...(start.role === undefined ? {} : { role: start.role }),
				provider: typeof start.data.provider === "string" ? start.data.provider : "unavailable",
				model: typeof start.data.model === "string" ? start.data.model : "unavailable",
				configurationIdentity:
					typeof start.data.configurationIdentity === "string"
						? redactAnsteelSensitiveText(start.data.configurationIdentity)
						: "unavailable",
				timeoutMs: typeof start.data.timeoutMs === "number" ? start.data.timeoutMs : null,
				retryCount,
			};
		});
	const tools = entries
		.filter(
			(entry) =>
				entry.eventName === "tool.call.started" && entry.outcome === "started" && entry.toolCallId !== undefined,
		)
		.map((entry) => ({
			toolCallId: entry.toolCallId!,
			...(entry.role === undefined ? {} : { role: entry.role }),
			toolName:
				typeof entry.data.toolName === "string"
					? redactAnsteelSensitiveText(entry.data.toolName)
					: Object.hasOwn(entry.data, "command")
						? "governed-command"
						: "unavailable",
			policyBoundary: typeof entry.data.denialBoundary === "string" ? entry.data.denialBoundary : "governed-runtime",
		}));
	const runtimeEnvironment = readAnsteelIncidentRuntimeEnvironment(entries);
	return {
		...(runtimeEnvironment === undefined ? {} : { runtimeEnvironment }),
		providers,
		tools,
	};
}

export function createAnsteelTeamIncidentBundle(
	cwd: string,
	runId: string,
	projectContext: AnsteelIncidentProjectContext = {
		availability: "unavailable",
		reasonCode: "team-state-missing",
	},
): AnsteelIncidentBundle {
	const diagnosis = diagnoseAnsteelTeamRun(cwd, runId);
	let entries: AnsteelRuntimeLogEntry[] = [];
	let chainError: unknown;
	try {
		entries = readAnsteelRuntimeLogs(cwd, runId);
	} catch (error) {
		chainError = error;
	}
	const segmentInspection = inspectAnsteelIncidentLogSegments(cwd, runId);
	const artifactRefs = new Map<string, AnsteelRuntimeArtifactRef>();
	for (const entry of entries) {
		for (const artifact of entry.artifactRefs) artifactRefs.set(`${artifact.kind}:${artifact.sha256}`, artifact);
	}
	const artifactResults = [...artifactRefs.values()]
		.sort((left, right) => left.kind.localeCompare(right.kind) || left.sha256.localeCompare(right.sha256))
		.map((artifact) => {
			const inspection = inspectAnsteelRuntimeArtifact(artifact);
			return {
				kind: artifact.kind,
				sha256: artifact.sha256,
				verificationResult:
					inspection.verificationResult === "verified"
						? ("verified" as const)
						: inspection.verificationResult === "hash-mismatch"
							? ("hash-mismatch" as const)
							: ("missing" as const),
				...(inspection.actualHash === undefined ? {} : { actualHash: inspection.actualHash }),
			};
		});
	const verifiedArtifactCount = artifactResults.filter((result) => result.verificationResult === "verified").length;
	const missingArtifactCount = artifactResults.length - verifiedArtifactCount;
	const rootCauseIndex =
		diagnosis.rootCause === undefined ? -1 : entries.findIndex((entry) => entry.hash === diagnosis.rootCause!.hash);
	const propagationEvents =
		rootCauseIndex < 0
			? []
			: entries
					.slice(rootCauseIndex + 1)
					.filter(
						(entry) =>
							entry.outcome === "failed" || entry.outcome === "cancelled" || entry.outcome === "abandoned",
					)
					.map(toAnsteelIncidentEventRef);
	const rootStart = entries.find(
		(entry) => entry.eventName === "run.started" && entry.outcome === "started" && entry.parentSpanId === undefined,
	);
	const terminalEntry =
		rootStart === undefined
			? undefined
			: entries.find(
					(entry) => entry.sequence > rootStart.sequence && isAnsteelRuntimeTerminalForStart(rootStart, entry),
				);
	const lastObservedEntry = entries.at(-1);
	const chainMessage =
		chainError === undefined
			? undefined
			: redactAnsteelSensitiveText(chainError instanceof Error ? chainError.message : String(chainError));
	const manifest: AnsteelIncidentBundle["manifest"] = {
		schemaVersion: 2,
		evidenceModel: "mechanical-facts-only",
		run: {
			runId,
			...(diagnosis.traceId === undefined ? {} : { traceId: diagnosis.traceId }),
			...(entries[0]?.teamId === undefined ? {} : { teamId: entries[0].teamId }),
			...(entries[0]?.timestampUtc === undefined ? {} : { startedAt: entries[0].timestampUtc }),
			...(entries.at(-1)?.timestampUtc === undefined ? {} : { endedAt: entries.at(-1)!.timestampUtc }),
			...(terminalEntry === undefined ? {} : { terminalOutcome: terminalEntry.outcome }),
		},
		healthy: diagnosis.healthy,
		...(diagnosis.rootCause === undefined ? {} : { rootCause: diagnosis.rootCause }),
		propagationEvents,
		finalRuntimeState: {
			...(terminalEntry === undefined ? {} : { terminalEvent: toAnsteelIncidentEventRef(terminalEntry) }),
			...(lastObservedEntry === undefined
				? {}
				: { lastObservedEvent: toAnsteelIncidentEventRef(lastObservedEntry) }),
		},
		issues: diagnosis.issues,
		spanTree: createAnsteelIncidentSpanTree(entries),
		logSegments: segmentInspection.segments,
		artifactRefs: [...artifactRefs.values()].sort(
			(left, right) => left.kind.localeCompare(right.kind) || left.sha256.localeCompare(right.sha256),
		),
		configurationSummary: createAnsteelIncidentConfigurationSummary(entries),
		integrity: {
			runtimeEventChain:
				chainError === undefined && entries.length > 0
					? {
							status: "verified",
							entryCount: entries.length,
							...(entries.at(-1)?.hash === undefined ? {} : { headHash: entries.at(-1)!.hash }),
						}
					: {
							status: "failed",
							entryCount: 0,
							reasonCode:
								chainError === undefined
									? ("artifact-missing" as const)
									: chainError instanceof AnsteelObservabilityError
										? chainError.reasonCode
										: ("event-chain-invalid" as const),
							...(chainError === undefined
								? { message: `Ansteel runtime run ${runId} has no persisted logs` }
								: chainMessage === undefined
									? {}
									: { message: chainMessage }),
						},
			logSegments: {
				status: segmentInspection.status,
				...(segmentInspection.runIndexHash === undefined ? {} : { runIndexHash: segmentInspection.runIndexHash }),
			},
			artifacts: {
				status:
					chainError !== undefined || entries.length === 0
						? "unavailable"
						: missingArtifactCount === 0
							? "verified"
							: "failed",
				verifiedCount: verifiedArtifactCount,
				missingCount: missingArtifactCount,
				results: artifactResults,
			},
		},
		projectContext,
	};
	// JCS 保证相同证据的重复请求产生完全一致的字节、SHA-256 和存储路径。事故文件位于
	// `.pi` 下，而工作区指纹明确排除该协调器私有目录，因此生成事故包不会扰动包内工作区哈希。
	const content = `${canonicalizeAnsteelAuditValue(manifest)}\n`;
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

export interface AnsteelRuntimeLoggerOptions {
	/**
	 * 记录外部可见的 run writer 锁生命周期。内部 index 锁和审计门仍是实现细节，
	 * 否则“记录一次 lease 事件”本身又需要新的被审计 lease，会形成递归依赖。
	 */
	auditRunLease?: boolean;
	/**
	 * 当损坏的历史链导致共享索引不可读时，允许独立诊断 run 将自身哈希链记录持久化。
	 * 该路径绝不修复、覆盖或重新签署损坏索引；普通业务 run 仍必须失败关闭，只有显式诊断
	 * 写入可以进入这个隔离边界。
	 */
	allowUnindexedDiagnosticWrites?: boolean;
}

export function createAnsteelRuntimeLogger(
	cwd: string,
	context: AnsteelRunContext,
	options: AnsteelRuntimeLoggerOptions = {},
): AnsteelRuntimeLogger {
	assertRunId(context.runId);
	if (!/^[0-9a-f]{32}$/.test(context.traceId)) {
		throw new AnsteelObservabilityError("unclassified-runtime-error", "Ansteel runtime trace ID is invalid");
	}
	const directory = getAnsteelRuntimeLogDirectory(cwd);
	mkdirSync(directory, { recursive: true });
	const runLockPath = getAnsteelRuntimeLogPath(cwd, context.runId);
	let runLock: AnsteelRuntimeLockHandle;
	try {
		runLock = acquireAnsteelRuntimeLock(
			runLockPath,
			"run",
			ANSTEEL_RUNTIME_LOG_LOCK_STALE_MS,
			ANSTEEL_RUNTIME_LOG_LOCK_UPDATE_MS,
		);
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
		runLock.release();
		throw error;
	}
	let sequence = existing.length + 1;
	let previousHash = existing.at(-1)?.hash ?? null;
	const startedAt = process.hrtime.bigint();
	const runtimeEnvironment = createAnsteelRuntimeEnvironmentFingerprint(cwd);
	let closed = false;
	let writingReleaseReceipt = false;
	let leaseAuditFailure: Error | undefined;

	const writeBatch = (inputs: readonly AnsteelRuntimeLogInput[]): AnsteelRuntimeLogEntry[] => {
		if (closed) {
			throw new AnsteelObservabilityError("event-fsync-failed", "Ansteel runtime logger is closed");
		}
		if (options.auditRunLease && !writingReleaseReceipt) runLock.assertOwned();
		if (leaseAuditFailure !== undefined) throw leaseAuditFailure;
		if (inputs.length === 0) return [];
		let nextSequence = sequence;
		let nextPreviousHash = previousHash;
		const persistedEntries: AnsteelRuntimeLogEntry[] = [];
		const sourceEntries: AnsteelRuntimeLogEntry[] = [];
		interface PreparedRuntimeLogInput {
			input: AnsteelRuntimeLogInput;
			security: {
				findingCount: number;
				sensitiveFieldCount: number;
				sensitiveTextMatchCount: number;
				surfaces: Array<"message" | "data" | "artifact">;
			};
		}
		const validateInputMetadata = (input: AnsteelRuntimeLogInput): void => {
			assertAnsteelRuntimeEventCombination(input.eventName, input.outcome);
			if (input.reasonCode !== undefined && !isAnsteelRuntimeReasonCode(input.reasonCode)) {
				throw new AnsteelObservabilityError("event-chain-invalid", "Ansteel runtime reason code is invalid");
			}
			if (
				(input.eventName.startsWith("artifact.") || input.eventName.startsWith("security.")) &&
				(input.artifacts?.length ?? 0) > 0
			) {
				throw new AnsteelObservabilityError(
					"event-chain-invalid",
					"Ansteel artifact and security lifecycle events cannot recursively attach artifacts",
				);
			}
		};
		const validateInput = (input: AnsteelRuntimeLogInput): void => {
			validateInputMetadata(input);
			assertAnsteelRuntimeEventData(input.eventName, input.outcome, input.data);
		};
		const prepareInput = (input: AnsteelRuntimeLogInput): PreparedRuntimeLogInput => {
			const message = inspectAndRedactAnsteelSensitiveText(input.message);
			const data = inspectAndRedactAnsteelSensitiveValue(input.data);
			const surfaces = new Set<"message" | "data" | "artifact">();
			if (message.findingCount > 0) surfaces.add("message");
			if (data.findingCount > 0) surfaces.add("data");
			let findingCount = message.findingCount + data.findingCount;
			let sensitiveFieldCount = message.sensitiveFieldCount + data.sensitiveFieldCount;
			let sensitiveTextMatchCount = message.sensitiveTextMatchCount + data.sensitiveTextMatchCount;
			const artifacts = input.artifacts?.map((artifact) => {
				const content = inspectAndRedactAnsteelSensitiveText(artifact.content);
				if (content.findingCount > 0) surfaces.add("artifact");
				findingCount += content.findingCount;
				sensitiveFieldCount += content.sensitiveFieldCount;
				sensitiveTextMatchCount += content.sensitiveTextMatchCount;
				return { ...artifact, content: content.value };
			});
			return {
				input: {
					...input,
					message: message.value,
					data: data.value as Record<string, unknown>,
					...(artifacts === undefined ? {} : { artifacts }),
				},
				security: {
					findingCount,
					sensitiveFieldCount,
					sensitiveTextMatchCount,
					surfaces: [...surfaces],
				},
			};
		};
		// 在创建第一个内容寻址文件前先校验整批输入。security 事件自身若仍含秘密必须直接拒绝；
		// 若对 security 事件再次静默脱敏，会递归产生新的 security 事件并破坏明确因果链。
		const preparedInputs = inputs.map((input) => {
			validateInputMetadata(input);
			const prepared = prepareInput(input);
			if (input.eventName.startsWith("security.") && prepared.security.findingCount > 0) {
				throw new AnsteelObservabilityError(
					"event-chain-invalid",
					"Ansteel security lifecycle events must already contain only non-sensitive metadata",
				);
			}
			assertAnsteelRuntimeEventData(prepared.input.eventName, prepared.input.outcome, prepared.input.data);
			return prepared;
		});
		const appendEntry = (
			input: AnsteelRuntimeLogInput,
			artifactRefs: AnsteelRuntimeArtifactRef[],
		): AnsteelRuntimeLogEntry => {
			validateInput(input);
			const { artifacts: _artifacts, spanId: inputSpanId, data, ...fields } = input;
			const unsigned = {
				schemaVersion: 1 as const,
				eventCatalogVersion: ANSTEEL_RUNTIME_EVENT_CATALOG_VERSION,
				timestampUtc: new Date().toISOString(),
				monotonicElapsedNs: (process.hrtime.bigint() - startedAt).toString(),
				sequence: nextSequence,
				...fields,
				runId: context.runId,
				traceId: context.traceId,
				spanId: inputSpanId ?? randomBytes(8).toString("hex"),
				teamId: context.teamId,
				message: redactAnsteelSensitiveText(input.message),
				data: redactRecord(data),
				artifactRefs,
				previousHash: nextPreviousHash,
			};
			const entry: AnsteelRuntimeLogEntry = { ...unsigned, hash: hashRuntimeLogEntry(unsigned) };
			nextSequence++;
			nextPreviousHash = entry.hash;
			persistedEntries.push(entry);
			return entry;
		};
		const relatedFields = (source: AnsteelRuntimeLogEntry) => ({
			...(source.sessionId === undefined ? {} : { sessionId: source.sessionId }),
			...(source.taskId === undefined ? {} : { taskId: source.taskId }),
			...(source.checkpointId === undefined ? {} : { checkpointId: source.checkpointId }),
			...(source.issueId === undefined ? {} : { issueId: source.issueId }),
			...(source.toolCallId === undefined ? {} : { toolCallId: source.toolCallId }),
			...(source.providerRequestId === undefined ? {} : { providerRequestId: source.providerRequestId }),
			...(source.processId === undefined ? {} : { processId: source.processId }),
			...(source.leaseId === undefined ? {} : { leaseId: source.leaseId }),
			...(source.revision === undefined ? {} : { revision: source.revision }),
			...(source.diffHash === undefined ? {} : { diffHash: source.diffHash }),
		});
		const appendSecurityEvents = (
			source: AnsteelRuntimeLogEntry,
			security: PreparedRuntimeLogInput["security"],
		): void => {
			if (
				source.eventName === "tool.call.completed" &&
				source.outcome === "failed" &&
				source.reasonCode === "tool-policy-denied"
			) {
				appendEntry(
					{
						level: "audit",
						eventName: "security.access-denied",
						outcome: "failed",
						reasonCode: "tool-policy-denied",
						role: source.role ?? "coordinator",
						parentSpanId: source.spanId,
						...relatedFields(source),
						causeEventId: source.hash,
						message: "Ansteel tool access was denied by a mechanical policy boundary",
						data: {
							sourceEventName: source.eventName,
							sourceSequence: source.sequence,
							denialBoundary:
								typeof source.data.denialBoundary === "string" ? source.data.denialBoundary : "tool-policy",
						},
					},
					[],
				);
			}
			if (source.eventName.startsWith("security.") || security.findingCount === 0) return;
			const auditData = {
				sourceEventName: source.eventName,
				sourceSequence: source.sequence,
				redactionBoundary: "runtime-persistence",
				findingCount: security.findingCount,
				sensitiveFieldCount: security.sensitiveFieldCount,
				sensitiveTextMatchCount: security.sensitiveTextMatchCount,
				surfaces: security.surfaces,
			};
			appendEntry(
				{
					level: "audit",
					eventName: "security.secret-detected",
					outcome: "failed",
					reasonCode: "secret-detected",
					role: source.role ?? "coordinator",
					parentSpanId: source.spanId,
					...relatedFields(source),
					causeEventId: source.hash,
					message: "Ansteel detected sensitive content before runtime persistence",
					data: auditData,
				},
				[],
			);
			appendEntry(
				{
					level: "audit",
					eventName: "security.redaction-applied",
					outcome: "succeeded",
					role: source.role ?? "coordinator",
					parentSpanId: source.spanId,
					...relatedFields(source),
					causeEventId: source.hash,
					message: "Ansteel applied redaction before runtime persistence",
					data: auditData,
				},
				[],
			);
		};
		for (const prepared of preparedInputs) {
			const { input, security } = prepared;
			const storedArtifacts = (input.artifacts ?? []).map((artifact) => storeArtifact(cwd, artifact));
			const source = appendEntry(
				input,
				storedArtifacts.map((artifact) => artifact.ref),
			);
			sourceEntries.push(source);
			appendSecurityEvents(source, security);
			for (const artifact of storedArtifacts) {
				const stored = artifact.storageResult === "created";
				appendEntry(
					{
						level: "audit",
						eventName: stored ? "artifact.stored" : "artifact.verified",
						outcome: "succeeded",
						role: "coordinator",
						...relatedFields(source),
						causeEventId: source.hash,
						message: stored
							? `Ansteel runtime artifact ${artifact.ref.sha256} was durably stored`
							: `Ansteel runtime artifact ${artifact.ref.sha256} already existed and was verified`,
						data: {
							resourceKind: "content-addressed-artifact",
							sourceSequence: source.sequence,
							artifactKind: artifact.ref.kind,
							sha256: artifact.ref.sha256,
							contentByteLength: artifact.contentByteLength,
							storageResult: artifact.storageResult,
						},
					},
					[],
				);
			}
		}
		const persistEntries = (): void => {
			try {
				writeBuffer(
					fd,
					Buffer.from(`${persistedEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8"),
				);
				fsyncSync(fd);
			} catch (error) {
				throw new AnsteelObservabilityError(
					"event-fsync-failed",
					"Ansteel runtime log could not be durably written",
					{ cause: error },
				);
			}
			// 事件批次已经 fsync 落盘。即随后替换索引失败，也必须推进进程内 sequence 和
			// previousHash，防止重试复用旧游标并写出重复序号或错误前驱哈希。
			sequence = nextSequence;
			previousHash = nextPreviousHash;
		};
		withRuntimeIndexLock(cwd, () => {
			let index: AnsteelRuntimeIndex;
			try {
				index = readOrRebuildRuntimeIndexLocked(cwd, false);
			} catch (error) {
				if (
					!options.allowUnindexedDiagnosticWrites ||
					!(error instanceof AnsteelObservabilityError) ||
					error.reasonCode !== "event-chain-invalid"
				) {
					throw error;
				}
				// 调用方显式开启了独立诊断 run：其日志段依靠自身哈希链验证并已经 fsync，
				// 但故意不插入当前不可受信的共享索引，避免诊断动作掩盖原始索引损坏。
				persistEntries();
				return;
			}
			persistEntries();
			writeRuntimeIndexAtomic(cwd, replaceRuntimeIndexRunLocked(cwd, index, context.runId));
		});
		return sourceEntries;
	};
	const write = (input: AnsteelRuntimeLogInput): AnsteelRuntimeLogEntry => writeBatch([input])[0]!;

	if (options.auditRunLease) {
		const previousOwner = runLock.previousOwner;
		// 残留 owner 旁路文件本身不能证明 lease 已过期。先重放已验证 run，避免重复生成既有
		// release/expiry 回执；只有确实找不到该 owner 的持久终态事实时才按 lease-expired 失败关闭。
		if (
			previousOwner !== undefined &&
			!existing.some(
				(entry) =>
					entry.leaseId === previousOwner.ownerId &&
					(entry.eventName === "lease.released" || entry.eventName === "lease.expired"),
			)
		) {
			write({
				level: "error",
				eventName: "lease.expired",
				outcome: "failed",
				reasonCode: "lease-expired",
				role: "coordinator",
				leaseId: previousOwner.ownerId,
				message: "A previous Ansteel runtime writer lease ended without a durable release receipt",
				data: {
					resourceKind: "runtime-run",
					resourceHash: runLock.resourceHash,
					lockKind: previousOwner.lockKind,
					ownerPid: previousOwner.pid,
					ownerProcessStartedAtUtc: previousOwner.processStartedAtUtc,
					ownerExecutableHash: previousOwner.executableHash,
					ownerCommandHash: previousOwner.commandHash,
					ownerWorkingDirectoryHash: previousOwner.workingDirectoryHash,
					acquiredAtUtc: previousOwner.acquiredAtUtc,
					detectedAtUtc: new Date().toISOString(),
					replacementLeaseId: runLock.owner.ownerId,
				},
			});
		}
		write({
			level: "audit",
			eventName: "lease.acquired",
			outcome: "succeeded",
			role: "coordinator",
			leaseId: runLock.owner.ownerId,
			message: "Ansteel runtime writer lease was acquired",
			data: {
				resourceKind: "runtime-run",
				resourceHash: runLock.resourceHash,
				lockKind: runLock.owner.lockKind,
				ownerPid: runLock.owner.pid,
				ownerProcessStartedAtUtc: runLock.owner.processStartedAtUtc,
				ownerExecutableHash: runLock.owner.executableHash,
				ownerCommandHash: runLock.owner.commandHash,
				ownerWorkingDirectoryHash: runLock.owner.workingDirectoryHash,
				acquiredAtUtc: runLock.owner.acquiredAtUtc,
				staleAfterMs: ANSTEEL_RUNTIME_LOG_LOCK_STALE_MS,
				renewEveryMs: ANSTEEL_RUNTIME_LOG_LOCK_UPDATE_MS,
				expiresAtUtc: new Date(
					Date.parse(runLock.owner.acquiredAtUtc) + ANSTEEL_RUNTIME_LOG_LOCK_STALE_MS,
				).toISOString(),
			},
		});
		runLock.setRenewedListener((renewedAtUtc, renewalCount) => {
			if (closed || writingReleaseReceipt || leaseAuditFailure !== undefined) return;
			try {
				write({
					level: "audit",
					eventName: "lease.renewed",
					outcome: "progress",
					role: "coordinator",
					leaseId: runLock.owner.ownerId,
					message: "Ansteel runtime writer lease was renewed by the lock owner",
					data: {
						resourceKind: "runtime-run",
						resourceHash: runLock.resourceHash,
						ownerPid: runLock.owner.pid,
						renewedAtUtc,
						renewalCount,
						expiresAtUtc: new Date(Date.parse(renewedAtUtc) + ANSTEEL_RUNTIME_LOG_LOCK_STALE_MS).toISOString(),
					},
				});
			} catch (error) {
				leaseAuditFailure =
					error instanceof Error ? error : new AnsteelObservabilityError("event-fsync-failed", String(error));
			}
		});
	}

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
		const startEventName = getAnsteelRuntimeSpanStartEventName(eventName);
		const openTelemetrySpan = tracer.startSpan(eventName, undefined, parentContext);
		const spanContext = openTelemetrySpan.spanContext();
		const parentSpanId = options.parent?.spanId;
		const { parent: _parent, message, data, ...fields } = options;
		const rootData =
			startEventName === "run.started" && options.parent === undefined
				? {
						...(data ?? {}),
						command: context.command,
						runtimeEnvironment,
						...(context.resumedFromRunId === undefined
							? {}
							: {
									resumedFromRunId: context.resumedFromRunId,
									resumedFromSequence: context.resumedFromSequence,
								}),
					}
				: (data ?? {});
		const startInputs: AnsteelRuntimeLogInput[] = [
			{
				level: "info",
				eventName: startEventName,
				outcome: "started",
				...fields,
				spanId: spanContext.spanId,
				...(parentSpanId === undefined ? {} : { parentSpanId }),
				message: message ?? `${eventName} started`,
				data: rootData,
			},
		];
		if (startEventName === "run.started" && options.parent === undefined && context.resumedFromRunId !== undefined) {
			startInputs.push({
				level: "info",
				eventName: "run.resumed",
				outcome: "progress",
				...fields,
				spanId: spanContext.spanId,
				message: "Ansteel team command resumed from a durable runtime boundary",
				data: {
					resumedFromRunId: context.resumedFromRunId,
					resumedFromSequence: context.resumedFromSequence,
				},
			});
		}
		writeBatch(startInputs);
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
				const normalizedInput =
					startEventName === "run.started" && options.parent === undefined
						? { ...input, data: { ...(input.data ?? {}), command: context.command } }
						: input;
				pendingEnds.set(spanContext.spanId, {
					eventName: getAnsteelRuntimeSpanTerminalEventName(startEventName, input.outcome),
					fields,
					parentSpanId,
					input: normalizedInput,
				});
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
		writeBatch,
		startSpan,
		forceFlush: () => provider.forceFlush(),
		close() {
			if (closed) return;
			let closeError: unknown;
			try {
				fsyncSync(fd);
				if (leaseAuditFailure !== undefined) throw leaseAuditFailure;
				if (options.auditRunLease) {
					runLock.release((receipt) => {
						writingReleaseReceipt = true;
						try {
							write({
								level: "audit",
								eventName: "lease.released",
								outcome: "succeeded",
								role: "coordinator",
								leaseId: runLock.owner.ownerId,
								message: "Ansteel runtime writer lease was released",
								data: {
									resourceKind: "runtime-run",
									resourceHash: runLock.resourceHash,
									ownerPid: runLock.owner.pid,
									releasedAtUtc: receipt.releasedAtUtc,
									renewalCount: receipt.renewalCount,
									heldDurationMs: Math.max(
										0,
										Date.parse(receipt.releasedAtUtc) - Date.parse(runLock.owner.acquiredAtUtc),
									),
								},
							});
						} finally {
							writingReleaseReceipt = false;
						}
					});
				} else {
					runLock.release();
				}
			} catch (error) {
				closeError = error;
			} finally {
				try {
					closeSync(fd);
				} catch (error) {
					closeError ??= error;
				}
				closed = true;
			}
			if (closeError !== undefined) throw closeError;
		},
	};
}
