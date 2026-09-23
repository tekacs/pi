import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { bindCheckpoint, ClaudePrefix, selectCheckpoint } from "../src/core/claude-checkpoints.ts";
import { ClaudeStore } from "../src/core/claude-store.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const model = getModel("anthropic", "claude-sonnet-4-5")!;
const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const assistant = (responseId: string, content: AssistantMessage["content"]): AssistantMessage => ({
	role: "assistant",
	responseId,
	content,
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
});

async function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "pi-native-checkpoint-"));
	directories.push(directory);
	const manager = SessionManager.create(directory, join(directory, "sessions"));
	const store = new ClaudeStore(join(directory, "native"));
	const messages: Message[] = [
		{ role: "user", content: "run", timestamp: 1 },
		assistant("response-a", [{ type: "toolCall", id: "call-a", name: "probe", arguments: {} }]),
		{
			role: "toolResult",
			toolCallId: "call-a",
			toolName: "probe",
			content: [{ type: "text", text: "result" }],
			isError: false,
			timestamp: 3,
		},
	];
	for (const message of messages) manager.appendMessage(message, { durable: true });
	const target = manager.getLeafId()!;
	const prefix = new ClaudePrefix(messages);
	await store.append({ projectKey: "native-project", sessionId: "native-session" }, [
		{
			type: "assistant",
			uuid: "native-call",
			parentUuid: null,
			message: { content: [{ type: "tool_use", id: "call-a", name: "probe", input: {} }] },
		},
		{
			type: "user",
			uuid: "native-result",
			parentUuid: "native-call",
			message: { content: [{ type: "tool_result", tool_use_id: "call-a", content: "result" }] },
		},
	]);
	await bindCheckpoint(store, prefix.stamp(messages[2] as ToolResultMessage), "native-session", "native-result");
	return { directory, manager, store, messages, target };
}

describe("native IDs carried by ordinary v3 messages", () => {
	it("reopens exact result forks across projects without Pi checkpoint records", async () => {
		const state = await fixture();
		state.manager.appendLabelChange(state.target, "result boundary");
		state.manager.appendMessage(assistant("response-later", [{ type: "text", text: "after selected boundary" }]));
		const source = state.manager.getSessionFile()!;
		const extracted = SessionManager.open(source).createBranchedSession(state.target)!;
		const relocated = SessionManager.forkFrom(
			extracted,
			join(state.directory, "other-project"),
			join(state.directory, "other-sessions"),
		);
		const reopened = SessionManager.open(relocated.getSessionFile()!);
		const messages = reopened.buildSessionContext().messages as Message[];
		expect(reopened.getHeader()?.version).toBe(3);
		expect(messages).toEqual(state.messages);
		expect(selectCheckpoint(new ClaudeStore(join(state.directory, "native")), messages)).toMatchObject({
			responseId: "response-a",
			cursor: "native-result",
			count: 3,
		});
		expect(reopened.getEntries().every((entry) => entry.type === "message" || entry.type === "label")).toBe(true);
		// Lookup does not depend on the old canonical files or their tree IDs.
		rmSync(source);
		rmSync(extracted);
		expect(selectCheckpoint(state.store, messages)?.cursor).toBe("native-result");
	});

	it("validates content and outcome identity, not just a matching native response ID", async () => {
		const state = await fixture();
		const changed = state.messages.map((message) =>
			message.role === "toolResult"
				? { ...message, content: [{ type: "text" as const, text: "altered" }] }
				: message,
		);
		expect(() => selectCheckpoint(state.store, changed)).toThrow("No exact native checkpoint");
		expect(() =>
			selectCheckpoint(state.store, [
				...state.messages,
				assistant("response-a", [{ type: "text", text: "unbound" }]),
			]),
		).toThrow("No exact native checkpoint");
		expect(
			selectCheckpoint(state.store, [...state.messages, { role: "user", content: "next", timestamp: 4 }])?.cursor,
		).toBe("native-result");
	});

	it("fails explicitly when native identity or resources are absent", async () => {
		const state = await fixture();
		expect(() => selectCheckpoint(new ClaudeStore(join(state.directory, "missing")), state.messages)).toThrow(
			"No exact native checkpoint",
		);
		const withoutIdentity = state.messages.map((message) =>
			message.role === "assistant" ? { ...message, responseId: undefined } : message,
		);
		expect(() => selectCheckpoint(state.store, withoutIdentity)).toThrow("no native response identity");
		expect(selectCheckpoint(state.store, [{ role: "user", content: "fresh", timestamp: 1 }])).toBeUndefined();
	});
});
