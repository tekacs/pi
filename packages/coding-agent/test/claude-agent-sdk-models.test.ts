import { describe, expect, it } from "vitest";
import { CLAUDE_AGENT_SDK_MODELS } from "../src/core/claude-agent-sdk-models.ts";

describe("Claude Agent SDK models", () => {
	it("exposes Fable 5.1 explicitly while keeping the Fable 5 gateway alias", () => {
		const alias = CLAUDE_AGENT_SDK_MODELS.find((model) => model.id === "fable");
		const fable = CLAUDE_AGENT_SDK_MODELS.find((model) => model.id === "claude-fable-5-1");

		expect(alias).toMatchObject({
			name: "Claude Fable",
			cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
		});
		expect(fable).toMatchObject({
			name: "Claude Fable 5.1",
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			thinkingLevelMap: { off: null, minimal: "low", xhigh: "xhigh", max: "max" },
			cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
		});
	});
});
