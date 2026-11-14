import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";

class FifoQueue<T> {
	private incoming: T[] = [];
	private outgoing: T[] = [];

	get length(): number {
		return this.incoming.length + this.outgoing.length;
	}

	enqueue(value: T): void {
		this.incoming.push(value);
	}

	dequeue(): T | undefined {
		if (this.outgoing.length === 0) {
			while (this.incoming.length > 0) {
				this.outgoing.push(this.incoming.pop()!);
			}
		}
		return this.outgoing.pop();
	}
}

// Generic event stream class for async iteration
export class EventStream<T, R = T> implements AsyncIterable<T> {
	private queue = new FifoQueue<T>();
	private waiting = new FifoQueue<(value: IteratorResult<T>) => void>();
	protected done = false;
	private finalResultPromise: Promise<R>;
	private resolveFinalResult!: (result: R) => void;
	private isComplete: (event: T) => boolean;
	private extractResult: (event: T) => R;

	constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
		this.isComplete = isComplete;
		this.extractResult = extractResult;
		this.finalResultPromise = new Promise((resolve) => {
			this.resolveFinalResult = resolve;
		});
	}

	push(event: T): void {
		if (this.done) return;

		if (this.isComplete(event)) {
			this.done = true;
			this.resolveFinalResult(this.extractResult(event));
		}

		// Deliver to waiting consumer or queue it
		const waiter = this.waiting.dequeue();
		if (waiter) {
			waiter({ value: event, done: false });
		} else {
			this.queue.enqueue(event);
		}
	}

	end(result?: R): void {
		this.done = true;
		if (result !== undefined) {
			this.resolveFinalResult(result);
		}
		// Notify all waiting consumers that we're done
		while (this.waiting.length > 0) {
			const waiter = this.waiting.dequeue()!;
			waiter({ value: undefined as any, done: true });
		}
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.queue.length > 0) {
				yield this.queue.dequeue()!;
			} else if (this.done) {
				return;
			} else {
				const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.enqueue(resolve));
				if (result.done) return;
				yield result.value;
			}
		}
	}

	result(): Promise<R> {
		return this.finalResultPromise;
	}
}

/**
 * Event stream of one assistant response. It also times the response: the final message (`done` or `error` event, or
 * the result passed to `end()`) gets `durationMs`, measured with a monotonic clock from the stream's creation, unless
 * the message already has one or its `timestamp` predates the stream. A stream that forwards a response which started
 * elsewhere, such as a deferred result fetched later, therefore leaves it untimed.
 */
interface TrackedItemTiming {
	startedAt: number;
	delayMs: number;
	endedAt?: number;
}

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	readonly #startedAt = Date.now();
	readonly #startedAtMonotonic = performance.now();
	#firstContentAtMonotonic?: number;
	#lastBoundaryAtMonotonic = this.#startedAtMonotonic;
	readonly #itemTimings = new Map<number, TrackedItemTiming>();

	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") {
					return event.message;
				} else if (event.type === "error") {
					return event.error;
				}
				throw new Error("Unexpected event type for final result");
			},
		);
	}

	override push(event: AssistantMessageEvent): void {
		if (!this.done) {
			switch (event.type) {
				case "text_start":
				case "text_delta":
				case "thinking_start":
				case "thinking_delta":
				case "toolcall_start":
				case "toolcall_delta":
					this.#recordItemStart(event.contentIndex);
					break;
				case "text_end":
				case "thinking_end":
				case "toolcall_end":
					this.#recordItemEnd(event.contentIndex);
					break;
				case "done":
					this.#time(event.message);
					break;
				case "error":
					this.#time(event.error);
					break;
			}
		}
		super.push(event);
	}

	override end(result?: AssistantMessage): void {
		if (result !== undefined) this.#time(result);
		super.end(result);
	}

	#recordItemStart(contentIndex: number): void {
		const now = performance.now();
		if (this.#firstContentAtMonotonic === undefined) {
			this.#firstContentAtMonotonic = now;
		}
		if (!this.#itemTimings.has(contentIndex)) {
			this.#itemTimings.set(contentIndex, {
				startedAt: now,
				delayMs: Math.max(0, Math.round(now - this.#lastBoundaryAtMonotonic)),
			});
		}
	}

	#recordItemEnd(contentIndex: number): void {
		const now = performance.now();
		if (this.#firstContentAtMonotonic === undefined) {
			this.#firstContentAtMonotonic = now;
		}
		let entry = this.#itemTimings.get(contentIndex);
		if (!entry) {
			entry = {
				startedAt: now,
				delayMs: Math.max(0, Math.round(now - this.#lastBoundaryAtMonotonic)),
				endedAt: now,
			};
			this.#itemTimings.set(contentIndex, entry);
		} else if (entry.endedAt === undefined) {
			entry.endedAt = now;
		}
		if (now > this.#lastBoundaryAtMonotonic) {
			this.#lastBoundaryAtMonotonic = now;
		}
	}

	#time(message: AssistantMessage): void {
		if (this.done || message.durationMs !== undefined || message.timestamp < this.#startedAt) return;
		const finishedAt = performance.now();
		message.durationMs = Math.max(0, Math.round(finishedAt - this.#startedAtMonotonic));
		if (this.#firstContentAtMonotonic !== undefined && message.ttftMs === undefined) {
			message.ttftMs = Math.max(0, Math.round(this.#firstContentAtMonotonic - this.#startedAtMonotonic));
		}
		if (this.#itemTimings.size > 0 && message.contentTimings === undefined && message.content.length > 0) {
			message.contentTimings = message.content.map((_block, index) => {
				const item = this.#itemTimings.get(index);
				if (!item) return { delayMs: 0, durationMs: 0 };
				const endedAt = item.endedAt ?? finishedAt;
				return {
					delayMs: item.delayMs,
					durationMs: Math.max(0, Math.round(endedAt - item.startedAt)),
				};
			});
		}
	}
}

/** Factory function for AssistantMessageEventStream (for use in extensions) */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}
