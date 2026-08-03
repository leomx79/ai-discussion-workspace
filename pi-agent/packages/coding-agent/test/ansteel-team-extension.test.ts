import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnsteelConfig } from "../src/core/ansteel-discussion.ts";
import {
	listAnsteelTeamEvents,
	loadAnsteelTeamState,
	resolveAnsteelTeamWritePath,
	saveAnsteelTeamState,
	transitionAnsteelTeamRoleStatus,
	transitionAnsteelTeamStatus,
} from "../src/core/ansteel-team.ts";
import {
	createAnsteelRunContext,
	createAnsteelRuntimeLogger,
	diagnoseAnsteelTeamRun,
	getAnsteelRuntimeIndexPath,
	getAnsteelRuntimeLogDirectory,
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
	type AnsteelTeamTaskOperations,
	type AnsteelTeamRoleSession,
	type CreateAnsteelTeamRoleSessionOptions,
	createAnsteelTeamExtension,
	createAnsteelTeamMutationToolController,
	getAnsteelTeamEvidenceBlockReason,
} from "../src/extensions/ansteel-team/index.ts";

const temporaryDirectories: string[] = [];

function createTemporaryProject(): string {
	const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-team-extension-"));
	temporaryDirectories.push(cwd);
	return cwd;
}

function createDeliveryManifest(taskId: string, revision: number, script = "process.exit(0)"): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-ansteel-team-extension-delivery-"));
	temporaryDirectories.push(directory);
	const path = join(directory, "delivery.json");
	writeFileSync(
		path,
		JSON.stringify({
			version: 1,
			taskId,
			revision,
			checks: [{ id: "acceptance", executable: process.execPath, args: ["-e", script], timeoutMs: 10_000 }],
		}),
		"utf8",
	);
	return path;
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
	roleStageAudit?: (
		role: string,
		promptCount?: number,
	) => Array<{ type: string; toolName?: string; isError?: boolean }>,
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
			let promptCount = 0;
			const session: AnsteelTeamRoleSession = {
				dispose: vi.fn(),
				prompt: vi.fn(async (prompt: string) => {
					promptCount += 1;
					prompts.push(prompt);
					let response = `## Public Update\n\n${role} completed its investigation.`;
					if (rolePrompt) {
						response = await rolePrompt(role, prompt);
					} else if (prompt.startsWith("You are the independent ")) {
						await options.taskOperations.reviewTask("TASK-1", { verdict: "approve" });
					}
					if (prompt.includes("continuous collaborator for")) {
						const taskMatch = /^You are the .* continuous collaborator for (TASK-[A-Z0-9-]+) revision/.exec(
							prompt,
						);
						const milestoneMatch =
							/^You are the .* continuous collaborator for (MILESTONE-[A-Z0-9-]+) integration revision/.exec(
								prompt,
							);
						if (taskMatch) {
							const task = options.taskOperations.state.tasks.find((item) => item.id === taskMatch[1]);
							if (
								task?.status === "submitted" &&
								!task.collaborationUpdates.some(
									(update) => update.revision === task.revision && update.collaborator === role,
								)
							) {
								await options.taskOperations.publishTaskCollaboration(task.id, {
									summary: `${role} recorded the default continuous collaboration update.`,
									evidenceRefs: [`test:${task.id}:${role}:continuous-collaboration`],
									uncertainties: [],
								});
							}
						} else if (milestoneMatch) {
							const milestone = options.taskOperations.state.milestones.find(
								(item) => item.id === milestoneMatch[1],
							);
							if (
								milestone?.status === "submitted" &&
								!milestone.collaborationUpdates.some(
									(update) => update.revision === milestone.revision && update.collaborator === role,
								)
							) {
								await options.taskOperations.publishMilestoneCollaboration(milestone.id, {
									summary: `${role} recorded the default integration collaboration update.`,
									evidenceRefs: [`test:${milestone.id}:${role}:continuous-collaboration`],
									uncertainties: [],
								});
							}
						}
					}
					return response;
				}),
				abort: vi.fn(),
				getLastStageAudit: () => ({ events: roleStageAudit ? roleStageAudit(role, promptCount) : [] }),
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

// These tests exercise durable Git and runtime-record workflows rather than a
// latency target. Keep the protocol's own timeouts unchanged, but allow the
// complete serial integration group enough outer time on Windows hosts.
// These integration cases create three role sessions, durable ledgers, Git fixtures, and real child
// processes. This host-side allowance does not change any production stage, epoch, or review timeout.
const ANSTEEL_EXTENSION_TEST_TIMEOUT_MS = 60_000;

describe("Ansteel team extension", { timeout: ANSTEEL_EXTENSION_TEST_TIMEOUT_MS }, () => {
	it("registers guarded production mutation tools for default role sessions", async () => {
		const cwd = createTemporaryProject();
		const outside = createTemporaryProject();
		const existingPath = join(cwd, "existing.ts");
		writeFileSync(existingPath, "original\n", "utf8");
		const existingStats = statSync(existingPath, { bigint: true });
		const existingIdentity = {
			dev: existingStats.dev,
			ino: existingStats.ino,
			sha256: createHash("sha256").update(readFileSync(existingPath)).digest("hex"),
		};
		const approvedPath = resolveAnsteelTeamWritePath(cwd, "pending/escaped.ts");
		symlinkSync(outside, join(cwd, "pending"), process.platform === "win32" ? "junction" : "dir");
		const mutationTools = createAnsteelTeamMutationToolController(cwd);
		const writeTool = mutationTools.tools.find((tool) => tool.name === "write");
		if (!writeTool) throw new Error("Missing guarded Ansteel write tool");
		mutationTools.authorize(approvedPath, existingIdentity);

		await expect(
			writeTool.execute(
				"TOOL-DEFAULT-WRITE-TOCTOU-1",
				{
					path: approvedPath,
					content: "must not escape\n",
				},
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow("changed after approval");
		expect(existsSync(join(outside, "escaped.ts"))).toBe(false);

		mutationTools.authorize(existingPath, existingIdentity);
		await expect(
			writeTool.execute(
				"TOOL-DEFAULT-WRITE-EXISTING-1",
				{
					path: existingPath,
					content: "updated safely\n",
				},
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).resolves.toBeDefined();
		expect(readFileSync(existingPath, "utf8")).toBe("updated safely\n");

		const missingPath = resolveAnsteelTeamWritePath(cwd, "new-file.ts");
		mutationTools.authorize(missingPath, existingIdentity);
		await expect(
			writeTool.execute(
				"TOOL-DEFAULT-WRITE-MISSING-1",
				{
					path: missingPath,
					content: "must fail closed\n",
				},
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow("atomic creation is unavailable");
		expect(existsSync(missingPath)).toBe(false);
	});

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
		expect(roleSessionOptions.every((options) => options.recordReadOnlyToolBudget !== undefined)).toBe(true);
		expect(roleSessionOptions.every((options) => options.recordProviderRetry !== undefined)).toBe(true);
		expect(prompts).toHaveLength(6);
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "ansteel-team-event", display: true }),
			{ triggerTurn: false },
		);
	});

	it("allows an in-stage retry after a governed tool input error succeeds", async () => {
		const harness = setup(createConfig(), undefined, createTemporaryProject(), (role) =>
			role === "tech-lead"
				? [
						{ type: "tool-execution-end", toolName: "ansteel_publish_checkpoint", isError: true },
						{ type: "tool-execution-end", toolName: "ansteel_publish_checkpoint", isError: false },
					]
				: [],
		);
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		await command("start Review the parser", harness.ctx);
		const failure = listAnsteelTeamEvents(harness.ctx.cwd).find((event) => event.type === "role-failure");
		expect(failure).toBeUndefined();
	});

	it("mechanically repairs a failed governed tool call with one corrective turn", async () => {
		const harness = setup(createConfig(), undefined, createTemporaryProject(), (role, promptCount) =>
			role === "tech-lead" && promptCount === 1
				? [{ type: "tool-execution-end", toolName: "ansteel_publish_checkpoint", isError: true }]
				: role === "tech-lead" && promptCount === 2
					? [{ type: "tool-execution-end", toolName: "ansteel_publish_checkpoint", isError: false }]
					: [],
		);
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		await command("start Review the parser", harness.ctx);
		const failure = listAnsteelTeamEvents(harness.ctx.cwd).find((event) => event.type === "role-failure");
		expect(failure).toBeUndefined();
		const run = listAnsteelRuntimeRuns(harness.ctx.cwd).at(-1);
		expect(run).toBeDefined();
		const entries = readAnsteelRuntimeLogs(harness.ctx.cwd, run!.runId);
		const techLeadRequests = entries.filter(
			(entry) => entry.role === "tech-lead" && entry.eventName === "provider.request.started",
		);
		const requestsByRoleSpan = new Map<string | undefined, (typeof techLeadRequests)[number][]>();
		for (const entry of techLeadRequests) {
			const requests = requestsByRoleSpan.get(entry.parentSpanId) ?? [];
			requests.push(entry);
			requestsByRoleSpan.set(entry.parentSpanId, requests);
		}
		const repairedRequests = [...requestsByRoleSpan.values()].find((requests) => requests.length === 2);
		expect(repairedRequests).toBeDefined();
		expect(repairedRequests!.map((entry) => entry.providerRequestId)).toEqual([
			expect.stringMatching(/^PROVIDER-/),
			expect.stringMatching(/^PROVIDER-/),
		]);
		expect(new Set(repairedRequests!.map((entry) => entry.providerRequestId)).size).toBe(2);
		expect(repairedRequests!.map((entry) => entry.data)).toEqual([
			expect.objectContaining({ requestRound: 1, retryCount: 0, timeoutStage: "role-stage" }),
			expect.objectContaining({ requestRound: 2, retryCount: 0, timeoutStage: "role-stage" }),
		]);
		const repairedProviderRequestIds = new Set(repairedRequests!.map((entry) => entry.providerRequestId));
		expect(
			entries.filter(
				(entry) =>
					entry.eventName === "provider.request.completed" &&
					entry.providerRequestId !== undefined &&
					repairedProviderRequestIds.has(entry.providerRequestId),
			),
		).toHaveLength(2);
		expect(
			entries.filter(
				(entry) => entry.eventName === "role.session.output" && entry.spanId === repairedRequests![0]!.parentSpanId,
			),
		).toHaveLength(1);
	});

	it("fails the stage when the mechanical repair turn cannot fix the governed tool call", async () => {
		const harness = setup(createConfig(), undefined, createTemporaryProject(), (role) =>
			role === "tech-lead"
				? [{ type: "tool-execution-end", toolName: "ansteel_publish_checkpoint", isError: true }]
				: [],
		);
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		const error = await command("start Review the parser", harness.ctx).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("without a successful retry");
	});

	it("fails the stage when the final governed tool attempt is an error", async () => {
		const harness = setup(createConfig(), undefined, createTemporaryProject(), (role) =>
			role === "tech-lead"
				? [{ type: "tool-execution-end", toolName: "ansteel_publish_checkpoint", isError: true }]
				: [],
		);
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		const error = await command("start Review the parser", harness.ctx).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("without a successful retry");
		const failure = listAnsteelTeamEvents(harness.ctx.cwd).find((event) => event.type === "role-failure");
		expect(failure?.role).toBe("tech-lead");
	});

	it("fails the stage when governed tool input errors exceed the retry limit", async () => {
		const harness = setup(createConfig(), undefined, createTemporaryProject(), (role) =>
			role === "tech-lead"
				? [
						{ type: "tool-execution-end", toolName: "ansteel_publish_checkpoint", isError: true },
						{ type: "tool-execution-end", toolName: "ansteel_publish_checkpoint", isError: true },
						{ type: "tool-execution-end", toolName: "ansteel_publish_checkpoint", isError: true },
						{ type: "tool-execution-end", toolName: "ansteel_publish_checkpoint", isError: false },
					]
				: [],
		);
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		const error = await command("start Review the parser", harness.ctx).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("exceeded the stage retry limit");
	});

	it("redacts provider failures before writing the public ledger or UI timeline", async () => {
		const harness = setup(createConfig(), async (role) => {
			if (role === "tech-lead") {
				throw new Error("provider api_key: provider-secret; authorization: Basic scheme-secret");
			}
			return `${role} completed collaboration.`;
		});
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");

		const publicError = await command("start Review provider failure redaction", harness.ctx).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(publicError).toBeInstanceOf(Error);
		expect((publicError as Error).message).not.toContain("provider-secret");
		expect((publicError as Error).message).not.toContain("scheme-secret");

		const failure = listAnsteelTeamEvents(harness.ctx.cwd).find(
			(event) => event.type === "role-failure" && event.role === "tech-lead",
		);
		expect(failure?.content).toContain("api_key: [REDACTED]");
		expect(failure?.content).toContain("authorization: [REDACTED]");
		expect(failure?.content).not.toContain("provider-secret");
		expect(failure?.content).not.toContain("scheme-secret");
		const renderedTimeline = JSON.stringify(harness.sendMessage.mock.calls);
		expect(renderedTimeline).not.toContain("provider-secret");
		expect(renderedTimeline).not.toContain("scheme-secret");
	});

	it("redacts successful role output at both the public ledger and UI boundaries", async () => {
		const harness = setup(createConfig(), async (role) =>
			role === "tech-lead"
				? 'api_key: ledger-secret; {"access_token":"json-secret"}; Authorization: Bearer bearer-secret'
				: `${role} completed collaboration.`,
		);
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");

		await command("start Review successful output redaction", harness.ctx);

		const report = listAnsteelTeamEvents(harness.ctx.cwd).find(
			(event) => event.type === "role-report" && event.role === "tech-lead",
		);
		expect(report?.content).toContain("api_key: [REDACTED]");
		expect(report?.content).toContain('"access_token":[REDACTED]');
		expect(report?.content).toContain("Authorization: [REDACTED]");
		const publicData = JSON.stringify({
			events: listAnsteelTeamEvents(harness.ctx.cwd),
			timeline: harness.sendMessage.mock.calls,
		});
		expect(publicData).not.toContain("ledger-secret");
		expect(publicData).not.toContain("json-secret");
		expect(publicData).not.toContain("bearer-secret");
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

	it("records mechanical action assessments and exposes exact peer action reviews", async () => {
		const harness = setup();
		initializeGitProject(harness.ctx.cwd);
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		await command("start Review the parser", harness.ctx);
		const staff = harness.roleSessionOptions.find((entry) => entry.role === "staff-engineer");
		const techLead = harness.roleSessionOptions.find((entry) => entry.role === "tech-lead");
		const qa = harness.roleSessionOptions.find((entry) => entry.role === "qa-engineer");
		if (!staff || !techLead || !qa) throw new Error("Missing role operations");
		await staff.taskOperations.claimTask({
			id: "TASK-ACTION-GATE",
			files: ["src/parser.ts"],
			description: "Change the governed parser.",
			acceptanceCriteria: "The parser test passes.",
		});

		const withoutCheckpoint = await staff.taskOperations.assessAction("edit", {
			path: "src/parser.ts",
			edits: [],
		});
		expect(withoutCheckpoint.blockReason).toContain("active checkpoint");

		const checkpoint = await staff.taskOperations.publishCheckpoint({
			id: "CP-ACTION-GATE-0001",
			taskId: "TASK-ACTION-GATE",
			goal: "Change the governed parser",
			currentUnderstanding: "The exact edit is ready for peer inspection",
			assumptions: [],
			evidenceRefs: ["file:src/parser.ts"],
			uncertainties: [],
			nextAction: { kind: "edit", target: "src/parser.ts", expectedResult: "The parser changes" },
			risk: "yellow",
			confidence: "L2",
		});
		const action = {
			kind: checkpoint.governedAction!.kind,
			target: checkpoint.governedAction!.target,
			version: checkpoint.governedAction!.version,
		};
		await techLead.taskOperations.reviewAction({
			checkpointId: checkpoint.id,
			action,
			verdict: "approve",
			reason: "The change stays inside the task lease.",
		});
		expect(
			(await staff.taskOperations.assessAction("edit", { path: "src/parser.ts", edits: [] })).blockReason,
		).toContain("qa-engineer");
		await qa.taskOperations.reviewAction({
			checkpointId: checkpoint.id,
			action,
			verdict: "approve",
			reason: "The parser boundary remains testable.",
		});

		expect(
			(await staff.taskOperations.assessAction("edit", { path: "src/parser.ts", edits: [] })).blockReason,
		).toBeUndefined();
		expect((await qa.taskOperations.assessAction("read", { path: "src/parser.ts" })).action.effectiveRisk).toBe(
			"green",
		);
		expect(listAnsteelTeamEvents(harness.ctx.cwd).map((event) => event.type)).toEqual(
			expect.arrayContaining(["action-assessed", "action-review"]),
		);
		const timeline = harness.sendMessage.mock.calls
			.map(([message]) => ("content" in message ? message.content : ""))
			.join("\n");
		expect(timeline).toContain("action-assessed");
		expect(timeline).toContain("action-review");
	});

	it("collects required peer action reviews before releasing an owner mutation", async () => {
		const config = createConfig();
		config.teamTaskMaxEpochs = 1;
		let ownerAssessment: Awaited<ReturnType<AnsteelTeamTaskOperations["assessAction"]>> | undefined;
		const scheduledReviewers: string[] = [];
		let harness: ReturnType<typeof setup>;
		harness = setup(config, async (role, prompt) => {
			const operations = harness.roleSessionOptions.find((entry) => entry.role === role)?.taskOperations;
			if (!operations) throw new Error(`Missing task operations for ${role}`);
			if (role === "staff-engineer" && prompt.includes("Execute governed task TASK-ACTION-HANDOFF")) {
				await operations.publishCheckpoint({
					id: "CP-ACTION-HANDOFF-0001",
					taskId: "TASK-ACTION-HANDOFF",
					goal: "Change the governed parser after exact peer authorization",
					currentUnderstanding: "The task-local edit is ready for independent review",
					assumptions: [],
					evidenceRefs: ["file:src/parser.ts"],
					uncertainties: [],
					nextAction: { kind: "edit", target: "src/parser.ts", expectedResult: "The parser changes" },
					risk: "yellow",
					confidence: "L2",
				});
				ownerAssessment = await operations.assessAction("edit", { path: "src/parser.ts", edits: [] });
				return "The owner received the coordinator's action-authorization result.";
			}
			if (prompt.includes("independent peer reviewer for one immutable governed action binding")) {
				const checkpoint = operations.state.workCheckpoints.find((item) => item.id === "CP-ACTION-HANDOFF-0001");
				if (!checkpoint?.governedAction) throw new Error("Missing action handoff checkpoint");
				scheduledReviewers.push(role);
				await operations.reviewAction({
					checkpointId: checkpoint.id,
					action: {
						kind: checkpoint.governedAction.kind,
						target: checkpoint.governedAction.target,
						version: checkpoint.governedAction.version,
					},
					verdict: "approve",
					reason: "The immutable action binding stays inside the task lease.",
				});
				return `${role} approved the immutable action binding.`;
			}
			return `${role} completed its stage.`;
		});
		initializeGitProject(harness.ctx.cwd);
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		await command("start Review the parser", harness.ctx);

		await command(
			'task {"id":"TASK-ACTION-HANDOFF","owner":"staff-engineer","type":"implementation","files":["src/parser.ts"],"description":"Change parser after peer authorization","acceptanceCriteria":"The parser test passes","dependsOn":[]}',
			harness.ctx,
		);

		expect(ownerAssessment?.blockReason).toBeUndefined();
		expect(scheduledReviewers.sort()).toEqual(["qa-engineer", "tech-lead"]);
		expect(
			loadAnsteelTeamState(harness.ctx.cwd)?.actionReviews.filter(
				(review) => review.checkpointId === "CP-ACTION-HANDOFF-0001" && review.verdict === "approve",
			),
		).toHaveLength(2);
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
					/Goal:[\s\S]*Three-axis status:[\s\S]*collaboration: disputed[\s\S]*governance: not-required[\s\S]*delivery: not-started[\s\S]*workflow: blocked[\s\S]*Role status and active checkpoint[\s\S]*Active checkpoints: 1[\s\S]*Open process issues: 1[\s\S]*Blocking process issues: 1/,
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

		const runIdsBeforeDoctor = listAnsteelRuntimeRuns(harness.ctx.cwd).map((run) => run.runId);
		await expect(command(`doctor ${healthyRun!.runId}`, harness.ctx)).rejects.toThrow();
		// A strict integrity gate fails before it creates a diagnostic run. A new
		// run here could rebuild the log index and overwrite the evidence being checked.
		expect(listAnsteelRuntimeRuns(harness.ctx.cwd).map((run) => run.runId)).toEqual(runIdsBeforeDoctor);

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

		const runIdsBeforeDoctor = listAnsteelRuntimeRuns(harness.ctx.cwd).map((run) => run.runId);
		await expect(command(`doctor ${healthyRun!.runId}`, harness.ctx)).rejects.toThrow();
		expect(listAnsteelRuntimeRuns(harness.ctx.cwd).map((run) => run.runId)).toEqual(runIdsBeforeDoctor);
		const postMismatchMessages = harness.sendMessage.mock.calls
			.map(([message]) => ("content" in message ? message.content : ""))
			.join("\n");
		expect(postMismatchMessages).toContain("Ansteel team command failed");
		expect(postMismatchMessages).not.toContain("Health: healthy");

		harness.sendMessage.mockClear();
		await expect(command("status", harness.ctx)).rejects.toThrow("state-projection-mismatch");
		expect(harness.sendMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ content: expect.stringContaining("Ansteel team command failed") }),
			{ triggerTurn: false },
		);
		expect(harness.sendMessage).not.toHaveBeenLastCalledWith(
			expect.objectContaining({ content: expect.stringContaining("Three-axis status") }),
			expect.anything(),
		);
	});

	it("does not rebuild a missing runtime index before the doctor integrity preflight", async () => {
		const harness = setup();
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		await command("start Review the parser", harness.ctx);
		await command("board", harness.ctx);
		const healthyRun = listAnsteelRuntimeRuns(harness.ctx.cwd).at(-1);
		if (!healthyRun) throw new Error("Missing healthy runtime run");
		const indexPath = getAnsteelRuntimeIndexPath(harness.ctx.cwd);
		expect(existsSync(indexPath)).toBe(true);
		rmSync(indexPath);

		await expect(command(`doctor ${healthyRun.runId}`, harness.ctx)).rejects.toThrow("runtime-log integrity");
		// The command must fail before runObservedCommand opens a writer, otherwise
		// normal logger recovery would recreate the deleted index and hide tampering.
		expect(existsSync(indexPath)).toBe(false);
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

		const runIdsBeforeDoctor = listAnsteelRuntimeRuns(harness.ctx.cwd).map((run) => run.runId);
		await expect(command(`doctor ${healthyRun!.runId}`, harness.ctx)).rejects.toThrow();
		expect(listAnsteelRuntimeRuns(harness.ctx.cwd).map((run) => run.runId)).toEqual(runIdsBeforeDoctor);
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
		rmSync(join(harness.ctx.cwd, ".pi", "ansteel-team", "run-index.json"), { force: true });

		await expect(command("board", harness.ctx)).rejects.toThrow("verifiable historical runtime run");
		await expect(command("board", harness.ctx)).rejects.toThrow("verifiable historical runtime run");
		expect(harness.sendMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ content: expect.stringContaining("Ansteel team command failed") }),
			{ triggerTurn: false },
		);
	});

	it("rejects an orphaned same-team run whose last completed child tool succeeded", async () => {
		const harness = setup();
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		await command("start Review the parser", harness.ctx);
		const state = loadAnsteelTeamState(harness.ctx.cwd);
		if (!state) throw new Error("Missing persisted Ansteel team state");

		const orphanedContext = createAnsteelRunContext({
			teamId: state.id,
			command: "task TASK-BOARD-ORPHAN-1",
		});
		const orphanedLogger = createAnsteelRuntimeLogger(harness.ctx.cwd, orphanedContext);
		const root = orphanedLogger.startSpan("run.started", { role: "coordinator" });
		const tool = orphanedLogger.startSpan("tool.call", {
			parent: root,
			role: "tech-lead",
			taskId: "TASK-BOARD-ORPHAN-1",
			toolCallId: "TOOL-BOARD-ORPHAN-1",
		});
		tool.end({
			outcome: "succeeded",
			message: "child tool completed before the host crashed",
			data: { exitCode: 0 },
		});
		await orphanedLogger.forceFlush();
		orphanedLogger.close();

		const otherRunIds = listAnsteelRuntimeRuns(harness.ctx.cwd)
			.filter((run) => run.teamId === state.id && run.runId !== orphanedContext.runId)
			.map((run) => run.runId);
		const logDirectory = getAnsteelRuntimeLogDirectory(harness.ctx.cwd);
		for (const fileName of readdirSync(logDirectory)) {
			if (otherRunIds.some((runId) => fileName.startsWith(`run-${runId}-`))) {
				rmSync(join(logDirectory, fileName), { force: true });
			}
		}
		rmSync(join(harness.ctx.cwd, ".pi", "ansteel-team", "run-index.json"), { force: true });

		await expect(command("board", harness.ctx)).rejects.toThrow("verifiable historical runtime run");
	});

	it("rejects a same-team run whose forged successful root terminal has a parent", async () => {
		const harness = setup();
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		await command("start Review the parser", harness.ctx);
		const state = loadAnsteelTeamState(harness.ctx.cwd);
		if (!state) throw new Error("Missing persisted Ansteel team state");

		const forgedContext = createAnsteelRunContext({
			teamId: state.id,
			command: "task TASK-BOARD-FORGED-ROOT-1",
		});
		const forgedLogger = createAnsteelRuntimeLogger(harness.ctx.cwd, forgedContext);
		const root = forgedLogger.startSpan("run.started", { role: "coordinator" });
		forgedLogger.write({
			level: "info",
			eventName: "run.completed",
			outcome: "succeeded",
			spanId: root.spanId,
			parentSpanId: "f".repeat(16),
			role: "coordinator",
			taskId: "TASK-BOARD-FORGED-ROOT-1",
			message: "forged non-root terminal",
			data: { command: forgedContext.command },
		});
		forgedLogger.close();

		const otherRunIds = listAnsteelRuntimeRuns(harness.ctx.cwd)
			.filter((run) => run.teamId === state.id && run.runId !== forgedContext.runId)
			.map((run) => run.runId);
		const logDirectory = getAnsteelRuntimeLogDirectory(harness.ctx.cwd);
		for (const fileName of readdirSync(logDirectory)) {
			if (otherRunIds.some((runId) => fileName.startsWith(`run-${runId}-`))) {
				rmSync(join(logDirectory, fileName), { force: true });
			}
		}
		rmSync(join(harness.ctx.cwd, ".pi", "ansteel-team", "run-index.json"), { force: true });

		await expect(command("board", harness.ctx)).rejects.toThrow("verifiable historical runtime run");
	});

	it("renders a successful same-team tool fact after rebuilding the runtime index", async () => {
		const harness = setup();
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		await command("start Review the parser", harness.ctx);
		const state = loadAnsteelTeamState(harness.ctx.cwd);
		if (!state) throw new Error("Missing persisted Ansteel team state");

		const successfulContext = createAnsteelRunContext({
			teamId: state.id,
			command: "task TASK-BOARD-HISTORY-1",
		});
		const successfulLogger = createAnsteelRuntimeLogger(harness.ctx.cwd, successfulContext);
		const root = successfulLogger.startSpan("run.started", { role: "coordinator" });
		const tool = successfulLogger.startSpan("tool.call", {
			parent: root,
			role: "tech-lead",
			taskId: "TASK-BOARD-HISTORY-1",
			toolCallId: "TOOL-BOARD-HISTORY-1",
		});
		tool.end({
			outcome: "succeeded",
			message: "same-team tool fact survived index rebuild",
			data: { exitCode: 0 },
		});
		root.end({ outcome: "succeeded", message: "same-team run completed" });
		await successfulLogger.forceFlush();
		successfulLogger.close();
		rmSync(join(harness.ctx.cwd, ".pi", "ansteel-team", "run-index.json"), { force: true });
		harness.sendMessage.mockClear();

		await command("board", harness.ctx);

		expect(harness.sendMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ content: expect.stringContaining("tool.call.completed: succeeded") }),
			{ triggerTurn: false },
		);
	});

	it("does not accept another team runtime as shared-board history", async () => {
		const harness = setup();
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		await command("start Review the parser", harness.ctx);
		const state = loadAnsteelTeamState(harness.ctx.cwd);
		if (!state) throw new Error("Missing persisted Ansteel team state");

		const unrelatedContext = createAnsteelRunContext({
			teamId: "unrelated-team",
			command: "task TASK-UNRELATED-BOARD-1",
		});
		const unrelatedLogger = createAnsteelRuntimeLogger(harness.ctx.cwd, unrelatedContext);
		unrelatedLogger.write({
			level: "info",
			eventName: "tool.call.completed",
			outcome: "succeeded",
			taskId: "TASK-UNRELATED-BOARD-1",
			message: "unrelated team tool fact",
			data: {},
		});
		unrelatedLogger.close();

		const currentTeamRunIds = listAnsteelRuntimeRuns(harness.ctx.cwd)
			.filter((run) => run.teamId === state.id)
			.map((run) => run.runId);
		const logDirectory = getAnsteelRuntimeLogDirectory(harness.ctx.cwd);
		for (const fileName of readdirSync(logDirectory)) {
			if (currentTeamRunIds.some((runId) => fileName.startsWith(`run-${runId}-`))) {
				rmSync(join(logDirectory, fileName), { force: true });
			}
		}
		rmSync(join(harness.ctx.cwd, ".pi", "ansteel-team", "run-index.json"), { force: true });

		await expect(command("board", harness.ctx)).rejects.toThrow("verifiable historical runtime run");
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
				content: expect.stringMatching(
					new RegExp(`Three-axis status:.*delivery: not-started.*${capturedRun!.runId}.*provider-timeout`, "s"),
				),
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
			expect.arrayContaining([
				"lease.acquired",
				"lease.released",
				"role.session.started",
				"role.session.output",
				"role.session.ended",
				"provider.request.started",
				"provider.request.completed",
				"state.persisted",
				"event.appended",
			]),
		);
		const acquiredLease = entries.find((entry) => entry.eventName === "lease.acquired");
		const releasedLease = entries.find((entry) => entry.eventName === "lease.released");
		expect(releasedLease).toMatchObject({
			outcome: "succeeded",
			leaseId: acquiredLease?.leaseId,
			data: { resourceKind: "runtime-run" },
		});
		expect(entries.indexOf(releasedLease!)).toBeGreaterThan(
			entries.findIndex((entry) => entry.eventName === "run.completed"),
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

		await command("status --explain", harness.ctx);
		expect(harness.sendMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({
				content: expect.stringMatching(new RegExp(`${failedRun!.runId}.*provider-timeout`, "s")),
			}),
			{ triggerTurn: false },
		);
		await command(`trace ${failedRun!.runId}`, harness.ctx);
		expect(harness.sendMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ content: expect.stringContaining("provider-timeout") }),
			{ triggerTurn: false },
		);
		await expect(command(`doctor ${failedRun!.runId}`, harness.ctx)).rejects.toThrow("is unhealthy");
		expect(harness.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.stringMatching(new RegExp(`${failedRun!.runId}.*provider-timeout`, "s")),
			}),
			{ triggerTurn: false },
		);

		await command(`incident ${failedRun!.runId}`, harness.ctx);
		await command(`incident ${failedRun!.runId}`, harness.ctx);
		const incidentDirectory = join(harness.ctx.cwd, ".pi", "ansteel-team", "incidents");
		expect(existsSync(incidentDirectory)).toBe(true);
		const incidentFiles = readdirSync(incidentDirectory);
		expect(incidentFiles).toEqual([
			expect.stringMatching(new RegExp(`^incident-${failedRun!.runId}-[0-9a-f]{64}\\.json$`)),
		]);
		const manifest = JSON.parse(readFileSync(join(incidentDirectory, incidentFiles[0]!), "utf8"));
		expect(manifest).toMatchObject({
			schemaVersion: 2,
			evidenceModel: "mechanical-facts-only",
			run: { runId: failedRun!.runId, traceId: failedRun!.traceId, terminalOutcome: "failed" },
			rootCause: { reasonCode: "provider-timeout" },
			finalRuntimeState: { terminalEvent: { eventName: "run.failed", reasonCode: "provider-timeout" } },
			configurationSummary: {
				providers: expect.arrayContaining([expect.objectContaining({ provider: "provider-c", model: "model-c" })]),
			},
			integrity: {
				runtimeEventChain: { status: "verified" },
				logSegments: { status: "verified" },
				artifacts: { status: "verified", missingCount: 0 },
			},
			projectContext: {
				availability: "verified",
				publicAuditEventRange: { integrity: "verified" },
				workspace: { status: "unavailable", reasonCode: "workspace-snapshot-unavailable" },
				recoveryEntry: { kind: "team-resume" },
			},
		});
		expect(manifest.propagationEvents).toEqual(
			expect.arrayContaining([expect.objectContaining({ eventName: "run.failed", reasonCode: "provider-timeout" })]),
		);
		expect(manifest.spanTree.nodes.length).toBeGreaterThanOrEqual(3);
		expect(JSON.stringify(manifest)).not.toContain("modelAnalysis");
	});

	it("finalizes and blocks an orphaned run and records its public recovery audit before resuming", async () => {
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
		const state = loadAnsteelTeamState(firstHost.ctx.cwd)!;
		transitionAnsteelTeamStatus(state, "active", "test-interrupted-host-active");
		transitionAnsteelTeamRoleStatus(state, "staff-engineer", "working", "test-provider-request-interrupted");
		saveAnsteelTeamState(firstHost.ctx.cwd, state);

		const restartedHost = setup(createConfig(), undefined, firstHost.ctx.cwd);
		const restartedCommand = restartedHost.commands.get("ansteel-team");
		if (!restartedCommand) throw new Error("Missing restarted-host ansteel-team command");
		await expect(restartedCommand("start Review the parser", restartedHost.ctx)).rejects.toThrow("orphaned runtime");
		expect(diagnoseAnsteelTeamRun(restartedHost.ctx.cwd, orphanContext.runId)).toMatchObject({
			healthy: false,
			rootCause: {
				eventName: "provider.request.completed",
				outcome: "abandoned",
				reasonCode: "process-orphaned",
				providerRequestId: "PROVIDER-RECOVERY-ORPHAN-1",
			},
		});
		const recoveryEvents = listAnsteelTeamEvents(restartedHost.ctx.cwd).filter(
			(event) => event.type === "runtime-recovery",
		);
		expect(recoveryEvents).toContainEqual(
			expect.objectContaining({
				type: "runtime-recovery",
				role: "coordinator",
				reasonCode: "process-orphaned",
				payload: expect.objectContaining({
					kind: "runtime-recovery",
					runId: orphanContext.runId,
					abandonedSpanCount: 1,
					previousHeadHash: expect.stringMatching(/^[0-9a-f]{64}$/),
					recoveredHeadHash: expect.stringMatching(/^[0-9a-f]{64}$/),
					recoveredAt: expect.any(String),
				}),
			}),
		);
		expect(JSON.stringify(recoveryEvents)).not.toMatch(/stdout|authorization|api[_-]?key|secret/i);

		await restartedCommand("start Review the parser", restartedHost.ctx);

		expect(restartedHost.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining("recovered from an interrupted host") }),
			{ triggerTurn: false },
		);
	});

	it("does not publish a successful recovery audit while the original host still owns the logger", async () => {
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
		expect(listAnsteelTeamEvents(firstHost.ctx.cwd).filter((event) => event.type === "runtime-recovery")).toEqual([]);

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

	it("requires two public collaboration updates before final independent task verification", async () => {
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

		expect(prompts).toHaveLength(10);
		expect(prompts.filter((prompt) => prompt.includes("continuous collaborator for TASK-1 revision"))).toHaveLength(
			2,
		);
		expect(
			prompts.some((prompt) => prompt.startsWith("You are the staff-engineer continuous collaborator for TASK-1")),
		).toBe(false);
		expect(prompts.filter((prompt) => prompt.startsWith("You are the independent "))).toHaveLength(2);
		expect(
			prompts.find((prompt) => prompt.startsWith("You are the independent tech-lead final-verification reviewer")),
		).toContain("Coordinator-verified dependency delivery receipts:\n\n```json\n\n[]\n\n```");
		const taskEventTypes = listAnsteelTeamEvents(ctx.cwd)
			.filter((event) =>
				["task-collaboration", "task-final-verification-requested", "task-review"].includes(event.type),
			)
			.map((event) => event.type);
		expect(taskEventTypes).toEqual([
			"task-collaboration",
			"task-collaboration",
			"task-final-verification-requested",
			"task-review",
			"task-review",
		]);
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
			'task {"id":"TASK-1","owner":"staff-engineer","type":"implementation","files":["src/parser.ts"],"description":"Change parser","acceptanceCriteria":"The parser test passes","dependsOn":[]}',
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
			expect.arrayContaining([
				"task.claim",
				"tool.call.started",
				"tool.call.completed",
				"task.submit",
				"task.review",
			]),
		);
		expect(
			operationEntries.find((entry) => entry.eventName === "tool.call.completed" && entry.outcome === "succeeded"),
		).toMatchObject({ taskId: "TASK-1", outcome: "succeeded" });
		const toolStarted = operationEntries.find(
			(entry) => entry.eventName === "tool.call.started" && entry.taskId === "TASK-1",
		);
		const processStarted = operationEntries.find(
			(entry) => entry.eventName === "process.spawned" && entry.taskId === "TASK-1",
		);
		const processExited = operationEntries.find(
			(entry) => entry.eventName === "process.exited" && entry.processId === processStarted?.processId,
		);
		expect(processStarted).toMatchObject({
			outcome: "started",
			parentSpanId: toolStarted?.spanId,
			toolCallId: toolStarted?.toolCallId,
			data: { pid: expect.any(Number), policy: "task-test" },
		});
		expect(processExited).toMatchObject({
			outcome: "succeeded",
			parentSpanId: toolStarted?.spanId,
			toolCallId: toolStarted?.toolCallId,
			data: { exitCode: 0, timedOut: false },
		});
	});

	it(
		"runs three typed owners in parallel before sequential immutable peer reviews",
		async () => {
			const config = createConfig();
			config.teamTaskOwners = ["tech-lead", "staff-engineer", "qa-engineer"];
			config.teamTaskMaxEpochs = 2;
			config.teamTaskMaxNoProgressEpochs = 1;
			const ownerTaskByRole = {
				"tech-lead": "TASK-ARCHITECTURE",
				"staff-engineer": "TASK-IMPLEMENTATION",
				"qa-engineer": "TASK-VERIFICATION",
			} as const;
			const ownerFileByRole = {
				"tech-lead": ["src/architecture.ts", "export const architecture = 'after';\n"],
				"staff-engineer": ["src/implementation.ts", "export const implementation = 'after';\n"],
				"qa-engineer": [
					"test/verification.test.mjs",
					"import test from 'node:test';\ntest('verification', () => {});\ntest('parallel owner', () => {});\n",
				],
			} as const;
			const startedOwners = new Set<string>();
			let finishedOwners = 0;
			let releaseOwnerWave: (() => void) | undefined;
			const allOwnersStarted = new Promise<void>((resolve) => {
				releaseOwnerWave = resolve;
			});
			let harness: ReturnType<typeof setup>;
			harness = setup(config, async (role, prompt) => {
				const roleOptions = harness.roleSessionOptions.find((entry) => entry.role === role);
				if (!roleOptions) throw new Error(`Missing ${role} options`);
				const ownerTaskId = ownerTaskByRole[role as keyof typeof ownerTaskByRole];
				if (prompt.includes(`Execute governed task ${ownerTaskId}`)) {
					startedOwners.add(role);
					if (startedOwners.size === 3) releaseOwnerWave?.();
					await allOwnersStarted;
					const [path, content] = ownerFileByRole[role as keyof typeof ownerFileByRole];
					writeFileSync(join(harness.ctx.cwd, path), content, "utf8");
					await roleOptions.taskOperations.submitTask(ownerTaskId, "node --test test/verification.test.mjs");
					finishedOwners++;
					return `${role} submitted ${ownerTaskId}.`;
				}
				if (prompt.startsWith("You are the independent ")) {
					expect(finishedOwners).toBe(3);
					const reviewedTaskId = prompt.match(/reviewer for (TASK-[A-Z0-9-]+) revision/)?.[1];
					if (!reviewedTaskId) throw new Error("Missing task ID in review prompt");
					await roleOptions.taskOperations.reviewTask(reviewedTaskId, { verdict: "approve" });
					return `${role} approved ${reviewedTaskId}.`;
				}
				return `${role} completed discussion.`;
			});
			initializeGitProject(harness.ctx.cwd);
			writeFileSync(
				join(harness.ctx.cwd, "src", "architecture.ts"),
				"export const architecture = 'before';\n",
				"utf8",
			);
			writeFileSync(
				join(harness.ctx.cwd, "src", "implementation.ts"),
				"export const implementation = 'before';\n",
				"utf8",
			);
			writeFileSync(
				join(harness.ctx.cwd, "test", "verification.test.mjs"),
				"import test from 'node:test';\ntest('verification', () => {});\n",
				"utf8",
			);
			execFileSync("git", ["add", "src/architecture.ts", "src/implementation.ts", "test/verification.test.mjs"], {
				cwd: harness.ctx.cwd,
				stdio: "ignore",
			});
			execFileSync("git", ["commit", "-m", "parallel baseline"], { cwd: harness.ctx.cwd, stdio: "ignore" });
			const command = harness.commands.get("ansteel-team");
			if (!command) throw new Error("Missing ansteel-team command");
			await command("start Review typed parallel ownership", harness.ctx);

			await command(
				`task ${JSON.stringify([
					{
						id: "TASK-ARCHITECTURE",
						owner: "tech-lead",
						type: "architecture",
						files: ["src/architecture.ts"],
						description: "Define the architecture seam.",
						acceptanceCriteria: "The shared verification test passes.",
						dependsOn: [],
					},
					{
						id: "TASK-IMPLEMENTATION",
						owner: "staff-engineer",
						type: "implementation",
						files: ["src/implementation.ts"],
						description: "Implement the product behavior.",
						acceptanceCriteria: "The shared verification test passes.",
						dependsOn: [],
					},
					{
						id: "TASK-VERIFICATION",
						owner: "qa-engineer",
						type: "verification",
						files: ["test/verification.test.mjs"],
						description: "Extend the acceptance automation.",
						acceptanceCriteria: "The shared verification test passes.",
						dependsOn: [],
					},
				])}`,
				harness.ctx,
			);

			expect(startedOwners).toEqual(new Set(["tech-lead", "staff-engineer", "qa-engineer"]));
			expect(loadAnsteelTeamState(harness.ctx.cwd)?.tasks).toEqual([
				expect.objectContaining({
					id: "TASK-ARCHITECTURE",
					owner: "tech-lead",
					type: "architecture",
					status: "approved",
				}),
				expect.objectContaining({
					id: "TASK-IMPLEMENTATION",
					owner: "staff-engineer",
					type: "implementation",
					status: "approved",
				}),
				expect.objectContaining({
					id: "TASK-VERIFICATION",
					owner: "qa-engineer",
					type: "verification",
					status: "approved",
				}),
			]);
			const events = listAnsteelTeamEvents(harness.ctx.cwd);
			const assignmentEvents = events.filter((event) => event.type === "tasks-assigned");
			expect(assignmentEvents).toHaveLength(1);
			expect(assignmentEvents[0]?.content).toContain("TASK-ARCHITECTURE");
			expect(assignmentEvents[0]?.content).toContain("TASK-IMPLEMENTATION");
			expect(assignmentEvents[0]?.content).toContain("TASK-VERIFICATION");
			expect(events.filter((event) => event.type === "task-review")).toHaveLength(6);
			const parallelRun = listAnsteelRuntimeRuns(harness.ctx.cwd).at(-1);
			expect(parallelRun).toBeDefined();
			expect(
				readAnsteelRuntimeLogs(harness.ctx.cwd, parallelRun!.runId).some(
					(entry) => entry.eventName === "task.claim.parallel" && entry.outcome === "succeeded",
				),
			).toBe(true);
		},
		ANSTEEL_EXTENSION_TEST_TIMEOUT_MS,
	);

	it("rejects a parallel assignment event without leaving a partial batch", async () => {
		const config = createConfig();
		config.teamTaskOwners = ["tech-lead", "staff-engineer", "qa-engineer"];
		let ownerPrompts = 0;
		const harness = setup(config, async (role, prompt) => {
			if (prompt.includes("Execute governed task")) ownerPrompts++;
			return `${role} completed discussion.`;
		});
		initializeGitProject(harness.ctx.cwd);
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		await command("start Exercise atomic parallel assignment", harness.ctx);
		const eventsBefore = listAnsteelTeamEvents(harness.ctx.cwd);

		await expect(
			command(
				`task ${JSON.stringify([
					{
						id: "TASK-ARCHITECTURE",
						owner: "tech-lead",
						type: "architecture",
						files: ["src/architecture.ts"],
						description: "Define the architecture.",
						acceptanceCriteria: "The architecture test passes.",
						dependsOn: [],
					},
					{
						id: "TASK-IMPLEMENTATION",
						owner: "staff-engineer",
						type: "implementation",
						files: ["src/implementation.ts"],
						description: "Implement the feature.",
						acceptanceCriteria: "x".repeat(17_000),
						dependsOn: [],
					},
					{
						id: "TASK-VERIFICATION",
						owner: "qa-engineer",
						type: "verification",
						files: ["test/verification.ts"],
						description: "Verify the feature.",
						acceptanceCriteria: "The verification test passes.",
						dependsOn: [],
					},
				])}`,
				harness.ctx,
			),
		).rejects.toThrow("public content exceeds");

		expect(ownerPrompts).toBe(0);
		expect(loadAnsteelTeamState(harness.ctx.cwd)?.tasks).toEqual([]);
		expect(listAnsteelTeamEvents(harness.ctx.cwd)).toEqual(eventsBefore);
	});

	it("queues cross-role review when a parallel owner submits an older task", async () => {
		const config = createConfig();
		config.teamTaskOwners = ["tech-lead", "staff-engineer", "qa-engineer"];
		config.teamTaskMaxEpochs = 1;
		config.teamTaskMaxNoProgressEpochs = 1;
		let finishedOwners = 0;
		let reviewPrompts = 0;
		let prematureReviewPrompts = 0;
		let harness: ReturnType<typeof setup>;
		harness = setup(config, async (role, prompt) => {
			const roleOptions = harness.roleSessionOptions.find((entry) => entry.role === role);
			if (!roleOptions) throw new Error(`Missing ${role} options`);
			if (prompt.includes("Execute governed task TASK-IMPLEMENTATION")) {
				writeFileSync(
					join(harness.ctx.cwd, "src", "parser.ts"),
					"export const parser = 'old-task-change';\n",
					"utf8",
				);
				await roleOptions.taskOperations.submitTask("TASK-OLD", "node --test test/parser.test.mjs");
				finishedOwners++;
				return "Staff submitted its older task during the new owner wave.";
			}
			if (prompt.includes("Execute governed task")) {
				finishedOwners++;
				return `${role} completed its new owner task.`;
			}
			if (prompt.startsWith("You are the independent ") && prompt.includes("reviewer for TASK-OLD revision")) {
				reviewPrompts++;
				if (finishedOwners < 3) prematureReviewPrompts++;
				await roleOptions.taskOperations.reviewTask("TASK-OLD", { verdict: "approve" });
				return `${role} approved TASK-OLD.`;
			}
			return `${role} completed discussion.`;
		});
		initializeGitProject(harness.ctx.cwd);
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		await command("start Exercise cross-task parallel prompt deferral", harness.ctx);
		const staff = harness.roleSessionOptions.find((entry) => entry.role === "staff-engineer");
		if (!staff) throw new Error("Missing Staff Engineer operations");
		await staff.taskOperations.claimTask({
			id: "TASK-OLD",
			type: "implementation",
			files: ["src/parser.ts"],
			description: "Keep an older Staff task active.",
			acceptanceCriteria: "The parser test passes.",
			dependsOn: [],
		});
		reviewPrompts = 0;

		await command(
			`task ${JSON.stringify([
				{
					id: "TASK-ARCHITECTURE",
					owner: "tech-lead",
					type: "architecture",
					files: ["src/architecture.ts"],
					description: "Exercise the architecture owner.",
					acceptanceCriteria: "The batch remains isolated.",
					dependsOn: [],
				},
				{
					id: "TASK-IMPLEMENTATION",
					owner: "staff-engineer",
					type: "implementation",
					files: ["src/implementation.ts"],
					description: "Exercise the Staff owner.",
					acceptanceCriteria: "The batch remains isolated.",
					dependsOn: [],
				},
				{
					id: "TASK-VERIFICATION",
					owner: "qa-engineer",
					type: "verification",
					files: ["test/verification.ts"],
					description: "Exercise the QA owner.",
					acceptanceCriteria: "The batch remains isolated.",
					dependsOn: [],
				},
			])}`,
			harness.ctx,
		);

		expect(prematureReviewPrompts).toBe(0);
		expect(reviewPrompts).toBe(2);
		expect(loadAnsteelTeamState(harness.ctx.cwd)?.tasks).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "TASK-OLD", status: "approved" })]),
		);
	});

	it("flushes a deferred older milestone after every parallel owner settles", async () => {
		const config = createConfig();
		config.teamTaskOwners = ["tech-lead", "staff-engineer", "qa-engineer"];
		config.teamTaskMaxEpochs = 1;
		config.teamTaskMaxNoProgressEpochs = 1;
		let finishedOwners = 0;
		let expectedOwners = 3;
		let milestoneReviewPrompts = 0;
		let prematureMilestoneReviews = 0;
		let qaMilestoneAttempts = 0;
		let harness: ReturnType<typeof setup>;
		harness = setup(config, async (role, prompt) => {
			const roleOptions = harness.roleSessionOptions.filter((entry) => entry.role === role).at(-1);
			if (!roleOptions) throw new Error(`Missing ${role} options`);
			if (prompt.includes("reviewer for TASK-PREREQUISITE revision")) {
				await roleOptions.taskOperations.reviewTask("TASK-PREREQUISITE", { verdict: "approve" });
				return `${role} approved the prerequisite task.`;
			}
			if (prompt.includes("Execute governed task TASK-ARCHITECTURE. This")) {
				await roleOptions.taskOperations.submitMilestone("MILESTONE-OLD", "node --test test/parser.test.mjs");
				finishedOwners++;
				return "Tech Lead submitted the older milestone during the new owner wave.";
			}
			if (prompt.includes("Execute governed task")) {
				finishedOwners++;
				return `${role} completed its new owner task.`;
			}
			if (prompt.includes("reviewer for MILESTONE-OLD integration revision")) {
				milestoneReviewPrompts++;
				if (finishedOwners < expectedOwners) prematureMilestoneReviews++;
				if (role === "qa-engineer" && ++qaMilestoneAttempts === 1) {
					throw new Error("transient QA provider failure");
				}
				await roleOptions.taskOperations.reviewMilestone("MILESTONE-OLD", { verdict: "approve" });
				return `${role} approved MILESTONE-OLD.`;
			}
			return `${role} completed discussion.`;
		});
		initializeGitProject(harness.ctx.cwd);
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		await command("start Exercise milestone prompt deferral", harness.ctx);
		const staff = harness.roleSessionOptions.find((entry) => entry.role === "staff-engineer");
		const techLead = harness.roleSessionOptions.find((entry) => entry.role === "tech-lead");
		if (!staff || !techLead) throw new Error("Missing task operations for milestone setup");
		await staff.taskOperations.claimTask({
			id: "TASK-PREREQUISITE",
			type: "implementation",
			files: ["src/parser.ts"],
			description: "Prepare an approved task for an older integration milestone.",
			acceptanceCriteria: "The parser test passes.",
			dependsOn: [],
		});
		writeFileSync(join(harness.ctx.cwd, "src", "parser.ts"), "export const parser = 'milestone-ready';\n", "utf8");
		await staff.taskOperations.submitTask("TASK-PREREQUISITE", "node --test test/parser.test.mjs");
		const prerequisite = staff.taskOperations.state.tasks.find((task) => task.id === "TASK-PREREQUISITE");
		if (!prerequisite) throw new Error("Missing approved prerequisite task");
		await command(
			`verify ${prerequisite.id} "${createDeliveryManifest(prerequisite.id, prerequisite.revision)}"`,
			harness.ctx,
		);
		await techLead.taskOperations.createMilestone({
			id: "MILESTONE-OLD",
			taskIds: ["TASK-PREREQUISITE"],
			description: "Verify the approved prerequisite as one integration unit.",
			acceptanceCriteria: "The parser integration test passes.",
		});
		finishedOwners = 0;

		await command(
			`task ${JSON.stringify([
				{
					id: "TASK-ARCHITECTURE",
					owner: "tech-lead",
					type: "architecture",
					files: ["src/architecture.ts"],
					description: "Exercise the architecture owner.",
					acceptanceCriteria: "The batch remains isolated.",
					dependsOn: [],
				},
				{
					id: "TASK-IMPLEMENTATION",
					owner: "staff-engineer",
					type: "implementation",
					files: ["src/implementation.ts"],
					description: "Exercise the Staff owner.",
					acceptanceCriteria: "The batch remains isolated.",
					dependsOn: [],
				},
				{
					id: "TASK-VERIFICATION",
					owner: "qa-engineer",
					type: "verification",
					files: ["test/verification.ts"],
					description: "Exercise the QA owner.",
					acceptanceCriteria: "The batch remains isolated.",
					dependsOn: [],
				},
			])}`,
			harness.ctx,
		);

		expect(prematureMilestoneReviews).toBe(0);
		expect(milestoneReviewPrompts).toBe(2);
		expect(loadAnsteelTeamState(harness.ctx.cwd)?.milestones).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "MILESTONE-OLD",
					status: "final-verification",
					reviews: [expect.objectContaining({ reviewer: "staff-engineer", verdict: "approve" })],
				}),
			]),
		);

		await command("stop", harness.ctx);
		finishedOwners = 0;
		expectedOwners = 0;
		await command("start Exercise milestone prompt deferral", harness.ctx);

		expect(prematureMilestoneReviews).toBe(0);
		expect(milestoneReviewPrompts).toBe(3);
		expect(loadAnsteelTeamState(harness.ctx.cwd)?.milestones).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "MILESTONE-OLD",
					status: "approved",
					reviews: expect.arrayContaining([
						expect.objectContaining({ reviewer: "staff-engineer", verdict: "approve" }),
						expect.objectContaining({ reviewer: "qa-engineer", verdict: "approve" }),
					]),
				}),
			]),
		);
	});

	it("keeps peer reviews deferred until every parallel owner settles after an infrastructure failure", async () => {
		const config = createConfig();
		config.teamTaskOwners = ["tech-lead", "staff-engineer", "qa-engineer"];
		config.teamTaskMaxEpochs = 1;
		config.teamTaskMaxNoProgressEpochs = 1;
		let releaseStaff: (() => void) | undefined;
		let releaseQa: (() => void) | undefined;
		const staffMayContinue = new Promise<void>((resolve) => {
			releaseStaff = resolve;
		});
		const qaMayContinue = new Promise<void>((resolve) => {
			releaseQa = resolve;
		});
		let finishedOwners = 0;
		let prematureReviewPrompts = 0;
		let staffSubmitted = false;
		let harness: ReturnType<typeof setup>;
		harness = setup(config, async (role, prompt) => {
			const roleOptions = harness.roleSessionOptions.find((entry) => entry.role === role);
			if (!roleOptions) throw new Error(`Missing ${role} options`);
			if (prompt.includes("Execute governed task TASK-ARCHITECTURE")) {
				finishedOwners++;
				return "Tech Lead completed the owner callback.";
			}
			if (prompt.includes("Execute governed task TASK-IMPLEMENTATION")) {
				await staffMayContinue;
				writeFileSync(join(harness.ctx.cwd, "src", "parser.ts"), "export const parser = 'after';\n", "utf8");
				await roleOptions.taskOperations.submitTask("TASK-IMPLEMENTATION", "node --test test/parser.test.mjs");
				staffSubmitted = true;
				finishedOwners++;
				releaseQa?.();
				return "Staff completed the delayed owner callback.";
			}
			if (prompt.includes("Execute governed task TASK-VERIFICATION")) {
				await qaMayContinue;
				finishedOwners++;
				return "QA completed the delayed owner callback.";
			}
			if (prompt.startsWith("You are the independent ")) {
				if (finishedOwners < 3) prematureReviewPrompts++;
				return `${role} observed a review prompt.`;
			}
			return `${role} completed discussion.`;
		});
		initializeGitProject(harness.ctx.cwd);
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		await command("start Exercise parallel infrastructure failure isolation", harness.ctx);
		harness.sendMessage.mockImplementation((message) => {
			if (
				message.customType === "ansteel-team-event" &&
				typeof message.content === "string" &&
				message.content.includes("tech-lead parallel task epoch 1")
			) {
				// Delay the other owners until a reject-fast Promise.all would
				// already have entered its finally block and cleared deferral.
				setTimeout(() => releaseStaff?.(), 0);
				throw new Error("simulated timeline infrastructure failure");
			}
		});

		await expect(
			command(
				`task ${JSON.stringify([
					{
						id: "TASK-ARCHITECTURE",
						owner: "tech-lead",
						type: "architecture",
						files: ["src/architecture.ts"],
						description: "Exercise a failing owner result.",
						acceptanceCriteria: "The batch fails closed.",
						dependsOn: [],
					},
					{
						id: "TASK-IMPLEMENTATION",
						owner: "staff-engineer",
						type: "implementation",
						files: ["src/parser.ts"],
						description: "Submit after the peer owner fails.",
						acceptanceCriteria: "The parser test passes.",
						dependsOn: [],
					},
					{
						id: "TASK-VERIFICATION",
						owner: "qa-engineer",
						type: "verification",
						files: ["test/verification.ts"],
						description: "Remain active while Staff submits.",
						acceptanceCriteria: "No reviewer re-enters this session.",
						dependsOn: [],
					},
				])}`,
				harness.ctx,
			),
		).rejects.toThrow("simulated timeline infrastructure failure");

		expect(staffSubmitted).toBe(true);
		expect(finishedOwners).toBe(3);
		expect(prematureReviewPrompts).toBe(0);
		expect(loadAnsteelTeamState(harness.ctx.cwd)?.tasks).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "TASK-IMPLEMENTATION", status: "final-verification" })]),
		);
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
				'task {"id":"TASK-AUDIT-FAIL","owner":"staff-engineer","type":"implementation","files":["src/parser.ts"],"description":"Exercise owner error handling","acceptanceCriteria":"The command fails closed","dependsOn":[]}',
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
			'task {"id":"TASK-1","owner":"staff-engineer","type":"implementation","files":["src/parser.ts"],"description":"Change parser","acceptanceCriteria":"The parser test passes","dependsOn":[]}',
			harness.ctx,
		);

		expect(taskEpochs).toBe(2);
		expect(harness.prompts.find((prompt) => prompt.includes("Execute governed task TASK-1"))).toContain(
			"Read-only tool budget: 4 calls",
		);
		expect(harness.prompts.find((prompt) => prompt.includes("Execute governed task TASK-1"))).toContain(
			"assumptions (use [] when none)",
		);
		expect(harness.prompts.find((prompt) => prompt.includes("Execute governed task TASK-1"))).toContain(
			"Active task-bound checkpoints eligible for supersession: none",
		);
		expect(harness.prompts.find((prompt) => prompt.includes("Execute governed task TASK-1"))).toContain(
			"Do not spend retries inspecting .pi or .git",
		);
		expect(loadAnsteelTeamState(harness.ctx.cwd)?.tasks[0]).toMatchObject({ id: "TASK-1", status: "claimed" });
		expect(listAnsteelTeamEvents(harness.ctx.cwd).at(-1)).toMatchObject({
			type: "role-failure",
			role: "staff-engineer",
			content: expect.stringContaining("owner-no-progress"),
		});
	});

	it("grants only one collaboration continuation without marking delivery started", async () => {
		const config = createConfig();
		config.teamTaskMaxEpochs = 4;
		config.teamTaskMaxNoProgressEpochs = 1;
		let taskEpochs = 0;
		let harness: ReturnType<typeof setup>;
		harness = setup(config, async (role, prompt) => {
			if (role === "staff-engineer" && prompt.includes("Execute governed task TASK-COLLABORATION")) {
				taskEpochs++;
				const staff = harness.roleSessionOptions.find((entry) => entry.role === role);
				if (!staff) throw new Error("Missing Staff Engineer operations");
				await staff.taskOperations.publishCheckpoint({
					id: `CP-COLLABORATION-${String(taskEpochs).padStart(4, "0")}`,
					taskId: "TASK-COLLABORATION",
					goal: "Refine the governed parser implementation path",
					currentUnderstanding: `Collaboration fact from owner epoch ${taskEpochs}`,
					assumptions: [],
					evidenceRefs: ["file:src/parser.ts"],
					uncertainties: ["No delivery evidence exists yet"],
					nextAction: {
						kind: "read",
						target: "src/parser.ts",
						expectedResult: "The next implementation step is bounded",
					},
					confidence: "L2",
				});
			}
			return `${role} completed its stage.`;
		});
		initializeGitProject(harness.ctx.cwd);
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		await command("start Review the parser", harness.ctx);

		await command(
			'task {"id":"TASK-COLLABORATION","owner":"staff-engineer","type":"implementation","files":["src/parser.ts"],"description":"Change parser","acceptanceCriteria":"The parser test passes","dependsOn":[]}',
			harness.ctx,
		);

		expect(taskEpochs).toBe(2);
		expect(loadAnsteelTeamState(harness.ctx.cwd)?.tasks[0]).toMatchObject({
			id: "TASK-COLLABORATION",
			status: "claimed",
			revision: 0,
			testEvidence: [],
			submissions: [],
			reviews: [],
		});
		expect(listAnsteelTeamEvents(harness.ctx.cwd).filter((event) => event.type === "work-checkpoint")).toHaveLength(
			2,
		);
		expect(listAnsteelTeamEvents(harness.ctx.cwd).at(-1)).toMatchObject({
			type: "role-failure",
			content: expect.stringContaining("owner-no-progress"),
		});
	});

	it("does not declare owner no-progress when a new exact action binding earns both peer approvals", async () => {
		const config = createConfig();
		config.teamTaskMaxEpochs = 4;
		config.teamTaskMaxNoProgressEpochs = 2;
		let taskEpochs = 0;
		let harness: ReturnType<typeof setup>;
		harness = setup(config, async (role, prompt) => {
			const options = harness.roleSessionOptions.find((entry) => entry.role === role);
			if (!options) throw new Error(`Missing ${role} operations`);
			if (role === "staff-engineer" && prompt.includes("Execute governed task TASK-ACTION-UNBLOCK")) {
				taskEpochs++;
				if (taskEpochs <= 3) {
					await options.taskOperations.publishCheckpoint({
						id: `CP-ACTION-UNBLOCK-${String(taskEpochs).padStart(4, "0")}`,
						taskId: "TASK-ACTION-UNBLOCK",
						goal: "Apply the exact parser edit after peer review",
						currentUnderstanding: `Owner epoch ${taskEpochs} is waiting on the immutable action gate`,
						assumptions: [],
						evidenceRefs: ["file:src/parser.ts"],
						uncertainties: [],
						nextAction: { kind: "edit", target: "src/parser.ts", expectedResult: "The parser changes" },
						confidence: "L2",
					});
				} else {
					writeFileSync(join(harness.ctx.cwd, "src", "parser.ts"), "export const parser = 'after';\n", "utf8");
				}
			}
			if (prompt.includes("independent peer reviewer for one immutable governed action binding")) {
				const checkpoint = options.taskOperations.state.workCheckpoints.at(-1);
				if (!checkpoint?.governedAction) throw new Error("Missing action checkpoint");
				if (checkpoint.id.endsWith("0001") || checkpoint.id.endsWith("0003")) {
					await options.taskOperations.reviewAction({
						checkpointId: checkpoint.id,
						action: {
							kind: checkpoint.governedAction.kind,
							target: checkpoint.governedAction.target,
							version: checkpoint.governedAction.version,
						},
						verdict: checkpoint.id.endsWith("0001") && role === "qa-engineer" ? "reject" : "approve",
						reason: "Deterministic peer action review for the progress counter.",
					});
				}
			}
			return `${role} completed its stage.`;
		});
		initializeGitProject(harness.ctx.cwd);
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		await command("start Review the parser", harness.ctx);
		await command(
			'task {"id":"TASK-ACTION-UNBLOCK","owner":"staff-engineer","type":"implementation","files":["src/parser.ts"],"description":"Change parser","acceptanceCriteria":"The parser test passes","dependsOn":[]}',
			harness.ctx,
		);

		expect(taskEpochs).toBe(4);
		expect(listAnsteelTeamEvents(harness.ctx.cwd).some((event) => event.content.includes("owner-no-progress"))).toBe(
			false,
		);
		expect(listAnsteelTeamEvents(harness.ctx.cwd).at(-1)?.content).toContain("task-epoch-limit");
	});

	it("routes a proposed process resolution to its author before action review and final verification", async () => {
		const config = createConfig();
		config.teamTaskMaxEpochs = 4;
		config.teamTaskMaxNoProgressEpochs = 2;
		let taskEpochs = 0;
		const scheduledStages: string[] = [];
		let harness: ReturnType<typeof setup>;
		harness = setup(config, async (role, prompt) => {
			const options = harness.roleSessionOptions.find((entry) => entry.role === role);
			if (!options) throw new Error(`Missing ${role} operations`);

			if (role === "staff-engineer" && prompt.includes("Execute governed task TASK-RESOLUTION-ROUTE")) {
				taskEpochs++;
				if (taskEpochs === 1) {
					await options.taskOperations.publishCheckpoint({
						id: "CP-RESOLUTION-ROUTE-0001",
						taskId: "TASK-RESOLUTION-ROUTE",
						goal: "Apply the parser edit after independent challenge",
						currentUnderstanding: "The first action proposal is ready for peer review",
						assumptions: [],
						evidenceRefs: ["file:src/parser.ts"],
						uncertainties: ["Whether editing must precede action approval"],
						nextAction: { kind: "edit", target: "src/parser.ts", expectedResult: "The parser changes" },
						confidence: "L2",
					});
				} else if (taskEpochs === 2) {
					await options.taskOperations.publishCheckpoint({
						id: "CP-RESOLUTION-ROUTE-0002",
						taskId: "TASK-RESOLUTION-ROUTE",
						goal: "Apply the parser edit after independent challenge",
						currentUnderstanding: "Action approval must precede the governed edit",
						assumptions: [],
						evidenceRefs: ["protocol:pre-action-review"],
						uncertainties: [],
						nextAction: { kind: "edit", target: "src/parser.ts", expectedResult: "The parser changes" },
						confidence: "L1",
						supersedesCheckpointId: "CP-RESOLUTION-ROUTE-0001",
					});
					await options.taskOperations.resolveProcessIssue({
						id: "PR-RESOLUTION-ROUTE-0001",
						issueId: "PI-RESOLUTION-ROUTE-0001",
						outcome: "REFUTED",
						summary:
							"The protocol requires approval before the file edit, so the original ordering concern is inverted.",
						evidenceRefs: ["protocol:pre-action-review"],
					});
				} else if (taskEpochs === 3) {
					writeFileSync(join(harness.ctx.cwd, "src", "parser.ts"), "export const parser = 'after';\n", "utf8");
					await options.taskOperations.submitTask("TASK-RESOLUTION-ROUTE", "node --test test/parser.test.mjs");
				}
				return `Staff completed task epoch ${taskEpochs}.`;
			}

			if (prompt.includes("original author of process issue PI-RESOLUTION-ROUTE-0001")) {
				scheduledStages.push("resolution-review");
				expect(role).toBe("qa-engineer");
				await options.taskOperations.reviewProcessResolution("PI-RESOLUTION-ROUTE-0001", {
					verdict: "accept",
					reason: "The immutable proposal cites the protocol ordering and directly refutes the claim.",
				});
				return "QA accepted the process resolution.";
			}

			if (prompt.includes("independent peer reviewer for one immutable governed action binding")) {
				const checkpoint = options.taskOperations.state.workCheckpoints.at(-1);
				if (!checkpoint?.governedAction) throw new Error("Missing governed action checkpoint");
				scheduledStages.push(`action-review:${checkpoint.id}:${role}`);
				if (checkpoint.id === "CP-RESOLUTION-ROUTE-0001" && role === "qa-engineer") {
					await options.taskOperations.raiseProcessIssue({
						id: "PI-RESOLUTION-ROUTE-0001",
						targetCheckpointId: checkpoint.id,
						severity: "blocking",
						claim: "The file must be edited before the action can be approved.",
						evidenceRefs: ["file:src/parser.ts"],
						suggestedCorrection: "Clarify the required action ordering.",
					});
				}
				await options.taskOperations.reviewAction({
					checkpointId: checkpoint.id,
					action: {
						kind: checkpoint.governedAction.kind,
						target: checkpoint.governedAction.target,
						version: checkpoint.governedAction.version,
					},
					verdict: checkpoint.id === "CP-RESOLUTION-ROUTE-0001" && role === "qa-engineer" ? "reject" : "approve",
					reason: "Deterministic action review for process-resolution routing.",
				});
				return `${role} reviewed ${checkpoint.id}.`;
			}

			if (prompt.startsWith("You are the independent ")) {
				await options.taskOperations.reviewTask("TASK-RESOLUTION-ROUTE", { verdict: "approve" });
				return `${role} approved TASK-RESOLUTION-ROUTE.`;
			}

			return `${role} completed its stage.`;
		});
		initializeGitProject(harness.ctx.cwd);
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		await command("start Review the parser", harness.ctx);
		await command(
			'task {"id":"TASK-RESOLUTION-ROUTE","owner":"staff-engineer","type":"implementation","files":["src/parser.ts"],"description":"Change parser","acceptanceCriteria":"The parser test passes","dependsOn":[]}',
			harness.ctx,
		);

		const state = loadAnsteelTeamState(harness.ctx.cwd);
		expect(taskEpochs).toBe(3);
		expect(state?.processIssues[0]).toMatchObject({ id: "PI-RESOLUTION-ROUTE-0001", status: "closed" });
		expect(state?.tasks[0]).toMatchObject({
			id: "TASK-RESOLUTION-ROUTE",
			status: "approved",
			revision: 1,
		});
		expect(state?.tasks[0].collaborationUpdates).toHaveLength(2);
		expect(state?.tasks[0].reviews).toHaveLength(2);
		expect(scheduledStages.indexOf("resolution-review")).toBeGreaterThan(
			scheduledStages.findIndex((stage) => stage.startsWith("action-review:CP-RESOLUTION-ROUTE-0001")),
		);
		expect(scheduledStages.indexOf("resolution-review")).toBeLessThan(
			scheduledStages.findIndex((stage) => stage.startsWith("action-review:CP-RESOLUTION-ROUTE-0002")),
		);
		expect(
			harness.prompts.find((prompt) => prompt.includes("Execute governed task TASK-RESOLUTION-ROUTE")),
		).toContain("must include taskId exactly TASK-RESOLUTION-ROUTE");
		const taskCollaborationPrompt = harness.prompts.find((prompt) =>
			prompt.includes("continuous collaborator for TASK-RESOLUTION-ROUTE revision 1"),
		);
		expect(taskCollaborationPrompt).toContain("then stop this stage");
		expect(taskCollaborationPrompt).toContain(
			"Do not publish task collaboration or final review after raising that issue",
		);
		expect(taskCollaborationPrompt).toContain("If you do not raise a blocking or critical process issue");
		const actionReviewPrompt = harness.prompts.find((prompt) =>
			prompt.includes("independent peer reviewer for one immutable governed action binding"),
		);
		expect(actionReviewPrompt).toContain("Treat action.version as an opaque coordinator value");
		expect(actionReviewPrompt).toContain("copy every field from the JSON byte-for-byte");
		expect(actionReviewPrompt).toContain("This binding belongs to TASK-RESOLUTION-ROUTE");
		expect(actionReviewPrompt).toContain("During this peer action review, never publish a checkpoint");
		expect(actionReviewPrompt).toContain("only the task owner may create task-bound checkpoints");
	});

	it("rejects task assignment when an advisory cross-examination issue lacks a structured resolution", async () => {
		let harness: ReturnType<typeof setup>;
		harness = setup(createConfig(), async (role, prompt) => {
			const options = harness.roleSessionOptions.find((entry) => entry.role === role);
			if (!options) throw new Error(`Missing ${role} operations`);

			if (role === "tech-lead" && prompt.includes("Investigate this independently.")) {
				await options.taskOperations.publishCheckpoint({
					id: "CP-CROSS-EXAMINATION-UNRESOLVED-0001",
					goal: "Propose a bounded parser review approach",
					currentUnderstanding: "The initial approach needs independent review before task assignment.",
					assumptions: [],
					evidenceRefs: ["file:src/parser.ts"],
					uncertainties: ["Whether the stated verification command is sufficient"],
					nextAction: {
						kind: "report",
						target: "protocol:task-assignment",
						expectedResult: "Peers can challenge the initial approach",
					},
					confidence: "L2",
				});
			}

			if (role === "staff-engineer" && prompt.includes("Cross-examine each peer's public claims.")) {
				await options.taskOperations.raiseProcessIssue({
					id: "PI-CROSS-EXAMINATION-UNRESOLVED-0001",
					targetCheckpointId: "CP-CROSS-EXAMINATION-UNRESOLVED-0001",
					severity: "advisory",
					claim: "The initial approach must identify the acceptance command before assigning implementation work.",
					evidenceRefs: ["file:test/parser.test.mjs"],
					suggestedCorrection: "Publish a replacement checkpoint with the acceptance command.",
				});
			}

			return `${role} completed its stage.`;
		});
		initializeGitProject(harness.ctx.cwd);
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");

		await expect(command("start Review the parser", harness.ctx)).rejects.toThrow(
			"cannot continue while cross-examination process issues remain unresolved",
		);

		const state = loadAnsteelTeamState(harness.ctx.cwd);
		expect(state?.tasks).toHaveLength(0);
		expect(state?.processIssues).toMatchObject([
			{
				id: "PI-CROSS-EXAMINATION-UNRESOLVED-0001",
				status: "open",
				targetRole: "tech-lead",
				resolutions: [],
			},
		]);
		expect(listAnsteelTeamEvents(harness.ctx.cwd)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "role-failure",
					role: "tech-lead",
					content: expect.stringContaining("did not receive a structured resolution proposal"),
				}),
			]),
		);
	});

	it("blocks later task assignment when a taskless advisory issue remains unresolved", async () => {
		let harness: ReturnType<typeof setup>;
		harness = setup(createConfig(), async (role, prompt) => {
			const options = harness.roleSessionOptions.find((entry) => entry.role === role);
			if (!options) throw new Error(`Missing ${role} operations`);

			if (role === "tech-lead" && prompt.includes("Surface a late taskless issue.")) {
				await options.taskOperations.publishCheckpoint({
					id: "CP-LATE-TASKLESS-ISSUE-0001",
					goal: "State the parser acceptance command before assigning new work",
					currentUnderstanding: "A later collaboration round discovered an unreviewed acceptance gap.",
					assumptions: [],
					evidenceRefs: ["file:src/parser.ts"],
					uncertainties: ["Whether the proposed task can be accepted without a named command"],
					nextAction: {
						kind: "report",
						target: "protocol:task-assignment",
						expectedResult: "Peers can challenge the late taskless checkpoint",
					},
					confidence: "L2",
				});
			}

			if (role === "staff-engineer" && prompt.includes("Surface a late taskless issue.")) {
				await options.taskOperations.raiseProcessIssue({
					id: "PI-LATE-TASKLESS-ISSUE-0001",
					targetCheckpointId: "CP-LATE-TASKLESS-ISSUE-0001",
					severity: "advisory",
					claim: "New work must name the acceptance command before the coordinator assigns it.",
					evidenceRefs: ["file:test/parser.test.mjs"],
					suggestedCorrection: "Publish and review a direct replacement checkpoint with the command.",
				});
			}

			return `${role} completed its stage.`;
		});
		initializeGitProject(harness.ctx.cwd);
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");

		await command("start Review the parser", harness.ctx);
		await command("ask Surface a late taskless issue.", harness.ctx);
		await expect(
			command(
				'task {"id":"TASK-LATE-TASKLESS-ISSUE","owner":"staff-engineer","type":"implementation","files":["src/parser.ts"],"description":"Change parser","acceptanceCriteria":"The parser test passes","dependsOn":[]}',
				harness.ctx,
			),
		).rejects.toThrow("cannot continue while taskless process issues remain unresolved");

		const state = loadAnsteelTeamState(harness.ctx.cwd);
		expect(state?.tasks).toHaveLength(0);
		expect(state?.processIssues).toMatchObject([
			{
				id: "PI-LATE-TASKLESS-ISSUE-0001",
				status: "open",
				targetRole: "tech-lead",
				resolutions: [],
			},
		]);
		expect(harness.prompts).toEqual(
			expect.arrayContaining([
				expect.stringContaining("target role for open process issue PI-LATE-TASKLESS-ISSUE-0001"),
			]),
		);
	});

	it("settles an advisory cross-examination issue before accepting task assignments", async () => {
		let harness: ReturnType<typeof setup>;
		harness = setup(createConfig(), async (role, prompt) => {
			const options = harness.roleSessionOptions.find((entry) => entry.role === role);
			if (!options) throw new Error(`Missing ${role} operations`);

			if (role === "tech-lead" && prompt.includes("Investigate this independently.")) {
				await options.taskOperations.publishCheckpoint({
					id: "CP-CROSS-EXAMINATION-0001",
					goal: "Propose a bounded parser review approach",
					currentUnderstanding: "The initial approach needs independent review before task assignment.",
					assumptions: [],
					evidenceRefs: ["file:src/parser.ts"],
					uncertainties: ["Whether the stated verification command is sufficient"],
					nextAction: {
						kind: "report",
						target: "protocol:task-assignment",
						expectedResult: "Peers can challenge the initial approach",
					},
					confidence: "L2",
				});
			}

			if (role === "staff-engineer" && prompt.includes("Cross-examine each peer's public claims.")) {
				await options.taskOperations.raiseProcessIssue({
					id: "PI-CROSS-EXAMINATION-0001",
					targetCheckpointId: "CP-CROSS-EXAMINATION-0001",
					severity: "advisory",
					claim: "The initial approach must identify the acceptance command before assigning implementation work.",
					evidenceRefs: ["file:test/parser.test.mjs"],
					suggestedCorrection: "Publish a replacement checkpoint with the acceptance command.",
				});
			}

			if (role === "tech-lead" && prompt.includes("target role for open process issue PI-CROSS-EXAMINATION-0001")) {
				await options.taskOperations.publishCheckpoint({
					id: "CP-CROSS-EXAMINATION-0002",
					goal: "State the parser acceptance command before task assignment",
					currentUnderstanding: "The acceptance command is node --test test/parser.test.mjs.",
					assumptions: [],
					evidenceRefs: ["file:test/parser.test.mjs"],
					uncertainties: [],
					nextAction: {
						kind: "report",
						target: "protocol:task-assignment",
						expectedResult: "The acceptance command is independently reviewable",
					},
					confidence: "L1",
					supersedesCheckpointId: "CP-CROSS-EXAMINATION-0001",
				});
				await options.taskOperations.resolveProcessIssue({
					id: "PR-CROSS-EXAMINATION-0001",
					issueId: "PI-CROSS-EXAMINATION-0001",
					outcome: "ACCEPTED",
					summary: "The replacement checkpoint names the immutable parser acceptance command.",
					evidenceRefs: ["file:test/parser.test.mjs"],
					replacementCheckpointId: "CP-CROSS-EXAMINATION-0002",
				});
			}

			if (
				role === "staff-engineer" &&
				prompt.includes("original author of process issue PI-CROSS-EXAMINATION-0001")
			) {
				await options.taskOperations.reviewProcessResolution("PI-CROSS-EXAMINATION-0001", {
					verdict: "accept",
					reason: "The replacement checkpoint supplies the requested acceptance command.",
				});
			}

			return `${role} completed its stage.`;
		});
		initializeGitProject(harness.ctx.cwd);
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		await command("start Review the parser", harness.ctx);

		const state = loadAnsteelTeamState(harness.ctx.cwd);
		expect(state?.tasks).toHaveLength(0);
		expect(state?.processIssues).toMatchObject([
			{
				id: "PI-CROSS-EXAMINATION-0001",
				status: "closed",
				resolutions: [
					{
						id: "PR-CROSS-EXAMINATION-0001",
						review: { reviewer: "staff-engineer", verdict: "accept" },
					},
				],
			},
		]);
		expect(harness.prompts).toEqual(
			expect.arrayContaining([
				expect.stringContaining("target role for open process issue PI-CROSS-EXAMINATION-0001"),
				expect.stringContaining("original author of process issue PI-CROSS-EXAMINATION-0001"),
			]),
		);
	});

	it("never lets collaboration continuation bypass the task epoch ceiling", async () => {
		const config = createConfig();
		config.teamTaskMaxEpochs = 1;
		config.teamTaskMaxNoProgressEpochs = 1;
		let harness: ReturnType<typeof setup>;
		harness = setup(config, async (role, prompt) => {
			if (role === "staff-engineer" && prompt.includes("Execute governed task TASK-COLLABORATION")) {
				const staff = harness.roleSessionOptions.find((entry) => entry.role === role);
				if (!staff) throw new Error("Missing Staff Engineer operations");
				await staff.taskOperations.publishCheckpoint({
					id: "CP-COLLABORATION-CEILING",
					taskId: "TASK-COLLABORATION",
					goal: "Exercise the immutable epoch ceiling",
					currentUnderstanding: "Collaboration exists without delivery",
					assumptions: [],
					evidenceRefs: ["file:src/parser.ts"],
					uncertainties: ["The implementation has not started"],
					nextAction: {
						kind: "read",
						target: "src/parser.ts",
						expectedResult: "The next step remains visible",
					},
					confidence: "L2",
				});
			}
			return `${role} completed its stage.`;
		});
		initializeGitProject(harness.ctx.cwd);
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		await command("start Review the parser", harness.ctx);

		await command(
			'task {"id":"TASK-COLLABORATION","owner":"staff-engineer","type":"implementation","files":["src/parser.ts"],"description":"Change parser","acceptanceCriteria":"The parser test passes","dependsOn":[]}',
			harness.ctx,
		);

		expect(listAnsteelTeamEvents(harness.ctx.cwd).at(-1)).toMatchObject({
			type: "role-failure",
			content: expect.stringContaining("task-epoch-limit"),
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
			'task {"id":"TASK-1","owner":"staff-engineer","type":"implementation","files":["src/parser.ts"],"description":"Change parser","acceptanceCriteria":"The parser test passes","dependsOn":[]}',
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
				'task {"id":"TASK-TL","owner":"tech-lead","type":"architecture","files":["src/parser.ts"],"description":"Change parser","acceptanceCriteria":"Pass","dependsOn":[]}',
				harness.ctx,
			),
		).rejects.toThrow("not authorized");
		await expect(command("task TASK-UNKNOWN", harness.ctx)).rejects.toThrow("does not exist");
		expect(ownerEpochs).toBe(0);
		expect(loadAnsteelTeamState(harness.ctx.cwd)?.tasks).toHaveLength(0);

		await command(
			'task {"id":"TASK-OK","owner":"staff-engineer","type":"implementation","files":["src/parser.ts"],"description":"Change parser","acceptanceCriteria":"Pass","dependsOn":[]}',
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

	it("refreshes active task state after failed delivery verification so the next revision can resume", async () => {
		const config = createConfig();
		config.teamTaskMaxEpochs = 2;
		config.teamTaskMaxNoProgressEpochs = 2;
		let ownerEpochs = 0;
		let harness: ReturnType<typeof setup>;
		harness = setup(config, async (role, prompt) => {
			const roleOptions = harness.roleSessionOptions.find((entry) => entry.role === role);
			if (!roleOptions) throw new Error(`Missing ${role} options`);
			if (prompt.startsWith("You are the independent ") && prompt.includes("TASK-VERIFY-RECOVERY revision")) {
				await roleOptions.taskOperations.reviewTask("TASK-VERIFY-RECOVERY", { verdict: "approve" });
				return `${role} approved the current recovery revision.`;
			}
			if (role === "staff-engineer" && prompt.includes("Execute governed task TASK-VERIFY-RECOVERY")) {
				ownerEpochs++;
				if (ownerEpochs === 1) {
					writeFileSync(join(harness.ctx.cwd, "src", "parser.ts"), "export const parser = 'after';\n", "utf8");
				}
				await roleOptions.taskOperations.submitTask("TASK-VERIFY-RECOVERY", "node --test test/parser.test.mjs");
				return `Staff submitted recovery revision ${ownerEpochs}.`;
			}
			return `${role} completed discussion.`;
		});
		initializeGitProject(harness.ctx.cwd);
		const command = harness.commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");
		await command("start Exercise delivery failure recovery", harness.ctx);
		await command(
			'task {"id":"TASK-VERIFY-RECOVERY","owner":"staff-engineer","type":"implementation","files":["src/parser.ts"],"description":"Recover after a failed external delivery check","acceptanceCriteria":"The current revision passes parser tests and independent delivery verification","dependsOn":[]}',
			harness.ctx,
		);
		expect(loadAnsteelTeamState(harness.ctx.cwd)?.tasks[0]).toMatchObject({ status: "approved", revision: 1 });

		await expect(
			command(
				`verify TASK-VERIFY-RECOVERY "${createDeliveryManifest("TASK-VERIFY-RECOVERY", 1, "process.exit(7)")}"`,
				harness.ctx,
			),
		).rejects.toThrow("check-failed");
		expect(loadAnsteelTeamState(harness.ctx.cwd)?.tasks[0]).toMatchObject({
			status: "revision-required",
			revision: 1,
		});

		await command("task TASK-VERIFY-RECOVERY", harness.ctx);
		const recovered = loadAnsteelTeamState(harness.ctx.cwd);
		expect(ownerEpochs).toBe(2);
		expect(recovered?.tasks[0]).toMatchObject({ status: "approved", revision: 2 });
		expect(recovered?.tasks[0]?.submissions).toHaveLength(2);
		expect(recovered?.deliveryVerifications).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ taskId: "TASK-VERIFY-RECOVERY", revision: 1, status: "failed" }),
			]),
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
			'task {"id":"TASK-1","owner":"staff-engineer","type":"implementation","files":["src/parser.ts"],"description":"Change parser","acceptanceCriteria":"The parser test passes","dependsOn":[]}',
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
