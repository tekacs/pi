import type { Query, SDKMessage, SDKResultMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent, Context } from "@earendil-works/pi-ai";
import { cleanupSessionResources, isContextOverflow } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_AGENT_SDK_MODELS } from "../src/core/claude-agent-sdk-models.ts";
import { streamClaudeAgentSdk } from "../src/core/claude-agent-sdk-stream.ts";

const sdk = vi.hoisted(() => ({
	createServer: vi.fn(),
	query: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	createSdkMcpServer: sdk.createServer,
	query: sdk.query,
}));

type MockServer = {
	tools: Array<{
		inputSchema: Record<string, { safeParse: (value: unknown) => { success: boolean } }>;
		handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
	}>;
};

type QueryInput = {
	prompt: AsyncIterable<SDKUserMessage>;
	options: {
		env: Record<string, string | undefined>;
		mcpServers: { pi: MockServer };
		forwardSubagentText: boolean;
		resume?: string;
	};
};

const testSessions = [
	"claude-sdk-persistent",
	"claude-sdk-resume",
	"claude-sdk-divergence",
	"claude-sdk-overflow",
	"claude-sdk-reset-fallback",
];

function fableModel() {
	const model = CLAUDE_AGENT_SDK_MODELS.find((candidate) => candidate.id === "fable");
	if (!model) throw new Error("Missing fable model");
	return { ...model, provider: "claude-agent-sdk" };
}

function assistant(
	content: unknown[],
	parentToolUseId: string | null = null,
	metadata: {
		id?: string;
		uuid?: string;
		supersedes?: string[];
		usage?: {
			input_tokens: number;
			output_tokens: number;
			cache_read_input_tokens?: number;
			cache_creation_input_tokens?: number;
			iterations?: Array<{
				input_tokens: number;
				output_tokens: number;
				cache_read_input_tokens: number;
				cache_creation_input_tokens: number;
			}>;
		};
	} = {},
): SDKMessage {
	return {
		type: "assistant",
		parent_tool_use_id: parentToolUseId,
		uuid: metadata.uuid,
		supersedes: metadata.supersedes,
		message: {
			id: metadata.id,
			content,
			usage: metadata.usage ?? { input_tokens: 0, output_tokens: 0 },
		},
	} as SDKMessage;
}

function streamEvent(event: unknown): SDKMessage {
	return { type: "stream_event", event } as SDKMessage;
}

function init(sessionId: string): SDKMessage {
	return { type: "system", subtype: "init", session_id: sessionId } as SDKMessage;
}

function success(result: string, sessionId = "sdk-session"): SDKResultMessage {
	return {
		type: "result",
		subtype: "success",
		result,
		session_id: sessionId,
		total_cost_usd: 0.0637,
		usage: {
			input_tokens: 2,
			output_tokens: 11,
			cache_read_input_tokens: 100,
			cache_creation_input_tokens: 3126,
		},
		modelUsage: {
			"claude-haiku-4-5": { inputTokens: 525, outputTokens: 11, costUSD: 0.00058 },
			"claude-fable-5": { inputTokens: 2, outputTokens: 11, costUSD: 0.0631 },
		},
	} as unknown as SDKResultMessage;
}

function promptTooLong(sessionId = "sdk-session"): SDKResultMessage {
	return {
		type: "result",
		subtype: "error_during_execution",
		session_id: sessionId,
		terminal_reason: "prompt_too_long",
		errors: ["Request stopped"],
		total_cost_usd: 0.1,
		usage: {
			input_tokens: 2,
			output_tokens: 20,
			cache_read_input_tokens: 1_500_000,
			cache_creation_input_tokens: 0,
		},
		modelUsage: {},
	} as unknown as SDKResultMessage;
}

function mockQuery(messages: AsyncGenerator<SDKMessage>, close = vi.fn()): Query {
	return Object.assign(messages, {
		close,
		interrupt: vi.fn(async () => undefined),
	}) as unknown as Query;
}

async function nextInput(input: AsyncIterable<SDKUserMessage>): Promise<SDKUserMessage> {
	const next = await input[Symbol.asyncIterator]().next();
	if (next.done) throw new Error("SDK input closed unexpectedly");
	return next.value;
}

function contentText(input: SDKUserMessage): string {
	return typeof input.message.content === "string" ? input.message.content : JSON.stringify(input.message.content);
}

async function collect(
	context: Context,
	options: Omit<Parameters<typeof streamClaudeAgentSdk>[2], "tools" | "agentContext"> & {
		tools?: readonly AgentTool[];
	},
): Promise<{ result: AssistantMessage; events: AssistantMessageEvent[] }> {
	const tools = [...(options.tools ?? [])];
	const stream = streamClaudeAgentSdk(fableModel(), context, {
		...options,
		tools,
		agentContext: { systemPrompt: options.systemPrompt, messages: [], tools },
	});
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { result: await stream.result(), events };
}

function user(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

describe("Claude Agent SDK stream", () => {
	beforeEach(() => {
		sdk.createServer.mockReset();
		sdk.query.mockReset();
		sdk.createServer.mockImplementation((options: MockServer) => options);
	});

	afterEach(() => {
		for (const sessionId of testSessions) cleanupSessionResources(sessionId);
	});

	it("separates assistant turns and exposes internally executed Pi tools", async () => {
		const schema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof schema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo text",
			parameters: schema,
			async execute(_toolCallId, params, _signal, onUpdate) {
				onUpdate?.({
					content: [{ type: "text", text: "working" }],
					details: { value: params.value },
				});
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};
		const context: Context = {
			messages: [user("echo")],
			tools: [{ name: tool.name, description: tool.description, parameters: schema }],
		};

		let mcpResult: unknown;
		sdk.query.mockImplementation(({ prompt, options }: QueryInput) =>
			mockQuery(
				(async function* () {
					await nextInput(prompt);
					yield assistant([
						{ type: "thinking", thinking: "Considering the request.", signature: "sig-1" },
						{ type: "text", text: "First assistant turn." },
					]);
					yield assistant(
						[{ type: "text", text: "Subagent progress that must remain visible." }],
						"subagent-task-1",
						{
							usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 900_000 },
						},
					);
					mcpResult = await options.mcpServers.pi.tools[0].handler({ value: "hello" }, {});
					yield assistant([{ type: "text", text: "Second assistant turn." }], null, {
						usage: {
							input_tokens: 2,
							output_tokens: 11,
							cache_read_input_tokens: 100,
							cache_creation_input_tokens: 126,
						},
					});
					yield success("Second assistant turn.");
				})(),
			),
		);

		const { result, events } = await collect(context, {
			cwd: process.cwd(),
			systemPrompt: "system",
			tools: [tool],
		});

		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "Considering the request.", thinkingSignature: "sig-1" },
			{ type: "text", text: "First assistant turn." },
			{ type: "text", text: "Second assistant turn." },
		]);
		expect(events.filter((event) => event.type === "assistant_message_commit")).toEqual([
			expect.objectContaining({
				alreadyStreamed: false,
				message: expect.objectContaining({
					content: [{ type: "text", text: "Subagent progress that must remain visible." }],
				}),
			}),
		]);
		expect(events.flatMap((event) => (event.type === "text_start" ? [event.contentIndex] : []))).toEqual([1, 2]);
		expect(events.flatMap((event) => (event.type === "thinking_start" ? [event.contentIndex] : []))).toEqual([0]);
		expect(result.usage).toMatchObject({
			input: 2,
			output: 11,
			cacheRead: 100,
			cacheWrite: 3126,
			totalTokens: 3239,
			contextTokens: 239,
		});
		expect(result.usage.cost.total).toBeCloseTo(0.0637);
		expect(sdk.query.mock.calls[0][0].options.env).toMatchObject({
			DISABLE_AUTO_COMPACT: "1",
			DISABLE_COMPACT: "1",
		});
		expect(sdk.query.mock.calls[0][0].options.forwardSubagentText).toBe(true);
		expect(events.filter((event) => event.type.startsWith("tool_execution_")).map((event) => event.type)).toEqual([
			"tool_execution_start",
			"tool_execution_update",
			"tool_execution_end",
		]);
		const start = events.find((event) => event.type === "tool_execution_start");
		const end = events.find((event) => event.type === "tool_execution_end");
		expect(start).toMatchObject({ toolName: "echo", args: { value: "hello" } });
		expect(end).toMatchObject({
			toolName: "echo",
			result: { content: [{ type: "text", text: "echoed: hello" }], details: { value: "hello" } },
			isError: false,
		});
		expect(mcpResult).toEqual({
			isError: false,
			content: [{ type: "text", text: "echoed: hello" }],
		});
	});

	it("publishes deduplicated inner-request usage before the outer turn completes", async () => {
		let continueAfterFirst!: () => void;
		let continueAfterSecond!: () => void;
		const afterFirst = new Promise<void>((resolve) => {
			continueAfterFirst = resolve;
		});
		const afterSecond = new Promise<void>((resolve) => {
			continueAfterSecond = resolve;
		});
		sdk.query.mockImplementation(({ prompt }: QueryInput) =>
			mockQuery(
				(async function* () {
					await nextInput(prompt);
					const first = {
						id: "request-one",
						uuid: "request-one-frame",
						usage: {
							input_tokens: 10,
							output_tokens: 2,
							cache_read_input_tokens: 100,
							cache_creation_input_tokens: 20,
						},
					};
					yield assistant([], null, first);
					yield assistant([], null, { ...first, uuid: "request-one-snapshot" });
					await afterFirst;
					yield assistant([], null, {
						id: "request-two",
						uuid: "request-two-frame",
						usage: {
							input_tokens: 11,
							output_tokens: 3,
							cache_read_input_tokens: 200,
							cache_creation_input_tokens: 30,
							iterations: [
								{
									input_tokens: 5,
									output_tokens: 3,
									cache_read_input_tokens: 40,
									cache_creation_input_tokens: 2,
								},
							],
						},
					});
					await afterSecond;
					yield success("done");
				})(),
			),
		);

		const context: Context = { messages: [user("measure")], tools: [] };
		const stream = streamClaudeAgentSdk(fableModel(), context, {
			cwd: process.cwd(),
			systemPrompt: "system",
			tools: [],
			agentContext: { systemPrompt: "system", messages: [], tools: [] },
		});
		const iterator = stream[Symbol.asyncIterator]();
		const nextUsageAbove = async (minimum: number) => {
			while (true) {
				const next = await iterator.next();
				if (next.done) throw new Error("SDK stream ended before publishing provisional usage");
				const event = next.value;
				if (event.type === "text_delta" && event.delta === "" && event.partial.usage.totalTokens > minimum) {
					return {
						...event.partial.usage,
						cost: { ...event.partial.usage.cost },
					};
				}
			}
		};

		const firstUsage = await nextUsageAbove(0);
		expect(firstUsage).toMatchObject({ totalTokens: 132, contextTokens: 132 });
		continueAfterFirst();
		const secondUsage = await nextUsageAbove(132);
		expect(secondUsage).toMatchObject({ totalTokens: 376, contextTokens: 50 });
		continueAfterSecond();
		while (!(await iterator.next()).done) {
			// Drain the final response.
		}

		const result = await stream.result();
		expect(result.usage).toMatchObject({ totalTokens: 3239, contextTokens: 50 });
	});

	it("hands prompt overflow to Pi and clears the overfull transcript before replay", async () => {
		const calls: QueryInput[] = [];
		const prompts: string[] = [];
		const close = vi.fn();
		sdk.query.mockImplementation((input: QueryInput) => {
			calls.push(input);
			return mockQuery(
				(async function* () {
					yield init("overfull-sdk-session");
					let overfull = true;
					while (true) {
						const prompt = contentText(await nextInput(input.prompt));
						prompts.push(prompt);
						if (overfull) {
							overfull = false;
							yield promptTooLong("overfull-sdk-session");
						} else if (prompt === "/clear") {
							yield {
								type: "conversation_reset",
								new_conversation_id: "00000000-0000-0000-0000-000000000001",
								uuid: "00000000-0000-0000-0000-000000000002",
								session_id: "overfull-sdk-session",
							} as SDKMessage;
							yield init("fresh-sdk-session");
							yield success("", "fresh-sdk-session");
						} else {
							yield assistant([{ type: "text", text: "recovered" }], null, {
								id: "recovered-request",
								usage: { input_tokens: 10, output_tokens: 2 },
							});
							yield success("recovered", "fresh-sdk-session");
						}
					}
				})(),
				close,
			);
		});

		const first = await collect(
			{ messages: [user("overfull history")], tools: [] },
			{ cwd: process.cwd(), systemPrompt: "system", sessionId: "claude-sdk-overflow" },
		);
		expect(first.result).toMatchObject({
			stopReason: "error",
			errorMessage: "Claude Agent SDK prompt is too long",
		});
		expect(isContextOverflow(first.result, fableModel().contextWindow)).toBe(true);
		expect(close).not.toHaveBeenCalled();

		const second = await collect(
			{ messages: [user("Pi compaction summary")], tools: [] },
			{ cwd: process.cwd(), systemPrompt: "system", sessionId: "claude-sdk-overflow" },
		);
		expect(second.result.content).toEqual([{ type: "text", text: "recovered" }]);
		expect(calls).toHaveLength(1);
		expect(prompts).toEqual([
			"<user>\noverfull history\n</user>",
			"/clear",
			"<user>\nPi compaction summary\n</user>",
		]);
	});

	it("streams partial text and replaces superseded assistant frames", async () => {
		sdk.query.mockImplementation(({ prompt }: QueryInput) =>
			mockQuery(
				(async function* () {
					await nextInput(prompt);
					yield streamEvent({ type: "message_start", message: { id: "message-a" } });
					yield streamEvent({
						type: "content_block_start",
						index: 0,
						content_block: { type: "thinking", thinking: "", signature: "signature" },
					});
					yield streamEvent({ type: "content_block_stop", index: 0 });
					yield streamEvent({
						type: "content_block_start",
						index: 1,
						content_block: { type: "text", text: "" },
					});
					yield streamEvent({
						type: "content_block_delta",
						index: 1,
						delta: { type: "text_delta", text: "Provisional text." },
					});
					yield streamEvent({ type: "content_block_stop", index: 1 });

					yield assistant([{ type: "text", text: "Provisional text." }], null, {
						id: "message-a",
						uuid: "assistant-a",
					});
					yield streamEvent({ type: "message_stop" });
					yield assistant([{ type: "text", text: "Replacement text." }], null, {
						id: "message-b",
						uuid: "assistant-b",
						supersedes: ["assistant-a"],
					});
					yield success("Replacement text.");
				})(),
			),
		);

		const { result, events } = await collect(
			{ messages: [user("stream")], tools: [] },
			{ cwd: process.cwd(), systemPrompt: "system" },
		);

		expect(result.content).toEqual([{ type: "text", text: "Replacement text." }]);
		expect(events.filter((event) => event.type === "assistant_message_commit")).toEqual([
			expect.objectContaining({
				type: "assistant_message_commit",
				message: expect.objectContaining({ content: [{ type: "text", text: "Provisional text." }] }),
			}),
		]);
		expect(events.filter((event) => event.type === "text_start")).toHaveLength(2);
		expect(
			events
				.filter((event) => event.type === "text_delta")
				.map((event) => event.delta)
				.filter(Boolean),
		).toEqual(["Provisional text.", "Replacement text."]);
	});

	it("commits streamed assistant content before an SDK tool-use boundary", async () => {
		sdk.query.mockImplementation(({ prompt }: QueryInput) =>
			mockQuery(
				(async function* () {
					await nextInput(prompt);
					yield streamEvent({ type: "message_start", message: { id: "tool-request" } });
					yield streamEvent({
						type: "content_block_start",
						index: 0,
						content_block: { type: "thinking", thinking: "", signature: "before-signature" },
					});
					yield streamEvent({
						type: "content_block_delta",
						index: 0,
						delta: { type: "thinking_delta", thinking: "Choosing the lookup." },
					});
					yield streamEvent({ type: "content_block_stop", index: 0 });
					yield assistant(
						[{ type: "thinking", thinking: "Choosing the lookup.", signature: "before-signature" }],
						null,
						{
							id: "tool-request",
							uuid: "thinking-before-tool",
						},
					);
					yield streamEvent({
						type: "content_block_start",
						index: 1,
						content_block: { type: "text", text: "" },
					});
					yield streamEvent({
						type: "content_block_delta",
						index: 1,
						delta: { type: "text_delta", text: "I'll inspect the value." },
					});
					yield streamEvent({ type: "content_block_stop", index: 1 });
					yield assistant([{ type: "text", text: "I'll inspect the value." }], null, {
						id: "tool-request",
						uuid: "text-before-tool",
					});
					yield streamEvent({
						type: "content_block_start",
						index: 2,
						content_block: { type: "tool_use", id: "tool-1", name: "mcp__pi__read", input: {} },
					});
					yield assistant([{ type: "tool_use", id: "tool-1", name: "mcp__pi__read", input: {} }], null, {
						id: "tool-request",
						uuid: "tool-call",
					});
					yield streamEvent({ type: "message_stop" });

					yield streamEvent({ type: "message_start", message: { id: "final-request" } });
					yield streamEvent({
						type: "content_block_start",
						index: 0,
						content_block: { type: "thinking", thinking: "", signature: "after-signature" },
					});
					yield streamEvent({
						type: "content_block_delta",
						index: 0,
						delta: { type: "thinking_delta", thinking: "The value is ready." },
					});
					yield streamEvent({ type: "content_block_stop", index: 0 });
					yield assistant(
						[{ type: "thinking", thinking: "The value is ready.", signature: "after-signature" }],
						null,
						{
							id: "final-request",
							uuid: "thinking-after-tool",
						},
					);
					yield streamEvent({
						type: "content_block_start",
						index: 1,
						content_block: { type: "text", text: "" },
					});
					yield streamEvent({
						type: "content_block_delta",
						index: 1,
						delta: { type: "text_delta", text: "Final answer." },
					});
					yield streamEvent({ type: "content_block_stop", index: 1 });
					yield assistant([{ type: "text", text: "Final answer." }], null, {
						id: "final-request",
						uuid: "text-after-tool",
					});
					yield streamEvent({ type: "message_stop" });
					yield success("Final answer.");
				})(),
			),
		);

		const { result, events } = await collect(
			{ messages: [user("inspect")], tools: [] },
			{ cwd: process.cwd(), systemPrompt: "system" },
		);

		expect(events.filter((event) => event.type === "assistant_message_commit")).toEqual([
			expect.objectContaining({
				message: expect.objectContaining({
					content: [
						{ type: "thinking", thinking: "Choosing the lookup.", thinkingSignature: "before-signature" },
						{ type: "text", text: "I'll inspect the value." },
					],
				}),
			}),
		]);
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "The value is ready.", thinkingSignature: "after-signature" },
			{ type: "text", text: "Final answer." },
		]);
		expect(
			events
				.filter((event) => event.type === "thinking_delta" || event.type === "text_delta")
				.map((event) => event.delta)
				.filter(Boolean),
		).toEqual(["Choosing the lookup.", "I'll inspect the value.", "The value is ready.", "Final answer."]);
	});

	it("commits a completed SDK message when a later assistant message starts", async () => {
		sdk.query.mockImplementation(({ prompt }: QueryInput) =>
			mockQuery(
				(async function* () {
					await nextInput(prompt);
					yield streamEvent({ type: "message_start", message: { id: "intermediate-message" } });
					yield streamEvent({
						type: "content_block_start",
						index: 0,
						content_block: { type: "text", text: "" },
					});
					yield streamEvent({
						type: "content_block_delta",
						index: 0,
						delta: { type: "text_delta", text: "Intermediate message." },
					});
					yield streamEvent({ type: "content_block_stop", index: 0 });
					yield assistant([{ type: "text", text: "Intermediate message." }], null, {
						id: "intermediate-message",
						uuid: "intermediate-frame",
					});
					yield streamEvent({ type: "message_stop" });

					yield streamEvent({ type: "message_start", message: { id: "final-message" } });
					yield streamEvent({
						type: "content_block_start",
						index: 0,
						content_block: { type: "text", text: "" },
					});
					yield streamEvent({
						type: "content_block_delta",
						index: 0,
						delta: { type: "text_delta", text: "Final message." },
					});
					yield streamEvent({ type: "content_block_stop", index: 0 });
					yield assistant([{ type: "text", text: "Final message." }], null, {
						id: "final-message",
						uuid: "final-frame",
					});
					yield streamEvent({ type: "message_stop" });
					yield success("Final message.");
				})(),
			),
		);

		const { result, events } = await collect(
			{ messages: [user("continue")], tools: [] },
			{ cwd: process.cwd(), systemPrompt: "system" },
		);

		expect(events.filter((event) => event.type === "assistant_message_commit")).toEqual([
			expect.objectContaining({
				message: expect.objectContaining({ content: [{ type: "text", text: "Intermediate message." }] }),
			}),
		]);
		expect(result.content).toEqual([{ type: "text", text: "Final message." }]);
	});

	it("preserves TypeBox parameter shapes in the SDK MCP schema", async () => {
		const schema = Type.Object({
			urls: Type.Optional(Type.Array(Type.String())),
			workflow: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("auto-summary")])),
			options: Type.Object({ limit: Type.Integer({ minimum: 1 }) }),
		});
		const tool: AgentTool<typeof schema, Record<string, never>> = {
			name: "fetch",
			label: "Fetch",
			description: "Fetch URLs",
			parameters: schema,
			async execute() {
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		sdk.query.mockImplementation(({ prompt }: QueryInput) =>
			mockQuery(
				(async function* () {
					await nextInput(prompt);
					yield success("ok");
				})(),
			),
		);

		await collect(
			{
				messages: [user("fetch")],
				tools: [{ name: tool.name, description: tool.description, parameters: schema }],
			},
			{ cwd: process.cwd(), systemPrompt: "system", tools: [tool] },
		);

		const inputSchema = (sdk.createServer.mock.calls[0][0] as MockServer).tools[0].inputSchema;
		expect(inputSchema.urls.safeParse(["https://example.com"]).success).toBe(true);
		expect(inputSchema.urls.safeParse("https://example.com").success).toBe(false);
		expect(inputSchema.workflow.safeParse("auto-summary").success).toBe(true);
		expect(inputSchema.workflow.safeParse("invalid").success).toBe(false);
		expect(inputSchema.options.safeParse({ limit: 2 }).success).toBe(true);
		expect(inputSchema.options.safeParse({ limit: 0 }).success).toBe(false);
	});

	it("keeps one SDK process and sends only new Pi messages on later turns", async () => {
		const prompts: string[] = [];
		const close = vi.fn();
		sdk.query.mockImplementation(({ prompt }: QueryInput) =>
			mockQuery(
				(async function* () {
					yield init("persistent-sdk-session");
					while (true) {
						const input = await nextInput(prompt);
						const text = contentText(input);
						prompts.push(text);
						const reply = text.includes("second") ? "second reply" : "first reply";
						yield assistant([{ type: "text", text: reply }]);
						yield success(reply, "persistent-sdk-session");
					}
				})(),
				close,
			),
		);

		const firstContext: Context = { messages: [user("first")], tools: [] };
		const first = await collect(firstContext, {
			cwd: process.cwd(),
			systemPrompt: "system",
			sessionId: "claude-sdk-persistent",
		});
		const secondContext: Context = {
			messages: [...firstContext.messages, first.result, user("second")],
			tools: [],
		};
		const second = await collect(secondContext, {
			cwd: process.cwd(),
			systemPrompt: "system",
			sessionId: "claude-sdk-persistent",
		});

		expect(second.result.content).toEqual([{ type: "text", text: "second reply" }]);
		expect(sdk.query).toHaveBeenCalledTimes(1);
		expect(prompts).toEqual(["<user>\nfirst\n</user>", "<user>\nsecond\n</user>"]);
		cleanupSessionResources("claude-sdk-persistent");
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("restarts with resume when SDK configuration changes without Pi-context divergence", async () => {
		const calls: QueryInput[] = [];
		const prompts: string[] = [];
		sdk.query.mockImplementation((input: QueryInput) => {
			calls.push(input);
			return mockQuery(
				(async function* () {
					yield init("resume-sdk-session");
					const message = await nextInput(input.prompt);
					const text = contentText(message);
					prompts.push(text);
					yield assistant([{ type: "text", text: text.includes("second") ? "second reply" : "first reply" }]);
					yield success("reply", "resume-sdk-session");
				})(),
			);
		});

		const firstContext: Context = { messages: [user("first")], tools: [] };
		const first = await collect(firstContext, {
			cwd: process.cwd(),
			systemPrompt: "system one",
			sessionId: "claude-sdk-resume",
		});
		const secondContext: Context = {
			messages: [...firstContext.messages, first.result, user("second")],
			tools: [],
		};
		await collect(secondContext, {
			cwd: process.cwd(),
			systemPrompt: "system two",
			sessionId: "claude-sdk-resume",
		});

		expect(calls).toHaveLength(2);
		expect(calls[1].options.resume).toBe("resume-sdk-session");
		expect(prompts[1]).toBe("<user>\nsecond\n</user>");
	});

	it("falls back to a fresh process when the SDK does not confirm reset", async () => {
		const calls: QueryInput[] = [];
		const prompts: string[] = [];
		const close = vi.fn();
		sdk.query.mockImplementation((input: QueryInput) => {
			calls.push(input);
			const call = calls.length;
			return mockQuery(
				(async function* () {
					yield init(call === 1 ? "old-sdk-session" : "fresh-sdk-session");
					const prompt = contentText(await nextInput(input.prompt));
					prompts.push(prompt);
					yield assistant([{ type: "text", text: "reply" }]);
					yield success("reply", call === 1 ? "old-sdk-session" : "fresh-sdk-session");
				})(),
				close,
			);
		});

		await collect(
			{ messages: [user("original")], tools: [] },
			{ cwd: process.cwd(), systemPrompt: "system", sessionId: "claude-sdk-reset-fallback" },
		);
		await collect(
			{ messages: [user("rewritten")], tools: [] },
			{ cwd: process.cwd(), systemPrompt: "system", sessionId: "claude-sdk-reset-fallback" },
		);

		expect(calls).toHaveLength(2);
		expect(calls[1].options.resume).toBeUndefined();
		expect(prompts).toEqual(["<user>\noriginal\n</user>", "<user>\nrewritten\n</user>"]);
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("clears and reuses the SDK process after a history divergence", async () => {
		const calls: QueryInput[] = [];
		const prompts: string[] = [];
		sdk.query.mockImplementation((input: QueryInput) => {
			calls.push(input);
			return mockQuery(
				(async function* () {
					let currentSessionId = input.options.resume ?? "divergence-sdk-session";
					yield init(currentSessionId);
					while (true) {
						const prompt = contentText(await nextInput(input.prompt));
						prompts.push(prompt);
						if (prompt === "/clear") {
							yield {
								type: "conversation_reset",
								new_conversation_id: "00000000-0000-0000-0000-000000000003",
								uuid: "00000000-0000-0000-0000-000000000004",
								session_id: "divergence-sdk-session",
							} as SDKMessage;
							currentSessionId = "reset-sdk-session";
							yield init(currentSessionId);
							yield success("", currentSessionId);
						} else {
							yield assistant([{ type: "text", text: "reply" }]);
							yield success("reply", currentSessionId);
						}
					}
				})(),
			);
		});

		const firstContext: Context = { messages: [user("original")], tools: [] };
		await collect(firstContext, {
			cwd: process.cwd(),
			systemPrompt: "system",
			sessionId: "claude-sdk-divergence",
		});
		const rewrittenContext: Context = { messages: [user("rewritten")], tools: [] };
		const rewritten = await collect(rewrittenContext, {
			cwd: process.cwd(),
			systemPrompt: "system",
			sessionId: "claude-sdk-divergence",
		});
		await collect(
			{ messages: [...rewrittenContext.messages, rewritten.result, user("after reset")], tools: [] },
			{
				cwd: process.cwd(),
				systemPrompt: "changed system",
				sessionId: "claude-sdk-divergence",
			},
		);

		expect(calls).toHaveLength(2);
		expect(calls[1].options.resume).toBe("reset-sdk-session");
		expect(prompts).toEqual([
			"<user>\noriginal\n</user>",
			"/clear",
			"<user>\nrewritten\n</user>",
			"<user>\nafter reset\n</user>",
		]);
	});
});
