import { randomUUID } from "node:crypto";
import type {
	HookCallback,
	Options,
	Query,
	SDKMessage,
	SDKUserMessage,
	SessionStore,
} from "@anthropic-ai/claude-agent-sdk";
import { vi } from "vitest";

export interface MockServer {
	tools: Array<{
		name: string;
		inputSchema: Record<string, { safeParse: (value: unknown) => { success: boolean } }>;
		handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
	}>;
}
export interface QueryInput {
	prompt: AsyncIterable<SDKUserMessage>;
	options: {
		env: Record<string, string | undefined>;
		mcpServers: { pi: MockServer };
		forwardSubagentText: boolean;
		systemPrompt: Options["systemPrompt"];
		resume?: string;
		sessionStore: SessionStore;
		hooks: { PostToolBatch: { hooks: HookCallback[] }[] };
	};
}

/** Mirrors the SDK's independent transcript/result planes around renderer-focused fixtures. */
export function sdkQuery(messages: AsyncGenerator<SDKMessage>, options: QueryInput["options"], close = vi.fn()): Query {
	const sessionId = options.resume ?? randomUUID();
	const key = { projectKey: "fixture", sessionId };
	const results: Extract<SDKMessage, { type: "user" }>[] = [];
	const calls: { tool_name: string; tool_input: unknown; tool_use_id: string }[] = [];
	for (const tool of options.mcpServers.pi.tools) {
		const handler = tool.handler;
		tool.handler = async (args, extra) => {
			const result = await handler(args, extra);
			const id = (extra as { _meta: { "claudecode/toolUseId": string } })._meta["claudecode/toolUseId"];
			calls.push({ tool_name: `mcp__pi__${tool.name}`, tool_input: args, tool_use_id: id });
			results.push({
				type: "user",
				uuid: randomUUID(),
				session_id: sessionId,
				parent_tool_use_id: null,
				message: {
					role: "user",
					content: [{ type: "tool_result", tool_use_id: id, content: JSON.stringify(result) }],
				},
			});
			return result;
		};
	}
	async function* output(): AsyncGenerator<SDKMessage> {
		if (options.resume) await options.sessionStore.load(key);
		let active: string | undefined;
		let lastText = "";
		const queued = messages[Symbol.asyncIterator]();
		while (true) {
			const next = await queued.next();
			if (next.done) return;
			let message = { ...next.value, session_id: sessionId } as SDKMessage;
			if (results.length) {
				if (active) {
					yield {
						type: "stream_event",
						event: { type: "message_stop" },
						parent_tool_use_id: null,
						session_id: sessionId,
						uuid: randomUUID(),
					};
					active = undefined;
				}
				for (const matcher of options.hooks.PostToolBatch)
					for (const hook of matcher.hooks)
						await hook(
							{
								hook_event_name: "PostToolBatch",
								session_id: sessionId,
								cwd: "/fixture",
								transcript_path: "",
								tool_calls: calls.splice(0),
							},
							undefined,
							{ signal: new AbortController().signal },
						);
				for (const result of results.splice(0)) {
					await options.sessionStore.append(key, [result]);
					yield result;
				}
			}
			if (
				message.type === "result" &&
				message.subtype === "success" &&
				message.result &&
				message.result !== lastText
			) {
				// Real SDK success text also arrives as an authoritative assistant frame.
				const frame = {
					type: "assistant",
					uuid: randomUUID(),
					session_id: sessionId,
					parent_tool_use_id: null,
					message: {
						id: randomUUID(),
						content: [{ type: "text", text: message.result }],
						usage: { input_tokens: 0, output_tokens: 0 },
					},
				} as Extract<SDKMessage, { type: "assistant" }>;
				yield {
					type: "stream_event",
					event: { type: "message_start", message: frame.message },
					parent_tool_use_id: null,
					session_id: sessionId,
					uuid: randomUUID(),
				} as SDKMessage;
				active = frame.message.id;
				await options.sessionStore.append(key, [frame]);
				yield frame;
			}
			if (message.type === "result") {
				if (active)
					yield {
						type: "stream_event",
						event: { type: "message_stop" },
						parent_tool_use_id: null,
						session_id: sessionId,
						uuid: randomUUID(),
					};
				active = undefined;
				lastText = "";
			} else if (message.type === "assistant") {
				message = { ...message, uuid: message.uuid ?? randomUUID() };
				if (!message.parent_tool_use_id) {
					if (active !== message.message.id) {
						yield {
							type: "stream_event",
							event: { type: "message_start", message: message.message },
							parent_tool_use_id: null,
							session_id: sessionId,
							uuid: randomUUID(),
						} as SDKMessage;
						active = message.message.id;
					}
					lastText = message.message.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("");
					await options.sessionStore.append(key, [message]);
				}
			} else if (message.type === "stream_event") {
				if (message.event.type === "message_start") active = message.event.message.id;
				if (message.event.type === "message_stop") active = undefined;
			}
			yield message;
		}
	}
	return Object.assign(output(), { close, interrupt: vi.fn(async () => undefined) }) as unknown as Query;
}
