import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { nativeEndpoint } from "./claude-native-fixture.ts";
import { nativeModel, nativeSession, settled } from "./claude-session-fixture.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()!();
});
const user: Message = { role: "user", content: "Original request.", timestamp: 1 };
function reply(content: AssistantMessage["content"], native = false): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: native ? nativeModel.api : "openai-responses",
		provider: native ? nativeModel.provider : "openai",
		model: native ? nativeModel.id : "gpt-4o",
		responseId: "historical",
		stopReason: "stop",
		timestamp: 2,
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
const call = reply([{ type: "toolCall", id: "old-call", name: "probe", arguments: {} }], true);
const result: Message = {
	role: "toolResult",
	toolCallId: "old-call",
	toolName: "probe",
	content: [{ type: "text", text: "Recorded historical outcome." }],
	isError: false,
	timestamp: 3,
};
const histories: { name: string; messages: Message[]; evidence: string }[] = [
	{
		name: "foreign abort followed by successful conversation",
		messages: [
			user,
			{
				...reply([{ type: "thinking", thinking: "Partial foreign thought.", thinkingSignature: "nonportable" }]),
				stopReason: "aborted",
			},
			user,
			reply([{ type: "text", text: "Later successful response." }]),
		],
		evidence: "Later successful response.",
	},
	{
		name: "nonempty foreign error",
		messages: [user, { ...reply([{ type: "text", text: "Partial failed text." }]), stopReason: "error" }],
		evidence: "Partial failed text.",
	},
	{
		name: "legacy native conversation without identity",
		messages: [user, { ...reply([{ type: "text", text: "Old native response." }], true), responseId: undefined }],
		evidence: "Old native response.",
	},
	{ name: "unresolved native effect", messages: [user, call], evidence: "outcome unknown" },
	{ name: "orphaned result", messages: [user, result], evidence: "Recorded historical outcome." },
	{
		name: "duplicated calls and results",
		messages: [user, call, call, result, result],
		evidence: "Historical duplicate",
	},
];

describe("Claude conversation recovery", () => {
	it.each(histories)(
		"continues $name without executing historical calls",
		async ({ messages, evidence }) => {
			const root = mkdtempSync(join(tmpdir(), "pi-claude-recovery-"));
			cleanups.push(() => rmSync(root, { recursive: true, force: true }));
			const endpoint = await nativeEndpoint(() => [{ type: "text", text: "Continued recovered conversation." }]);
			cleanups.push(endpoint.close);
			let effects = 0;
			const tool: AgentTool = {
				name: "probe",
				label: "Probe",
				description: "Must not execute history",
				parameters: Type.Object({}),
				async execute() {
					effects++;
					return { content: [], details: {} };
				},
			};
			const manager = SessionManager.create(root, join(root, "sessions"));
			for (const message of messages) manager.appendMessage(message);
			const original = structuredClone(manager.buildSessionContext().messages);
			const state = await nativeSession(manager, root, endpoint.url, tool);
			cleanups.push(state.close);
			await state.session.prompt("Continue in Claude.");
			settled(state.session);
			expect(JSON.stringify(endpoint.requests[0].messages)).toContain(evidence);
			expect(JSON.stringify(endpoint.requests[0].messages)).not.toContain("nonportable");
			expect(manager.buildSessionContext().messages.slice(0, original.length)).toEqual(original);
			state.close();
			const cold = await nativeSession(SessionManager.open(manager.getSessionFile()!), root, endpoint.url, tool);
			cleanups.push(cold.close);
			await cold.session.prompt("Continue after restarting.");
			settled(cold.session);
			expect(effects).toBe(0);
			expect(endpoint.requests).toHaveLength(2);
		},
		60_000,
	);

	it.each(["missing-log", "corrupt-binding", "corrupt-log"] as const)(
		"reconstructs %s before inference and binds fresh native state",
		async (damage) => {
			const root = mkdtempSync(join(tmpdir(), "pi-claude-damaged-"));
			cleanups.push(() => rmSync(root, { recursive: true, force: true }));
			const endpoint = await nativeEndpoint(() => [
				{ type: "thinking", thinking: "Readable native reasoning.", signature: "native-secret" },
				{ type: "text", text: "Durable native response." },
			]);
			cleanups.push(endpoint.close);
			const tool: AgentTool = {
				name: "probe",
				label: "Probe",
				description: "Unused",
				parameters: Type.Object({}),
				async execute() {
					throw new Error("History executed");
				},
			};
			const manager = SessionManager.create(root, join(root, "sessions"));
			const state = await nativeSession(manager, root, endpoint.url, tool);
			cleanups.push(state.close);
			await state.session.prompt("Original question.");
			settled(state.session);
			state.close();
			const folder = join(root, "native", damage === "corrupt-binding" ? "checkpoints" : "sessions");
			if (damage === "missing-log") rmSync(folder, { recursive: true });
			else
				for (const name of readdirSync(folder, { recursive: true })) {
					if (String(name).endsWith(damage === "corrupt-binding" ? ".json" : ".jsonl"))
						writeFileSync(join(folder, String(name)), "corrupt\n");
				}
			const recovered = await nativeSession(
				SessionManager.open(manager.getSessionFile()!),
				root,
				endpoint.url,
				tool,
			);
			cleanups.push(recovered.close);
			await recovered.session.prompt("Continue despite missing exact state.");
			settled(recovered.session);
			const input = JSON.stringify(endpoint.requests[1].messages);
			expect(input).toContain("Durable native response.");
			expect(input).toContain("Readable native reasoning.");
			expect(input).not.toContain("native-secret");
			await recovered.session.prompt("Continue again.");
			settled(recovered.session);
			expect(endpoint.requests).toHaveLength(3);
		},
		60_000,
	);
});
