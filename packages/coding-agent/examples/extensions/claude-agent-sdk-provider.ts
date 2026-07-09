import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const standardCost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const opus5Cost = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };

const models: ProviderModelConfig[] = [
	model("sonnet", "Claude Sonnet", 1000000, 64000, true, { xhigh: "xhigh", max: "max" }),
	model("opus", "Claude Opus", 1000000, 128000, true, { xhigh: "xhigh", max: "max" }, opus5Cost),
	model("haiku", "Claude Haiku", 1000000, 64000, true),
	model("fable", "Claude Fable", 1000000, 128000, true, { xhigh: "xhigh", max: "max" }),
	model("claude-opus-5", "Claude Opus 5", 1000000, 128000, true, { xhigh: "xhigh", max: "max" }, opus5Cost),
	model("claude-opus-4-5-20251101", "Claude Opus 4.5", 1000000, 64000, true),
	model("claude-sonnet-4-5-20250929", "Claude Sonnet 4.5", 1000000, 64000, true),
	model("claude-haiku-4-5-20251001", "Claude Haiku 4.5", 1000000, 64000, true),
	model("claude-opus-4-1-20250805", "Claude Opus 4.1", 1000000, 32000, true),
	model("claude-opus-4-20250514", "Claude Opus 4", 1000000, 32000, true),
	model("claude-sonnet-4-20250514", "Claude Sonnet 4", 1000000, 64000, true),
	model("claude-3-7-sonnet-20250219", "Claude Sonnet 3.7", 200000, 64000, true),
	model("claude-3-5-haiku-20241022", "Claude Haiku 3.5", 200000, 8192, false),
];

export default function (pi: ExtensionAPI) {
	pi.registerProvider("claude-agent-sdk", {
		name: "Claude Agent SDK",
		baseUrl: "claude-agent-sdk://local",
		api: "claude-agent-sdk",
		apiKey: "$ANTHROPIC_API_KEY",
		models,
	});

	pi.registerProvider("claude-agent-sdk-subscription", {
		name: "Claude Agent SDK (subscription)",
		baseUrl: "claude-agent-sdk://local",
		api: "claude-agent-sdk",
		apiKey: "__PI_CLAUDE_AGENT_SDK_SUBSCRIPTION__",
		models,
	});
}

function model(
	id: string,
	name: string,
	contextWindow: number,
	maxTokens: number,
	reasoning: boolean,
	thinkingLevelMap?: ProviderModelConfig["thinkingLevelMap"],
	cost = standardCost,
): ProviderModelConfig {
	return {
		id,
		name,
		reasoning,
		thinkingLevelMap,
		input: ["text", "image"],
		cost,
		contextWindow,
		maxTokens,
	};
}
