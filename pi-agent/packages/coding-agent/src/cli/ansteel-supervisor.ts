import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
	getAnsteelRunCheckpointPath,
	loadAnsteelRunCheckpoint,
	type AnsteelRunCheckpointStatus,
} from "../core/ansteel-run.ts";

export type AnsteelEpochCall =
	| { kind: "new"; topic: string }
	| { kind: "resume"; runId: string };

export interface AnsteelEpochSupervisorOptions {
	topic?: string;
	resumeRunId?: string;
	maxEpochs: number;
	cwd?: string;
	listRunIds?: () => string[];
	loadCheckpoint?: (runId: string) => { id: string; status: AnsteelRunCheckpointStatus | string };
	runEpoch: (call: AnsteelEpochCall) => Promise<number>;
}

export interface AnsteelEpochSupervisorResult {
	outcome: "terminal" | "limit-reached" | "child-failed" | "invalid-checkpoint";
	runId?: string;
	epochsStarted: number;
	exitCode: number;
}

/** Runs bounded review epochs until their durable checkpoint reaches a terminal state. */
export async function runAnsteelEpochSupervisor(
	options: AnsteelEpochSupervisorOptions,
): Promise<AnsteelEpochSupervisorResult> {
	const cwd = options.cwd ?? process.cwd();
	const listRunIds = options.listRunIds ?? (() => readdirSync(join(cwd, ".pi", "ansteel-runs")));
	const loadCheckpoint =
		options.loadCheckpoint ?? ((runId: string) => loadAnsteelRunCheckpoint(getAnsteelRunCheckpointPath(cwd, runId)));
	let runId = options.resumeRunId;

	for (let epoch = 0; epoch < options.maxEpochs; epoch++) {
		const before = runId === undefined ? new Set(listRunIds()) : undefined;
		if (runId === undefined && options.topic === undefined) {
			throw new Error("Ansteel epoch supervisor requires a topic for a new run");
		}
		const exitCode = await options.runEpoch(
			runId === undefined ? { kind: "new", topic: options.topic! } : { kind: "resume", runId },
		);
		if (exitCode !== 0) return { outcome: "child-failed", runId, epochsStarted: epoch + 1, exitCode };
		if (runId === undefined) runId = getOnlyNewRunId(before!, listRunIds());

		let checkpoint: { id: string; status: AnsteelRunCheckpointStatus | string };
		try {
			checkpoint = loadCheckpoint(runId);
		} catch {
			return { outcome: "invalid-checkpoint", runId, epochsStarted: epoch + 1, exitCode: 1 };
		}
		if (checkpoint.status === "ready-to-resume") continue;
		if (
			checkpoint.status === "completed" ||
			checkpoint.status === "failed" ||
			checkpoint.status === "expired"
		) {
			return { outcome: "terminal", runId, epochsStarted: epoch + 1, exitCode: 0 };
		}
		return { outcome: "invalid-checkpoint", runId, epochsStarted: epoch + 1, exitCode: 1 };
	}

	return { outcome: "limit-reached", runId, epochsStarted: options.maxEpochs, exitCode: 1 };
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
