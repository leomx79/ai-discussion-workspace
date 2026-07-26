import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnsteelConfig } from "../src/core/ansteel-discussion.ts";
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
					if (rolePrompt) return await rolePrompt(role, prompt);
					prompts.push(prompt);
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
		cwd: createTemporaryProject(),
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
		const { commands, ctx, roleSessions, sendMessage } = setup(
			config,
			async (role) => {
				if (role === "staff-engineer") return await new Promise<string>(() => {});
				return `## Public Update\n\n${role} completed its investigation.`;
			},
		);
		const command = commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");

		await command("start Review the parser", ctx);

		const staff = roleSessions.find((entry) => entry.role === "staff-engineer");
		if (!staff) throw new Error("Missing Staff Engineer session");
		expect(staff.session.abort).toHaveBeenCalled();
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining("exceeded configured timeout of 1ms") }),
			{ triggerTurn: false },
		);
	});

	it("records a stale working role before recovering an interrupted persisted team", async () => {
		const { commands, ctx, sendMessage } = setup();
		const command = commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");

		await command("start Review the parser", ctx);
		await command("stop", ctx);
		const statePath = join(ctx.cwd, ".pi", "ansteel-team", "team.json");
		const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, any>;
		state.status = "active";
		state.roles["staff-engineer"].status = "working";
		writeFileSync(statePath, `${JSON.stringify(state)}\n`, "utf8");

		await command("start Review the parser", ctx);

		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining("recovered from an interrupted host") }),
			{ triggerTurn: false },
		);
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
		await command("start Review the parser", ctx);

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
});
