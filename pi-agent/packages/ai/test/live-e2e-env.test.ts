import { describe, expect, it } from "vitest";
import { disableLiveE2ECredentials } from "../scripts/live-e2e-env.ts";

describe("live provider E2E environment", () => {
	it("removes only live-provider credentials when the explicit opt-in is absent", () => {
		const env: Record<string, string | undefined> = {
			QWEN_TOKEN_PLAN_CN_API_KEY: "token-plan-key",
			DEEPSEEK_API_KEY: "deepseek-key",
			GITHUB_TOKEN: "github-token",
			HTTPS_PROXY: "http://127.0.0.1:7890",
			AWS_REGION: "cn-beijing-1",
		};

		disableLiveE2ECredentials(env);

		expect(env).toEqual({ HTTPS_PROXY: "http://127.0.0.1:7890", AWS_REGION: "cn-beijing-1" });
	});

	it("keeps credentials when PI_RUN_LIVE_E2E is exactly enabled", () => {
		const env: Record<string, string | undefined> = {
			PI_RUN_LIVE_E2E: "1",
			QWEN_TOKEN_PLAN_CN_API_KEY: "token-plan-key",
		};

		disableLiveE2ECredentials(env);

		expect(env).toEqual({ PI_RUN_LIVE_E2E: "1", QWEN_TOKEN_PLAN_CN_API_KEY: "token-plan-key" });
	});

	it("does not treat arbitrary opt-in text as permission to spend provider credits", () => {
		const env: Record<string, string | undefined> = {
			PI_RUN_LIVE_E2E: "true",
			QWEN_TOKEN_PLAN_CN_API_KEY: "token-plan-key",
		};

		disableLiveE2ECredentials(env);

		expect(env).toEqual({ PI_RUN_LIVE_E2E: "true" });
	});
});
