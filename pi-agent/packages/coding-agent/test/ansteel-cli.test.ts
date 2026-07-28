import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const temporaryDirectories: string[] = [];

const COMPLETE_WORK_CARD = [
	"## Conclusion",
	"[L2] The implementation is ready for review.",
	"## Evidence",
	"[L1] Deterministic provider response.",
	"## Assumptions and Unknowns",
	"[L3] Production-provider behavior remains outside this test.",
	"## Alternatives and Trade-offs",
	"[L2] A live provider would add non-determinism.",
	"## Self-Refutation Conditions",
	"[L3] Re-run against a configured external provider.",
	"## Questions for Peers",
	"[L2] No further questions.",
].join("\n");

const COMPLETE_REVISION_WORK_CARD = [
	COMPLETE_WORK_CARD,
	"## Challenge Responses",
	"[L2] The resolution is supported by the cited evidence and retains the stated residual risk.",
	"## Recommended Actions",
	"[L2] Staff Engineer verifies the change within the claimed scope using the stated acceptance criterion.",
].join("\n");

const DETERMINISTIC_PROVIDER_EXTENSION = `
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

const completeWorkCard = ${JSON.stringify(COMPLETE_WORK_CARD)};
const completeRevisionWorkCard = ${JSON.stringify(COMPLETE_REVISION_WORK_CARD)};

function register(pi, provider, model, responses) {
	const faux = fauxProvider({ provider, models: [{ id: model }] });
	faux.setResponses(responses.map((response) => fauxAssistantMessage(response)));
	pi.registerProvider(faux.provider);
}

export default function (pi) {
	register(pi, "deterministic-tech", "tech", [
		completeWorkCard,
		"ISSUE: TL-1 | TARGET: staff-engineer\\nNO ISSUES | TARGET: qa-engineer",
		"RESOLUTION: STAFF-1 | RESOLVED\\nRESOLUTION: QA-1 | RESOLVED\\n\\n" + completeRevisionWorkCard,
		"VERDICT: APPROVE",
		"[L1] Consensus\\nAll 2 ledger entries are resolved.",
	]);
	register(pi, "deterministic-staff", "staff", [
		completeWorkCard,
		"ISSUE: STAFF-1 | TARGET: tech-lead\\nNO ISSUES | TARGET: qa-engineer",
		"RESOLUTION: TL-1 | RESOLVED\\n\\n" + completeRevisionWorkCard,
		"VERDICT: APPROVE",
	]);
	register(pi, "deterministic-qa", "qa", [
		completeWorkCard,
		"ISSUE: QA-1 | TARGET: tech-lead\\nNO ISSUES | TARGET: staff-engineer",
		completeRevisionWorkCard,
		"VERDICT: APPROVE",
	]);
}
`;

const SUPERVISED_PROVIDER_EXTENSION = `
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

const completeWorkCard = ${JSON.stringify(COMPLETE_WORK_CARD)};
const completeRevisionWorkCard = ${JSON.stringify(COMPLETE_REVISION_WORK_CARD)};

function delayed(message) {
	return async () => {
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		return fauxAssistantMessage(message);
	};
}

function register(pi, provider, model, responses) {
	const faux = fauxProvider({ provider, models: [{ id: model }] });
	faux.setResponses(responses.map((response) => typeof response === "function" ? response : fauxAssistantMessage(response)));
	pi.registerProvider(faux.provider);
}

export default function (pi) {
	const isResume = process.argv.includes("--ansteel-resume");
	if (!isResume) {
		register(pi, "supervised-tech", "tech", [delayed(completeWorkCard)]);
		register(pi, "supervised-staff", "staff", []);
		register(pi, "supervised-qa", "qa", []);
		return;
	}
	register(pi, "supervised-tech", "tech", [
		"ISSUE: TL-1 | TARGET: staff-engineer\\nNO ISSUES | TARGET: qa-engineer",
		"RESOLUTION: STAFF-1 | RESOLVED\\nRESOLUTION: QA-1 | RESOLVED\\n\\n" + completeRevisionWorkCard,
		"VERDICT: APPROVE",
		"[L1] Consensus\\nThe coordinator-derived immutable ledger summary is the authoritative resolution record.",
	]);
	register(pi, "supervised-staff", "staff", [
		completeWorkCard,
		"ISSUE: STAFF-1 | TARGET: tech-lead\\nNO ISSUES | TARGET: qa-engineer",
		"RESOLUTION: TL-1 | RESOLVED\\n\\n" + completeRevisionWorkCard,
		"VERDICT: APPROVE",
		"VERDICT: APPROVE",
	]);
	register(pi, "supervised-qa", "qa", [
		completeWorkCard,
		"ISSUE: QA-1 | TARGET: tech-lead\\nNO ISSUES | TARGET: staff-engineer",
		completeRevisionWorkCard,
		"VERDICT: APPROVE",
		"VERDICT: APPROVE",
	]);
}
`;

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createTemporaryProject(): { agentDir: string; projectDir: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-ansteel-cli-"));
	temporaryDirectories.push(root);
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	const extensionsDir = join(projectDir, ".pi", "extensions");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(extensionsDir, { recursive: true });
	writeFileSync(join(extensionsDir, "deterministic-ansteel.ts"), DETERMINISTIC_PROVIDER_EXTENSION, "utf8");
	writeFileSync(
		join(projectDir, ".pi", "ansteel.json"),
		JSON.stringify(
			{
				reportDirectory: ".pi/ansteel-reports",
				stageTimeoutMs: 5_000,
				maxToolCallsPerStage: 1,
				roles: {
					"tech-lead": { model: "deterministic-tech/tech", tools: [] },
					"staff-engineer": { model: "deterministic-staff/staff", tools: [] },
					"qa-engineer": { model: "deterministic-qa/qa", tools: [] },
				},
			},
			null,
			2,
		),
		"utf8",
	);
	return { agentDir, projectDir };
}

function createSupervisedTemporaryProject(): { agentDir: string; projectDir: string } {
	const { agentDir, projectDir } = createTemporaryProject();
	const extensionsDir = join(projectDir, ".pi", "extensions");
	writeFileSync(join(extensionsDir, "supervised-ansteel.ts"), SUPERVISED_PROVIDER_EXTENSION, "utf8");
	writeFileSync(
		join(projectDir, ".pi", "ansteel.json"),
		JSON.stringify(
			{
				reportDirectory: ".pi/ansteel-reports",
				stageTimeoutMs: 5_000,
				maxToolCallsPerStage: 1,
				adaptiveBudgetPolicy: {
					enabled: true,
					epochTimeoutMs: 1_000,
					projectTimeoutMs: 30_000,
					maxProjectToolCalls: 20,
					protectedVerificationTimeMs: 100,
					protectedVerificationToolCalls: 10,
				},
				roles: {
					"tech-lead": { model: "supervised-tech/tech", tools: [] },
					"staff-engineer": { model: "supervised-staff/staff", tools: [] },
					"qa-engineer": { model: "supervised-qa/qa", tools: [] },
				},
			},
			null,
			2,
		),
		"utf8",
	);
	return { agentDir, projectDir };
}

function configureGitRootEvidence(projectDir: string): void {
	const reviewRoot = resolve(projectDir, "..");
	mkdirSync(join(reviewRoot, ".git"));
	mkdirSync(join(reviewRoot, ".github", "workflows"), { recursive: true });
	mkdirSync(join(projectDir, "docs"), { recursive: true });
	writeFileSync(join(reviewRoot, ".github", "workflows", "ansteel-delivery.yml"), "name: delivery\n", "utf8");
	writeFileSync(join(projectDir, "docs", "ansteel-acceptance.md"), "# Acceptance\n", "utf8");
	writeFileSync(
		join(projectDir, ".pi", "ansteel.json"),
		JSON.stringify(
			{
				reportDirectory: ".pi/ansteel-reports",
				reviewRoot: "git-root",
				requiredEvidencePaths: [
					".github/workflows/ansteel-delivery.yml",
					"project/docs/ansteel-acceptance.md",
					"project/.pi/ansteel.json",
				],
				stageTimeoutMs: 5_000,
				maxToolCallsPerStage: 1,
				roles: {
					"tech-lead": { model: "deterministic-tech/tech", tools: [] },
					"staff-engineer": { model: "deterministic-staff/staff", tools: [] },
					"qa-engineer": { model: "deterministic-qa/qa", tools: [] },
				},
			},
			null,
			2,
		),
		"utf8",
	);
}

async function runCli(
	projectDir: string,
	agentDir: string,
	args = ["--ansteel", "Reject a hallucinated ledger total"],
	extensionName = "deterministic-ansteel.ts",
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return await new Promise((resolvePromise, reject) => {
		const child = spawn(
			process.execPath,
			[
				cliPath,
				"-e",
				join(projectDir, ".pi", "extensions", extensionName),
				...args,
			],
			{
				cwd: projectDir,
				env: {
					...process.env,
					[ENV_AGENT_DIR]: agentDir,
					TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			resolvePromise({ code, stdout, stderr });
		});
	});
}

describe("Ansteel CLI", () => {
	it("rejects a deterministic provider consensus that manually states a ledger count and archives invalid-ledger-summary", async () => {
		const { agentDir, projectDir } = createTemporaryProject();

		const result = await runCli(projectDir, agentDir);

		expect(result.code).toBe(1);
		expect(result.stderr).not.toContain("No more faux responses queued");
		const reportMatch = /Ansteel review rejected: (.+)\r?\n?$/.exec(result.stdout);
		expect(reportMatch?.[1]).toBeDefined();
		const reportPath = reportMatch?.[1];
		if (!reportPath) throw new Error(`Could not find Ansteel report path in CLI output: ${result.stdout}`);
		expect(existsSync(reportPath)).toBe(true);
		const report = readFileSync(reportPath, "utf8");
		expect(report).toContain("- Termination reason: invalid-ledger-summary");
		expect(report).toContain("tech-lead / consensus manually stated a ledger count (2 ledger entries)");
		expect(report).toContain("- Total recorded challenges: 3");
		expect(report).toContain("Configured/resolved role identities:");
		expect(report).toContain("Diversity status: UNVERIFIED.");
	}, 20_000);

	it("runs from a child directory while retaining declared Git-root evidence in the archived CLI report", async () => {
		const { agentDir, projectDir } = createTemporaryProject();
		configureGitRootEvidence(projectDir);

		const result = await runCli(projectDir, agentDir);

		expect(result.code).toBe(1);
		const reportMatch = /Ansteel review rejected: (.+)\r?\n?$/.exec(result.stdout);
		const reportPath = reportMatch?.[1];
		if (!reportPath) throw new Error(`Could not find Ansteel report path in CLI output: ${result.stdout}`);
		const report = readFileSync(reportPath, "utf8");
		expect(report).toContain("Tool path rule: every manifest path is relative to the review root");
		expect(report).toContain(".github/workflows/ansteel-delivery.yml | bytes=");
		expect(report).toContain("project/docs/ansteel-acceptance.md | bytes=");
		expect(report).toContain("project/.pi/ansteel.json | bytes=");
	}, 20_000);

	it("automatically resumes an epoch through a second real Ansteel CLI child", async () => {
		const { agentDir, projectDir } = createSupervisedTemporaryProject();

		const result = await runCli(
			projectDir,
			agentDir,
			["--ansteel-supervise", "Complete two epochs", "--ansteel-supervise-max-epochs", "4"],
			"supervised-ansteel.ts",
		);

		expect(result.code, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
		expect(result.stdout).toContain("Ansteel review paused:");
		expect(result.stdout).toContain("Ansteel review approved:");
		expect(readdirSync(join(projectDir, ".pi", "ansteel-runs"))).toHaveLength(1);
		expect(existsSync(join(projectDir, ".pi", "ansteel-supervisor.lock"))).toBe(false);
	}, 30_000);
});
