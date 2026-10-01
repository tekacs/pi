import type Anthropic from "@anthropic-ai/sdk";
import type * as BedrockSdk from "@aws-sdk/client-bedrock-runtime";
import type * as GoogleSdk from "@google/genai";
import { describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
	googleError: undefined as unknown,
	bedrockError: undefined as unknown,
	bedrockEvent: undefined as unknown,
}));

vi.mock("@google/genai", async (importOriginal) => ({
	...(await importOriginal<typeof GoogleSdk>()),
	GoogleGenAI: class {
		models = {
			generateContentStream: async () => {
				throw sdk.googleError;
			},
		};
	},
}));

vi.mock("@aws-sdk/client-bedrock-runtime", async (importOriginal) => ({
	...(await importOriginal<typeof BedrockSdk>()),
	BedrockRuntimeClient: class {
		middlewareStack = { add: () => {} };
		send = async () => {
			if (sdk.bedrockEvent) {
				return {
					$metadata: { httpStatusCode: 200 },
					stream: (async function* () {
						yield sdk.bedrockEvent;
					})(),
				};
			}
			throw sdk.bedrockError;
		};
	},
}));

import { stream as anthropic } from "../src/api/anthropic-messages.ts";
import { stream as azure } from "../src/api/azure-openai-responses.ts";
import { stream as bedrock } from "../src/api/bedrock-converse-stream.ts";
import { stream as google } from "../src/api/google-generative-ai.ts";
import { stream as vertex } from "../src/api/google-vertex.ts";
import { stream as mistral } from "../src/api/mistral-conversations.ts";
import { stream as completions } from "../src/api/openai-completions.ts";
import { stream as piMessages } from "../src/api/pi-messages.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { AssistantMessage, FetchFunction, Model } from "../src/types.ts";

const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });

function expectFailure(message: AssistantMessage, failure: NonNullable<AssistantMessage["failure"]>): void {
	expect(message.stopReason).toBe("error");
	expect(message.failure).toEqual(failure);
}

const httpFailure: FetchFunction = async () =>
	new Response(JSON.stringify({ error: { message: "busy", code: "service_unavailable", type: "server_error" } }), {
		status: 503,
		headers: { "content-type": "application/json" },
	});

function sse(data: unknown): Response {
	return new Response(`data: ${JSON.stringify(data)}\n\n`, { headers: { "content-type": "text/event-stream" } });
}

// Regression for incident #35577: provider failure facts survive every chat adapter boundary.
describe("structured chat adapter failures", () => {
	it("retains Anthropic SDK HTTP metadata", async () => {
		const error = Object.assign(new Error("server busy"), {
			status: 503,
			error: { type: "overloaded_error", code: "overloaded" },
		});
		const client = {
			beta: {
				messages: {
					create: () => ({
						asResponse: async () => {
							throw error;
						},
					}),
				},
			},
		} as unknown as Anthropic;
		const result = await anthropic(getModel("anthropic", "claude-haiku-4-5"), context, { client }).result();
		expectFailure(result, { status: 503, code: "overloaded", type: "overloaded_error" });
	});

	it("retains provider type but not the SSE envelope type", async () => {
		const response = new Response(
			'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","code":"overloaded"}}\n\n',
		);
		const client = {
			beta: { messages: { create: () => ({ asResponse: async () => response }) } },
		} as unknown as Anthropic;
		const result = await anthropic(getModel("anthropic", "claude-haiku-4-5"), context, { client }).result();
		expectFailure(result, { code: "overloaded", type: "overloaded_error" });
	});

	it("retains OpenAI-compatible Chat Completions HTTP metadata", async () => {
		const model: Model<"openai-completions"> = { ...getModel("openai", "gpt-4o"), api: "openai-completions" };
		const result = await completions(model, context, {
			apiKey: "test",
			fetch: httpFailure,
		}).result();
		expectFailure(result, { status: 503, code: "service_unavailable", type: "server_error" });
	});

	it("retains Azure Responses HTTP metadata", async () => {
		const model = getModel("openai", "gpt-4o");
		const azureModel: Model<"azure-openai-responses"> = {
			...model,
			api: "azure-openai-responses",
			provider: "azure-openai-responses",
			baseUrl: "https://example.openai.azure.com/openai/v1",
		};
		const result = await azure(azureModel, context, { apiKey: "test", fetch: httpFailure }).result();
		expectFailure(result, { status: 503, code: "service_unavailable", type: "server_error" });
	});

	it("retains Google and Vertex SDK status/code without attributing a handshake", async () => {
		sdk.googleError = Object.assign(new Error("resource exhausted"), {
			status: 429,
			code: "RESOURCE_EXHAUSTED",
		});
		const gemini = await google(getModel("google", "gemini-2.5-flash"), context, { apiKey: "test" }).result();
		const vertexModel = { ...getModel("google", "gemini-2.5-flash"), api: "google-vertex" as const };
		const vertexResult = await vertex(vertexModel, context, { apiKey: "test" }).result();
		expectFailure(gemini, { status: 429, code: "RESOURCE_EXHAUSTED" });
		expectFailure(vertexResult, { status: 429, code: "RESOURCE_EXHAUSTED" });
	});

	it("retains Bedrock exception metadata and modeled code", async () => {
		sdk.bedrockError = Object.assign(new Error("busy"), {
			name: "ServiceUnavailableException",
			$metadata: { httpStatusCode: 503 },
		});
		const result = await bedrock(getModel("amazon-bedrock", "us.anthropic.claude-opus-4-8"), context, {
			cacheRetention: "none",
		}).result();
		expectFailure(result, { status: 503, type: "ServiceUnavailableException" });
	});

	it("retains Bedrock's event discriminator for bare stream exceptions", async () => {
		sdk.bedrockEvent = { throttlingException: { message: "busy" } };
		const result = await bedrock(getModel("amazon-bedrock", "us.anthropic.claude-opus-4-8"), context, {
			cacheRetention: "none",
		}).result();
		expectFailure(result, { code: "ThrottlingException" });
		sdk.bedrockEvent = undefined;
	});

	it("retains Mistral HTTP and SSE error codes", async () => {
		const model = getModel("mistral", "mistral-large-latest");
		const http = await mistral(model, context, { apiKey: "test", fetch: httpFailure }).result();
		const streamed = await mistral(model, context, {
			apiKey: "test",
			fetch: async () => sse({ error: { message: "busy", code: "service_unavailable", type: "server_error" } }),
		}).result();
		expectFailure(http, { status: 503, code: "service_unavailable", type: "server_error" });
		expectFailure(streamed, { code: "service_unavailable", type: "server_error" });
	});

	it("retains pi-messages HTTP and wire failure facts", async () => {
		const { compat: _compat, ...base } = getModel("openai", "gpt-4o");
		const model: Model<"pi-messages"> = {
			...base,
			api: "pi-messages",
			provider: "radius",
			baseUrl: "https://example.com",
		};
		const http = await piMessages(model, context, { apiKey: "test", fetch: httpFailure }).result();
		const streamed = await piMessages(model, context, {
			apiKey: "test",
			fetch: async () =>
				sse({
					type: "error",
					reason: "error",
					errorMessage: "busy",
					failure: { code: "overloaded" },
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				}),
		}).result();
		expectFailure(http, { status: 503, code: "service_unavailable", type: "server_error" });
		expectFailure(streamed, { code: "overloaded" });
	});
});
