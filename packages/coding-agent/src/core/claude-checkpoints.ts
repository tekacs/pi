import { createHash, type Hash } from "node:crypto";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { z } from "zod/v4";
import type { ClaudeStore } from "./claude-store.ts";

const format = z.object({
	version: z.literal(1),
	responseId: z.string().min(1),
	count: z.number().int().positive(),
	hash: z.string().regex(/^[a-f0-9]{64}$/),
	key: z.object({ projectKey: z.string().min(1), sessionId: z.string().min(1) }),
	cursor: z.string().min(1),
});
export type ClaudeCheckpoint = z.infer<typeof format>;

/** Incremental fingerprint of model-visible history; native response IDs supply identity. */
export class ClaudePrefix {
	private digest: Hash = createHash("sha256");
	private size = 0;
	private calls = new Map<string, string>();

	constructor(messages: readonly Message[]) {
		for (const message of messages) this.add(message);
	}

	add(message: Message): void {
		if (message.role === "system") return;
		const identity =
			message.role === "assistant"
				? {
						api: message.api,
						provider: message.provider,
						model: message.model,
						responseId: message.responseId,
						stopReason: message.stopReason,
					}
				: message.role === "toolResult"
					? {
							toolCallId: message.toolCallId,
							toolName: message.toolName,
							isError: message.isError,
							terminate: message.terminate,
						}
					: {};
		this.digest
			.update(
				JSON.stringify({ role: message.role, content: message.content, timestamp: message.timestamp, ...identity }),
			)
			.update("\n");
		this.size++;
		if (message.role === "assistant" && message.responseId) {
			for (const block of message.content)
				if (block.type === "toolCall") this.calls.set(block.id, message.responseId);
		}
	}

	stamp(message: AssistantMessage | ToolResultMessage): Pick<ClaudeCheckpoint, "responseId" | "count" | "hash"> {
		const responseId = message.role === "assistant" ? message.responseId : this.calls.get(message.toolCallId);
		if (!responseId) throw new Error("Canonical history has no native response identity; exact continuation refused");
		return { responseId, count: this.size, hash: this.digest.copy().digest("hex") };
	}
}

export function checkpointId(stamp: Pick<ClaudeCheckpoint, "responseId" | "hash">): string {
	return JSON.stringify([stamp.responseId, stamp.hash]);
}

export function selectCheckpoint(
	store: ClaudeStore,
	messages: readonly Message[],
	prefix = new ClaudePrefix([]),
): ClaudeCheckpoint | undefined {
	const history = messages.filter((message) => message.role !== "system");
	let boundary = history.length - 1;
	while (boundary >= 0 && history[boundary].role === "user") boundary--;
	for (const message of history.slice(0, boundary + 1)) prefix.add(message);
	if (boundary < 0) {
		for (const message of history) prefix.add(message);
		return undefined;
	}
	const message = history[boundary];
	if (message.role !== "assistant" && message.role !== "toolResult")
		throw new Error("Invalid native continuation boundary");
	const stamp = prefix.stamp(message);
	const checkpoint = readCheckpoint(store, stamp);
	if (!checkpoint) throw new Error("No exact native checkpoint for this boundary; text replay was not attempted");
	for (const message of history.slice(boundary + 1)) prefix.add(message);
	return checkpoint;
}

export function readCheckpoint(
	store: ClaudeStore,
	stamp: Pick<ClaudeCheckpoint, "responseId" | "count" | "hash">,
): ClaudeCheckpoint | undefined {
	const stored = store.binding(checkpointId(stamp));
	if (stored === undefined) return undefined;
	const checkpoint = format.parse(stored);
	if (checkpoint.hash !== stamp.hash || checkpoint.responseId !== stamp.responseId || checkpoint.count !== stamp.count)
		throw new Error("Native checkpoint does not match canonical history");
	return checkpoint;
}

export async function bindCheckpoint(
	store: ClaudeStore,
	stamp: Pick<ClaudeCheckpoint, "responseId" | "count" | "hash">,
	sessionId: string,
	cursor: string,
	signal?: AbortSignal,
): Promise<ClaudeCheckpoint> {
	const key = await store.wait(sessionId, cursor, signal);
	const checkpoint = format.parse({ version: 1, ...stamp, key, cursor });
	store.bind(checkpointId(stamp), checkpoint);
	return checkpoint;
}
