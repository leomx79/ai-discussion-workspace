import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { type FileHandle, open, stat } from "node:fs/promises";

export interface GuardedFileMutationHandle {
	/** Read from the file object that was verified against the approved path. */
	readFile: () => Promise<Buffer>;
	/** Recheck that the approved path still names the opened file object. */
	revalidate: () => Promise<void>;
	/** Replace the opened file contents without resolving the path again. */
	replaceFile: (content: string) => Promise<void>;
}

export type GuardedFileMutationExecutor = <T>(
	absolutePath: string,
	mutation: (handle: GuardedFileMutationHandle) => Promise<T>,
) => Promise<T>;

export type GuardedPathValidator = (absolutePath: string) => void | Promise<void>;

export interface GuardedFileIdentity {
	dev: bigint;
	ino: bigint;
	sha256: string;
}

export interface GuardedFileMutationController {
	/** Authorize exactly one subsequent mutation of the approved file object. */
	authorize: (absolutePath: string, identity: GuardedFileIdentity) => void;
	/** Execute the one-shot mutation after consuming its exact authorization. */
	execute: GuardedFileMutationExecutor;
}

function isSameFile(left: BigIntStats, right: BigIntStats): boolean {
	// A zero inode does not provide a usable identity guarantee on this platform.
	// Failing closed is safer than silently falling back to a path-string check.
	return left.dev === right.dev && left.ino !== 0n && left.ino === right.ino;
}

function hasIdentity(stats: BigIntStats, identity: GuardedFileIdentity): boolean {
	return stats.isFile() && identity.ino !== 0n && stats.dev === identity.dev && stats.ino === identity.ino;
}

async function readOpenedFile(
	fileHandle: FileHandle,
	identity: GuardedFileIdentity,
	absolutePath: string,
): Promise<Buffer> {
	const before = await fileHandle.stat({ bigint: true });
	if (!hasIdentity(before, identity) || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new Error("The approved file identity or size changed while reading");
	}
	const content = Buffer.alloc(Number(before.size));
	let offset = 0;
	while (offset < content.length) {
		const { bytesRead } = await fileHandle.read(content, offset, content.length - offset, offset);
		if (bytesRead <= 0) throw new Error("The approved file ended while reading");
		offset += bytesRead;
	}
	const after = await fileHandle.stat({ bigint: true });
	if (!hasIdentity(after, identity) || after.size !== before.size) {
		throw new Error("The approved file identity or size changed while reading");
	}
	const currentHash = createHash("sha256").update(content).digest("hex");
	if (currentHash !== identity.sha256) {
		throw guardedMutationError(absolutePath, "contents changed after peer approval");
	}
	return content;
}

function guardedMutationError(absolutePath: string, detail: string): Error {
	return new Error(`Guarded file mutation ${detail}: ${absolutePath}`);
}

/**
 * Build a one-shot mutation controller that binds review approval and I/O to
 * one existing file handle. The caller must authorize the exact device/inode
 * identity captured in the governed checkpoint before each execution.
 *
 * The immutable approved identity closes the remaining validate/open race: even
 * when an attacker swaps a parent junction after every successful path check,
 * an outside handle cannot match the file object approved by both peers. Later
 * writes use that verified handle, so another link swap cannot redirect I/O.
 * Creating a missing target is intentionally rejected because Node does not
 * expose a portable openat-style API that can atomically create a child relative
 * to a verified directory handle.
 */
export function createGuardedFileMutationController(validatePath: GuardedPathValidator): GuardedFileMutationController {
	let pendingAuthorization: { absolutePath: string; identity: GuardedFileIdentity } | undefined;
	const comparablePath = (value: string): string => (process.platform === "win32" ? value.toLowerCase() : value);

	const authorize = (absolutePath: string, identity: GuardedFileIdentity): void => {
		if (identity.ino === 0n) {
			throw guardedMutationError(absolutePath, "requires a stable non-zero approved file identity");
		}
		pendingAuthorization = { absolutePath, identity };
	};

	const execute: GuardedFileMutationExecutor = async <T>(
		absolutePath: string,
		mutation: (handle: GuardedFileMutationHandle) => Promise<T>,
	): Promise<T> => {
		const authorization = pendingAuthorization;
		pendingAuthorization = undefined;
		if (authorization === undefined || comparablePath(authorization.absolutePath) !== comparablePath(absolutePath)) {
			throw guardedMutationError(absolutePath, "requires a matching one-time approved file identity");
		}

		await validatePath(absolutePath);

		let fileHandle: FileHandle;
		try {
			fileHandle = await open(absolutePath, "r+");
		} catch (error: unknown) {
			const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
			if (code === "ENOENT") {
				throw guardedMutationError(
					absolutePath,
					"requires an existing regular file; atomic creation is unavailable",
				);
			}
			throw error;
		}

		try {
			const openedStats = await fileHandle.stat({ bigint: true });
			if (!hasIdentity(openedStats, authorization.identity)) {
				throw guardedMutationError(absolutePath, "opened a different file than the approved checkpoint");
			}

			const revalidateAndRead = async (): Promise<Buffer> => {
				await validatePath(absolutePath);
				const [openedStats, currentStats] = await Promise.all([
					fileHandle.stat({ bigint: true }),
					stat(absolutePath, { bigint: true }),
				]);
				if (
					!hasIdentity(openedStats, authorization.identity) ||
					!currentStats.isFile() ||
					!isSameFile(openedStats, currentStats)
				) {
					throw guardedMutationError(absolutePath, "target changed after approval");
				}
				// Return the exact buffer whose hash was checked. Edit must never
				// perform a second unchecked read after validation, because an
				// in-place ABA writer could otherwise substitute unreviewed bytes.
				return readOpenedFile(fileHandle, authorization.identity, absolutePath);
			};

			const revalidate = async (): Promise<void> => {
				await revalidateAndRead();
			};

			const replaceFile = async (content: string): Promise<void> => {
				await revalidate();
				const buffer = Buffer.from(content, "utf8");
				let offset = 0;
				while (offset < buffer.length) {
					const { bytesWritten } = await fileHandle.write(buffer, offset, buffer.length - offset, offset);
					if (bytesWritten <= 0) {
						throw guardedMutationError(absolutePath, "made no progress while writing");
					}
					offset += bytesWritten;
				}
				await fileHandle.truncate(buffer.length);
			};

			await revalidate();
			return await mutation({
				readFile: revalidateAndRead,
				revalidate,
				replaceFile,
			});
		} finally {
			await fileHandle.close();
		}
	};

	return { authorize, execute };
}
