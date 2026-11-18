import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_VERTEX_STREAM_STALL_TIMEOUT_MS,
	StreamStalledError,
	stream as streamGoogleVertex,
} from "../src/api/google-vertex.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";

const model = getModel("google-vertex", "gemini-3-flash-preview");
const context = normalizeContext({
	messages: [{ role: "user", content: "ping", timestamp: 1 }],
});
const encoder = new TextEncoder();

function sseEvent(payload: unknown): Uint8Array {
	return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("google-vertex SSE stream-stall watchdog", () => {
	it("defaults to 60 seconds and marks StreamStalledError as retryable", () => {
		expect(DEFAULT_VERTEX_STREAM_STALL_TIMEOUT_MS).toBe(60_000);
		const err = new StreamStalledError(60_000);
		expect(err.code).toBe("stream_stalled");
		expect(err.type).toBe("stream_stalled");
	});

	it("aborts a stalled mock ReadableStream with a retryable StreamStalledError", async () => {
		let capturedSignal: AbortSignal | undefined;
		let abortedBySignal = false;

		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			capturedSignal = init?.signal ?? undefined;
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						sseEvent({
							responseId: "resp-stall-1",
							candidates: [{ content: { parts: [{ text: "partial" }] } }],
						}),
					);
					// Mirror real fetch/Undici behavior: aborting the request signal tears down the response body.
					init?.signal?.addEventListener("abort", () => {
						abortedBySignal = true;
						controller.error(init.signal?.reason ?? new Error("Aborted"));
					});
				},
			});
			return new Response(body, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});

		const result = await streamGoogleVertex(model, context, {
			apiKey: "test-vertex-key",
			streamStallTimeoutMs: 40,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("stalled after 40ms");
		expect(result.failure).toEqual({ code: "stream_stalled", type: "stream_stalled" });
		expect(isRetryableAssistantError(result)).toBe(true);
		expect(capturedSignal?.aborted).toBe(true);
		expect(abortedBySignal).toBe(true);
	});

	it("still settles with StreamStalledError even when a stalled ReadableStream ignores AbortSignal", async () => {
		let capturedSignal: AbortSignal | undefined;

		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			capturedSignal = init?.signal ?? undefined;
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						sseEvent({
							candidates: [{ content: { parts: [{ text: "half" }] } }],
						}),
					);
					// Deliberately ignore init.signal and never close.
				},
			});
			return new Response(body, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});

		const result = await streamGoogleVertex(model, context, {
			apiKey: "test-vertex-key",
			streamStallTimeoutMs: 40,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("stalled after 40ms");
		expect(result.failure).toEqual({ code: "stream_stalled", type: "stream_stalled" });
		expect(isRetryableAssistantError(result)).toBe(true);
		expect(capturedSignal?.aborted).toBe(true);
	});

	it("resets the watchdog on every chunk so healthy long streams complete cleanly", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			const body = new ReadableStream<Uint8Array>({
				async start(controller) {
					const parts = ["one ", "two ", "three ", "four"];
					for (const part of parts) {
						await new Promise((resolve) => setTimeout(resolve, 25));
						controller.enqueue(
							sseEvent({
								candidates: [{ content: { parts: [{ text: part }] } }],
							}),
						);
					}
					await new Promise((resolve) => setTimeout(resolve, 25));
					controller.enqueue(
						sseEvent({
							candidates: [{ finishReason: "STOP" }],
							usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 4, totalTokenCount: 8 },
						}),
					);
					controller.close();
				},
			});
			return new Response(body, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});

		// Total stream duration (~125ms) exceeds the 60ms per-chunk watchdog,
		// proving each chunk resets the idle timer cleanly.
		const result = await streamGoogleVertex(model, context, {
			apiKey: "test-vertex-key",
			streamStallTimeoutMs: 60,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "one two three four" }]);
	});

	it("honors PI_VERTEX_STREAM_STALL_TIMEOUT_MS from options.env", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			const body = new ReadableStream<Uint8Array>({
				start() {
					// Stall before first chunk after headers.
				},
			});
			return new Response(body, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});

		const result = await streamGoogleVertex(model, context, {
			apiKey: "test-vertex-key",
			env: { PI_VERTEX_STREAM_STALL_TIMEOUT_MS: "35" },
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("stalled after 35ms");
		expect(isRetryableAssistantError(result)).toBe(true);
	});

	it("reports caller abort as aborted rather than StreamStalledError", async () => {
		const callerController = new AbortController();
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					init?.signal?.addEventListener("abort", () => {
						controller.error(new Error("Request aborted"));
					});
				},
			});
			return new Response(body, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});

		const stream = streamGoogleVertex(model, context, {
			apiKey: "test-vertex-key",
			signal: callerController.signal,
			streamStallTimeoutMs: 500,
		});
		setTimeout(() => callerController.abort(), 20);

		const result = await stream.result();
		expect(result.stopReason).toBe("aborted");
		expect(result.failure?.code).not.toBe("stream_stalled");
	});

	it("emits an error event and settles cleanly on invalid streamStallTimeoutMs without unhandled rejection", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			for (const invalidValue of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
				const stream = streamGoogleVertex(model, context, {
					apiKey: "test-vertex-key",
					streamStallTimeoutMs: invalidValue,
				});
				const events = [];
				for await (const event of stream) {
					events.push(event);
				}
				const result = await stream.result();
				expect(result.stopReason).toBe("error");
				expect(result.errorMessage).toContain("Invalid streamStallTimeoutMs");
				expect(events.some((event) => event.type === "error")).toBe(true);
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(unhandled).toEqual([]);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("isolates ANSI normalizer state across separate text blocks when block 1 ends with an unclosed fence", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						sseEvent({
							candidates: [{ content: { parts: [{ text: "```ts\nconst x = '\\e[31mraw\\e[0m';" }] } }],
						}),
					);
					controller.enqueue(
						sseEvent({
							candidates: [{ content: { parts: [{ text: "thinking step", thought: true }] } }],
						}),
					);
					controller.enqueue(
						sseEvent({
							candidates: [{ content: { parts: [{ text: "Next block: \\e[1mOK\\e[0m" }] } }],
						}),
					);
					controller.enqueue(
						sseEvent({
							candidates: [{ finishReason: "STOP" }],
							usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 4, totalTokenCount: 8 },
						}),
					);
					controller.close();
				},
			});
			return new Response(body, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});

		const result = await streamGoogleVertex(model, context, {
			apiKey: "test-vertex-key",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([
			{ type: "text", text: "```ts\nconst x = '\\e[31mraw\\e[0m';" },
			{ type: "thinking", thinking: "thinking step", thinkingSignature: undefined },
			{ type: "text", text: "Next block: \u001b[1mOK\u001b[0m" },
		]);
	});
});
