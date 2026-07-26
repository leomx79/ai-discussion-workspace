import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const ansteelTeamExtensionPath = resolve(__dirname, "../src/extensions/ansteel-team/index.ts");
const temporaryDirectories: string[] = [];

const DETERMINISTIC_TEAM_PROVIDER_EXTENSION = `
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

function register(pi, provider, model, responses) {
	const faux = fauxProvider({ provider, models: [{ id: model }] });
	faux.setResponses(responses);
	const registeredModel = faux.getModel();
	pi.registerProvider(provider, {
		api: registeredModel.api,
		apiKey: "deterministic-test-key",
		baseUrl: registeredModel.baseUrl,
		streamSimple: (resolvedModel, context, options) => faux.provider.streamSimple(resolvedModel, context, options),
		models: [{
			id: model,
			name: registeredModel.name,
			reasoning: registeredModel.reasoning,
			input: registeredModel.input,
			cost: registeredModel.cost,
			contextWindow: registeredModel.contextWindow,
			maxTokens: registeredModel.maxTokens,
		}],
	});
}

export default function (pi) {
	register(pi, "deterministic-team-tl", "tl", [
		fauxAssistantMessage([
			fauxToolCall("ansteel_claim_task", {
				id: "TASK-TL",
				files: ["src/tl.ts"],
				description: "Attempt an unauthorized implementation change.",
				acceptanceCriteria: "This must be rejected by the owner policy.",
			}),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage("Tech Lead recorded the owner-policy rejection."),
		fauxAssistantMessage("Tech Lead completed cross-examination."),
	]);
	register(pi, "deterministic-team-staff", "staff", [
		fauxAssistantMessage([
			fauxToolCall("ansteel_claim_task", {
				id: "TASK-STAFF",
				files: ["src/staff.ts"],
				description: "Claim the authorized implementation change.",
				acceptanceCriteria: "The task must be recorded in the public ledger.",
			}),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage("Staff Engineer recorded the authorized task claim."),
		fauxAssistantMessage("Staff Engineer completed cross-examination."),
	]);
	register(pi, "deterministic-team-qa", "qa", [
		fauxAssistantMessage("QA Engineer completed independent investigation."),
		fauxAssistantMessage("QA Engineer completed cross-examination."),
	]);
}
`;

interface RpcRecord {
	id?: string;
	type?: string;
	command?: string;
	success?: boolean;
	data?: unknown;
	error?: string;
}

interface RpcCliProcess {
	child: ChildProcessWithoutNullStreams;
	records: () => RpcRecord[];
	stderr: () => string;
	send: (command: Record<string, unknown>) => Promise<RpcRecord>;
	stop: () => Promise<void>;
}

function createTemporaryProject(): { agentDir: string; projectDir: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-ansteel-team-cli-"));
	temporaryDirectories.push(root);
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	const extensionsDir = join(projectDir, ".pi", "extensions");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(extensionsDir, { recursive: true });
	writeFileSync(join(extensionsDir, "deterministic-team-provider.ts"), DETERMINISTIC_TEAM_PROVIDER_EXTENSION, "utf8");
	writeFileSync(
		join(projectDir, ".pi", "ansteel.json"),
		JSON.stringify(
			{
				stageTimeoutMs: 5_000,
				roles: {
					"tech-lead": { model: "deterministic-team-tl/tl", tools: [] },
					"staff-engineer": { model: "deterministic-team-staff/staff", tools: [] },
					"qa-engineer": { model: "deterministic-team-qa/qa", tools: [] },
				},
			},
			null,
			2,
		),
		"utf8",
	);
	return { agentDir, projectDir };
}

function startRpcCli(projectDir: string, agentDir: string): RpcCliProcess {
	const child = spawn(
		process.execPath,
		[
			cliPath,
			"--mode",
			"rpc",
			"-e",
			join(projectDir, ".pi", "extensions", "deterministic-team-provider.ts"),
			"-e",
			ansteelTeamExtensionPath,
		],
		{
			cwd: projectDir,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: agentDir,
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
			},
		},
	);
	let stderr = "";
	let pending = "";
	const records: RpcRecord[] = [];
	const waiters = new Map<string, { resolve: (record: RpcRecord) => void; reject: (error: Error) => void }>();
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	child.stdout.on("data", (chunk) => {
		pending += chunk.toString();
		let newlineIndex = pending.indexOf("\n");
		while (newlineIndex !== -1) {
			const line = pending.slice(0, newlineIndex).trim();
			pending = pending.slice(newlineIndex + 1);
			if (line.length > 0) {
				const record = JSON.parse(line) as RpcRecord;
				records.push(record);
				if (record.type === "response" && record.id !== undefined) {
					const waiter = waiters.get(record.id);
					if (waiter) {
						waiters.delete(record.id);
						waiter.resolve(record);
					}
				}
			}
			newlineIndex = pending.indexOf("\n");
		}
	});
	child.on("error", (error) => {
		for (const waiter of waiters.values()) waiter.reject(error);
		waiters.clear();
	});
	child.on("exit", (code) => {
		for (const waiter of waiters.values()) {
			waiter.reject(new Error(`Ansteel team RPC CLI exited with code ${code}. Stderr: ${stderr}`));
		}
		waiters.clear();
	});

	return {
		child,
		records: () => [...records],
		stderr: () => stderr,
		send: async (command) => {
			const id = String(command.id);
			return await new Promise<RpcRecord>((resolvePromise, reject) => {
				const timeout = setTimeout(() => {
					waiters.delete(id);
					reject(new Error(`Timed out waiting for RPC response ${id}. Stderr: ${stderr}`));
				}, 15_000);
				waiters.set(id, {
					resolve: (record) => {
						clearTimeout(timeout);
						resolvePromise(record);
					},
					reject: (error) => {
						clearTimeout(timeout);
						reject(error);
					},
				});
				child.stdin.write(`${JSON.stringify(command)}\n`);
			});
		},
		stop: async () => {
			if (child.exitCode !== null) return;
			await new Promise<void>((resolvePromise) => {
				child.once("exit", () => resolvePromise());
				child.stdin.end();
			});
		},
	};
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("Ansteel team CLI", () => {
	it("enforces the default task-owner policy through real role tool calls and records the result", async () => {
		const { agentDir, projectDir } = createTemporaryProject();
		const rpc = startRpcCli(projectDir, agentDir);
		try {
			const commands = await rpc.send({ id: "commands", type: "get_commands" });
			expect(commands).toMatchObject({ success: true, command: "get_commands" });
			const teamCommand = (commands.data as { commands: Array<{ name: string }> }).commands.find((command) =>
				command.name.startsWith("ansteel-team"),
			)?.name;
			expect(teamCommand).toBeDefined();

			const start = await rpc.send({
				id: "start",
				type: "prompt",
				message: `/${teamCommand} start Exercise the deterministic owner policy`,
			});
			expect(start).toMatchObject({ success: true, command: "prompt" });

			const teamDirectory = join(projectDir, ".pi", "ansteel-team");
			const statePath = join(teamDirectory, "team.json");
			const eventsPath = join(teamDirectory, "events.jsonl");
			if (!existsSync(statePath)) {
				throw new Error(`Ansteel team state was not created. RPC: ${JSON.stringify(rpc.records())}. Stderr: ${rpc.stderr()}`);
			}
			expect(existsSync(eventsPath)).toBe(true);
			const state = JSON.parse(readFileSync(statePath, "utf8")) as {
				taskOwners: string[];
				tasks: Array<{ id: string; owner: string; status: string }>;
				roles: { "tech-lead": { sessionFile: string }; "staff-engineer": { sessionFile: string } };
			};
			const events = readFileSync(eventsPath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { type: string; role: string; content: string });
			expect(state.taskOwners).toEqual(["staff-engineer"]);
			if (state.tasks.length === 0) {
				const staffSessionPath = state.roles["staff-engineer"].sessionFile;
				const staffSession = existsSync(staffSessionPath) ? readFileSync(staffSessionPath, "utf8") : "(not created)";
				throw new Error(
					`Staff task was not claimed. Events: ${JSON.stringify(events)}. Staff session: ${staffSession}. RPC: ${JSON.stringify(rpc.records())}`,
				);
			}
			expect(state.tasks).toEqual([expect.objectContaining({ id: "TASK-STAFF", owner: "staff-engineer", status: "claimed" })]);
			expect(events).toContainEqual(
				expect.objectContaining({ type: "task-claimed", role: "staff-engineer", content: expect.stringContaining("TASK-STAFF") }),
			);
			expect(events).not.toContainEqual(expect.objectContaining({ type: "task-claimed", role: "tech-lead" }));
			expect(readFileSync(state.roles["tech-lead"].sessionFile, "utf8")).toContain(
				"tech-lead is not authorized to claim change tasks",
			);
			expect(readFileSync(state.roles["staff-engineer"].sessionFile, "utf8")).toContain("Claimed TASK-STAFF");

			const stop = await rpc.send({ id: "stop", type: "prompt", message: `/${teamCommand} stop` });
			expect(stop).toMatchObject({ success: true, command: "prompt" });
			expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ status: "stopped" });
		} finally {
			await rpc.stop();
		}
	});
});
