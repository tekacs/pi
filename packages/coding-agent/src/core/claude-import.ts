import { createHash, randomUUID } from "node:crypto";
import type { SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import type { Message, UserMessage } from "@earendil-works/pi-ai";
import { z } from "zod/v4";
import { CLAUDE_AGENT_SDK_API } from "./claude-agent-sdk-models.ts";
import { mcpName } from "./claude-calls.ts";
import { type ClaudeCheckpoint, type ClaudePrefix, readCheckpoint } from "./claude-checkpoints.ts";
import type { ClaudeStore } from "./claude-store.ts";

/** Empty failure shells remain in the canonical fingerprint but need no native input. */
export function displayOnly(message: Message): boolean {
	return (
		message.role === "assistant" &&
		message.content.length === 0 &&
		(message.stopReason === "error" || message.stopReason === "aborted")
	);
}

/** Exact native state is preferred; readable canonical history is always the recovery source. */
export function selectHistory(store: ClaudeStore, history: readonly Message[], prefix: ClaudePrefix) {
	const owners = new Map<string, boolean>();
	const candidates: { index: number; stamp: Pick<ClaudeCheckpoint, "responseId" | "count" | "hash"> }[] = [];
	let boundary = -1;
	for (const [index, message] of history.entries()) {
		prefix.add(message);
		if (displayOnly(message) || message.role === "user" || message.role === "system") continue;
		boundary = index;
		let native = false;
		if (message.role === "assistant") {
			native = message.api === CLAUDE_AGENT_SDK_API;
			for (const block of message.content) if (block.type === "toolCall") owners.set(block.id, native);
		} else native = owners.get(message.toolCallId) === true;
		if (native) {
			try {
				candidates.push({ index, stamp: prefix.stamp(message) });
			} catch {
				/* Old or interrupted messages may lack native identity. They are imported. */
			}
		}
	}
	for (const candidate of candidates.reverse()) {
		try {
			const checkpoint = readCheckpoint(store, candidate.stamp);
			if (checkpoint)
				return { checkpoint, count: boundary + 1, imported: history.slice(candidate.index + 1, boundary + 1) };
		} catch {
			/* Missing or damaged optional native metadata must not strand the conversation. */
		}
	}
	return { checkpoint: undefined, count: boundary + 1, imported: history.slice(0, boundary + 1) };
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

/** Reconstruct records, never execute historical calls or manufacture reasoning signatures. */
export function importHistory(history: readonly Message[], parent: string | null = null): SessionStoreEntry[] {
	const messages: ImportedMessage[] = [];
	const calls = new Map<string, { name: string; id: string }>();
	const ids = new Set<string>();
	const add = (role: ImportedMessage["role"], content: ImportedMessage["content"]) => {
		if (!content.length) return;
		const previous = messages.at(-1);
		if (previous?.role === role) previous.content.push(...content);
		else messages.push({ role, content });
	};
	const close = () => {
		for (const [original, call] of calls)
			add("user", [
				{
					type: "tool_result",
					tool_use_id: call.id,
					is_error: true,
					content: `Historical tool exchange interrupted; outcome unknown. Changes may already have occurred. Original call ID: ${original}. This closes only the conversation exchange, not the underlying operation. Do not automatically repeat it; inspect current state first.`,
				},
			]);
		calls.clear();
	};
	for (const message of history) {
		if (message.role === "system" || displayOnly(message)) continue;
		if (message.role === "user") {
			close();
			const content = userContent(message.content);
			add("user", typeof content === "string" ? [{ type: "text", text: content }] : content);
		} else if (message.role === "assistant") {
			// Split commits from one assistant response may precede its results. A new
			// assistant after any result ends that exchange, even when some calls lack outcomes.
			if (messages.at(-1)?.role === "user") close();
			const content: ImportedMessage["content"] = [];
			for (const block of message.content) {
				if (block.type === "text") content.push({ type: "text", text: block.text });
				else if (block.type === "thinking") {
					if (!block.redacted && block.thinking) content.push({ type: "text", text: block.thinking });
				} else {
					const normalized = /^[a-zA-Z0-9_-]{1,64}$/.test(block.id)
						? block.id
						: `pi_${createHash("sha256").update(block.id).digest("hex").slice(0, 60)}`;
					if (ids.has(normalized)) {
						content.push({
							type: "text",
							text: `Historical duplicate tool-call record (not an execution request): ${JSON.stringify(block)}`,
						});
						continue;
					}
					ids.add(normalized);
					calls.set(block.id, { id: normalized, name: block.name });
					content.push({
						type: "tool_use",
						id: normalized,
						name: `mcp__pi__${mcpName(block.name)}`,
						input: block.arguments,
					});
				}
			}
			if (message.stopReason === "error" || message.stopReason === "aborted")
				content.push({
					type: "text",
					text: `[Historical assistant response ${message.stopReason}; the preceding content may be incomplete.]`,
				});
			add("assistant", content);
		} else {
			const call = calls.get(message.toolCallId);
			if (!call || call.name !== message.toolName) {
				close();
				const content = userContent(message.content);
				add("user", [
					{
						type: "text",
						text: `Historical unpaired tool result: ${message.toolName}, original call ID ${message.toolCallId}, error=${message.isError}. Retained as evidence, not an execution request.`,
					},
					...(typeof content === "string" ? [{ type: "text", text: content }] : content),
				]);
				continue;
			}
			calls.delete(message.toolCallId);
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
	close();
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
