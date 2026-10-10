import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { cleanupSessionResources, normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_AGENT_SDK_MODELS, CLAUDE_AGENT_SDK_SUBSCRIPTION_AUTH } from "../src/core/claude-agent-sdk-models.ts";
import { streamClaudeAgentSdk } from "../src/core/claude-agent-sdk-stream.ts";
import { type QueryInput, sdkQuery } from "./claude-sdk-fixture.ts";

const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	query: sdk.query,
	createSdkMcpServer: (value: unknown) => value,
}));

afterEach(() => {
	cleanupSessionResources();
	vi.unstubAllEnvs();
	sdk.query.mockReset();
});

describe("Claude credential profile", () => {
	it.each<{ ambient: Record<string, string>; request: Record<string, string>; expected: string }>([
		{ ambient: {}, request: {}, expected: "" },
		{ ambient: { CLAUDE_CONFIG_DIR: "/ambient" }, request: {}, expected: "/ambient" },
		{
			ambient: { CLAUDE_CONFIG_DIR: "/ambient" },
			request: { CLAUDE_CONFIG_DIR: "/selected" },
			expected: "/selected",
		},
		{
			ambient: { CLAUDE_SECURESTORAGE_CONFIG_DIR: "/secure" },
			request: { CLAUDE_CONFIG_DIR: "/selected" },
			expected: "/secure",
		},
		{
			ambient: { CLAUDE_SECURESTORAGE_CONFIG_DIR: "/secure" },
			request: { CLAUDE_SECURESTORAGE_CONFIG_DIR: "", CLAUDE_CONFIG_DIR: "/selected" },
			expected: "",
		},
		{
			ambient: {},
			request: {
				CLAUDE_SECURESTORAGE_CONFIG_DIR: "/secure",
				CLAUDE_CONFIG_DIR: "/selected",
				CLAUDE_CODE_OAUTH_TOKEN: "external-token",
			},
			expected: "/secure",
		},
	])("pins secure storage before SDK resume: $expected", async ({ ambient, request, expected }) => {
		vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
		vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", undefined);
		for (const [name, value] of Object.entries(ambient)) vi.stubEnv(name, value);
		sdk.query.mockImplementation(({ options }: QueryInput) =>
			sdkQuery(
				(async function* () {
					yield {
						type: "result",
						subtype: "success",
						result: "ok",
						usage: { input_tokens: 1, output_tokens: 1 },
						total_cost_usd: 0,
					} as SDKMessage;
				})(),
				options,
			),
		);
		const model = { ...CLAUDE_AGENT_SDK_MODELS[0], provider: "claude-agent-sdk-subscription" };
		// Importing prior history forces the real adapter to supply a staged resume.
		const context = normalizeContext({
			messages: [
				{ role: "user", content: "earlier", timestamp: 0 },
				{ role: "user", content: "now", timestamp: 1 },
			],
		});
		const stream = streamClaudeAgentSdk(model, context, {
			cwd: process.cwd(),
			tools: [],
			agentContext: { messages: [], tools: [] },
			apiKey: CLAUDE_AGENT_SDK_SUBSCRIPTION_AUTH,
			env: request,
		});
		for await (const event of stream) if (event.type === "assistant_message_commit") event.acknowledge?.();
		expect((await stream.result()).stopReason).toBe("stop");
		const options = (sdk.query.mock.calls[0][0] as QueryInput).options;
		expect(options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(expected);
		expect(options.env.CLAUDE_CONFIG_DIR).toBe(request.CLAUDE_CONFIG_DIR ?? ambient.CLAUDE_CONFIG_DIR);
		expect(options.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(
			request.CLAUDE_CODE_OAUTH_TOKEN ?? process.env.CLAUDE_CODE_OAUTH_TOKEN,
		);
	});
});
