import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { bindCheckpoint, ClaudePrefix } from "../src/core/claude-checkpoints.ts";
import { emptyAttempt, importHistory, selectHistory } from "../src/core/claude-import.ts";
import { ClaudeStore } from "../src/core/claude-store.ts";

function assistant(content: AssistantMessage["content"], native = false): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: native ? "claude-agent-sdk" : "openai-responses",
		provider: native ? "claude-agent-sdk-subscription" : "openai",
		model: native ? "opus" : "gpt-5",
		responseId: "response",
		timestamp: 2,
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
const user: Message = { role: "user", content: "hello", timestamp: 1 };
const call = (id = "call|foreign") => assistant([{ type: "toolCall", id, name: "old/tool", arguments: { value: 7 } }]);
const result = (id = "call|foreign"): ToolResultMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "old/tool",
	content: [{ type: "text", text: "done" }],
	isError: false,
	timestamp: 3,
});

describe("structured foreign-provider import", () => {
	it("keeps roles, tool pairing and images without changing canonical IDs or treating signatures as portable", () => {
		const messages: Message[] = [
			user,
			assistant([
				{ type: "thinking", thinking: "visible foreign thought", thinkingSignature: "invalid-on-claude" },
				{ type: "thinking", thinking: "", thinkingSignature: "opaque-secret", redacted: true },
				{ type: "text", text: "before tool" },
			]),
			call(),
			{
				...result(),
				content: [
					{ type: "text", text: "done" },
					{ type: "image", mimeType: "image/png", data: "base64" },
				],
			},
		];
		const original = structuredClone(messages);
		const records = importHistory(messages, "native-prefix");
		expect(records).toHaveLength(3);
		expect(records[0].parentUuid).toBe("native-prefix");
		expect(records[1].parentUuid).toBe(records[0].uuid);
		expect(records[2].parentUuid).toBe(records[1].uuid);
		const content = (records[1].message as { content: { type: string; id?: string }[] }).content;
		const id = content.find((block) => block.type === "tool_use")!.id!;
		expect(id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
		expect(records[1]).toMatchObject({
			type: "assistant",
			message: {
				content: [
					{ type: "text", text: "visible foreign thought" },
					{ type: "text", text: "before tool" },
					{ type: "tool_use", id, name: "mcp__pi__old_tool", input: { value: 7 } },
				],
			},
		});
		expect(records[2]).toMatchObject({
			type: "user",
			message: {
				content: [
					{
						type: "tool_result",
						tool_use_id: id,
						content: [
							{ type: "text", text: "done" },
							{ type: "image", source: { type: "base64", data: "base64", media_type: "image/png" } },
						],
					},
				],
			},
		});
		expect(JSON.stringify(records)).not.toContain("invalid-on-claude");
		expect(JSON.stringify(records)).not.toContain("opaque-secret");
		expect(messages).toEqual(original);
	});

	it.each(
		[
			[call()],
			[result()],
			[call(), user, result()],
			[call(), call(), result()],
			[call(), result(), result()],
			[call(), { ...result(), toolName: "different" }],
			[call("a"), call("b"), result("a"), assistant([{ type: "text", text: "too early" }]), result("b")],
		].map((messages) => [messages]),
	)("refuses unresolved or malformed tool exchanges", (messages) => {
		expect(() => importHistory(messages as Message[])).toThrow(/Cannot import/);
	});

	it("selects first entry without needing a foreign response ID and retries empty failed switch attempts", () => {
		const foreign = { ...assistant([{ type: "text", text: "foreign" }]), responseId: undefined };
		const failed = { ...assistant([], true), responseId: undefined, stopReason: "error" as const };
		const messages = [user, foreign, user, failed, user];
		const prefix = new ClaudePrefix([]);
		const selected = selectHistory(new ClaudeStore(), messages, prefix);
		expect(selected.checkpoint).toBeUndefined();
		expect(selected.count).toBe(2);
		expect(selected.imported).toEqual([user, foreign]);
		expect(emptyAttempt(failed)).toBe(true);
		expect(prefix.stamp(assistant([]))).toEqual(new ClaudePrefix(messages).stamp(assistant([])));
	});

	it("keeps the last native checkpoint and imports only a foreign suffix", async () => {
		const store = new ClaudeStore();
		const native = assistant([{ type: "text", text: "native prefix" }], true);
		const original = [user, native];
		await store.append({ projectKey: "project", sessionId: "session" }, [{ type: "assistant", uuid: "cursor" }]);
		await bindCheckpoint(store, new ClaudePrefix(original).stamp(native), "session", "cursor");
		const suffix = [user, call(), result()];
		const selected = selectHistory(store, [...original, ...suffix, user], new ClaudePrefix([]));
		expect(selected.checkpoint?.cursor).toBe("cursor");
		expect(selected.imported).toEqual(suffix);
		expect(selected.count).toBe(5);
	});

	it("does not use foreign output or empty failure shells to bypass missing native state", () => {
		const native = assistant([{ type: "text", text: "native" }], true);
		const foreign = assistant([{ type: "text", text: "foreign" }]);
		for (const messages of [
			[user, native, user],
			[user, native, user, foreign, user],
		]) {
			expect(() => selectHistory(new ClaudeStore(), messages, new ClaudePrefix([]))).toThrow(
				"No exact native checkpoint",
			);
		}
		expect(() => importHistory([native])).toThrow("Native Claude history requires its checkpoint");
	});
});
