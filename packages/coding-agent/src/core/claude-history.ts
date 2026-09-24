import { isDeepStrictEqual } from "node:util";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { z } from "zod/v4";
import { bindCheckpoint, type ClaudeCheckpoint, type ClaudePrefix } from "./claude-checkpoints.ts";
import type { ClaudeStore } from "./claude-store.ts";

type Commit = AssistantMessage | ToolResultMessage;
interface Boundary {
	message: Commit;
	tools: number;
	stamp: Pick<ClaudeCheckpoint, "responseId" | "count" | "hash">;
}
interface Source {
	sessionId: string;
	cursor: string;
	members: readonly object[];
}
interface Call {
	position: number;
	responseId: string;
	result?: number;
}

/** Certifies successive native intervals against acknowledged canonical positions. */
export class ClaudeHistory {
	private store: ClaudeStore;
	private prefix: ClaudePrefix;
	private options: { cursor?: string; signal?: AbortSignal; fail?: (error: Error) => void };
	private calls = new Map<string, Call>();
	private batches = new Map<string, ReadonlySet<string>>();
	private stopped = new Set<string>();
	private pending: Boundary[] = [];
	private frames = new Map<string, Source>();
	private sources = new WeakMap<object, Source>();
	private members = new WeakMap<object, { position: number; snapshot: object }>();
	private segments = new Map<Boundary, readonly object[]>();
	private tail = Promise.resolve();
	private failure?: Error;
	private children = false;
	private count = 0;
	private tools = 0;
	private certifiedTools = 0;
	private nativeResults = new Set<string>();
	private cursor?: string;
	private lastResult?: { sessionId: string; cursor: string };

	constructor(store: ClaudeStore, prefix: ClaudePrefix, options: ClaudeHistory["options"] = {}) {
		this.store = store;
		this.prefix = prefix;
		this.options = options;
		this.cursor = options.cursor;
	}

	record(message: Commit, members?: readonly object[], receipt = Promise.resolve()): void {
		this.prefix.add(message);
		const boundary: Boundary = { message, tools: this.tools, stamp: this.prefix.stamp(message) };
		if (message.role === "assistant") {
			for (const block of message.content)
				if (block.type === "toolCall") {
					if (this.calls.has(block.id)) throw new Error("Duplicate canonical native call");
					this.calls.set(block.id, { position: boundary.stamp.count, responseId: boundary.stamp.responseId });
					boundary.tools = ++this.tools;
				}
		} else {
			const call = this.calls.get(message.toolCallId);
			if (!call || call.result !== undefined) throw new Error("Unmatched canonical native result");
			call.result = boundary.stamp.count;
			this.pending.push(boundary);
		}
		// Catch immediately, even while an earlier native interval is still awaiting its mirror.
		void receipt.catch((error: unknown) => this.fail(error));
		this.track(() => receipt);
		if (members?.length) {
			for (const member of members)
				this.members.set(member, { position: boundary.stamp.count, snapshot: structuredClone(member) });
			this.segments.set(boundary, members);
			this.bindSegments();
		}
	}

	child(): void {
		this.children = true;
	}

	observe(sessionId: string, cursor: string, members: readonly object[]): void {
		const source: Source = { sessionId, cursor, members };
		this.frames.set(cursor, source);
		for (const member of members) this.sources.set(member, source);
		this.bindSegments();
	}

	/** A batch is closed only when both PostToolBatch and message_stop have arrived. */
	seal(ids: readonly string[]): void {
		const batch = new Set(ids);
		for (const id of batch) {
			const previous = this.batches.get(id);
			if (previous && !isDeepStrictEqual(previous, batch)) throw new Error("Conflicting native batch identity");
			this.batches.set(id, batch);
		}
		if (this.lastResult) this.result(this.lastResult.sessionId, this.lastResult.cursor);
	}

	stop(responseId: string): void {
		this.stopped.add(responseId);
		if (this.lastResult) this.result(this.lastResult.sessionId, this.lastResult.cursor);
	}

	result(sessionId: string, cursor: string, ids: readonly string[] = []): void {
		for (const id of ids) this.nativeResults.add(id);
		this.lastResult = { sessionId, cursor };
		const boundary = this.pending.at(-1);
		if (boundary && boundary.tools - this.certifiedTools === this.nativeResults.size)
			this.track(() => this.bind(boundary, sessionId, cursor));
	}

	private fail(error: unknown): void {
		if (this.failure) return;
		this.failure = error instanceof Error ? error : new Error(String(error));
		this.options.fail?.(this.failure);
	}

	private track(work: () => Promise<unknown>): void {
		this.tail = this.tail
			.then(async () => {
				if (!this.failure) await work();
			})
			.catch((error: unknown) => this.fail(error));
	}

	private bindSegments(): void {
		for (const [boundary, members] of this.segments) {
			if (!members.every((member) => this.sources.has(member))) continue;
			const sources = members.map((member) => this.sources.get(member)!);
			if (
				!sources.every((source) =>
					source.members.every(
						(member) => (this.members.get(member)?.position ?? Infinity) <= boundary.stamp.count,
					),
				)
			)
				continue;
			this.segments.delete(boundary);
			if (!isDeepStrictEqual(boundary.message.content, members)) continue;
			const source = sources.at(-1)!;
			this.track(() => this.bind(boundary, source.sessionId, source.cursor));
		}
	}

	async flush(): Promise<void> {
		await this.tail;
		if (this.failure) throw this.failure;
	}

	async finish(message: AssistantMessage, sessionId: string, cursor: string): Promise<ClaudeCheckpoint> {
		await this.flush();
		if (this.children) throw new Error("Native child checkpoints are not implemented; exact continuation refused");
		if (message.content.some((member) => !this.sources.has(member)))
			throw new Error("Assistant output has no authoritative native frame; exact continuation refused");
		this.prefix.add(message);
		const stamp = this.prefix.stamp(message);
		for (const member of message.content)
			this.members.set(member, { position: stamp.count, snapshot: structuredClone(member) });
		const checkpoint = await this.bind({ message, stamp, tools: this.tools }, sessionId, cursor);
		if (!checkpoint) throw new Error("Canonical and native Claude histories differ; exact continuation refused");
		return checkpoint;
	}

	private complete(position: number): boolean {
		const checked = new Set<ReadonlySet<string>>();
		for (const [id, call] of this.calls) {
			if (call.position > position) continue;
			const batch = this.batches.get(id);
			if (call.result === undefined || call.result > position || !this.stopped.has(call.responseId) || !batch)
				return false;
			if (!checked.has(batch)) {
				checked.add(batch);
				for (const member of batch) if ((this.calls.get(member)?.position ?? Infinity) > position) return false;
			}
		}
		return true;
	}

	private async bind(boundary: Boundary, sessionId: string, cursor: string): Promise<ClaudeCheckpoint | undefined> {
		if (this.children || boundary.stamp.count <= this.count || !this.complete(boundary.stamp.count)) return undefined;
		const key = await this.store.wait(sessionId, cursor, this.options.signal);
		if (this.cursor && this.store.position(key, cursor) < this.store.position(key, this.cursor)) return undefined;
		const entries = this.store.prefix(key, cursor, this.cursor);
		const calls = new Set<string>();
		const results = new Set<string>();
		for (const entry of entries) {
			if (entry.isSidechain) throw new Error("Native child coverage requires independent cuts");
			if (
				entry.type === "assistant" &&
				!this.frames.get(entry.uuid ?? "")?.members.every((member) => {
					const canonical = this.members.get(member);
					return (
						canonical !== undefined &&
						canonical.position <= boundary.stamp.count &&
						isDeepStrictEqual(canonical.snapshot, member)
					);
				})
			)
				return undefined;
			const parsed = nativeMessage.safeParse(entry.message);
			for (const block of parsed.success ? parsed.data.content : []) {
				if (block.type === "tool_use" && block.id) calls.add(block.id);
				if (block.type === "tool_result" && block.tool_use_id) results.add(block.tool_use_id);
			}
		}
		for (const [id, call] of this.calls) {
			if (call.position > boundary.stamp.count) continue;
			if (!calls.delete(id) || !results.delete(id)) return undefined;
		}
		if (calls.size || results.size) return undefined;
		if (this.failure) throw this.failure;
		const checkpoint = await bindCheckpoint(this.store, boundary.stamp, sessionId, cursor, this.options.signal);
		this.cursor = cursor;
		this.count = boundary.stamp.count;
		this.certifiedTools = boundary.tools;
		for (const [id, call] of this.calls)
			if (call.position <= this.count) {
				this.calls.delete(id);
				this.batches.delete(id);
				this.nativeResults.delete(id);
			}
		this.pending = this.pending.filter((entry) => entry.stamp.count > this.count);
		for (const entry of entries) if (entry.uuid) this.frames.delete(entry.uuid);
		return checkpoint;
	}
}

const nativeMessage = z.object({
	content: z.array(z.looseObject({ type: z.string(), id: z.string().optional(), tool_use_id: z.string().optional() })),
});
