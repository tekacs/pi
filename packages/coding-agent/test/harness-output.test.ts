import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { HarnessOutput } from "../src/core/harness-output.ts";

const message: ToolResultMessage = {
	role: "toolResult",
	toolCallId: "call",
	toolName: "probe",
	content: [],
	isError: false,
	timestamp: 1,
};

describe("harness commit receipts", () => {
	it.each(["done", "error", "end"] as const)("drains concurrent tools before %s, even after abort", async (mode) => {
		const controller = new AbortController();
		const stream = new HarnessOutput(controller.signal);
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "aborted",
			timestamp: 1,
		};
		const events: string[] = [];
		let finished = false;
		const consumer = (async () => {
			for await (const event of stream) events.push(event.type);
			finished = true;
		})();
		for (const id of ["one", "two"])
			stream.push({ type: "tool_execution_start", toolCallId: id, toolName: "probe", args: {} });
		controller.abort();
		if (mode === "done") stream.push({ type: "done", reason: "stop", message: output });
		if (mode === "error") stream.push({ type: "error", reason: "aborted", error: output });
		stream.end(output);
		await expect(stream.commit(message)).rejects.toThrow("closed");
		expect(finished).toBe(false);
		const end = (id: string) =>
			stream.push({
				type: "tool_execution_end",
				toolCallId: id,
				toolName: "probe",
				result: { content: [], details: {} },
				isError: true,
			});
		end("one");
		await Promise.resolve();
		expect(finished).toBe(false);
		end("two");
		await consumer;
		expect(events).toEqual([
			"tool_execution_start",
			"tool_execution_start",
			"tool_execution_end",
			"tool_execution_end",
			...(mode === "end" ? [] : [mode]),
		]);
		expect(await stream.result()).toBe(output);
	});

	it("waits for explicit acknowledgement, not queue delivery", async () => {
		const stream = new HarnessOutput();
		let acknowledged = false;
		const pending = stream.commit(message).then(() => {
			acknowledged = true;
		});
		const iterator = stream[Symbol.asyncIterator]();
		const { value: event } = await iterator.next();
		expect(acknowledged).toBe(false);
		if (event?.type !== "assistant_message_commit") throw new Error("Missing commit");
		event.acknowledge?.();
		await pending;
		expect(acknowledged).toBe(true);
		await iterator.return(undefined);
	});

	it("propagates the host's persistence error", async () => {
		const stream = new HarnessOutput();
		const pending = expect(stream.commit(message)).rejects.toThrow("disk failed");
		const iterator = stream[Symbol.asyncIterator]();
		const { value: event } = await iterator.next();
		if (event?.type !== "assistant_message_commit") throw new Error("Missing commit");
		event.acknowledge?.(new Error("disk failed"));
		await pending;
		await iterator.return(undefined);
	});

	it("rejects a consumer advancing without acknowledgement", async () => {
		const stream = new HarnessOutput();
		const pending = expect(stream.commit(message)).rejects.toThrow("advanced without acknowledging");
		const iterator = stream[Symbol.asyncIterator]();
		await iterator.next();
		const next = iterator.next();
		await pending;
		stream.end();
		await next;
	});

	it.each(["abandon", "end", "abort"] as const)("rejects pending and future commits on %s", async (mode) => {
		const controller = new AbortController();
		const stream = new HarnessOutput(controller.signal);
		const pending = expect(stream.commit(message)).rejects.toThrow();
		const iterator = stream[Symbol.asyncIterator]();
		await iterator.next();
		if (mode === "abandon") await iterator.return(undefined);
		else if (mode === "end") stream.end();
		else controller.abort();
		await pending;
		await expect(stream.commit(message)).rejects.toThrow("closed");
		await iterator.return(undefined);
	});
});
