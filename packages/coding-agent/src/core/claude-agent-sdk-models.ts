import { createProvider, envApiKeyAuth, type Provider } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai/compat";

export const CLAUDE_AGENT_SDK_API = "claude-agent-sdk";
export const CLAUDE_AGENT_SDK_SUBSCRIPTION_AUTH = "__PI_CLAUDE_AGENT_SDK_SUBSCRIPTION__";

const standardCost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const opus5Cost = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };

export const CLAUDE_AGENT_SDK_MODELS = [
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

export function createClaudeAgentSdkProviderModels(provider: string): Model<Api>[] {
	return CLAUDE_AGENT_SDK_MODELS.map((entry) => ({ ...entry, provider }));
}

export function sdkProviders(): Provider[] {
	return [
		createProvider({
			id: "claude-agent-sdk",
			name: "Claude Agent SDK",
			baseUrl: "claude-agent-sdk://local",
			auth: { apiKey: envApiKeyAuth("Anthropic API key", ["ANTHROPIC_API_KEY"]) },
			models: createClaudeAgentSdkProviderModels("claude-agent-sdk"),
			api: {},
		}),
		createProvider({
			id: "claude-agent-sdk-subscription",
			name: "Claude Agent SDK (subscription)",
			baseUrl: "claude-agent-sdk://local",
			auth: {
				apiKey: {
					name: "Claude subscription",
					resolve: async () => ({
						auth: { apiKey: CLAUDE_AGENT_SDK_SUBSCRIPTION_AUTH },
						source: "Claude subscription",
					}),
				},
			},
			models: createClaudeAgentSdkProviderModels("claude-agent-sdk-subscription"),
			api: {},
		}),
	];
}

function model(
	id: string,
	name: string,
	contextWindow: number,
	maxTokens: number,
	reasoning: boolean,
	effortMap?: Model<Api>["thinkingLevelMap"],
	cost = standardCost,
): Omit<Model<Api>, "provider"> {
	return {
		id,
		name,
		api: CLAUDE_AGENT_SDK_API,
		baseUrl: "claude-agent-sdk://local",
		reasoning,
		thinkingLevelMap: reasoning ? { minimal: "low", ...effortMap } : undefined,
		input: ["text", "image"],
		cost,
		contextWindow,
		maxTokens,
	};
}
