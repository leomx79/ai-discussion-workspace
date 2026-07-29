import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnsteelConfig } from "../src/core/ansteel-discussion.ts";
import { listAnsteelTeamEvents, loadAnsteelTeamState } from "../src/core/ansteel-team.ts";
import {
	createAnsteelRunContext,
	createAnsteelRuntimeLogger,
	diagnoseAnsteelTeamRun,
	listAnsteelRuntimeRuns,
	readAnsteelRuntimeLogs,
} from "../src/core/ansteel-team-observability.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "../src/core/extensions/index.ts";
import {
	type AnsteelTeamRoleSession,
	type CreateAnsteelTeamRoleSessionOptions,
	createAnsteelTeamExtension,
	getAnsteelTeamEvidenceBlockReason,
} from "../src/extensions/ansteel-team/index.ts";

const temporaryDirectories: string[] = [];

function createTemporaryProject(): string {
	const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-team-extension-"));
	temporaryDirectories.push(cwd);
	return cwd;
}

function createConfig(): AnsteelConfig {
	return {
		allowSingleModel: false,
		maxToolCallsPerStage: 4,
		reportDirectory: "unused",
		roles: {
			"tech-lead": { model: "provider-a/model-a", tools: ["read"], skillPaths: [] },
			"staff-engineer": { model: "provider-b/model-b", tools: ["read"], skillPaths: [] },
			"qa-engineer": { model: "provider-c/model-c", tools: ["read"], skillPaths: [] },
		},
		stageTimeoutMs: 120_000,
	};
}

function initializeGitProject(cwd: string): void {
	mkdirSync(join(cwd, "src"), { recursive: true });
	mkdirSync(join(cwd, "test"), { recursive: true });
	writeFileSync(join(cwd, "src", "parser.ts"), "export const parser = 'before';\n", "utf8");
	writeFileSync(
		join(cwd, "test", "parser.test.mjs"),
		"import test from 'node:test';\ntest('parser', () => {});\n",
		"utf8",
	);
	execFileSync("git", ["init"], { cwd, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "ansteel@example.test"], { cwd, stdio: "ignore" });
	execFileSync("git", ["config", "user.name", "Ansteel Test"], { cwd, stdio: "ignore" });
	execFileSync("git", ["add", "src/parser.ts", "test/parser.test.mjs"], { cwd, stdio: "ignore" });
	execFileSync("git", ["commit", "-m", "baseline"], { cwd, stdio: "ignore" });
}

function setup(
	config = createConfig(),
	rolePrompt?: (role: string, prompt: string) => Promise<string>,
	cwd = createTemporaryProject(),
) {
	const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
	const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
	const prompts: string[] = [];
	const toolCallHandlers: Array<
		(
			event: ToolCallEvent,
			ctx: ExtensionContext,
		) => Promise<ToolCallEventResult | undefined> | ToolCallEventResult | undefined
	> = [];
	const roleSessions: Array<{ role: string; session: AnsteelTeamRoleSession }> = [];
	const roleSessionOptions: CreateAnsteelTeamRoleSessionOptions[] = [];

	const extension = createAnsteelTeamExtension({
		loadConfig: () => config,
		resolveRoleModel: (_ctx, role, config) => ({
			model: config.roles[role].model,
			roleConfig: config.roles[role],
		}),
		createRoleSession: async (options) => {
			const { role } = options;
			roleSessionOptions.push(options);
			const session: AnsteelTeamRoleSession = {
				dispose: vi.fn(),
				prompt: vi.fn(async (prompt: string) => {
					prompts.push(prompt);
					if (rolePrompt) return await rolePrompt(role, prompt);
					if (prompt.startsWith("You are the independent ")) {
						await options.taskOperations.reviewTask("TASK-1", { verdict: "approve" });
					}
					return `## Public Update\n\n${role} completed its investigation.`;
				}),
				abort: vi.fn(),
			};
			roleSessions.push({ role, session });
			return session;
		},
	});

	const api = {
		on: (event: string, handler: unknown) => {
			if (event === "tool_call") {
				toolCallHandlers.push(
					handler as (
						event: ToolCallEvent,
						ctx: ExtensionContext,
					) => Promise<ToolCallEventResult | undefined> | ToolCallEventResult | undefined,
				);
			}
		},
		registerCommand: (
			name: string,
			command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
		) => {
			commands.set(name, command.handler);
		},
		sendMessage,
	} as unknown as ExtensionAPI;
	extension(api);

	const ctx = {
		cwd,
		hasUI: false,
		mode: "tui",
		ui: { notify: vi.fn() },
	} as unknown as ExtensionCommandContext;

	return { commands, ctx, prompts, roleSessionOptions, roleSessions, sendMessage, toolCallHandlers };
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

describe("Ansteel team extension", () => {
	it("blocks role tools from reading coordinator-generated state while preserving project evidence", () => {
		for (const [toolName, args] of [
			["read", { path: ".pi/ansteel-team/team.json" }],
			["ls", { path: ".pi" }],
			["find", { path: "node_modules", pattern: "**/*" }],
			["read", { path: ".git/config" }],
			["bash", { command: "cat .pi/ansteel-team/events.jsonl" }],
		] as const) {
			expect(getAnsteelTeamEvidenceBlockReason("/workspace/project", toolName, args)).toEqual(
				expect.stringContaining("cannot access coordinator state"),
			);
		}
		expect(
			getAnsteelTeamEvidenceBlockReason("/workspace/project", "read", { path: "src/parser.ts" }),
		).toBeUndefined();
		expect(
			getAnsteelTeamEvidenceBlockReason("/workspace/project", "read", { path: ".pi/ansteel.json" }),
		).toBeUndefined();
		expect(
			getAnsteelTeamEvidenceBlockReason("/workspace/project", "bash", { command: "git status --short" }),
		).toBeUndefined();
	});

	it("starts three independent sessions and publishes their public reports", async () => {
		const { commands, ctx, prompts, roleSessionOptions, roleSessions, sendMessage } = setup();
		const command = commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");

		await command("start Review the parser", ctx);

		expect(roleSessions.map((entry) => entry.role)).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
		expect(roleSessionOptions.every((options) => options.taskOperations !== undefined)).toBe(true);
		expect(prompts).toHaveLength(6);
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "ansteel-team-event", display: true }),
			{ triggerTurn: false },
		);
	});

	it("publishes public checkpoints, corrections, timeline entries, and correlated runtime spans", async () => {
		let exercised = false;
		let harness: ReturnType<typeof setup>;
		harness = setup(createConfig(), async (role, prompt) => {
			if (role === "staff-engineer" && prompt.includes("Exercise public collaboration workflow") && !exercised) {
				exercised = true;
				const staff = harness.roleSessionOptions.find((entry) => entry.role === "staff-engineer");
				const qa = harness.roleSessionOptions.find((entry) => entry.role === "qa-engineer");
				if (!staff || !qa) throw new Error("Missing collaboration role operations");
				const first = await staff.taskOperations.publishCheckpoint({
					id: "CP-TOOLS-0001",
					goal: "Validate calculated lease expiry",
					currentUnderstanding: "Inputs are validated but the calculated result is not",
					assumptions: ["Clock and duration are safe integers"],
					evidenceRefs: ["file:src/lease.ts:10"],
					uncertainties: ["The addition can overflow"],
					nextAction: {
						kind: "test",
						target: "test/lease.test.ts",
						expectedResult: "The boundary overflow is reproduced",
					},
					risk: "yellow",
					confidence: "L2",
				});
				const issue = await qa.taskOperations.raiseProcessIssue({
					id: "PI-TOOLS-0001",
					targetCheckpointId: first.id,
					severity: "blocking",
					claim: "Safe operands do not guarantee a safe sum",
					evidenceRefs: ["test:lease-overflow"],
					suggestedCorrection: "Validate the calculated expiry before persistence",
				});
				const replacement = await staff.taskOperations.publishCheckpoint({
					id: "CP-TOOLS-0002",
					goal: first.goal,
					currentUnderstanding: "The calculated expiry must also be a safe integer",
					assumptions: first.assumptions,
					evidenceRefs: ["test:lease-overflow:passed"],
					uncertainties: [],
					nextAction: {
						kind: "edit",
						target: "src/lease.ts",
						expectedResult: "Unsafe expiry is rejected before persistence",
					},
					risk: "yellow",
					confidence: "L1",
					supersedesCheckpointId: first.id,
				});
				await staff.taskOperations.resolveProcessIssue({
					id: "PR-TOOLS-0001",
					issueId: issue.id,
					outcome: "ACCEPTED",
					summary: "Validate the calculated expiry",
					evidenceRefs: ["test:lease-overflow:passed"],
					replacementCheckpointId: replacement.id,
				});
				await qa.taskOperations.reviewProcessResolution(issue.id, {
					verdict: "accept",
					reason: "The replacement checkpoint includes the boundary regression",
				});
			}
			return `${role} completed collaboration.`;
		});
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");

		await command("start Review the parser", harness.ctx);
		await command("ask Exercise public collaboration workflow", harness.ctx);

		const events = listAnsteelTeamEvents(harness.ctx.cwd);
		expect(events.map((event) => event.type)).toEqual(
			expect.arrayContaining([
				"work-checkpoint",
				"process-issue",
				"process-resolution",
				"process-resolution-review",
			]),
		);
		const timeline = harness.sendMessage.mock.calls
			.map(([message]) => ("content" in message ? message.content : ""))
			.join("\n");
		expect(timeline).toContain("CP-TOOLS-0001");
		expect(timeline).toContain("PI-TOOLS-0001");
		expect(timeline).toContain("PR-TOOLS-0001");

		const run = listAnsteelRuntimeRuns(harness.ctx.cwd).at(-1);
		expect(run).toBeDefined();
		const runtimeEvents = readAnsteelRuntimeLogs(harness.ctx.cwd, run!.runId);
		expect(runtimeEvents.map((entry) => entry.eventName)).toEqual(
			expect.arrayContaining(["checkpoint.publish", "process.issue", "process.resolve", "process.review"]),
		);
		expect(
			runtimeEvents.find(
				(entry) =>
					entry.eventName === "process.issue" &&
					entry.outcome === "succeeded" &&
					entry.checkpointId === "CP-TOOLS-0001",
			),
		).toMatchObject({ issueId: "PI-TOOLS-0001", role: "qa-engineer" });
	});

	it("reports scope escalation as requiring a user decision instead of issue-author review", async () => {
		const harness = setup();
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		await command("start Review the parser", harness.ctx);
		const staff = harness.roleSessionOptions.find((entry) => entry.role === "staff-engineer");
		const qa = harness.roleSessionOptions.find((entry) => entry.role === "qa-engineer");
		if (!staff || !qa) throw new Error("Missing collaboration role operations");
		const checkpoint = await staff.taskOperations.publishCheckpoint({
			id: "CP-SCOPE-0001",
			goal: "Clarify an authorization boundary",
			currentUnderstanding: "The requested change may expand user-authorized scope",
			assumptions: [],
			evidenceRefs: ["goal:user-request"],
			uncertainties: ["Whether the user permits external publication"],
			nextAction: {
				kind: "decision",
				target: "user",
				expectedResult: "The authorization boundary is explicit",
			},
			risk: "red",
			confidence: "L3",
		});
		const issue = await qa.taskOperations.raiseProcessIssue({
			id: "PI-SCOPE-0001",
			targetCheckpointId: checkpoint.id,
			severity: "blocking",
			claim: "The external publication scope is not authorized",
			evidenceRefs: ["goal:user-request"],
			suggestedCorrection: "Ask the user before publishing",
		});

		await staff.taskOperations.resolveProcessIssue({
			id: "PR-SCOPE-0001",
			issueId: issue.id,
			outcome: "SCOPE_ESCALATION",
			summary: "Request an explicit user decision",
			evidenceRefs: ["goal:user-request"],
		});

		const timeline = harness.sendMessage.mock.calls
			.map(([message]) => ("content" in message ? message.content : ""))
			.join("\n");
		expect(timeline).toMatch(/PR-SCOPE-0001[\s\S]*Next: user decision required/);
		expect(staff.taskOperations.state.processIssues[0].status).toBe("escalated");
	});

	it("renders a mechanically derived shared board and rejects a damaged public ledger", async () => {
		const harness = setup();
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		await command("start Review the parser", harness.ctx);
		const staff = harness.roleSessionOptions.find((entry) => entry.role === "staff-engineer");
		const qa = harness.roleSessionOptions.find((entry) => entry.role === "qa-engineer");
		if (!staff || !qa) throw new Error("Missing collaboration role operations");
		const checkpoint = await staff.taskOperations.publishCheckpoint({
			id: "CP-BOARD-CMD-0001",
			goal: "Expose the durable collaboration state",
			currentUnderstanding: "The board must be derived from the event ledger",
			assumptions: [],
			evidenceRefs: ["event:public-ledger"],
			uncertainties: ["Whether the ledger was modified"],
			nextAction: {
				kind: "read",
				target: ".pi/ansteel-team/events.jsonl",
				expectedResult: "The event chain verifies",
			},
			risk: "green",
			confidence: "L1",
		});
		await qa.taskOperations.raiseProcessIssue({
			id: "PI-BOARD-CMD-0001",
			targetCheckpointId: checkpoint.id,
			severity: "blocking",
			claim: "The ledger integrity still needs verification",
			evidenceRefs: ["event:public-ledger"],
			suggestedCorrection: "Verify the complete hash chain before rendering",
		});

		await command("board", harness.ctx);

		expect(harness.sendMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({
				content: expect.stringMatching(
					/Goal:[\s\S]*Role status and active checkpoint[\s\S]*Active checkpoints: 1[\s\S]*Open process issues: 1[\s\S]*Blocking process issues: 1/,
				),
			}),
			{ triggerTurn: false },
		);
		const eventPath = join(harness.ctx.cwd, ".pi", "ansteel-team", "events.jsonl");
		const events = readFileSync(eventPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		events[0].content = `${String(events[0].content)} tampered`;
		writeFileSync(eventPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

		await expect(command("board", harness.ctx)).rejects.toThrow();
		expect(harness.sendMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ content: expect.stringContaining("Ansteel team command failed") }),
			{ triggerTurn: false },
		);
	});

	it("rejects a previously healthy doctor run when the persisted public ledger is tampered", async () => {
		const harness = setup();
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		await command("start Review the parser", harness.ctx);

		const staff = harness.roleSessionOptions.find((entry) => entry.role === "staff-engineer");
		const qa = harness.roleSessionOptions.find((entry) => entry.role === "qa-engineer");
		if (!staff || !qa) throw new Error("Missing collaboration role operations");
		const checkpoint = await staff.taskOperations.publishCheckpoint({
			id: "CP-DOCTOR-TAMPER-0001",
			goal: "Keep doctor bound to the persisted collaboration ledger",
			currentUnderstanding: "A runtime diagnosis alone cannot prove public state integrity",
			assumptions: [],
			evidenceRefs: ["event:public-ledger"],
			uncertainties: [],
			nextAction: {
				kind: "read",
				target: ".pi/ansteel-team/events.jsonl",
				expectedResult: "The complete event chain verifies before diagnosis",
			},
			risk: "green",
			confidence: "L1",
		});
		await qa.taskOperations.raiseProcessIssue({
			id: "PI-DOCTOR-TAMPER-0001",
			targetCheckpointId: checkpoint.id,
			severity: "blocking",
			claim: "Doctor can otherwise trust a healthy runtime after public history changes",
			evidenceRefs: ["event:public-ledger"],
			suggestedCorrection: "Replay persisted collaboration state before runtime diagnosis",
		});

		// Establish a healthy observed command after the public state exists, then preserve its exact run ID.
		await command("board", harness.ctx);
		const healthyRun = listAnsteelRuntimeRuns(harness.ctx.cwd).at(-1);
		expect(healthyRun).toBeDefined();
		expect(diagnoseAnsteelTeamRun(harness.ctx.cwd, healthyRun!.runId).healthy).toBe(true);

		const eventPath = join(harness.ctx.cwd, ".pi", "ansteel-team", "events.jsonl");
		const events = readFileSync(eventPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		// Change durable public content without recalculating the event hash so the persisted chain is invalid.
		events[0].content = `${String(events[0].content)} tampered`;
		writeFileSync(eventPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
		harness.sendMessage.mockClear();

		await expect(command(`doctor ${healthyRun!.runId}`, harness.ctx)).rejects.toThrow();
		const doctorRun = listAnsteelRuntimeRuns(harness.ctx.cwd).at(-1);
		expect(doctorRun).toBeDefined();
		expect(diagnoseAnsteelTeamRun(harness.ctx.cwd, doctorRun!.runId).rootCause).toMatchObject({
			reasonCode: "event-chain-invalid",
		});

		await expect(command("board", harness.ctx)).rejects.toThrow();
		const postTamperMessages = harness.sendMessage.mock.calls
			.map(([message]) => ("content" in message ? message.content : ""))
			.join("\n");
		expect(postTamperMessages).toContain("Ansteel team command failed");
		expect(postTamperMessages).not.toContain("Active checkpoints:");
		expect(postTamperMessages).not.toContain("Health: healthy");
	});

	it("rejects doctor with a projection mismatch when persisted state diverges from the valid ledger", async () => {
		const harness = setup();
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		await command("start Review the parser", harness.ctx);

		const staff = harness.roleSessionOptions.find((entry) => entry.role === "staff-engineer");
		if (!staff) throw new Error("Missing staff collaboration operations");
		await staff.taskOperations.publishCheckpoint({
			id: "CP-DOCTOR-PROJECTION-0001",
			goal: "Keep doctor bound to replayed collaboration state",
			currentUnderstanding: "The persisted state currently matches the public event ledger",
			assumptions: [],
			evidenceRefs: ["event:public-ledger"],
			uncertainties: [],
			nextAction: {
				kind: "read",
				target: ".pi/ansteel-team/team.json",
				expectedResult: "Replayed public state matches the persisted projection",
			},
			risk: "green",
			confidence: "L1",
		});

		await command("board", harness.ctx);
		const healthyRun = listAnsteelRuntimeRuns(harness.ctx.cwd).at(-1);
		expect(healthyRun).toBeDefined();
		expect(diagnoseAnsteelTeamRun(harness.ctx.cwd, healthyRun!.runId).healthy).toBe(true);

		const statePath = join(harness.ctx.cwd, ".pi", "ansteel-team", "team.json");
		const state = JSON.parse(readFileSync(statePath, "utf8")) as {
			workCheckpoints: Array<{ currentUnderstanding: string }>;
		};
		state.workCheckpoints[0].currentUnderstanding = "Persisted state was changed without a public event";
		writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
		harness.sendMessage.mockClear();

		await expect(command(`doctor ${healthyRun!.runId}`, harness.ctx)).rejects.toThrow();
		const doctorRun = listAnsteelRuntimeRuns(harness.ctx.cwd).at(-1);
		expect(doctorRun).toBeDefined();
		expect(diagnoseAnsteelTeamRun(harness.ctx.cwd, doctorRun!.runId).rootCause).toMatchObject({
			reasonCode: "state-projection-mismatch",
		});
		const postMismatchMessages = harness.sendMessage.mock.calls
			.map(([message]) => ("content" in message ? message.content : ""))
			.join("\n");
		expect(postMismatchMessages).toContain("Ansteel team command failed");
		expect(postMismatchMessages).not.toContain("Health: healthy");
	});

	it.each([
		["ledger head", (state: Record<string, unknown>) => Object.assign(state, { ledgerHeadHash: "0".repeat(64) })],
		[
			"next event sequence",
			(state: Record<string, unknown>) =>
				Object.assign(state, { nextEventSequence: Number(state.nextEventSequence) + 1 }),
		],
	])("classifies a valid ledger with a damaged %s cursor as a projection mismatch", async (_name, mutateState) => {
		const harness = setup();
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		await command("start Review the parser", harness.ctx);
		await command("board", harness.ctx);
		const healthyRun = listAnsteelRuntimeRuns(harness.ctx.cwd).at(-1);
		expect(healthyRun).toBeDefined();

		const statePath = join(harness.ctx.cwd, ".pi", "ansteel-team", "team.json");
		const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
		mutateState(state);
		writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

		await expect(command(`doctor ${healthyRun!.runId}`, harness.ctx)).rejects.toThrow();
		const doctorRun = listAnsteelRuntimeRuns(harness.ctx.cwd).at(-1);
		expect(doctorRun).toBeDefined();
		expect(diagnoseAnsteelTeamRun(harness.ctx.cwd, doctorRun!.runId).rootCause).toMatchObject({
			reasonCode: "state-projection-mismatch",
		});
	});

	it("rejects an active-team board when the persisted team state is damaged", async () => {
		const harness = setup();
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		await command("start Review the parser", harness.ctx);
		writeFileSync(join(harness.ctx.cwd, ".pi", "ansteel-team", "team.json"), "{", "utf8");

		await expect(command("board", harness.ctx)).rejects.toThrow();

		expect(harness.sendMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ content: expect.stringContaining("Ansteel team command failed") }),
			{ triggerTurn: false },
		);
	});

	it("rejects an active-team board when the persisted event ledger is missing", async () => {
		const harness = setup();
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		await command("start Review the parser", harness.ctx);
		rmSync(join(harness.ctx.cwd, ".pi", "ansteel-team", "events.jsonl"));

		await expect(command("board", harness.ctx)).rejects.toThrow("ledger head hash");

		expect(harness.sendMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ content: expect.stringContaining("Ansteel team command failed") }),
			{ triggerTurn: false },
		);
	});

	it("fails closed instead of rendering a board when every historical runtime log is missing", async () => {
		const harness = setup();
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		await command("start Review the parser", harness.ctx);

		// The current board command must not treat an empty runtime projection as verified history.
		rmSync(join(harness.ctx.cwd, ".pi", "ansteel-team", "logs"), { force: true, recursive: true });

		await expect(command("board", harness.ctx)).rejects.toThrow("verifiable historical runtime run");
		expect(harness.sendMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ content: expect.stringContaining("Ansteel team command failed") }),
			{ triggerTurn: false },
		);
	});

	it("reports persistent status and disposes live sessions without deleting the team", async () => {
		const { commands, ctx, roleSessions, sendMessage } = setup();
		const command = commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");

		await command("start Review the parser", ctx);
		await command("status", ctx);
		await command("stop", ctx);

		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining("Ansteel team: active") }),
			{ triggerTurn: false },
		);
		for (const { session } of roleSessions) {
			expect(session.dispose).toHaveBeenCalledTimes(1);
		}
	});

	it("records and aborts a role stage that exceeds the configured interactive timeout", async () => {
		const config = createConfig();
		config.stageTimeoutMs = 1;
		const { commands, ctx, roleSessions, sendMessage } = setup(config, async (role) => {
			if (role === "staff-engineer") return await new Promise<string>(() => {});
			return `## Public Update\n\n${role} completed its investigation.`;
		});
		const command = commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");

		await expect(command("start Review the parser", ctx)).rejects.toThrow("exceeded configured timeout of 1ms");

		const staff = roleSessions.find((entry) => entry.role === "staff-engineer");
		if (!staff) throw new Error("Missing Staff Engineer session");
		expect(staff.session.abort).toHaveBeenCalled();
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining("exceeded configured timeout of 1ms") }),
			{ triggerTurn: false },
		);
	});

	it("explains a failed role run from persisted trace evidence", async () => {
		const harness = setup(createConfig(), async (role) => {
			if (role === "staff-engineer") throw new Error("provider request timeout");
			return `## Public Update\n\n${role} completed its investigation.`;
		});
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");

		await expect(command("start Review the parser", harness.ctx)).rejects.toThrow("provider request timeout");
		const capturedRun = listAnsteelRuntimeRuns(harness.ctx.cwd).at(-1);
		expect(capturedRun).toBeDefined();
		expect(diagnoseAnsteelTeamRun(harness.ctx.cwd, capturedRun!.runId).rootCause).toMatchObject({
			reasonCode: "provider-timeout",
		});

		await command("status --explain", harness.ctx);
		expect(harness.sendMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({
				content: expect.stringMatching(new RegExp(`${capturedRun!.runId}.*provider-timeout`, "s")),
			}),
			{ triggerTurn: false },
		);

		await command(`trace ${capturedRun!.runId}`, harness.ctx);
		expect(harness.sendMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ content: expect.stringContaining("provider.request") }),
			{ triggerTurn: false },
		);
	});

	it("correlates role reports and durable state updates in the command trace", async () => {
		const harness = setup();
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		await command("start Review the parser", harness.ctx);

		await command("ask Inspect the parser state", harness.ctx);

		const run = listAnsteelRuntimeRuns(harness.ctx.cwd).at(-1);
		expect(run).toBeDefined();
		const entries = readAnsteelRuntimeLogs(harness.ctx.cwd, run!.runId);
		expect(entries.map((entry) => entry.eventName)).toEqual(
			expect.arrayContaining(["role.session", "provider.request", "state.persisted", "event.appended"]),
		);
		expect(entries.every((entry) => entry.traceId === run!.traceId)).toBe(true);
	});

	it("diagnoses an unhealthy run and creates a content-addressed incident bundle", async () => {
		const harness = setup(createConfig(), async (role) => {
			if (role === "qa-engineer") throw new Error("provider request timeout");
			return `## Public Update\n\n${role} completed its investigation.`;
		});
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		await expect(command("start Review the parser", harness.ctx)).rejects.toThrow("provider request timeout");
		const failedRun = listAnsteelRuntimeRuns(harness.ctx.cwd).at(-1);
		expect(failedRun).toBeDefined();

		await expect(command(`doctor ${failedRun!.runId}`, harness.ctx)).rejects.toThrow("is unhealthy");
		expect(harness.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.stringMatching(new RegExp(`${failedRun!.runId}.*provider-timeout`, "s")),
			}),
			{ triggerTurn: false },
		);

		await command(`incident ${failedRun!.runId}`, harness.ctx);
		const incidentDirectory = join(harness.ctx.cwd, ".pi", "ansteel-team", "incidents");
		expect(existsSync(incidentDirectory)).toBe(true);
		expect(readdirSync(incidentDirectory)).toEqual([
			expect.stringMatching(new RegExp(`^incident-${failedRun!.runId}-[0-9a-f]{64}\\.json$`)),
		]);
	});

	it("finalizes and blocks an orphaned run before recovering an interrupted persisted team", async () => {
		const firstHost = setup();
		const firstCommand = firstHost.commands.get("ansteel-team");
		if (!firstCommand) throw new Error("Missing first-host ansteel-team command");

		await firstCommand("start Review the parser", firstHost.ctx);
		const persistedBeforeRecovery = loadAnsteelTeamState(firstHost.ctx.cwd);
		expect(persistedBeforeRecovery).toBeDefined();
		const orphanContext = createAnsteelRunContext({
			teamId: persistedBeforeRecovery!.id,
			command: "ask interrupted work",
		});
		const orphanLogger = createAnsteelRuntimeLogger(firstHost.ctx.cwd, orphanContext);
		const completedRoot = orphanLogger.startSpan("run.started", {
			role: "coordinator",
			message: "interrupted command started",
			data: { command: "ask interrupted work" },
		});
		orphanLogger.startSpan("provider.request", {
			parent: completedRoot,
			role: "staff-engineer",
			providerRequestId: "PROVIDER-RECOVERY-ORPHAN-1",
			message: "provider request interrupted",
		});
		completedRoot.end({ outcome: "succeeded", message: "root command returned before child cleanup" });
		await orphanLogger.forceFlush();
		orphanLogger.close();
		const statePath = join(firstHost.ctx.cwd, ".pi", "ansteel-team", "team.json");
		const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, any>;
		state.status = "active";
		state.roles["staff-engineer"].status = "working";
		writeFileSync(statePath, `${JSON.stringify(state)}\n`, "utf8");

		const restartedHost = setup(createConfig(), undefined, firstHost.ctx.cwd);
		const restartedCommand = restartedHost.commands.get("ansteel-team");
		if (!restartedCommand) throw new Error("Missing restarted-host ansteel-team command");
		await expect(restartedCommand("start Review the parser", restartedHost.ctx)).rejects.toThrow("orphaned runtime");
		expect(diagnoseAnsteelTeamRun(restartedHost.ctx.cwd, orphanContext.runId)).toMatchObject({
			healthy: false,
			rootCause: {
				eventName: "provider.request",
				outcome: "abandoned",
				reasonCode: "process-orphaned",
				providerRequestId: "PROVIDER-RECOVERY-ORPHAN-1",
			},
		});

		await restartedCommand("start Review the parser", restartedHost.ctx);

		expect(restartedHost.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining("recovered from an interrupted host") }),
			{ triggerTurn: false },
		);
	});

	it("does not recover a runtime run while its original host still owns the logger", async () => {
		const firstHost = setup();
		const firstCommand = firstHost.commands.get("ansteel-team");
		if (!firstCommand) throw new Error("Missing first-host ansteel-team command");
		await firstCommand("start Review the parser", firstHost.ctx);
		const persisted = loadAnsteelTeamState(firstHost.ctx.cwd);
		expect(persisted).toBeDefined();

		const activeContext = createAnsteelRunContext({
			teamId: persisted!.id,
			command: "ask active work",
		});
		const activeLogger = createAnsteelRuntimeLogger(firstHost.ctx.cwd, activeContext);
		activeLogger.startSpan("run.started", {
			role: "coordinator",
			message: "active command started",
			data: { command: "ask active work" },
		});
		await activeLogger.forceFlush();

		const restartedHost = setup(createConfig(), undefined, firstHost.ctx.cwd);
		const restartedCommand = restartedHost.commands.get("ansteel-team");
		if (!restartedCommand) throw new Error("Missing restarted-host ansteel-team command");
		await expect(restartedCommand("start Review the parser", restartedHost.ctx)).rejects.toThrow();
		expect(readAnsteelRuntimeLogs(firstHost.ctx.cwd, activeContext.runId).map((entry) => entry.outcome)).toEqual([
			"started",
		]);

		activeLogger.close();
	});

	it("resumes a stopped team when its persisted task-owner policy still matches configuration", async () => {
		const { commands, ctx, roleSessionOptions, roleSessions } = setup();
		const command = commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");

		await command("start Review the parser", ctx);
		await command("stop", ctx);
		await command("start Review the parser", ctx);

		expect(roleSessions).toHaveLength(6);
		expect(roleSessionOptions.slice(3).map((options) => options.role)).toEqual([
			"tech-lead",
			"staff-engineer",
			"qa-engineer",
		]);
		expect(roleSessionOptions.slice(3).every((options) => options.allowedTaskOwners.includes("staff-engineer"))).toBe(
			true,
		);
	});

	it("rejects a resume when the configured task-owner policy differs from the persisted team policy", async () => {
		const config = createConfig();
		const { commands, ctx, sendMessage } = setup(config);
		const command = commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");

		await command("start Review the parser", ctx);
		await command("stop", ctx);
		config.teamTaskOwners = ["staff-engineer", "tech-lead"];
		await expect(command("start Review the parser", ctx)).rejects.toThrow("task-owner policy differs");

		expect(sendMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ content: expect.stringContaining("task-owner policy differs") }),
			{ triggerTurn: false },
		);
	});

	it("submits one immutable evidence package to both non-owner reviewers", async () => {
		const { commands, ctx, prompts, roleSessionOptions } = setup();
		initializeGitProject(ctx.cwd);
		const command = commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");

		await command("start Review the parser", ctx);
		const staff = roleSessionOptions.find((options) => options.role === "staff-engineer");
		if (!staff) throw new Error("Missing Staff Engineer session");
		await staff.taskOperations.claimTask({
			id: "TASK-1",
			files: ["src/parser.ts"],
			description: "Handle empty parser input.",
			acceptanceCriteria: "The targeted parser test passes.",
		});
		writeFileSync(join(ctx.cwd, "src", "parser.ts"), "export const parser = 'after';\n", "utf8");

		await staff.taskOperations.submitTask("TASK-1", "node --test test/parser.test.mjs");

		expect(prompts).toHaveLength(8);
		expect(prompts.filter((prompt) => prompt.startsWith("You are the independent "))).toHaveLength(2);
		expect(staff.taskOperations.state.tasks[0]).toMatchObject({ status: "approved", revision: 1 });
	});

	it("allows Tech Lead task claims only when the project configuration explicitly authorizes it", async () => {
		const config = createConfig();
		config.teamTaskOwners = ["staff-engineer", "tech-lead"];
		const { commands, ctx, roleSessionOptions } = setup(config);
		const command = commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");

		await command("start Review the parser", ctx);
		const techLead = roleSessionOptions.find((options) => options.role === "tech-lead");
		if (!techLead) throw new Error("Missing Tech Lead session");

		await expect(
			techLead.taskOperations.claimTask({
				id: "TASK-TL",
				files: ["src/lead.ts"],
				description: "Implement an explicitly authorized change.",
				acceptanceCriteria: "The targeted test passes.",
			}),
		).resolves.toMatchObject({ owner: "tech-lead", status: "claimed" });
	});

	it("blocks the host session from bypassing an active team's task and ledger gates", async () => {
		const { commands, ctx, toolCallHandlers } = setup();
		const command = commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");

		await command("start Review the parser", ctx);
		const handler = toolCallHandlers[0];
		if (!handler) throw new Error("Missing Ansteel host tool gate");

		const writeResult = await handler(
			{
				type: "tool_call",
				toolCallId: "host-write",
				toolName: "write",
				input: { path: "src/parser.ts", content: "export const parser = 'bypass';\n" },
			},
			ctx as unknown as ExtensionContext,
		);
		expect(writeResult).toMatchObject({ block: true, reason: expect.stringContaining("Ansteel team is active") });

		const ledgerWriteResult = await handler(
			{
				type: "tool_call",
				toolCallId: "host-ledger-write",
				toolName: "edit",
				input: { path: ".pi/ansteel-team/events.jsonl", edits: [] },
			},
			ctx as unknown as ExtensionContext,
		);
		expect(ledgerWriteResult).toMatchObject({ block: true, reason: expect.stringContaining("team ledger") });

		const bashResult = await handler(
			{
				type: "tool_call",
				toolCallId: "host-bash",
				toolName: "bash",
				input: { command: "printf bypass > src/parser.ts" },
			},
			ctx as unknown as ExtensionContext,
		);
		expect(bashResult).toMatchObject({ block: true, reason: expect.stringContaining("host session") });

		const bypassBashResult = await handler(
			{
				type: "tool_call",
				toolCallId: "host-bash-output-bypass",
				toolName: "bash",
				input: { command: "git diff --output=src/parser.ts" },
			},
			ctx as unknown as ExtensionContext,
		);
		expect(bypassBashResult).toMatchObject({
			block: true,
			reason: expect.stringContaining("host session"),
		});

		const readResult = await handler(
			{
				type: "tool_call",
				toolCallId: "host-read",
				toolName: "read",
				input: { path: "src/parser.ts" },
			},
			ctx as unknown as ExtensionContext,
		);
		expect(readResult).toBeUndefined();

		await command("stop", ctx);
		const afterStopResult = await handler(
			{
				type: "tool_call",
				toolCallId: "host-write-after-stop",
				toolName: "write",
				input: { path: "src/parser.ts", content: "export const parser = 'allowed';\n" },
			},
			ctx as unknown as ExtensionContext,
		);
		expect(afterStopResult).toBeUndefined();
	});

	it("runs a coordinator task through a truncated progress epoch and immutable peer approval", async () => {
		const config = createConfig();
		config.teamTaskMaxEpochs = 4;
		config.teamTaskMaxNoProgressEpochs = 2;
		let taskEpochs = 0;
		let harness: ReturnType<typeof setup>;
		harness = setup(config, async (role, prompt) => {
			const roleOptions = harness.roleSessionOptions.find((entry) => entry.role === role);
			if (!roleOptions) throw new Error(`Missing ${role} options`);
			if (prompt.startsWith("You are the independent ")) {
				await roleOptions.taskOperations.reviewTask("TASK-1", { verdict: "approve" });
				return `${role} approved TASK-1.`;
			}
			if (role === "staff-engineer" && prompt.includes("Execute governed task TASK-1")) {
				taskEpochs++;
				if (taskEpochs === 1) {
					writeFileSync(join(harness.ctx.cwd, "src", "parser.ts"), "export const parser = 'after';\n", "utf8");
					throw new Error("Ansteel role stage failed: output-truncated");
				}
				await roleOptions.taskOperations.submitTask("TASK-1", "node --test test/parser.test.mjs");
				return "Staff submitted TASK-1.";
			}
			return `${role} completed discussion.`;
		});
		initializeGitProject(harness.ctx.cwd);
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		await command("start Review the parser", harness.ctx);

		await command(
			'task {"id":"TASK-1","owner":"staff-engineer","files":["src/parser.ts"],"description":"Change parser","acceptanceCriteria":"The parser test passes","dependsOn":[]}',
			harness.ctx,
		);

		expect(taskEpochs).toBe(2);
		expect(loadAnsteelTeamState(harness.ctx.cwd)?.tasks).toEqual([
			expect.objectContaining({ id: "TASK-1", owner: "staff-engineer", status: "approved", revision: 1 }),
		]);
		const events = listAnsteelTeamEvents(harness.ctx.cwd);
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "task-assigned",
					role: "coordinator",
					targetRole: "staff-engineer",
				}),
				expect.objectContaining({
					type: "role-failure",
					role: "staff-engineer",
					content: expect.stringContaining("output-truncated"),
				}),
				expect.objectContaining({ type: "task-submitted", role: "staff-engineer" }),
				expect.objectContaining({ type: "task-review", role: "tech-lead" }),
				expect.objectContaining({ type: "task-review", role: "qa-engineer" }),
			]),
		);
		const taskRun = listAnsteelRuntimeRuns(harness.ctx.cwd).at(-1);
		expect(taskRun).toBeDefined();
		const operationEntries = readAnsteelRuntimeLogs(harness.ctx.cwd, taskRun!.runId);
		expect(operationEntries.map((entry) => entry.eventName)).toEqual(
			expect.arrayContaining(["task.claim", "tool.call", "task.submit", "task.review"]),
		);
		expect(
			operationEntries.find((entry) => entry.eventName === "tool.call" && entry.outcome === "succeeded"),
		).toMatchObject({ taskId: "TASK-1", outcome: "succeeded" });
	});

	it("fails a task command with the audited collaboration tool when the owner provider also errors", async () => {
		const config = createConfig();
		config.teamTaskMaxEpochs = 1;
		config.teamTaskMaxNoProgressEpochs = 1;
		const harness = setup(config, async (role, prompt) => {
			if (role === "staff-engineer" && prompt.includes("Execute governed task TASK-AUDIT-FAIL")) {
				throw new Error("provider failed after the collaboration tool error");
			}
			return `${role} completed its stage.`;
		});
		initializeGitProject(harness.ctx.cwd);
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		await command("start Review the parser", harness.ctx);
		const staff = harness.roleSessions.find((entry) => entry.role === "staff-engineer");
		if (!staff) throw new Error("Missing Staff Engineer session");

		// This audit represents a rejected public collaboration mutation before the provider failure.
		staff.session.getLastStageAudit = () => ({
			events: [{ type: "tool-execution-end", toolName: "ansteel_publish_checkpoint", isError: true }],
		});

		await expect(
			command(
				'task {"id":"TASK-AUDIT-FAIL","owner":"staff-engineer","files":["src/parser.ts"],"description":"Exercise owner error handling","acceptanceCriteria":"The command fails closed","dependsOn":[]}',
				harness.ctx,
			),
		).rejects.toThrow("ansteel_publish_checkpoint returned an error");
	});

	it("stops a coordinator task after the configured consecutive no-progress epochs", async () => {
		const config = createConfig();
		config.teamTaskMaxEpochs = 4;
		config.teamTaskMaxNoProgressEpochs = 2;
		let taskEpochs = 0;
		const harness = setup(config, async (role, prompt) => {
			if (role === "staff-engineer" && prompt.includes("Execute governed task TASK-1")) taskEpochs++;
			return `${role} produced prose without task progress.`;
		});
		initializeGitProject(harness.ctx.cwd);
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		await command("start Review the parser", harness.ctx);

		await command(
			'task {"id":"TASK-1","owner":"staff-engineer","files":["src/parser.ts"],"description":"Change parser","acceptanceCriteria":"The parser test passes","dependsOn":[]}',
			harness.ctx,
		);

		expect(taskEpochs).toBe(2);
		expect(harness.prompts.find((prompt) => prompt.includes("Execute governed task TASK-1"))).toContain(
			"Read-only tool budget: 4 calls",
		);
		expect(loadAnsteelTeamState(harness.ctx.cwd)?.tasks[0]).toMatchObject({ id: "TASK-1", status: "claimed" });
		expect(listAnsteelTeamEvents(harness.ctx.cwd).at(-1)).toMatchObject({
			type: "role-failure",
			role: "staff-engineer",
			content: expect.stringContaining("owner-no-progress"),
		});
	});

	it("stops a progressing coordinator task at the configured epoch ceiling", async () => {
		const config = createConfig();
		config.teamTaskMaxEpochs = 1;
		config.teamTaskMaxNoProgressEpochs = 1;
		const harness = setup(config, async (role, prompt) => {
			if (role === "staff-engineer" && prompt.includes("Execute governed task TASK-1")) {
				writeFileSync(join(harness.ctx.cwd, "src", "parser.ts"), "export const parser = 'after';\n", "utf8");
			}
			return `${role} completed one epoch.`;
		});
		initializeGitProject(harness.ctx.cwd);
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		await command("start Review the parser", harness.ctx);

		await command(
			'task {"id":"TASK-1","owner":"staff-engineer","files":["src/parser.ts"],"description":"Change parser","acceptanceCriteria":"The parser test passes","dependsOn":[]}',
			harness.ctx,
		);

		expect(listAnsteelTeamEvents(harness.ctx.cwd).at(-1)).toMatchObject({
			type: "role-failure",
			role: "staff-engineer",
			content: expect.stringContaining("task-epoch-limit"),
		});
	});

	it("resumes one existing unfinished coordinator task without creating a duplicate", async () => {
		const config = createConfig();
		config.teamTaskMaxEpochs = 2;
		config.teamTaskMaxNoProgressEpochs = 1;
		let ownerEpochs = 0;
		const harness = setup(config, async (role, prompt) => {
			if (role === "staff-engineer" && prompt.includes("Execute governed task TASK-1")) ownerEpochs++;
			return `${role} produced no governed task progress.`;
		});
		initializeGitProject(harness.ctx.cwd);
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		await command("start Review the parser", harness.ctx);
		const staff = harness.roleSessionOptions.find((options) => options.role === "staff-engineer");
		if (!staff) throw new Error("Missing Staff Engineer session");
		await staff.taskOperations.claimTask({
			id: "TASK-1",
			files: ["src/parser.ts"],
			description: "Change parser",
			acceptanceCriteria: "The parser test passes",
			dependsOn: [],
		});

		await command("task TASK-1", harness.ctx);

		expect(ownerEpochs).toBe(1);
		expect(loadAnsteelTeamState(harness.ctx.cwd)?.tasks).toHaveLength(1);
		expect(loadAnsteelTeamState(harness.ctx.cwd)?.tasks[0]).toMatchObject({
			id: "TASK-1",
			status: "claimed",
		});
	});

	it("rejects malformed, unauthorized, unknown, and approved coordinator tasks before prompting an owner", async () => {
		const config = createConfig();
		let ownerEpochs = 0;
		let harness: ReturnType<typeof setup>;
		harness = setup(config, async (role, prompt) => {
			const roleOptions = harness.roleSessionOptions.find((entry) => entry.role === role);
			if (!roleOptions) throw new Error(`Missing ${role} options`);
			if (prompt.startsWith("You are the independent ")) {
				await roleOptions.taskOperations.reviewTask("TASK-OK", { verdict: "approve" });
				return `${role} approved TASK-OK.`;
			}
			if (role === "staff-engineer" && prompt.includes("Execute governed task")) {
				ownerEpochs++;
				writeFileSync(join(harness.ctx.cwd, "src", "parser.ts"), "export const parser = 'after';\n", "utf8");
				await roleOptions.taskOperations.submitTask("TASK-OK", "node --test test/parser.test.mjs");
			}
			return `${role} completed its stage.`;
		});
		initializeGitProject(harness.ctx.cwd);
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		await command("start Review the parser", harness.ctx);

		await expect(command("task {bad-json", harness.ctx)).rejects.toThrow("Usage:");
		await expect(
			command(
				'task {"id":"TASK-TL","owner":"tech-lead","files":["src/parser.ts"],"description":"Change parser","acceptanceCriteria":"Pass","dependsOn":[]}',
				harness.ctx,
			),
		).rejects.toThrow("not authorized");
		await expect(command("task TASK-UNKNOWN", harness.ctx)).rejects.toThrow("does not exist");
		expect(ownerEpochs).toBe(0);
		expect(loadAnsteelTeamState(harness.ctx.cwd)?.tasks).toHaveLength(0);

		await command(
			'task {"id":"TASK-OK","owner":"staff-engineer","files":["src/parser.ts"],"description":"Change parser","acceptanceCriteria":"Pass","dependsOn":[]}',
			harness.ctx,
		);
		expect(loadAnsteelTeamState(harness.ctx.cwd)?.tasks[0]).toMatchObject({ status: "approved" });
		await expect(command("task TASK-OK", harness.ctx)).rejects.toThrow("already approved");

		expect(ownerEpochs).toBe(1);
		expect(harness.sendMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ content: expect.stringContaining("already approved") }),
			{ triggerTurn: false },
		);
	});

	it("resumes only the missing peer review for a submitted coordinator task", async () => {
		const config = createConfig();
		config.teamTaskMaxEpochs = 3;
		const reviewPrompts = new Map<string, number>();
		let harness: ReturnType<typeof setup>;
		harness = setup(config, async (role, prompt) => {
			const roleOptions = harness.roleSessionOptions.find((entry) => entry.role === role);
			if (!roleOptions) throw new Error(`Missing ${role} options`);
			if (prompt.startsWith("You are the independent ")) {
				reviewPrompts.set(role, (reviewPrompts.get(role) ?? 0) + 1);
				if (role === "qa-engineer" && reviewPrompts.get(role) === 1) {
					throw new Error("temporary QA provider failure");
				}
				await roleOptions.taskOperations.reviewTask("TASK-1", { verdict: "approve" });
				return `${role} approved TASK-1.`;
			}
			if (role === "staff-engineer" && prompt.includes("Execute governed task TASK-1")) {
				writeFileSync(join(harness.ctx.cwd, "src", "parser.ts"), "export const parser = 'after';\n", "utf8");
				await roleOptions.taskOperations.submitTask("TASK-1", "node --test test/parser.test.mjs");
				return "Staff submitted TASK-1.";
			}
			return `${role} completed its stage.`;
		});
		initializeGitProject(harness.ctx.cwd);
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		await command("start Review the parser", harness.ctx);

		await command(
			'task {"id":"TASK-1","owner":"staff-engineer","files":["src/parser.ts"],"description":"Change parser","acceptanceCriteria":"The parser test passes","dependsOn":[]}',
			harness.ctx,
		);

		expect(loadAnsteelTeamState(harness.ctx.cwd)?.tasks[0]).toMatchObject({ status: "approved" });
		expect(reviewPrompts.get("tech-lead")).toBe(1);
		expect(reviewPrompts.get("qa-engineer")).toBe(2);
		expect(
			listAnsteelTeamEvents(harness.ctx.cwd).filter(
				(event) =>
					event.type === "role-failure" &&
					event.role === "tech-lead" &&
					event.content.includes("already has a tech-lead review"),
			),
		).toHaveLength(0);
	});
});
