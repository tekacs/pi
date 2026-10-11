import type { Query, SDKMessage, SDKResultMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent, Context, Message } from "@earendil-works/pi-ai";
import { cleanupSessionResources, isContextOverflow, normalizeContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_AGENT_SDK_MODELS, CLAUDE_AGENT_SDK_SUBSCRIPTION_AUTH } from "../src/core/claude-agent-sdk-models.ts";
import { streamClaudeAgentSdk } from "../src/core/claude-agent-sdk-stream.ts";
import { type MockServer, type QueryInput, sdkQuery } from "./claude-sdk-fixture.ts";

const sdk = vi.hoisted(() => ({
	createServer: vi.fn(),
	query: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	createSdkMcpServer: sdk.createServer,
	query: sdk.query,
}));

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
		error?: string;
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
		error: metadata.error,
		message: {
			id: metadata.id ?? "native-response",
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

/** A result whose spend, like the SDK's, is the process's running total per model. */
function spent(totals: Record<string, number>): SDKResultMessage {
	const modelUsage = Object.fromEntries(Object.entries(totals).map(([id, costUSD]) => [id, { costUSD }]));
	const total = Object.values(totals).reduce((sum, cost) => sum + cost, 0);
	return { ...success("reply"), total_cost_usd: total, modelUsage } as SDKResultMessage;
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
	return sdkQuery(messages, (sdk.query.mock.calls.at(-1)![0] as QueryInput).options, close);
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
		systemPrompt?: string;
	},
): Promise<{ result: AssistantMessage; events: AssistantMessageEvent[]; committed: Message[] }> {
	const { systemPrompt, ...streamOptions } = options;
	const tools = [...(options.tools ?? [])];
	const agentContext = { messages: [...context.messages], tools };
	const stream = streamClaudeAgentSdk(fableModel(), normalizeContext({ systemPrompt, ...context }), {
		...streamOptions,
		tools,
		agentContext,
	});
	const events: AssistantMessageEvent[] = [];
	const committed: Message[] = [];
	for await (const event of stream) {
		events.push(event);
		if (event.type === "assistant_message_commit") {
			committed.push(event.message);
			agentContext.messages.push(event.message);
			event.acknowledge?.();
		}
	}
	return { result: await stream.result(), events, committed };
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

	it("waits for native frames when MCP dispatch overtakes the iterator", async () => {
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "result" }], details: {} }));
		const tool: AgentTool = {
			name: "probe",
			label: "Probe",
			description: "Probe",
			parameters: Type.Object({}),
			execute,
		};
		sdk.query.mockImplementation(({ prompt, options }: QueryInput) =>
			mockQuery(
				(async function* () {
					await nextInput(prompt);
					const pending = options.mcpServers.pi.tools[0].handler(
						{},
						{ _meta: { "claudecode/toolUseId": "early" } },
					);
					expect(execute).not.toHaveBeenCalled();
					yield assistant([{ type: "text", text: "Before the call." }]);
					yield assistant([{ type: "tool_use", id: "early", name: "mcp__pi__probe", input: {} }]);
					await pending;
					yield success("done");
				})(),
			),
		);
		const { result, committed } = await collect(
			{ messages: [user("run")], tools: [tool] },
			{ cwd: process.cwd(), tools: [tool] },
		);
		expect(result.stopReason).toBe("stop");
		expect(execute).toHaveBeenCalledTimes(1);
		expect(committed).toMatchObject([
			{ role: "assistant", responseId: "native-response", content: [{ type: "text", text: "Before the call." }] },
			{ role: "assistant", responseId: "native-response", content: [{ type: "toolCall", id: "early" }] },
			{ role: "toolResult", toolCallId: "early" },
		]);
	});

	it.each(["missing", "conflicting"] as const)("refuses %s API identity for a native call", async (mode) => {
		sdk.query.mockImplementation(({ prompt }: QueryInput) =>
			mockQuery(
				(async function* () {
					await nextInput(prompt);
					const content = [{ type: "tool_use", id: "same-call", name: "mcp__pi__probe", input: {} }];
					yield assistant(content, null, { id: mode === "missing" ? "" : "response-one" });
					if (mode === "conflicting") yield assistant(content, null, { id: "response-two" });
					yield success("unreachable");
				})(),
			),
		);
		const { result } = await collect({ messages: [user("run")] }, { cwd: process.cwd() });
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(
			mode === "missing" ? "no API response identity" : "Conflicting native call identity",
		);
	});

	it("refuses a missing native call ID before executing a tool", async () => {
		const execute = vi.fn(async () => ({ content: [], details: {} }));
		const tool: AgentTool = {
			name: "probe",
			label: "Probe",
			description: "Probe",
			parameters: Type.Object({}),
			execute,
		};
		const close = vi.fn();
		sdk.query.mockImplementation(({ prompt, options }: QueryInput) =>
			mockQuery(
				(async function* () {
					await nextInput(prompt);
					await options.mcpServers.pi.tools[0].handler({}, {});
					yield success("unreachable");
				})(),
				close,
			),
		);
		const { result } = await collect(
			{ messages: [user("run")], tools: [tool] },
			{ cwd: process.cwd(), tools: [tool] },
		);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("no native call ID");
		expect(execute).not.toHaveBeenCalled();
		expect(close).toHaveBeenCalled();
	});

	it("maps Pi's long cache retention to Claude Code's one-hour TTL", async () => {
		let sdkEnv: Record<string, string | undefined> | undefined;
		sdk.query.mockImplementation(({ prompt, options }: QueryInput) => {
			sdkEnv = options.env;
			return mockQuery(
				(async function* () {
					await nextInput(prompt);
					yield success("ok");
				})(),
			);
		});

		await collect(
			{ messages: [user("cache")], tools: [] },
			{
				cwd: process.cwd(),
				systemPrompt: "system",
				apiKey: CLAUDE_AGENT_SDK_SUBSCRIPTION_AUTH,
				env: { PI_CACHE_RETENTION: "long" },
			},
		);

		expect(sdkEnv).toMatchObject({
			PI_CACHE_RETENTION: "long",
			CLAUDE_CODE_PROMPT_CACHE_TTL: "1h",
		});
		expect(sdkEnv?.ANTHROPIC_API_KEY).toBeUndefined();
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
					yield assistant([
						{ type: "tool_use", id: "native-echo", name: "mcp__pi__echo", input: { value: "hello" } },
					]);
					mcpResult = await options.mcpServers.pi.tools[0].handler(
						{ value: "hello" },
						{ _meta: { "claudecode/toolUseId": "native-echo" } },
					);
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

		// Unsupported native children lose exact fidelity; they never fail the completed turn.
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "Second assistant turn." }]);
		expect(events.filter((event) => event.type === "assistant_message_commit")).toMatchObject([
			{
				alreadyStreamed: false,
				message: { content: [{ type: "text", text: "Subagent progress that must remain visible." }] },
			},
			{
				message: {
					content: [
						{ type: "thinking", thinking: "Considering the request.", thinkingSignature: "sig-1" },
						{ type: "text", text: "First assistant turn." },
					],
				},
			},
			{
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "native-echo", name: "echo", arguments: { value: "hello" } }],
				},
			},
			{
				message: {
					role: "toolResult",
					toolCallId: "native-echo",
					content: [{ type: "text", text: "echoed: hello" }],
				},
			},
		]);
		expect(events.flatMap((event) => (event.type === "text_start" ? [event.contentIndex] : []))).toEqual([1, 0]);
		expect(events.flatMap((event) => (event.type === "thinking_start" ? [event.contentIndex] : []))).toEqual([0]);
		expect(result.usage).toMatchObject({
			input: 2,
			output: 11,
			cacheRead: 100,
			cacheWrite: 3126,
			totalTokens: 3239,
			contextTokens: 239,
			// The main loop's first request, not the summed loop and not the subagent.
			entryPrompt: { input: 2, cacheRead: 100, cacheWrite: 126 },
		});
		expect(result.usage.cost.total).toBeCloseTo(0.0637);
		const { input, output, cacheRead, cacheWrite } = result.usage.cost;
		expect(input + output + cacheRead + cacheWrite).toBeCloseTo(0.0637);
		expect(sdk.query.mock.calls[0][0].options.env).toMatchObject({
			DISABLE_AUTO_COMPACT: "1",
			DISABLE_COMPACT: "1",
			MAX_MCP_OUTPUT_TOKENS: "9007199254740991",
		});
		expect(sdk.query.mock.calls[0][0].options.forwardSubagentText).toBe(true);
		expect(events.filter((event) => event.type.startsWith("tool_execution_")).map((event) => event.type)).toEqual([
			"tool_execution_start",
			"tool_execution_update",
			"tool_execution_end",
		]);
		const start = events.find((event) => event.type === "tool_execution_start");
		const end = events.find((event) => event.type === "tool_execution_end");
		expect(start).toMatchObject({ toolCallId: "native-echo", toolName: "echo", args: { value: "hello" } });
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

		const context = normalizeContext({ systemPrompt: "system", messages: [user("measure")], tools: [] });
		const stream = streamClaudeAgentSdk(fableModel(), context, {
			cwd: process.cwd(),
			tools: [],
			agentContext: { messages: [], tools: [] },
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
		expect(result.usage).toMatchObject({
			totalTokens: 3239,
			contextTokens: 50,
			entryPrompt: { input: 10, cacheRead: 100, cacheWrite: 20 },
		});
	});

	it("hands prompt overflow to Pi and starts fresh from a user-only compaction summary", async () => {
		const calls: QueryInput[] = [];
		const prompts: string[] = [];
		const close = vi.fn();
		sdk.query.mockImplementation((input: QueryInput) => {
			calls.push(input);
			return mockQuery(
				(async function* () {
					yield init("overfull-sdk-session");
					let overfull = calls.length === 1;
					while (true) {
						const prompt = contentText(await nextInput(input.prompt));
						prompts.push(prompt);
						if (overfull) {
							overfull = false;
							yield promptTooLong("overfull-sdk-session");
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
		expect(close).toHaveBeenCalledTimes(1);

		const second = await collect(
			{ messages: [user("Pi compaction summary")], tools: [] },
			{ cwd: process.cwd(), systemPrompt: "system", sessionId: "claude-sdk-overflow" },
		);
		expect(second.result.content).toEqual([{ type: "text", text: "recovered" }]);
		expect(calls).toHaveLength(2);
		expect(prompts).toEqual(["overfull history", "Pi compaction summary"]);
	});

	it.each([true, false])(
		"reloads credentials in a fresh native process after an authentication failure (recovers=%s)",
		async (recovers) => {
			const closes: ReturnType<typeof vi.fn>[] = [];
			sdk.query.mockImplementation(({ prompt }: QueryInput) => {
				const attempt = sdk.query.mock.calls.length;
				const close = vi.fn();
				closes.push(close);
				return mockQuery(
					(async function* () {
						await nextInput(prompt);
						if (attempt === 1 || !recovers) {
							yield assistant([{ type: "text", text: "OAuth token has expired." }], null, {
								id: `auth-${attempt}`,
								error: "authentication_failed",
							});
							yield success("OAuth token has expired.");
						} else {
							yield assistant([{ type: "text", text: "authenticated reply" }], null, { id: "after-reload" });
							yield success("authenticated reply");
						}
					})(),
					close,
				);
			});
			const { result } = await collect(
				{ messages: [user("hello")], tools: [] },
				{ cwd: process.cwd(), sessionId: `claude-sdk-auth-${recovers}` },
			);
			expect(sdk.query).toHaveBeenCalledTimes(2);
			expect(closes[0]).toHaveBeenCalled();
			if (recovers)
				expect(result).toMatchObject({
					stopReason: "stop",
					content: [{ type: "text", text: "authenticated reply" }],
				});
			else {
				expect(result.stopReason).toBe("error");
				expect(result.errorMessage).toContain("Sign in again in Claude Code");
			}
			cleanupSessionResources(`claude-sdk-auth-${recovers}`);
		},
	);

	it("reports a synthetic native overflow reply as a context-overflow error, not assistant text", async () => {
		sdk.query.mockImplementation(({ prompt }: QueryInput) =>
			mockQuery(
				(async function* () {
					await nextInput(prompt);
					yield assistant([{ type: "text", text: "Prompt is too long" }], null, {
						id: "synthetic-error",
						error: "invalid_request",
					});
					yield success("Prompt is too long");
				})(),
			),
		);
		const { result, events } = await collect({ messages: [user("large")], tools: [] }, { cwd: process.cwd() });
		expect(result).toMatchObject({ stopReason: "error", errorMessage: "Prompt is too long", content: [] });
		expect(isContextOverflow(result, fableModel().contextWindow)).toBe(true);
		expect(events.some((event) => event.type === "text_delta" && event.delta.includes("Prompt is too long"))).toBe(
			false,
		);
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
		// This renderer fixture leaves its native call unexecuted: exact continuation is skipped, not the turn.
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
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
				message: expect.objectContaining({
					responseId: "intermediate-message",
					content: [{ type: "text", text: "Intermediate message." }],
				}),
			}),
		]);
		expect(result.content).toEqual([{ type: "text", text: "Final message." }]);
		expect(result.responseId).toBe("final-message");
	});

	it("leaves an explicit tool-result ceiling to the operator", async () => {
		const previous = process.env.MAX_MCP_OUTPUT_TOKENS;
		process.env.MAX_MCP_OUTPUT_TOKENS = "9000";
		sdk.query.mockImplementation(({ prompt }: QueryInput) =>
			mockQuery(
				(async function* () {
					await nextInput(prompt);
					yield success("ok");
				})(),
			),
		);

		try {
			await collect({ messages: [user("hello")] }, { cwd: process.cwd(), systemPrompt: "system" });
		} finally {
			if (previous === undefined) delete process.env.MAX_MCP_OUTPUT_TOKENS;
			else process.env.MAX_MCP_OUTPUT_TOKENS = previous;
		}

		expect(sdk.query.mock.calls[0][0].options.env.MAX_MCP_OUTPUT_TOKENS).toBe("9000");
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
		expect(prompts).toEqual(["first", "second"]);
		cleanupSessionResources("claude-sdk-persistent");
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("charges each turn its own spend, not the SDK process's running total", async () => {
		const processes = [
			[
				{ "claude-opus-5-5": 1, "claude-haiku-4-5": 0.01 },
				{ "claude-opus-5-5": 1.5, "claude-haiku-4-5": 0.01 },
				{ "claude-opus-5-5": 2.25, "claude-haiku-4-5": 0.04 },
			],
			// A replacement process counts from zero again.
			[{ "claude-opus-5-5": 0.4 }],
		];
		let started = 0;
		sdk.query.mockImplementation(({ prompt }: QueryInput) => {
			const turns = processes[started++];
			return mockQuery(
				(async function* () {
					for (const totals of turns) {
						await nextInput(prompt);
						yield assistant([{ type: "text", text: "reply" }]);
						yield spent(totals);
					}
				})(),
			);
		});
		const options = { cwd: process.cwd(), sessionId: "claude-sdk-persistent" };
		const costs: number[] = [];
		const messages: Message[] = [];
		for (const text of ["first", "second", "third"]) {
			messages.push(user(text));
			const { result } = await collect({ messages: [...messages] }, options);
			messages.push(result);
			costs.push(result.usage.cost.total);
		}
		cleanupSessionResources("claude-sdk-persistent");
		const { result: fresh } = await collect({ messages: [user("fresh")] }, options);
		costs.push(fresh.usage.cost.total);

		expect(sdk.query).toHaveBeenCalledTimes(2);
		expect(costs.map((cost) => Number(cost.toFixed(6)))).toEqual([1.01, 0.5, 0.78, 0.4]);
		const { input, output, cacheRead, cacheWrite } = fresh.usage.cost;
		expect(input + output + cacheRead + cacheWrite).toBeCloseTo(0.4);
	});

	it.each(["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"])(
		"replaces the SDK child when %s changes without replaying prior user turns",
		async (field) => {
			const prompts: string[] = [];
			const close = vi.fn();
			sdk.query.mockImplementation(({ prompt }: QueryInput) =>
				mockQuery(
					(async function* () {
						while (true) {
							prompts.push(contentText(await nextInput(prompt)));
							yield assistant([{ type: "text", text: "reply" }]);
							yield success("reply");
						}
					})(),
					close,
				),
			);
			const options = {
				cwd: process.cwd(),
				sessionId: "claude-sdk-persistent",
				apiKey: CLAUDE_AGENT_SDK_SUBSCRIPTION_AUTH,
			};
			const context: Context = { messages: [user("first")] };
			const first = await collect(context, { ...options, env: { [field]: "account-a" } });
			const second = await collect(
				{ messages: [...context.messages, first.result, user("second")] },
				{
					...options,
					env: { [field]: "account-b", ANTHROPIC_AUTH_TOKEN: "wrong-account", CLAUDE_CODE_USE_BEDROCK: "1" },
				},
			);
			expect(first.result.stopReason).toBe("stop");
			expect(second.result.stopReason).toBe("stop");
			expect(sdk.query).toHaveBeenCalledTimes(2);
			expect(close).toHaveBeenCalledTimes(1);
			expect(prompts).toEqual(["first", "second"]);
			const { env, resume } = sdk.query.mock.calls[1][0].options;
			expect(resume).toEqual(expect.any(String));
			expect(env[field]).toBe("account-b");
			if (field === "CLAUDE_CODE_OAUTH_TOKEN") {
				expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
				expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
			}
		},
	);

	it("releases memory-only checkpoints on session cleanup, not on native process replacement", async () => {
		sdk.query.mockImplementation(({ prompt }: QueryInput) =>
			mockQuery(
				(async function* () {
					while (true) {
						await nextInput(prompt);
						yield assistant([{ type: "text", text: "reply" }]);
						yield success("reply");
					}
				})(),
			),
		);
		const context: Context = { messages: [user("start")] };
		const options = { cwd: process.cwd(), sessionId: "claude-sdk-persistent" };
		const first = await collect(context, { ...options, systemPrompt: "one" });
		expect(first.result.stopReason).toBe("stop");
		const continued: Context = { messages: [...context.messages, first.result, user("next")] };
		const second = await collect(continued, { ...options, systemPrompt: "two" });
		expect(second.result.stopReason).toBe("stop");
		expect(sdk.query).toHaveBeenCalledTimes(2);
		cleanupSessionResources(options.sessionId);
		const released = await collect(
			{ messages: [...continued.messages, second.result, user("after cleanup")] },
			options,
		);
		// Released native state reduces fidelity; canonical history still continues the conversation.
		expect(released.result.stopReason).toBe("stop");
		expect(sdk.query).toHaveBeenCalledTimes(3);
		expect(sdk.query.mock.calls[2][0].options.resumeSessionAt).toEqual(expect.any(String));
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
					const reply = text.includes("second") ? "second reply" : "first reply";
					yield assistant([{ type: "text", text: reply }]);
					yield success(reply, "resume-sdk-session");
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
		expect(calls[1].options.resume).toEqual(expect.any(String));
		expect(calls[1].options.resume).not.toBe("resume-sdk-session");
		expect(prompts[1]).toBe("second");
	});

	it("replays transcript sections and tool changes while resuming conversational history", async () => {
		const calls: QueryInput[] = [];
		const prompts: string[] = [];
		const executed: string[] = [];
		const tools: AgentTool[] = ["old", "new"].map((name) => ({
			name,
			label: name,
			description: name,
			parameters: Type.Object({}),
			async execute() {
				executed.push(name);
				return { content: [{ type: "text", text: name }], details: {} };
			},
		}));
		sdk.query.mockImplementation((input: QueryInput) => {
			calls.push(input);
			return mockQuery(
				(async function* () {
					yield init("resume-sdk-session");
					prompts.push(contentText(await nextInput(input.prompt)));
					yield assistant([
						{
							type: "tool_use",
							id: `call-${calls.length}`,
							name: `mcp__pi__${input.options.mcpServers.pi.tools[0].name}`,
							input: {},
						},
					]);
					await input.options.mcpServers.pi.tools[0].handler(
						{},
						{ _meta: { "claudecode/toolUseId": `call-${calls.length}` } },
					);
					yield success("reply", "resume-sdk-session");
				})(),
			);
		});
		const context: Context = {
			messages: [
				{ role: "system", content: "base", sections: { rules: "before" }, toolsAdded: [tools[0]], timestamp: 1 },
				user("first"),
			],
		};
		const options = { cwd: process.cwd(), sessionId: "claude-sdk-resume", tools };
		const first = await collect(context, options);
		await collect(
			{
				messages: [
					...context.messages,
					...first.committed,
					first.result,
					{
						role: "system",
						content: "",
						sections: { rules: "after" },
						toolsRemoved: [{ name: "old" }],
						toolsAdded: [tools[1]],
						timestamp: 2,
					},
					user("second"),
				],
			},
			options,
		);
		expect(calls).toHaveLength(2);
		expect(calls[0].options.systemPrompt).toMatchObject({ prompt: "base\n\nbefore", snapshot: false });
		expect(calls[1].options.systemPrompt).toMatchObject({ prompt: "base\n\nafter", snapshot: false });
		expect(calls[1].options.resume).toEqual(expect.any(String));
		expect(calls[1].options.mcpServers.pi.tools.map((tool) => tool.name)).toEqual(["new"]);
		expect(executed).toEqual(["old", "new"]);
		expect(prompts).toEqual(["first", "second"]);
	});

	it("reconstructs modified assistant history as assistant records, never as user text", async () => {
		sdk.query.mockImplementation(({ prompt }: QueryInput) =>
			mockQuery(
				(async function* () {
					await nextInput(prompt);
					yield assistant([{ type: "text", text: "original" }]);
					yield success("original");
				})(),
			),
		);
		const context: Context = { messages: [user("start")] };
		const first = await collect(context, { cwd: process.cwd() });
		expect(first.result.stopReason).toBe("stop");
		const second = await collect(
			{
				messages: [
					...context.messages,
					{ ...first.result, content: [{ type: "text", text: "altered" }] },
					user("continue"),
				],
			},
			{ cwd: process.cwd() },
		);
		expect(second.result.stopReason).toBe("stop");
		expect(sdk.query).toHaveBeenCalledTimes(2);
		const { resume, resumeSessionAt, sessionStore } = sdk.query.mock.calls[1][0].options;
		const staged = await sessionStore.load({ projectKey: "fixture", sessionId: resume });
		const altered = staged.find((entry: { uuid?: string }) => entry.uuid === resumeSessionAt);
		expect(altered).toMatchObject({ type: "assistant", message: { content: [{ type: "text", text: "altered" }] } });
		// Only the staged prefix is history; the mock appends its own new reply after it.
		expect(JSON.stringify(staged.slice(0, staged.indexOf(altered) + 1))).not.toContain("original");
	});

	it("uses a fresh process for a rewritten user-only conversation without sending clear", async () => {
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
		expect(prompts).toEqual(["original", "rewritten"]);
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("resumes the replacement conversation after a subsequent configuration change", async () => {
		const calls: QueryInput[] = [];
		const prompts: string[] = [];
		sdk.query.mockImplementation((input: QueryInput) => {
			calls.push(input);
			return mockQuery(
				(async function* () {
					const currentSessionId = input.options.resume ?? "divergence-sdk-session";
					yield init(currentSessionId);
					while (true) {
						const prompt = contentText(await nextInput(input.prompt));
						prompts.push(prompt);
						yield assistant([{ type: "text", text: "reply" }]);
						yield success("reply", currentSessionId);
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

		expect(calls).toHaveLength(3);
		expect(calls[1].options.resume).toBeUndefined();
		expect(calls[2].options.resume).toEqual(expect.any(String));
		expect(prompts).toEqual(["original", "rewritten", "after reset"]);
	});
});
