import { createHash, randomUUID } from "node:crypto";
import type { SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import type { Message, UserMessage } from "@earendil-works/pi-ai";
import { z } from "zod/v4";
import { CLAUDE_AGENT_SDK_API } from "./claude-agent-sdk-models.ts";
import { mcpName } from "./claude-calls.ts";
import { type ClaudePrefix, selectCheckpoint } from "./claude-checkpoints.ts";
import type { ClaudeStore } from "./claude-store.ts";

/** Failed entry attempts carry no native state and must not prevent retrying a provider switch. */
export function emptyAttempt(message: Message): boolean {
	return (
		message.role === "assistant" &&
		!message.responseId &&
		message.content.length === 0 &&
		(message.stopReason === "error" || message.stopReason === "aborted")
	);
}

/** Native history remains strict; only explicitly foreign history takes the import path. */
export function selectHistory(store: ClaudeStore, history: readonly Message[], prefix: ClaudePrefix) {
	const owners = new Map<string, boolean>();
	let native = -1;
	let boundary = -1;
	for (const [index, message] of history.entries()) {
		if (emptyAttempt(message) || message.role === "user" || message.role === "system") continue;
		let own: boolean;
		if (message.role === "assistant") {
			own = message.api === CLAUDE_AGENT_SDK_API;
			for (const block of message.content) if (block.type === "toolCall") owners.set(block.id, own);
		} else {
			const owner = owners.get(message.toolCallId);
			if (owner === undefined) throw new Error("Cannot import a tool result without its canonical call");
			own = owner;
		}
		boundary = index;
		if (own) native = index;
	}
	const checkpoint = selectCheckpoint(store, history.slice(0, native + 1), prefix);
	for (const message of history.slice(native + 1)) prefix.add(message);
	return { checkpoint, count: boundary + 1, imported: history.slice(native + 1, boundary + 1) };
}

type Content = Exclude<UserMessage["content"], string>;
export function userContent(content: string | Content) {
	if (typeof content === "string") return content;
	return content.map((block) =>
		block.type === "text"
			? { type: "text" as const, text: block.text }
			: {
					type: "image" as const,
					source: {
						type: "base64" as const,
						data: block.data,
						media_type: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]).parse(block.mimeType),
					},
				},
	);
}

interface ImportedMessage {
	role: "user" | "assistant";
	content: Record<string, unknown>[];
}

/** Import public canonical content, never manufacture native reasoning signatures or execute old calls. */
export function importHistory(history: readonly Message[], parent: string | null = null): SessionStoreEntry[] {
	const messages: ImportedMessage[] = [];
	const calls = new Map<string, { name: string; id: string; complete: boolean }>();
	const ids = new Set<string>();
	let outstanding = 0;
	const add = (role: ImportedMessage["role"], content: ImportedMessage["content"]) => {
		if (!content.length) return;
		const previous = messages.at(-1);
		if (previous?.role === role) previous.content.push(...content);
		else messages.push({ role, content });
	};
	for (const message of history) {
		if (message.role === "system" || emptyAttempt(message)) continue;
		if (message.role === "user") {
			if (outstanding) throw new Error("Cannot import unresolved tool effects across a user boundary");
			const content = userContent(message.content);
			add("user", typeof content === "string" ? [{ type: "text", text: content }] : content);
		} else if (message.role === "assistant") {
			if (outstanding && messages.at(-1)?.role === "user")
				throw new Error("Cannot import an assistant response before its tool batch is complete");
			if (message.api === CLAUDE_AGENT_SDK_API)
				throw new Error("Native Claude history requires its checkpoint, not import");
			if (message.stopReason === "error" || message.stopReason === "aborted")
				throw new Error("Cannot import an incomplete foreign assistant response");
			const content: ImportedMessage["content"] = [];
			for (const block of message.content) {
				if (block.type === "text") content.push({ type: "text", text: block.text });
				else if (block.type === "thinking") {
					if (!block.redacted && block.thinking) content.push({ type: "text", text: block.thinking });
				} else {
					if (calls.has(block.id)) throw new Error("Cannot import duplicate tool call identities");
					const id = /^[a-zA-Z0-9_-]{1,64}$/.test(block.id)
						? block.id
						: `pi_${createHash("sha256").update(block.id).digest("hex").slice(0, 60)}`;
					if (ids.has(id)) throw new Error("Imported tool identities collide after normalization");
					ids.add(id);
					calls.set(block.id, { id, name: block.name, complete: false });
					outstanding++;
					content.push({ type: "tool_use", id, name: `mcp__pi__${mcpName(block.name)}`, input: block.arguments });
				}
			}
			add("assistant", content);
		} else {
			const call = calls.get(message.toolCallId);
			if (!call || call.complete || call.name !== message.toolName)
				throw new Error("Cannot import an unmatched or duplicate tool result");
			call.complete = true;
			outstanding--;
			add("user", [
				{
					type: "tool_result",
					tool_use_id: call.id,
					content: userContent(message.content),
					is_error: message.isError,
				},
			]);
		}
	}
	if (outstanding) throw new Error("Cannot import unresolved tool effects; execution refused");
	return messages.map((message): SessionStoreEntry => {
		const uuid = randomUUID();
		const entry = {
			type: message.role,
			uuid,
			parentUuid: parent,
			isSidechain: false,
			timestamp: new Date().toISOString(),
			message:
				message.role === "assistant"
					? {
							...message,
							id: `pi-import-${uuid}`,
							type: "message",
							model: "imported",
							stop_reason: message.content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
							stop_sequence: null,
							usage: { input_tokens: 0, output_tokens: 0 },
						}
					: message,
		};
		parent = uuid;
		return entry;
	});
}
