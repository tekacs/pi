import type { Model } from "../src/types.ts";

export const model: Model<"openai-codex-responses"> = {
	id: "example",
	name: "Example",
	provider: "example",
	api: "openai-codex-responses",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
	contextWindow: 100000,
	maxTokens: 1000,
	compat: { preparation: "connection" },
};

export function token(nonce = 1): string {
	return `header.${Buffer.from(JSON.stringify({ nonce, "https://api.openai.com/auth": { chatgpt_account_id: "example" } })).toString("base64url")}.signature`;
}

export function barrier() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

export class Socket extends EventTarget {
	static instances: Socket[] = [];
	static onSend: ((socket: Socket, request: Record<string, unknown>) => void) | undefined;
	readyState = 1;
	requests: Record<string, unknown>[] = [];
	constructor(_url: string, _options: unknown) {
		super();
		Socket.instances.push(this);
		queueMicrotask(() => this.dispatchEvent(new Event("open")));
	}
	send(data: string): void {
		const request = JSON.parse(data) as Record<string, unknown>;
		this.requests.push(request);
		queueMicrotask(() => (Socket.onSend ? Socket.onSend(this, request) : this.complete()));
	}
	emit(event: unknown): void {
		this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
	}
	complete(response: Record<string, unknown> = {}): void {
		this.emit({
			type: "response.completed",
			response: {
				id: `response-${this.requests.length}`,
				status: "completed",
				output: [],
				usage: {
					input_tokens: 1,
					output_tokens: 0,
					total_tokens: 1,
					input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
				},
				...response,
			},
		});
	}
	close(): void {
		this.readyState = 3;
		this.dispatchEvent(new Event("close"));
	}
	static reset(): void {
		Socket.instances = [];
		Socket.onSend = undefined;
	}
}
