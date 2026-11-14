import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../src/types.ts";
import { AssistantMessageEventStream, EventStream } from "../src/utils/event-stream.ts";

// Regression tests for https://github.com/earendil-works/pi/issues/9055
describe("EventStream", () => {
	it("drains buffered events in order and ignores events pushed after completion", async () => {
		const stream = new EventStream<number, number>(
			(event) => event === 3,
			(event) => event,
		);
		stream.push(1);
		stream.push(2);
		stream.push(3);
		stream.push(4);

		expect(await stream.result()).toBe(3);

		const events: number[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		expect(events).toEqual([1, 2, 3]);
	});

	it("preserves order when events arrive after buffered draining starts", async () => {
		const stream = new EventStream<number, number>(
			() => false,
			(event) => event,
		);
		stream.push(1);
		stream.push(2);

		const iterator = stream[Symbol.asyncIterator]();
		expect(await iterator.next()).toEqual({ value: 1, done: false });

		stream.push(3);
		expect(await iterator.next()).toEqual({ value: 2, done: false });
		expect(await iterator.next()).toEqual({ value: 3, done: false });

		stream.end(3);
		expect(await iterator.next()).toEqual({ value: undefined, done: true });
	});

	it("delivers events to waiting consumers in registration order", async () => {
		const stream = new EventStream<number, number>(
			() => false,
			(event) => event,
		);
		const firstIterator = stream[Symbol.asyncIterator]();
		const secondIterator = stream[Symbol.asyncIterator]();
		const firstEvent = firstIterator.next();
		const secondEvent = secondIterator.next();

		stream.push(1);
		stream.push(2);

		expect(await firstEvent).toEqual({ value: 1, done: false });
		expect(await secondEvent).toEqual({ value: 2, done: false });
	});

	it("drains buffered events after end and resolves the explicit result", async () => {
		const stream = new EventStream<number, string>(
			() => false,
			(event) => String(event),
		);
		stream.push(1);
		stream.push(2);
		stream.end("complete");

		expect(await stream.result()).toBe("complete");

		const events: number[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		expect(events).toEqual([1, 2]);
	});

	it("wakes all waiting consumers when ended without a result", async () => {
		const stream = new EventStream<number, number>(
			() => false,
			(event) => event,
		);
		const firstIterator = stream[Symbol.asyncIterator]();
		const secondIterator = stream[Symbol.asyncIterator]();
		const firstEvent = firstIterator.next();
		const secondEvent = secondIterator.next();

		stream.end();

		expect(await firstEvent).toEqual({ value: undefined, done: true });
		expect(await secondEvent).toEqual({ value: undefined, done: true });
	});
});

function message(timestamp: number, durationMs?: number): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "openai",
		model: "m",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
		...(durationMs === undefined ? {} : { durationMs }),
	};
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("AssistantMessageEventStream timing", () => {
	it("sets durationMs on the final done or error message of a response it saw start", async () => {
		const done = new AssistantMessageEventStream();
		const answer = message(Date.now());
		await sleep(20);
		done.push({ type: "done", reason: "stop", message: answer });
		expect(answer.durationMs).toBeGreaterThanOrEqual(15);
		expect((await done.result()).durationMs).toBe(answer.durationMs);

		const failed = new AssistantMessageEventStream();
		const error = { ...message(Date.now()), stopReason: "error" as const };
		failed.push({ type: "error", reason: "error", error });
		expect(error.durationMs).toBeGreaterThanOrEqual(0);

		const ended = new AssistantMessageEventStream();
		const result = message(Date.now());
		ended.end(result);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("keeps an existing duration, so a forwarding stream keeps the inner measurement", async () => {
		const outer = new AssistantMessageEventStream();
		await sleep(20);
		const inner = new AssistantMessageEventStream();
		const answer = message(Date.now());
		inner.push({ type: "done", reason: "stop", message: answer });
		const measured = answer.durationMs;
		outer.push({ type: "done", reason: "stop", message: answer });
		expect(answer.durationMs).toBe(measured);
		expect(measured).toBeLessThan(20);

		const preset = message(Date.now(), 1234);
		new AssistantMessageEventStream().push({ type: "done", reason: "stop", message: preset });
		expect(preset.durationMs).toBe(1234);
	});

	it("leaves a message untimed when it started before the stream, such as a fetched deferred result", () => {
		const fetched = message(Date.now() - 60_000);
		new AssistantMessageEventStream().push({ type: "done", reason: "stop", message: fetched });
		expect(fetched.durationMs).toBeUndefined();
	});

	it("does not time a message pushed after the stream completed", () => {
		const stream = new AssistantMessageEventStream();
		stream.push({ type: "done", reason: "stop", message: message(Date.now()) });
		const late = message(Date.now());
		stream.push({ type: "done", reason: "stop", message: late });
		expect(late.durationMs).toBeUndefined();
	});

	it("records ttftMs and per-item delayMs/durationMs across thinking, text, and toolCall items", async () => {
		const stream = new AssistantMessageEventStream();
		const partial = message(Date.now());
		stream.push({ type: "start", partial });

		await sleep(25);
		partial.content.push({ type: "thinking", thinking: "plan" });
		stream.push({ type: "thinking_start", contentIndex: 0, partial });
		await sleep(20);
		stream.push({ type: "thinking_delta", contentIndex: 0, delta: "plan", partial });
		stream.push({ type: "thinking_end", contentIndex: 0, content: "plan", partial });

		await sleep(18);
		partial.content.push({ type: "text", text: "answer" });
		stream.push({ type: "text_start", contentIndex: 1, partial });
		await sleep(15);
		stream.push({ type: "text_end", contentIndex: 1, content: "answer", partial });

		await sleep(12);
		const call = { type: "toolCall" as const, id: "c1", name: "bash", arguments: { command: "true" } };
		partial.content.push(call);
		stream.push({ type: "toolcall_start", contentIndex: 2, partial });
		stream.push({ type: "toolcall_end", contentIndex: 2, toolCall: call, partial });

		stream.push({ type: "done", reason: "toolUse", message: partial });
		const result = await stream.result();

		expect(result.ttftMs).toBeGreaterThanOrEqual(18);
		expect(result.contentTimings).toHaveLength(3);
		expect(result.contentTimings?.[0]?.delayMs).toBe(result.ttftMs);
		expect(result.contentTimings?.[0]?.durationMs).toBeGreaterThanOrEqual(14);
		expect(result.contentTimings?.[1]?.delayMs).toBeGreaterThanOrEqual(12);
		expect(result.contentTimings?.[1]?.durationMs).toBeGreaterThanOrEqual(10);
		expect(result.contentTimings?.[2]?.delayMs).toBeGreaterThanOrEqual(8);
		expect(result.content).toEqual([{ type: "thinking", thinking: "plan" }, { type: "text", text: "answer" }, call]);

		// Forwarding stream preserves inner ttftMs and contentTimings.
		const outer = new AssistantMessageEventStream();
		await sleep(20);
		outer.push({ type: "done", reason: "toolUse", message: result });
		expect(result.ttftMs).toBe(result.contentTimings?.[0]?.delayMs);

		// Unclosed block on error closes its durationMs at stream settlement.
		const abortedStream = new AssistantMessageEventStream();
		const failed = { ...message(Date.now()), stopReason: "aborted" as const };
		await sleep(15);
		failed.content.push({ type: "thinking", thinking: "partial" });
		abortedStream.push({ type: "thinking_start", contentIndex: 0, partial: failed });
		await sleep(15);
		abortedStream.push({ type: "error", reason: "aborted", error: failed });
		expect(failed.ttftMs).toBeGreaterThanOrEqual(10);
		expect(failed.contentTimings?.[0]?.delayMs).toBe(failed.ttftMs);
		expect(failed.contentTimings?.[0]?.durationMs).toBeGreaterThanOrEqual(10);
	});
});
