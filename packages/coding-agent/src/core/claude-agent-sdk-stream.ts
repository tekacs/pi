import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	createSdkMcpServer,
	type EffortLevel,
	type ModelUsage,
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
	Model,
	SimpleStreamOptions,
	Tool,
	ToolResultMessage,
	TranscriptContext,
	Usage,
} from "@earendil-works/pi-ai";
import {
	calculateCost,
	getCurrentSystemPrompt,
	getCurrentTools,
	registerSessionResourceCleanup,
} from "@earendil-works/pi-ai";
import { z } from "zod/v4";
import { getPackageDir } from "../config.ts";
import { CLAUDE_AGENT_SDK_API, CLAUDE_AGENT_SDK_SUBSCRIPTION_AUTH, pricedAs } from "./claude-agent-sdk-models.ts";
import { ClaudeCalls, mcpName } from "./claude-calls.ts";
import { type ClaudeCheckpoint, ClaudePrefix } from "./claude-checkpoints.ts";
import { ClaudeHistory } from "./claude-history.ts";
import { displayOnly, importHistory, selectHistory, userContent } from "./claude-import.ts";
import { ClaudeMemory, ClaudeStore } from "./claude-store.ts";
import { runAgentTool } from "./harness.ts";
import { HarnessOutput } from "./harness-output.ts";

/** Disable the bundled binary's duplicate MCP result ceiling in practice. */
const SDK_TOOL_RESULT_TOKENS = Number.MAX_SAFE_INTEGER;
/**
 * Per-tool `anthropic/maxResultSizeChars` hint. The binary clamps it to its
 * 500k-char persistence ceiling; without it, MCP results above ~50k chars are
 * persisted to disk and replaced by a preview.
 */
const SDK_TOOL_RESULT_CHARS = 500_000;

type ToolLookup = ReadonlyMap<string, AgentTool>;

export interface ClaudeAgentSdkStreamOptions extends SimpleStreamOptions {
	cwd: string;
	/** Executable host tools; declarations and prompt are replayed from the request transcript. */
	tools: readonly AgentTool[];
	agentContext: AgentContext;
	/** Claude-owned profile storage; omitted for in-process, memory-only history. */
	nativeRoot?: string;
	executable?: string;
	beforeToolCall?: Agent["beforeToolCall"];
	afterToolCall?: Agent["afterToolCall"];
}

type SdkTurn = {
	model: Model<any>;
	options: ClaudeAgentSdkStreamOptions;
	toolLookup: ToolLookup;
	stream: HarnessOutput;
	calls: ClaudeCalls;
	native: ClaudeHistory;
	commit: (message: AssistantMessage | ToolResultMessage) => Promise<void>;
	fail: (error: unknown) => void;
};

type SdkSession = {
	lifetime: AbortController;
	input: SdkInput;
	query: Query;
	turn: { current?: SdkTurn };
	config: string;
	store: ClaudeStore;
	checkpoint?: ClaudeCheckpoint;
	failure?: Error;
	/** Per-model spend as of this process's last result; the SDK reports it cumulatively, never per turn. */
	spent: Record<string, ModelUsage>;
};

type SdkInvocation = {
	session: SdkSession;
	persistent: boolean;
	native: ClaudeHistory;
};

type SdkOutputBlock = {
	content: AssistantMessage["content"][number];
	kind: "text" | "thinking";
};

type SdkPartialOutput = {
	blocks: Map<number, SdkOutputBlock>;
	finalized: Set<SdkOutputBlock>;
};

type ExtendedSdkUsage = {
	output_tokens_details?: { thinking_tokens?: number };
	iterations?: Array<{
		input_tokens: number;
		output_tokens: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
	}>;
};

type SdkOutputState = {
	active?: SdkPartialOutput;
	activeMessageId?: string;
	currentMessageId?: string;
	partial: Map<string, SdkPartialOutput>;
	assistants: Map<string, SdkOutputBlock[]>;
	requests: Map<string, Usage>;
	publish: (
		message: AssistantMessage | ToolResultMessage,
		members?: readonly object[],
		alreadyStreamed?: boolean,
	) => Promise<void>;
	native?: ClaudeHistory;
	/** Text of a synthetic native API-error reply; it is an error, never model output. */
	apiError?: string;
	apiErrorKind?: string;
	commits: number;
	cursor?: string;
	contextTokens?: number;
	entryPrompt?: Usage["entryPrompt"];
	/** Model Claude Code actually served for this loop; an alias such as "opus" resolves to it. */
	servedModel?: string;
	hasText: boolean;
};

const sdkSessions = new Map<string, SdkSession>();
const memorySessions = new Map<string, ClaudeMemory>();

registerSessionResourceCleanup((sessionId) => {
	for (const [id, session] of sdkSessions) {
		if (sessionId !== undefined && sessionId !== id) continue;
		sdkSessions.delete(id);
		closeSdkSession(session);
	}
	for (const [id, memory] of memorySessions) {
		if (sessionId !== undefined && sessionId !== id) continue;
		memory.close();
		memorySessions.delete(id);
	}
});

export function streamClaudeAgentSdk(
	model: Model<any>,
	context: TranscriptContext,
	options: ClaudeAgentSdkStreamOptions,
) {
	const stream = new HarnessOutput(options.signal);

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
		let invocation: SdkInvocation | undefined;
		const outputState: SdkOutputState = {
			partial: new Map(),
			assistants: new Map(),
			requests: new Map(),
			hasText: false,
			commits: 0,
			publish: (message, members, alreadyStreamed = true) => {
				outputState.commits++;
				const receipt = stream.commit(message, alreadyStreamed);
				void receipt.catch((error: unknown) => invocation?.session.turn.current?.fail(error));
				outputState.native?.record(message, members, receipt);
				return receipt;
			},
		};
		const commit = (message: AssistantMessage | ToolResultMessage) => {
			if (message.role === "assistant") commitCurrentOutput(output, stream, outputState);
			return outputState.publish(message);
		};

		try {
			stream.push({ type: "start", partial: output });
			if (options.signal?.aborted) {
				output.stopReason = "aborted";
				stream.push({ type: "error", reason: "aborted", error: output });
				return;
			}

			invocation = await startSdkInvocation(model, context, options, stream, commit);
			outputState.native = invocation.native;
			let result = await readSdkTurn(invocation.session, model, output, stream, outputState, options.signal);
			const authFailed = () =>
				outputState.apiErrorKind === "authentication_failed" ||
				(result.subtype !== "success" && /\b401\b|authenticat|oauth token/i.test(result.errors.join("\n")));
			if (authFailed() && !options.signal?.aborted && outputState.commits === 0 && output.content.length === 0) {
				// A long-lived process can hold credentials Claude Code has since rotated. The pinned
				// secure-storage profile lets its replacement reread and refresh the original login.
				discardSdkInvocation(options.sessionId, invocation.session);
				outputState.apiError = undefined;
				outputState.apiErrorKind = undefined;
				outputState.requests.clear();
				invocation = await startSdkInvocation(model, context, options, stream, commit);
				outputState.native = invocation.native;
				result = await readSdkTurn(invocation.session, model, output, stream, outputState, options.signal);
				if (authFailed() && outputState.apiError)
					outputState.apiError = `${outputState.apiError}\nClaude authentication still fails after reloading credentials. Sign in again in Claude Code (run \`claude\`, then /login).`;
			}

			const promptTooLong = result.terminal_reason === "prompt_too_long";
			if (options.signal?.aborted) {
				output.stopReason = "aborted";
			} else if (outputState.apiError) {
				// Pi's error classification (e.g. context overflow → compaction) reads this message.
				output.stopReason = "error";
				output.errorMessage = outputState.apiError;
				output.usage = usageFromResult(result, model, outputState, invocation.session);
			} else if (promptTooLong) {
				const errorText = "Claude Agent SDK prompt is too long";
				output.stopReason = "error";
				output.errorMessage = errorText;
				output.usage = usageFromResult(result, model, outputState, invocation.session);
				if (!outputState.hasText) appendTextBlock(output, stream, errorText);
			} else if (result.subtype === "success") {
				if (!outputState.hasText && result.result) appendTextBlock(output, stream, result.result);
				output.usage = usageFromResult(result, model, outputState, invocation.session);
			} else {
				const errorText = result.errors.join("\n") || "Claude Agent SDK query failed";
				output.stopReason = "error";
				output.errorMessage = errorText;
				output.usage = usageFromResult(result, model, outputState, invocation.session);
				if (!outputState.hasText && errorText) appendTextBlock(output, stream, errorText);
			}

			if (output.stopReason === "stop") {
				if (!outputState.cursor) throw new Error("Claude returned no native checkpoint boundary");
				invocation.session.checkpoint = await invocation.native.finish(
					output,
					result.session_id,
					outputState.cursor,
				);
				stream.push({ type: "done", reason: "stop", message: output });
			} else {
				discardSdkInvocation(options.sessionId, invocation.session);
				stream.push({
					type: "error",
					reason: output.stopReason === "aborted" ? "aborted" : "error",
					error: output,
				});
			}
		} catch (error) {
			const failure = invocation?.session.failure ?? error;
			if (invocation?.persistent) discardSdkInvocation(options.sessionId, invocation.session);
			output.stopReason = options.signal?.aborted ? "aborted" : "error";
			output.errorMessage = failure instanceof Error ? failure.message : String(failure);
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
	context: TranscriptContext,
	options: ClaudeAgentSdkStreamOptions,
	stream: HarnessOutput,
	commit: SdkTurn["commit"],
): Promise<SdkInvocation> {
	const history = context.messages.filter((message) => message.role !== "system");
	const config = sdkConfig(model, context, options);
	const sessionId = options.sessionId;
	const existing = sessionId === undefined ? undefined : sdkSessions.get(sessionId);
	if (existing?.turn.current) throw new Error("Claude session already has an active turn");
	let memory: ClaudeMemory | undefined;
	if (options.nativeRoot === undefined && sessionId !== undefined) {
		memory = memorySessions.get(sessionId) ?? new ClaudeMemory();
		memorySessions.set(sessionId, memory);
	}
	const store = new ClaudeStore(options.nativeRoot ?? memory);
	const prefix = new ClaudePrefix([]);
	const { checkpoint, count, imported } = selectHistory(store, history, prefix);
	let seed = importHistory(imported, checkpoint?.cursor);
	let cursor = seed.at(-1)?.uuid ?? checkpoint?.cursor;
	const continues =
		imported.length === 0 &&
		existing?.config === config.fingerprint &&
		checkpoint !== undefined &&
		existing.checkpoint?.hash === checkpoint.hash;
	const messages = history.slice(count).filter((message) => !displayOnly(message));
	if (!messages.length) throw new Error("Claude Agent SDK received no new messages for a persistent session");
	const inputs = messages.map((message, index): SDKUserMessage => {
		if (message.role !== "user") throw new Error("Claude continuation accepts only new user messages");
		return {
			type: "user",
			message: { role: "user", content: userContent(message.content) },
			parent_tool_use_id: null,
			client_composed: true,
			shouldQuery: index === messages.length - 1,
		};
	});
	let session: SdkSession;
	if (continues && existing) session = existing;
	else {
		if (existing) discardSdkInvocation(sessionId, existing);
		let continuation: Parameters<typeof createSdkSession>[5];
		try {
			continuation = checkpoint
				? await store.fork(checkpoint.key, checkpoint.cursor, options.signal, seed)
				: seed.length
					? store.stage(seed)
					: { sessionStore: store };
		} catch (error) {
			if (options.signal?.aborted) throw error;
			// Pre-inference only: no historical effects execute and no failed query is retried.
			seed = importHistory(history.slice(0, count));
			cursor = seed.at(-1)?.uuid;
			continuation = seed.length ? store.stage(seed) : { sessionStore: store };
		}
		session = createSdkSession(model, context, options, config, store, continuation);
	}
	const fail = (error: unknown) => {
		session.failure = error instanceof Error ? error : new Error(String(error));
		closeSdkSession(session);
	};
	// Cancelling inference must not cancel certification of already acknowledged effects.
	const native = new ClaudeHistory(session.store, prefix, { cursor, signal: session.lifetime.signal, fail });
	session.turn.current = {
		model,
		options,
		toolLookup: new Map(options.tools.map((tool) => [tool.name, tool])),
		stream,
		calls: new ClaudeCalls(),
		native,
		commit,
		fail,
	};
	for (const input of inputs) session.input.push(input);
	if (sessionId !== undefined) sdkSessions.set(sessionId, session);
	return { session, persistent: sessionId !== undefined, native };
}

function createSdkSession(
	model: Model<any>,
	context: TranscriptContext,
	options: ClaudeAgentSdkStreamOptions,
	config: SdkConfig,
	store: ClaudeStore,
	continuation: { sessionStore: ClaudeStore } | Awaited<ReturnType<ClaudeStore["fork"]>>,
): SdkSession {
	const input = new SdkInput();
	const turn: { current?: SdkTurn } = {};
	const sdkTools = createSdkTools(getCurrentTools(context.messages), () => turn.current);
	return {
		lifetime: new AbortController(),
		input,
		query: query({
			prompt: input,
			options: {
				cwd: options.cwd,
				model: model.id,
				pathToClaudeCodeExecutable: options.executable ?? findBundledClaude(),
				...config.thinking,
				systemPrompt: config.systemPrompt,
				settingSources: [],
				tools: [],
				mcpServers: {
					pi: createSdkMcpServer({ name: "pi", version: "1.0.0", tools: sdkTools }),
				},
				hooks: {
					PostToolBatch: [
						{
							hooks: [
								async (input) => {
									if (input.hook_event_name !== "PostToolBatch") return {};
									const ids = input.tool_calls.map((call) => call.tool_use_id);
									return turn.current?.calls.terminates(ids)
										? { continue: false, stopReason: "Pi tool batch requested termination" }
										: {};
								},
							],
						},
					],
				},
				allowedTools: ["mcp__pi__*"],
				permissionMode: "dontAsk",
				strictMcpConfig: true,
				includePartialMessages: true,
				forwardSubagentText: true,
				env: config.env,
				...continuation,
				sessionStoreFlush: "eager",
				stderr: process.env.PI_CLAUDE_AGENT_SDK_DEBUG === "1" ? (data) => process.stderr.write(data) : undefined,
			},
		}),
		turn,
		config: config.fingerprint,
		store,
		spent: {},
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
			if (session.failure) throw session.failure;
			if (next.done) throw new Error("Claude Agent SDK process ended before returning a result");
			const message = next.value;
			// Native persistence loss reduces fidelity; the canonical conversation continues.
			if (message.type === "system" && message.subtype === "mirror_error") session.turn.current?.native.degrade();
			if (message.type === "result") {
				if (message.subtype === "success" && message.num_turns === 0) continue;
				session.turn.current?.calls.finish();
				await session.turn.current?.native.settle();
				return message;
			}
			if (
				message.type === "user" &&
				!message.parent_tool_use_id &&
				message.uuid &&
				Array.isArray(message.message.content) &&
				message.message.content.some((block) => block.type === "tool_result")
			) {
				const turn = session.turn.current;
				for (const block of message.message.content)
					if (block.type === "tool_result" && turn) recordNativeOutcome(turn, model, block);
				outputState.cursor = message.uuid;
				if (!message.session_id) outputState.native?.degrade();
				else
					outputState.native?.result(
						message.session_id,
						message.uuid,
						message.message.content.flatMap((block) => (block.type === "tool_result" ? [block.tool_use_id] : [])),
					);
			}
			if (message.type === "stream_event") {
				appendSdkStreamEvent(message, output, stream, outputState);
			} else {
				appendSdkText(message, model, output, stream, outputState);
				if (message.type === "assistant") session.turn.current?.calls.observe(message);
			}
		}
	} finally {
		signal?.removeEventListener("abort", interrupt);
		session.turn.current?.calls.close();
		session.turn.current = undefined;
	}
}

type NativeResult = { tool_use_id: string; content?: unknown; is_error?: boolean };

/** Commit a call the native runtime settled itself, so canonical history matches what the model saw. */
function recordNativeOutcome(turn: SdkTurn, model: Model<any>, block: NativeResult): void {
	const call = turn.calls.unexecuted(block.tool_use_id);
	if (!call) return;
	turn.calls.complete(call.id, false);
	const toolName = call.name.startsWith("mcp__pi__") ? call.name.slice("mcp__pi__".length) : call.name;
	const args = (call.input && typeof call.input === "object" ? call.input : {}) as Record<string, never>;
	void turn.commit({
		role: "assistant",
		content: [{ type: "toolCall", id: call.id, name: toolName, arguments: args }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		responseId: call.responseId,
		usage: createEmptyUsage(),
		stopReason: "toolUse",
		timestamp: Date.now(),
	});
	turn.stream.push({ type: "tool_execution_start", toolCallId: call.id, toolName, args });
	const content = nativeContent(block.content);
	const isError = block.is_error === true;
	void turn.commit({ role: "toolResult", toolCallId: call.id, toolName, content, isError, timestamp: Date.now() });
	turn.stream.push({
		type: "tool_execution_end",
		toolCallId: call.id,
		toolName,
		result: { content, details: {} },
		isError,
	});
}

function nativeContent(content: unknown): ToolResultMessage["content"] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (!Array.isArray(content)) return [];
	return content.map((block): ToolResultMessage["content"][number] => {
		if (block?.type === "text" && typeof block.text === "string") return { type: "text", text: block.text };
		if (block?.type === "image" && block.source?.type === "base64")
			return { type: "image", data: block.source.data, mimeType: block.source.media_type };
		return { type: "text", text: JSON.stringify(block) };
	});
}

function sdkConfig(model: Model<any>, context: TranscriptContext, options: ClaudeAgentSdkStreamOptions): SdkConfig {
	const usesSubscriptionAuth = options.apiKey === CLAUDE_AGENT_SDK_SUBSCRIPTION_AUTH;
	const systemPrompt = sdkSystemPrompt(getCurrentSystemPrompt(context.messages), usesSubscriptionAuth);
	const thinking = resolveSdkThinking(model, options.reasoning);
	const env = createClaudeAgentSdkEnv(options);
	return {
		systemPrompt,
		thinking,
		env,
		fingerprint: fingerprint({
			apiKey: options.apiKey,
			// A live SDK child retains auth. Recreate it when a request selects a different
			// token/profile, rather than silently continuing under the previous account.
			auth: [env.CLAUDE_CODE_OAUTH_TOKEN, env.CLAUDE_CONFIG_DIR, env.CLAUDE_SECURESTORAGE_CONFIG_DIR],
			cacheTtl: env.CLAUDE_CODE_PROMPT_CACHE_TTL,
			cwd: options.cwd,
			nativeRoot: options.nativeRoot,
			executable: options.executable,
			model: model.id,
			systemPrompt,
			thinking,
			tools: getCurrentTools(context.messages).map(({ name, description, parameters }) => ({
				name,
				description,
				parameters,
			})),
		}),
	};
}

type SdkConfig = {
	fingerprint: string;
	systemPrompt: ReturnType<typeof sdkSystemPrompt>;
	thinking: ReturnType<typeof resolveSdkThinking>;
	env: Record<string, string | undefined>;
};

function fingerprint(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function discardSdkInvocation(sessionId: string | undefined, session: SdkSession): void {
	if (sessionId && sdkSessions.get(sessionId) === session) sdkSessions.delete(sessionId);
	closeSdkSession(session);
}

function closeSdkSession(session: SdkSession): void {
	session.lifetime.abort();
	session.turn.current?.calls.close();
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
	if (!usesSubscriptionAuth) return { type: "custom" as const, prompt: systemPrompt, snapshot: false };

	// Subscription requests that carry pi's documentation block are billed as extra usage;
	// the rest of pi's prompt passes as-is, without the Claude Code preset.
	return {
		type: "custom" as const,
		prompt: `${withoutPiDocs(systemPrompt)}\n\nYou are running inside pi. Use the exposed mcp__pi__* tools for workspace actions.`,
		snapshot: false,
	};
}

function withoutPiDocs(systemPrompt: string): string {
	const start = systemPrompt.indexOf("<docs>\nPi documentation (");
	const end = start < 0 ? -1 : systemPrompt.indexOf("</docs>", start);
	if (end < 0) return systemPrompt;
	const before = systemPrompt.slice(0, start).trimEnd();
	const after = systemPrompt.slice(end + "</docs>".length).trimStart();
	return before && after ? `${before}\n\n${after}` : before || after;
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

function createClaudeAgentSdkEnv(
	options: Pick<ClaudeAgentSdkStreamOptions, "apiKey" | "cacheRetention" | "env">,
): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {
		...process.env,
		...options.env,
		CLAUDE_AGENT_SDK_CLIENT_APP: "pi-coding-agent",
		CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
		DISABLE_AUTO_COMPACT: "1",
		DISABLE_COMPACT: "1",
	};
	// SDK resume stages an access-token-only copy in a temporary CLAUDE_CONFIG_DIR.
	// Keep credentials, refresh locks, and writeback in the original profile. Empty
	// string deliberately selects Claude Code's default (unhashed) Keychain item.
	env.CLAUDE_SECURESTORAGE_CONFIG_DIR ??= env.CLAUDE_CONFIG_DIR ?? "";
	// Pi's tools reach the binary as SDK MCP tools, so their results otherwise
	// cross a second, context-blind persistence threshold after Pi has already
	// sized them deliberately. Keep Pi's own result handling authoritative.
	if (!env.MAX_MCP_OUTPUT_TOKENS) {
		env.MAX_MCP_OUTPUT_TOKENS = String(SDK_TOOL_RESULT_TOKENS);
	}
	const retention = options.cacheRetention ?? (env.PI_CACHE_RETENTION === "long" ? "long" : undefined);
	if (retention === "long") env.CLAUDE_CODE_PROMPT_CACHE_TTL = "1h";
	if (retention === "short") env.CLAUDE_CODE_PROMPT_CACHE_TTL = "5m";
	if (options.apiKey === CLAUDE_AGENT_SDK_SUBSCRIPTION_AUTH) {
		env.ANTHROPIC_API_KEY = undefined;
		if (options.env?.CLAUDE_CODE_OAUTH_TOKEN) {
			// Explicit subscription selection must not inherit another credential or vendor.
			for (const name of [
				"ANTHROPIC_AUTH_TOKEN",
				"ANTHROPIC_BASE_URL",
				"ANTHROPIC_UNIX_SOCKET",
				"CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
				"CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
				"CLAUDE_CODE_USE_BEDROCK",
				"CLAUDE_CODE_USE_VERTEX",
				"CLAUDE_CODE_USE_FOUNDRY",
			])
				env[name] = undefined;
		}
	} else if (options.apiKey) {
		env.ANTHROPIC_API_KEY = options.apiKey;
	}
	return env;
}

function createSdkTools(
	activeTools: readonly Tool[],
	getTurn: () => SdkTurn | undefined,
): SdkMcpToolDefinition<z.ZodRawShape>[] {
	return activeTools.map((toolDefinition) => ({
		name: mcpName(toolDefinition.name),
		description: toolDefinition.description,
		inputSchema: zodShapeFromTypeBox(toolDefinition.parameters),
		_meta: { "anthropic/maxResultSizeChars": SDK_TOOL_RESULT_CHARS },
		handler: async (_args, extra) => {
			const turn = getTurn();
			const agentTool = turn?.toolLookup.get(toolDefinition.name);
			if (!turn || !agentTool) {
				return {
					isError: true,
					content: [{ type: "text" as const, text: `Pi tool ${toolDefinition.name} is unavailable` }],
				};
			}
			try {
				const metadata = z
					.object({ _meta: z.object({ "claudecode/toolUseId": z.string().min(1) }) })
					.safeParse(extra);
				if (!metadata.success) throw new Error("Claude MCP request has no native call ID; execution refused");
				const call = await turn.calls.wait(metadata.data._meta["claudecode/toolUseId"]);
				if (call.name !== `mcp__pi__${mcpName(toolDefinition.name)}`)
					throw new Error("Native call names a different tool");
				const execution = await runAgentTool(agentTool, call.input, {
					model: turn.model,
					context: turn.options.agentContext,
					stream: turn.stream,
					signal: turn.options.signal,
					callId: call.id,
					commit: (message) => {
						if (message.role === "assistant") message.responseId = call.responseId;
						return turn.commit(message);
					},
					beforeToolCall: turn.options.beforeToolCall,
					afterToolCall: turn.options.afterToolCall,
				});
				turn.calls.complete(call.id, execution.result.terminate === true);
				return toolResultToMcp(execution.result, execution.isError);
			} catch (error) {
				// A failed canonical barrier must not become a retryable MCP tool error.
				turn.fail(error);
				throw error;
			}
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
					(block.content.type === "thinking" &&
						!block.content.redacted &&
						block.content.thinking.trim().length === 0),
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
		state.native?.child();
		appendNestedAssistant(message, output, state);
		return;
	}
	// The native runtime reports API failures, including context overflow, as synthetic assistant replies.
	if (message.error) {
		const text = message.message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
		state.apiError = text || `Claude API error: ${message.error}`;
		state.apiErrorKind = message.error;
		return;
	}

	beginSdkMessage(message.message.id, output, stream, state);
	const usageChanged = recordUsage(message, model, output, state);
	const removed = removeSupersededBlocks(message.supersedes, output, state);
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
		} else if (block.type === "redacted_thinking") {
			const opaque = appendThinkingBlock(output, stream, "", block.data);
			if (opaque.content.type === "thinking") opaque.content.redacted = true;
			blocks.push(opaque);
		}
	}

	state.cursor = message.uuid;
	state.native?.observe(message.session_id, message.uuid, blocks.map((block) => block.content).filter(visibleBlock));
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
	output.responseId = messageId;
}

function appendNestedAssistant(
	message: Extract<SDKMessage, { type: "assistant" }>,
	output: AssistantMessage,
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
		responseId: message.message.id,
		content,
		usage: createEmptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
	void state.publish(committed, undefined, false);
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
	return commitOutputBlocks(blocks, output, state);
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
	if (commitOutputBlocks(blocks, output, state)) refreshOutput(output, stream);
}

function commitOutputBlocks(blocks: SdkOutputBlock[], output: AssistantMessage, state: SdkOutputState): boolean {
	const active = blocks.filter((block) => output.content.includes(block.content));
	if (active.length === 0) return false;
	const members = active.map((block) => block.content).filter(visibleBlock);
	const committedContent = members.map((content) => ({ ...content }));
	if (committedContent.length > 0) {
		const committed: AssistantMessage = {
			...output,
			content: committedContent,
			usage: createEmptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		void state.publish(committed, members);
	}
	return removeOutputBlocks(active, output);
}

function visibleBlock(content: AssistantMessage["content"][number]): boolean {
	return (
		(content.type === "text" && content.text.trim().length > 0) ||
		(content.type === "thinking" && (content.redacted === true || content.thinking.trim().length > 0))
	);
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
	const raw = message.message.usage as (typeof message.message.usage & ExtendedSdkUsage) | undefined;
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
	if (message.message.model) state.servedModel = message.message.model;
	calculateCost(pricedAs(model, state.servedModel), request);

	state.requests.set(message.message.id, request);
	// The first request of the loop is the only one that met the cache as the
	// previous turn left it; requests 2..N re-read what it warmed. Frames without a
	// prompt say nothing about the cache, so wait for one that has one.
	if (!state.entryPrompt && request.input + request.cacheRead + request.cacheWrite > 0) {
		state.entryPrompt = { input: request.input, cacheRead: request.cacheRead, cacheWrite: request.cacheWrite };
	}
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
	aggregate.entryPrompt = state.entryPrompt;
	output.usage = aggregate;
	return true;
}

function requestContext(raw: Extract<SDKMessage, { type: "assistant" }>["message"]["usage"]): number {
	const extended = raw as typeof raw & ExtendedSdkUsage;
	const usage = extended.iterations?.at(-1) ?? extended;
	return (
		usage.input_tokens +
		usage.output_tokens +
		(usage.cache_read_input_tokens ?? 0) +
		(usage.cache_creation_input_tokens ?? 0)
	);
}

function usageFromResult(
	result: SDKResultMessage,
	model: Model<any>,
	state: SdkOutputState,
	session: SdkSession,
): Usage {
	const usage = createEmptyUsage();
	// result.usage aggregates the main conversation loop; modelUsage[0] can be an
	// internal helper model (e.g. Haiku) and badly under-reports the turn.
	usage.input = result.usage.input_tokens;
	usage.output = result.usage.output_tokens;
	usage.cacheRead = result.usage.cache_read_input_tokens ?? 0;
	usage.cacheWrite = result.usage.cache_creation_input_tokens ?? 0;
	usage.cacheWrite1h = result.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
	const resultUsage = result.usage as typeof result.usage & ExtendedSdkUsage;
	usage.reasoning = resultUsage.output_tokens_details?.thinking_tokens;
	usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	usage.contextTokens = state.contextTokens;
	usage.entryPrompt = state.entryPrompt;
	calculateCost(pricedAs(model, state.servedModel), usage);
	// The SDK's spend covers helper and subagent models this loop's tokens cannot
	// see. Scale the buckets onto it so the breakdown and the total describe the
	// same dollars. Without a reported spend, the token price stands.
	const spend = turnSpend(session, result);
	if (spend <= 0) return usage;
	const computed = usage.cost.total;
	if (computed > 0) {
		const multiplier = spend / computed;
		usage.cost.input *= multiplier;
		usage.cost.output *= multiplier;
		usage.cost.cacheRead *= multiplier;
		usage.cost.cacheWrite *= multiplier;
	}
	usage.cost.total = spend;
	return usage;
}

/**
 * Each result carries the process's running per-model spend (`total_cost_usd` is its sum), so a turn costs the
 * excess over the previous result. A model whose spend went backwards means the SDK restarted its count (/clear,
 * or a zeroed crash result), so the whole report belongs to this turn.
 */
function turnSpend(session: SdkSession, result: SDKResultMessage): number {
	const current = result.modelUsage ?? {};
	const restarted = Object.entries(session.spent).some(([id, usage]) => (current[id]?.costUSD ?? 0) < usage.costUSD);
	const baseline = restarted ? {} : session.spent;
	session.spent = current;
	return Object.entries(current).reduce(
		(spend, [id, usage]) => spend + usage.costUSD - (baseline[id]?.costUSD ?? 0),
		0,
	);
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

export function isClaudeAgentSdkModel(model: Model<any>): boolean {
	return model.api === CLAUDE_AGENT_SDK_API;
}
