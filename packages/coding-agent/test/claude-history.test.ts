import { randomUUID } from "node:crypto";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import { ClaudePrefix, selectCheckpoint } from "../src/core/claude-checkpoints.ts";
import { ClaudeHistory } from "../src/core/claude-history.ts";
import { ClaudeStore } from "../src/core/claude-store.ts";

const model = getModel("anthropic", "claude-sonnet-4-5")!;
function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		responseId: "native-api-response",
		api: "claude-agent-sdk",
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
		stopReason: "stop",
		timestamp: 2,
	};
}
const call = (id: string) => assistant([{ type: "toolCall", id, name: "probe", arguments: {} }]);
const result = (id: string): ToolResultMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "probe",
	content: [{ type: "text", text: `result ${id}` }],
	isError: false,
	timestamp: 3,
});

function fixture() {
	const store = new ClaudeStore();
	const key = { projectKey: "fixture", sessionId: randomUUID() };
	const messages: Message[] = [{ role: "user", content: randomUUID(), timestamp: 1 }];
	const history = new ClaudeHistory(store, new ClaudePrefix(messages));
	const record = (
		message: AssistantMessage | ToolResultMessage,
		members?: readonly object[],
		receipt?: Promise<void>,
	) => {
		messages.push(message);
		history.record(message, members, receipt);
	};
	const nativeCall = async (id: string) => {
		await store.append(key, [
			{ type: "assistant", uuid: `call-${id}`, message: { content: [{ type: "tool_use", id }] } },
		]);
		history.observe(key.sessionId, `call-${id}`, []);
	};
	const nativeResult = async (id: string) => {
		await store.append(key, [
			{ type: "user", uuid: `result-${id}`, message: { content: [{ type: "tool_result", tool_use_id: id }] } },
		]);
		history.result(key.sessionId, `result-${id}`, [id]);
	};
	const finish = async (cursor: string) => {
		const final = assistant([]);
		await history.finish(final, key.sessionId, cursor);
		messages.push(final);
	};
	return { store, key, history, messages, record, nativeCall, nativeResult, finish };
}

describe("Claude checkpoint publication", () => {
	it("certifies long loops by disjoint intervals rather than rescanning the turn", async () => {
		const f = fixture();
		const scanned: string[] = [];
		const prefix = f.store.prefix.bind(f.store);
		vi.spyOn(f.store, "prefix").mockImplementation((key, cursor, after) => {
			const entries = prefix(key, cursor, after);
			for (const entry of entries) if (entry.uuid) scanned.push(entry.uuid);
			return entries;
		});
		for (let index = 0; index < 64; index++) {
			const id = String(index);
			await f.nativeCall(id);
			f.record(call(id));
			f.record(result(id));
			f.history.seal([id]);
			f.history.stop("native-api-response");
			await f.nativeResult(id);
			await f.history.flush();
			expect(selectCheckpoint(f.store, f.messages)?.cursor).toBe(`result-${id}`);
		}
		await f.finish("result-63");
		expect(scanned).toHaveLength(128);
		expect(new Set(scanned).size).toBe(scanned.length);
	});

	it("waits for all native results before reading a large settled batch", async () => {
		const f = fixture();
		const ids = Array.from({ length: 64 }, (_, index) => String(index));
		for (const id of ids) {
			await f.nativeCall(id);
			f.record(call(id));
		}
		for (const id of ids) f.record(result(id));
		f.history.seal(ids);
		f.history.stop("native-api-response");
		const prefix = vi.spyOn(f.store, "prefix");
		for (const id of ids.slice(0, -1)) {
			await f.nativeResult(id);
			await f.history.flush();
		}
		expect(prefix).not.toHaveBeenCalled();
		await f.nativeResult(ids.at(-1)!);
		await f.history.flush();
		expect(prefix).toHaveBeenCalledTimes(1);
		expect(selectCheckpoint(f.store, f.messages)?.cursor).toBe("result-63");
	});

	it("binds only a complete parallel batch, even when the first result overtakes later frames", async () => {
		const f = fixture();
		await f.nativeCall("a");
		f.record(call("a"));
		f.record(result("a"));
		const partial = [...f.messages];
		await f.nativeResult("a");
		await f.nativeCall("b");
		f.record(call("b"));
		f.record(result("b"));
		const complete = [...f.messages];
		f.history.seal(["a", "b"]);
		await f.nativeResult("b");
		await f.history.flush();
		expect(() => selectCheckpoint(f.store, complete)).toThrow("No exact native checkpoint");
		f.history.stop("native-api-response");
		await f.finish("result-b");
		expect(() => selectCheckpoint(f.store, partial)).toThrow("No exact native checkpoint");
		expect(selectCheckpoint(f.store, complete)?.cursor).toBe("result-b");
		expect(selectCheckpoint(f.store, f.messages)?.cursor).toBe("result-b");
	});

	it("never binds a native frame that includes a later canonical segment", async () => {
		const f = fixture();
		const first = { type: "text" as const, text: "first" };
		const later = { type: "text" as const, text: "later" };
		await f.store.append(f.key, [{ type: "assistant", uuid: "both", message: { content: [first, later] } }]);
		f.history.observe(f.key.sessionId, "both", [first, later]);
		f.record(assistant([{ ...first }]), [first]);
		const partial = [...f.messages];
		f.record(assistant([{ ...later }]), [later]);
		const complete = [...f.messages];
		await f.finish("both");
		expect(() => selectCheckpoint(f.store, partial)).toThrow("No exact native checkpoint");
		expect(selectCheckpoint(f.store, complete)?.cursor).toBe("both");
	});

	it("does not let a late authoritative mutation rewrite an already committed snapshot", async () => {
		const f = fixture();
		const member = { type: "thinking" as const, thinking: "plan", thinkingSignature: "partial" };
		f.record(assistant([{ ...member }]), [member]);
		const partial = [...f.messages];
		member.thinkingSignature = "authoritative";
		await f.store.append(f.key, [
			{
				type: "assistant",
				uuid: "thinking",
				message: { content: [{ type: "thinking", thinking: "plan", signature: "authoritative" }] },
			},
		]);
		f.history.observe(f.key.sessionId, "thinking", [member]);
		await expect(f.finish("thinking")).rejects.toThrow("histories differ");
		expect(() => selectCheckpoint(f.store, partial)).toThrow("No exact native checkpoint");
	});

	it("waits for canonical acknowledgement before publishing a native boundary", async () => {
		const f = fixture();
		let acknowledge!: () => void;
		const receipt = new Promise<void>((resolve) => {
			acknowledge = resolve;
		});
		const member = { type: "text" as const, text: "durable" };
		await f.store.append(f.key, [{ type: "assistant", uuid: "text", message: { content: [member] } }]);
		f.history.observe(f.key.sessionId, "text", [member]);
		f.record(assistant([{ ...member }]), [member], receipt);
		const boundary = [...f.messages];
		expect(() => selectCheckpoint(f.store, boundary)).toThrow("No exact native checkpoint");
		acknowledge();
		await f.finish("text");
		expect(selectCheckpoint(f.store, boundary)?.cursor).toBe("text");
	});

	it.each(["child", "fallback"] as const)("refuses a %s without native coverage", async (mode) => {
		const f = fixture();
		await f.store.append(f.key, [{ type: "assistant", uuid: "native", message: { content: [] } }]);
		f.history.observe(f.key.sessionId, "native", []);
		if (mode === "child") f.history.child();
		const final = assistant(mode === "fallback" ? [{ type: "text", text: "not from a native frame" }] : []);
		await expect(f.history.finish(final, f.key.sessionId, "native")).rejects.toThrow(
			mode === "child" ? "Native child checkpoints" : "no authoritative native frame",
		);
		expect(() => selectCheckpoint(f.store, [...f.messages, final])).toThrow("No exact native checkpoint");
	});

	it("does not publish after a canonical acknowledgement fails", async () => {
		const f = fixture();
		const member = { type: "text" as const, text: "not durable" };
		await f.store.append(f.key, [{ type: "assistant", uuid: "native", message: { content: [member] } }]);
		f.history.observe(f.key.sessionId, "native", [member]);
		f.record(assistant([{ ...member }]), [member], Promise.reject(new Error("canonical sync failed")));
		await expect(f.history.flush()).rejects.toThrow("canonical sync failed");
		expect(() => selectCheckpoint(f.store, f.messages)).toThrow("No exact native checkpoint");
	});

	it("rejects final publication without a closed batch or with future uncommitted native text", async () => {
		const f = fixture();
		await f.nativeCall("a");
		f.record(call("a"));
		f.record(result("a"));
		await f.nativeResult("a");
		await expect(f.finish("result-a")).rejects.toThrow("histories differ");
		const g = fixture();
		await g.nativeCall("a");
		g.record(call("a"));
		g.record(result("a"));
		g.history.seal(["a"]);
		g.history.stop("native-api-response");
		await g.store.append(g.key, [
			{ type: "assistant", uuid: "future", message: { content: [{ type: "text", text: "not canonical" }] } },
		]);
		await g.nativeResult("a");
		await expect(g.finish("result-a")).rejects.toThrow("histories differ");
	});
});
