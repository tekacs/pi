import { afterEach, describe, expect, it } from "vitest";
import { openAIResponsesApi } from "../src/api/openai-responses.lazy.ts";
import * as responses from "../src/api/openai-responses.ts";
import { createModels, createProvider } from "../src/models.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import type { Context, Model, StreamOptions } from "../src/types.ts";
import { withClientIdentity } from "../src/utils/identity.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { barrier } from "./codex-socket.ts";

const model: Model<"openai-responses"> = {
	id: "example",
	name: "Example",
	provider: "example",
	api: "openai-responses",
	baseUrl: "https://example.invalid/v1",
	reasoning: true,
	input: ["text"],
	contextWindow: 100000,
	maxTokens: 1000,
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
	compat: { preparation: "cache", supportsExplicitPromptCacheMode: true },
};
const context: Context = {
	messages: [{ role: "system", timestamp: 0, content: [{ type: "text", text: "Common", cache: { ttl: "12h" } }] }],
};

function response(overrides: Record<string, unknown> = {}): Response {
	const body = {
		id: "prepared",
		status: "completed",
		output: [],
		usage: {
			input_tokens: 12000,
			output_tokens: 0,
			total_tokens: 12000,
			input_tokens_details: {
				cached_tokens: 4000,
				cache_write_tokens: 7000,
				cache_write_tokens_details: { ttl_30m_tokens: 3000, ttl_12h_tokens: 4000 },
			},
		},
		...overrides,
	};
	return new Response(`data: ${JSON.stringify({ type: "response.completed", response: body })}\n\ndata: [DONE]\n\n`, {
		headers: { "content-type": "text/event-stream", "x-example": "received" },
	});
}

function models() {
	const collection = createModels();
	collection.setProvider(
		createProvider({
			id: "example",
			models: [model],
			api: openAIResponsesApi(),
			auth: {
				apiKey: {
					name: "Example",
					resolve: async () => ({
						auth: { apiKey: "sk-example", headers: { "x-auth": "resolved" } },
						source: "example",
					}),
				},
			},
		}),
	);
	return collection;
}

afterEach(async () => {
	await cleanupSessionResources("http-example");
});

describe("native Responses cache preparation", () => {
	it("shares auth, headers, options, payload hooks and usage decoding with ordinary requests", async () => {
		const bodies: Record<string, unknown>[] = [];
		const headers: Headers[] = [];
		let payloads = 0;
		let replies = 0;
		let events = 0;
		const collection = models();
		const options = {
			sessionId: "http-example",
			reasoning: "high" as const,
			promptCache: { mode: "explicit" as const, ttl: "30m" as const },
			samplingParams: { top_p: 0.7 },
			transformHeaders: (value: Record<string, string | null>) => ({ ...value, "x-route": "selected" }),
			onPayload: () => {
				payloads++;
			},
			onResponse: () => {
				replies++;
			},
			onProviderStreamEvent: () => {
				events++;
			},
			fetch: (async (_input, init) => {
				bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
				headers.push(new Headers(init?.headers));
				return response();
			}) satisfies typeof fetch,
		};
		const prepared = await collection.prepareSimple(model, context, options);
		const generated = await collection.completeSimple(model, context, options);
		expect(prepared).toMatchObject({ responseId: "prepared", reused: false });
		expect(prepared.usage?.cost.total).toBeCloseTo(0.01515);
		expect(generated.stopReason).toBe("stop");
		const first = bodies[0]!;
		const second = bodies[1]!;
		expect(first).toEqual({ ...second, prompt_cache_options: { mode: "explicit", ttl: "30m", prewarm: true } });
		expect(first.reasoning).toMatchObject({ effort: "high" });
		expect(first.top_p).toBe(0.7);
		expect(headers.map((value) => value.get("authorization"))).toEqual(["Bearer sk-example", "Bearer sk-example"]);
		for (const value of headers) {
			expect(value.get("x-auth")).toBe("resolved");
			expect(value.get("x-route")).toBe("selected");
			expect(value.get("x-client-request-id")).toBe("http-example");
		}
		expect([payloads, replies, events]).toEqual([2, 2, 2]);
	});

	it("retains wrapper identity on both preparation methods, with request overrides", async () => {
		const collection = withClientIdentity(models(), { userAgent: { custom: "example/1" } });
		const agents: (string | null)[] = [];
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			agents.push(new Headers(init?.headers).get("user-agent"));
			return response();
		};
		await collection.prepare(model, context, { fetch });
		await collection.prepareSimple(model, context, { fetch, identity: { userAgent: "short" } });
		expect(agents).toEqual(["example/1", "pi"]);
	});

	it("forces prewarm and streaming after a payload hook", async () => {
		let sent: Record<string, unknown> | undefined;
		await responses.prepare(model, normalizeContext(context), {
			apiKey: "sk-example",
			onPayload: (payload) => ({
				...(payload as object),
				stream: false,
				prompt_cache_options: { prewarm: false, ttl: "12h" },
			}),
			fetch: async (_input, init) => {
				sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return response();
			},
		});
		expect(sent).toMatchObject({ stream: true, prompt_cache_options: { prewarm: true, ttl: "12h" } });
	});

	it.each([
		{ status: "incomplete" },
		{ status: "failed" },
		{ error: { code: "failure" } },
		{ id: "" },
		{ id: 42 },
		{ id: {} },
		{ output: [{ type: "message" }] },
		{ output: undefined },
		{ usage: { output_tokens: 1 } },
	])("rejects non-completion or generated output %j", async (overrides) => {
		await expect(
			responses.prepare(model, normalizeContext(context), {
				apiKey: "sk-example",
				fetch: async () => response(overrides),
			}),
		).rejects.toThrow();
	});

	it("rejects EOF without a completed response", async () => {
		await expect(
			responses.prepare(model, normalizeContext(context), {
				apiKey: "sk-example",
				fetch: async () => new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }),
			}),
		).rejects.toThrow("before response.completed");
	});

	it("does not assume OpenRouter cache controls imply non-generation support", async () => {
		let calls = 0;
		const selected = {
			...model,
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			compat: { supportsExplicitPromptCacheMode: true },
		};
		await expect(
			responses.prepare(selected, normalizeContext(context), {
				apiKey: "sk-example",
				fetch: async () => {
					calls++;
					return response();
				},
			}),
		).rejects.toThrow("does not support");
		expect(calls).toBe(0);
	});

	it("never substitutes a generation when a provider has no prepare operation", async () => {
		let calls = 0;
		const collection = createModels();
		const unexpected = () => {
			calls++;
			throw new Error("Unexpected generation");
		};
		collection.setProvider(
			createProvider({
				id: "example",
				models: [model],
				api: { stream: unexpected, streamSimple: unexpected },
				auth: {
					apiKey: {
						name: "Example",
						resolve: async () => ({ auth: { apiKey: "sk-example" }, source: "example" }),
					},
				},
			}),
		);
		await expect(collection.prepare(model, context)).rejects.toThrow("does not support");
		await expect(collection.prepareSimple(model, context)).rejects.toThrow("does not support");
		expect(calls).toBe(0);
	});

	it("cancels and joins a pending HTTP request during session cleanup", async () => {
		const entered = barrier();
		let aborted = false;
		const options: StreamOptions = {
			sessionId: "http-example",
			fetch: async (_input, init) => {
				entered.resolve();
				return new Promise<Response>((_resolve, reject) => {
					const abort = () => {
						aborted = true;
						reject(new Error("aborted"));
					};
					init?.signal?.addEventListener("abort", abort, { once: true });
					if (init?.signal?.aborted) abort();
				});
			},
		};
		const task = models()
			.prepare(model, context, options)
			.catch((error: unknown) => error);
		await entered.promise;
		await cleanupSessionResources("http-example");
		expect(aborted).toBe(true);
		expect(await task).toBeInstanceOf(Error);
	});
});
