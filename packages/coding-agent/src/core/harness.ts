import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Agent, AgentContext, AgentTool, AgentToolCall, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type AuthResult,
	type JsonObject,
	type JsonValue,
	type Model,
	type SimpleStreamOptions,
	type ToolResultMessage,
	type TranscriptContext,
	validateToolArguments,
} from "@earendil-works/pi-ai";
import type { HarnessOutput } from "./harness-output.ts";
import type { ReadonlySessionManager } from "./session-manager.ts";

const claims = new WeakMap<AgentContext, Set<string>>();

/** One Pi tool invocation requested by an embedded-agent harness. */
export interface HarnessToolCall {
	tool: AgentTool;
	args: unknown;
	/** Preserve the vendor call id when one exists; otherwise Pi generates one. */
	callId?: string;
	/** The harness response stream that owns commit receipts and execution events. */
	stream: HarnessOutput;
}

/** Result returned to the embedded runtime after Pi has executed a tool. */
export interface HarnessToolResult {
	result: AgentToolResult<unknown>;
	isError: boolean;
}

export type HarnessToolRunner = (call: HarnessToolCall) => Promise<HarnessToolResult>;

/** Live Pi host state supplied to a registered embedded-agent harness. */
export interface HarnessStreamOptions extends SimpleStreamOptions {
	auth: AuthResult;
	cwd: string;
	/** Current prompt replayed from the transformed request transcript. */
	systemPrompt: string;
	tools: readonly AgentTool[];
	agentContext: AgentContext;
	/** Existing canonical identities and branch ancestry; native metadata stays harness-owned. */
	session: ReadonlySessionManager;
	/** Bound executor carrying Pi's argument, hook, cancellation, update, and event semantics. */
	runTool: HarnessToolRunner;
}

export type HarnessStream = (
	model: Model<Api>,
	context: TranscriptContext,
	options: HarnessStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

export interface AgentToolRunOptions {
	model: Model<Api>;
	context: AgentContext;
	stream: HarnessOutput;
	/** Provider binding around an acknowledged canonical commit. */
	commit?: (message: AssistantMessage | ToolResultMessage) => Promise<void>;
	signal?: AbortSignal;
	callId?: string;
	idPrefix?: string;
	beforeToolCall?: Agent["beforeToolCall"];
	afterToolCall?: Agent["afterToolCall"];
}

/**
 * Execute one vendor-requested tool with the same shell Pi's ordinary agent loop applies.
 *
 * Calls persist before execution; outcomes persist before native delivery. Original call IDs
 * are retained. Completed outcomes are reusable; unresolved effects never execute automatically.
 */
export async function runAgentTool(
	tool: AgentTool,
	rawArgs: unknown,
	options: AgentToolRunOptions,
): Promise<HarnessToolResult> {
	const callId = options.callId ?? `${options.idPrefix ?? "harness"}-${randomUUID()}`;
	const previous = options.context.messages
		.flatMap((message) => (message.role === "assistant" ? message.content : []))
		.find((block) => block.type === "toolCall" && block.id === callId);
	if (previous?.type === "toolCall") {
		if (previous.name !== tool.name || !isDeepStrictEqual(previous.arguments, rawArgs))
			throw new Error(`Harness call ${callId} was reused with different arguments`);
		const recorded = options.context.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === callId,
		);
		if (recorded?.role !== "toolResult")
			throw new Error(`Harness call ${callId} has an unresolved outcome; execution refused`);
		return {
			result: {
				content: recorded.content,
				details: recorded.details,
				usage: recorded.usage,
				terminate: recorded.terminate,
			},
			isError: recorded.isError,
		};
	}
	const claimed = claims.get(options.context) ?? new Set<string>();
	if (claimed.has(callId)) throw new Error(`Harness call ${callId} is already claimed`);
	claimed.add(callId);
	claims.set(options.context, claimed);
	const commit = options.commit ?? ((message: AssistantMessage | ToolResultMessage) => options.stream.commit(message));
	const toolCall: AgentToolCall = {
		type: "toolCall",
		id: callId,
		name: tool.name,
		arguments: rawArgs as JsonObject,
	};
	const assistantMessage: AssistantMessage = {
		role: "assistant",
		content: [toolCall],
		api: options.model.api,
		provider: options.model.provider,
		model: options.model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};

	await commit(structuredClone(assistantMessage));
	options.stream.push({ type: "tool_execution_start", toolCallId: callId, toolName: tool.name, args: rawArgs });

	let result: AgentToolResult<unknown>;
	let isError = false;
	let preparedArgs: unknown;
	try {
		preparedArgs = tool.prepareArguments ? tool.prepareArguments(rawArgs) : rawArgs;
		preparedArgs = validateToolArguments(tool, { ...toolCall, arguments: preparedArgs as JsonObject });

		const beforeResult = await options.beforeToolCall?.(
			{ assistantMessage, toolCall, args: preparedArgs, context: options.context },
			options.signal,
		);
		if (options.signal?.aborted) throw new Error("Operation aborted");
		if (beforeResult?.block) {
			result = errorResult(beforeResult.reason || "Tool execution was blocked");
			if (beforeResult.terminate === true) result.terminate = true;
			isError = true;
		} else {
			let acceptingUpdates = true;
			try {
				result = await tool.execute(callId, preparedArgs as never, options.signal, (partialResult) => {
					if (!acceptingUpdates) return;
					options.stream.push({
						type: "tool_execution_update",
						toolCallId: callId,
						toolName: tool.name,
						args: rawArgs,
						partialResult,
					});
				});
			} catch (error) {
				result = errorResult(error instanceof Error ? error.message : String(error));
				isError = true;
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
					context: options.context,
				},
				options.signal,
			);
			if (afterResult) {
				result = {
					...result,
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					usage: afterResult.usage ?? result.usage,
					terminate: afterResult.terminate ?? result.terminate,
				};
				isError = afterResult.isError ?? isError;
			}
		}
	} catch (error) {
		result = errorResult(error instanceof Error ? error.message : String(error));
		isError = true;
	}

	// Execution settlement is independent of transcript durability. In particular,
	// cancellation closes commit receipts but must still retire the live tool.
	options.stream.push({ type: "tool_execution_end", toolCallId: callId, toolName: tool.name, result, isError });
	await commit({
		role: "toolResult",
		toolCallId: callId,
		toolName: tool.name,
		content: structuredClone(result.content),
		details: structuredClone(result.details) as JsonValue,
		usage: result.usage,
		...(result.terminate !== undefined ? { terminate: result.terminate } : {}),
		isError,
		timestamp: Date.now(),
	});
	return { result, isError };
}

function errorResult(message: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: message }], details: {} };
}
