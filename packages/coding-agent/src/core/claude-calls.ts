import { isDeepStrictEqual } from "node:util";
import type { SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";

interface NativeCall {
	id: string;
	responseId: string;
	name: string;
	input: unknown;
}

/** MCP dispatch may overtake transcript consumption; native IDs join the two paths. */
export class ClaudeCalls {
	private observed = new Map<string, NativeCall>();
	private waiting = new Map<string, { resolve: (call: NativeCall) => void; reject: (error: Error) => void }[]>();
	private failure?: Error;
	private outcomes = new Map<string, boolean>();

	observe(frame: SDKAssistantMessage): void {
		for (const block of frame.message.content) {
			if (block.type !== "tool_use") continue;
			const previous = this.observed.get(block.id);
			if (!frame.message.id) throw new Error("Native call has no API response identity");
			if (
				previous &&
				(previous.responseId !== frame.message.id ||
					previous.name !== block.name ||
					!isDeepStrictEqual(previous.input, block.input))
			)
				throw new Error(`Conflicting native call identity ${block.id}`);
			const call = { id: block.id, responseId: frame.message.id, name: block.name, input: block.input };
			this.observed.set(call.id, call);
			for (const waiter of this.waiting.get(call.id) ?? []) waiter.resolve(call);
			this.waiting.delete(call.id);
		}
	}

	wait(id: string): Promise<NativeCall> {
		if (this.failure) return Promise.reject(this.failure);
		const call = this.observed.get(id);
		if (call) return Promise.resolve(call);
		return new Promise((resolve, reject) => {
			const waiting = this.waiting.get(id) ?? [];
			waiting.push({ resolve, reject });
			this.waiting.set(id, waiting);
		});
	}

	complete(id: string, terminate: boolean): void {
		this.outcomes.set(id, terminate);
	}

	terminates(ids: readonly string[]): boolean {
		return ids.length > 0 && ids.every((id) => this.outcomes.get(id) === true);
	}

	finish(): void {
		if (this.waiting.size) throw new Error("Claude ended before MCP requests matched native call frames");
	}

	close(): void {
		this.failure = new Error("Claude invocation closed before its native call frame arrived");
		for (const waiting of this.waiting.values()) for (const waiter of waiting) waiter.reject(this.failure);
		this.waiting.clear();
	}
}
