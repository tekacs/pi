import { afterEach, describe, expect, it, vi } from "vitest";
import * as anthropic from "../src/api/anthropic-messages.ts";
import * as azure from "../src/api/azure-openai-responses.ts";
import * as mistral from "../src/api/mistral-conversations.ts";
import * as codex from "../src/api/openai-codex-responses.ts";
import * as completions from "../src/api/openai-completions.ts";
import * as responses from "../src/api/openai-responses.ts";
import { createFauxCore, fauxAssistantMessage } from "../src/providers/faux.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import type { Api, AssistantMessageEventStream, CacheRetention, Model, SimpleStreamOptions } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const context = normalizeContext({ messages: [{ role: "user", content: "Shared prefix", timestamp: 1 }] });
const token = `aaa.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic" } })).toString("base64")}.bbb`;
function model<T extends Api>(api: T): Model<T> {
	return {
		api,
		id: "synthetic",
		name: "Synthetic",
		provider: "synthetic",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		contextWindow: 128000,
		maxTokens: 4096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}
const adapters: Array<{
	name: string;
	run: (options: SimpleStreamOptions, simple: boolean) => AssistantMessageEventStream;
	header?: string;
	field?: string;
}> = [
	{
		name: "responses",
		field: "prompt_cache_key",
		header: "x-client-request-id",
		run: (options, simple) =>
			(simple ? responses.streamSimple : responses.stream)(model("openai-responses"), context, options),
	},
	{
		name: "completions",
		field: "prompt_cache_key",
		header: "x-session-affinity",
		run: (options, simple) =>
			(simple ? completions.streamSimple : completions.stream)(
				{ ...model("openai-completions"), compat: { sendSessionAffinityHeaders: true } },
				context,
				options,
			),
	},
	{
		name: "azure",
		field: "prompt_cache_key",
		run: (options, simple) =>
			(simple ? azure.streamSimple : azure.stream)(model("azure-openai-responses"), context, options),
	},
	{
		name: "codex",
		field: "prompt_cache_key",
		header: "session-id",
		run: (options, simple) =>
			(simple ? codex.streamSimple : codex.stream)(model("openai-codex-responses"), context, options),
	},
	{
		name: "anthropic",
		header: "x-session-affinity",
		run: (options, simple) =>
			(simple ? anthropic.streamSimple : anthropic.stream)(
				{ ...model("anthropic-messages"), compat: { sendSessionAffinityHeaders: true } },
				context,
				options,
			),
	},
	{
		name: "mistral",
		field: "promptCacheKey",
		header: "x-affinity",
		run: (options, simple) =>
			(simple ? mistral.streamSimple : mistral.stream)(model("mistral-conversations"), context, options),
	},
];

afterEach(() => {
	codex.closeOpenAICodexWebSocketSessions();
	codex.resetOpenAICodexWebSocketDebugStats();
	vi.unstubAllGlobals();
});

describe.each(adapters)("$name cache affinity", (adapter) => {
	for (const simple of [false, true]) {
		it.each([
			{ cacheKey: undefined, sessionId: "child", retention: "short", expected: "child" },
			{ cacheKey: "shared", sessionId: "child", retention: "short", expected: "shared" },
			{ cacheKey: "shared", sessionId: undefined, retention: "long", expected: "shared" },
			{ cacheKey: "shared", sessionId: "child", retention: "none", expected: undefined },
		] as const)(
			`uses $expected with retention $retention (simple=${simple})`,
			async ({ cacheKey, sessionId, retention, expected }) => {
				let payload: Record<string, unknown> | undefined;
				let headers: Headers | undefined;
				const fetch: typeof globalThis.fetch = async (_input, init) => {
					headers = new Headers(init?.headers);
					return new Response(JSON.stringify({ error: { message: "Synthetic rejection" } }), { status: 400 });
				};
				// No real network, credentials, or provider responses are used by this matrix.
				vi.stubGlobal("fetch", fetch);
				const result = await adapter
					.run(
						{
							apiKey: adapter.name === "codex" ? token : "synthetic-key",
							env: {},
							cacheKey,
							sessionId,
							cacheRetention: retention,
							fetch,
							transport: "sse",
							maxRetries: 0,
							onPayload: (value) => {
								payload = value as Record<string, unknown>;
							},
						},
						simple,
					)
					.result();
				expect(result.stopReason).toBe("error");
				expect(payload).toBeDefined();
				expect(headers).toBeDefined();
				if (adapter.field) expect(payload?.[adapter.field]).toBe(expected);
				if (adapter.header) expect(headers?.get(adapter.header)).toBe(expected ?? null);
			},
		);
	}
});

it("shares only the synthetic prompt cache across distinct sessions and honors retention", async () => {
	const faux = createFauxCore({});
	const call = async (sessionId: string, cacheKey?: string, cacheRetention: CacheRetention = "short") => {
		faux.setResponses([fauxAssistantMessage("ok")]);
		return faux.stream(faux.getModel(), context, { sessionId, cacheKey, cacheRetention }).result();
	};
	expect((await call("parent")).usage.cacheRead).toBe(0);
	expect((await call("child", "parent")).usage.cacheRead).toBeGreaterThan(0);
	expect((await call("other")).usage.cacheRead).toBe(0);
	expect((await call("child", "parent", "none")).usage.cacheRead).toBe(0);
});

it("keeps Codex connections, fallback and cleanup independent when cache keys match", async () => {
	const sockets: Socket[] = [];
	let fail = false;
	class Socket extends EventTarget {
		readyState = 1;
		readonly requests: Array<Record<string, unknown>> = [];
		readonly headers: Headers;
		constructor(_url: string, options: { headers: Record<string, string> }) {
			super();
			this.headers = new Headers(options.headers);
			sockets.push(this);
			queueMicrotask(() => this.dispatchEvent(new Event("open")));
		}
		send(data: string) {
			if (fail) {
				fail = false;
				throw new Error("Synthetic connection failure");
			}
			this.requests.push(JSON.parse(data));
			queueMicrotask(() =>
				this.dispatchEvent(
					new MessageEvent("message", {
						data: JSON.stringify({
							type: "response.completed",
							response: {
								id: `response-${sockets.indexOf(this)}`,
								status: "completed",
								usage: { input_tokens: 3, output_tokens: 0 },
							},
						}),
					}),
				),
			);
		}
		close() {
			this.readyState = 3;
		}
	}
	vi.stubGlobal("WebSocket", Socket);
	const fetch = vi.fn(async () => new Response("Synthetic HTTP rejection", { status: 400 }));
	vi.stubGlobal("fetch", fetch);
	const call = (sessionId: string, transport: "auto" | "websocket-cached" = "websocket-cached") =>
		codex
			.stream(model("openai-codex-responses"), context, {
				apiKey: token,
				sessionId,
				cacheKey: "shared",
				transport,
				env: {},
				maxRetries: 0,
			})
			.result();
	expect((await call("parent")).stopReason).toBe("stop");
	expect((await call("child")).stopReason).toBe("stop");
	expect(sockets).toHaveLength(2);
	for (const socket of sockets) {
		expect(socket.headers.get("session-id")).toBe("shared");
		expect(socket.requests[0].prompt_cache_key).toBe("shared");
		expect(socket.requests[0].previous_response_id).toBeUndefined();
	}
	cleanupSessionResources("child");
	expect(sockets[1].readyState).toBe(3);
	expect(sockets[0].readyState).toBe(1);
	expect((await call("parent")).stopReason).toBe("stop");
	expect(sockets).toHaveLength(2);
	expect(sockets[0].requests[1].previous_response_id).toBe("response-0");
	expect(codex.getOpenAICodexWebSocketDebugStats("parent")?.connectionsReused).toBe(1);
	expect(codex.getOpenAICodexWebSocketDebugStats("child")?.connectionsReused).toBe(0);
	expect(codex.getOpenAICodexWebSocketDebugStats("shared")).toBeUndefined();
	expect(fetch).not.toHaveBeenCalled();
	fail = true;
	expect((await call("child", "auto")).stopReason).toBe("error");
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(codex.getOpenAICodexWebSocketDebugStats("child")?.websocketFallbackActive).toBe(true);
	expect((await call("parent", "auto")).stopReason).toBe("stop");
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(codex.getOpenAICodexWebSocketDebugStats("parent")?.websocketFailures).toBe(0);
});
