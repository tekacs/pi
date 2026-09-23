import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";

/** Harness-only commit receipts. The shared provider EventStream is unchanged. */
export class HarnessOutput extends EventStream<AssistantMessageEvent, AssistantMessage> {
	private closed = false;
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
		if (event.type === "done" || event.type === "error") this.close();
		super.push(event);
	}

	override end(result?: AssistantMessage): void {
		this.close();
		super.end(result);
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
