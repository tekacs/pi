import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { nativeEndpoint } from "./claude-native-fixture.ts";
import { nativeModel, nativeSession, settled } from "./claude-session-fixture.ts";

const foreignModel = getModel("openai", "gpt-4o")!;
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()!();
});
const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4XsAAAAASUVORK5CYII=";

async function host(manager: SessionManager, root: string, url: string, tool: AgentTool) {
	const state = await nativeSession(manager, root, url, tool);
	cleanups.push(state.close);
	await state.auth.modify(foreignModel.provider, async () => ({ type: "api_key", key: "local-faux-provider" }));
	const native = state.agent.streamFunction;
	let calls = 0;
	state.agent.streamFunction = (model, context, options) => {
		if (model.api === nativeModel.api) return native(model, context, options);
		const toolTurn = calls++ % 2 === 0;
		const message: AssistantMessage = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			responseId: randomUUID(),
			timestamp: Date.now(),
			content: toolTurn
				? [{ type: "toolCall", id: `foreign|${randomUUID()}`, name: "probe", arguments: { value: 7 } }]
				: [
						{ type: "thinking", thinking: "Visible foreign reasoning.", thinkingSignature: "foreign-signature" },
						{ type: "thinking", thinking: "", thinkingSignature: "opaque-foreign-reasoning", redacted: true },
						{ type: "text", text: "Foreign assistant completed its tool." },
					],
			stopReason: toolTurn ? "toolUse" : "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "done", reason: toolTurn ? "toolUse" : "stop", message });
		stream.end(message);
		return stream;
	};
	return state;
}

describe("real Pi provider transitions into Claude", () => {
	it("imports first entry and returning foreign turns without replaying effects, then forks and cold-resumes", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-claude-switch-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const endpoint = await nativeEndpoint((_body, index) =>
			index === 1
				? [
						{ type: "thinking", thinking: "Native private reasoning.", signature: "native-signature" },
						{ type: "redacted_thinking", data: "native-opaque-reasoning" },
						{ type: "text", text: "Native intermediate." },
						{ type: "tool_use", id: "native-call", name: "mcp__pi__probe", input: { value: 8 } },
					]
				: [{ type: "text", text: `Native final ${index}.` }],
		);
		cleanups.push(endpoint.close);
		let effects = 0;
		const parameters = Type.Object({ value: Type.Number() });
		const tool: AgentTool<typeof parameters> = {
			name: "probe",
			label: "Probe",
			description: "Local effect",
			parameters,
			async execute(id, args) {
				effects++;
				return {
					content: [
						{ type: "text", text: `Completed value ${args.value} (${id}).` },
						{ type: "image", mimeType: "image/png", data: image },
					],
					details: {},
				};
			},
		};
		const manager = SessionManager.create(root, join(root, "sessions"));
		const first = await host(manager, root, endpoint.url, tool);
		await first.session.setModel(foreignModel);
		await first.session.prompt("First foreign turn");
		settled(first.session);
		expect(effects).toBe(1);
		const foreignPrefix = structuredClone(manager.buildSessionContext().messages);
		await first.session.setModel(nativeModel);
		const dispatch = first.agent.streamFunction;
		first.agent.streamFunction = () => {
			const previous = [...first.session.messages].reverse().find((message) => message.role === "assistant");
			if (!previous || previous.role !== "assistant") throw new Error("Missing foreign fixture reply");
			const failed: AssistantMessage = {
				...previous,
				api: nativeModel.api,
				provider: nativeModel.provider,
				model: nativeModel.id,
				responseId: undefined,
				content: [],
				stopReason: "error",
				errorMessage: "Pre-update switch refused",
				timestamp: Date.now(),
			};
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "error", reason: "error", error: failed });
			stream.end(failed);
			return stream;
		};
		await first.session.prompt("Failed pre-update switch");
		expect(first.session.messages.at(-1)).toMatchObject({ stopReason: "error" });
		first.agent.streamFunction = dispatch;
		await first.session.prompt("Enter Claude");
		settled(first.session);
		expect(effects).toBe(2); // Only the new Claude call executed.
		expect(endpoint.requests).toHaveLength(2);
		const imported = JSON.stringify(endpoint.requests[0].messages);
		expect(imported).toContain("Visible foreign reasoning.");
		expect(imported).toContain("Completed value 7");
		expect(imported).toContain(image);
		expect(imported).not.toContain("foreign-signature");
		expect(imported).not.toContain("opaque-foreign-reasoning");
		expect(
			endpoint.requests[0].messages.some(
				(message) =>
					message.role === "assistant" && JSON.stringify(message.content).includes("Foreign assistant completed"),
			),
		).toBe(true);
		const blocks = endpoint.requests[0].messages.flatMap((message) =>
			Array.isArray(message.content) ? message.content : [],
		);
		const historicalResult = blocks.find((block) => block.type === "tool_result")!;
		expect(historicalResult.tool_use_id).toMatch(/^pi_[a-f0-9]{60}$/);
		expect(manager.buildSessionContext().messages.slice(0, foreignPrefix.length)).toEqual(foreignPrefix);
		const source = manager.getSessionFile()!;
		const result = manager
			.getEntries()
			.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolCallId === "native-call",
			);
		if (!result) throw new Error("Native result absent");
		first.close();
		const forkFile = SessionManager.open(source).createBranchedSession(result.id)!;
		const branch = await host(SessionManager.open(forkFile), root, endpoint.url, tool);
		await branch.session.prompt("Fork after imported history");
		settled(branch.session);
		expect(effects).toBe(2);
		expect(JSON.stringify(endpoint.requests[2].messages)).toContain("Completed value 7");
		expect(JSON.stringify(endpoint.requests[2].messages)).toContain("Completed value 8");
		expect(JSON.stringify(endpoint.requests[2].messages)).not.toContain("Native final 2.");
		const original = await host(SessionManager.open(source), root, endpoint.url, tool);
		await original.session.prompt("Original after imported history");
		settled(original.session);
		await original.session.setModel(foreignModel);
		await original.session.prompt("Switch away from Claude");
		settled(original.session);
		expect(effects).toBe(3);
		await original.session.setModel(nativeModel);
		await original.session.prompt("Return to Claude");
		settled(original.session);
		expect(effects).toBe(3);
		const returned = JSON.stringify(endpoint.requests[4].messages);
		expect(returned).toContain("native-signature");
		expect(returned).toContain("native-opaque-reasoning");
		expect(returned).toContain("Switch away from Claude");
		expect(returned).not.toContain("Fork after imported history");
		expect(returned).not.toContain("foreign-signature");
		original.close();
		const cold = await host(SessionManager.open(source), root, endpoint.url, tool);
		await cold.session.prompt("Cold resume after return");
		settled(cold.session);
		expect(effects).toBe(3);
		expect(endpoint.requests).toHaveLength(6);
		// A foreign suffix must not hide loss of an existing native prefix.
		await cold.session.setModel(foreignModel);
		await cold.session.prompt("Foreign turn before loss");
		settled(cold.session);
		rmSync(join(root, "native"), { recursive: true, force: true });
		await cold.session.setModel(nativeModel);
		await cold.session.prompt("Do not silently reconstruct missing native state");
		expect(cold.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: expect.stringContaining("No exact native checkpoint"),
		});
		expect(endpoint.requests).toHaveLength(6);
		expect(effects).toBe(4);
	}, 60_000);
});
