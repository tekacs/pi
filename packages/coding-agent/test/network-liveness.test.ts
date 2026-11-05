import type { Api, AssistantMessage, Model, TranscriptContext } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddressWatch, guardNetwork, internetAddress } from "../src/core/network-liveness.ts";

const model = { id: "m", api: "openai-codex-responses", provider: "openai-codex" } as unknown as Model<Api>;
const context = { messages: [] } as unknown as TranscriptContext;

function message(stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	};
}

/** A provider waiting on a socket that never answers; it settles only through its abort signal. */
function silentProvider(options: { honorAbort: boolean }) {
	return (_model: Model<Api>, _context: unknown, streamOptions?: { signal?: AbortSignal }) => {
		const stream = new AssistantMessageEventStream();
		stream.push({ type: "start", partial: message("pending") });
		if (options.honorAbort) {
			streamOptions?.signal?.addEventListener("abort", () => {
				stream.push({ type: "error", reason: "aborted", error: message("aborted", "Request was aborted") });
			});
		}
		return stream;
	};
}

function addresses(initial: string[]) {
	let current = new Set(initial);
	return {
		source: () => new Set(current),
		set: (next: string[]) => {
			current = new Set(next);
		},
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("network liveness guard", () => {
	it("ignores link-local and loopback churn while an internet address stays up", async () => {
		const net = addresses(["192.0.2.10", "fe80::1234", "febf::1", "169.254.1.2", "::1"]);
		const watch = new AddressWatch(net.source, 60_000);
		const lost = vi.fn();
		const stop = watch.watch(lost);
		net.set(["192.0.2.10"]);
		watch.poll();
		expect(lost).not.toHaveBeenCalled();
		net.set([]);
		watch.poll();
		expect(lost).toHaveBeenCalledWith(["192.0.2.10"]);
		stop();
	});

	it("recognizes the complete IPv6 link-local range without excluding global addresses", () => {
		for (const address of ["fe80::1", "FE80::1%en0", "fe90::1", "feaf::1", "febf::1", "127.0.0.1", "::1"]) {
			expect(internetAddress(address)).toBe(false);
		}
		for (const address of ["192.0.2.10", "2001:db8::1", "fd00::1"]) expect(internetAddress(address)).toBe(true);
	});

	it("settles a request when every starting address vanishes as a retryable lost connection", async () => {
		const net = addresses(["192.0.2.20"]);
		const watch = new AddressWatch(net.source, 60_000);
		const stream = await guardNetwork(silentProvider({ honorAbort: true }), watch)(model, context, {});

		net.set(["192.0.2.10"]);
		watch.poll();

		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("192.0.2.20 was removed");
		expect(isRetryableAssistantError(result)).toBe(true);
	});

	it("keeps concurrent provider requests alive through unrelated private IPv6 address churn", async () => {
		const net = addresses(["192.0.2.10", "fd06:bd7e:6a9f::2"]);
		const watch = new AddressWatch(net.source, 60_000);
		const signals: AbortSignal[] = [];
		const provider = (_model: Model<Api>, _context: unknown, options?: { signal?: AbortSignal }) => {
			signals.push(options!.signal!);
			return silentProvider({ honorAbort: true })(_model, _context, options);
		};
		const guarded = guardNetwork(provider, watch);
		const first = await guarded(model, context, {});
		net.set(["192.0.2.10", "fdf8:5fd8:6451::2"]);
		watch.poll();
		const second = await guarded(model, context, {});
		net.set(["192.0.2.10", "fdc4:e5f3:8a00::2"]);
		watch.poll();
		expect(signals.map((signal) => signal.aborted)).toEqual([false, false]);

		net.set([]);
		watch.poll();
		for (const stream of [first, second]) {
			const result = await stream.result();
			expect(result.stopReason).toBe("error");
			expect(isRetryableAssistantError(result)).toBe(true);
		}
	});

	it("does not infer a loss when no usable addresses existed at request start", () => {
		const net = addresses([]);
		const watch = new AddressWatch(net.source, 60_000);
		const lost = vi.fn();
		const stop = watch.watch(lost);
		watch.poll();
		expect(lost).not.toHaveBeenCalled();
		stop();
	});

	it("keeps a user abort a user abort even if the network also changed", async () => {
		const net = addresses(["10.0.0.2"]);
		const watch = new AddressWatch(net.source, 60_000);
		const user = new AbortController();
		const stream = await guardNetwork(silentProvider({ honorAbort: true }), watch)(model, context, {
			signal: user.signal,
		});

		user.abort();
		net.set([]);
		watch.poll();

		const result = await stream.result();
		expect(result.stopReason).toBe("aborted");
		expect(isRetryableAssistantError(result)).toBe(false);
	});

	it("settles even when the provider never observes the abort", async () => {
		vi.useFakeTimers();
		const net = addresses(["10.0.0.2"]);
		const watch = new AddressWatch(net.source, 60_000);
		const stream = await guardNetwork(silentProvider({ honorAbort: false }), watch)(model, context, {});

		net.set([]);
		watch.poll();
		await vi.advanceTimersByTimeAsync(10_000);

		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(isRetryableAssistantError(result)).toBe(true);
	});

	it("passes completed responses through and stops polling once nothing is in flight", async () => {
		const net = addresses(["10.0.0.2"]);
		const source = vi.fn(net.source);
		const watch = new AddressWatch(source, 60_000);
		const provider = () => {
			const stream = new AssistantMessageEventStream();
			stream.push({ type: "start", partial: message("pending") });
			stream.push({ type: "done", reason: "stop", message: message("stop") });
			return stream;
		};
		const stream = await guardNetwork(provider, watch)(model, context, {});
		const events: string[] = [];
		for await (const event of stream) events.push(event.type);

		expect(events).toEqual(["start", "done"]);
		expect((await stream.result()).stopReason).toBe("stop");
		source.mockClear();
		net.set([]);
		watch.poll();
		expect(source).toHaveBeenCalledTimes(1); // the poll ran, but no request was left to abort
	});
});
