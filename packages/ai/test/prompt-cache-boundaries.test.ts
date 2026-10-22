import { describe, expect, it } from "vitest";
import { stream as codex } from "../src/api/openai-codex-responses.ts";
import { stream as completions } from "../src/api/openai-completions.ts";
import { applyCacheWrites } from "../src/api/openai-prompt-cache.ts";
import { stream as responses } from "../src/api/openai-responses.ts";
import { calculateCost } from "../src/models.ts";
import type { Context, Model, StreamOptions, Usage } from "../src/types.ts";
import { getSystemMessageText } from "../src/utils/text.ts";
import { getCurrentSystemMessage, normalizeContext } from "../src/utils/transcript.ts";

type CacheApi = "openai-completions" | "openai-responses" | "openai-codex-responses";

function model<T extends CacheApi>(api: T): Model<T> {
	return {
		id: "example",
		name: "Example",
		provider: "example",
		api,
		baseUrl: "https://example.invalid/v1",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 100000,
		maxTokens: 1000,
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
		compat: { supportsExplicitPromptCacheMode: true } as Model<T>["compat"],
	};
}

const context: Context = {
	messages: [
		{
			role: "system",
			timestamp: 0,
			content: [
				{ type: "text", text: "Common", cache: { ttl: "12h" } },
				{ type: "text", text: "Session", cache: { ttl: "30m" } },
			],
			sections: { extra: "Extra" },
		},
	],
};

interface Payload {
	instructions?: string;
	prompt_cache_options?: { mode?: string; ttl?: string };
	prompt_cache_retention?: string;
	input?: { role?: string; content?: unknown; output?: unknown }[];
	messages?: { role?: string; content?: unknown }[];
}

async function capture(api: CacheApi, input = context, options: StreamOptions = {}, supported = true) {
	let payload: Payload | undefined;
	let requests = 0;
	const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "example" } })).toString("base64url")}.signature`;
	const selected = model(api);
	selected.compat = { supportsExplicitPromptCacheMode: supported };
	const settings: StreamOptions = {
		apiKey: api === "openai-codex-responses" ? token : "sk-example",
		transport: "sse",
		env: { PI_CACHE_RETENTION: "short" },
		fetch: async () => {
			requests++;
			throw new Error("Unexpected network request");
		},
		onPayload: (value) => {
			payload = structuredClone(value) as Payload;
			throw new Error("Captured");
		},
		...options,
	};
	const transcript = normalizeContext(input);
	const output =
		api === "openai-completions"
			? await completions(modelWithApi(selected, "openai-completions"), transcript, settings).result()
			: api === "openai-responses"
				? await responses(modelWithApi(selected, "openai-responses"), transcript, settings).result()
				: await codex(modelWithApi(selected, "openai-codex-responses"), transcript, settings).result();
	expect(requests).toBe(0);
	return { payload, output };
}

function modelWithApi<T extends CacheApi>(value: Model<CacheApi>, api: T): Model<T> {
	return { ...value, api } as Model<T>;
}

describe("modern cache boundaries", () => {
	it.each<CacheApi>(["openai-completions", "openai-responses", "openai-codex-responses"])(
		"preserves common and session boundaries through %s",
		async (api) => {
			const before = structuredClone(context);
			const { payload, output } = await capture(api, context, { promptCache: { mode: "explicit", ttl: "30m" } });
			expect(output.errorMessage).toContain("Captured");
			expect(payload?.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" });
			expect(payload?.prompt_cache_retention).toBeUndefined();
			const messages = payload?.input ?? payload?.messages;
			const type = api === "openai-completions" ? "text" : "input_text";
			expect(messages?.[0]?.content).toEqual([
				{ type, text: "Common", prompt_cache_breakpoint: { mode: "explicit", ttl: "12h" } },
				{ type, text: "\nSession", prompt_cache_breakpoint: { mode: "explicit", ttl: "30m" } },
				{ type, text: "\n\nExtra" },
			]);
			if (api === "openai-codex-responses") expect(payload?.instructions).toBe("");
			expect(context).toEqual(before);
		},
	);

	it("keeps exact text and markers across collapsed system updates", () => {
		const messages: Context["messages"] = [
			...context.messages,
			{
				role: "system",
				timestamp: 1,
				content: [{ type: "text", text: "Later", cache: {} }],
				sections: { extra: null, replacement: "New" },
			},
		];
		const current = getCurrentSystemMessage(messages)!;
		expect(getSystemMessageText(current)).toBe("Common\nSession\n\nLater\n\nNew");
		expect(current.content).toEqual([
			{ type: "text", text: "Common", cache: { ttl: "12h" } },
			{ type: "text", text: "Session", cache: { ttl: "30m" } },
			{ type: "text", text: "\nLater", cache: {} },
		]);
		expect(getCurrentSystemMessage([current])).toEqual(current);
	});

	it.each<CacheApi>(["openai-completions", "openai-responses", "openai-codex-responses"])(
		"rejects unsupported and contradictory controls before %s dispatch",
		async (api) => {
			const unsupported = await capture(api, context, {}, false);
			expect(unsupported.payload).toBeUndefined();
			expect(unsupported.output.errorMessage).toContain("does not support");
			const contradictory = await capture(api, context, { cacheRetention: "long" });
			expect(contradictory.payload).toBeUndefined();
			expect(contradictory.output.errorMessage).toContain("cannot be combined");
		},
	);

	it.each<CacheApi>(["openai-completions", "openai-responses"])(
		"maps text and image user boundaries through %s",
		async (api) => {
			const input: Context = {
				messages: [
					{
						role: "user",
						timestamp: 0,
						content: [
							{ type: "text", text: "Reference", cache: {} },
							{ type: "image", data: "AA==", mimeType: "image/png", cache: { ttl: "12h" } },
						],
					},
				],
			};
			const { payload } = await capture(api, input);
			const messages = payload?.input ?? payload?.messages;
			expect(messages?.[0]?.content).toMatchObject([
				{ prompt_cache_breakpoint: { mode: "explicit" } },
				{ prompt_cache_breakpoint: { mode: "explicit", ttl: "12h" } },
			]);
		},
	);

	it.each<CacheApi>(["openai-completions", "openai-responses"])(
		"keeps unmarked system encoding unchanged in %s",
		async (api) => {
			const input: Context = {
				messages: [
					{
						role: "system",
						timestamp: 0,
						content: [
							{ type: "text", text: "A" },
							{ type: "text", text: "B" },
						],
						sections: { c: "C" },
					},
				],
			};
			const { payload } = await capture(api, input);
			expect((payload?.input ?? payload?.messages)?.[0]?.content).toBe("A\nB\n\nC");
		},
	);

	it.each<CacheApi>(["openai-completions", "openai-responses"])(
		"rejects assistant and empty-text boundaries in %s",
		async (api) => {
			const empty = await capture(api, {
				messages: [{ role: "user", timestamp: 0, content: [{ type: "text", text: "", cache: {} }] }],
			});
			expect(empty.payload).toBeUndefined();
			expect(empty.output.errorMessage).toContain("must not be empty");
			const assistant = await capture(api, {
				messages: [
					{
						role: "assistant",
						api,
						provider: "example",
						model: "example",
						timestamp: 0,
						content: [{ type: "text", text: "Answer", cache: {} }],
						usage: usage(),
						stopReason: "stop",
					},
				],
			});
			expect(assistant.payload).toBeUndefined();
			expect(assistant.output.errorMessage).toContain("require input");
		},
	);

	it("does not move a tool-image boundary to a synthetic user message", async () => {
		const input: Context = {
			messages: [
				{
					role: "toolResult",
					toolName: "read",
					toolCallId: "call",
					timestamp: 0,
					isError: false,
					content: [{ type: "image", mimeType: "image/png", data: "AA==", cache: {} }],
				},
			],
		};
		const chat = await capture("openai-completions", input);
		expect(chat.payload).toBeUndefined();
		expect(chat.output.errorMessage).toContain("cannot preserve");
		const response = await capture("openai-responses", input);
		expect(response.payload?.input?.[0]?.output).toMatchObject([
			{ type: "input_image", prompt_cache_breakpoint: { mode: "explicit" } },
		]);
	});

	it("carries request-level 12h without legacy retention", async () => {
		const { payload } = await capture(
			"openai-responses",
			{ messages: [] },
			{
				promptCache: { ttl: "12h" },
				env: { PI_CACHE_RETENTION: "long" },
			},
		);
		expect(payload?.prompt_cache_options).toEqual({ ttl: "12h" });
		expect(payload?.prompt_cache_retention).toBeUndefined();
	});

	it.each<CacheApi>(["openai-completions", "openai-responses"])(
		"preserves marked text tool results in %s",
		async (api) => {
			const { payload } = await capture(api, {
				messages: [
					{
						role: "toolResult",
						toolName: "read",
						toolCallId: "call",
						isError: false,
						timestamp: 0,
						content: [
							{ type: "text", text: "One", cache: { ttl: "12h" } },
							{ type: "text", text: "Two" },
						],
					},
				],
			});
			const first = (payload?.input ?? payload?.messages)?.[0];
			expect(first && ("output" in first ? first.output : first.content)).toMatchObject([
				{ text: "One", prompt_cache_breakpoint: { mode: "explicit", ttl: "12h" } },
				{ text: api === "openai-completions" ? "\nTwo" : "Two" },
			]);
		},
	);
});

function usage(): Usage {
	return {
		input: 1000,
		output: 0,
		cacheRead: 4000,
		cacheWrite: 7000,
		totalTokens: 12000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("cache write accounting", () => {
	it("prices the reported non-overlapping lifetime split once", () => {
		const value = usage();
		applyCacheWrites(value, { ttl_30m_tokens: 3000, ttl_12h_tokens: 4000 }, true);
		calculateCost(model("openai-responses"), value);
		expect(value.cost.total).toBeCloseTo(0.01515);
		expect(value.cost.estimated).toBeUndefined();
	});

	it("labels an upper-rate estimate instead of inventing missing lifetime counts", () => {
		const value = usage();
		applyCacheWrites(value, undefined, true);
		calculateCost(model("openai-responses"), value);
		expect(value.cost.total).toBeCloseTo(0.0189);
		expect(value.cost.estimated).toBe(true);
		expect(value.cacheWriteDetails?.[0]?.ttlSeconds).toBeUndefined();
	});

	it.each([
		null,
		{},
		{ ttl_30m_tokens: 3000, ttl_12h_tokens: 3999 },
		{ ttl_30m_tokens: -1, ttl_12h_tokens: 7001 },
		{ ttl_30m_tokens: 0.5, ttl_12h_tokens: 6999.5 },
	])("refuses malformed lifetime counts %j", (details) => {
		expect(() => applyCacheWrites(usage(), details, true)).toThrow("Invalid cache-write");
	});

	it.each<CacheApi>(["openai-completions", "openai-responses"])(
		"decodes lifetime counts from the actual %s response",
		async (api) => {
			const detail = {
				cached_tokens: 4000,
				cache_write_tokens: 7000,
				cache_write_tokens_details: { ttl_30m_tokens: 3000, ttl_12h_tokens: 4000 },
			};
			const event =
				api === "openai-responses"
					? {
							type: "response.completed",
							response: {
								status: "completed",
								output: [],
								usage: {
									input_tokens: 12000,
									output_tokens: 0,
									total_tokens: 12000,
									input_tokens_details: detail,
								},
							},
						}
					: {
							id: "example",
							choices: [{ delta: {}, finish_reason: "stop" }],
							usage: {
								prompt_tokens: 12000,
								completion_tokens: 0,
								prompt_tokens_details: detail,
							},
						};
			const options: StreamOptions = {
				apiKey: "sk-example",
				fetch: async () =>
					new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
						headers: { "content-type": "text/event-stream" },
					}),
			};
			const input = normalizeContext({ messages: [] });
			const output =
				api === "openai-responses"
					? await responses(model("openai-responses"), input, options).result()
					: await completions(model("openai-completions"), input, options).result();
			expect(output.stopReason).toBe("stop");
			expect(output.usage.input).toBe(1000);
			expect(output.usage.cost.total).toBeCloseTo(0.01515);
		},
	);
});
