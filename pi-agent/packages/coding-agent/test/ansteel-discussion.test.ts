import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ANSTEEL_ROLES,
	type AnsteelConfig,
	type AnsteelDiscussionStage,
	AnsteelGovernanceSetupError,
	type AnsteelRole,
	createAnsteelEvidencePackage,
	createAnsteelProjectToolBudget,
	createAnsteelRawTurnSession,
	createAnsteelReviewToolPolicy,
	createAnsteelRunCheckpoint,
	createAnsteelSetupFailureMarkdown,
	createAnsteelStageBudgetPolicy,
	createAnsteelToolBudget,
	getAnsteelReviewExitCode,
	getAnsteelRunCheckpointPath,
	loadAnsteelConfig,
	loadAnsteelRunCheckpoint,
	resolveAnsteelReviewRoot,
	runAnsteelDiscussion,
	runAnsteelProjectReview,
	shouldExtendRevisionRounds,
	updateAnsteelRunCheckpoint,
	validateAnsteelRunCheckpointForResume,
	writeAnsteelReport,
} from "../src/core/ansteel-discussion.ts";
import { getAnsteelModelBoundary } from "../src/main.ts";

type RawTurnMessage = {
	role: string;
	content?: Array<{ type: string; text?: string }>;
	stopReason?: string;
	errorMessage?: string;
};

type RawTurnSessionSource = {
	readonly messages: readonly RawTurnMessage[];
	prompt: (text: string) => Promise<void>;
	reset?: () => void | Promise<void>;
	subscribeToAssistantMessageEnd: (listener: (message: unknown) => void) => () => void;
	subscribeToAgentEvent?: (listener: (event: unknown) => void) => () => void;
	abort?: () => void | Promise<void>;
	dispose: () => void | Promise<void>;
};

function createAssistantMessageEmitter(): {
	emit: (message: RawTurnMessage) => void;
	subscribe: (listener: (message: unknown) => void) => () => void;
} {
	const listeners = new Set<(message: unknown) => void>();
	return {
		emit: (message) => {
			for (const listener of listeners) listener(message);
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

function createAgentEventEmitter(): {
	emit: (event: unknown) => void;
	subscribe: (listener: (event: unknown) => void) => () => void;
} {
	const listeners = new Set<(event: unknown) => void>();
	return {
		emit: (event) => {
			for (const listener of listeners) listener(event);
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

function getLegacyCopyText(messages: readonly RawTurnMessage[]): string | undefined {
	const lastAssistant = messages
		.slice()
		.reverse()
		.find((message) => {
			if (message.role !== "assistant") return false;
			return !(message.stopReason === "aborted" && !message.content?.length);
		});
	if (!lastAssistant) return undefined;

	const text = (lastAssistant.content ?? [])
		.filter((content) => content.type === "text")
		.map((content) => content.text ?? "")
		.join("");
	return text.trim() || undefined;
}

const MUTUAL_REVIEW_STAGE_ORDER: Array<{ role: AnsteelRole; stage: AnsteelDiscussionStage }> = [
	{ role: "tech-lead", stage: "architecture" },
	{ role: "staff-engineer", stage: "staff-critique" },
	{ role: "qa-engineer", stage: "qa-critique" },
	{ role: "tech-lead", stage: "tech-lead-cross-examination" },
	{ role: "staff-engineer", stage: "staff-cross-examination" },
	{ role: "qa-engineer", stage: "qa-cross-examination" },
	{ role: "tech-lead", stage: "architecture-revision" },
	{ role: "staff-engineer", stage: "staff-revision" },
	{ role: "qa-engineer", stage: "qa-revision" },
	{ role: "tech-lead", stage: "tech-lead-verification" },
	{ role: "staff-engineer", stage: "staff-verification" },
	{ role: "qa-engineer", stage: "qa-verification" },
	{ role: "tech-lead", stage: "consensus" },
	{ role: "staff-engineer", stage: "staff-sign-off" },
	{ role: "qa-engineer", stage: "qa-sign-off" },
];

const COMPLETE_WORK_CARD = [
	"## Conclusion\n[L2] The proposed work card is ready for peer review.",
	"## Evidence\n[L2] Current project evidence was reviewed.",
	"## Assumptions and Unknowns\n[L3] Remaining uncertainty has a verification path.",
	"## Alternatives and Trade-offs\n[L2] The selected approach has stated trade-offs.",
	"## Self-Refutation Conditions\n[L3] Contradictory evidence would invalidate this work card.",
	"## Questions for Peers\n[L2] Review the stated evidence and trade-offs.",
].join("\n\n");

const COMPLETE_REVISION_WORK_CARD = [
	COMPLETE_WORK_CARD,
	"## Challenge Responses\n[L2] Each resolved challenge is explained with its evidence and remaining risk.",
	"## Recommended Actions\n[L2] Assign the next verification task with a scope and acceptance criterion.",
].join("\n\n");

const INCOMPLETE_WORK_CARD = COMPLETE_WORK_CARD.split("\n\n")
	.filter((section) => !section.startsWith("## Self-Refutation Conditions"))
	.join("\n\n");
const INCOMPLETE_REVISION_WORK_CARD = COMPLETE_REVISION_WORK_CARD.split("\n\n")
	.filter((section) => !section.startsWith("## Recommended Actions"))
	.join("\n\n");

function completeWorkCard(response: string): string {
	return `${response}\n\n${COMPLETE_REVISION_WORK_CARD}`;
}

const MUTUAL_REVIEW_RESPONSES: Record<AnsteelDiscussionStage, string> = {
	architecture: `[L2] Tech Lead work card\n\n${COMPLETE_WORK_CARD}`,
	"staff-critique": `[L2] Staff Engineer work card\n\n${COMPLETE_WORK_CARD}`,
	"qa-critique": `[L2] QA Engineer work card\n\n${COMPLETE_WORK_CARD}`,
	"tech-lead-cross-examination":
		"ISSUE: TL-CROSS | TARGET: staff-engineer\nNO ISSUES | TARGET: qa-engineer\n[L2] Challenge the implementation trade-off.",
	"staff-cross-examination":
		"ISSUE: STAFF-CROSS | TARGET: qa-engineer\nNO ISSUES | TARGET: tech-lead\n[L2] Challenge the test strategy.",
	"qa-cross-examination":
		"ISSUE: QA-CROSS | TARGET: tech-lead\nNO ISSUES | TARGET: staff-engineer\n[L2] Challenge the evidence boundary.",
	"architecture-revision": `RESOLUTION: QA-CROSS | RESOLVED\n[L2] Tech Lead revised work card\n\n${COMPLETE_REVISION_WORK_CARD}`,
	"staff-revision": `RESOLUTION: TL-CROSS | RESOLVED\n[L2] Staff revised work card\n\n${COMPLETE_REVISION_WORK_CARD}`,
	"qa-revision": `RESOLUTION: STAFF-CROSS | RESOLVED\n[L2] QA revised work card\n\n${COMPLETE_REVISION_WORK_CARD}`,
	"tech-lead-verification": "VERDICT: APPROVE",
	"staff-verification": "VERDICT: APPROVE",
	"qa-verification": "VERDICT: APPROVE",
	consensus:
		"[L1] Immutable consensus\n<verification-method>\nL1 confirmed by an independent numerical check.\n</verification-method>",
	"staff-sign-off": "VERDICT: APPROVE",
	"qa-sign-off": "VERDICT: APPROVE",
};

function getStageFromPrompt(prompt: string): AnsteelDiscussionStage {
	const match = /Current stage: ([a-z-]+)\./.exec(prompt);
	if (!match || !(match[1] in MUTUAL_REVIEW_RESPONSES)) {
		throw new Error(`Could not determine Ansteel stage from prompt: ${prompt}`);
	}
	return match[1] as AnsteelDiscussionStage;
}

function responseForMutualReviewStage(
	stage: AnsteelDiscussionStage,
	overrides: Partial<Record<AnsteelDiscussionStage, string>> = {},
): string {
	return overrides[stage] ?? MUTUAL_REVIEW_RESPONSES[stage];
}

const temporaryDirectories: string[] = [];

afterEach(() => {
	while (temporaryDirectories.length > 0) {
		const directory = temporaryDirectories.pop();
		if (directory) rmSync(directory, { recursive: true, force: true });
	}
});

describe("runAnsteelDiscussion", () => {
	it("reports configured identities without claiming verified backend diversity", () => {
		expect(getAnsteelModelBoundary(true)).toBe(
			"Diversity status: SINGLE_MODEL_CONFIGURED. Role sessions may share the same configured model, so this review is not cross-model verification; evidence verification remains required.",
		);
		expect(getAnsteelModelBoundary(false)).toBe(
			"Diversity status: UNVERIFIED. Pi resolved three distinct configured role identities, but this does not prove that the backend models, provider endpoints, or providers are actually distinct. Evidence verification remains required.",
		);
	});

	it("emits a visible start and completion event for every completed stage", async () => {
		const progress: string[] = [];

		const result = await runAnsteelDiscussion({
			topic: "Review visible discussion progress",
			onStageEvent: ({ type, role, stage }) => {
				progress.push(`${type}:${role}/${stage}`);
			},
			runRole: async ({ stage }) => responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("approved");
		// Independent stages start in parallel: all started events of a group
		// are emitted first (role order), then all completed events (commit order).
		expect(progress).toEqual([
			"started:tech-lead/architecture",
			"completed:tech-lead/architecture",
			"started:staff-engineer/staff-critique",
			"started:qa-engineer/qa-critique",
			"completed:staff-engineer/staff-critique",
			"completed:qa-engineer/qa-critique",
			"started:tech-lead/tech-lead-cross-examination",
			"started:staff-engineer/staff-cross-examination",
			"started:qa-engineer/qa-cross-examination",
			"completed:tech-lead/tech-lead-cross-examination",
			"completed:staff-engineer/staff-cross-examination",
			"completed:qa-engineer/qa-cross-examination",
			"started:tech-lead/architecture-revision",
			"completed:tech-lead/architecture-revision",
			"started:staff-engineer/staff-revision",
			"completed:staff-engineer/staff-revision",
			"started:qa-engineer/qa-revision",
			"completed:qa-engineer/qa-revision",
			"started:tech-lead/tech-lead-verification",
			"started:staff-engineer/staff-verification",
			"started:qa-engineer/qa-verification",
			"completed:tech-lead/tech-lead-verification",
			"completed:staff-engineer/staff-verification",
			"completed:qa-engineer/qa-verification",
			"started:tech-lead/consensus",
			"completed:tech-lead/consensus",
			"started:staff-engineer/staff-sign-off",
			"started:qa-engineer/qa-sign-off",
			"completed:staff-engineer/staff-sign-off",
			"completed:qa-engineer/qa-sign-off",
		]);
	});

	it("replays a committed transcript entry without calling the completed role stage again", async () => {
		const calls: AnsteelDiscussionStage[] = [];
		const result = await runAnsteelDiscussion({
			topic: "Resume a committed architecture work card",
			initialState: {
				transcript: [
					{
						role: "tech-lead",
						stage: "architecture",
						prompt: "persisted coordinator prompt",
						response: responseForMutualReviewStage("architecture"),
					},
				],
			},
			runRole: async ({ stage }) => {
				calls.push(stage);
				return responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("approved");
		expect(calls).not.toContain("architecture");
		expect(result.transcript.filter((entry) => entry.stage === "architecture")).toHaveLength(1);
	});

	it("renders coordinator-derived adaptive budget decisions before the transcript", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review adaptive budget report integrity",
			adaptiveBudgetEvents: [
				{
					role: "tech-lead",
					stage: "architecture-revision",
					action: "grant-time",
					granted: { timeMs: 30_000 },
					evidenceProgressCount: 1,
					unresolvedChallengeCount: 2,
					remainingProjectTimeMs: 600_000,
					remainingProjectToolCalls: 40,
					reason: "New evidence supports unresolved governance work.",
				},
			],
			runRole: async ({ stage }) => responseForMutualReviewStage(stage),
		});

		expect(result.markdown).toContain("## Adaptive Budget Ledger");
		expect(result.markdown).toContain("grant-time; granted-time=30000ms");
		expect(result.markdown.indexOf("## Adaptive Budget Ledger")).toBeLessThan(
			result.markdown.indexOf("## Full Transcript"),
		);
	});

	it("asks each role for a concise response so later roles can consume the full transcript", async () => {
		let firstPrompt = "";

		await runAnsteelDiscussion({
			topic: "Review concise discussion prompts",
			runRole: async ({ prompt }) => {
				firstPrompt = prompt;
				return "";
			},
		});

		expect(firstPrompt).toContain(
			"Response limit: keep the response within 800 tokens unless code or evidence requires more.",
		);
	});

	it("gives every initial work-card stage an exact heading and marker discipline", async () => {
		const prompts = new Map<AnsteelDiscussionStage, string>();

		const result = await runAnsteelDiscussion({
			topic: "Review work-card prompt compliance",
			runRole: async ({ stage, prompt }) => {
				prompts.set(stage, prompt);
				return responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict, result.markdown).toBe("approved");
		for (const stage of ["architecture", "staff-critique", "qa-critique"] as const) {
			const prompt = prompts.get(stage) ?? "";
			expect(prompt).toContain("Begin the response with exactly `## Conclusion`.");
			expect(prompt).toContain(
				"Include each exact heading once with nonempty content: `## Conclusion`, `## Evidence`, `## Assumptions and Unknowns`, `## Alternatives and Trade-offs`, `## Self-Refutation Conditions`, and `## Questions for Peers`.",
			);
			expect(prompt).toContain(
				"Do not emit `VERDICT`, `ISSUE`, `NO ISSUES`, or `RESOLUTION` markers in this initial work-card stage.",
			);
		}
	});

	it("gives every revision stage an exact resolution-before-work-card contract", async () => {
		const prompts = new Map<AnsteelDiscussionStage, string>();
		const assignedTechLeadIds = ["STAFF-1", "STAFF-2", "STAFF-3", "QA-1", "QA-2", "QA-3", "QA-4"];

		const result = await runAnsteelDiscussion({
			topic: "Review a complete Tech Lead resolution ledger",
			runRole: async ({ stage, prompt }) => {
				prompts.set(stage, prompt);
				switch (stage) {
					case "staff-cross-examination":
						return [
							"ISSUE: STAFF-1 | TARGET: tech-lead",
							"ISSUE: STAFF-2 | TARGET: tech-lead",
							"ISSUE: STAFF-3 | TARGET: tech-lead",
							"NO ISSUES | TARGET: qa-engineer",
						].join("\n");
					case "qa-cross-examination":
						return [
							"ISSUE: QA-1 | TARGET: tech-lead",
							"ISSUE: QA-2 | TARGET: tech-lead",
							"ISSUE: QA-3 | TARGET: tech-lead",
							"ISSUE: QA-4 | TARGET: tech-lead",
							"NO ISSUES | TARGET: staff-engineer",
						].join("\n");
					case "architecture-revision":
						return completeWorkCard(assignedTechLeadIds.map((id) => `RESOLUTION: ${id} | RESOLVED`).join("\n"));
					case "qa-revision":
						return completeWorkCard("[L2] No open challenge is assigned.");
					default:
						return responseForMutualReviewStage(stage);
				}
			},
		});

		expect(result.terminationReason).toBeUndefined();
		expect(result.verdict).toBe("approved");
		for (const stage of ["architecture-revision", "staff-revision", "qa-revision"] as const) {
			const prompt = prompts.get(stage) ?? "";
			expect(prompt).toContain(
				"Before the revised work card, for every open challenge ID assigned to you, emit exactly one whole-line `RESOLUTION: <assigned-ID> | RESOLVED` marker.",
			);
			expect(prompt).toContain("Emit no `RESOLUTION` marker when no open challenge ID is assigned to you.");
			expect(prompt).toContain(
				"After those resolution markers, publish the revised work card with each exact heading once and nonempty content: `## Conclusion`, `## Evidence`, `## Assumptions and Unknowns`, `## Alternatives and Trade-offs`, `## Self-Refutation Conditions`, `## Questions for Peers`, `## Challenge Responses`, and `## Recommended Actions`.",
			);
			expect(prompt).toContain(
				"In Challenge Responses, explain the evidence, decision, and remaining risk for each resolution instead of merely repeating its marker.",
			);
			expect(prompt).toContain(
				"In Recommended Actions, state the owner or decision maker, scope, and acceptance condition for each next step; when no action is needed, explain why current evidence is sufficient.",
			);
			expect(prompt).toContain(
				"Do not emit `VERDICT`, `ISSUE`, or `NO ISSUES` markers in this revision stage; reserve them for a subsequent verification stage if required.",
			);
		}
		for (const id of assignedTechLeadIds) {
			expect(prompts.get("architecture-revision")).toContain(`- ${id} from`);
		}
	});

	it("rejects an initial work card that omits required visible sections", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review incomplete initial work card",
			runRole: async ({ stage }) =>
				stage === "architecture"
					? "## Conclusion\n[L2] The architecture is ready for review."
					: responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("incomplete-work-card");
		expect(result.transcript.at(-1)?.stage).toBe("architecture");
		expect(result.markdown).toContain("missing required visible sections: Evidence");
	});

	it("rejects a work card with an empty required section body", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review empty work-card evidence",
			runRole: async ({ stage }) =>
				stage === "architecture"
					? [
							"## Conclusion",
							"[L2] The architecture is ready for review.",
							"## Evidence",
							"## Assumptions and Unknowns",
							"[L3] The integration dependency remains to be checked.",
							"## Alternatives and Trade-offs",
							"[L2] The direct path has the lowest operational cost.",
							"## Self-Refutation Conditions",
							"[L3] A failing integration test invalidates this proposal.",
							"## Questions for Peers",
							"[L2] Verify the proposed evidence boundary.",
						].join("\n\n")
					: responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("incomplete-work-card");
		expect(result.markdown).toContain("missing required visible sections: Evidence");
	});

	it("rejects a work card whose required section contains only a non-required heading", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review heading-only work-card evidence",
			runRole: async ({ stage }) =>
				stage === "architecture"
					? [
							"## Conclusion",
							"[L2] The architecture is ready for review.",
							"## Evidence",
							"## Placeholder",
							"## Assumptions and Unknowns",
							"[L3] The integration dependency remains to be checked.",
							"## Alternatives and Trade-offs",
							"[L2] The direct path has the lowest operational cost.",
							"## Self-Refutation Conditions",
							"[L3] A failing integration test invalidates this proposal.",
							"## Questions for Peers",
							"[L2] Verify the proposed evidence boundary.",
						].join("\n\n")
					: responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("incomplete-work-card");
		expect(result.markdown).toContain("missing required visible sections: Evidence");
	});

	it("accepts required headings wrapped by an outer Markdown heading", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review wrapped work-card headings",
			runRole: async ({ stage }) =>
				stage === "architecture"
					? `[L2] Wrapped work card\n\n${COMPLETE_WORK_CARD.replace(/^## /gm, "### ## ")}`
					: responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("approved");
	});

	it.each(["#", "####"])(
		"rejects a wrapped required heading with an alternate inner level (%s)",
		async (innerLevel) => {
			const result = await runAnsteelDiscussion({
				topic: "Review invalid wrapped work-card headings",
				runRole: async ({ stage }) =>
					stage === "architecture"
						? `[L2] Invalid wrapped work card\n\n${COMPLETE_WORK_CARD.replace(/^## /gm, `### ${innerLevel} `)}`
						: responseForMutualReviewStage(stage),
			});

			expect(result.verdict).toBe("rejected");
			expect(result.terminationReason).toBe("incomplete-work-card");
		},
	);

	it("accepts parenthesized qualifiers on every required revision heading", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review qualified revision headings",
			runRole: async ({ stage }) =>
				responseForMutualReviewStage(stage, {
					"architecture-revision": completeWorkCard("RESOLUTION: QA-CROSS | RESOLVED").replace(
						/^## (.+)$/gm,
						"## $1 (Revised)",
					),
				}),
		});

		expect(result.verdict).toBe("approved");
	});

	it("rejects a revision heading with an arbitrary required-section suffix", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review arbitrary revision heading suffix",
			runRole: async ({ stage }) =>
				stage === "architecture-revision"
					? completeWorkCard("RESOLUTION: QA-CROSS | RESOLVED").replace("## Conclusion", "## Conclusion notes")
					: responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("incomplete-work-card");
		expect(result.transcript.at(-1)?.stage).toBe("architecture-revision");
	});

	it("requires each revision to explain challenge responses and recommend actions", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review explanation and action requirements",
			runRole: async ({ stage }) =>
				stage === "architecture-revision"
					? `RESOLUTION: QA-CROSS | RESOLVED\n\n${COMPLETE_WORK_CARD}`
					: responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("incomplete-work-card");
		expect(result.markdown).toContain("missing required visible sections: Challenge Responses, Recommended Actions");
	});

	it("rejects a qualified revision heading with an empty body", async () => {
		const revision = completeWorkCard("RESOLUTION: QA-CROSS | RESOLVED")
			.replace(/^## (.+)$/gm, "## $1 (Revised)")
			.replace(
				"## Conclusion (Revised)\n[L2] The proposed work card is ready for peer review.",
				"## Conclusion (Revised)",
			);
		const result = await runAnsteelDiscussion({
			topic: "Review empty qualified revision heading",
			runRole: async ({ stage }) =>
				stage === "architecture-revision" ? revision : responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("incomplete-work-card");
		expect(result.markdown).toContain("missing required visible sections: Conclusion");
	});

	it("accepts an ISSUE marker in a Markdown heading", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review Markdown issue formatting",
			runRole: async ({ stage }) => {
				if (stage === "staff-cross-examination") {
					return "### ISSUE: STAFF-HEADING | TARGET: qa-engineer\nNO ISSUES | TARGET: tech-lead\nProvide a clearer invariant.";
				}
				if (stage === "qa-revision") return completeWorkCard("RESOLUTION: STAFF-HEADING | RESOLVED\n[L2] Revised.");
				return responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("approved");
	});

	it("allows a targeted no-issues marker alongside an issue for the other peer", async () => {
		let staffCrossExaminationPrompt = "";
		const result = await runAnsteelDiscussion({
			topic: "Review per-peer cross-examination markers",
			runRole: async ({ stage, prompt }) => {
				if (stage === "staff-cross-examination") {
					staffCrossExaminationPrompt = prompt;
					return "ISSUE: STAFF-PER-PEER | TARGET: tech-lead\n### NO ISSUES | TARGET: qa-engineer\n[L2] The architecture needs a clearer invariant.";
				}
				if (stage === "architecture-revision") {
					return completeWorkCard("RESOLUTION: STAFF-PER-PEER | RESOLVED\nRESOLUTION: QA-CROSS | RESOLVED");
				}
				if (stage === "qa-revision") return completeWorkCard("[L2] No challenge is assigned to QA.");
				return responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("approved");
		expect(staffCrossExaminationPrompt).toContain("NO ISSUES | TARGET: tech-lead");
	});

	it("rejects a cross-examination response that omits one peer", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review missing cross-examination peer coverage",
			runRole: async ({ stage }) =>
				stage === "staff-cross-examination"
					? "ISSUE: STAFF-ONLY-ONE | TARGET: tech-lead\n[L2] The interface contract is incomplete."
					: responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("invalid-challenge-ledger");
		expect(result.markdown).toContain("must cover every peer role");
	});

	it("accepts a RESOLUTION marker in a Markdown heading", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review Markdown resolution heading formatting",
			runRole: async ({ stage }) => {
				if (stage === "staff-cross-examination") {
					return "ISSUE: STAFF-RESOLUTION-HEADING | TARGET: qa-engineer\nNO ISSUES | TARGET: tech-lead";
				}
				if (stage === "qa-revision")
					return completeWorkCard("### RESOLUTION: STAFF-RESOLUTION-HEADING | RESOLVED\n[L2] Revised.");
				return responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("approved");
	});

	it("rejects a zero-width-only role response as blank", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review zero-width role output",
			runRole: async ({ stage }) =>
				stage === "qa-verification" ? "\u200B\u200C\u200D\uFEFF" : responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("blank-response");
		expect(result.markdown).toContain("qa-engineer / qa-verification returned an empty or whitespace-only response");
	});

	it("rejects a cross-examination issue without a target role", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review an untargeted cross-examination issue",
			runRole: async ({ stage }) => {
				if (stage === "staff-cross-examination") return "ISSUE: STAFF-SHORT\nClarify the invariant";
				return responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("invalid-challenge-ledger");
	});

	it("rejects a self-targeted cross-examination issue", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review a self-targeted challenge",
			runRole: async ({ stage }) =>
				stage === "tech-lead-cross-examination"
					? "ISSUE: TL-SELF | TARGET: tech-lead\n[L2] This must be rejected."
					: responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("invalid-challenge-ledger");
		expect(result.markdown).toContain("cannot challenge its own work card");
	});

	it("rejects a cross-examination response that combines issues with NO ISSUES", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review contradictory cross-examination markers",
			runRole: async ({ stage }) =>
				stage === "staff-cross-examination"
					? "ISSUE: STAFF-CONTRADICTION | TARGET: tech-lead\nNO ISSUES"
					: responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("invalid-challenge-ledger");
	});

	it("ignores a NO ISSUES commentary heading after valid targeted issues", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review no-issues commentary after targeted challenges",
			runRole: async ({ stage }) =>
				responseForMutualReviewStage(stage, {
					"tech-lead-cross-examination": [
						"### ISSUE: TL-COMMENT-STAFF | TARGET: staff-engineer",
						"### ISSUE: TL-COMMENT-QA | TARGET: qa-engineer",
						"### NO ISSUES (remaining claims)",
					].join("\n"),
					"staff-revision": completeWorkCard("RESOLUTION: TL-COMMENT-STAFF | RESOLVED"),
					"qa-revision": completeWorkCard(
						"RESOLUTION: STAFF-CROSS | RESOLVED\nRESOLUTION: TL-COMMENT-QA | RESOLVED",
					),
				}),
		});

		expect(result.verdict).toBe("approved");
		expect(result.challengeLedger).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "TL-COMMENT-STAFF", targetRole: "staff-engineer", status: "resolved" }),
				expect.objectContaining({ id: "TL-COMMENT-QA", targetRole: "qa-engineer", status: "resolved" }),
			]),
		);
	});

	it("does not let NO ISSUES commentary cover an unchallenged peer", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review unchallenged peer after no-issues commentary",
			runRole: async ({ stage }) =>
				stage === "tech-lead-cross-examination"
					? "ISSUE: TL-COMMENT-ONLY | TARGET: staff-engineer\nNO ISSUES: QA claims are already covered above."
					: responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("invalid-challenge-ledger");
		expect(result.markdown).toContain("must cover every peer role with an ISSUE or targeted NO ISSUES marker");
	});

	it("rejects a bold RESOLUTION marker embedded in prose", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review embedded Markdown resolution formatting",
			runRole: async ({ stage }) => {
				if (stage === "staff-cross-examination") {
					return "ISSUE: STAFF-TABLE | TARGET: qa-engineer\nNO ISSUES | TARGET: tech-lead\nClarify the boundary.";
				}
				if (stage === "qa-revision")
					return completeWorkCard("The summary says **RESOLUTION: STAFF-TABLE | RESOLVED**.");
				return responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("unanswered-challenge");
		expect(result.transcript.at(-1)?.stage).toBe("qa-revision");
	});

	it("accepts an emphasized verification verdict", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review Markdown verdict formatting",
			runRole: async ({ stage }) =>
				responseForMutualReviewStage(stage, {
					"staff-verification": "**VERDICT: APPROVE**",
				}),
		});

		expect(result.verdict).toBe("approved");
	});

	it("bounds each role stage to a finite number of safe tool executions", () => {
		const budget = createAnsteelToolBudget(2);

		expect(budget.beforeToolCall("read", { path: "src/main.ts" })).toBeUndefined();
		expect(budget.beforeToolCall("find", { pattern: "*.ts" })).toBeUndefined();
		expect(budget.beforeToolCall("grep", { pattern: "TODO" })).toEqual({
			block: true,
			reason:
				"Ansteel stage tool budget of 2 executions is exhausted. Provide the evidence-labelled conclusion without requesting more tools.",
		});
		expect(budget.getStageFailureReason()).toBeUndefined();

		budget.reset();
		expect(budget.beforeToolCall("bash", { command: "npm test" })).toEqual({
			block: true,
			reason: "Ansteel bash requires an explicit timeout of at most 20 seconds.",
		});
		expect(budget.getStageFailureReason()).toBeUndefined();
		expect(budget.beforeToolCall("bash", { command: "npm test", timeout: 21 })).toEqual({
			block: true,
			reason: "Ansteel bash requires an explicit timeout of at most 20 seconds.",
		});
		expect(budget.getStageFailureReason()).toBeUndefined();
		expect(budget.beforeToolCall("bash", { command: "npm test", timeout: 20 })).toEqual({
			block: true,
			reason:
				"Ansteel stage tool budget of 2 executions is exhausted. Provide the evidence-labelled conclusion without requesting more tools.",
		});
		expect(budget.getStageFailureReason()).toBeUndefined();

		budget.reset();
		expect(budget.getStageFailureReason()).toBeUndefined();
		expect(budget.beforeToolCall("bash", { command: "npm test", timeout: 20 })).toBeUndefined();
	});

	it("permits an extra tool batch only when the coordinator grants it", () => {
		const budget = createAnsteelToolBudget(1);
		let grantsRemaining = 1;
		budget.setExtensionHandler(() => (grantsRemaining-- > 0 ? 2 : undefined));

		expect(budget.beforeToolCall("read", { path: "src/main.ts" })).toBeUndefined();
		expect(budget.beforeToolCall("find", { path: "src" })).toBeUndefined();
		expect(budget.beforeToolCall("grep", { pattern: "TODO", path: "src" })).toBeUndefined();
		expect(budget.beforeToolCall("ls", { path: "src" })).toEqual({
			block: true,
			reason:
				"Ansteel stage tool budget of 3 executions is exhausted. Provide the evidence-labelled conclusion without requesting more tools.",
		});
	});

	it("counts a policy-blocked request without rejecting the stage before the bounded allowance is exhausted", () => {
		const budget = createAnsteelToolBudget(2);

		budget.recordBlockedToolCall("Ansteel review tools must stay inside the reviewed project: ..");

		expect(budget.getStageFailureReason()).toBeUndefined();
		expect(budget.beforeToolCall("read", { path: ".github/workflows/ansteel-delivery.yml" })).toBeUndefined();
		expect(budget.beforeToolCall("read", { path: "README.md" })).toEqual({
			block: true,
			reason:
				"Ansteel stage tool budget of 2 executions is exhausted. Provide the evidence-labelled conclusion without requesting more tools.",
		});
	});

	it("creates a bounded stage policy with immutable hard and project limits", () => {
		expect(
			createAnsteelStageBudgetPolicy({
				stageTimeoutMs: 40,
				maxStageTimeoutMs: 60,
				timeoutExtensionMs: 10,
				maxStageExtensions: 1,
				projectTimeoutMs: 200,
				maxToolCallsPerStage: 2,
				maxProjectToolCalls: 5,
			}),
		).toEqual({
			stageTimeoutMs: 40,
			maxStageTimeoutMs: 60,
			timeoutExtensionMs: 10,
			maxStageExtensions: 1,
			projectTimeoutMs: 200,
			maxToolCallsPerStage: 2,
			maxProjectToolCalls: 5,
		});
		expect(() =>
			createAnsteelStageBudgetPolicy({
				stageTimeoutMs: 60,
				maxStageTimeoutMs: 40,
			}),
		).toThrow("Ansteel maxStageTimeoutMs must be at least stageTimeoutMs");
	});

	it("rejects tool calls after the project-wide tool budget is exhausted", () => {
		const budget = createAnsteelProjectToolBudget(2);

		expect(budget.tryConsumeToolCall()).toBeUndefined();
		expect(budget.tryConsumeToolCall()).toBeUndefined();
		expect(budget.tryConsumeToolCall()).toBe(
			"Ansteel project tool budget of 2 executions is exhausted. Provide the evidence-labelled conclusion without requesting more tools.",
		);
		expect(budget.getUsedToolCalls()).toBe(2);
	});

	it("blocks a tool call when its project budget consumption cannot be durably persisted", () => {
		const budget = createAnsteelProjectToolBudget(2, 0, 0, () => {
			throw new Error("checkpoint write failed");
		});

		expect(budget.tryConsumeToolCall()).toContain("could not be durably recorded");
		expect(budget.getUsedToolCalls()).toBe(0);
	});

	it("restores consumed project tool capacity before a resumed role session starts", () => {
		const budget = createAnsteelProjectToolBudget(3, 2);

		expect(budget.getUsedToolCalls()).toBe(2);
		expect(budget.tryConsumeToolCall()).toBeUndefined();
		expect(budget.tryConsumeToolCall()).toContain("project tool budget of 3 executions is exhausted");
	});

	it("protects verification reserve from ordinary project tool calls", () => {
		const createBudget = createAnsteelProjectToolBudget as unknown as (
			maximum: number,
			initialUsed: number,
			protectedVerificationToolCalls: number,
		) => ReturnType<typeof createAnsteelProjectToolBudget>;
		const budget = createBudget(5, 0, 2);

		expect(budget.tryConsumeToolCall()).toBeUndefined();
		expect(budget.tryConsumeToolCall()).toBeUndefined();
		expect(budget.tryConsumeToolCall()).toBeUndefined();
		expect(budget.tryConsumeToolCall()).toContain("protected verification reserve");
	});

	it("leaves a minimum tool allocation for every remaining mandatory verification gate", () => {
		const budget = createAnsteelProjectToolBudget(10, 5, 5);
		budget.setProtectedVerificationReserve(4);

		expect(budget.tryConsumeToolCall()).toBeUndefined();
		expect(budget.tryConsumeToolCall()).toContain("protected verification reserve");
	});

	it("enforces the adaptive project cap before ordinary stages can consume the verification reserve", async () => {
		type TestModel = { provider: string; id: string };
		const architectureToolResults: Array<string | undefined> = [];

		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Enforce adaptive project tool cap",
			cwd: process.cwd(),
			config: {
				stageBudgetPolicy: { maxProjectToolCalls: 20 },
				adaptiveBudgetPolicy: {
					enabled: true,
					maxProjectToolCalls: 12,
					protectedVerificationToolCalls: 10,
				},
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ projectToolBudget }) => ({
				prompt: async (prompt) => {
					const stage = getStageFromPrompt(prompt);
					if (stage === "architecture") {
						if (!projectToolBudget) throw new Error("Expected a project tool budget");
						architectureToolResults.push(
							projectToolBudget.tryConsumeToolCall(),
							projectToolBudget.tryConsumeToolCall(),
							projectToolBudget.tryConsumeToolCall(),
							projectToolBudget.tryConsumeToolCall(),
						);
					}
					return responseForMutualReviewStage(stage);
				},
				dispose: () => {},
			}),
		});

		expect(result.verdict, result.markdown).toBe("approved");
		expect(architectureToolResults).toEqual([
			undefined,
			undefined,
			expect.stringContaining("protected verification reserve"),
			expect.stringContaining("protected verification reserve"),
		]);
	});

	it("rejects an injected project budget that exceeds the adaptive hard cap", async () => {
		await expect(
			runAnsteelDiscussion({
				topic: "Reject oversized injected budget",
				stageBudgetPolicy: { maxProjectToolCalls: 20 },
				adaptiveBudgetPolicy: { enabled: true, maxProjectToolCalls: 12, protectedVerificationToolCalls: 10 },
				projectToolBudget: createAnsteelProjectToolBudget(20),
				runRole: async ({ stage }) => responseForMutualReviewStage(stage),
			}),
		).rejects.toThrow("Ansteel injected project tool budget exceeds the effective project hard cap of 12");
	});

	it("creates a recovery checkpoint outside historical reports", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-run-"));
		temporaryDirectories.push(cwd);
		mkdirSync(join(cwd, ".pi", "ansteel-reports"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "ansteel-reports", "old-review.md"), "historical model output", "utf8");

		const checkpoint = createAnsteelRunCheckpoint({
			cwd,
			topic: "Recover provider failure",
			roleModels: {
				"tech-lead": "tech/lead",
				"staff-engineer": "staff/engineer",
				"qa-engineer": "qa/engineer",
			},
			reviewRoot: cwd,
			evidencePackageHash: "a".repeat(64),
			configFingerprint: "b".repeat(64),
			projectStartedAt: Date.parse("2026-07-26T00:00:00.000Z"),
			hardProjectDeadline: Date.parse("2026-07-26T01:00:00.000Z"),
			nextAction: { role: "tech-lead", stage: "architecture" },
			now: new Date("2026-07-26T00:00:00.000Z"),
		});

		expect(checkpoint.path).toMatch(
			/\.pi[\\/]ansteel-runs[\\/]ansteel-run-2026-07-26T00-00-00-000Z[\\/]checkpoint\.json$/,
		);
		expect(loadAnsteelRunCheckpoint(checkpoint.path)).toMatchObject({
			status: "ready-to-resume",
			topic: "Recover provider failure",
			roleModels: checkpoint.state.roleModels,
			events: [],
		});
		updateAnsteelRunCheckpoint(checkpoint, {
			status: "failed",
			event: { type: "failed", detail: "stage-timeout" },
			now: new Date("2026-07-26T00:01:00.000Z"),
		});
		expect(loadAnsteelRunCheckpoint(checkpoint.path)).toMatchObject({
			status: "failed",
			updatedAt: "2026-07-26T00:01:00.000Z",
			events: [expect.objectContaining({ type: "failed", detail: "stage-timeout" })],
		});
	});

	it("durably records project tool use before an uncommitted role response can be interrupted", async () => {
		type TestModel = { provider: string; id: string };
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-durable-tool-use-"));
		temporaryDirectories.push(cwd);
		let releaseArchitectureResponse: (() => void) | undefined;
		let resolveToolConsumed: (() => void) | undefined;
		const toolConsumed = new Promise<void>((resolve) => {
			resolveToolConsumed = resolve;
		});

		const review = runAnsteelProjectReview<TestModel>({
			topic: "Persist project tool usage before a role response commits",
			cwd,
			enableRunCheckpoints: true,
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ projectToolBudget }) => ({
				prompt: async (prompt) => {
					const stage = getStageFromPrompt(prompt);
					if (stage === "architecture") {
						expect(projectToolBudget?.tryConsumeToolCall()).toBeUndefined();
						resolveToolConsumed?.();
						await new Promise<void>((resolve) => {
							releaseArchitectureResponse = resolve;
						});
					}
					return responseForMutualReviewStage(stage);
				},
				dispose: () => {},
			}),
		});

		await toolConsumed;
		const [runId] = readdirSync(join(cwd, ".pi", "ansteel-runs"));
		const checkpoint = loadAnsteelRunCheckpoint(getAnsteelRunCheckpointPath(cwd, runId));
		expect(checkpoint.workflowState).toMatchObject({ projectToolCallsUsed: 1 });

		releaseArchitectureResponse?.();
		await expect(review).resolves.toMatchObject({ verdict: "approved" });
	});

	it("rejects a checkpoint transition from a terminal state back to resumable", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-run-transition-"));
		temporaryDirectories.push(cwd);
		const checkpoint = createAnsteelRunCheckpoint({
			cwd,
			topic: "Reject terminal checkpoint rewind",
			roleModels: {
				"tech-lead": "tech/lead",
				"staff-engineer": "staff/engineer",
				"qa-engineer": "qa/engineer",
			},
			reviewRoot: cwd,
			evidencePackageHash: "a".repeat(64),
			configFingerprint: "b".repeat(64),
			projectStartedAt: 1,
			hardProjectDeadline: 2,
			nextAction: { role: "tech-lead", stage: "architecture" },
		});

		updateAnsteelRunCheckpoint(checkpoint, { status: "completed" });
		expect(() => updateAnsteelRunCheckpoint(checkpoint, { status: "ready-to-resume" })).toThrow(
			"Ansteel run checkpoint cannot transition from terminal status completed",
		);
	});

	it("rejects a checkpoint update with an unknown governance action", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-run-action-"));
		temporaryDirectories.push(cwd);
		const checkpoint = createAnsteelRunCheckpoint({
			cwd,
			topic: "Reject unknown checkpoint action",
			roleModels: {
				"tech-lead": "tech/lead",
				"staff-engineer": "staff/engineer",
				"qa-engineer": "qa/engineer",
			},
			reviewRoot: cwd,
			evidencePackageHash: "a".repeat(64),
			configFingerprint: "b".repeat(64),
			projectStartedAt: 1,
			hardProjectDeadline: 2,
			nextAction: { role: "tech-lead", stage: "architecture" },
		});

		expect(() =>
			updateAnsteelRunCheckpoint(checkpoint, {
				nextAction: { role: "unknown-role" as AnsteelRole, stage: "architecture" },
			}),
		).toThrow("Ansteel run checkpoint has an invalid next action");
	});

	it("rejects a checkpoint action whose role cannot perform its stage", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-run-role-stage-"));
		temporaryDirectories.push(cwd);
		const checkpoint = createAnsteelRunCheckpoint({
			cwd,
			topic: "Reject mismatched checkpoint role and stage",
			roleModels: {
				"tech-lead": "tech/lead",
				"staff-engineer": "staff/engineer",
				"qa-engineer": "qa/engineer",
			},
			reviewRoot: cwd,
			evidencePackageHash: "a".repeat(64),
			configFingerprint: "b".repeat(64),
			projectStartedAt: 1,
			hardProjectDeadline: 2,
			nextAction: { role: "tech-lead", stage: "architecture" },
		});

		expect(() =>
			updateAnsteelRunCheckpoint(checkpoint, {
				nextAction: { role: "qa-engineer", stage: "architecture" },
			}),
		).toThrow("Ansteel run checkpoint has an invalid next action");
	});

	it("refuses all workflow changes once a checkpoint is terminal", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-run-terminal-"));
		temporaryDirectories.push(cwd);
		const checkpoint = createAnsteelRunCheckpoint({
			cwd,
			topic: "Reject terminal checkpoint mutation",
			roleModels: {
				"tech-lead": "tech/lead",
				"staff-engineer": "staff/engineer",
				"qa-engineer": "qa/engineer",
			},
			reviewRoot: cwd,
			evidencePackageHash: "a".repeat(64),
			configFingerprint: "b".repeat(64),
			projectStartedAt: 1,
			hardProjectDeadline: 2,
			nextAction: { role: "tech-lead", stage: "architecture" },
		});

		updateAnsteelRunCheckpoint(checkpoint, { status: "completed" });
		expect(() =>
			updateAnsteelRunCheckpoint(checkpoint, {
				workflowState: { ...checkpoint.state.workflowState, projectToolCallsUsed: 1 },
			}),
		).toThrow("Ansteel terminal checkpoint cannot be modified");
	});

	it("rejects an impossible transition from blocked directly to completed", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-run-transition-graph-"));
		temporaryDirectories.push(cwd);
		const checkpoint = createAnsteelRunCheckpoint({
			cwd,
			topic: "Reject impossible checkpoint transition",
			roleModels: {
				"tech-lead": "tech/lead",
				"staff-engineer": "staff/engineer",
				"qa-engineer": "qa/engineer",
			},
			reviewRoot: cwd,
			evidencePackageHash: "a".repeat(64),
			configFingerprint: "b".repeat(64),
			projectStartedAt: 1,
			hardProjectDeadline: 2,
			nextAction: { role: "tech-lead", stage: "architecture" },
		});

		updateAnsteelRunCheckpoint(checkpoint, { status: "blocked" });
		expect(() => updateAnsteelRunCheckpoint(checkpoint, { status: "completed" })).toThrow(
			"Ansteel run checkpoint cannot transition from blocked to completed",
		);
	});

	it("starts a resumed epoch from its epoch boundary instead of the original project start", async () => {
		const calls: AnsteelDiscussionStage[] = [];
		const resumedEpochStartedAt = Date.now();
		const result = await runAnsteelDiscussion({
			topic: "Resume with a fresh epoch clock",
			projectStartedAt: resumedEpochStartedAt - 5_000,
			hardProjectDeadline: resumedEpochStartedAt + 5_000,
			adaptiveBudgetPolicy: { enabled: true, epochTimeoutMs: 1_000 },
			runRole: async ({ stage }) => {
				calls.push(stage);
				return responseForMutualReviewStage(stage);
			},
			...({ epochStartedAt: resumedEpochStartedAt } as Record<string, unknown>),
		} as Parameters<typeof runAnsteelDiscussion>[0]);

		expect(result.verdict, result.markdown).toBe("approved");
		expect(calls).toContain("staff-critique");
	});

	it("persists a resumable checkpoint with an immutable evidence identity and next action", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-resume-"));
		temporaryDirectories.push(cwd);
		const checkpoint = createAnsteelRunCheckpoint({
			cwd,
			topic: "Resume an epoch without replaying completed governance work",
			roleModels: {
				"tech-lead": "tech/lead",
				"staff-engineer": "staff/engineer",
				"qa-engineer": "qa/engineer",
			},
			reviewRoot: cwd,
			evidencePackageHash: "a".repeat(64),
			configFingerprint: "b".repeat(64),
			projectStartedAt: Date.parse("2026-07-27T00:00:00.000Z"),
			hardProjectDeadline: Date.parse("2026-07-27T01:00:00.000Z"),
			nextAction: { role: "tech-lead", stage: "architecture" },
			now: new Date("2026-07-27T00:00:00.000Z"),
		});

		expect(loadAnsteelRunCheckpoint(checkpoint.path)).toMatchObject({
			version: 5,
			status: "ready-to-resume",
			evidencePackageHash: "a".repeat(64),
			configFingerprint: "b".repeat(64),
			nextAction: { role: "tech-lead", stage: "architecture" },
			epoch: 0,
		});
	});

	it("fails closed when a resume checkpoint identity no longer matches the project", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-resume-validation-"));
		temporaryDirectories.push(cwd);
		const checkpoint = createAnsteelRunCheckpoint({
			cwd,
			topic: "Validate resumable identity",
			roleModels: {
				"tech-lead": "tech/lead",
				"staff-engineer": "staff/engineer",
				"qa-engineer": "qa/engineer",
			},
			reviewRoot: cwd,
			evidencePackageHash: "a".repeat(64),
			configFingerprint: "b".repeat(64),
			projectStartedAt: Date.now(),
			hardProjectDeadline: Date.now() + 60_000,
			nextAction: { role: "tech-lead", stage: "architecture" },
		});

		expect(getAnsteelRunCheckpointPath(cwd, checkpoint.state.id)).toBe(checkpoint.path);
		expect(() => getAnsteelRunCheckpointPath(cwd, "../checkpoint")).toThrow("safe Ansteel run ID");
		expect(() =>
			validateAnsteelRunCheckpointForResume(checkpoint.state, {
				reviewRoot: cwd,
				evidencePackageHash: "c".repeat(64),
				configFingerprint: "b".repeat(64),
				roleModels: checkpoint.state.roleModels,
			}),
		).toThrow("evidence package changed");
	});

	it("rebuilds a frozen evidence package without admitting files created after the checkpoint", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-frozen-evidence-"));
		temporaryDirectories.push(cwd);
		for (let index = 0; index < 24; index += 1) {
			writeFileSync(
				join(cwd, `source-${String(index).padStart(2, "0")}.ts`),
				`export const value${index} = ${index};\n`,
				"utf8",
			);
		}

		const captured = createAnsteelEvidencePackage(cwd);
		const frozenPaths = [...captured.matchAll(/^- (.+?) \| bytes=/gm)].map(([, path]) => path);
		writeFileSync(join(cwd, "00-created-after-checkpoint.ts"), "export const later = true;\n", "utf8");

		expect(createAnsteelEvidencePackage(cwd, [], frozenPaths)).toBe(captured);
	});

	it("retains the captured eligible-file count when rebuilding a frozen evidence package", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-frozen-evidence-count-"));
		temporaryDirectories.push(cwd);
		for (let index = 0; index < 25; index += 1) {
			writeFileSync(
				join(cwd, `source-${String(index).padStart(2, "0")}.ts`),
				`export const value${index} = ${index};\n`,
				"utf8",
			);
		}

		const captured = createAnsteelEvidencePackage(cwd);
		const frozenPaths = [...captured.matchAll(/^- (.+?) \| bytes=/gm)].map(([, path]) => path);
		writeFileSync(join(cwd, "00-created-after-checkpoint.ts"), "export const later = true;\n", "utf8");
		const rebuild = createAnsteelEvidencePackage as unknown as (
			cwd: string,
			requiredEvidencePaths: readonly string[],
			frozenEvidencePaths: readonly string[],
			frozenEligibleFileCount: number,
		) => string;

		expect(rebuild(cwd, [], frozenPaths, 25)).toBe(captured);
	});

	// This case must survive 3 same-model retries with 1s/2s/3s backoff (6s total)
	// plus the fallback flow (~8s measured), so it needs an explicit timeout above the 5s default.
	it("fails over only an explicitly configured role after a recoverable provider failure", async () => {
		type TestModel = { provider: string; id: string };
		const createdModels: string[] = [];
		const disposedModels: string[] = [];

		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Recover a transient provider failure",
			cwd: process.cwd(),
			config: {
				allowProviderFallback: true,
				roles: {
					"tech-lead": { model: "tech/primary", fallbackModels: ["tech/fallback"], tools: ["read"] },
					"staff-engineer": { model: "staff/primary", tools: ["read"] },
					"qa-engineer": { model: "qa/primary", tools: ["read"] },
				},
				reportDirectory: "unused",
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ model }) => {
				const reference = `${model.provider}/${model.id}`;
				createdModels.push(reference);
				return {
					prompt: async (prompt) => {
						if (reference === "tech/primary") throw new Error("HTTP 503 service unavailable");
						return responseForMutualReviewStage(getStageFromPrompt(prompt));
					},
					dispose: () => {
						disposedModels.push(reference);
					},
				};
			},
		});

		expect(result.verdict).toBe("approved");
		expect(createdModels).toEqual([
			"tech/primary",
			"staff/primary",
			"qa/primary",
			"tech/primary",
			"tech/primary",
			"tech/primary",
			"tech/fallback",
		]);
		expect(disposedModels).toContain("tech/primary");
		expect(result.providerFallbacks).toEqual([
			expect.objectContaining({
				role: "tech-lead",
				fromModel: "tech/primary",
				toModel: "tech/fallback",
				failureClass: "transient",
			}),
		]);
		expect(result.markdown).toContain("## Provider Recovery");
	}, 30_000);

	it("resumes a paused review with the provider fallback identity already in effect", async () => {
		type TestModel = { provider: string; id: string };
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-resume-fallback-"));
		temporaryDirectories.push(cwd);
		const config: AnsteelConfig = {
			allowProviderFallback: true,
			adaptiveBudgetPolicy: {
				enabled: true,
				projectTimeoutMs: 30_000,
				maxProjectToolCalls: 20,
				protectedVerificationTimeMs: 100,
				protectedVerificationToolCalls: 10,
				epochTimeoutMs: 5_000,
			},
			roles: {
				"tech-lead": { model: "tech/primary", fallbackModels: ["tech/fallback"], tools: ["read"] },
				"staff-engineer": { model: "staff/primary", tools: ["read"] },
				"qa-engineer": { model: "qa/primary", tools: ["read"] },
			},
			reportDirectory: "unused",
		};
		const first = await runAnsteelProjectReview<TestModel>({
			topic: "Resume persisted fallback identity",
			cwd,
			enableRunCheckpoints: true,
			config,
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ model }) => ({
				prompt: async (prompt) => {
					const stage = getStageFromPrompt(prompt);
					if (model.id === "primary" && model.provider === "tech") throw new Error("HTTP 503 service unavailable");
					if (stage === "architecture") await new Promise((resolve) => setTimeout(resolve, 5_500));
					return responseForMutualReviewStage(stage);
				},
				dispose: () => {},
			}),
		});
		if (!first.runCheckpointPath) throw new Error("Expected checkpoint path");
		expect(first.verdict).toBe("paused");
		const resumedModels: string[] = [];

		const resumed = await runAnsteelProjectReview<TestModel>({
			topic: "Resume persisted fallback identity",
			cwd,
			resumeRunId: loadAnsteelRunCheckpoint(first.runCheckpointPath).id,
			config,
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ model }) => {
				resumedModels.push(`${model.provider}/${model.id}`);
				return {
					prompt: async (prompt) => responseForMutualReviewStage(getStageFromPrompt(prompt)),
					dispose: () => {},
				};
			},
		});

		expect(resumed.verdict).toBe("approved");
		expect(resumedModels).toContain("tech/fallback");
	}, 15_000);

	it("persists a completed project review to a dedicated run checkpoint when enabled", async () => {
		type TestModel = { provider: string; id: string };
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-run-review-"));
		temporaryDirectories.push(cwd);

		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Persist recoverable review state",
			cwd,
			enableRunCheckpoints: true,
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async () => ({
				prompt: async (prompt) => responseForMutualReviewStage(getStageFromPrompt(prompt)),
				dispose: () => {},
			}),
		});

		expect(result.runCheckpointPath).toBeDefined();
		if (!result.runCheckpointPath) throw new Error("Expected a run checkpoint path");
		expect(loadAnsteelRunCheckpoint(result.runCheckpointPath)).toMatchObject({
			status: "completed",
			topic: "Persist recoverable review state",
			projectStartedAt: expect.any(Number),
			hardProjectDeadline: expect.any(Number),
			evidenceManifest: {
				paths: expect.any(Array),
				eligibleFileCount: expect.any(Number),
			},
			events: expect.arrayContaining([expect.objectContaining({ type: "completed" })]),
			workflowState: {
				transcript: expect.arrayContaining([expect.objectContaining({ role: "tech-lead", stage: "architecture" })]),
				budgetLedger: expect.any(Array),
				adaptiveBudgetEvents: expect.any(Array),
			},
		});
	});

	it("resumes a checkpointed project review without replaying committed role prompts", async () => {
		type TestModel = { provider: string; id: string };
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-resume-review-"));
		temporaryDirectories.push(cwd);
		const config: AnsteelConfig = {
			adaptiveBudgetPolicy: {
				enabled: true,
				projectTimeoutMs: 10_000,
				maxProjectToolCalls: 20,
				protectedVerificationTimeMs: 100,
				protectedVerificationToolCalls: 10,
				epochTimeoutMs: 500,
			},
			roles: {
				"tech-lead": { model: "tech/lead", tools: ["read"] },
				"staff-engineer": { model: "staff/engineer", tools: ["read"] },
				"qa-engineer": { model: "qa/engineer", tools: ["read"] },
			},
			reportDirectory: "unused",
		};
		const first = await runAnsteelProjectReview<TestModel>({
			topic: "Resume committed review state",
			cwd,
			enableRunCheckpoints: true,
			config,
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async () => ({
				prompt: async (prompt) => {
					const stage = getStageFromPrompt(prompt);
					if (stage === "architecture") await new Promise((resolve) => setTimeout(resolve, 550));
					return responseForMutualReviewStage(stage);
				},
				dispose: () => {},
			}),
		});
		if (!first.runCheckpointPath) throw new Error("Expected checkpoint path");
		const checkpoint = { path: first.runCheckpointPath, state: loadAnsteelRunCheckpoint(first.runCheckpointPath) };
		expect(checkpoint.state.status).toBe("ready-to-resume");
		writeFileSync(join(cwd, "created-after-checkpoint.ts"), "export const later = true;\n", "utf8");
		const resumedStages: AnsteelDiscussionStage[] = [];

		let resumed: Awaited<ReturnType<typeof runAnsteelProjectReview<TestModel>>> | undefined;
		for (let attempt = 0; attempt < 16; attempt++) {
			resumed = await runAnsteelProjectReview<TestModel>({
				topic: "Resume committed review state",
				cwd,
				resumeRunId: checkpoint.state.id,
				config,
				resolveModel: (provider, id) => ({ provider, id }),
				createRoleSession: async () => ({
					prompt: async (prompt) => {
						const stage = getStageFromPrompt(prompt);
						resumedStages.push(stage);
						return responseForMutualReviewStage(stage);
					},
					dispose: () => {},
				}),
			});
			if (resumed.verdict !== "paused") break;
		}

		expect(resumed?.verdict).toBe("approved");
		expect(resumedStages).not.toContain("architecture");
		expect(resumedStages).toContain("staff-critique");
	});

	it("pauses at an epoch boundary after committing the current role stage", async () => {
		type TestModel = { provider: string; id: string };
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-epoch-"));
		temporaryDirectories.push(cwd);
		const calls: AnsteelDiscussionStage[] = [];
		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Pause a resumable epoch",
			cwd,
			enableRunCheckpoints: true,
			config: {
				adaptiveBudgetPolicy: {
					enabled: true,
					projectTimeoutMs: 1_000,
					maxProjectToolCalls: 20,
					protectedVerificationTimeMs: 100,
					protectedVerificationToolCalls: 10,
					epochTimeoutMs: 1,
				},
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async () => ({
				prompt: async (prompt) => {
					const stage = getStageFromPrompt(prompt);
					calls.push(stage);
					if (stage === "architecture") await new Promise((resolve) => setTimeout(resolve, 5));
					return responseForMutualReviewStage(stage);
				},
				dispose: () => {},
			}),
		});

		expect(result.verdict).toBe("paused");
		expect(calls).toEqual(["architecture"]);
		if (!result.runCheckpointPath) throw new Error("Expected checkpoint path");
		expect(loadAnsteelRunCheckpoint(result.runCheckpointPath)).toMatchObject({
			status: "ready-to-resume",
			epoch: 1,
			nextAction: { role: "staff-engineer", stage: "staff-critique" },
			workflowState: { transcript: [expect.objectContaining({ stage: "architecture" })] },
		});
	});

	it("rejects resume when a role thinking level changes after the checkpoint", async () => {
		type TestModel = { provider: string; id: string };
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-resume-thinking-"));
		temporaryDirectories.push(cwd);
		const config: AnsteelConfig = {
			adaptiveBudgetPolicy: {
				enabled: true,
				projectTimeoutMs: 10_000,
				maxProjectToolCalls: 20,
				protectedVerificationTimeMs: 100,
				protectedVerificationToolCalls: 10,
				epochTimeoutMs: 500,
			},
			roles: {
				"tech-lead": { model: "tech/lead", tools: ["read"] },
				"staff-engineer": { model: "staff/engineer", tools: ["read"] },
				"qa-engineer": { model: "qa/engineer", tools: ["read"] },
			},
			reportDirectory: "unused",
		};
		const first = await runAnsteelProjectReview<TestModel>({
			topic: "Reject changed role thinking on resume",
			cwd,
			enableRunCheckpoints: true,
			config,
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async () => ({
				prompt: async (prompt) => {
					if (getStageFromPrompt(prompt) === "architecture")
						await new Promise((resolve) => setTimeout(resolve, 550));
					return responseForMutualReviewStage(getStageFromPrompt(prompt));
				},
				dispose: () => {},
			}),
		});
		if (!first.runCheckpointPath) throw new Error("Expected checkpoint path");
		const runId = loadAnsteelRunCheckpoint(first.runCheckpointPath).id;
		const changedConfig: AnsteelConfig = {
			...config,
			roles: {
				...config.roles,
				"staff-engineer": { ...config.roles["staff-engineer"], thinkingLevel: "high" },
			},
		};

		await expect(
			runAnsteelProjectReview<TestModel>({
				topic: "Reject changed role thinking on resume",
				cwd,
				resumeRunId: runId,
				config: changedConfig,
				resolveModel: (provider, id) => ({ provider, id }),
				createRoleSession: async () => ({
					prompt: async (prompt) => responseForMutualReviewStage(getStageFromPrompt(prompt)),
					dispose: () => {},
				}),
			}),
		).rejects.toThrow("Ansteel resume configuration changed");
	});

	it("expires a resumed epoch from its persisted project deadline before prompting the next role", async () => {
		type TestModel = { provider: string; id: string };
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-expired-epoch-"));
		temporaryDirectories.push(cwd);
		const calls: AnsteelDiscussionStage[] = [];
		const config: AnsteelConfig = {
			adaptiveBudgetPolicy: {
				enabled: true,
				projectTimeoutMs: 1_000,
				maxProjectToolCalls: 20,
				protectedVerificationTimeMs: 100,
				protectedVerificationToolCalls: 10,
				epochTimeoutMs: 1,
			},
			roles: {
				"tech-lead": { model: "tech/lead", tools: ["read"] },
				"staff-engineer": { model: "staff/engineer", tools: ["read"] },
				"qa-engineer": { model: "qa/engineer", tools: ["read"] },
			},
			reportDirectory: "unused",
		};
		const first = await runAnsteelProjectReview<TestModel>({
			topic: "Expire a resumed epoch",
			cwd,
			enableRunCheckpoints: true,
			config,
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async () => ({
				prompt: async (prompt) => {
					const stage = getStageFromPrompt(prompt);
					calls.push(stage);
					if (stage === "architecture") await new Promise((resolve) => setTimeout(resolve, 5));
					return responseForMutualReviewStage(stage);
				},
				dispose: () => {},
			}),
		});
		if (!first.runCheckpointPath) throw new Error("Expected checkpoint path");
		const checkpoint = { path: first.runCheckpointPath, state: loadAnsteelRunCheckpoint(first.runCheckpointPath) };
		checkpoint.state.projectStartedAt = Date.now() - 100;
		checkpoint.state.hardProjectDeadline = Date.now() - 1;
		updateAnsteelRunCheckpoint(checkpoint, {
			status: "ready-to-resume",
			epochStartedAt: checkpoint.state.projectStartedAt,
		});
		let resumedSessionCreations = 0;

		const resumed = await runAnsteelProjectReview<TestModel>({
			topic: "Expire a resumed epoch",
			cwd,
			resumeRunId: checkpoint.state.id,
			config,
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async () => {
				resumedSessionCreations++;
				return {
					prompt: async (prompt) => {
						calls.push(getStageFromPrompt(prompt));
						return responseForMutualReviewStage(getStageFromPrompt(prompt));
					},
					dispose: () => {},
				};
			},
		});

		expect(resumed.verdict).toBe("rejected");
		expect(calls).toEqual(["architecture"]);
		expect(resumedSessionCreations).toBe(0);
		expect(loadAnsteelRunCheckpoint(first.runCheckpointPath).status).toBe("expired");
	});

	it("extends a stage once for new redacted evidence and records the budget ledger", async () => {
		const progress: string[] = [];
		const result = await runAnsteelDiscussion({
			topic: "Review adaptive stage budget",
			stageBudgetPolicy: {
				stageTimeoutMs: 10,
				maxStageTimeoutMs: 30,
				timeoutExtensionMs: 20,
				maxStageExtensions: 1,
				projectTimeoutMs: 500,
				maxToolCallsPerStage: 4,
				maxProjectToolCalls: 20,
			},
			adaptiveBudgetPolicy: {
				enabled: true,
				projectTimeoutMs: 500,
				maxProjectToolCalls: 20,
				timeExtensionMs: 20,
				protectedVerificationTimeMs: 100,
				protectedVerificationToolCalls: 10,
			},
			getStageAudit: () => ({
				events: [
					{ type: "tool-execution-end", elapsedMs: 1, toolName: "read", isError: false, evidenceProgress: true },
				],
			}),
			onStageEvent: ({ type, role, stage, budget }) => {
				if (type === "budget-extended") progress.push(`${role}/${stage}:${budget.stageTimeoutMs}`);
			},
			runRole: async ({ stage }) => {
				if (stage === "architecture") await new Promise((resolve) => setTimeout(resolve, 15));
				return responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict, result.markdown).toBe("approved");
		expect(progress).toEqual(["tech-lead/architecture:30"]);
		expect(result.budgetLedger[0]).toMatchObject({
			role: "tech-lead",
			stage: "architecture",
			outcome: "completed",
			extensions: 1,
			toolCalls: 1,
			maxStageTimeoutMs: 30,
		});
		expect(result.markdown).toContain("## Budget Ledger");
		expect(result.adaptiveBudgetEvents).toEqual([
			expect.objectContaining({ role: "tech-lead", stage: "architecture", action: "grant-time" }),
		]);
		expect(result.markdown).toContain("## Adaptive Budget Ledger");
		expect(result.markdown).not.toContain("src/main.ts");
	});

	it("does not let adaptive time allocations bypass the configured stage extension count", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Respect the adaptive stage extension count",
			stageBudgetPolicy: {
				stageTimeoutMs: 10,
				maxStageTimeoutMs: 30,
				timeoutExtensionMs: 10,
				maxStageExtensions: 1,
				projectTimeoutMs: 500,
				maxToolCallsPerStage: 4,
				maxProjectToolCalls: 20,
			},
			adaptiveBudgetPolicy: {
				enabled: true,
				projectTimeoutMs: 500,
				maxProjectToolCalls: 20,
				timeExtensionMs: 10,
				protectedVerificationTimeMs: 100,
				protectedVerificationToolCalls: 10,
			},
			getStageAudit: () => ({
				events: [
					{ type: "tool-execution-end", elapsedMs: 1, toolName: "read", isError: false, evidenceProgress: true },
				],
			}),
			runRole: async ({ stage }) => {
				if (stage === "architecture") await new Promise((resolve) => setTimeout(resolve, 50));
				return responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.failure).toMatchObject({ role: "tech-lead", stage: "architecture" });
		expect(result.budgetLedger[0]).toMatchObject({ outcome: "timed-out", extensions: 1, stageTimeoutMs: 20 });
		expect(result.adaptiveBudgetEvents).toHaveLength(1);
	});

	it("grants a coordinator-derived tool batch to the active role stage", async () => {
		const requestedExtensions: Array<number | undefined> = [];
		const result = await runAnsteelDiscussion({
			topic: "Grant tools only after observed evidence",
			stageBudgetPolicy: {
				stageTimeoutMs: 100,
				maxStageTimeoutMs: 100,
				projectTimeoutMs: 500,
				maxToolCallsPerStage: 2,
				maxProjectToolCalls: 20,
			},
			adaptiveBudgetPolicy: {
				enabled: true,
				projectTimeoutMs: 500,
				maxProjectToolCalls: 20,
				toolExtensionCalls: 2,
				protectedVerificationTimeMs: 100,
				protectedVerificationToolCalls: 10,
			},
			getStageAudit: () => ({
				events: [
					{ type: "tool-execution-end", elapsedMs: 1, toolName: "read", isError: false, evidenceProgress: true },
				],
			}),
			runRole: async ({ stage }, requestToolExtension) => {
				if (stage === "architecture") requestedExtensions.push(requestToolExtension?.());
				return responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict, result.markdown).toBe("approved");
		expect(requestedExtensions).toEqual([2]);
		expect(result.adaptiveBudgetEvents).toEqual([
			expect.objectContaining({
				role: "tech-lead",
				stage: "architecture",
				action: "grant-tools",
				granted: { toolCalls: 2 },
			}),
		]);
	});

	it("does not reset the project deadline when a later epoch starts", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Keep the original project deadline across epochs",
			projectStartedAt: Date.now() - 100,
			hardProjectDeadline: Date.now() - 1,
			runRole: async ({ stage }) => responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.failure).toMatchObject({ reason: "Project hard deadline has expired" });
	});

	it("blocks all tool execution during the one permitted format repair", () => {
		const budget = createAnsteelToolBudget(4);

		budget.reset({ toolsEnabled: false });

		expect(budget.beforeToolCall("read", { path: "src/main.ts" })).toEqual({
			block: true,
			reason: "Ansteel format repair permits no tool executions. Correct only the required response markers.",
		});
		expect(budget.getStageFailureReason()).toBeUndefined();
	});

	it("blocks shell execution and historical Ansteel state paths during review", () => {
		const policy = createAnsteelReviewToolPolicy("/workspace/project");

		expect(policy.beforeToolCall("bash", { command: "cat .pi/ansteel-reports/stale.md", timeout: 5 })).toEqual({
			block: true,
			reason: "Ansteel reviews do not permit shell execution; use the bounded read-only review tools.",
		});
		expect(policy.beforeToolCall("read", { path: ".pi/ansteel-reports/stale.md" })).toEqual({
			block: true,
			reason: "Ansteel review tools cannot access coordinator state: .pi/ansteel-reports/stale.md",
		});
		expect(policy.beforeToolCall("grep", { pattern: "ISSUE", path: "src" })).toBeUndefined();
	});

	it("blocks direct traversal of the Ansteel coordinator state directory during review", () => {
		const policy = createAnsteelReviewToolPolicy("/workspace/project");

		for (const [toolName, args] of [
			["ls", { path: ".pi" }],
			["find", { path: ".pi", pattern: "**/*" }],
			["grep", { path: ".pi", pattern: "ISSUE" }],
		] as const) {
			expect(policy.beforeToolCall(toolName, args)).toEqual({
				block: true,
				reason: "Ansteel review tools cannot access coordinator state: .pi",
			});
		}
	});

	it("rejects a QA challenge that uses the Staff Engineer issue namespace", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review role-specific challenge namespaces",
			runRole: async ({ stage }) =>
				stage === "qa-cross-examination"
					? "ISSUE: STAFF-1 | TARGET: tech-lead\nNO ISSUES | TARGET: staff-engineer"
					: responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("invalid-challenge-ledger");
		expect(result.transcript.at(-1)?.stage).toBe("qa-cross-examination");
		expect(result.markdown).toContain("qa-engineer challenge STAFF-1 must use issue IDs beginning with QA-");
	});

	it("permits exactly one no-tool format repair for a namespace-invalid QA challenge", async () => {
		const calls: Array<{ role: AnsteelRole; stage: AnsteelDiscussionStage; formatRepair?: true }> = [];

		const result = await runAnsteelDiscussion({
			topic: "Repair a namespace-invalid QA challenge",
			runRole: async ({ role, stage, formatRepair }) => {
				calls.push({ role, stage, formatRepair });
				if (role === "qa-engineer" && stage === "qa-cross-examination") {
					return formatRepair
						? "ISSUE: QA-CROSS | TARGET: tech-lead\nNO ISSUES | TARGET: staff-engineer"
						: "ISSUE: STAFF-CROSS | TARGET: tech-lead\nNO ISSUES | TARGET: staff-engineer";
				}
				return responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("approved");
		expect(calls.filter((call) => call.role === "qa-engineer" && call.stage === "qa-cross-examination")).toEqual([
			{ role: "qa-engineer", stage: "qa-cross-examination" },
			{ role: "qa-engineer", stage: "qa-cross-examination", formatRepair: true },
		]);
		expect(result.transcript.filter((entry) => entry.formatRepair)).toEqual([
			expect.objectContaining({ role: "qa-engineer", stage: "qa-cross-examination", formatRepair: true }),
		]);
	});

	it("repairs a truncated cross-examination response that omitted all peer coverage markers", async () => {
		const calls: Array<{ role: AnsteelRole; stage: AnsteelDiscussionStage; formatRepair?: true }> = [];

		const result = await runAnsteelDiscussion({
			topic: "Repair truncated cross-examination peer coverage",
			runRole: async ({ role, stage, formatRepair }) => {
				calls.push({ role, stage, formatRepair });
				if (role === "staff-engineer" && stage === "staff-cross-examination") {
					return formatRepair
						? "NO ISSUES | TARGET: tech-lead\nNO ISSUES | TARGET: qa-engineer"
						: "## Staff cross-examination\nProvider response was truncated mid-sentence without any ISSUE or NO ISSUES marker.";
				}
				if (stage === "qa-revision") {
					// No challenge is targeted at QA in this scenario, so the
					// default fixture's STAFF-CROSS resolution would be dangling.
					return completeWorkCard("[L2] No challenge is assigned to QA.");
				}
				return responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("approved");
		expect(
			calls.filter((call) => call.role === "staff-engineer" && call.stage === "staff-cross-examination"),
		).toEqual([
			{ role: "staff-engineer", stage: "staff-cross-examination" },
			{ role: "staff-engineer", stage: "staff-cross-examination", formatRepair: true },
		]);
		expect(result.transcript.filter((entry) => entry.formatRepair)).toEqual([
			expect.objectContaining({ role: "staff-engineer", stage: "staff-cross-examination", formatRepair: true }),
		]);
	});

	it("reads only the raw assistant text created by the current prompt", async () => {
		const messages: RawTurnMessage[] = [
			{
				role: "assistant",
				content: [{ type: "text", text: "VERDICT: APPROVE" }],
				stopReason: "stop",
			},
		];
		const assistantMessages = createAssistantMessageEmitter();
		const source: RawTurnSessionSource = {
			messages,
			prompt: async () => {
				const response: RawTurnMessage = {
					role: "assistant",
					content: [
						{ type: "text", text: "VERDICT: " },
						{ type: "text", text: "APPROVE " },
					],
					stopReason: "stop",
				};
				messages.push(response);
				assistantMessages.emit(response);
			},
			subscribeToAssistantMessageEnd: assistantMessages.subscribe,
			dispose: () => {},
		};

		const session = createAnsteelRawTurnSession(source);

		const response = await session.prompt("veto");

		expect(getLegacyCopyText(messages)).toBe("VERDICT: APPROVE");
		expect(response).toBe("VERDICT: APPROVE ");
	});

	it("forwards the raw session abort hook", async () => {
		let aborts = 0;
		const session = createAnsteelRawTurnSession({
			prompt: async () => {},
			subscribeToAssistantMessageEnd: () => () => {},
			abort: () => {
				aborts++;
			},
			dispose: () => {},
		});

		expect(session.abort).toBeDefined();
		await session.abort?.();
		expect(aborts).toBe(1);
	});

	it("resets raw session history before every stage prompt", async () => {
		const events: string[] = [];
		const assistantMessages = createAssistantMessageEmitter();
		const session = createAnsteelRawTurnSession({
			prompt: async (text) => {
				events.push(`prompt:${text}`);
				assistantMessages.emit({
					role: "assistant",
					content: [{ type: "text", text: `Completed ${text}` }],
					stopReason: "stop",
				});
			},
			reset: () => {
				events.push("reset");
			},
			subscribeToAssistantMessageEnd: assistantMessages.subscribe,
			dispose: () => {},
		});

		await session.prompt("first stage");
		await session.prompt("second stage");

		expect(events).toEqual(["reset", "prompt:first stage", "reset", "prompt:second stage"]);
	});

	it("captures the current assistant event when compaction replaces the message list", async () => {
		let messages: RawTurnMessage[] = [
			{ role: "user", content: [{ type: "text", text: "old request" }] },
			{ role: "assistant", content: [{ type: "text", text: "old response" }] },
		];
		const assistantMessages = createAssistantMessageEmitter();
		const source: RawTurnSessionSource = {
			get messages() {
				return messages;
			},
			prompt: async () => {
				assistantMessages.emit({
					role: "assistant",
					content: [{ type: "text", text: "[L1] Current evidence before compaction" }],
				});
				messages = [{ role: "assistant", content: [{ type: "text", text: "compacted history" }] }];
			},
			subscribeToAssistantMessageEnd: assistantMessages.subscribe,
			dispose: () => {},
		};

		const response = await createAnsteelRawTurnSession(source).prompt("verify evidence");

		expect(response).toBe("[L1] Current evidence before compaction");
	});

	it("uses the final assistant message emitted during a prompt", async () => {
		const assistantMessages = createAssistantMessageEmitter();
		const source: RawTurnSessionSource = {
			messages: [],
			prompt: async () => {
				assistantMessages.emit({
					role: "assistant",
					content: [{ type: "text", text: "[L3] First tool-loop response" }],
				});
				assistantMessages.emit({
					role: "assistant",
					content: [{ type: "text", text: "[L1] Final verified response " }],
				});
			},
			subscribeToAssistantMessageEnd: assistantMessages.subscribe,
			dispose: () => {},
		};

		const response = await createAnsteelRawTurnSession(source).prompt("verify evidence");

		expect(response).toBe("[L1] Final verified response ");
	});

	it("keeps the final nonblank assistant text when a tool loop ends with an empty terminal message", async () => {
		const assistantMessages = createAssistantMessageEmitter();
		const source: RawTurnSessionSource = {
			messages: [],
			prompt: async () => {
				assistantMessages.emit({
					role: "assistant",
					content: [{ type: "text", text: "NO ISSUES" }],
					stopReason: "toolUse",
				});
				assistantMessages.emit({ role: "assistant", content: [], stopReason: "stop" });
			},
			subscribeToAssistantMessageEnd: assistantMessages.subscribe,
			dispose: () => {},
		};

		const response = await createAnsteelRawTurnSession(source).prompt("cross-examine peers");

		expect(response).toBe("NO ISSUES");
	});

	it("records a stage audit trail with tool lifecycle events", async () => {
		const assistantMessages = createAssistantMessageEmitter();
		const agentEvents = createAgentEventEmitter();
		const session = createAnsteelRawTurnSession({
			prompt: async () => {
				agentEvents.emit({
					type: "tool_execution_start",
					toolCallId: "read-1",
					toolName: "read",
					args: { path: "src/main.ts" },
				});
				agentEvents.emit({
					type: "tool_execution_end",
					toolCallId: "read-1",
					toolName: "read",
					result: { content: [] },
					isError: false,
				});
				assistantMessages.emit({
					role: "assistant",
					content: [{ type: "text", text: "[L1] Evidence reviewed" }],
					stopReason: "stop",
				});
			},
			subscribeToAssistantMessageEnd: assistantMessages.subscribe,
			subscribeToAgentEvent: agentEvents.subscribe,
			dispose: () => {},
		});

		await session.prompt("review evidence");

		const auditableSession = session as typeof session & {
			getLastStageAudit?: () => { events: Array<Record<string, unknown>> };
		};
		expect(auditableSession.getLastStageAudit?.()).toEqual({
			events: [
				expect.objectContaining({ type: "stage-prompt-start" }),
				expect.objectContaining({ type: "tool-execution-start", toolName: "read" }),
				expect.objectContaining({ type: "tool-execution-end", toolName: "read", isError: false }),
				expect.objectContaining({ type: "assistant-message-end", stopReason: "stop" }),
				expect.objectContaining({ type: "stage-prompt-end" }),
			],
		});
	});

	it("rejects an empty current turn instead of reusing an older assistant message", async () => {
		const assistantMessages = createAssistantMessageEmitter();
		const source: RawTurnSessionSource = {
			messages: [{ role: "assistant", content: [{ type: "text", text: "VERDICT: APPROVE" }] }],
			prompt: async () => {},
			subscribeToAssistantMessageEnd: assistantMessages.subscribe,
			dispose: () => {},
		};

		await expect(createAnsteelRawTurnSession(source).prompt("veto")).rejects.toThrow("empty-public-update");
	});

	it("rejects an output-length stop instead of publishing an empty role reply", async () => {
		const assistantMessages = createAssistantMessageEmitter();
		const session = createAnsteelRawTurnSession({
			prompt: async () => {
				assistantMessages.emit({
					role: "assistant",
					content: [],
					stopReason: "length",
				});
			},
			subscribeToAssistantMessageEnd: assistantMessages.subscribe,
			dispose: () => {},
		});

		await expect(session.prompt("implement")).rejects.toThrow("output-truncated");
		expect(session.getLastStageAudit?.().events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "assistant-message-end", stopReason: "length" }),
				expect.objectContaining({ type: "stage-prompt-error" }),
			]),
		);
	});

	it("surfaces a redacted provider error instead of treating it as an empty role reply", async () => {
		const assistantMessages = createAssistantMessageEmitter();
		const session = createAnsteelRawTurnSession({
			prompt: async () => {
				assistantMessages.emit({
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "Provider rejected Authorization: Bearer top-secret-token",
				});
			},
			subscribeToAssistantMessageEnd: assistantMessages.subscribe,
			dispose: () => {},
		});

		await expect(session.prompt("inspect failure")).rejects.toThrow(
			"Ansteel role provider error: Provider rejected Authorization: Bearer [REDACTED]",
		);
		const audit = session.getLastStageAudit?.();
		expect(audit?.events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "assistant-message-end", stopReason: "error" }),
				expect.objectContaining({ type: "stage-prompt-error" }),
			]),
		);
		expect(audit?.events).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "stage-prompt-end" })]),
		);
	});

	it("attempts every raw-session listener cleanup after one cleanup fails", async () => {
		let agentEventUnsubscribes = 0;
		const assistantMessages = createAssistantMessageEmitter();
		const session = createAnsteelRawTurnSession({
			prompt: async () => {
				assistantMessages.emit({
					role: "assistant",
					content: [{ type: "text", text: "[L1] Evidence" }],
					stopReason: "stop",
				});
			},
			subscribeToAssistantMessageEnd: (listener) => {
				const unsubscribe = assistantMessages.subscribe(listener);
				return () => {
					unsubscribe();
					throw new Error("assistant listener cleanup failed");
				};
			},
			subscribeToAgentEvent: () => () => {
				agentEventUnsubscribes++;
			},
			dispose: () => {},
		});

		await expect(session.prompt("verify cleanup")).rejects.toThrow("assistant listener cleanup failed");
		expect(agentEventUnsubscribes).toBe(1);
	});

	it("redacts thrown role failures before they reach the discussion report", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Redact provider failure",
			runRole: async () => {
				throw new Error("Provider rejected Authorization: Bearer sk-unit-test-provider-secret");
			},
		});

		expect(result.failure?.reason).toBe("Provider rejected Authorization: Bearer [REDACTED]");
		expect(result.markdown).toContain("Bearer [REDACTED]");
		expect(result.markdown).not.toContain("sk-unit-test-provider-secret");
	});

	it("unsubscribes a failed prompt listener before a later stage emits an assistant message", async () => {
		const listeners = new Set<(message: unknown) => void>();
		const deliveryCounts = new Map<number, number>();
		let promptCount = 0;
		let subscriptionCount = 0;
		let unsubscribeCalls = 0;
		const emitAssistantMessage = (message: RawTurnMessage): void => {
			for (const listener of listeners) listener(message);
		};
		const source: RawTurnSessionSource = {
			messages: [],
			prompt: async () => {
				promptCount++;
				if (promptCount === 1) throw new Error("source prompt failed");
				emitAssistantMessage({
					role: "assistant",
					content: [{ type: "text", text: "[L1] Later-stage evidence" }],
				});
			},
			subscribeToAssistantMessageEnd: (listener) => {
				const subscription = subscriptionCount++;
				deliveryCounts.set(subscription, 0);
				const trackedListener = (message: unknown): void => {
					deliveryCounts.set(subscription, (deliveryCounts.get(subscription) ?? 0) + 1);
					listener(message);
				};
				listeners.add(trackedListener);
				return () => {
					unsubscribeCalls++;
					listeners.delete(trackedListener);
				};
			},
			dispose: () => {},
		};

		const session = createAnsteelRawTurnSession(source);

		await expect(session.prompt("failed stage")).rejects.toThrow("source prompt failed");
		expect(await session.prompt("later stage")).toBe("[L1] Later-stage evidence");
		expect(unsubscribeCalls).toBe(2);
		expect(listeners.size).toBe(0);
		expect(deliveryCounts.get(0)).toBe(0);
		expect(deliveryCounts.get(1)).toBe(1);
	});

	it("keeps the provider failure primary when raw listener cleanup also fails", async () => {
		type TestModel = { provider: string; id: string };
		const promptedRoles: AnsteelRole[] = [];
		const disposed: AnsteelRole[] = [];

		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Review a raw provider failure",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ role }) => {
				if (role === "tech-lead") {
					return createAnsteelRawTurnSession({
						prompt: async () => {
							promptedRoles.push(role);
							throw new Error("provider request failed");
						},
						subscribeToAssistantMessageEnd: () => () => {
							throw new Error("listener cleanup failed");
						},
						dispose: () => {
							disposed.push(role);
						},
					});
				}

				return {
					prompt: async () => {
						promptedRoles.push(role);
						throw new Error(`Unexpected prompt for ${role}`);
					},
					dispose: () => {
						disposed.push(role);
					},
				};
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.failure).toEqual({
			role: "tech-lead",
			stage: "architecture",
			reason: "provider request failed; listener cleanup also failed: listener cleanup failed",
		});
		expect(result.transcript).toEqual([]);
		expect(promptedRoles).toEqual(["tech-lead"]);
		expect(disposed).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
	});

	it("rejects and archives listener cleanup failure after a successful raw prompt", async () => {
		const assistantMessages = createAssistantMessageEmitter();
		const result = await runAnsteelDiscussion({
			topic: "Review listener cleanup failure",
			runRole: async ({ role, stage, prompt }) => {
				if (role !== "tech-lead" || stage !== "architecture") {
					throw new Error(`Unexpected ${role} / ${stage}`);
				}

				return await createAnsteelRawTurnSession({
					prompt: async () => {
						assistantMessages.emit({
							role: "assistant",
							content: [{ type: "text", text: "Successful provider response" }],
							stopReason: "stop",
						});
					},
					subscribeToAssistantMessageEnd: (listener) => {
						const unsubscribe = assistantMessages.subscribe(listener);
						return () => {
							unsubscribe();
							throw new Error("listener cleanup failed");
						};
					},
					dispose: () => {},
				}).prompt(prompt);
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.failure).toEqual({
			role: "tech-lead",
			stage: "architecture",
			reason: "listener cleanup failed",
		});
		expect(result.transcript).toEqual([]);
		expect(result.markdown).toContain("- Reason: listener cleanup failed");
	});

	it("stops project review when the current QA reply is empty instead of reusing an earlier reply", async () => {
		type TestModel = { provider: string; id: string };
		const prompts: Array<{ role: AnsteelRole; text: string }> = [];
		let qaMessages: RawTurnMessage[] | undefined;

		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Review current QA turn",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ role }) => {
				const assistantMessages = createAssistantMessageEmitter();
				const messages: RawTurnMessage[] =
					role === "qa-engineer"
						? [
								{
									role: "assistant",
									content: [{ type: "text", text: "VERDICT: APPROVE" }],
									stopReason: "stop",
								},
							]
						: [];
				if (role === "qa-engineer") qaMessages = messages;
				return createAnsteelRawTurnSession({
					prompt: async (text) => {
						prompts.push({ role, text });
						const stage = getStageFromPrompt(text);
						const response: RawTurnMessage =
							stage === "qa-verification"
								? { role: "assistant", content: [], stopReason: "aborted" }
								: { role: "assistant", content: [{ type: "text", text: responseForMutualReviewStage(stage) }] };
						messages.push(response);
						assistantMessages.emit(response);
					},
					subscribeToAssistantMessageEnd: assistantMessages.subscribe,
					dispose: () => {},
				});
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.consensus).toBeUndefined();
		expect(result.failure).toEqual({
			role: "qa-engineer",
			stage: "qa-verification",
			reason: "Ansteel role stage failed: empty-public-update",
		});
		expect(result.transcript.at(-1)).toMatchObject({
			role: "staff-engineer",
			stage: "staff-verification",
			response: "VERDICT: APPROVE",
		});
		expect(getLegacyCopyText(qaMessages ?? [])).toBe(MUTUAL_REVIEW_RESPONSES["qa-revision"]);
		expect(result.markdown).toContain("Ansteel role stage failed: empty-public-update");
		expect(prompts.some(({ text }) => text.includes("Current stage: consensus."))).toBe(false);
	});

	it("runs three independent work cards, cross-examination, and three-role verification before consensus", async () => {
		const calls: Array<{ role: AnsteelRole; stage: string; prompt: string }> = [];
		const techCard = completeWorkCard(
			"[L2] Tech work card: component boundaries, failure policy, and acceptance criteria",
		);
		const staffCard = completeWorkCard("[L2] Staff work card: implementation sequencing and interface constraints");
		const qaCard = completeWorkCard("[L2] QA work card: test oracle and fault-injection plan");

		const result = await runAnsteelDiscussion({
			topic: "Review the motor safety architecture",
			runRole: async ({ role, stage, prompt }) => {
				calls.push({ role, stage, prompt });
				switch (stage) {
					case "architecture":
						return techCard;
					case "staff-critique":
						return staffCard;
					case "qa-critique":
						return qaCard;
					case "tech-lead-cross-examination":
						return "ISSUE: TL-1 | TARGET: staff-engineer\nNO ISSUES | TARGET: qa-engineer\n[L2] The driver interface cannot meet the proposed timing.";
					case "staff-cross-examination":
						return "ISSUE: STAFF-1 | TARGET: qa-engineer\nNO ISSUES | TARGET: tech-lead\n[L2] The fault-injection acceptance test is missing.";
					case "qa-cross-examination":
						return "ISSUE: QA-1 | TARGET: tech-lead\nNO ISSUES | TARGET: staff-engineer\n[L2] The architecture lacks a failure boundary.";
					case "architecture-revision":
						return completeWorkCard("RESOLUTION: QA-1 | RESOLVED");
					case "staff-revision":
						return completeWorkCard("RESOLUTION: TL-1 | RESOLVED");
					case "qa-revision":
						return completeWorkCard("RESOLUTION: STAFF-1 | RESOLVED");
					case "tech-lead-verification":
						return "VERDICT: APPROVE\nTL-VERIFICATION-PRIVATE";
					case "staff-verification":
						return "VERDICT: APPROVE\nSTAFF-VERIFICATION-PRIVATE";
					case "qa-verification":
						return "VERDICT: APPROVE\nQA-VERIFICATION-PRIVATE";
					case "staff-sign-off":
					case "qa-sign-off":
						return "VERDICT: APPROVE";
					case "consensus":
						return "[L1] Immutable architecture consensus\n<verification-method>\nL1 confirmed by exhaustive enumeration in an independent implementation.\n</verification-method>";
					default:
						return `[L2] ${role}/${stage}`;
				}
			},
		});

		expect(result.verdict).toBe("approved");
		expect(calls.map(({ role, stage }) => `${role}:${stage}`)).toEqual(
			MUTUAL_REVIEW_STAGE_ORDER.map(({ role, stage }) => `${role}:${stage}`),
		);

		const staffCritiquePrompt = calls.find((call) => call.stage === "staff-critique")?.prompt ?? "";
		const qaCritiquePrompt = calls.find((call) => call.stage === "qa-critique")?.prompt ?? "";
		const staffCrossExaminationPrompt = calls.find((call) => call.stage === "staff-cross-examination")?.prompt ?? "";
		const architectureRevisionPrompt = calls.find((call) => call.stage === "architecture-revision")?.prompt ?? "";
		const staffRevisionPrompt = calls.find((call) => call.stage === "staff-revision")?.prompt ?? "";
		const techLeadVerificationPrompt = calls.find((call) => call.stage === "tech-lead-verification")?.prompt ?? "";
		const staffVerificationPrompt = calls.find((call) => call.stage === "staff-verification")?.prompt ?? "";
		const qaVerificationPrompt = calls.find((call) => call.stage === "qa-verification")?.prompt ?? "";
		expect(staffCritiquePrompt).not.toContain(techCard);
		expect(qaCritiquePrompt).not.toContain(techCard);
		expect(staffCritiquePrompt).toContain("no leading or trailing whitespace");
		expect(staffCritiquePrompt).toContain("Never repeat an `ISSUE:` marker");
		expect(staffCritiquePrompt).toContain("Do not read or cite prior Ansteel reports");
		expect(staffCrossExaminationPrompt).toContain("## Cross-Examination Brief");
		expect(staffCrossExaminationPrompt).toContain("### tech-lead / architecture");
		expect(staffCrossExaminationPrompt).toContain("### qa-engineer / qa-critique");
		expect(staffCrossExaminationPrompt).not.toContain(staffCard);
		expect(architectureRevisionPrompt).toContain("The architecture lacks a failure boundary.");
		expect(staffRevisionPrompt).toContain("The driver interface cannot meet the proposed timing.");
		for (const verificationPrompt of [techLeadVerificationPrompt, staffVerificationPrompt, qaVerificationPrompt]) {
			expect(verificationPrompt).toContain("Every ISSUE must target a different role; never target yourself.");
			expect(verificationPrompt).toContain("RESOLUTION: TL-1 | RESOLVED");
			expect(verificationPrompt).toContain("RESOLUTION: STAFF-1 | RESOLVED");
			expect(verificationPrompt).toContain("RESOLUTION: QA-1 | RESOLVED");
			expect(verificationPrompt).toContain("TL-1 | tech-lead -> staff-engineer | round 0 | resolved");
			expect(verificationPrompt).toContain(
				"The final nonblank line of your response must be exactly `VERDICT: APPROVE` or exactly `VERDICT: REJECT`.",
			);
			expect(verificationPrompt).toContain(
				"If you reject, add at least one new targeted `ISSUE: <ID> | TARGET: <role>` marker before that final verdict line.",
			);
		}
		expect(qaVerificationPrompt).toContain(
			"Staff Engineer or QA Engineer must instead target tech-lead as canonical revision owner for an identified cross-card inconsistency",
		);
		expect(qaVerificationPrompt).not.toContain("STAFF-VERIFICATION-PRIVATE");
	});

	it("gives cross-examination only bounded peer work-card briefs while retaining full cards in the transcript", async () => {
		const calls: Array<{ role: AnsteelRole; stage: string; prompt: string }> = [];
		const longWorkCard = (conclusion: string, evidence: string, rawBody: string): string =>
			[
				`## Conclusion\n[L2] ${conclusion}`,
				`## Evidence\n[L1] ${evidence}\n\n${rawBody}`,
				"## Assumptions and Unknowns\n[L3] An explicit verification path remains.",
				"## Alternatives and Trade-offs\n[L2] Trade-offs are recorded.",
				"## Self-Refutation Conditions\n[L3] Contradictory evidence invalidates this card.",
				"## Questions for Peers\n[L2] Review the evidence.",
			].join("\n\n");
		const techCard = longWorkCard(
			"TECH-CONCLUSION-KEPT",
			"TECH-EVIDENCE-KEPT",
			`TECH-RAW-BODY-OMITTED-${"x".repeat(8_000)}`,
		);
		const staffCard = longWorkCard(
			"STAFF-OWN-CARD-OMITTED",
			"STAFF-OWN-EVIDENCE-OMITTED",
			`STAFF-RAW-BODY-OMITTED-${"y".repeat(8_000)}`,
		);
		const qaCard = longWorkCard("QA-CONCLUSION-KEPT", "QA-EVIDENCE-KEPT", `QA-RAW-BODY-OMITTED-${"z".repeat(8_000)}`);

		const result = await runAnsteelDiscussion({
			topic: "Review bounded cross-examination context",
			runRole: async ({ role, stage, prompt }) => {
				calls.push({ role, stage, prompt });
				switch (stage) {
					case "architecture":
						return techCard;
					case "staff-critique":
						return staffCard;
					case "qa-critique":
						return qaCard;
					case "tech-lead-cross-examination":
						return "NO ISSUES";
					case "staff-cross-examination":
						return "NO ISSUES";
					case "qa-cross-examination":
						return "NO ISSUES";
					case "architecture-revision":
					case "staff-revision":
					case "qa-revision":
						return completeWorkCard("[L2] No changes after cross-examination.");
					case "tech-lead-verification":
					case "staff-verification":
					case "qa-verification":
					case "staff-sign-off":
					case "qa-sign-off":
						return "VERDICT: APPROVE";
					case "consensus":
						return "[L1] Immutable consensus\n<verification-method>\nL1 confirmed by an independent numerical check.\n</verification-method>";
				}
			},
		});

		const staffCrossExaminationPrompt = calls.find((call) => call.stage === "staff-cross-examination")?.prompt ?? "";
		expect(staffCrossExaminationPrompt).toContain("## Cross-Examination Brief");
		expect(staffCrossExaminationPrompt).toContain("TECH-CONCLUSION-KEPT");
		expect(staffCrossExaminationPrompt).toContain("TECH-EVIDENCE-KEPT");
		expect(staffCrossExaminationPrompt).toContain("QA-CONCLUSION-KEPT");
		expect(staffCrossExaminationPrompt).toContain("QA-EVIDENCE-KEPT");
		expect(staffCrossExaminationPrompt).not.toContain("TECH-RAW-BODY-OMITTED");
		expect(staffCrossExaminationPrompt).not.toContain("QA-RAW-BODY-OMITTED");
		expect(staffCrossExaminationPrompt).not.toContain("STAFF-OWN-CARD-OMITTED");
		expect(result.markdown).toContain("TECH-RAW-BODY-OMITTED");
		expect(result.markdown).toContain("STAFF-OWN-CARD-OMITTED");
		expect(result.markdown).toContain("QA-RAW-BODY-OMITTED");
	});

	it("returns verifier rejections to a second collaborative revision before rejecting at the cap", async () => {
		const calls: Array<{ role: AnsteelRole; stage: string }> = [];
		let revisionCount = 0;

		const result = await runAnsteelDiscussion({
			topic: "Review repeated architecture objections",
			runRole: async ({ role, stage }) => {
				calls.push({ role, stage });
				switch (stage) {
					case "architecture-revision":
						revisionCount++;
						return completeWorkCard(
							revisionCount === 1 ? "RESOLUTION: QA-CROSS | RESOLVED" : "[L2] No new Tech Lead challenge.",
						);
					case "staff-revision":
						return completeWorkCard(
							revisionCount === 1 ? "RESOLUTION: TL-CROSS | RESOLVED" : "RESOLUTION: QA-VERIFY-1 | RESOLVED",
						);
					case "qa-revision":
						return completeWorkCard(
							revisionCount === 1 ? "RESOLUTION: STAFF-CROSS | RESOLVED" : "[L2] No new QA challenge.",
						);
					case "qa-verification":
						return `VERDICT: REJECT\nISSUE: QA-VERIFY-${revisionCount} | TARGET: staff-engineer\n[L1] The safety test still cannot prove the fault path.`;
					default:
						return responseForMutualReviewStage(stage);
				}
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(calls.filter((call) => call.stage === "architecture-revision")).toHaveLength(2);
		expect(calls.map(({ role, stage }) => `${role}:${stage}`)).not.toContain("tech-lead:consensus");
		expect(result.markdown).toContain("maximum of 2 revision rounds");
	});

	it("extends revision rounds adaptively while the ledger narrows, then stops at the cap", async () => {
		const calls: Array<{ role: AnsteelRole; stage: string }> = [];
		let revisionCount = 0;

		const result = await runAnsteelDiscussion({
			topic: "Review adaptive revision rounds",
			maxArchitectureRevisionRounds: 2,
			adaptiveArchitectureRevisions: true,
			adaptiveArchitectureRevisionCap: 3,
			runRole: async ({ role, stage }) => {
				calls.push({ role, stage });
				switch (stage) {
					case "architecture-revision":
						revisionCount++;
						return completeWorkCard(
							revisionCount === 1 ? "RESOLUTION: QA-CROSS | RESOLVED" : "[L2] No new Tech Lead challenge.",
						);
					case "staff-revision":
						return completeWorkCard(
							revisionCount === 1
								? "RESOLUTION: TL-CROSS | RESOLVED"
								: `RESOLUTION: QA-VERIFY-${revisionCount - 1} | RESOLVED`,
						);
					case "qa-revision":
						return completeWorkCard(
							revisionCount === 1 ? "RESOLUTION: STAFF-CROSS | RESOLVED" : "[L2] No new QA challenge.",
						);
					case "qa-verification":
						return `VERDICT: REJECT\nISSUE: QA-VERIFY-${revisionCount} | TARGET: staff-engineer\n[L1] The safety test still cannot prove the fault path.`;
					default:
						return responseForMutualReviewStage(stage);
				}
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(calls.filter((call) => call.stage === "architecture-revision")).toHaveLength(3);
		expect(result.markdown).toContain("maximum of 3 revision rounds");
		expect(result.revisionRounds.at(-1)?.extension).toContain("reached the configured revision round cap");
	});

	it("does not extend revision rounds when new issues grow", async () => {
		let revisionCount = 0;

		const result = await runAnsteelDiscussion({
			topic: "Review diverging revision rounds",
			maxArchitectureRevisionRounds: 2,
			adaptiveArchitectureRevisions: true,
			adaptiveArchitectureRevisionCap: 4,
			runRole: async ({ role, stage }) => {
				switch (stage) {
					case "architecture-revision":
						revisionCount++;
						return completeWorkCard(
							revisionCount === 1 ? "RESOLUTION: QA-CROSS | RESOLVED" : "[L2] No new Tech Lead challenge.",
						);
					case "staff-revision":
						return completeWorkCard(
							revisionCount === 1 ? "RESOLUTION: TL-CROSS | RESOLVED" : "RESOLUTION: QA-VERIFY-1 | RESOLVED",
						);
					case "qa-revision":
						return completeWorkCard(
							revisionCount === 1 ? "RESOLUTION: STAFF-CROSS | RESOLVED" : "[L2] No new QA challenge.",
						);
					case "qa-verification":
						return revisionCount === 1
							? "VERDICT: REJECT\nISSUE: QA-VERIFY-1 | TARGET: staff-engineer\n[L1] issue one."
							: "VERDICT: REJECT\nISSUE: QA-VERIFY-2 | TARGET: staff-engineer\n[L1] issue two.\nISSUE: QA-VERIFY-3 | TARGET: tech-lead\n[L1] issue three.\nISSUE: QA-VERIFY-4 | TARGET: staff-engineer\n[L1] issue four.";
					default:
						return responseForMutualReviewStage(stage);
				}
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.markdown).toContain("new issues grew from 1 to 3 (more than 2x)");
	});

	it("rejects an architecture revision that does not answer every challenge ID", async () => {
		const calls: Array<{ role: AnsteelRole; stage: string }> = [];

		const result = await runAnsteelDiscussion({
			topic: "Review unresolved architecture challenge",
			runRole: async ({ role, stage }) => {
				calls.push({ role, stage });
				switch (stage) {
					case "architecture":
						return completeWorkCard("[L1] Architecture v0");
					case "staff-critique":
						return completeWorkCard("ISSUE: STAFF-UNANSWERED\n[L2] Driver ownership is ambiguous.");
					case "qa-critique":
						return completeWorkCard("ISSUE: QA-ANSWERED\n[L2] Error-path coverage is incomplete.");
					case "architecture-revision":
						return completeWorkCard("RESOLUTION: QA-ANSWERED | RESOLVED");
					default:
						return `[L2] ${role}/${stage}`;
				}
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.markdown).toContain("STAFF-UNANSWERED");
		expect(calls.map(({ role, stage }) => `${role}:${stage}`)).not.toContain("staff-engineer:staff-verification");
	});

	it("allows independent reviewers to record NO ISSUES", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review an architecture without objections",
			runRole: async ({ stage }) =>
				responseForMutualReviewStage(stage, {
					"tech-lead-cross-examination": "NO ISSUES",
					"staff-cross-examination": "NO ISSUES",
					"qa-cross-examination": "NO ISSUES",
					"architecture-revision": completeWorkCard(
						"[L2] Tech Lead work card remains unchanged after independent review.",
					),
					"staff-revision": completeWorkCard("[L2] Staff work card remains unchanged after independent review."),
					"qa-revision": completeWorkCard("[L2] QA work card remains unchanged after independent review."),
				}),
		});

		expect(result.verdict).toBe("approved");
		expect(result.challengeLedger).toEqual([]);
		expect(result.markdown).toContain("No recorded challenge IDs.");
	});

	it("tolerates a redundant targeted NO ISSUES marker without discarding peer challenges", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review redundant targeted no-issues commentary",
			runRole: async ({ stage }) =>
				responseForMutualReviewStage(stage, {
					"staff-cross-examination": [
						"ISSUE: STAFF-REDUNDANT-1 | TARGET: tech-lead",
						"ISSUE: STAFF-REDUNDANT-2 | TARGET: tech-lead",
						"ISSUE: STAFF-REDUNDANT-3 | TARGET: qa-engineer",
						"NO ISSUES | TARGET: tech-lead",
					].join("\n"),
					"architecture-revision": completeWorkCard(
						"RESOLUTION: QA-CROSS | RESOLVED\nRESOLUTION: STAFF-REDUNDANT-1 | RESOLVED\nRESOLUTION: STAFF-REDUNDANT-2 | RESOLVED",
					),
					"qa-revision": completeWorkCard("RESOLUTION: STAFF-REDUNDANT-3 | RESOLVED"),
				}),
		});

		expect(result.verdict).toBe("approved");
		expect(result.challengeLedger).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "STAFF-REDUNDANT-1", targetRole: "tech-lead", status: "resolved" }),
				expect.objectContaining({ id: "STAFF-REDUNDANT-2", targetRole: "tech-lead", status: "resolved" }),
				expect.objectContaining({ id: "STAFF-REDUNDANT-3", targetRole: "qa-engineer", status: "resolved" }),
			]),
		);
	});

	it("accepts exact whole-line inline-code cross-examination and resolution markers", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review inline-code Ansteel markers",
			runRole: async ({ stage }) =>
				responseForMutualReviewStage(stage, {
					"tech-lead-cross-examination":
						"`ISSUE: TL-INLINE | TARGET: staff-engineer`\n`NO ISSUES | TARGET: qa-engineer`",
					"staff-cross-examination":
						"`ISSUE: STAFF-INLINE | TARGET: qa-engineer`\n`NO ISSUES | TARGET: tech-lead`",
					"qa-cross-examination": "`ISSUE: QA-INLINE | TARGET: tech-lead`\n`NO ISSUES | TARGET: staff-engineer`",
					"architecture-revision": completeWorkCard("`RESOLUTION: QA-INLINE | RESOLVED`"),
					"staff-revision": completeWorkCard("`RESOLUTION: TL-INLINE | RESOLVED`"),
					"qa-revision": completeWorkCard("`RESOLUTION: STAFF-INLINE | RESOLVED`"),
				}),
		});

		expect(result.verdict).toBe("approved");
		expect(result.challengeLedger).toEqual([
			expect.objectContaining({ id: "TL-INLINE", targetRole: "staff-engineer", status: "resolved" }),
			expect.objectContaining({ id: "STAFF-INLINE", targetRole: "qa-engineer", status: "resolved" }),
			expect.objectContaining({ id: "QA-INLINE", targetRole: "tech-lead", status: "resolved" }),
		]);
	});

	it("accepts an exact whole-line inline-code plain NO ISSUES marker", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review inline-code no-issues markers",
			runRole: async ({ stage }) =>
				responseForMutualReviewStage(stage, {
					"tech-lead-cross-examination": "`NO ISSUES`",
					"staff-cross-examination": "`NO ISSUES`",
					"qa-cross-examination": "`NO ISSUES`",
					"architecture-revision": completeWorkCard("[L2] No Tech Lead revision is required."),
					"staff-revision": completeWorkCard("[L2] No Staff revision is required."),
					"qa-revision": completeWorkCard("[L2] No QA revision is required."),
				}),
		});

		expect(result.verdict).toBe("approved");
		expect(result.challengeLedger).toEqual([]);
	});

	it("accepts exact whole-line bold cross-examination and resolution markers", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review bold Ansteel markers",
			runRole: async ({ stage }) =>
				responseForMutualReviewStage(stage, {
					"tech-lead-cross-examination":
						"**ISSUE: TL-BOLD | TARGET: staff-engineer**\n**NO ISSUES | TARGET: qa-engineer**",
					"staff-cross-examination":
						"**ISSUE: STAFF-BOLD | TARGET: qa-engineer**\n**NO ISSUES | TARGET: tech-lead**",
					"qa-cross-examination": "**ISSUE: QA-BOLD | TARGET: tech-lead**\n**NO ISSUES | TARGET: staff-engineer**",
					"architecture-revision": completeWorkCard("**RESOLUTION: QA-BOLD | RESOLVED**"),
					"staff-revision": completeWorkCard("**RESOLUTION: TL-BOLD | RESOLVED**"),
					"qa-revision": completeWorkCard("**RESOLUTION: STAFF-BOLD | RESOLVED**"),
				}),
		});

		expect(result.verdict).toBe("approved");
		expect(result.challengeLedger).toEqual([
			expect.objectContaining({ id: "TL-BOLD", targetRole: "staff-engineer", status: "resolved" }),
			expect.objectContaining({ id: "STAFF-BOLD", targetRole: "qa-engineer", status: "resolved" }),
			expect.objectContaining({ id: "QA-BOLD", targetRole: "tech-lead", status: "resolved" }),
		]);
	});

	it.each([
		[
			"a bold marker embedded in prose",
			"The review says **ISSUE: TL-EMBEDDED-BOLD | TARGET: staff-engineer** and **NO ISSUES | TARGET: qa-engineer**.",
		],
		[
			"partially wrapped bold markers",
			"**ISSUE: TL-PARTIAL-BOLD | TARGET: staff-engineer\nNO ISSUES | TARGET: qa-engineer**",
		],
	])("rejects %s during cross-examination", async (_description, response) => {
		const result = await runAnsteelDiscussion({
			topic: "Reject non-whole-line bold markers",
			runRole: async ({ stage }) =>
				stage === "tech-lead-cross-examination" ? response : responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("invalid-challenge-ledger");
		expect(result.transcript.at(-1)?.stage).toBe("tech-lead-cross-examination");
	});

	it("rejects inline-code markers embedded in prose", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Reject embedded inline-code markers",
			runRole: async ({ stage }) =>
				responseForMutualReviewStage(stage, {
					"tech-lead-cross-examination":
						"The review says `ISSUE: TL-EMBEDDED | TARGET: staff-engineer` and `NO ISSUES | TARGET: qa-engineer`.",
					"staff-cross-examination":
						"The review says `ISSUE: STAFF-EMBEDDED | TARGET: qa-engineer` and `NO ISSUES | TARGET: tech-lead`.",
					"qa-cross-examination":
						"The review says `ISSUE: QA-EMBEDDED | TARGET: tech-lead` and `NO ISSUES | TARGET: staff-engineer`.",
					"architecture-revision": completeWorkCard("The review says `RESOLUTION: QA-EMBEDDED | RESOLVED`."),
					"staff-revision": completeWorkCard("The review says `RESOLUTION: TL-EMBEDDED | RESOLVED`."),
					"qa-revision": completeWorkCard("The review says `RESOLUTION: STAFF-EMBEDDED | RESOLVED`."),
				}),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("invalid-challenge-ledger");
		expect(result.transcript.at(-1)?.stage).toBe("tech-lead-cross-examination");
	});

	it("rejects a resolution marker embedded in inline-code prose", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Reject embedded inline-code resolutions",
			runRole: async ({ stage }) =>
				responseForMutualReviewStage(stage, {
					"staff-revision": completeWorkCard(
						"The revision says `RESOLUTION: TL-CROSS | RESOLVED`, but does not provide a whole-line marker.",
					),
				}),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("unanswered-challenge");
		expect(result.transcript.at(-1)?.stage).toBe("staff-revision");
		expect(result.markdown).toContain("did not answer open challenge IDs: TL-CROSS");
	});

	it.each([
		["a trailing space on an issue marker", "ISSUE: STAFF-STRICT "],
		["a trailing space on the no-issues marker", "NO ISSUES "],
	])("rejects %s before the collaborative revision", async (_description, staffCritique) => {
		const result = await runAnsteelDiscussion({
			topic: "Review strict challenge marker parsing",
			runRole: async ({ stage }) =>
				stage === "staff-cross-examination" ? staffCritique : responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("invalid-challenge-ledger");
		expect(result.transcript.at(-1)?.stage).toBe("staff-cross-examination");
	});

	it("accepts Markdown hard-break spaces on whole-line governance markers without format repair", async () => {
		const calls: Array<{ role: AnsteelRole; stage: AnsteelDiscussionStage; formatRepair?: true }> = [];
		const result = await runAnsteelDiscussion({
			topic: "Review Markdown hard-break challenge markers",
			runRole: async ({ role, stage, formatRepair }) => {
				calls.push({ role, stage, formatRepair });
				return responseForMutualReviewStage(stage, {
					"tech-lead-cross-examination":
						"ISSUE: TL-HARD-BREAK | TARGET: staff-engineer  \nNO ISSUES | TARGET: qa-engineer  ",
					"staff-cross-examination":
						"ISSUE: STAFF-HARD-BREAK | TARGET: qa-engineer  \nNO ISSUES | TARGET: tech-lead  ",
					"qa-cross-examination":
						"ISSUE: QA-HARD-BREAK | TARGET: tech-lead  \nNO ISSUES | TARGET: staff-engineer  ",
					"architecture-revision": completeWorkCard("RESOLUTION: QA-HARD-BREAK | RESOLVED"),
					"staff-revision": completeWorkCard("RESOLUTION: TL-HARD-BREAK | RESOLVED"),
					"qa-revision": completeWorkCard("RESOLUTION: STAFF-HARD-BREAK | RESOLVED"),
					"tech-lead-verification": "VERDICT: APPROVE  ",
					"staff-verification": "VERDICT: APPROVE  ",
					"qa-verification": "VERDICT: APPROVE  ",
					"staff-sign-off": "VERDICT: APPROVE  ",
					"qa-sign-off": "VERDICT: APPROVE  ",
				});
			},
		});

		expect(result.verdict).toBe("approved");
		expect(calls.filter((call) => call.formatRepair)).toEqual([]);
	});

	it("rejects a resolution marker with trailing whitespace before verification", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review strict resolution marker parsing",
			runRole: async ({ stage }) =>
				stage === "staff-revision"
					? completeWorkCard("RESOLUTION: TL-CROSS | RESOLVED ")
					: responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("unanswered-challenge");
		expect(result.transcript.at(-1)?.stage).toBe("staff-revision");
	});

	it("rejects a verification rejection that does not add a new issue", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review an unsupported verification rejection",
			runRole: async ({ stage }) =>
				stage === "qa-verification" ? "VERDICT: REJECT\nNO ISSUES" : responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.consensus).toBeUndefined();
		expect(result.terminationReason).toBe("invalid-challenge-ledger");
		expect(result.markdown).toContain("qa-engineer rejected the revised work cards without adding a new ISSUE line");
	});

	it("returns a targeted QA verification rejection to a second collaborative revision before consensus", async () => {
		const calls: Array<{ role: AnsteelRole; stage: AnsteelDiscussionStage; round?: number }> = [];

		const result = await runAnsteelDiscussion({
			topic: "Review the motor safety change",
			runRole: async ({ role, stage, round }) => {
				calls.push({ role, stage, round });
				if (stage === "qa-verification" && round === 1) {
					return "VERDICT: REJECT\nISSUE: QA-VERIFICATION-1 | TARGET: staff-engineer\n[L1] The safety test is absent.";
				}
				if (stage === "staff-revision" && round === 2) {
					return completeWorkCard("RESOLUTION: QA-VERIFICATION-1 | RESOLVED");
				}
				if ((stage === "architecture-revision" || stage === "qa-revision") && round === 2) {
					return completeWorkCard("[L2] No newly assigned challenge.");
				}
				return responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("approved");
		expect(result.revisionRounds).toEqual([
			{
				round: 1,
				techLeadVerdict: "approved",
				staffVerdict: "approved",
				qaVerdict: "rejected",
				outcome: "needs-revision",
				newIssues: 1,
				resolvedIssues: 3,
				extension: "within the baseline revision rounds",
			},
			{
				round: 2,
				techLeadVerdict: "approved",
				staffVerdict: "approved",
				qaVerdict: "approved",
				outcome: "approved",
				newIssues: 0,
				resolvedIssues: 1,
			},
		]);
		expect(calls.filter((call) => call.stage === "staff-revision")).toHaveLength(2);
		expect(calls.map(({ role, stage }) => `${role}:${stage}`)).toContain("tech-lead:consensus");
		expect(result.markdown).toContain("QA-VERIFICATION-1");
	});

	it("rejects a bare QA verification issue before another revision", async () => {
		const calls: Array<{ role: AnsteelRole; stage: AnsteelDiscussionStage; round?: number }> = [];

		const result = await runAnsteelDiscussion({
			topic: "Review an unassigned verification issue",
			runRole: async ({ role, stage, round }) => {
				calls.push({ role, stage, round });
				if (stage === "qa-verification" && round === 1) return "VERDICT: REJECT\nISSUE: QA-BARE";
				return responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("invalid-challenge-ledger");
		expect(calls.some((call) => call.round === 2)).toBe(false);
		expect(calls.map(({ role, stage }) => `${role}:${stage}`)).not.toContain("tech-lead:consensus");
	});

	it("runs consensus only after independent verification and keeps the discussion transcript", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review the parser",
			runRole: async ({ stage }) =>
				responseForMutualReviewStage(stage, {
					architecture: completeWorkCard("[L1] Tech Lead parser work card"),
					"qa-verification":
						"[L2] Conditions met before the decision\nVERDICT: APPROVE\n[L2] Follow-up remains after the decision",
					consensus:
						"[L2] Consensus \n<verification-method>\nL2 cross-checked with a second implementation.\n</verification-method>",
				}),
		});

		expect(result.verdict).toBe("approved");
		expect(result.consensus).toBe(
			"[L2] Consensus \n<verification-method>\nL2 cross-checked with a second implementation.\n</verification-method>",
		);
		expect(result.markdown).toContain("[L1] Tech Lead parser work card");
		expect(result.markdown).toContain("TL-CROSS");
		expect(result.markdown).toContain("STAFF-CROSS");
		expect(result.markdown).toContain("QA-CROSS");
		expect(result.markdown).toContain(
			"## Tech Lead Consensus\n\n[L2] Consensus \n<verification-method>\nL2 cross-checked with a second implementation.\n</verification-method>\n",
		);
	});

	it("gives consensus and final sign-offs the same coordinator-generated ledger summary", async () => {
		const prompts = new Map<AnsteelDiscussionStage, string>();

		const result = await runAnsteelDiscussion({
			topic: "Review immutable ledger summary delivery",
			runRole: async ({ stage, prompt }) => {
				prompts.set(stage, prompt);
				return responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("approved");
		expect(result.immutableLedgerSummary).toContain("- Total recorded challenges: 3");
		expect(result.immutableLedgerSummary).toContain("- Resolved challenges: 3");
		expect(result.immutableLedgerSummary).toContain("- Open challenges: 0");
		for (const stage of ["consensus", "staff-sign-off", "qa-sign-off"] as const) {
			const prompt = prompts.get(stage) ?? "";
			expect(prompt).toContain("## Immutable Challenge Ledger Summary");
			expect(prompt).toContain("- Total recorded challenges: 3");
			expect(prompt).toContain("Do not state a numeric ledger-entry or ledger-challenge total yourself.");
		}
		expect(result.markdown).toContain("## Immutable Challenge Ledger Summary");
	});

	it("rejects a consensus that writes an inconsistent ledger count", async () => {
		const calls: Array<{ role: AnsteelRole; stage: AnsteelDiscussionStage }> = [];

		const result = await runAnsteelDiscussion({
			topic: "Reject a hallucinated consensus ledger count",
			runRole: async ({ role, stage }) => {
				calls.push({ role, stage });
				return stage === "consensus"
					? "[L1] Consensus\nAll 2 ledger entries are resolved."
					: responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("invalid-ledger-summary");
		expect(result.consensus).toBeUndefined();
		expect(result.markdown).toContain("- Total recorded challenges: 3");
		expect(calls.map(({ role, stage }) => `${role}:${stage}`)).not.toContain("staff-engineer:staff-sign-off");
	});

	it("rejects a final sign-off that writes a ledger count instead of citing the immutable summary", async () => {
		const calls: Array<{ role: AnsteelRole; stage: AnsteelDiscussionStage }> = [];

		const result = await runAnsteelDiscussion({
			topic: "Reject a hallucinated final sign-off ledger count",
			runRole: async ({ role, stage }) => {
				calls.push({ role, stage });
				return stage === "staff-sign-off"
					? "All 2 ledger challenges are resolved.\nVERDICT: APPROVE"
					: responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("final-sign-off-rejected");
		expect(result.consensus).toBe("[L1] Immutable consensus\n<verification-method>\nL1 confirmed by an independent numerical check.\n</verification-method>");
		expect(result.markdown).toContain("- Total recorded challenges: 3");
		expect(calls.map(({ role, stage }) => `${role}:${stage}`)).toContain("staff-engineer:staff-sign-off");
		expect(result.transcript.some((entry) => entry.stage === "qa-sign-off")).toBe(false);
	});

	it("requires Staff and QA final sign-off on the immutable Tech Lead consensus", async () => {
		const calls: Array<{ role: AnsteelRole; stage: AnsteelDiscussionStage; prompt: string }> = [];

		const result = await runAnsteelDiscussion({
			topic: "Review final governance sign-off",
			runRole: async ({ role, stage, prompt }) => {
				calls.push({ role, stage, prompt });
				return responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("approved");
		expect(result.consensus).toBe("[L1] Immutable consensus\n<verification-method>\nL1 confirmed by an independent numerical check.\n</verification-method>");
		expect(calls.map(({ role, stage }) => `${role}:${stage}`)).toEqual(
			MUTUAL_REVIEW_STAGE_ORDER.map(({ role, stage }) => `${role}:${stage}`),
		);
		for (const stage of ["staff-sign-off", "qa-sign-off"] as const) {
			const prompt = calls.find((call) => call.stage === stage)?.prompt ?? "";
			expect(prompt).toContain("[L1] Immutable consensus");
			expect(prompt).toContain("immutable");
		}
	});

	it.each([
		["Staff Engineer", "staff-engineer", "staff-sign-off", "VERDICT: APPROVE "],
		["QA Engineer", "qa-engineer", "qa-sign-off", "VERDICT: APPROVE "],
	] as const)(
		"rejects a non-exact final %s sign-off without presenting an unratified consensus as a conclusion",
		async (_name, rejectedRole, rejectedStage, rejectedResponse) => {
			const calls: Array<{ role: AnsteelRole; stage: string }> = [];

			const result = await runAnsteelDiscussion({
				topic: "Review strict final governance sign-off",
				runRole: async ({ role, stage }) => {
					calls.push({ role, stage });
					if (role === rejectedRole && stage === rejectedStage) return rejectedResponse;
					return responseForMutualReviewStage(stage);
				},
			});

			expect(result.verdict).toBe("rejected");
			expect(result.consensus).toBe("[L1] Immutable consensus\n<verification-method>\nL1 confirmed by an independent numerical check.\n</verification-method>");
			expect(result.markdown).not.toContain("## Tech Lead Consensus");
			expect(result.markdown).toContain("- Governance result: REJECTED");
			expect(result.transcript.at(-1)).toMatchObject({ role: rejectedRole, stage: rejectedStage });
		},
	);

	it("repairs a consensus without an independent verification method once, then accepts it", async () => {
		let consensusCalls = 0;
		const result = await runAnsteelDiscussion({
			topic: "Review the independent verification method gate",
			runRole: async ({ stage }) => {
				if (stage === "consensus") {
					consensusCalls += 1;
					return consensusCalls === 1
						? "[L1] Consensus without an independent method"
						: "[L1] Consensus without an independent method\n<verification-method>\nL1 confirmed by exhaustive enumeration in a second implementation.\n</verification-method>";
				}
				return responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("approved");
		expect(consensusCalls).toBe(2);
		expect(result.consensus).toBe(
			"[L1] Consensus without an independent method\n<verification-method>\nL1 confirmed by exhaustive enumeration in a second implementation.\n</verification-method>",
		);
	});

	it("rejects a consensus that still lacks an independent verification method after the format repair", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Reject consensus without an independent verification method",
			runRole: async ({ stage }) =>
				stage === "consensus" ? "[L1] Consensus still without any verification method" : responseForMutualReviewStage(stage),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("consensus-verification-method-missing");
		expect(result.consensus).toBeUndefined();
		expect(result.markdown).toContain("- Governance result: REJECTED");
		expect(result.markdown).toContain("<verification-method>");
	});

	it("sends every role explicit L2-L4 confidence discipline", async () => {
		const prompts = new Map<AnsteelRole, string[]>();

		const result = await runAnsteelDiscussion({
			topic: "Review confidence discipline",
			runRole: async ({ role, stage, prompt }) => {
				const rolePrompts = prompts.get(role) ?? [];
				rolePrompts.push(prompt);
				prompts.set(role, rolePrompts);
				return responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("approved");
		for (const role of ["tech-lead", "staff-engineer", "qa-engineer"] as const) {
			const prompt = prompts.get(role)?.[0] ?? "";
			expect(prompt).toContain("L1 requires concrete evidence.");
			expect(prompt).toContain("L2 requires a stated technical basis.");
			expect(prompt).toContain("L3 requires a concrete verification method.");
			expect(prompt).toContain("L4 requires an explicit statement of what is unknown and no conclusion.");
		}
	});

	it.each([
		["a lower-case marker", "verdict: approve"],
		["a split-line marker", "VERDICT:\nAPPROVE"],
		["a missing verdict marker", "[L1] QA completed its review but omitted the required decision"],
		["a marker with trailing whitespace", "VERDICT: APPROVE "],
		["duplicate approval markers", "VERDICT: APPROVE\nVERDICT: APPROVE"],
		["contradictory markers", "VERDICT: APPROVE\nVERDICT: REJECT"],
		["a bullet-list contradiction", "VERDICT: APPROVE\n- VERDICT: REJECT"],
		["a Markdown-heading contradiction", "VERDICT: APPROVE\n## VERDICT: REJECT"],
		["a pending marker after approval", "VERDICT: APPROVE\nVERDICT PENDING"],
		["an isolated pending marker", "VERDICT PENDING"],
	])("rejects %s in QA verification without running consensus", async (_description, qaVerdict) => {
		const calls: Array<{ role: AnsteelRole; stage: AnsteelDiscussionStage }> = [];

		const result = await runAnsteelDiscussion({
			topic: "Review the QA gate",
			runRole: async ({ role, stage }) => {
				calls.push({ role, stage });
				return stage === "qa-verification" ? qaVerdict : responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.consensus).toBeUndefined();
		expect(result.terminationReason).toBe("invalid-verdict");
		expect(calls.map(({ role, stage }) => `${role}:${stage}`)).not.toContain("tech-lead:consensus");
	});

	it("accepts prose mentions of VERDICT markers when exactly one standalone verdict is present", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review quoted marker prose",
			runRole: async ({ role, stage }) => {
				if (stage !== "qa-verification") return responseForMutualReviewStage(stage);
				return [
					"In every verification response emit exactly one `VERDICT: APPROVE` or `VERDICT: REJECT` marker as the final standalone line.",
					"The audit found no `VERDICT:` marker in any work card.",
					"VERDICT: APPROVE",
				].join("\n");
			},
		});

		expect(result.verdict).toBe("approved");
		expect(result.consensus).toBeDefined();
		expect(result.terminationReason).toBeUndefined();
	});

	it("repairs a missing required section in an initial work card", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review initial card section repair",
			runRole: async ({ role, stage, prompt }) => {
				if (stage === "architecture" && !prompt.includes("Format repair constraint")) {
					return `[L2] Tech Lead work card\n\n${INCOMPLETE_WORK_CARD}`;
				}
				return responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("approved");
		expect(result.terminationReason).toBeUndefined();
	});

	it("repairs a missing required section in a revision work card", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review revision card section repair",
			runRole: async ({ role, stage, prompt }) => {
				if (stage === "qa-revision" && !prompt.includes("Format repair constraint")) {
					return `RESOLUTION: STAFF-CROSS | RESOLVED\n[L2] QA revised work card\n\n${INCOMPLETE_REVISION_WORK_CARD}`;
				}
				return responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("approved");
		expect(result.consensus).toBeDefined();
		expect(result.terminationReason).toBeUndefined();
	});

	it("rejects a work card that still misses a required section after repair", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review persistent missing section",
			runRole: async ({ role, stage }) => {
				if (stage === "qa-revision") {
					return `RESOLUTION: STAFF-CROSS | RESOLVED\n[L2] QA revised work card\n\n${INCOMPLETE_REVISION_WORK_CARD}`;
				}
				return responseForMutualReviewStage(stage);
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.terminationReason).toBe("incomplete-work-card");
		expect(result.consensus).toBeUndefined();
	});

	it.each([
		["tech-lead", "architecture"],
		["staff-engineer", "staff-critique"],
		["qa-engineer", "qa-critique"],
		["tech-lead", "architecture-revision"],
		["staff-engineer", "staff-verification"],
		["qa-engineer", "qa-verification"],
		["tech-lead", "consensus"],
		["staff-engineer", "staff-sign-off"],
		["qa-engineer", "qa-sign-off"],
	] as const)(
		"rejects a whitespace-only %s / %s response without running later stages",
		async (blankRole, blankStage) => {
			const stageOrder = MUTUAL_REVIEW_STAGE_ORDER;
			const rawWhitespace = " \t \r\n";
			const calls: Array<{ role: AnsteelRole; stage: AnsteelDiscussionStage }> = [];
			const blankIndex = stageOrder.findIndex(({ role, stage }) => role === blankRole && stage === blankStage);

			const result = await runAnsteelDiscussion({
				topic: "Review empty role output",
				runRole: async ({ role, stage }) => {
					calls.push({ role, stage });
					if (role === blankRole && stage === blankStage) return rawWhitespace;
					return responseForMutualReviewStage(stage);
				},
			});

			expect(result.verdict).toBe("rejected");
			expect(result.consensus).toBe(
				blankIndex > stageOrder.findIndex(({ stage }) => stage === "consensus")
					? "[L1] Immutable consensus\n<verification-method>\nL1 confirmed by an independent numerical check.\n</verification-method>"
					: undefined,
			);
			// Parallel groups invoke every independent member; archiving keeps protocol order.
			const parallelGroupEnd: Record<string, number> = {
				"staff-critique": 2,
				"staff-verification": 11,
				"staff-sign-off": 14,
			};
			const expectedEnd = Math.max(blankIndex, parallelGroupEnd[blankStage] ?? blankIndex);
			expect(calls).toEqual(stageOrder.slice(0, expectedEnd + 1));
			expect(result.transcript.at(-1)?.response).toBe(rawWhitespace);
			expect(result.markdown).toContain(
				`${blankRole} / ${blankStage} returned an empty or whitespace-only response`,
			);
			expect(result.markdown).toContain(rawWhitespace);
		},
	);

	it("archives a failed stage without inventing a role response or running later stages", async () => {
		const calls: Array<{ role: AnsteelRole; stage: AnsteelDiscussionStage }> = [];

		const result = await runAnsteelDiscussion({
			topic: "Review a failed provider call",
			runRole: async ({ role, stage }) => {
				calls.push({ role, stage });
				if (role === "staff-engineer" && stage === "staff-critique") {
					throw new Error("provider connection closed");
				}
				return completeWorkCard("[L1] Architecture evidence ");
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.consensus).toBeUndefined();
		expect(result.failure).toEqual({
			role: "staff-engineer",
			stage: "staff-critique",
			reason: "provider connection closed",
		});
		expect(result.transcript).toEqual([
			expect.objectContaining({
				role: "tech-lead",
				stage: "architecture",
				response: completeWorkCard("[L1] Architecture evidence "),
			}),
		]);
		expect(calls).toEqual([
			{ role: "tech-lead", stage: "architecture" },
			{ role: "staff-engineer", stage: "staff-critique" },
			{ role: "qa-engineer", stage: "qa-critique" },
		]);
		expect(result.markdown).toContain("## Stage Failure");
		expect(result.markdown).toContain("- Failed role: staff-engineer");
		expect(result.markdown).toContain("- Failed stage: staff-critique");
		expect(result.markdown).toContain("- Reason: provider connection closed");
	});

	it("disables model-visible tools only during cross-examination stages", async () => {
		type TestModel = { provider: string; id: string };
		const calls: Array<{ role: AnsteelRole; stage: AnsteelDiscussionStage; toolsEnabled: boolean | undefined }> = [];

		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Review cross-examination tool isolation",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ role }) => ({
				prompt: async (prompt, options) => {
					const stage = getStageFromPrompt(prompt);
					calls.push({ role, stage, toolsEnabled: options?.toolsEnabled });
					return responseForMutualReviewStage(stage);
				},
				dispose: () => {},
			}),
		});

		expect(result.verdict).toBe("approved");
		expect(calls.filter((call) => call.stage.includes("cross-examination")).map((call) => call.toolsEnabled)).toEqual(
			[false, false, false],
		);
		expect(
			calls.filter((call) => !call.stage.includes("cross-examination")).every((call) => call.toolsEnabled === true),
		).toBe(true);
	});

	it("archives a project-session prompt failure and disposes every created session", async () => {
		type TestModel = { provider: string; id: string };
		const prompts: Array<{ role: AnsteelRole; prompt: string }> = [];
		const created: AnsteelRole[] = [];
		const disposed: AnsteelRole[] = [];

		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Review a failed role session",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ role }) => {
				created.push(role);
				return {
					prompt: async (prompt) => {
						prompts.push({ role, prompt });
						if (role === "staff-engineer") throw new Error("role session timed out");
						return completeWorkCard("[L1] Architecture evidence ");
					},
					dispose: () => {
						disposed.push(role);
					},
				};
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.consensus).toBeUndefined();
		expect(result.failure).toEqual({
			role: "staff-engineer",
			stage: "staff-critique",
			reason: "role session timed out",
		});
		expect(result.transcript).toEqual([
			expect.objectContaining({
				role: "tech-lead",
				stage: "architecture",
				response: completeWorkCard("[L1] Architecture evidence "),
			}),
		]);
		expect(prompts.map(({ role }) => role)).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
		expect(prompts.some(({ prompt }) => prompt.includes("Current stage: consensus."))).toBe(false);
		expect(created).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
		expect(disposed).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
	});

	// The assertion below exercises a 20ms protocol timeout. Its outer allowance
	// only covers TypeScript transform and Windows scheduler delay; it is not a
	// relaxation of the stage-timeout behavior under test.
	it("returns an auditable rejection when a project-stage prompt exceeds its timeout", async () => {
		type TestModel = { provider: string; id: string };
		const aborted: AnsteelRole[] = [];
		const disposed: AnsteelRole[] = [];
		let rejectStaffPrompt: ((reason?: unknown) => void) | undefined;

		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Review a hung role session",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
				stageTimeoutMs: 20,
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ role }) => {
				const session = {
					prompt: async () => {
						if (role === "staff-engineer") {
							return await new Promise<string>((_resolve, reject) => {
								rejectStaffPrompt = reject;
							});
						}
						return completeWorkCard("[L1] Architecture evidence");
					},
					abort: () => {
						aborted.push(role);
						if (role === "staff-engineer") rejectStaffPrompt?.(new Error("session aborted after timeout"));
					},
					dispose: () => {
						disposed.push(role);
					},
					getLastStageAudit: () => ({
						events: [
							{ type: "stage-prompt-start" as const, elapsedMs: 0 },
							{ type: "tool-execution-start" as const, elapsedMs: 1, toolName: "find" },
						],
					}),
				};
				return session;
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.consensus).toBeUndefined();
		expect(result.terminationReason).toBe("stage-timeout");
		expect(result.failure).toEqual({
			role: "staff-engineer",
			stage: "staff-critique",
			reason: "Stage exceeded the configured timeout of 20ms",
			timeoutMs: 20,
		});
		expect(aborted).toEqual(["staff-engineer"]);
		expect(disposed).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
		expect(result.markdown).toContain("- Termination reason: stage-timeout");
		expect(result.markdown).toContain("- Timeout: 20ms");
		expect(result.markdown).toContain("## Stage Audit Trail");
		expect(result.markdown).toContain("tool-execution-start: find");
		expect((result as typeof result & { stageAudits?: unknown }).stageAudits).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "staff-engineer",
					stage: "staff-critique",
					events: expect.arrayContaining([expect.objectContaining({ toolName: "find" })]),
				}),
			]),
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
	}, 10_000);

	it("archives timeout and abort events that arrive asynchronously", async () => {
		type TestModel = { provider: string; id: string };
		const staffAgentEvents = createAgentEventEmitter();
		const staffAssistantMessages = createAssistantMessageEmitter();
		let rejectStaffPrompt: ((reason?: unknown) => void) | undefined;

		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Archive timeout abort audit",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
				stageTimeoutMs: 20,
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ role }) => {
				if (role !== "staff-engineer") {
					return { prompt: async () => completeWorkCard("[L1] Architecture evidence"), dispose: () => {} };
				}

				return createAnsteelRawTurnSession({
					prompt: async () =>
						await new Promise<void>((_resolve, reject) => {
							rejectStaffPrompt = reject;
						}),
					subscribeToAssistantMessageEnd: staffAssistantMessages.subscribe,
					subscribeToAgentEvent: staffAgentEvents.subscribe,
					abort: async () => {
						await Promise.resolve();
						staffAgentEvents.emit({
							type: "tool_execution_end",
							toolCallId: "abort-read",
							toolName: "read",
							isError: true,
						});
						staffAssistantMessages.emit({
							role: "assistant",
							content: [],
							stopReason: "error",
							errorMessage: "aborted after timeout",
						});
						rejectStaffPrompt?.(new Error("session aborted after timeout"));
					},
					dispose: () => {},
				});
			},
		});

		const audit = result.stageAudits.find(
			(candidate) => candidate.role === "staff-engineer" && candidate.stage === "staff-critique",
		);
		expect(audit?.events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "stage-timeout" }),
				expect.objectContaining({ type: "tool-execution-end", toolName: "read", isError: true }),
				expect.objectContaining({ type: "assistant-message-end", stopReason: "error" }),
			]),
		);
	});

	it("does not wait indefinitely for a timed-out role abort", async () => {
		type TestModel = { provider: string; id: string };
		let failTimeout: ReturnType<typeof setTimeout> | undefined;
		try {
			const result = await Promise.race([
				runAnsteelProjectReview<TestModel>({
					topic: "Bound a hung timeout abort",
					cwd: process.cwd(),
					config: {
						roles: {
							"tech-lead": { model: "tech/lead", tools: ["read"] },
							"staff-engineer": { model: "staff/engineer", tools: ["read"] },
							"qa-engineer": { model: "qa/engineer", tools: ["read"] },
						},
						reportDirectory: "unused",
						stageTimeoutMs: 20,
					},
					resolveModel: (provider, id) => ({ provider, id }),
					createRoleSession: async ({ role }) => ({
						prompt: async () => {
							if (role === "staff-engineer") return await new Promise<string>(() => {});
							return completeWorkCard("[L1] Architecture evidence");
						},
						abort: () => {
							if (role === "staff-engineer") return new Promise<void>(() => {});
						},
						dispose: () => {},
					}),
				}),
				new Promise<never>((_resolve, reject) => {
					failTimeout = setTimeout(() => reject(new Error("Timed-out role abort was not bounded")), 1_000);
				}),
			]);

			expect(result.failure).toEqual({
				role: "staff-engineer",
				stage: "staff-critique",
				reason: "Stage exceeded the configured timeout of 20ms",
				timeoutMs: 20,
			});
		} finally {
			if (failTimeout) clearTimeout(failTimeout);
		}
	});

	it("preserves a rejected prompt failure when session cleanup also fails", async () => {
		type TestModel = { provider: string; id: string };
		const disposed: AnsteelRole[] = [];

		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Review cleanup after a failed role prompt",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ role }) => ({
				prompt: async () => {
					if (role === "staff-engineer") throw new Error("role session timed out");
					return completeWorkCard("[L1] Architecture evidence");
				},
				dispose: () => {
					disposed.push(role);
					if (role === "tech-lead") {
						throw new Error("tech-lead cleanup failed Authorization: Bearer sk-unit-test-cleanup-secret");
					}
					if (role === "staff-engineer") throw new Error("staff-engineer cleanup failed");
				},
			}),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.failure).toEqual({
			role: "staff-engineer",
			stage: "staff-critique",
			reason: "role session timed out",
		});
		expect(result.transcript).toEqual([
			expect.objectContaining({
				role: "tech-lead",
				stage: "architecture",
				response: completeWorkCard("[L1] Architecture evidence"),
			}),
		]);
		expect(disposed).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
		expect(result.cleanupFailures).toEqual([
			{ role: "tech-lead", reason: "tech-lead cleanup failed Authorization: Bearer [REDACTED]" },
			{ role: "staff-engineer", reason: "staff-engineer cleanup failed" },
		]);
		expect(result.markdown).toContain("## Session Cleanup Failures");
		expect(result.markdown).toContain("- tech-lead: tech-lead cleanup failed Authorization: Bearer [REDACTED]");
		expect(result.markdown).not.toContain("sk-unit-test-cleanup-secret");
		expect(result.markdown).toContain("- staff-engineer: staff-engineer cleanup failed");
	});

	it("keeps a rejected review and completes cleanup when cleanup error formatting throws", async () => {
		type TestModel = { provider: string; id: string };
		const disposed: AnsteelRole[] = [];
		const throwingCoercion = {
			toString: () => {
				throw new Error("cleanup coercion failed");
			},
		};
		const throwingMessageGetter = new Error("hidden cleanup failure");
		Object.defineProperty(throwingMessageGetter, "message", {
			configurable: true,
			get: () => {
				throw new Error("cleanup message getter failed");
			},
		});

		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Review cleanup error boundaries",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ role }) => ({
				prompt: async () => {
					if (role === "staff-engineer") throw new Error("provider request failed");
					return completeWorkCard("[L1] Architecture evidence");
				},
				dispose: () => {
					disposed.push(role);
					if (role === "tech-lead") throw throwingCoercion;
					if (role === "staff-engineer") throw throwingMessageGetter;
				},
			}),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.failure).toEqual({
			role: "staff-engineer",
			stage: "staff-critique",
			reason: "provider request failed",
		});
		expect(disposed).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
		expect(result.cleanupFailures).toEqual([
			{ role: "tech-lead", reason: "Unknown role failure" },
			{ role: "staff-engineer", reason: "Unknown role failure" },
		]);
		expect(result.markdown).toContain("## Session Cleanup Failures");
		expect(result.markdown).toContain("- tech-lead: Unknown role failure");
		expect(result.markdown).toContain("- staff-engineer: Unknown role failure");
	});

	it("preserves a role-session setup failure over cleanup failures", async () => {
		type TestModel = { provider: string; id: string };
		const disposed: AnsteelRole[] = [];

		await expect(
			runAnsteelProjectReview<TestModel>({
				topic: "Review a role-session setup failure",
				cwd: process.cwd(),
				config: {
					roles: {
						"tech-lead": { model: "tech/lead", tools: ["read"] },
						"staff-engineer": { model: "staff/engineer", tools: ["read"] },
						"qa-engineer": { model: "qa/engineer", tools: ["read"] },
					},
					reportDirectory: "unused",
				},
				resolveModel: (provider, id) => ({ provider, id }),
				createRoleSession: async ({ role }) => {
					if (role === "staff-engineer") throw new Error("staff-engineer setup failed");
					return {
						prompt: async () => "[L1] Scope evidence",
						dispose: () => {
							disposed.push(role);
							throw new Error("tech-lead cleanup failed");
						},
					};
				},
			}),
		).rejects.toThrow("staff-engineer setup failed");

		expect(disposed).toEqual(["tech-lead"]);
	});

	it("loads independent role models with evidence tools for every role", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-"));
		temporaryDirectories.push(cwd);
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(
			join(cwd, ".pi", "ansteel.json"),
			JSON.stringify({
				roles: {
					"tech-lead": { model: "anthropic/claude-sonnet" },
					"staff-engineer": { model: "openai/gpt-5", thinkingLevel: "high" },
					"qa-engineer": { model: "deepseek/deepseek-chat" },
				},
			}),
		);

		const config = loadAnsteelConfig(cwd);

		expect(config.roles["tech-lead"].model).toBe("anthropic/claude-sonnet");
		expect(config.roles["staff-engineer"].model).toBe("openai/gpt-5");
		expect(config.roles["staff-engineer"].thinkingLevel).toBe("high");
		expect(config.roles["qa-engineer"].model).toBe("deepseek/deepseek-chat");
		expect(config.roles["qa-engineer"].tools).toEqual(["read", "grep", "find", "ls", "bash"]);
		expect(config.roles["qa-engineer"].teamTools).toEqual(["read", "grep", "find", "ls", "bash", "edit", "write"]);
		expect(config.teamTaskOwners).toEqual(["staff-engineer"]);
		expect(config.stageTimeoutMs).toBe(120_000);
		expect(config.maxToolCallsPerStage).toBe(4);
	});

	it("loads an enabled adaptive budget policy with protected verification reserves", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-"));
		temporaryDirectories.push(cwd);
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(
			join(cwd, ".pi", "ansteel.json"),
			JSON.stringify({
				adaptiveBudgetPolicy: {
					enabled: true,
					projectTimeoutMs: 900_000,
					maxProjectToolCalls: 96,
					protectedVerificationTimeMs: 360_000,
					protectedVerificationToolCalls: 24,
				},
				roles: {
					"tech-lead": { model: "anthropic/claude-sonnet" },
					"staff-engineer": { model: "openai/gpt-5" },
					"qa-engineer": { model: "deepseek/deepseek-chat" },
				},
			}),
		);

		const config = loadAnsteelConfig(cwd);

		expect(config.adaptiveBudgetPolicy).toMatchObject({
			enabled: true,
			projectTimeoutMs: 900_000,
			maxProjectToolCalls: 96,
			protectedVerificationTimeMs: 360_000,
			protectedVerificationToolCalls: 24,
		});
	});

	it("treats a disabled adaptive budget policy as the legacy fixed-budget path", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-"));
		temporaryDirectories.push(cwd);
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(
			join(cwd, ".pi", "ansteel.json"),
			JSON.stringify({
				adaptiveBudgetPolicy: { enabled: false },
				roles: {
					"tech-lead": { model: "anthropic/claude-sonnet" },
					"staff-engineer": { model: "openai/gpt-5" },
					"qa-engineer": { model: "deepseek/deepseek-chat" },
				},
			}),
		);

		expect(loadAnsteelConfig(cwd).adaptiveBudgetPolicy).toBeUndefined();
	});

	it("loads explicitly authorized interactive task owners", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-"));
		temporaryDirectories.push(cwd);
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(
			join(cwd, ".pi", "ansteel.json"),
			JSON.stringify({
				teamTaskOwners: ["staff-engineer", "tech-lead"],
				roles: {
					"tech-lead": { model: "anthropic/claude-sonnet" },
					"staff-engineer": { model: "openai/gpt-5" },
					"qa-engineer": { model: "deepseek/deepseek-chat" },
				},
			}),
		);

		expect(loadAnsteelConfig(cwd).teamTaskOwners).toEqual(["staff-engineer", "tech-lead"]);
	});

	it("loads bounded interactive task epoch controls", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-"));
		temporaryDirectories.push(cwd);
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(
			join(cwd, ".pi", "ansteel.json"),
			JSON.stringify({
				teamTaskMaxEpochs: 12,
				teamTaskMaxNoProgressEpochs: 3,
				roles: {
					"tech-lead": { model: "anthropic/claude-sonnet" },
					"staff-engineer": { model: "openai/gpt-5" },
					"qa-engineer": { model: "deepseek/deepseek-chat" },
				},
			}),
		);

		expect(loadAnsteelConfig(cwd)).toMatchObject({
			teamTaskMaxEpochs: 12,
			teamTaskMaxNoProgressEpochs: 3,
		});
	});

	it("rejects invalid interactive task epoch controls", () => {
		for (const controls of [
			{ teamTaskMaxEpochs: 0 },
			{ teamTaskMaxEpochs: 1 },
			{ teamTaskMaxEpochs: 129 },
			{ teamTaskMaxNoProgressEpochs: 0 },
			{ teamTaskMaxNoProgressEpochs: 9 },
			{ teamTaskMaxEpochs: 2, teamTaskMaxNoProgressEpochs: 3 },
		]) {
			const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-"));
			temporaryDirectories.push(cwd);
			mkdirSync(join(cwd, ".pi"));
			writeFileSync(
				join(cwd, ".pi", "ansteel.json"),
				JSON.stringify({
					...controls,
					roles: {
						"tech-lead": { model: "anthropic/claude-sonnet" },
						"staff-engineer": { model: "openai/gpt-5" },
						"qa-engineer": { model: "deepseek/deepseek-chat" },
					},
				}),
			);

			expect(() => loadAnsteelConfig(cwd)).toThrow("teamTaskMax");
		}
	});

	it("rejects invalid interactive task owner policies", () => {
		for (const teamTaskOwners of [[], ["staff-engineer", "staff-engineer"], ["unknown-role"]]) {
			const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-"));
			temporaryDirectories.push(cwd);
			mkdirSync(join(cwd, ".pi"));
			writeFileSync(
				join(cwd, ".pi", "ansteel.json"),
				JSON.stringify({
					teamTaskOwners,
					roles: {
						"tech-lead": { model: "anthropic/claude-sonnet" },
						"staff-engineer": { model: "openai/gpt-5" },
						"qa-engineer": { model: "deepseek/deepseek-chat" },
					},
				}),
			);

			expect(() => loadAnsteelConfig(cwd)).toThrow("Ansteel config teamTaskOwners");
		}
	});

	it("loads role-local memory and skill paths", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-"));
		temporaryDirectories.push(cwd);
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(
			join(cwd, ".pi", "ansteel.json"),
			JSON.stringify({
				roles: {
					"tech-lead": { model: "anthropic/claude-sonnet" },
					"staff-engineer": {
						model: "openai/gpt-5",
						memoryFile: ".pi/ansteel-memory/staff-engineer.md",
						skillPaths: [".pi/ansteel-skills/staff-engineer"],
					},
					"qa-engineer": { model: "deepseek/deepseek-chat" },
				},
			}),
		);

		const config = loadAnsteelConfig(cwd);

		expect(config.roles["staff-engineer"].memoryFile).toBe(join(cwd, ".pi", "ansteel-memory", "staff-engineer.md"));
		expect(config.roles["staff-engineer"].skillPaths).toEqual([join(cwd, ".pi", "ansteel-skills", "staff-engineer")]);
	});

	it("rejects role-local resources outside the reviewed project", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-"));
		temporaryDirectories.push(cwd);
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(
			join(cwd, ".pi", "ansteel.json"),
			JSON.stringify({
				roles: {
					"tech-lead": { model: "anthropic/claude-sonnet" },
					"staff-engineer": { model: "openai/gpt-5", memoryFile: "../other-project/memory.md" },
					"qa-engineer": { model: "deepseek/deepseek-chat" },
				},
			}),
		);

		expect(() => loadAnsteelConfig(cwd)).toThrow("Ansteel role resources must stay inside the reviewed project");
	});

	it("rejects a stage timeout that cannot enforce a bounded review", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-"));
		temporaryDirectories.push(cwd);
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(
			join(cwd, ".pi", "ansteel.json"),
			JSON.stringify({
				stageTimeoutMs: 0,
				roles: {
					"tech-lead": { model: "anthropic/claude-sonnet" },
					"staff-engineer": { model: "openai/gpt-5" },
					"qa-engineer": { model: "deepseek/deepseek-chat" },
				},
			}),
		);

		expect(() => loadAnsteelConfig(cwd)).toThrow("Ansteel stageTimeoutMs must be an integer between 1");
	});

	it("rejects an Ansteel tool budget that cannot bound a role stage", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-"));
		temporaryDirectories.push(cwd);
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(
			join(cwd, ".pi", "ansteel.json"),
			JSON.stringify({
				maxToolCallsPerStage: 0,
				roles: {
					"tech-lead": { model: "anthropic/claude-sonnet" },
					"staff-engineer": { model: "openai/gpt-5" },
					"qa-engineer": { model: "deepseek/deepseek-chat" },
				},
			}),
		);

		expect(() => loadAnsteelConfig(cwd)).toThrow("Ansteel maxToolCallsPerStage must be an integer between 1");
	});

	it("requires a project-local Ansteel configuration", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-"));
		temporaryDirectories.push(cwd);

		expect(() => loadAnsteelConfig(cwd)).toThrow(`Ansteel governance requires ${join(cwd, ".pi", "ansteel.json")}`);
	});

	it("rejects a configured report directory outside the reviewed project", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-"));
		temporaryDirectories.push(cwd);
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(
			join(cwd, ".pi", "ansteel.json"),
			JSON.stringify({
				reportDirectory: "../outside-ansteel-reports",
				roles: {
					"tech-lead": { model: "anthropic/claude-sonnet" },
					"staff-engineer": { model: "openai/gpt-5" },
					"qa-engineer": { model: "deepseek/deepseek-chat" },
				},
			}),
		);

		expect(() => loadAnsteelConfig(cwd)).toThrow("Ansteel reportDirectory must stay inside the reviewed project");
	});

	it("requires an explicit model for every governance role before creating sessions", async () => {
		type TestModel = { provider: string; id: string };
		let createdSessionCount = 0;

		const review = runAnsteelProjectReview<TestModel>({
			topic: "Review mandatory role models",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "claude/sonnet", tools: ["read"] },
					"staff-engineer": { tools: ["read"] },
					"qa-engineer": { model: "deepseek/chat", tools: ["read"] },
				},
				reportDirectory: "unused",
			} as unknown as AnsteelConfig,
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async () => {
				createdSessionCount++;
				return {
					prompt: async () => "[L2] Unexpected role response",
					dispose: () => {},
				};
			},
		});

		await expect(review).rejects.toMatchObject({
			name: "AnsteelGovernanceSetupError",
			phase: "configuration",
			role: "staff-engineer",
		});
		await expect(review).rejects.toThrow("Ansteel role staff-engineer requires an explicit provider/model");

		expect(createdSessionCount).toBe(0);
	});

	it("permits duplicate role models only when single-model mode is explicit", async () => {
		type TestModel = { provider: string; id: string };
		const createdRoles: AnsteelRole[] = [];

		await runAnsteelProjectReview<TestModel>({
			topic: "Review explicit single-model mode",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "deepseek/deepseek-v4-pro", tools: ["read"] },
					"staff-engineer": { model: "deepseek/deepseek-v4-pro", tools: ["read"] },
					"qa-engineer": { model: "deepseek/deepseek-v4-pro", tools: ["read"] },
				},
				reportDirectory: "unused",
				allowSingleModel: true,
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ role }) => {
				createdRoles.push(role);
				return {
					prompt: async (prompt) => responseForMutualReviewStage(getStageFromPrompt(prompt)),
					dispose: () => {},
				};
			},
		});

		expect(createdRoles).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
	});

	it("rejects duplicate role models before creating governance sessions", async () => {
		type TestModel = { provider: string; id: string };
		let createdSessionCount = 0;

		await expect(
			runAnsteelProjectReview<TestModel>({
				topic: "Review duplicate role models",
				cwd: process.cwd(),
				config: {
					roles: {
						"tech-lead": { model: "shared/model", tools: ["read"] },
						"staff-engineer": { model: "shared/model", tools: ["read"] },
						"qa-engineer": { model: "qa/engineer", tools: ["read"] },
					},
					reportDirectory: "unused",
				},
				resolveModel: (provider, id) => ({ provider, id }),
				createRoleSession: async () => {
					createdSessionCount++;
					return {
						prompt: async () => "[L2] Unexpected role response",
						dispose: () => {},
					};
				},
			}),
		).rejects.toThrow(
			"Ansteel governance requires distinct role models: staff-engineer duplicates tech-lead (shared/model)",
		);

		expect(createdSessionCount).toBe(0);
	});

	it("permits supplied QA bash configuration for evidence verification", async () => {
		type TestModel = { provider: string; id: string };
		let createdSessionCount = 0;
		const sessionSkillPaths: Array<readonly string[]> = [];

		await runAnsteelProjectReview<TestModel>({
			topic: "Review supplied configuration validation",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read", "bash"] },
				},
				reportDirectory: "unused",
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ skillPaths }) => {
				createdSessionCount++;
				sessionSkillPaths.push(skillPaths);
				return {
					prompt: async (prompt) => responseForMutualReviewStage(getStageFromPrompt(prompt)),
					dispose: () => {},
				};
			},
		});

		expect(createdSessionCount).toBe(3);
		expect(sessionSkillPaths).toEqual([[], [], []]);
	});

	it("rejects an unsupported role thinking level before creating any role session", async () => {
		type TestModel = { provider: string; id: string };
		let createdSessionCount = 0;

		await expect(
			runAnsteelProjectReview<TestModel>({
				topic: "Review supplied thinking-level validation",
				cwd: process.cwd(),
				config: {
					roles: {
						"tech-lead": { model: "tech/lead", tools: ["read"] },
						"staff-engineer": { model: "staff/engineer", thinkingLevel: "unsupported", tools: ["read"] },
						"qa-engineer": { model: "qa/engineer", tools: ["read"] },
					},
					reportDirectory: "unused",
				} as unknown as AnsteelConfig,
				resolveModel: (provider, id) => ({ provider, id }),
				createRoleSession: async () => {
					createdSessionCount++;
					return {
						prompt: async () => "VERDICT: APPROVE",
						dispose: () => {},
					};
				},
			}),
		).rejects.toThrow("Ansteel role staff-engineer thinkingLevel must be one of");

		expect(createdSessionCount).toBe(0);
	});

	it("creates isolated role sessions with the configured models", async () => {
		type TestModel = { provider: string; id: string };
		const calls: Array<{
			role: AnsteelRole;
			model: TestModel;
			thinkingLevel?: string;
			memoryFile?: string;
			skillPaths: readonly string[];
			tools: readonly string[];
		}> = [];
		const disposed: AnsteelRole[] = [];
		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Review the parser",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "claude/sonnet", tools: ["read", "bash"] },
					"staff-engineer": {
						model: "openai/gpt-5",
						thinkingLevel: "high",
						memoryFile: ".pi/ansteel-memory/staff.md",
						skillPaths: [".pi/ansteel-skills/staff"],
						tools: ["read", "grep"],
					},
					"qa-engineer": { model: "deepseek/chat", tools: ["read", "grep", "find", "ls"] },
				},
				reportDirectory: "unused",
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ role, model, thinkingLevel, memoryFile, skillPaths, tools }) => {
				calls.push({ role, model, thinkingLevel, memoryFile, skillPaths, tools });
				return {
					prompt: async (prompt) => responseForMutualReviewStage(getStageFromPrompt(prompt)),
					dispose: () => {
						disposed.push(role);
					},
				};
			},
		});

		expect(result.verdict).toBe("approved");
		expect(result.roleModels["tech-lead"]).toEqual({ provider: "claude", id: "sonnet" });
		expect(result.roleModels["staff-engineer"]).toEqual({ provider: "openai", id: "gpt-5" });
		expect(calls.find(({ role }) => role === "staff-engineer")?.thinkingLevel).toBe("high");
		expect(calls.find(({ role }) => role === "staff-engineer")?.memoryFile).toBe(
			join(process.cwd(), ".pi", "ansteel-memory", "staff.md"),
		);
		expect(calls.find(({ role }) => role === "staff-engineer")?.skillPaths).toEqual([
			join(process.cwd(), ".pi", "ansteel-skills", "staff"),
		]);
		expect(calls.map(({ role }) => role)).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
		expect(disposed).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
	});

	it("gives every project-review role the same bounded evidence package without historical reports", async () => {
		type TestModel = { provider: string; id: string };
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-evidence-"));
		temporaryDirectories.push(cwd);
		mkdirSync(join(cwd, "src"));
		mkdirSync(join(cwd, "test"));
		mkdirSync(join(cwd, ".pi", "ansteel-reports"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "ansteel-team"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "ansteel-memory"), { recursive: true });
		writeFileSync(join(cwd, "src", "solver.ts"), "export const answer = 42;\n");
		writeFileSync(join(cwd, "test", "solver.test.ts"), "expect(answer).toBe(42);\n");
		writeFileSync(join(cwd, ".pi", "ansteel-reports", "stale.md"), "historical model output");
		writeFileSync(join(cwd, ".pi", "ansteel-team", "events.jsonl"), "role session artifact");
		writeFileSync(join(cwd, ".pi", "ansteel-memory", "qa.md"), "QA private role memory");
		const evidencePackage = createAnsteelEvidencePackage(cwd);
		const prompts: Array<{ role: AnsteelRole; prompt: string }> = [];

		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Review shared project evidence",
			cwd,
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ role }) => ({
				prompt: async (prompt) => {
					prompts.push({ role, prompt });
					return responseForMutualReviewStage(getStageFromPrompt(prompt));
				},
				dispose: () => {},
			}),
		});

		expect(result.verdict).toBe("approved");
		expect(evidencePackage).toContain("src/solver.ts");
		expect(evidencePackage).toContain("sha256=");
		expect(evidencePackage).toContain("Tool path rule: every manifest path is relative to the review root");
		expect(evidencePackage).toContain("1 | export const answer = 42;");
		expect(evidencePackage).not.toContain("stale.md");
		expect(evidencePackage).not.toContain("historical model output");
		expect(evidencePackage).not.toContain("role session artifact");
		expect(evidencePackage).not.toContain("QA private role memory");
		expect(result.markdown).toContain(evidencePackage);
		for (const role of ANSTEEL_ROLES) {
			const rolePrompts = prompts.filter((entry) => entry.role === role);
			expect(rolePrompts.length).toBeGreaterThan(0);
			for (const { prompt } of rolePrompts) expect(prompt).toContain(evidencePackage);
		}
	});

	it("prioritizes declared evidence files beyond the bounded package limit", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-required-evidence-"));
		temporaryDirectories.push(cwd);
		for (let index = 0; index < 24; index++) {
			writeFileSync(join(cwd, `a-${String(index).padStart(2, "0")}.md`), `ordinary evidence ${index}`, "utf8");
		}
		writeFileSync(join(cwd, "z-required.md"), "required evidence", "utf8");

		const evidencePackage = createAnsteelEvidencePackage(cwd, ["z-required.md"]);

		expect(evidencePackage).toContain("z-required.md");
		expect(evidencePackage).toContain("required evidence");
	});

	it("rejects a missing declared evidence file before role sessions can start", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-required-evidence-"));
		temporaryDirectories.push(cwd);

		expect(() => createAnsteelEvidencePackage(cwd, ["missing-workflow.yml"])).toThrow(
			"Ansteel required evidence path does not exist: missing-workflow.yml",
		);
	});

	it("rejects missing required evidence before creating project-review role sessions", async () => {
		type TestModel = { provider: string; id: string };
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-required-evidence-"));
		temporaryDirectories.push(cwd);
		let createdSessionCount = 0;

		const review = runAnsteelProjectReview<TestModel>({
			topic: "Reject missing delivery workflow evidence",
			cwd,
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
				requiredEvidencePaths: [".github/workflows/ansteel-delivery.yml"],
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async () => {
				createdSessionCount++;
				return {
					prompt: async (prompt) => responseForMutualReviewStage(getStageFromPrompt(prompt)),
					dispose: () => {},
				};
			},
		});

		await expect(review).rejects.toThrow("Ansteel required evidence path does not exist");
		expect(createdSessionCount).toBe(0);
	});

	it("resolves an explicit git-root review scope without trusting the child working directory", () => {
		const repositoryRoot = mkdtempSync(join(tmpdir(), "pi-ansteel-review-root-"));
		temporaryDirectories.push(repositoryRoot);
		const childDirectory = join(repositoryRoot, "pi-agent");
		mkdirSync(join(repositoryRoot, ".git"));
		mkdirSync(childDirectory);

		expect(resolveAnsteelReviewRoot(childDirectory, "git-root")).toBe(repositoryRoot);
	});

	it("preserves a trailing-space QA verdict from a role session and rejects it", async () => {
		type TestModel = { provider: string; id: string };
		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Review the role-session QA gate",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async () => {
				return {
					prompt: async (prompt) =>
						responseForMutualReviewStage(getStageFromPrompt(prompt), { "qa-verification": "VERDICT: APPROVE " }),
					dispose: () => {},
				};
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.consensus).toBeUndefined();
		expect(result.transcript.at(-1)?.response).toBe("VERDICT: APPROVE ");
		expect(result.markdown).toContain("VERDICT: APPROVE \n");
	});

	it("preserves a trailing-space rejected QA verdict when session cleanup fails", async () => {
		type TestModel = { provider: string; id: string };
		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Review cleanup report integrity",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ role }) => ({
				prompt: async (prompt) =>
					responseForMutualReviewStage(getStageFromPrompt(prompt), { "qa-verification": "VERDICT: APPROVE " }),
				dispose: () => {
					if (role === "qa-engineer") throw new Error("QA cleanup failed");
				},
			}),
		});

		expect(result.verdict).toBe("rejected");
		expect(result.consensus).toBeUndefined();
		expect(result.transcript.at(-1)?.response).toBe("VERDICT: APPROVE ");
		expect(result.cleanupFailures).toEqual([{ role: "qa-engineer", reason: "QA cleanup failed" }]);
		expect(result.markdown).toContain("VERDICT: APPROVE \n\n## Session Cleanup Failures");
	});

	it("returns an auditable rejection for a whitespace-only QA session response", async () => {
		type TestModel = { provider: string; id: string };
		const calls: Array<{ role: AnsteelRole; prompt: string }> = [];
		const disposed: AnsteelRole[] = [];
		const result = await runAnsteelProjectReview<TestModel>({
			topic: "Review the whitespace-only QA response",
			cwd: process.cwd(),
			config: {
				roles: {
					"tech-lead": { model: "tech/lead", tools: ["read"] },
					"staff-engineer": { model: "staff/engineer", tools: ["read"] },
					"qa-engineer": { model: "qa/engineer", tools: ["read"] },
				},
				reportDirectory: "unused",
			},
			resolveModel: (provider, id) => ({ provider, id }),
			createRoleSession: async ({ role }) => {
				return {
					prompt: async (prompt) => {
						calls.push({ role, prompt });
						const stage = getStageFromPrompt(prompt);
						return stage === "qa-verification" ? " \t " : responseForMutualReviewStage(stage);
					},
					dispose: () => {
						disposed.push(role);
					},
				};
			},
		});

		expect(result.verdict).toBe("rejected");
		expect(result.consensus).toBeUndefined();
		expect(result.transcript.at(-1)?.response).toBe(" \t ");
		expect(result.markdown).toContain("qa-engineer / qa-verification returned an empty or whitespace-only response");
		expect(calls).toHaveLength(12);
		expect(calls.some(({ prompt }) => prompt.includes("Current stage: consensus."))).toBe(false);
		expect(disposed).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
	});

	it("allows an exact QA approval marker with a Verdict rationale line", async () => {
		const result = await runAnsteelDiscussion({
			topic: "Review the verdict parser",
			runRole: async ({ stage }) =>
				responseForMutualReviewStage(stage, {
					"qa-verification":
						"VERDICT: APPROVE\nVerdict rationale: [L1] The required test passed\n[L2] Monitor the follow-up",
					consensus:
						"[L2] Consensus\n<verification-method>\nL2 cross-checked with a second implementation.\n</verification-method>",
				}),
		});

		expect(result.verdict).toBe("approved");
		expect(result.consensus).toBe(
			"[L2] Consensus\n<verification-method>\nL2 cross-checked with a second implementation.\n</verification-method>",
		);
	});

	it("uses a nonzero CLI outcome for a rejected review", () => {
		expect(getAnsteelReviewExitCode("rejected")).toBe(1);
		expect(getAnsteelReviewExitCode("approved")).toBe(0);
	});

	it("writes an auditable Markdown report below the configured report directory", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-"));
		temporaryDirectories.push(cwd);
		const reportDirectory = join(cwd, ".pi", "ansteel-reports");

		const reportPath = writeAnsteelReport({
			reportDirectory,
			topic: "Review parser safety",
			markdown: "# Review\n\n[L1] Evidence\nRaw transcript trailing space: ",
			now: new Date("2026-07-22T08:15:30.000Z"),
		});

		expect(reportPath.startsWith(reportDirectory)).toBe(true);
		expect(existsSync(reportPath)).toBe(true);
		expect(readFileSync(reportPath, "utf-8")).toBe("# Review\n\n[L1] Evidence\nRaw transcript trailing space: ");
	});

	it("formats a sanitized setup rejection with the configured governance models", () => {
		const markdown = createAnsteelSetupFailureMarkdown({
			topic: "Review setup failure archiving",
			config: {
				roles: {
					"tech-lead": { model: "claude/sonnet", tools: ["read"] },
					"staff-engineer": { model: "openai/gpt-5", tools: ["read"] },
					"qa-engineer": { model: "deepseek/chat", tools: ["read"] },
				},
				reportDirectory: "unused",
			},
			error: new AnsteelGovernanceSetupError(
				"Authorization: Bearer top-secret-token; API key: super-secret-key\nwhile resolving the model",
				"model-resolution",
				"staff-engineer",
			),
		});

		expect(markdown).toContain("- Governance result: REJECTED");
		expect(markdown).toContain("- Delivery result: NOT_DELIVERED");
		expect(markdown).toContain("- Failed role: staff-engineer");
		expect(markdown).toContain("- Failed phase: model-resolution");
		expect(markdown).toContain("- tech-lead: claude/sonnet");
		expect(markdown).toContain("- staff-engineer: openai/gpt-5");
		expect(markdown).toContain("Authorization: Bearer [REDACTED]");
		expect(markdown).toContain("API key: [REDACTED]");
		expect(markdown).not.toContain("top-secret-token");
		expect(markdown).not.toContain("super-secret-key");
	});

	describe("shouldExtendRevisionRounds", () => {
		const base = {
			baseline: 2,
			cap: 4,
			adaptive: true,
			resolvedThisRound: 1,
			newIssuesThisRound: 1,
			newIssuesPreviousRound: 1,
		};

		it("extends within the baseline", () => {
			expect(shouldExtendRevisionRounds({ ...base, round: 1 }).extend).toBe(true);
		});

		it("extends on converging signals", () => {
			expect(shouldExtendRevisionRounds({ ...base, round: 2 }).extend).toBe(true);
		});

		it("rejects when adaptive extensions are disabled", () => {
			const decision = shouldExtendRevisionRounds({ ...base, round: 2, adaptive: false });
			expect(decision.extend).toBe(false);
			expect(decision.reason).toContain("disabled");
		});

		it("rejects when no previously open issue was resolved", () => {
			const decision = shouldExtendRevisionRounds({ ...base, round: 2, resolvedThisRound: 0 });
			expect(decision.extend).toBe(false);
			expect(decision.reason).toContain("no previously open issue");
		});

		it("rejects when new issues grow", () => {
			const decision = shouldExtendRevisionRounds({ ...base, round: 2, newIssuesThisRound: 3 });
			expect(decision.extend).toBe(false);
			expect(decision.reason).toContain("grew from 1 to 3 (more than 2x)");
		});

		it("rejects at the configured cap", () => {
			const decision = shouldExtendRevisionRounds({ ...base, round: 4, cap: 4 });
			expect(decision.extend).toBe(false);
			expect(decision.reason).toContain("cap");
		});
	});

	describe("adaptive revision round config parsing", () => {
		it("parses the adaptive revision round policy", () => {
			const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-"));
			temporaryDirectories.push(cwd);
			mkdirSync(join(cwd, ".pi"));
			writeFileSync(
				join(cwd, ".pi", "ansteel.json"),
				JSON.stringify({
					roles: {
						"tech-lead": { model: "a/b" },
						"staff-engineer": { model: "c/d" },
						"qa-engineer": { model: "e/f" },
					},
					maxArchitectureRevisionRounds: 3,
					adaptiveArchitectureRevisions: true,
					adaptiveArchitectureRevisionCap: 5,
				}),
			);

			const config = loadAnsteelConfig(cwd);
			expect(config.maxArchitectureRevisionRounds).toBe(3);
			expect(config.adaptiveArchitectureRevisions).toBe(true);
			expect(config.adaptiveArchitectureRevisionCap).toBe(5);
		});

		it("rejects a revision cap below the baseline", () => {
			const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-"));
			temporaryDirectories.push(cwd);
			mkdirSync(join(cwd, ".pi"));
			writeFileSync(
				join(cwd, ".pi", "ansteel.json"),
				JSON.stringify({
					roles: {
						"tech-lead": { model: "a/b" },
						"staff-engineer": { model: "c/d" },
						"qa-engineer": { model: "e/f" },
					},
					maxArchitectureRevisionRounds: 4,
					adaptiveArchitectureRevisionCap: 2,
				}),
			);
			expect(() => loadAnsteelConfig(cwd)).toThrow("adaptiveArchitectureRevisionCap cannot be lower");
		});
	});

	describe("review bash computation policy", () => {
		it("allows bounded bash computation when enabled", () => {
			const policy = createAnsteelReviewToolPolicy(process.cwd(), { allowBashComputation: true });
			expect(policy.beforeToolCall("bash", { command: 'python -c "print(1)"', timeout: 10 })).toBeUndefined();
			expect(policy.beforeToolCall("bash", { command: 'python -c "print(1)"', timeout: 20 })).toBeUndefined();
			expect(policy.beforeToolCall("bash", { command: 'python -c "print(1)"', timeout: 21 })).toEqual({
				block: true,
				reason: "Ansteel bash requires an explicit timeout of at most 20 seconds.",
			});
			expect(policy.beforeToolCall("bash", { command: 'python -c "print(1)"' })).toEqual({
				block: true,
				reason: "Ansteel bash requires an explicit timeout of at most 20 seconds.",
			});
		});

		it("blocks bash by default in review policy", () => {
			const policy = createAnsteelReviewToolPolicy(process.cwd());
			expect(policy.beforeToolCall("bash", { command: "ls", timeout: 10 })).toEqual({
				block: true,
				reason: "Ansteel reviews do not permit shell execution; use the bounded read-only review tools.",
			});
		});

		it("parses allowBashComputation from config", () => {
			const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-"));
			temporaryDirectories.push(cwd);
			mkdirSync(join(cwd, ".pi"));
			writeFileSync(
				join(cwd, ".pi", "ansteel.json"),
				JSON.stringify({
					roles: {
						"tech-lead": { model: "a/b" },
						"staff-engineer": { model: "c/d" },
						"qa-engineer": { model: "e/f" },
					},
					allowBashComputation: true,
				}),
			);

			const config = loadAnsteelConfig(cwd);
			expect(config.allowBashComputation).toBe(true);
		});

		it("rejects a non-boolean allowBashComputation", () => {
			const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-"));
			temporaryDirectories.push(cwd);
			mkdirSync(join(cwd, ".pi"));
			writeFileSync(
				join(cwd, ".pi", "ansteel.json"),
				JSON.stringify({
					roles: {
						"tech-lead": { model: "a/b" },
						"staff-engineer": { model: "c/d" },
						"qa-engineer": { model: "e/f" },
					},
					allowBashComputation: "yes",
				}),
			);
			expect(() => loadAnsteelConfig(cwd)).toThrow("allowBashComputation must be a boolean");
		});
	});

	describe("provider-truncation repair (parallel group)", () => {
		it("rewrites a provider-truncated cross-examination once and completes", async () => {
			let repairCalls = 0;
			const result = await runAnsteelDiscussion({
				topic: "Review truncated cross-examination repair",
				maxStageResponseChars: 1000,
				runRole: async ({ role, stage, formatRepair }) => {
					if (role === "staff-engineer" && stage === "staff-cross-examination") {
						if (formatRepair) {
							repairCalls++;
							return "ISSUE: STAFF-CROSS | TARGET: qa-engineer\nNO ISSUES | TARGET: tech-lead\n[L2] Check the test strategy.";
						}
						throw new Error("Ansteel role stage failed: output-truncated");
					}
					return responseForMutualReviewStage(stage);
				},
			});
			expect(result.verdict).toBe("approved");
			expect(repairCalls).toBe(1);
		});
	});
	describe("provider-truncation repair", () => {
		it("rewrites a provider-truncated response once and completes", async () => {
			let repairCalls = 0;
			const result = await runAnsteelDiscussion({
				topic: "Review truncated response repair",
				maxStageResponseChars: 1000,
				runRole: async ({ role, stage, formatRepair }) => {
					if (stage === "architecture") {
						if (formatRepair) {
							repairCalls++;
							return COMPLETE_WORK_CARD;
						}
						throw new Error("Ansteel role stage failed: output-truncated");
					}
					return responseForMutualReviewStage(stage);
				},
			});
			expect(result.verdict).toBe("approved");
			expect(repairCalls).toBe(1);
		});

		it("rejects a response that stays truncated after the concise rewrite", async () => {
			const result = await runAnsteelDiscussion({
				topic: "Review persistent truncation",
				maxStageResponseChars: 1000,
				runRole: async ({ role, stage }) => {
					if (stage === "architecture") throw new Error("Ansteel role stage failed: output-truncated");
					return responseForMutualReviewStage(stage);
				},
			});
			expect(result.verdict).toBe("rejected");
			expect(result.markdown).toContain("output-truncated");
		});

		it("repairs a provider-truncated parallel-group stage (cross-examination)", async () => {
			let repairCalls = 0;
			const result = await runAnsteelDiscussion({
				topic: "Review truncated cross-examination repair",
				maxStageResponseChars: 1000,
				runRole: async ({ role, stage, formatRepair }) => {
					if (role === "staff-engineer" && stage === "staff-cross-examination") {
						if (formatRepair) {
							repairCalls++;
							return "ISSUE: STAFF-CROSS | TARGET: qa-engineer\nNO ISSUES | TARGET: tech-lead";
						}
						throw new Error("Ansteel role stage failed: output-truncated");
					}
					return responseForMutualReviewStage(stage);
				},
			});
			expect(result.verdict).toBe("approved");
			expect(repairCalls).toBe(1);
		});
	});

	describe("over-length response enforcement", () => {
		it("rewrites an over-length response once and completes", async () => {
			let repairCalls = 0;

			const result = await runAnsteelDiscussion({
				topic: "Review over-length response repair",
				maxStageResponseChars: 1000,
				runRole: async ({ role, stage, formatRepair }) => {
					if (stage === "architecture") {
						if (formatRepair) {
							repairCalls++;
							return COMPLETE_WORK_CARD;
						}
						return "x".repeat(2000) + "\n\n" + COMPLETE_WORK_CARD;
					}
					return responseForMutualReviewStage(stage);
				},
			});

			expect(result.verdict).toBe("approved");
			expect(repairCalls).toBe(1);
		});

		it("rejects a response that stays over-length after the concise rewrite", async () => {
			const result = await runAnsteelDiscussion({
				topic: "Review persistent over-length response",
				maxStageResponseChars: 1000,
				runRole: async ({ role, stage }) => {
					if (stage === "architecture") return "x".repeat(2000);
					return responseForMutualReviewStage(stage);
				},
			});

			expect(result.verdict).toBe("rejected");
			expect(result.markdown).toContain("response still exceeds 1000 characters");
		});

		it("parses maxStageResponseChars from config", () => {
			const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-"));
			temporaryDirectories.push(cwd);
			mkdirSync(join(cwd, ".pi"));
			writeFileSync(
				join(cwd, ".pi", "ansteel.json"),
				JSON.stringify({
					roles: {
						"tech-lead": { model: "a/b" },
						"staff-engineer": { model: "c/d" },
						"qa-engineer": { model: "e/f" },
					},
					maxStageResponseChars: 24000,
				}),
			);

			const config = loadAnsteelConfig(cwd);
			expect(config.maxStageResponseChars).toBe(24000);
		});
	});
});
