import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import {
	appendAnsteelTeamEvent,
	beginAnsteelTeamMilestoneFinalVerification,
	beginAnsteelTeamTaskFinalVerification,
	claimAnsteelTeamTask,
	createAnsteelTeamMilestone,
	createAnsteelTeamState,
	publishAnsteelTeamMilestoneCollaboration,
	publishAnsteelTeamTaskCollaboration,
	recordAnsteelTeamTaskTestResult,
	reviewAnsteelTeamMilestone,
	reviewAnsteelTeamTask,
	runAnsteelTeamMilestoneTest,
	submitAnsteelTeamMilestone,
	submitAnsteelTeamTask,
} from "../src/core/ansteel-team.ts";
import {
	createAnsteelRunContext,
	createAnsteelRuntimeLogger,
	listAnsteelRuntimeRuns,
} from "../src/core/ansteel-team-observability.ts";

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

const DETERMINISTIC_TASK_DELIVERY_PROVIDER_EXTENSION = `
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
		fauxAssistantMessage("Tech Lead completed independent investigation."),
		fauxAssistantMessage("Tech Lead completed cross-examination."),
		fauxAssistantMessage([
			fauxToolCall("ansteel_review_action", {
				checkpointId: "CP-TASK-STAFF-EDIT-0001",
				action: { kind: "edit", target: "src/staff.ts", version: "TASK-STAFF@0;git-head:__TASK_STAFF_HEAD__" },
				verdict: "approve",
				reason: "The bounded Staff edit has a reproducible baseline and test target.",
			}),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage("Tech Lead approved the exact Staff edit action."),
		fauxAssistantMessage([
			fauxToolCall("ansteel_publish_task_collaboration", {
				taskId: "TASK-STAFF",
				summary: "The frozen Staff diff preserves the declared implementation scope.",
				evidenceRefs: ["file:src/staff.ts", "test:staff.test.mjs"],
				uncertainties: [],
			}),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage("Tech Lead published the continuous collaboration update."),
		fauxAssistantMessage([
			fauxToolCall("ansteel_review_task", {
				taskId: "TASK-STAFF",
				verdict: "approve",
			}),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage("Tech Lead approved TASK-STAFF."),
	]);
	register(pi, "deterministic-team-staff", "staff", [
		fauxAssistantMessage("Staff Engineer completed independent investigation."),
		fauxAssistantMessage("Staff Engineer completed cross-examination."),
		fauxAssistantMessage([
			fauxToolCall("read", { path: "README.md" }),
			fauxToolCall("read", { path: "test/staff.test.mjs" }),
			fauxToolCall("read", { path: "src/staff.ts" }),
			fauxToolCall("ls", { path: "src" }),
			fauxToolCall("read", { path: "package.json" }),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage([
			fauxToolCall("ansteel_publish_checkpoint", {
				id: "CP-TASK-STAFF-EDIT-0001",
				taskId: "TASK-STAFF",
				goal: "Implement the Staff fixture",
				currentUnderstanding: "The baseline intentionally exports NOT_IMPLEMENTED.",
				assumptions: ["The governed file remains at the committed baseline"],
				evidenceRefs: ["file:src/staff.ts", "test:staff.test.mjs"],
				uncertainties: [],
				nextAction: {
					kind: "edit",
					target: "src/staff.ts",
					expectedResult: "The implementation marker satisfies the Staff test.",
				},
				risk: "yellow",
				confidence: "L1",
			}),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage("Staff published the governed edit checkpoint."),
		fauxAssistantMessage([
			fauxToolCall("edit", {
				path: "src/staff.ts",
				edits: [
					{
						oldText: "export const staff = 'NOT_IMPLEMENTED';\\n",
						newText: "export const staff = 'implemented';\\n",
					},
				],
			}),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage([
			fauxToolCall("ansteel_submit_change", {
				taskId: "TASK-STAFF",
				testCommand: "node --test test/staff.test.mjs",
			}),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage("Staff Engineer submitted TASK-STAFF."),
	]);
	register(pi, "deterministic-team-qa", "qa", [
		fauxAssistantMessage("QA Engineer completed independent investigation."),
		fauxAssistantMessage("QA Engineer completed cross-examination."),
		fauxAssistantMessage([
			fauxToolCall("ansteel_review_action", {
				checkpointId: "CP-TASK-STAFF-EDIT-0001",
				action: { kind: "edit", target: "src/staff.ts", version: "TASK-STAFF@0;git-head:__TASK_STAFF_HEAD__" },
				verdict: "approve",
				reason: "The exact edit is testable and does not expand the governed scope.",
			}),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage("QA approved the exact Staff edit action."),
		fauxAssistantMessage([
			fauxToolCall("ansteel_publish_task_collaboration", {
				taskId: "TASK-STAFF",
				summary: "The frozen Staff evidence is reproducible and ready for final verification.",
				evidenceRefs: ["test:staff.test.mjs", "git-diff:src/staff.ts"],
				uncertainties: [],
			}),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage("QA published the continuous collaboration update."),
		fauxAssistantMessage([
			fauxToolCall("ansteel_review_task", {
				taskId: "TASK-STAFF",
				verdict: "approve",
			}),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage("QA Engineer approved TASK-STAFF."),
	]);
}
`;

const DETERMINISTIC_CORRECTION_LOOP_PROVIDER_EXTENSION = `
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
		fauxAssistantMessage("Tech Lead completed independent investigation."),
		fauxAssistantMessage("Tech Lead completed cross-examination."),
		fauxAssistantMessage([
			fauxToolCall("ansteel_review_process_resolution", {
				issueId: "PI-RPC-0001",
				verdict: "accept",
				reason: "Tech Lead is not the issue author.",
			}),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage("Tech Lead attempted an unauthorized review."),
	]);
	register(pi, "deterministic-team-staff", "staff", [
		fauxAssistantMessage([
			fauxToolCall("ansteel_publish_checkpoint", {
				id: "CP-RPC-0001",
				goal: "Validate calculated lease expiry",
				currentUnderstanding: "Only the input operands are currently validated",
				assumptions: ["Clock and duration are safe integers"],
				evidenceRefs: ["file:src/lease.ts:10"],
				uncertainties: ["The calculated sum can overflow"],
				nextAction: {
					kind: "test",
					target: "test/lease.test.ts",
					expectedResult: "The overflow boundary is reproduced",
				},
				risk: "yellow",
				confidence: "L2",
			}),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage("Staff published the initial checkpoint."),
		fauxAssistantMessage([
			fauxToolCall("ansteel_publish_checkpoint", {
				id: "CP-RPC-0002",
				goal: "Validate calculated lease expiry",
				currentUnderstanding: "The calculated expiry must also be a safe integer",
				assumptions: ["Clock and duration are safe integers"],
				evidenceRefs: ["test:lease-overflow:passed"],
				uncertainties: [],
				nextAction: {
					kind: "edit",
					target: "src/lease.ts",
					expectedResult: "Unsafe expiry is rejected before persistence",
				},
				risk: "yellow",
				confidence: "L1",
				supersedesCheckpointId: "CP-RPC-0001",
			}),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage([
			fauxToolCall("ansteel_resolve_process_issue", {
				id: "PR-RPC-0001",
				issueId: "PI-RPC-0001",
				outcome: "ACCEPTED",
				summary: "Validate the calculated expiry",
				evidenceRefs: ["test:lease-overflow:passed"],
				replacementCheckpointId: "CP-RPC-0002",
			}),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage("Staff proposed the corrected checkpoint."),
		fauxAssistantMessage("Staff observed the unauthorized review attempt."),
	]);
	register(pi, "deterministic-team-qa", "qa", [
		fauxAssistantMessage([
			fauxToolCall("ansteel_raise_process_issue", {
				id: "PI-RPC-0001",
				targetCheckpointId: "CP-RPC-0001",
				severity: "blocking",
				claim: "Safe operands do not guarantee a safe sum",
				evidenceRefs: ["test:lease-overflow"],
				suggestedCorrection: "Validate the calculated expiry before persistence",
			}),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage("QA raised the boundary issue."),
		fauxAssistantMessage([
			fauxToolCall("ansteel_review_process_resolution", {
				issueId: "PI-RPC-0001",
				verdict: "accept",
				reason: "The replacement checkpoint contains the overflow regression.",
			}),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage("QA accepted the correction."),
		fauxAssistantMessage("QA observed the unauthorized review attempt."),
	]);
}
`;

function createDeterministicFailureProviderExtension(responses: {
	techLead: string;
	staffEngineer: string;
	qaEngineer: string;
}): string {
	return `
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
	register(pi, "deterministic-team-tl", "tl", [${responses.techLead}]);
	register(pi, "deterministic-team-staff", "staff", [${responses.staffEngineer}]);
	register(pi, "deterministic-team-qa", "qa", [${responses.qaEngineer}]);
}
`;
}

type ActionGateFailureScenario = "missing-qa" | "stale-qa" | "blocking-issue" | "overwrite";

function createDeterministicActionGateFailureExtension(scenario: ActionGateFailureScenario): string {
	const exactAction =
		'action: { kind: "edit", target: "src/staff.ts", version: "TASK-STAFF@0;git-head:__TASK_STAFF_HEAD__" }';
	const qaReview =
		scenario === "missing-qa"
			? `
				fauxAssistantMessage("QA withheld the structured action confirmation."),
				fauxAssistantMessage("QA still has not recorded an action confirmation.")
			`
			: scenario === "stale-qa"
				? `
					fauxAssistantMessage([
						fauxToolCall("ansteel_review_action", {
							checkpointId: "CP-ACTION-GATE-FAIL-0001",
							action: {
								kind: "edit",
								target: "src/staff.ts",
								version: "TASK-STAFF@0;git-head:__TASK_STAFF_HEAD__-stale",
							},
							verdict: "approve",
							reason: "This stale binding must not authorize the edit.",
						}),
					], { stopReason: "toolUse" }),
					fauxAssistantMessage("QA claimed the stale approval was sufficient."),
					fauxAssistantMessage("QA did not replace the stale approval.")
				`
				: scenario === "blocking-issue"
					? `
						fauxAssistantMessage([
							fauxToolCall("ansteel_review_action", {
								checkpointId: "CP-ACTION-GATE-FAIL-0001",
								${exactAction},
								verdict: "approve",
								reason: "The exact edit binding is reproducible.",
							}),
						], { stopReason: "toolUse" }),
						fauxAssistantMessage([
							fauxToolCall("ansteel_raise_process_issue", {
								id: "PI-ACTION-GATE-BLOCK-0001",
								targetCheckpointId: "CP-ACTION-GATE-FAIL-0001",
								severity: "blocking",
								claim: "The acceptance evidence omits the compatibility boundary.",
								evidenceRefs: ["test:compatibility-missing"],
								suggestedCorrection: "Add the missing compatibility case before editing.",
							}),
						], { stopReason: "toolUse" }),
						fauxAssistantMessage("QA recorded the blocking issue after reviewing the exact binding.")
					`
					: `
						fauxAssistantMessage([
							fauxToolCall("ansteel_review_action", {
								checkpointId: "CP-ACTION-GATE-FAIL-0001",
								${exactAction},
								verdict: "approve",
								reason: "The yellow edit binding is reproducible.",
							}),
						], { stopReason: "toolUse" }),
						fauxAssistantMessage("QA approved only the exact yellow edit binding.")
					`;
	const ownerAction =
		scenario === "overwrite"
			? `
				fauxToolCall("write", {
					path: "src/staff.ts",
					content: "export const staff = 'implemented';\\n",
				})
			`
			: `
				fauxToolCall("edit", {
					path: "src/staff.ts",
					edits: [{
						oldText: "export const staff = 'NOT_IMPLEMENTED';\\n",
						newText: "export const staff = 'implemented';\\n",
					}],
				})
			`;
	return createDeterministicFailureProviderExtension({
		techLead: `
			fauxAssistantMessage("Tech Lead completed independent investigation."),
			fauxAssistantMessage("Tech Lead completed cross-examination."),
			fauxAssistantMessage([
				fauxToolCall("ansteel_review_action", {
					checkpointId: "CP-ACTION-GATE-FAIL-0001",
					${exactAction},
					verdict: "approve",
					reason: "The exact edit stays inside the assigned file.",
				}),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage("Tech Lead approved the exact edit binding.")
		`,
		staffEngineer: `
			fauxAssistantMessage("Staff completed independent investigation."),
			fauxAssistantMessage("Staff completed cross-examination."),
			fauxAssistantMessage([
				fauxToolCall("ansteel_publish_checkpoint", {
					id: "CP-ACTION-GATE-FAIL-0001",
					taskId: "TASK-STAFF",
					goal: "Exercise the real RPC action gate",
					currentUnderstanding: "The tracked file is still at the committed baseline.",
					assumptions: ["Only the exact yellow edit has been proposed"],
					evidenceRefs: ["file:src/staff.ts", "test:staff.test.mjs"],
					uncertainties: [],
					nextAction: {
						kind: "edit",
						target: "src/staff.ts",
						expectedResult: "The implementation marker changes.",
					},
					risk: "yellow",
					confidence: "L1",
				}),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage("Staff published the yellow edit checkpoint."),
			fauxAssistantMessage([${ownerAction}], { stopReason: "toolUse" }),
			fauxAssistantMessage("Staff claimed the file was implemented despite the blocked tool call.")
		`,
		qaEngineer: `
			fauxAssistantMessage("QA completed independent investigation."),
			fauxAssistantMessage("QA completed cross-examination."),
			${qaReview}
		`,
	});
}

const DETERMINISTIC_TASK_OWNER_COLLABORATION_FAILURE_EXTENSION = createDeterministicFailureProviderExtension({
	techLead: `
		fauxAssistantMessage("Tech Lead completed independent investigation."),
		fauxAssistantMessage("Tech Lead completed cross-examination.")
	`,
	staffEngineer: `
		fauxAssistantMessage("Staff completed independent investigation."),
		fauxAssistantMessage("Staff completed cross-examination."),
		fauxAssistantMessage([
			fauxToolCall("ansteel_publish_checkpoint", {
				id: "CP-OWNER-FAIL-0001",
				taskId: "TASK-OWNER-FAIL",
				goal: "Exercise task owner failure propagation",
				currentUnderstanding: "The replacement checkpoint is missing",
				assumptions: [],
				evidenceRefs: ["test:task-owner-failure"],
				uncertainties: [],
				nextAction: { kind: "edit", target: "src/staff.ts", expectedResult: "The task changes" },
				risk: "yellow",
				confidence: "L2",
				supersedesCheckpointId: "CP-UNKNOWN",
			}),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage("Staff observed the rejected checkpoint."),
		fauxAssistantMessage([
			fauxToolCall("ansteel_publish_checkpoint", {
				id: "CP-OWNER-FAIL-0002",
				taskId: "TASK-OWNER-FAIL",
				goal: "Exercise task owner failure propagation",
				currentUnderstanding: "The replacement checkpoint is still missing",
				assumptions: [],
				evidenceRefs: ["test:task-owner-failure"],
				uncertainties: [],
				nextAction: { kind: "edit", target: "src/staff.ts", expectedResult: "The task changes" },
				risk: "yellow",
				confidence: "L2",
				supersedesCheckpointId: "CP-UNKNOWN",
			}),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage("Staff observed the second rejected checkpoint.")
	`,
	qaEngineer: `
		fauxAssistantMessage("QA completed independent investigation."),
		fauxAssistantMessage("QA completed cross-examination.")
	`,
});

const DETERMINISTIC_TASK_REVIEW_COLLABORATION_FAILURE_EXTENSION = createDeterministicFailureProviderExtension({
	techLead: `
		fauxAssistantMessage("Tech Lead completed independent investigation."),
		fauxAssistantMessage("Tech Lead completed cross-examination."),
		fauxAssistantMessage([
			fauxToolCall("ansteel_raise_process_issue", {
				id: "PI-TASK-REVIEW-FAIL-0001",
				targetCheckpointId: "CP-UNKNOWN",
				severity: "blocking",
				claim: "The referenced checkpoint does not exist",
				evidenceRefs: ["test:task-review-failure"],
				suggestedCorrection: "Publish the checkpoint before challenging it",
			}),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage("Tech Lead observed the rejected process issue."),
		fauxAssistantMessage([
			fauxToolCall("ansteel_raise_process_issue", {
				id: "PI-TASK-REVIEW-FAIL-0002",
				targetCheckpointId: "CP-UNKNOWN",
				severity: "blocking",
				claim: "The referenced checkpoint still does not exist",
				evidenceRefs: ["test:task-review-failure"],
				suggestedCorrection: "Publish the checkpoint before challenging it",
			}),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage("Tech Lead observed the second rejected process issue.")
	`,
	staffEngineer: `
		fauxAssistantMessage("Staff completed independent investigation."),
		fauxAssistantMessage("Staff completed cross-examination."),
		fauxAssistantMessage([
			fauxToolCall("ansteel_publish_checkpoint", {
				id: "CP-TASK-REVIEW-FAIL-0001",
				taskId: "TASK-STAFF",
				goal: "Exercise peer process issue failure propagation",
				currentUnderstanding: "The baseline requires one bounded edit.",
				assumptions: [],
				evidenceRefs: ["file:src/staff.ts"],
				uncertainties: [],
				nextAction: { kind: "edit", target: "src/staff.ts", expectedResult: "The Staff test passes" },
				risk: "yellow",
				confidence: "L1",
			}),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage([
			fauxToolCall("ansteel_submit_change", {
				taskId: "TASK-STAFF",
				testCommand: "node --test test/staff.test.mjs",
			}),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage("Staff submitted TASK-STAFF.")
	`,
	qaEngineer: `
		fauxAssistantMessage("QA completed independent investigation."),
		fauxAssistantMessage("QA completed cross-examination."),
		fauxAssistantMessage([
			fauxToolCall("ansteel_review_task", { taskId: "TASK-STAFF", verdict: "approve" }),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage("QA approved TASK-STAFF.")
	`,
});

const DETERMINISTIC_MILESTONE_REVIEW_COLLABORATION_FAILURE_EXTENSION = createDeterministicFailureProviderExtension({
	techLead: `
			fauxAssistantMessage("Tech Lead completed independent investigation."),
			fauxAssistantMessage("Tech Lead completed cross-examination."),
			fauxAssistantMessage([
				fauxToolCall("ansteel_review_action", {
					checkpointId: "CP-MILESTONE-TASK-0001",
					action: { kind: "edit", target: "src/staff.ts", version: "TASK-STAFF@0;git-head:__TASK_STAFF_HEAD__" },
					verdict: "approve",
					reason: "The bounded task edit is ready for delivery review.",
				}),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage("Tech Lead approved the task action."),
			fauxAssistantMessage([
				fauxToolCall("ansteel_review_task", { taskId: "TASK-STAFF", verdict: "approve" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage("Tech Lead approved TASK-STAFF."),
			fauxAssistantMessage([
				fauxToolCall("ansteel_plan_milestone", {
					id: "MILESTONE-RPC-0001",
					taskIds: ["TASK-STAFF"],
					description: "Exercise milestone review failure propagation",
					acceptanceCriteria: "The integration command passes",
				}),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([
				fauxToolCall("ansteel_submit_integration", {
					milestoneId: "MILESTONE-RPC-0001",
					testCommand: "node --test test/staff.test.mjs",
				}),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage("Tech Lead submitted the integration milestone.")
		`,
	staffEngineer: `
			fauxAssistantMessage("Staff completed independent investigation."),
			fauxAssistantMessage("Staff completed cross-examination."),
			fauxAssistantMessage([
				fauxToolCall("ansteel_publish_checkpoint", {
					id: "CP-MILESTONE-TASK-0001",
					taskId: "TASK-STAFF",
					goal: "Prepare milestone input",
					currentUnderstanding: "The baseline requires one bounded edit.",
					assumptions: [],
					evidenceRefs: ["file:src/staff.ts"],
					uncertainties: [],
					nextAction: { kind: "edit", target: "src/staff.ts", expectedResult: "The Staff test passes" },
					risk: "yellow",
					confidence: "L1",
				}),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage("Staff published the milestone task action."),
			fauxAssistantMessage([
				fauxToolCall("edit", {
					path: "src/staff.ts",
					edits: [{ oldText: "export const staff = 'NOT_IMPLEMENTED';\\n", newText: "export const staff = 'implemented';\\n" }],
				}),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([
				fauxToolCall("ansteel_submit_change", {
					taskId: "TASK-STAFF",
					testCommand: "node --test test/staff.test.mjs",
				}),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage("Staff submitted TASK-STAFF."),
			fauxAssistantMessage([
				fauxToolCall("ansteel_resolve_process_issue", {
					id: "PR-MILESTONE-FAIL-0001",
					issueId: "PI-UNKNOWN",
					outcome: "EXPERIMENT_REQUIRED",
					summary: "The issue does not exist",
					evidenceRefs: ["test:milestone-review-failure"],
					experiment: "Create the missing issue first",
				}),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage("Staff observed the rejected process resolution."),
			fauxAssistantMessage("Staff completed milestone cross-examination.")
		`,
	qaEngineer: `
			fauxAssistantMessage("QA completed independent investigation."),
			fauxAssistantMessage("QA completed cross-examination."),
			fauxAssistantMessage([
				fauxToolCall("ansteel_review_action", {
					checkpointId: "CP-MILESTONE-TASK-0001",
					action: { kind: "edit", target: "src/staff.ts", version: "TASK-STAFF@0;git-head:__TASK_STAFF_HEAD__" },
					verdict: "approve",
					reason: "The bounded task edit is testable.",
				}),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage("QA approved the task action."),
			fauxAssistantMessage([
				fauxToolCall("ansteel_review_task", { taskId: "TASK-STAFF", verdict: "approve" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage("QA approved TASK-STAFF."),
			fauxAssistantMessage([
				fauxToolCall("ansteel_review_integration", {
					milestoneId: "MILESTONE-RPC-0001",
					verdict: "approve",
				}),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage("QA approved the integration milestone."),
			fauxAssistantMessage("QA completed milestone cross-examination.")
		`,
});

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

async function waitForCondition<T>(
	description: string,
	condition: () => T | undefined,
	timeoutMs = 15_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = condition();
		if (value !== undefined) return value;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
	}
	throw new Error(`Timed out waiting for ${description}`);
}

function createTemporaryProject(providerExtension = DETERMINISTIC_TEAM_PROVIDER_EXTENSION): {
	agentDir: string;
	projectDir: string;
} {
	const root = mkdtempSync(join(tmpdir(), "pi-ansteel-team-cli-"));
	temporaryDirectories.push(root);
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	const extensionsDir = join(projectDir, ".pi", "extensions");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(extensionsDir, { recursive: true });
	writeFileSync(join(extensionsDir, "deterministic-team-provider.ts"), providerExtension, "utf8");
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

function initializeTaskDeliveryProject(projectDir: string): void {
	mkdirSync(join(projectDir, "src"), { recursive: true });
	mkdirSync(join(projectDir, "test"), { recursive: true });
	writeFileSync(join(projectDir, "src", "staff.ts"), "export const staff = 'NOT_IMPLEMENTED';\n", "utf8");
	writeFileSync(
		join(projectDir, "test", "staff.test.mjs"),
		[
			'import assert from "node:assert/strict";',
			'import { readFileSync } from "node:fs";',
			'import test from "node:test";',
			'test("staff implementation", () => {',
			'  assert.match(readFileSync("src/staff.ts", "utf8"), /implemented/);',
			"});",
			"",
		].join("\n"),
		"utf8",
	);
	execFileSync("git", ["init"], { cwd: projectDir, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "ansteel@example.test"], { cwd: projectDir, stdio: "ignore" });
	execFileSync("git", ["config", "user.name", "Ansteel Test"], { cwd: projectDir, stdio: "ignore" });
	execFileSync("git", ["add", "src/staff.ts", "test/staff.test.mjs"], { cwd: projectDir, stdio: "ignore" });
	execFileSync("git", ["commit", "-m", "baseline"], { cwd: projectDir, stdio: "ignore" });
	const baselineVersion = createTaskStaffFileVersion(projectDir, readFileSync(join(projectDir, "src", "staff.ts")));
	const providerPath = join(projectDir, ".pi", "extensions", "deterministic-team-provider.ts");
	writeFileSync(
		providerPath,
		readFileSync(providerPath, "utf8").replaceAll("TASK-STAFF@0;git-head:__TASK_STAFF_HEAD__", baselineVersion),
		"utf8",
	);
}

function createTaskStaffFileVersion(projectDir: string, content: string | Buffer): string {
	const stats = statSync(join(projectDir, "src", "staff.ts"), { bigint: true });
	if (!stats.isFile() || stats.ino === 0n)
		throw new Error("Deterministic task target requires a stable file identity");
	const hash = createHash("sha256").update(content).digest("hex");
	return `TASK-STAFF@0;src/staff.ts@file:${stats.dev}:${stats.ino};sha256:${hash}`;
}

/**
 * Build the complete approved-task and approved-milestone history before the
 * RPC process starts. The command under test still performs every Git anchor
 * and verification operation through the registered extension command.
 */
function prepareAnchorRpcFixture(projectDir: string): {
	taskId: string;
	milestoneId: string;
	remote: string;
} {
	initializeTaskDeliveryProject(projectDir);
	writeFileSync(join(projectDir, ".gitignore"), ".pi/\n", "utf8");
	execFileSync("git", ["add", ".gitignore"], { cwd: projectDir, stdio: "ignore" });
	execFileSync("git", ["commit", "-m", "ignore local audit state"], { cwd: projectDir, stdio: "ignore" });

	const state = createAnsteelTeamState({
		cwd: projectDir,
		topic: "Exercise RPC task and milestone anchors",
		roleModels: {
			"tech-lead": "deterministic-team-tl/tl",
			"staff-engineer": "deterministic-team-staff/staff",
			"qa-engineer": "deterministic-team-qa/qa",
		},
	});
	const task = claimAnsteelTeamTask(projectDir, state, {
		id: "TASK-RPC-ANCHOR",
		owner: "staff-engineer",
		files: ["src/staff.ts"],
		description: "Produce a committed implementation before the RPC anchor command.",
		acceptanceCriteria: "The deterministic staff test passes.",
	});
	const milestone = createAnsteelTeamMilestone(projectDir, state, {
		id: "MILESTONE-RPC-ANCHOR",
		taskIds: [task.id],
		description: "Verify the task and milestone command routes against a real Git remote.",
		acceptanceCriteria: "Both structured anchor receipts verify through RPC.",
	});
	writeFileSync(join(projectDir, "src", "staff.ts"), "export const staff = 'implemented';\n", "utf8");
	recordAnsteelTeamTaskTestResult(projectDir, state, "staff-engineer", task.id, {
		command: "node --test test/staff.test.mjs",
		output: "PASS deterministic staff fixture",
		isError: false,
	});
	submitAnsteelTeamTask(projectDir, state, "staff-engineer", task.id, "node --test test/staff.test.mjs");
	for (const collaborator of ["tech-lead", "qa-engineer"] as const) {
		publishAnsteelTeamTaskCollaboration(projectDir, state, collaborator, task.id, {
			summary: `${collaborator} inspected the frozen RPC task evidence.`,
			evidenceRefs: [`test:${task.id}:${collaborator}:continuous-collaboration`],
			uncertainties: [],
		});
	}
	beginAnsteelTeamTaskFinalVerification(projectDir, state, task.id);
	reviewAnsteelTeamTask(projectDir, state, "tech-lead", task.id, { verdict: "approve" });
	reviewAnsteelTeamTask(projectDir, state, "qa-engineer", task.id, { verdict: "approve" });
	execFileSync("git", ["add", "src/staff.ts"], { cwd: projectDir, stdio: "ignore" });
	execFileSync("git", ["commit", "-m", "complete anchor fixture task"], { cwd: projectDir, stdio: "ignore" });

	runAnsteelTeamMilestoneTest(projectDir, state, "tech-lead", milestone.id, "node --test test/staff.test.mjs");
	submitAnsteelTeamMilestone(projectDir, state, "tech-lead", milestone.id, "node --test test/staff.test.mjs");
	for (const collaborator of ["staff-engineer", "qa-engineer"] as const) {
		publishAnsteelTeamMilestoneCollaboration(projectDir, state, collaborator, milestone.id, {
			summary: `${collaborator} inspected the frozen RPC integration evidence.`,
			evidenceRefs: [`test:${milestone.id}:${collaborator}:continuous-collaboration`],
			uncertainties: [],
		});
	}
	beginAnsteelTeamMilestoneFinalVerification(projectDir, state, milestone.id);
	reviewAnsteelTeamMilestone(projectDir, state, "staff-engineer", milestone.id, { verdict: "approve" });
	reviewAnsteelTeamMilestone(projectDir, state, "qa-engineer", milestone.id, { verdict: "approve" });

	appendAnsteelTeamEvent(projectDir, state, {
		type: "task-review",
		role: "tech-lead",
		content: `${task.id} revision ${task.revision}: APPROVE`,
	});
	appendAnsteelTeamEvent(projectDir, state, {
		type: "task-review",
		role: "qa-engineer",
		content: `${task.id} revision ${task.revision}: APPROVE`,
	});
	appendAnsteelTeamEvent(projectDir, state, {
		type: "milestone-review",
		role: "staff-engineer",
		content: `${milestone.id} integration revision ${milestone.revision}: APPROVE`,
	});
	appendAnsteelTeamEvent(projectDir, state, {
		type: "milestone-review",
		role: "qa-engineer",
		content: `${milestone.id} integration revision ${milestone.revision}: APPROVE`,
	});
	const logger = createAnsteelRuntimeLogger(
		projectDir,
		createAnsteelRunContext({ teamId: state.id, command: "prepare anchor RPC fixture" }),
	);
	logger.write({
		level: "audit",
		eventName: "anchor.rpc.fixture.prepared",
		outcome: "succeeded",
		message: "A strict runtime segment exists before the RPC anchor command.",
		data: {},
	});
	logger.close();

	const remoteDirectory = mkdtempSync(join(tmpdir(), "pi-ansteel-anchor-rpc-remote-"));
	temporaryDirectories.push(remoteDirectory);
	execFileSync("git", ["init", "--bare", remoteDirectory], { stdio: "ignore" });
	const remote = "audit";
	execFileSync("git", ["remote", "add", remote, remoteDirectory], { cwd: projectDir, stdio: "ignore" });
	const branch = execFileSync("git", ["branch", "--show-current"], { cwd: projectDir, encoding: "utf8" }).trim();
	execFileSync("git", ["push", remote, `HEAD:refs/heads/${branch}`], { cwd: projectDir, stdio: "ignore" });
	return { taskId: task.id, milestoneId: milestone.id, remote };
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
	it("prevents role-authored tasks before the coordinator assigns work", async () => {
		const { agentDir, projectDir } = createTemporaryProject();
		const rpc = startRpcCli(projectDir, agentDir);
		try {
			const commands = await rpc.send({ id: "commands", type: "get_commands" });
			expect(commands).toMatchObject({ success: true, command: "get_commands" });
			const teamCommand = (commands.data as { commands: Array<{ name: string }> }).commands.find((command) =>
				command.name.startsWith("ansteel-team"),
			)?.name;
			expect(teamCommand).toBeDefined();

			const invalidDiagnosis = await rpc.send({
				id: "invalid-diagnosis",
				type: "prompt",
				message: `/${teamCommand} status --unsupported`,
			});
			expect(invalidDiagnosis).toMatchObject({
				success: false,
				command: "prompt",
				error: expect.stringContaining("Usage: /ansteel-team status [--explain]"),
			});

			const start = await rpc.send({
				id: "start",
				type: "prompt",
				message: `/${teamCommand} start Exercise the deterministic owner policy`,
			});
			expect(start).toMatchObject({ success: true, command: "prompt" });

			const teamDirectory = join(projectDir, ".pi", "ansteel-team");
			const statePath = join(teamDirectory, "team.json");
			const eventsPath = join(teamDirectory, "events.jsonl");
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
			expect(state.tasks).toEqual([]);
			expect(events).not.toContainEqual(expect.objectContaining({ type: "task-claimed", role: "tech-lead" }));
			expect(events).not.toContainEqual(expect.objectContaining({ type: "task-claimed", role: "staff-engineer" }));
			expect(readFileSync(state.roles["tech-lead"].sessionFile, "utf8")).not.toContain("Claimed TASK-TL");
			expect(readFileSync(state.roles["staff-engineer"].sessionFile, "utf8")).not.toContain("Claimed TASK-STAFF");

			const stop = await rpc.send({ id: "stop", type: "prompt", message: `/${teamCommand} stop` });
			expect(stop).toMatchObject({ success: true, command: "prompt" });
			await waitForCondition("the Ansteel team to stop", () => {
				if (!existsSync(statePath)) return undefined;
				const state = JSON.parse(readFileSync(statePath, "utf8")) as { status: string };
				return state.status === "stopped" ? state : undefined;
			});
		} finally {
			await rpc.stop();
		}
	}, 20_000);

	it("delivers a coordinator task through the real RPC CLI, Git diff, test, and dual peer review", async () => {
		const { agentDir, projectDir } = createTemporaryProject(DETERMINISTIC_TASK_DELIVERY_PROVIDER_EXTENSION);
		initializeTaskDeliveryProject(projectDir);
		const rpc = startRpcCli(projectDir, agentDir);
		try {
			const commands = await rpc.send({ id: "commands", type: "get_commands" });
			const teamCommand = (commands.data as { commands: Array<{ name: string }> }).commands.find((command) =>
				command.name.startsWith("ansteel-team"),
			)?.name;
			expect(teamCommand).toBeDefined();

			const start = await rpc.send({
				id: "start",
				type: "prompt",
				message: `/${teamCommand} start Deliver a deterministic Staff task`,
			});
			expect(start).toMatchObject({ success: true, command: "prompt" });
			const task = await rpc.send({
				id: "task",
				type: "prompt",
				message: `/${teamCommand} task {"id":"TASK-STAFF","owner":"staff-engineer","type":"implementation","files":["src/staff.ts"],"description":"Implement the Staff fixture","acceptanceCriteria":"The Staff test passes","dependsOn":[]}`,
			});
			expect(task).toMatchObject({ success: true, command: "prompt" });

			const teamDirectory = join(projectDir, ".pi", "ansteel-team");
			const state = JSON.parse(readFileSync(join(teamDirectory, "team.json"), "utf8")) as {
				roles: { "staff-engineer": { sessionFile: string } };
				actionReviews: Array<{
					checkpointId: string;
					reviewer: string;
					verdict: string;
					action: { kind: string; target: string; version: string };
				}>;
				tasks: Array<{
					id: string;
					owner: string;
					status: string;
					revision: number;
					submissions: Array<{ diff: string; test: { command: string; isError: boolean } }>;
					reviews: Array<{ reviewer: string; verdict: string }>;
				}>;
			};
			const events = readFileSync(join(teamDirectory, "events.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map(
					(line) => JSON.parse(line) as { type: string; role: string; targetRole?: string; checkpointId?: string },
				);
			expect(state.tasks).toEqual([
				expect.objectContaining({
					id: "TASK-STAFF",
					owner: "staff-engineer",
					status: "approved",
					revision: 1,
					submissions: [
						expect.objectContaining({
							diff: expect.stringContaining("implemented"),
							test: expect.objectContaining({
								command: "node --test test/staff.test.mjs",
								isError: false,
							}),
						}),
					],
					reviews: expect.arrayContaining([
						expect.objectContaining({ reviewer: "tech-lead", verdict: "approve" }),
						expect.objectContaining({ reviewer: "qa-engineer", verdict: "approve" }),
					]),
				}),
			]);
			expect(events).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "task-assigned",
						role: "coordinator",
						targetRole: "staff-engineer",
					}),
					expect.objectContaining({ type: "task-submitted", role: "staff-engineer" }),
					expect.objectContaining({ type: "task-collaboration", role: "tech-lead" }),
					expect.objectContaining({ type: "task-collaboration", role: "qa-engineer" }),
					expect.objectContaining({ type: "task-final-verification-requested", role: "coordinator" }),
					expect.objectContaining({ type: "task-review", role: "tech-lead" }),
					expect.objectContaining({ type: "task-review", role: "qa-engineer" }),
				]),
			);
			expect(state.actionReviews).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						checkpointId: "CP-TASK-STAFF-EDIT-0001",
						reviewer: "tech-lead",
						verdict: "approve",
						action: {
							kind: "edit",
							target: "src/staff.ts",
							version: createTaskStaffFileVersion(projectDir, "export const staff = 'NOT_IMPLEMENTED';\n"),
						},
					}),
					expect.objectContaining({
						checkpointId: "CP-TASK-STAFF-EDIT-0001",
						reviewer: "qa-engineer",
						verdict: "approve",
						action: {
							kind: "edit",
							target: "src/staff.ts",
							version: createTaskStaffFileVersion(projectDir, "export const staff = 'NOT_IMPLEMENTED';\n"),
						},
					}),
				]),
			);
			const assessedIndex = events.findIndex(
				(event) => event.type === "action-assessed" && event.checkpointId === "CP-TASK-STAFF-EDIT-0001",
			);
			const reviewIndex = events.findIndex(
				(event) => event.type === "action-review" && event.checkpointId === "CP-TASK-STAFF-EDIT-0001",
			);
			const submissionIndex = events.findIndex((event) => event.type === "task-submitted");
			const finalVerificationIndex = events.findIndex((event) => event.type === "task-final-verification-requested");
			const firstTaskReviewIndex = events.findIndex((event) => event.type === "task-review");
			const collaborationIndexes = events
				.map((event, index) => (event.type === "task-collaboration" ? index : -1))
				.filter((index) => index >= 0);
			expect(assessedIndex).toBeGreaterThanOrEqual(0);
			expect(assessedIndex).toBeGreaterThan(reviewIndex);
			expect(submissionIndex).toBeGreaterThan(assessedIndex);
			expect(collaborationIndexes).toHaveLength(2);
			expect(finalVerificationIndex).toBeGreaterThan(Math.max(...collaborationIndexes));
			expect(firstTaskReviewIndex).toBeGreaterThan(finalVerificationIndex);
			expect(readFileSync(join(projectDir, "src", "staff.ts"), "utf8")).toContain("implemented");
			expect(readFileSync(state.roles["staff-engineer"].sessionFile, "utf8")).toContain(
				"read-only tool budget exhausted after 4 calls",
			);
		} finally {
			await rpc.stop();
		}
	}, 30_000);

	it.each([
		{
			name: "one peer action confirmation is missing",
			scenario: "missing-qa" as const,
			expectedReviewers: ["tech-lead"],
			expectedComputedRisk: "yellow",
			expectedBlockReason: "qa-engineer",
			expectedOpenIssues: 0,
			expectedRpcSuccess: true,
		},
		{
			name: "a stale checkpoint version is reused",
			scenario: "stale-qa" as const,
			expectedReviewers: ["tech-lead"],
			expectedComputedRisk: "yellow",
			expectedBlockReason: "qa-engineer",
			expectedOpenIssues: 0,
			expectedRpcSuccess: false,
		},
		{
			name: "two approvals coexist with an open blocking issue",
			scenario: "blocking-issue" as const,
			expectedReviewers: ["tech-lead", "qa-engineer"],
			expectedComputedRisk: "yellow",
			expectedBlockReason: "blocking process issue",
			expectedOpenIssues: 1,
			expectedRpcSuccess: true,
		},
		{
			name: "yellow edit confirmations are reused for an existing-file overwrite",
			scenario: "overwrite" as const,
			expectedReviewers: ["tech-lead", "qa-engineer"],
			expectedComputedRisk: "red",
			expectedBlockReason: "active checkpoint with the exact action binding",
			expectedOpenIssues: 0,
			expectedRpcSuccess: true,
		},
	])(
		"keeps the real RPC action confirmation gate closed when $name",
		async (testCase) => {
			const { agentDir, projectDir } = createTemporaryProject(
				createDeterministicActionGateFailureExtension(testCase.scenario),
			);
			initializeTaskDeliveryProject(projectDir);
			const rpc = startRpcCli(projectDir, agentDir);
			try {
				const commands = await rpc.send({ id: "commands", type: "get_commands" });
				const teamCommand = (commands.data as { commands: Array<{ name: string }> }).commands.find((command) =>
					command.name.startsWith("ansteel-team"),
				)?.name;
				expect(teamCommand).toBeDefined();
				expect(
					await rpc.send({
						id: "start",
						type: "prompt",
						message: `/${teamCommand} start Exercise the ${testCase.scenario} action gate`,
					}),
				).toMatchObject({ success: true, command: "prompt" });

				const taskResponse = await rpc.send({
					id: "task",
					type: "prompt",
					message: `/${teamCommand} task {"id":"TASK-STAFF","owner":"staff-engineer","type":"implementation","files":["src/staff.ts"],"description":"Exercise the real RPC action gate","acceptanceCriteria":"A blocked action cannot change the tracked file","dependsOn":[]}`,
				});
				expect(taskResponse).toMatchObject({
					success: testCase.expectedRpcSuccess,
					command: "prompt",
				});
				if (!testCase.expectedRpcSuccess) {
					expect(taskResponse.error).toContain("ansteel_review_action");
				}

				const teamDirectory = join(projectDir, ".pi", "ansteel-team");
				const state = JSON.parse(readFileSync(join(teamDirectory, "team.json"), "utf8")) as {
					actionReviews: Array<{ reviewer: string; verdict: string }>;
					processIssues: Array<{ status: string; severity: string }>;
					tasks: Array<{ id: string; status: string; submissions: unknown[] }>;
				};
				const events = readFileSync(join(teamDirectory, "events.jsonl"), "utf8")
					.trim()
					.split("\n")
					.map(
						(line) =>
							JSON.parse(line) as {
								type: string;
								content: string;
								payload?: {
									kind?: string;
									assessment?: {
										action?: { computedRisk?: string };
										blockReason?: string;
									};
								};
							},
					);
				const blockedAssessment = events.find(
					(event) =>
						event.type === "action-assessed" &&
						event.payload?.kind === "action-assessed" &&
						event.payload.assessment?.blockReason !== undefined,
				);

				expect(readFileSync(join(projectDir, "src", "staff.ts"), "utf8")).toBe(
					"export const staff = 'NOT_IMPLEMENTED';\n",
				);
				expect(state.tasks).toEqual([
					expect.objectContaining({ id: "TASK-STAFF", status: "claimed", submissions: [] }),
				]);
				expect(state.actionReviews.map((review) => review.reviewer).sort()).toEqual(
					[...testCase.expectedReviewers].sort(),
				);
				expect(state.actionReviews.every((review) => review.verdict === "approve")).toBe(true);
				expect(state.processIssues.filter((issue) => issue.status !== "closed")).toHaveLength(
					testCase.expectedOpenIssues,
				);
				expect(blockedAssessment?.payload?.assessment).toMatchObject({
					action: { computedRisk: testCase.expectedComputedRisk },
					blockReason: expect.stringContaining(testCase.expectedBlockReason),
				});
				expect(events).toContainEqual(
					expect.objectContaining({
						type: "role-report",
						content: expect.stringContaining("claimed the file was implemented despite the blocked tool call"),
					}),
				);
			} finally {
				await rpc.stop();
			}
		},
		30_000,
	);

	it("fails a task RPC when the owner public checkpoint mutation is rejected", async () => {
		const { agentDir, projectDir } = createTemporaryProject(DETERMINISTIC_TASK_OWNER_COLLABORATION_FAILURE_EXTENSION);
		initializeTaskDeliveryProject(projectDir);
		const rpc = startRpcCli(projectDir, agentDir);
		try {
			const commands = await rpc.send({ id: "commands", type: "get_commands" });
			const teamCommand = (commands.data as { commands: Array<{ name: string }> }).commands.find((command) =>
				command.name.startsWith("ansteel-team"),
			)?.name;
			expect(teamCommand).toBeDefined();
			expect(
				await rpc.send({
					id: "start",
					type: "prompt",
					message: `/${teamCommand} start Exercise task owner failure propagation`,
				}),
			).toMatchObject({ success: true, command: "prompt" });

			const task = await rpc.send({
				id: "task-owner-failure",
				type: "prompt",
				message: `/${teamCommand} task {"id":"TASK-OWNER-FAIL","owner":"staff-engineer","type":"implementation","files":["src/staff.ts"],"description":"Exercise owner failure propagation","acceptanceCriteria":"The rejected checkpoint fails the RPC","dependsOn":[]}`,
			});

			expect(task).toMatchObject({
				success: false,
				command: "prompt",
				error: expect.stringContaining("ansteel_publish_checkpoint"),
			});
		} finally {
			await rpc.stop();
		}
	}, 30_000);

	it("fails a task RPC when a peer public process issue mutation is rejected", async () => {
		const { agentDir, projectDir } = createTemporaryProject(
			DETERMINISTIC_TASK_REVIEW_COLLABORATION_FAILURE_EXTENSION,
		);
		initializeTaskDeliveryProject(projectDir);
		const rpc = startRpcCli(projectDir, agentDir);
		try {
			const commands = await rpc.send({ id: "commands", type: "get_commands" });
			const teamCommand = (commands.data as { commands: Array<{ name: string }> }).commands.find((command) =>
				command.name.startsWith("ansteel-team"),
			)?.name;
			expect(teamCommand).toBeDefined();
			expect(
				await rpc.send({
					id: "start",
					type: "prompt",
					message: `/${teamCommand} start Exercise task peer failure propagation`,
				}),
			).toMatchObject({ success: true, command: "prompt" });

			const task = await rpc.send({
				id: "task-review-failure",
				type: "prompt",
				message: `/${teamCommand} task {"id":"TASK-STAFF","owner":"staff-engineer","type":"implementation","files":["src/staff.ts"],"description":"Exercise peer failure propagation","acceptanceCriteria":"The Staff test passes","dependsOn":[]}`,
			});

			expect(task).toMatchObject({
				success: false,
				command: "prompt",
				error: expect.stringContaining("ansteel_raise_process_issue"),
			});
		} finally {
			await rpc.stop();
		}
	}, 30_000);

	it("fails an ask RPC when a milestone peer public resolution mutation is rejected", async () => {
		const { agentDir, projectDir } = createTemporaryProject(
			DETERMINISTIC_MILESTONE_REVIEW_COLLABORATION_FAILURE_EXTENSION,
		);
		initializeTaskDeliveryProject(projectDir);
		const rpc = startRpcCli(projectDir, agentDir);
		try {
			const commands = await rpc.send({ id: "commands", type: "get_commands" });
			const teamCommand = (commands.data as { commands: Array<{ name: string }> }).commands.find((command) =>
				command.name.startsWith("ansteel-team"),
			)?.name;
			expect(teamCommand).toBeDefined();
			expect(
				await rpc.send({
					id: "start",
					type: "prompt",
					message: `/${teamCommand} start Exercise milestone peer failure propagation`,
				}),
			).toMatchObject({ success: true, command: "prompt" });
			expect(
				await rpc.send({
					id: "task",
					type: "prompt",
					message: `/${teamCommand} task {"id":"TASK-STAFF","owner":"staff-engineer","type":"implementation","files":["src/staff.ts"],"description":"Prepare milestone input","acceptanceCriteria":"The Staff test passes","dependsOn":[]}`,
				}),
			).toMatchObject({ success: true, command: "prompt" });

			const ask = await rpc.send({
				id: "milestone-review-failure",
				type: "prompt",
				message: `/${teamCommand} ask Exercise milestone review failure propagation`,
			});

			expect(ask).toMatchObject({
				success: false,
				command: "prompt",
				error: expect.stringContaining("ansteel_resolve_process_issue"),
			});
		} finally {
			await rpc.stop();
		}
	}, 30_000);

	it("completes a public correction loop through real RPC and rejects a non-author resolution review", async () => {
		const { agentDir, projectDir } = createTemporaryProject(DETERMINISTIC_CORRECTION_LOOP_PROVIDER_EXTENSION);
		const rpc = startRpcCli(projectDir, agentDir);
		try {
			const commands = await rpc.send({ id: "commands", type: "get_commands" });
			const teamCommand = (commands.data as { commands: Array<{ name: string }> }).commands.find((command) =>
				command.name.startsWith("ansteel-team"),
			)?.name;
			expect(teamCommand).toBeDefined();

			const start = await rpc.send({
				id: "start",
				type: "prompt",
				message: `/${teamCommand} start Exercise the public correction loop`,
			});
			expect(start).toMatchObject({ success: true, command: "prompt" });

			const teamDirectory = join(projectDir, ".pi", "ansteel-team");
			const state = JSON.parse(readFileSync(join(teamDirectory, "team.json"), "utf8")) as {
				workCheckpoints: Array<{ id: string; status: string; supersedesCheckpointId?: string }>;
				processIssues: Array<{
					id: string;
					status: string;
					targetCheckpointId: string;
					resolutions: Array<{
						id: string;
						replacementCheckpointId?: string;
						review?: { reviewer: string; verdict: string };
					}>;
				}>;
			};
			expect(state.workCheckpoints).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ id: "CP-RPC-0001", status: "superseded" }),
					expect.objectContaining({
						id: "CP-RPC-0002",
						status: "active",
						supersedesCheckpointId: "CP-RPC-0001",
					}),
				]),
			);
			expect(state.processIssues).toEqual([
				expect.objectContaining({
					id: "PI-RPC-0001",
					status: "closed",
					targetCheckpointId: "CP-RPC-0001",
					resolutions: [
						expect.objectContaining({
							id: "PR-RPC-0001",
							replacementCheckpointId: "CP-RPC-0002",
							review: expect.objectContaining({ reviewer: "qa-engineer", verdict: "accept" }),
						}),
					],
				}),
			]);
			const events = readFileSync(join(teamDirectory, "events.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { type: string });
			expect(events.map((event) => event.type)).toEqual(
				expect.arrayContaining([
					"work-checkpoint",
					"process-issue",
					"process-resolution",
					"process-resolution-review",
				]),
			);

			const board = await rpc.send({
				id: "board",
				type: "prompt",
				message: `/${teamCommand} board`,
			});
			expect(board).toMatchObject({ success: true, command: "prompt" });
			expect(JSON.stringify(rpc.records())).toContain("Open process issues: 0");

			const unauthorized = await rpc.send({
				id: "unauthorized-review",
				type: "prompt",
				message: `/${teamCommand} ask Attempt a non-author resolution review`,
			});
			expect(unauthorized).toMatchObject({
				success: false,
				command: "prompt",
				error: expect.stringContaining("ansteel_review_process_resolution"),
			});
		} finally {
			await rpc.stop();
		}
	}, 30_000);

	it("returns RPC failure for board and doctor after the public ledger is tampered", async () => {
		const { agentDir, projectDir } = createTemporaryProject(DETERMINISTIC_CORRECTION_LOOP_PROVIDER_EXTENSION);
		const rpc = startRpcCli(projectDir, agentDir);
		try {
			const commands = await rpc.send({ id: "commands", type: "get_commands" });
			const teamCommand = (commands.data as { commands: Array<{ name: string }> }).commands.find((command) =>
				command.name.startsWith("ansteel-team"),
			)?.name;
			expect(teamCommand).toBeDefined();

			const start = await rpc.send({
				id: "start",
				type: "prompt",
				message: `/${teamCommand} start Exercise corrupted-ledger RPC propagation`,
			});
			expect(start).toMatchObject({ success: true, command: "prompt" });

			const healthyBoard = await rpc.send({
				id: "healthy-board",
				type: "prompt",
				message: `/${teamCommand} board`,
			});
			expect(healthyBoard).toMatchObject({ success: true, command: "prompt" });
			const healthyRun = listAnsteelRuntimeRuns(projectDir).at(-1);
			expect(healthyRun).toBeDefined();

			const eventsPath = join(projectDir, ".pi", "ansteel-team", "events.jsonl");
			const events = readFileSync(eventsPath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			events[0].content = `${String(events[0].content)} tampered`;
			writeFileSync(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
			const postTamperRecordIndex = rpc.records().length;

			const doctor = await rpc.send({
				id: "tampered-doctor",
				type: "prompt",
				message: `/${teamCommand} doctor ${healthyRun!.runId}`,
			});
			expect(doctor).toMatchObject({
				success: false,
				command: "prompt",
				error: expect.stringContaining("persisted team integrity verification failed"),
			});

			const board = await rpc.send({
				id: "tampered-board",
				type: "prompt",
				message: `/${teamCommand} board`,
			});
			expect(board).toMatchObject({
				success: false,
				command: "prompt",
				error: expect.stringContaining("hash mismatch"),
			});
			const postTamperRecords = JSON.stringify(rpc.records().slice(postTamperRecordIndex));
			expect(postTamperRecords).not.toContain("Health: healthy");
			expect(postTamperRecords).not.toContain("Active checkpoints:");
		} finally {
			await rpc.stop();
		}
	}, 30_000);

	it("anchors and verifies approved task and milestone receipts through real Git RPC routes", async () => {
		const { agentDir, projectDir } = createTemporaryProject();
		const fixture = prepareAnchorRpcFixture(projectDir);
		const rpc = startRpcCli(projectDir, agentDir);
		try {
			const commands = await rpc.send({ id: "anchor-commands", type: "get_commands" });
			const teamCommand = (commands.data as { commands: Array<{ name: string }> }).commands.find((command) =>
				command.name.startsWith("ansteel-team"),
			)?.name;
			expect(teamCommand).toBeDefined();

			for (const [targetId, operation] of [
				[fixture.taskId, "task"],
				[fixture.milestoneId, "milestone"],
			] as const) {
				const anchored = await rpc.send({
					id: `anchor-${operation}`,
					type: "prompt",
					message: `/${teamCommand} anchor ${targetId} ${fixture.remote}`,
				});
				expect(anchored).toMatchObject({ success: true, command: "prompt" });
				const verified = await rpc.send({
					id: `verify-${operation}`,
					type: "prompt",
					message: `/${teamCommand} verify-anchor ${targetId} ${fixture.remote}`,
				});
				expect(verified).toMatchObject({ success: true, command: "prompt" });
			}

			const remoteMismatch = await rpc.send({
				id: "verify-anchor-remote-mismatch",
				type: "prompt",
				message: `/${teamCommand} verify-anchor ${fixture.taskId} origin`,
			});
			expect(remoteMismatch).toMatchObject({
				success: false,
				command: "prompt",
				error: expect.stringContaining("verification remote does not match"),
			});

			const events = readFileSync(join(projectDir, ".pi", "ansteel-team", "events.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { type: string; anchor?: { target?: { id?: string } } });
			expect(events).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "task-anchor",
						anchor: expect.objectContaining({ target: expect.objectContaining({ id: fixture.taskId }) }),
					}),
					expect.objectContaining({
						type: "milestone-anchor",
						anchor: expect.objectContaining({ target: expect.objectContaining({ id: fixture.milestoneId }) }),
					}),
				]),
			);
		} finally {
			await rpc.stop();
		}
	}, 60_000);

	it("returns RPC failure when doctor diagnoses a run without persisted logs", async () => {
		const { agentDir, projectDir } = createTemporaryProject();
		const rpc = startRpcCli(projectDir, agentDir);
		try {
			const commands = await rpc.send({ id: "commands", type: "get_commands" });
			const teamCommand = (commands.data as { commands: Array<{ name: string }> }).commands.find((command) =>
				command.name.startsWith("ansteel-team"),
			)?.name;
			expect(teamCommand).toBeDefined();

			const start = await rpc.send({
				id: "start",
				type: "prompt",
				message: `/${teamCommand} start Exercise missing runtime diagnosis`,
			});
			expect(start).toMatchObject({ success: true, command: "prompt" });
			const preDoctorRecordIndex = rpc.records().length;

			const doctor = await rpc.send({
				id: "missing-run-doctor",
				type: "prompt",
				message: `/${teamCommand} doctor RUN-00000000-0000-4000-8000-000000000000`,
			});
			expect(doctor).toMatchObject({
				success: false,
				command: "prompt",
				error: expect.stringContaining("unhealthy"),
			});
			const doctorRecords = JSON.stringify(rpc.records().slice(preDoctorRecordIndex));
			expect(doctorRecords).toContain("artifact-missing");
			expect(doctorRecords).not.toContain("Health: healthy");
		} finally {
			await rpc.stop();
		}
	}, 30_000);
});
