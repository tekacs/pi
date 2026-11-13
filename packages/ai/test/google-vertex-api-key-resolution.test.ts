import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const googleGenAiMock = vi.hoisted(() => ({
	constructorCalls: [] as Array<Record<string, unknown>>,
	nextUsageMetadata: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@google/genai", () => {
	class GoogleGenAI {
		models = {
			generateContentStream: async function* () {
				const usageMetadata = googleGenAiMock.nextUsageMetadata ?? {
					promptTokenCount: 1,
					candidatesTokenCount: 1,
					totalTokenCount: 2,
				};
				googleGenAiMock.nextUsageMetadata = undefined;
				yield {
					responseId: "vertex-response-id",
					candidates: [
						{
							content: { parts: [{ text: "ok" }] },
							finishReason: "STOP",
						},
					],
					usageMetadata,
				};
			},
		};

		constructor(config: Record<string, unknown>) {
			googleGenAiMock.constructorCalls.push(config);
		}
	}

	return {
		GoogleGenAI,
		FinishReason: {
			STOP: "STOP",
			MAX_TOKENS: "MAX_TOKENS",
		},
		FunctionCallingConfigMode: {
			AUTO: "AUTO",
			ANY: "ANY",
			NONE: "NONE",
			VALIDATED: "VALIDATED",
		},
		ResourceScope: {
			COLLECTION: "COLLECTION",
		},
		ThinkingLevel: {
			THINKING_LEVEL_UNSPECIFIED: "THINKING_LEVEL_UNSPECIFIED",
			MINIMAL: "MINIMAL",
			LOW: "LOW",
			MEDIUM: "MEDIUM",
			HIGH: "HIGH",
		},
	};
});

import { stream as streamGoogleVertex } from "../src/api/google-vertex.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { Model } from "../src/types.ts";
import { formatUserAgent } from "../src/utils/identity.ts";

const PI_USER_AGENT = formatUserAgent();
const model = getModel("google-vertex", "gemini-3-flash-preview");
const context = normalizeContext({
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
});

const originalGoogleCloudApiKey = process.env.GOOGLE_CLOUD_API_KEY;

beforeEach(() => {
	googleGenAiMock.constructorCalls.length = 0;
	delete process.env.GOOGLE_CLOUD_API_KEY;
});

afterEach(() => {
	if (originalGoogleCloudApiKey === undefined) {
		delete process.env.GOOGLE_CLOUD_API_KEY;
	} else {
		process.env.GOOGLE_CLOUD_API_KEY = originalGoogleCloudApiKey;
	}
});

describe("google-vertex api key resolution", () => {
	it("falls back to ADC when options.apiKey is a placeholder marker", async () => {
		const stream = streamGoogleVertex(model, context, {
			apiKey: "<authenticated>",
			project: "test-project",
			location: "us-central1",
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({
			vertexai: true,
			project: "test-project",
			location: "us-central1",
			apiVersion: "v1",
		});
		expect(googleGenAiMock.constructorCalls[0]).not.toHaveProperty("apiKey");
	});

	it("falls back to ADC when options.apiKey is the gcp-vertex-credentials marker", async () => {
		const stream = streamGoogleVertex(model, context, {
			apiKey: "gcp-vertex-credentials",
			project: "test-project",
			location: "us-central1",
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({
			vertexai: true,
			project: "test-project",
			location: "us-central1",
			apiVersion: "v1",
		});
		expect(googleGenAiMock.constructorCalls[0]).not.toHaveProperty("apiKey");
	});

	it("falls back to ADC when GOOGLE_CLOUD_API_KEY is a placeholder marker", async () => {
		process.env.GOOGLE_CLOUD_API_KEY = "<authenticated>";

		const stream = streamGoogleVertex(model, context, {
			project: "test-project",
			location: "us-central1",
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({
			vertexai: true,
			project: "test-project",
			location: "us-central1",
			apiVersion: "v1",
		});
		expect(googleGenAiMock.constructorCalls[0]).not.toHaveProperty("apiKey");
	});

	it("still uses the API key client for real API keys", async () => {
		const stream = streamGoogleVertex(model, context, {
			apiKey: "AIzaSyExampleRealisticLookingApiKey123456",
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({
			vertexai: true,
			apiKey: "AIzaSyExampleRealisticLookingApiKey123456",
			apiVersion: "v1",
		});
		expect(googleGenAiMock.constructorCalls[0]).not.toHaveProperty("project");
		expect(googleGenAiMock.constructorCalls[0]).not.toHaveProperty("location");
	});

	it("does not forward generated Vertex base URL placeholders", async () => {
		const stream = streamGoogleVertex(model, context, {
			project: "test-project",
			location: "us-central1",
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]?.httpOptions).toEqual({
			headers: { "User-Agent": PI_USER_AGENT },
		});
	});

	it("lets explicit headers override the default User-Agent", async () => {
		const stream = streamGoogleVertex(model, context, {
			project: "test-project",
			location: "us-central1",
			headers: { "User-Agent": "custom-agent" },
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]?.httpOptions).toEqual({
			headers: { "User-Agent": "custom-agent" },
		});
	});

	it("forwards custom baseUrl to the ADC client", async () => {
		const customModel: Model<"google-vertex"> = { ...model, baseUrl: "https://proxy.example.com" };
		const stream = streamGoogleVertex(customModel, context, {
			project: "test-project",
			location: "us-central1",
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({
			vertexai: true,
			project: "test-project",
			location: "us-central1",
			apiVersion: "v1",
			httpOptions: {
				baseUrl: "https://proxy.example.com",
				baseUrlResourceScope: "COLLECTION",
			},
		});
	});

	it("forwards custom baseUrl to the API key client", async () => {
		const customModel: Model<"google-vertex"> = { ...model, baseUrl: "https://proxy.example.com" };
		const stream = streamGoogleVertex(customModel, context, {
			apiKey: "AIzaSyExampleRealisticLookingApiKey123456",
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({
			vertexai: true,
			apiKey: "AIzaSyExampleRealisticLookingApiKey123456",
			apiVersion: "v1",
			httpOptions: {
				baseUrl: "https://proxy.example.com",
				baseUrlResourceScope: "COLLECTION",
			},
		});
	});

	it("does not append apiVersion when custom baseUrl already includes one", async () => {
		const customModel: Model<"google-vertex"> = {
			...model,
			baseUrl: "https://proxy.example.com/v1/projects/test-project/locations/global",
		};
		const stream = streamGoogleVertex(customModel, context, {
			project: "test-project",
			location: "us-central1",
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({
			httpOptions: {
				baseUrl: "https://proxy.example.com/v1/projects/test-project/locations/global",
				baseUrlResourceScope: "COLLECTION",
				apiVersion: "",
			},
		});
	});

	it("sends X-Vertex-Ai-Session-Id from cacheKey or sessionId unless cacheRetention is none", async () => {
		await streamGoogleVertex(model, context, {
			project: "test-project",
			location: "global",
			sessionId: "session-123",
		}).result();

		await streamGoogleVertex(model, context, {
			apiKey: "AIzaSyExampleRealisticLookingApiKey123456",
			sessionId: "session-123",
			cacheKey: "cache-override-456",
		}).result();

		await streamGoogleVertex(model, context, {
			project: "test-project",
			location: "global",
			sessionId: "session-disabled",
			cacheRetention: "none",
		}).result();

		await streamGoogleVertex(model, context, {
			project: "test-project",
			location: "global",
			sessionId: "session-env-disabled",
			env: { PI_CACHE_RETENTION: "none" },
		}).result();

		await streamGoogleVertex(model, context, {
			project: "test-project",
			location: "global",
			sessionId: "session-default",
			headers: { "x-vertex-ai-session-id": "explicit-header-id" },
		}).result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(5);
		expect(googleGenAiMock.constructorCalls[0]?.httpOptions).toEqual({
			headers: {
				"User-Agent": PI_USER_AGENT,
				"X-Vertex-Ai-Session-Id": "session-123",
			},
		});
		expect(googleGenAiMock.constructorCalls[1]?.httpOptions).toEqual({
			headers: {
				"User-Agent": PI_USER_AGENT,
				"X-Vertex-Ai-Session-Id": "cache-override-456",
			},
		});
		expect(googleGenAiMock.constructorCalls[2]?.httpOptions).toEqual({
			headers: { "User-Agent": PI_USER_AGENT },
		});
		expect(googleGenAiMock.constructorCalls[3]?.httpOptions).toEqual({
			headers: { "User-Agent": PI_USER_AGENT },
		});
		expect(googleGenAiMock.constructorCalls[4]?.httpOptions).toEqual({
			headers: {
				"User-Agent": PI_USER_AGENT,
				"x-vertex-ai-session-id": "explicit-header-id",
			},
		});
	});

	it("scales usage cost from Vertex trafficType and marks serviceTier", async () => {
		const pricedModel: Model<"google-vertex"> = {
			...model,
			cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 },
		};

		googleGenAiMock.nextUsageMetadata = {
			promptTokenCount: 1_000_000,
			cachedContentTokenCount: 500_000,
			candidatesTokenCount: 100_000,
			totalTokenCount: 1_100_000,
			trafficType: "ON_DEMAND_PRIORITY",
		};
		const priority = await streamGoogleVertex(pricedModel, context, {
			project: "test-project",
			location: "global",
		}).result();
		expect(priority.usage.serviceTier).toBe("priority");
		expect(priority.usage.cost).toEqual({
			input: 1.8,
			output: 1.8,
			cacheRead: 0.09,
			cacheWrite: 0,
			total: 3.69,
			totalFromProvider: false,
		});

		googleGenAiMock.nextUsageMetadata = {
			promptTokenCount: 1_000_000,
			candidatesTokenCount: 100_000,
			totalTokenCount: 1_100_000,
			trafficType: "ON_DEMAND_FLEX",
		};
		const flex = await streamGoogleVertex(pricedModel, context, {
			project: "test-project",
			location: "global",
		}).result();
		expect(flex.usage.serviceTier).toBe("flex");
		expect(flex.usage.cost.total).toBe(1.5);
	});
});
