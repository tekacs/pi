import { randomUUID } from "node:crypto";
import type { Agent, AgentContext, AgentTool, AgentToolCall, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type AuthResult,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
	validateToolArguments,
} from "@earendil-works/pi-ai";

/** One Pi tool invocation requested by an embedded-agent harness. */
export interface HarnessToolCall {
	tool: AgentTool;
	args: unknown;
	/** Preserve the vendor call id when one exists; otherwise Pi generates one. */
	callId?: string;
	/** The harness response stream that receives tool execution lifecycle events. */
	stream: AssistantMessageEventStream;
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
	stream: AssistantMessageEventStream;
	signal?: AbortSignal;
	callId?: string;
	idPrefix?: string;
	beforeToolCall?: Agent["beforeToolCall"];
	afterToolCall?: Agent["afterToolCall"];
}

/**
 * Execute one vendor-requested tool with the same shell Pi's ordinary agent loop applies.
 *
 * The vendor's inner tool boundary remains private: this emits execution lifecycle events but no
 * assistant `toolCall` block or transcript `toolResult` message.
 */
export async function runAgentTool(
	tool: AgentTool,
	rawArgs: unknown,
	options: AgentToolRunOptions,
): Promise<HarnessToolResult> {
	const callId = options.callId ?? `${options.idPrefix ?? "harness"}-${randomUUID()}`;
	const toolCall: AgentToolCall = {
		type: "toolCall",
		id: callId,
		name: tool.name,
		arguments: rawArgs as Record<string, unknown>,
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

	options.stream.push({ type: "tool_execution_start", toolCallId: callId, toolName: tool.name, args: rawArgs });

	let result: AgentToolResult<unknown>;
	let isError = false;
	let preparedArgs: unknown;
	try {
		preparedArgs = tool.prepareArguments ? tool.prepareArguments(rawArgs) : rawArgs;
		preparedArgs = validateToolArguments(tool, { ...toolCall, arguments: preparedArgs as Record<string, unknown> });

		const beforeResult = await options.beforeToolCall?.(
			{ assistantMessage, toolCall, args: preparedArgs, context: options.context },
			options.signal,
		);
		if (options.signal?.aborted) throw new Error("Operation aborted");
		if (beforeResult?.block) {
			result = errorResult(beforeResult.reason || "Tool execution was blocked");
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

	options.stream.push({ type: "tool_execution_end", toolCallId: callId, toolName: tool.name, result, isError });
	return { result, isError };
}

function errorResult(message: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: message }], details: {} };
}
