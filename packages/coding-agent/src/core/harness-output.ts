import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";

/** Harness-only commit receipts. The shared provider EventStream is unchanged. */
export class HarnessOutput extends EventStream<AssistantMessageEvent, AssistantMessage> {
	private closed = false;
	private tools = new Set<string>();
	private termination?: { event: AssistantMessageEvent } | { result?: AssistantMessage };
	private pending = new Set<(error?: unknown) => void>();
	private signal?: AbortSignal;
	private abort = () => this.close(new Error("Harness invocation aborted"));

	constructor(signal?: AbortSignal) {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected harness terminal event");
			},
		);
		this.signal = signal;
		if (signal?.aborted) this.abort();
		else signal?.addEventListener("abort", this.abort, { once: true });
	}

	commit(message: AssistantMessage | ToolResultMessage, alreadyStreamed = false): Promise<void> {
		if (this.closed) return Promise.reject(new Error("Harness output is closed"));
		return new Promise((resolve, reject) => {
			const acknowledge = (error?: unknown) => {
				if (!this.pending.delete(acknowledge)) return;
				if (error !== undefined) reject(error);
				else resolve();
			};
			this.pending.add(acknowledge);
			this.push({ type: "assistant_message_commit", message, alreadyStreamed, acknowledge });
		});
	}

	override push(event: AssistantMessageEvent): void {
		if (event.type === "done" || event.type === "error") {
			this.close();
			this.termination ??= { event };
			this.flush();
			return;
		}
		if (event.type === "tool_execution_start") this.tools.add(event.toolCallId);
		if (event.type === "tool_execution_end") this.tools.delete(event.toolCallId);
		super.push(event);
		this.flush();
	}

	override end(result?: AssistantMessage): void {
		this.close();
		this.termination ??= { result };
		this.flush();
	}

	/** A provider can finish before cancelled tools finish unwinding. Drain their lifecycle first. */
	private flush(): void {
		if (this.tools.size || !this.termination) return;
		if ("event" in this.termination) super.push(this.termination.event);
		else super.end(this.termination.result);
	}

	override async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
		const source = super[Symbol.asyncIterator]();
		try {
			while (true) {
				const next = await source.next();
				if (next.done) return;
				const event = next.value;
				yield event;
				if (event.type === "assistant_message_commit")
					event.acknowledge?.(new Error("Harness consumer advanced without acknowledging the commit"));
			}
		} finally {
			this.close();
			await source.return?.();
		}
	}

	private close(error = new Error("Harness output closed before commit acknowledgement")): void {
		this.closed = true;
		this.signal?.removeEventListener("abort", this.abort);
		for (const acknowledge of this.pending) acknowledge(error);
	}
}
