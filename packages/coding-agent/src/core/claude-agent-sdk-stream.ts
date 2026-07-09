import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	createSdkMcpServer,
	type EffortLevel,
	type Query,
	query,
	type SDKMessage,
	type SDKResultMessage,
	type SDKUserMessage,
	type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import type { Agent, AgentContext, AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	Tool,
	Usage,
} from "@earendil-works/pi-ai";
import {
	calculateCost,
	createAssistantMessageEventStream,
	registerSessionResourceCleanup,
} from "@earendil-works/pi-ai";
import { z } from "zod/v4";
import { getPackageDir } from "../config.ts";
import { CLAUDE_AGENT_SDK_API, CLAUDE_AGENT_SDK_SUBSCRIPTION_AUTH } from "./claude-agent-sdk-models.ts";

type ToolLookup = ReadonlyMap<string, AgentTool>;

type SdkToolEvents = {
	start: (toolCallId: string, toolName: string, args: unknown) => void;
	update: (toolCallId: string, toolName: string, args: unknown, partialResult: AgentToolResult<unknown>) => void;
	end: (toolCallId: string, toolName: string, result: AgentToolResult<unknown>, isError: boolean) => void;
};

export interface ClaudeAgentSdkStreamOptions extends SimpleStreamOptions {
	cwd: string;
	systemPrompt: string;
	tools: readonly AgentTool[];
	agentContext: AgentContext;
	beforeToolCall?: Agent["beforeToolCall"];
	afterToolCall?: Agent["afterToolCall"];
}

type SdkTurn = {
	options: ClaudeAgentSdkStreamOptions;
	toolLookup: ToolLookup;
	events: SdkToolEvents;
};

type SdkSession = {
	input: SdkInput;
	query: Query;
	turn: { current?: SdkTurn };
	config: string;
	expectedHistory?: { count: number; hash: string };
	sdkSessionId?: string;
	needsReset?: boolean;
};

type SdkInvocation = {
	session: SdkSession;
	persistent: boolean;
	resumed: boolean;
	history: Context["messages"];
};

type SdkOutputBlock = {
	content: AssistantMessage["content"][number];
	kind: "text" | "thinking";
};

type SdkPartialOutput = {
	blocks: Map<number, SdkOutputBlock>;
	finalized: Set<SdkOutputBlock>;
};

type SdkOutputState = {
	active?: SdkPartialOutput;
	activeMessageId?: string;
	currentMessageId?: string;
	partial: Map<string, SdkPartialOutput>;
	assistants: Map<string, SdkOutputBlock[]>;
	requests: Map<string, Usage>;
	committed: AssistantMessage[];
	contextTokens?: number;
	hasText: boolean;
};

let liveSdkSession: { sessionId: string; session: SdkSession } | undefined;

registerSessionResourceCleanup((sessionId) => {
	if (sessionId !== undefined && liveSdkSession?.sessionId !== sessionId) return;
	const session = liveSdkSession?.session;
	liveSdkSession = undefined;
	if (session) closeSdkSession(session);
});

export function streamClaudeAgentSdk(model: Model<any>, context: Context, options: ClaudeAgentSdkStreamOptions) {
	const stream = createAssistantMessageEventStream();

	void (async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: createEmptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const outputState: SdkOutputState = {
			partial: new Map(),
			assistants: new Map(),
			requests: new Map(),
			committed: [],
			hasText: false,
		};
		let invocation: SdkInvocation | undefined;

		try {
			stream.push({ type: "start", partial: output });
			if (options.signal?.aborted) {
				output.stopReason = "aborted";
				stream.push({ type: "error", reason: "aborted", error: output });
				return;
			}

			invocation = await startSdkInvocation(model, context, options, stream);
			let result = await readSdkTurn(invocation.session, model, output, stream, outputState, options.signal);

			// A changed model, system prompt, or tool set restarts the process with
			// `resume`. If Claude no longer has that session, replay Pi's full context.
			if (invocation.resumed && !outputState.hasText && isResumeFailure(result)) {
				discardSdkInvocation(options.sessionId, invocation.session);
				invocation = await startSdkInvocation(model, context, options, stream);
				result = await readSdkTurn(invocation.session, model, output, stream, outputState, options.signal);
			}

			const promptTooLong = result.terminal_reason === "prompt_too_long";
			if (options.signal?.aborted) {
				output.stopReason = "aborted";
			} else if (promptTooLong) {
				const errorText = "Claude Agent SDK prompt is too long";
				output.stopReason = "error";
				output.errorMessage = errorText;
				output.usage = usageFromResult(result, model, outputState.contextTokens);
				if (!outputState.hasText) appendTextBlock(output, stream, errorText);
			} else if (result.subtype === "success") {
				if (!outputState.hasText && result.result) appendTextBlock(output, stream, result.result);
				output.usage = usageFromResult(result, model, outputState.contextTokens);
			} else {
				const errorText = result.errors.join("\n") || "Claude Agent SDK query failed";
				output.stopReason = "error";
				output.errorMessage = errorText;
				output.usage = usageFromResult(result, model, outputState.contextTokens);
				if (!outputState.hasText && errorText) appendTextBlock(output, stream, errorText);
			}

			if (invocation.persistent) {
				if (promptTooLong) {
					invocation.session.needsReset = true;
				} else {
					invocation.session.expectedHistory = historyState([
						...invocation.history,
						...outputState.committed,
						output,
					]);
					invocation.session.needsReset = false;
				}
			}

			if (output.stopReason === "stop") {
				stream.push({ type: "done", reason: "stop", message: output });
			} else {
				stream.push({
					type: "error",
					reason: output.stopReason === "aborted" ? "aborted" : "error",
					error: output,
				});
			}
		} catch (error) {
			if (invocation?.persistent) discardSdkInvocation(options.sessionId, invocation.session);
			output.stopReason = options.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
		} finally {
			if (invocation && !invocation.persistent) closeSdkSession(invocation.session);
			stream.end(output);
		}
	})();

	return stream;
}

async function startSdkInvocation(
	model: Model<any>,
	context: Context,
	options: ClaudeAgentSdkStreamOptions,
	stream: AssistantMessageEventStream,
): Promise<SdkInvocation> {
	const history = context.messages.slice();
	const config = sdkConfig(model, context, options);
	const sessionId = options.sessionId;
	const activeSession = liveSdkSession;
	if (sessionId && activeSession && activeSession.sessionId !== sessionId) {
		discardSdkInvocation(activeSession.sessionId, activeSession.session);
	}
	const existing =
		sessionId !== undefined && sessionId === liveSdkSession?.sessionId ? liveSdkSession.session : undefined;
	const historyContinues = existing ? historyMatches(existing, history) : false;
	const sameConfig = existing?.config === config.fingerprint;
	const continues = Boolean(existing && sameConfig && historyContinues && !existing.needsReset);
	const resets = Boolean(existing && sameConfig && (!historyContinues || existing.needsReset));
	const expectedCount = existing?.expectedHistory?.count ?? 0;
	const resume =
		!continues && !resets && existing && historyContinues && !existing.needsReset ? existing.sdkSessionId : undefined;

	let session: SdkSession;
	if (continues && existing) {
		session = existing;
	} else if (resets && existing) {
		try {
			await resetSdkSession(existing, options.signal);
			session = existing;
		} catch (error) {
			discardSdkInvocation(sessionId, existing);
			if (options.signal?.aborted) throw error;
			session = createSdkSession(model, context, options, config, undefined);
		}
	} else {
		if (existing) discardSdkInvocation(sessionId, existing);
		session = createSdkSession(model, context, options, config, resume);
	}

	const persistent = sessionId !== undefined;
	const turn: SdkTurn = {
		options,
		toolLookup: new Map(options.tools.map((tool) => [tool.name, tool])),
		events: streamToolEvents(stream),
	};
	session.turn.current = turn;

	const messages = continues || resume ? history.slice(expectedCount) : history;
	if (messages.length === 0) {
		if (persistent && liveSdkSession?.session === session) discardSdkInvocation(sessionId, session);
		else closeSdkSession(session);
		throw new Error("Claude Agent SDK received no new messages for a persistent session");
	}
	session.input.push({
		type: "user",
		message: { role: "user", content: serializeSdkMessages(messages) },
		parent_tool_use_id: null,
	});
	if (persistent) liveSdkSession = { sessionId, session };

	return { session, persistent, resumed: resume !== undefined, history };
}

async function resetSdkSession(session: SdkSession, signal: AbortSignal | undefined): Promise<void> {
	if (signal?.aborted) throw new Error("Claude Agent SDK reset aborted");

	const interrupt = () => {
		void session.query.interrupt().catch(() => closeSdkSession(session));
	};
	signal?.addEventListener("abort", interrupt, { once: true });
	session.input.push({
		type: "user",
		message: { role: "user", content: "/clear" },
		parent_tool_use_id: null,
	});

	let reset = false;
	try {
		while (true) {
			const next = await session.query.next();
			if (next.done) throw new Error("Claude Agent SDK process ended while clearing its conversation");
			const message = next.value;
			if (message.type === "conversation_reset") reset = true;
			if (message.type === "system" && message.subtype === "init") {
				// `new_conversation_id` identifies the reset transcript, but SDK resume
				// uses the distinct session_id emitted by the following init/result.
				session.sdkSessionId = message.session_id;
			}
			if (message.type !== "result") continue;

			session.sdkSessionId = message.session_id;
			if (signal?.aborted) throw new Error("Claude Agent SDK reset aborted");
			if (!reset || message.subtype !== "success") {
				throw new Error("Claude Agent SDK did not confirm conversation reset");
			}
			session.expectedHistory = undefined;
			session.needsReset = false;
			return;
		}
	} finally {
		signal?.removeEventListener("abort", interrupt);
	}
}

function createSdkSession(
	model: Model<any>,
	context: Context,
	options: ClaudeAgentSdkStreamOptions,
	config: SdkConfig,
	resume: string | undefined,
): SdkSession {
	const input = new SdkInput();
	const turn: { current?: SdkTurn } = {};
	const sdkTools = createSdkTools(context.tools ?? [], () => turn.current);
	return {
		input,
		query: query({
			prompt: input,
			options: {
				cwd: options.cwd,
				model: model.id,
				pathToClaudeCodeExecutable: findBundledClaude(),
				...config.thinking,
				systemPrompt: config.systemPrompt,
				settingSources: [],
				tools: [],
				mcpServers: {
					pi: createSdkMcpServer({ name: "pi", version: "1.0.0", tools: sdkTools }),
				},
				allowedTools: ["mcp__pi__*"],
				permissionMode: "dontAsk",
				strictMcpConfig: true,
				includePartialMessages: true,
				forwardSubagentText: true,
				env: createClaudeAgentSdkEnv(options.apiKey),
				resume,
				stderr: process.env.PI_CLAUDE_AGENT_SDK_DEBUG === "1" ? (data) => process.stderr.write(data) : undefined,
			},
		}),
		turn,
		config: config.fingerprint,
	};
}

async function readSdkTurn(
	session: SdkSession,
	model: Model<any>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	outputState: SdkOutputState,
	signal: AbortSignal | undefined,
): Promise<SDKResultMessage> {
	const interrupt = () => {
		void session.query.interrupt().catch(() => closeSdkSession(session));
	};
	if (signal?.aborted) interrupt();
	else signal?.addEventListener("abort", interrupt, { once: true });

	try {
		while (true) {
			const next = await session.query.next();
			if (next.done) throw new Error("Claude Agent SDK process ended before returning a result");
			const message = next.value;
			if (message.type === "system" && message.subtype === "init") {
				session.sdkSessionId = message.session_id;
			}
			if (message.type === "result") {
				session.sdkSessionId = message.session_id;
				return message;
			}
			if (message.type === "stream_event") {
				appendSdkStreamEvent(message, output, stream, outputState);
			} else {
				appendSdkText(message, model, output, stream, outputState);
			}
		}
	} finally {
		signal?.removeEventListener("abort", interrupt);
		session.turn.current = undefined;
	}
}

function streamToolEvents(stream: AssistantMessageEventStream): SdkToolEvents {
	return {
		start: (toolCallId, toolName, args) => {
			stream.push({ type: "tool_execution_start", toolCallId, toolName, args });
		},
		update: (toolCallId, toolName, args, partialResult) => {
			stream.push({ type: "tool_execution_update", toolCallId, toolName, args, partialResult });
		},
		end: (toolCallId, toolName, result, isError) => {
			stream.push({ type: "tool_execution_end", toolCallId, toolName, result, isError });
		},
	};
}

function sdkConfig(model: Model<any>, context: Context, options: ClaudeAgentSdkStreamOptions): SdkConfig {
	const usesSubscriptionAuth = options.apiKey === CLAUDE_AGENT_SDK_SUBSCRIPTION_AUTH;
	const systemPrompt = sdkSystemPrompt(options.systemPrompt, usesSubscriptionAuth);
	const thinking = resolveSdkThinking(model, options.reasoning);
	return {
		systemPrompt,
		thinking,
		fingerprint: fingerprint({
			apiKey: options.apiKey,
			cwd: options.cwd,
			model: model.id,
			systemPrompt,
			thinking,
			tools: (context.tools ?? []).map(({ name, description, parameters }) => ({ name, description, parameters })),
		}),
	};
}

type SdkConfig = {
	fingerprint: string;
	systemPrompt: ReturnType<typeof sdkSystemPrompt>;
	thinking: ReturnType<typeof resolveSdkThinking>;
};

function historyMatches(session: SdkSession, history: Context["messages"]): boolean {
	if (!session.expectedHistory || history.length < session.expectedHistory.count) return false;
	return historyState(history.slice(0, session.expectedHistory.count)).hash === session.expectedHistory.hash;
}

function historyState(messages: Context["messages"]): { count: number; hash: string } {
	return {
		count: messages.length,
		hash: fingerprint(messages.map(({ role, content }) => ({ role, content }))),
	};
}

function fingerprint(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isResumeFailure(result: SDKResultMessage): boolean {
	return (
		result.subtype === "error_during_execution" &&
		result.errors.some((error) =>
			/failed to resume|session (?:not found|does not exist)|invalid session/i.test(error),
		)
	);
}

function discardSdkInvocation(sessionId: string | undefined, session: SdkSession): void {
	if (sessionId && liveSdkSession?.sessionId === sessionId && liveSdkSession.session === session) {
		liveSdkSession = undefined;
	}
	closeSdkSession(session);
}

function closeSdkSession(session: SdkSession): void {
	session.input.close();
	session.query.close();
}

class SdkInput implements AsyncIterable<SDKUserMessage>, AsyncIterator<SDKUserMessage> {
	private messages: SDKUserMessage[] = [];
	private waiter: ((result: IteratorResult<SDKUserMessage>) => void) | undefined;
	private closed = false;

	push(message: SDKUserMessage): void {
		if (this.closed) throw new Error("Cannot send input to a closed Claude Agent SDK session");
		const waiter = this.waiter;
		if (waiter) {
			this.waiter = undefined;
			waiter({ value: message, done: false });
			return;
		}
		this.messages.push(message);
	}

	close(): void {
		this.closed = true;
		const waiter = this.waiter;
		this.waiter = undefined;
		waiter?.({ value: undefined, done: true });
	}

	next(): Promise<IteratorResult<SDKUserMessage>> {
		const message = this.messages.shift();
		if (message) return Promise.resolve({ value: message, done: false });
		if (this.closed) return Promise.resolve({ value: undefined, done: true });
		return new Promise((resolve) => {
			this.waiter = resolve;
		});
	}

	[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
		return this;
	}
}

export function sdkSystemPrompt(systemPrompt: string, usesSubscriptionAuth: boolean) {
	if (!usesSubscriptionAuth) return systemPrompt;

	const projectContext = systemPrompt.indexOf("\n<project_context>");
	const piDocs = systemPrompt.indexOf("\nPi documentation (");
	const subscriptionPrompt =
		piDocs >= 0 && projectContext > piDocs
			? `${systemPrompt.slice(0, piDocs)}${systemPrompt.slice(projectContext)}`
			: systemPrompt;

	return {
		type: "preset" as const,
		preset: "claude_code" as const,
		append: `${subscriptionPrompt}\n\nYou are running inside pi. Use the exposed mcp__pi__* tools for workspace actions.`,
	};
}

export function findBundledClaude(
	packageDir = getPackageDir(),
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	const executable = join(packageDir, "native", "claude-agent-sdk", platform === "win32" ? "claude.exe" : "claude");
	return existsSync(executable) ? executable : undefined;
}

export function resolveSdkThinking(
	model: Model<any>,
	level: SimpleStreamOptions["reasoning"],
): {
	thinking: { type: "disabled" } | undefined;
	effort: EffortLevel | undefined;
	extraArgs: Record<string, string | null> | undefined;
} {
	if (!level) return { thinking: { type: "disabled" }, effort: undefined, extraArgs: undefined };

	const mapped = model.thinkingLevelMap?.[level];
	if (mapped === null) return { thinking: undefined, effort: undefined, extraArgs: undefined };

	const effort = mapped ?? level;
	return {
		thinking: undefined,
		effort: effort === "minimal" ? "low" : (effort as EffortLevel),
		extraArgs: { "thinking-display": "summarized" },
	};
}

function createClaudeAgentSdkEnv(apiKey: string | undefined): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {
		...process.env,
		CLAUDE_AGENT_SDK_CLIENT_APP: "pi-coding-agent",
		CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
		DISABLE_AUTO_COMPACT: "1",
		DISABLE_COMPACT: "1",
	};
	if (apiKey === CLAUDE_AGENT_SDK_SUBSCRIPTION_AUTH) {
		delete env.ANTHROPIC_API_KEY;
	} else if (apiKey) {
		env.ANTHROPIC_API_KEY = apiKey;
	}
	return env;
}

function createSdkTools(
	activeTools: readonly Tool[],
	getTurn: () => SdkTurn | undefined,
): SdkMcpToolDefinition<z.ZodRawShape>[] {
	return activeTools.map((toolDefinition) => ({
		name: toMcpToolName(toolDefinition.name),
		description: toolDefinition.description,
		inputSchema: zodShapeFromTypeBox(toolDefinition.parameters),
		handler: async (args) => {
			const turn = getTurn();
			const agentTool = turn?.toolLookup.get(toolDefinition.name);
			if (!turn || !agentTool) {
				return {
					isError: true,
					content: [{ type: "text" as const, text: `Pi tool ${toolDefinition.name} is unavailable` }],
				};
			}
			const execution = await executeAgentTool(agentTool, args, turn.options, turn.events);
			return toolResultToMcp(execution.result, execution.isError);
		},
	}));
}

type TypeBoxSchema = {
	type?: string;
	description?: string;
	const?: unknown;
	enum?: unknown[];
	anyOf?: unknown[];
	oneOf?: unknown[];
	allOf?: unknown[];
	properties?: Record<string, unknown>;
	required?: string[];
	items?: unknown | unknown[];
	additionalProperties?: unknown;
	$ref?: string;
	$defs?: Record<string, unknown>;
	definitions?: Record<string, unknown>;
	minLength?: number;
	maxLength?: number;
	pattern?: string;
	minimum?: number;
	maximum?: number;
	minItems?: number;
	maxItems?: number;
};

type ZodSchema = z.ZodType;

function zodShapeFromTypeBox(schema: unknown): z.ZodRawShape {
	const root = asTypeBoxSchema(schema);
	if (!root?.properties) return {};
	const required = new Set(root.required ?? []);
	const definitions = root.$defs ?? root.definitions;
	return Object.fromEntries(
		Object.entries(root.properties).map(([name, property]) => {
			const zod = zodFromTypeBox(property, definitions);
			return [name, required.has(name) ? zod : zod.optional()];
		}),
	);
}

function zodFromTypeBox(schema: unknown, definitions?: Record<string, unknown>): ZodSchema {
	const typeBox = asTypeBoxSchema(schema);
	if (!typeBox) return z.unknown();

	const reference = resolveTypeBoxReference(typeBox.$ref, definitions);
	if (reference) return withDescription(zodFromTypeBox(reference, definitions), typeBox.description);

	if (Object.hasOwn(typeBox, "const")) {
		return withDescription(z.literal(typeBox.const as never), typeBox.description);
	}
	if (Array.isArray(typeBox.enum)) {
		return withDescription(zodLiteralUnion(typeBox.enum), typeBox.description);
	}
	if (Array.isArray(typeBox.anyOf) || Array.isArray(typeBox.oneOf)) {
		return withDescription(
			zodUnion((typeBox.anyOf ?? typeBox.oneOf ?? []).map((option) => zodFromTypeBox(option, definitions))),
			typeBox.description,
		);
	}
	if (Array.isArray(typeBox.allOf)) {
		return withDescription(
			typeBox.allOf
				.map((option) => zodFromTypeBox(option, definitions))
				.reduce((left, right) => z.intersection(left, right), z.unknown()),
			typeBox.description,
		);
	}

	switch (typeBox.type) {
		case "string":
			return withDescription(zodString(typeBox), typeBox.description);
		case "number":
			return withDescription(zodNumber(typeBox, false), typeBox.description);
		case "integer":
			return withDescription(zodNumber(typeBox, true), typeBox.description);
		case "boolean":
			return withDescription(z.boolean(), typeBox.description);
		case "null":
			return withDescription(z.null(), typeBox.description);
		case "array":
			return withDescription(zodArray(typeBox, definitions), typeBox.description);
		case "object":
			return withDescription(zodObject(typeBox, definitions), typeBox.description);
		default:
			return withDescription(z.unknown(), typeBox.description);
	}
}

function zodString(schema: TypeBoxSchema): ZodSchema {
	let value = z.string();
	if (typeof schema.minLength === "number") value = value.min(schema.minLength);
	if (typeof schema.maxLength === "number") value = value.max(schema.maxLength);
	if (schema.pattern) {
		try {
			value = value.regex(new RegExp(schema.pattern));
		} catch {
			// Invalid patterns must not make a tool unavailable.
		}
	}
	return value;
}

function zodNumber(schema: TypeBoxSchema, integer: boolean): ZodSchema {
	let value = integer ? z.int() : z.number();
	if (typeof schema.minimum === "number") value = value.min(schema.minimum);
	if (typeof schema.maximum === "number") value = value.max(schema.maximum);
	return value;
}

function zodArray(schema: TypeBoxSchema, definitions: Record<string, unknown> | undefined): ZodSchema {
	if (Array.isArray(schema.items)) {
		return z.tuple(schema.items.map((item) => zodFromTypeBox(item, definitions)) as [ZodSchema, ...ZodSchema[]]);
	}
	let value = z.array(zodFromTypeBox(schema.items, definitions));
	if (typeof schema.minItems === "number") value = value.min(schema.minItems);
	if (typeof schema.maxItems === "number") value = value.max(schema.maxItems);
	return value;
}

function zodObject(schema: TypeBoxSchema, definitions: Record<string, unknown> | undefined): ZodSchema {
	const properties = schema.properties ?? {};
	const required = new Set(schema.required ?? []);
	const shape = Object.fromEntries(
		Object.entries(properties).map(([name, property]) => {
			const value = zodFromTypeBox(property, definitions);
			return [name, required.has(name) ? value : value.optional()];
		}),
	);
	if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
		return z.object(shape).catchall(zodFromTypeBox(schema.additionalProperties, definitions));
	}
	return z.object(shape);
}

function zodLiteralUnion(values: unknown[]): ZodSchema {
	return zodUnion(values.map((value) => z.literal(value as never)));
}

function zodUnion(options: ZodSchema[]): ZodSchema {
	if (options.length === 0) return z.never();
	if (options.length === 1) return options[0];
	return z.union(options as [ZodSchema, ZodSchema, ...ZodSchema[]]);
}

function asTypeBoxSchema(value: unknown): TypeBoxSchema | undefined {
	return value && typeof value === "object" ? (value as TypeBoxSchema) : undefined;
}

function resolveTypeBoxReference(
	reference: string | undefined,
	definitions: Record<string, unknown> | undefined,
): unknown {
	if (!reference || !definitions) return undefined;
	const name = reference.replace(/^#\/(?:\$defs|definitions)\//, "");
	return definitions[name];
}

function withDescription<T extends ZodSchema>(schema: T, description: string | undefined): T {
	return description ? schema.describe(description) : schema;
}

async function executeAgentTool(
	agentTool: AgentTool,
	args: unknown,
	options: ClaudeAgentSdkStreamOptions,
	events: SdkToolEvents,
): Promise<{ result: AgentToolResult<unknown>; isError: boolean }> {
	const preparedArgs = agentTool.prepareArguments ? agentTool.prepareArguments(args) : args;
	const toolCall = {
		type: "toolCall",
		id: `claude-agent-sdk-${randomUUID()}`,
		name: agentTool.name,
		arguments: preparedArgs as Record<string, unknown>,
	} as const;
	const assistantMessage: AssistantMessage = {
		role: "assistant",
		content: [toolCall],
		api: CLAUDE_AGENT_SDK_API,
		provider: "claude-agent-sdk",
		model: "claude-agent-sdk",
		usage: createEmptyUsage(),
		stopReason: "toolUse",
		timestamp: Date.now(),
	};

	events.start(toolCall.id, toolCall.name, toolCall.arguments);
	let result: AgentToolResult<unknown>;
	let isError = false;
	try {
		const beforeResult = await options.beforeToolCall?.(
			{
				assistantMessage,
				toolCall,
				args: preparedArgs,
				context: options.agentContext,
			},
			options.signal,
		);
		if (beforeResult?.block) {
			result = {
				content: [{ type: "text", text: beforeResult.reason || "Tool execution was blocked" }],
				details: {},
			};
			isError = true;
		} else {
			let acceptingUpdates = true;
			try {
				result = await agentTool.execute(toolCall.id, preparedArgs as never, options.signal, (partialResult) => {
					if (acceptingUpdates) events.update(toolCall.id, toolCall.name, toolCall.arguments, partialResult);
				});
			} finally {
				acceptingUpdates = false;
			}
			const afterResult = await options.afterToolCall?.(
				{
					assistantMessage,
					toolCall,
					args: preparedArgs,
					result,
					isError,
					context: options.agentContext,
				},
				options.signal,
			);
			if (afterResult) {
				result = {
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					terminate: afterResult.terminate ?? result.terminate,
				};
				isError = afterResult.isError ?? isError;
			}
		}
	} catch (error) {
		result = {
			content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
			details: {},
		};
		isError = true;
	}
	events.end(toolCall.id, toolCall.name, result, isError);
	return { result, isError };
}

function toolResultToMcp(result: AgentToolResult<unknown>, isError: boolean) {
	return {
		isError,
		content: result.content.map((content) => {
			if (content.type === "text") return { type: "text" as const, text: content.text };
			return {
				type: "image" as const,
				data: content.data,
				mimeType: content.mimeType,
			};
		}),
		// Claude Code passes structuredContent to the model instead of content.
		// Pi details belong to the UI; content is the model-facing tool result.
	};
}

function serializeSdkMessages(messages: Context["messages"]): string {
	return messages
		.map((message) => {
			if (message.role === "user" || message.role === "toolResult") {
				const content = Array.isArray(message.content)
					? message.content
							.map((part) => (part.type === "text" ? part.text : `[image:${part.mimeType}]`))
							.join("\n")
					: String(message.content);
				return `<${message.role}>\n${content}\n</${message.role}>`;
			}
			if (message.role === "assistant") {
				const content = message.content
					.map((part) => {
						if (part.type === "text") return part.text;
						if (part.type === "thinking") return `<thinking>${part.thinking}</thinking>`;
						return `<tool_call name="${part.name}">${JSON.stringify(part.arguments)}</tool_call>`;
					})
					.join("\n");
				return `<assistant>\n${content}\n</assistant>`;
			}
			return "";
		})
		.filter(Boolean)
		.join("\n\n");
}

function appendSdkStreamEvent(
	message: Extract<SDKMessage, { type: "stream_event" }>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: SdkOutputState,
): void {
	if (message.parent_tool_use_id) return;
	const event = message.event;
	if (event.type === "message_start") {
		beginSdkMessage(event.message.id, output, stream, state);
		const partial: SdkPartialOutput = { blocks: new Map(), finalized: new Set() };
		state.active = partial;
		state.activeMessageId = event.message.id;
		state.partial.set(event.message.id, partial);
		return;
	}
	if (event.type === "message_stop") {
		if (state.active) {
			const empty = [...state.active.blocks.values()].filter(
				(block) =>
					(block.content.type === "text" && block.content.text.trim().length === 0) ||
					(block.content.type === "thinking" && block.content.thinking.trim().length === 0),
			);
			if (removeOutputBlocks(empty, output)) refreshOutput(output, stream);
		}
		if (state.activeMessageId) state.partial.delete(state.activeMessageId);
		state.active = undefined;
		state.activeMessageId = undefined;
		return;
	}
	if (!state.active) return;

	if (event.type === "content_block_start") {
		const block = event.content_block;
		if (block.type === "text") {
			const outputBlock = appendTextBlock(output, stream, block.text, false);
			state.active.blocks.set(event.index, outputBlock);
			if (block.text) state.hasText = true;
		} else if (block.type === "thinking") {
			state.active.blocks.set(
				event.index,
				appendThinkingBlock(output, stream, block.thinking, block.signature, false),
			);
		} else if (block.type === "tool_use") {
			commitCurrentOutput(output, stream, state);
		}
		return;
	}

	if (event.type !== "content_block_delta" && event.type !== "content_block_stop") return;
	const outputBlock = state.active.blocks.get(event.index);
	if (!outputBlock) return;
	if (event.type === "content_block_delta" && event.delta.type === "text_delta" && outputBlock.kind === "text") {
		appendTextDelta(output, stream, outputBlock, event.delta.text);
		if (event.delta.text) state.hasText = true;
	} else if (
		event.type === "content_block_delta" &&
		event.delta.type === "thinking_delta" &&
		outputBlock.kind === "thinking"
	) {
		appendThinkingDelta(output, stream, outputBlock, event.delta.thinking);
	} else if (event.type === "content_block_stop") {
		endSdkBlock(output, stream, outputBlock);
	}
}

function appendSdkText(
	message: SDKMessage,
	model: Model<any>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: SdkOutputState,
): void {
	if (message.type !== "assistant") return;
	if (message.parent_tool_use_id) {
		appendNestedAssistant(message, output, stream, state);
		return;
	}

	beginSdkMessage(message.message.id, output, stream, state);
	const usageChanged = recordUsage(message, model, output, state);
	const removed = removeSupersededBlocks(message.supersedes, output, stream, state);
	const partial = state.partial.get(message.message.id);
	const takePartialBlock = (kind: SdkOutputBlock["kind"]): SdkOutputBlock | undefined => {
		if (!partial) return undefined;
		for (const outputBlock of partial.blocks.values()) {
			if (outputBlock.kind !== kind || partial.finalized.has(outputBlock)) continue;
			partial.finalized.add(outputBlock);
			return outputBlock;
		}
		return undefined;
	};
	const blocks: SdkOutputBlock[] = [];

	for (const block of message.message.content) {
		if (block.type === "text") {
			const outputBlock = takePartialBlock("text");
			if (outputBlock) {
				reconcileTextBlock(output, stream, outputBlock, block.text);
				blocks.push(outputBlock);
			} else if (block.text) {
				blocks.push(appendTextBlock(output, stream, block.text));
			}
			if (block.text) state.hasText = true;
		} else if (block.type === "thinking") {
			const outputBlock = takePartialBlock("thinking");
			if (outputBlock) {
				reconcileThinkingBlock(output, stream, outputBlock, block.thinking, block.signature);
				blocks.push(outputBlock);
			} else if (block.thinking) {
				blocks.push(appendThinkingBlock(output, stream, block.thinking, block.signature));
			}
		}
	}

	state.assistants.set(message.uuid, blocks);
	if (removed || usageChanged) refreshOutput(output, stream);
}

function beginSdkMessage(
	messageId: string,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: SdkOutputState,
): void {
	if (state.currentMessageId === messageId) return;
	if (state.currentMessageId) commitCurrentOutput(output, stream, state);
	state.currentMessageId = messageId;
}

function appendNestedAssistant(
	message: Extract<SDKMessage, { type: "assistant" }>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: SdkOutputState,
): void {
	const content = message.message.content.flatMap((block): AssistantMessage["content"] => {
		if (block.type === "thinking" && block.thinking.trim()) {
			return [{ type: "thinking", thinking: block.thinking, thinkingSignature: block.signature }];
		}
		if (block.type === "text" && block.text.trim()) return [{ type: "text", text: block.text }];
		return [];
	});
	if (content.length === 0) return;
	const committed: AssistantMessage = {
		...output,
		content,
		usage: createEmptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
	state.committed.push(committed);
	stream.push({ type: "assistant_message_commit", message: committed, alreadyStreamed: false });
}

function appendThinkingBlock(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	thinking: string,
	signature: string | undefined,
	complete = true,
): SdkOutputBlock {
	const content = { type: "thinking" as const, thinking, thinkingSignature: signature };
	const outputBlock: SdkOutputBlock = { content, kind: "thinking" };
	output.content.push(content);
	const contentIndex = contentIndexFor(output, outputBlock);
	stream.push({ type: "thinking_start", contentIndex, partial: output });
	if (thinking) stream.push({ type: "thinking_delta", contentIndex, delta: thinking, partial: output });
	if (complete) stream.push({ type: "thinking_end", contentIndex, content: thinking, partial: output });
	return outputBlock;
}

function appendTextBlock(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	text: string,
	complete = true,
): SdkOutputBlock {
	const content = { type: "text" as const, text };
	const outputBlock: SdkOutputBlock = { content, kind: "text" };
	output.content.push(content);
	const contentIndex = contentIndexFor(output, outputBlock);
	stream.push({ type: "text_start", contentIndex, partial: output });
	if (text) stream.push({ type: "text_delta", contentIndex, delta: text, partial: output });
	if (complete) stream.push({ type: "text_end", contentIndex, content: text, partial: output });
	return outputBlock;
}

function appendTextDelta(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	outputBlock: SdkOutputBlock,
	delta: string,
): void {
	if (outputBlock.content.type !== "text") return;
	outputBlock.content.text += delta;
	stream.push({ type: "text_delta", contentIndex: contentIndexFor(output, outputBlock), delta, partial: output });
}

function appendThinkingDelta(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	outputBlock: SdkOutputBlock,
	delta: string,
): void {
	if (outputBlock.content.type !== "thinking") return;
	outputBlock.content.thinking += delta;
	stream.push({ type: "thinking_delta", contentIndex: contentIndexFor(output, outputBlock), delta, partial: output });
}

function endSdkBlock(output: AssistantMessage, stream: AssistantMessageEventStream, outputBlock: SdkOutputBlock): void {
	const contentIndex = contentIndexFor(output, outputBlock);
	if (outputBlock.content.type === "text") {
		stream.push({ type: "text_end", contentIndex, content: outputBlock.content.text, partial: output });
	} else if (outputBlock.content.type === "thinking") {
		stream.push({ type: "thinking_end", contentIndex, content: outputBlock.content.thinking, partial: output });
	}
}

function reconcileTextBlock(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	outputBlock: SdkOutputBlock,
	text: string,
): void {
	if (outputBlock.content.type !== "text" || outputBlock.content.text === text) return;
	const delta = text.startsWith(outputBlock.content.text) ? text.slice(outputBlock.content.text.length) : "";
	outputBlock.content.text = text;
	if (delta) {
		stream.push({ type: "text_delta", contentIndex: contentIndexFor(output, outputBlock), delta, partial: output });
	} else {
		refreshOutput(output, stream);
	}
}

function reconcileThinkingBlock(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	outputBlock: SdkOutputBlock,
	thinking: string,
	signature: string | undefined,
): void {
	if (outputBlock.content.type !== "thinking") return;
	const delta = thinking.startsWith(outputBlock.content.thinking)
		? thinking.slice(outputBlock.content.thinking.length)
		: "";
	outputBlock.content.thinking = thinking;
	outputBlock.content.thinkingSignature = signature;
	if (delta) {
		stream.push({
			type: "thinking_delta",
			contentIndex: contentIndexFor(output, outputBlock),
			delta,
			partial: output,
		});
	} else {
		refreshOutput(output, stream);
	}
}

function removeSupersededBlocks(
	supersedes: string[] | undefined,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: SdkOutputState,
): boolean {
	if (!supersedes?.length) return false;
	const removed = new Set<AssistantMessage["content"][number]>();
	for (const uuid of supersedes) {
		for (const block of state.assistants.get(uuid) ?? []) removed.add(block.content);
		state.assistants.delete(uuid);
	}
	const blocks = [...removed].map((content) => ({
		content,
		kind: content.type === "thinking" ? ("thinking" as const) : ("text" as const),
	}));
	return commitOutputBlocks(blocks, output, stream, state);
}

function commitCurrentOutput(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: SdkOutputState,
): void {
	const blocks = output.content.flatMap((content): SdkOutputBlock[] => {
		if (content.type === "thinking") return [{ content, kind: "thinking" }];
		if (content.type === "text") return [{ content, kind: "text" }];
		return [];
	});
	if (commitOutputBlocks(blocks, output, stream, state)) refreshOutput(output, stream);
}

function commitOutputBlocks(
	blocks: SdkOutputBlock[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: SdkOutputState,
): boolean {
	const active = blocks.filter((block) => output.content.includes(block.content));
	if (active.length === 0) return false;
	const committedContent = active
		.map((block) => block.content)
		.filter(
			(content) =>
				(content.type === "text" && content.text.trim().length > 0) ||
				(content.type === "thinking" && content.thinking.trim().length > 0),
		)
		.map((content) => ({ ...content }));
	if (committedContent.length > 0) {
		const committed: AssistantMessage = {
			...output,
			content: committedContent,
			usage: createEmptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		state.committed.push(committed);
		stream.push({ type: "assistant_message_commit", message: committed });
	}
	return removeOutputBlocks(active, output);
}

function removeOutputBlocks(blocks: SdkOutputBlock[], output: AssistantMessage): boolean {
	if (blocks.length === 0) return false;
	const removed = new Set(blocks.map((block) => block.content));
	const retained = output.content.filter((content) => !removed.has(content));
	if (retained.length === output.content.length) return false;
	output.content.splice(0, output.content.length, ...retained);
	return true;
}

function refreshOutput(output: AssistantMessage, stream: AssistantMessageEventStream): void {
	const content = output.content.at(-1);
	if (content?.type === "thinking") {
		stream.push({ type: "thinking_delta", contentIndex: output.content.length - 1, delta: "", partial: output });
	} else {
		stream.push({
			type: "text_delta",
			contentIndex: Math.max(0, output.content.length - 1),
			delta: "",
			partial: output,
		});
	}
}

function contentIndexFor(output: AssistantMessage, outputBlock: SdkOutputBlock): number {
	return output.content.indexOf(outputBlock.content);
}

function recordUsage(
	message: Extract<SDKMessage, { type: "assistant" }>,
	model: Model<any>,
	output: AssistantMessage,
	state: SdkOutputState,
): boolean {
	const raw = message.message.usage;
	if (!raw) return false;

	const request = createEmptyUsage();
	request.input = raw.input_tokens;
	request.output = raw.output_tokens;
	request.cacheRead = raw.cache_read_input_tokens ?? 0;
	request.cacheWrite = raw.cache_creation_input_tokens ?? 0;
	request.cacheWrite1h = raw.cache_creation?.ephemeral_1h_input_tokens ?? 0;
	request.reasoning = raw.output_tokens_details?.thinking_tokens;
	request.totalTokens = request.input + request.output + request.cacheRead + request.cacheWrite;
	request.contextTokens = requestContext(raw);
	calculateCost(model, request);

	state.requests.set(message.message.id, request);
	if (request.contextTokens > 0) state.contextTokens = request.contextTokens;

	const aggregate = createEmptyUsage();
	let hasLongWrites = false;
	let hasReasoning = false;
	for (const usage of state.requests.values()) {
		aggregate.input += usage.input;
		aggregate.output += usage.output;
		aggregate.cacheRead += usage.cacheRead;
		aggregate.cacheWrite += usage.cacheWrite;
		aggregate.totalTokens += usage.totalTokens;
		aggregate.cost.input += usage.cost.input;
		aggregate.cost.output += usage.cost.output;
		aggregate.cost.cacheRead += usage.cost.cacheRead;
		aggregate.cost.cacheWrite += usage.cost.cacheWrite;
		aggregate.cost.total += usage.cost.total;
		if (usage.cacheWrite1h !== undefined) {
			hasLongWrites = true;
			aggregate.cacheWrite1h = (aggregate.cacheWrite1h ?? 0) + usage.cacheWrite1h;
		}
		if (usage.reasoning !== undefined) {
			hasReasoning = true;
			aggregate.reasoning = (aggregate.reasoning ?? 0) + usage.reasoning;
		}
	}
	if (!hasLongWrites) aggregate.cacheWrite1h = undefined;
	if (!hasReasoning) aggregate.reasoning = undefined;
	aggregate.contextTokens = state.contextTokens;
	output.usage = aggregate;
	return true;
}

function requestContext(raw: Extract<SDKMessage, { type: "assistant" }>["message"]["usage"]): number {
	const usage = raw.iterations?.at(-1) ?? raw;
	return (
		usage.input_tokens +
		usage.output_tokens +
		(usage.cache_read_input_tokens ?? 0) +
		(usage.cache_creation_input_tokens ?? 0)
	);
}

function usageFromResult(result: SDKResultMessage, model: Model<any>, contextTokens: number | undefined): Usage {
	const usage = createEmptyUsage();
	// result.usage aggregates the main conversation loop; modelUsage[0] can be an
	// internal helper model (e.g. Haiku) and badly under-reports the turn.
	usage.input = result.usage.input_tokens;
	usage.output = result.usage.output_tokens;
	usage.cacheRead = result.usage.cache_read_input_tokens ?? 0;
	usage.cacheWrite = result.usage.cache_creation_input_tokens ?? 0;
	usage.cacheWrite1h = result.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
	usage.reasoning = result.usage.output_tokens_details?.thinking_tokens;
	usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	usage.contextTokens = contextTokens;
	calculateCost(model, usage);
	usage.cost.total = result.total_cost_usd;
	return usage;
}

function createEmptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function toMcpToolName(toolName: string): string {
	return toolName.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
}

export function isClaudeAgentSdkModel(model: Model<any>): boolean {
	return model.api === CLAUDE_AGENT_SDK_API;
}
