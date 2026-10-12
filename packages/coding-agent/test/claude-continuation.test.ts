import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentSession } from "../src/core/agent-session.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { toolEndpoint } from "./claude-native-fixture.ts";
import { nativeSession, settled } from "./claude-session-fixture.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()!();
});

async function host(manager: SessionManager, root: string, url: string, tool: AgentTool, prompt = "Local fixture.") {
	const state = await nativeSession(manager, root, url, tool, prompt);
	cleanups.push(state.close);
	return state;
}

describe("Pi sessions backed by native Claude checkpoints", () => {
	it("cold-reopens a result fork and its source, then advances both without duplicate effects or leakage", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-claude-continuation-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const endpoint = await toolEndpoint();
		cleanups.push(endpoint.close);
		let effects = 0;
		const manager = SessionManager.create(root, join(root, "sessions"));
		let active = manager;
		const tool: AgentTool = {
			name: "probe",
			label: "Probe",
			description: "Local effect",
			parameters: Type.Object({}),
			async execute(id) {
				effects++;
				const persisted = SessionManager.open(active.getSessionFile()!).buildSessionContext().messages;
				expect(
					persisted.some(
						(message) =>
							message.role === "assistant" &&
							message.content.some((block) => block.type === "toolCall" && block.id === id),
					),
				).toBe(true);
				return { content: [{ type: "text", text: `Completed ${id}.` }], details: {} };
			},
		};
		const initial = await host(manager, root, endpoint.url, tool);
		await initial.session.prompt("Run two tools");
		settled(initial.session);
		const source = manager.getSessionFile()!;
		const result = [...manager.getEntries()]
			.reverse()
			.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
		if (!result) throw new Error("Canonical result absent");
		const intermediate = manager
			.getEntries()
			.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					entry.message.content.some((block) => block.type === "text" && block.text === "Before native tools."),
			);
		if (!intermediate) throw new Error("Canonical intermediate segment absent");
		expect(effects).toBe(2);
		initial.close();
		const selectedFile = SessionManager.open(source).createBranchedSession(result.id)!;
		const forkManager = SessionManager.forkFrom(
			selectedFile,
			mkdtempSync(join(root, "other-project-")),
			join(root, "other-sessions"),
		);
		const forkFile = forkManager.getSessionFile()!;
		const branch = await host(forkManager, root, endpoint.url, tool);
		await branch.session.prompt("Continue fork");
		settled(branch.session);
		const original = await host(SessionManager.open(source), root, endpoint.url, tool, "Changed system prompt.");
		await original.session.prompt("Continue original");
		settled(original.session);
		expect(effects).toBe(2);
		expect(endpoint.requests).toHaveLength(4);
		const forkInput = JSON.stringify(endpoint.requests[2].messages);
		expect(forkInput).toContain("Completed call-1-0.");
		expect(forkInput).toContain("Completed call-1-1.");
		expect(forkInput).toContain("fixture-signature");
		expect(forkInput).toContain("opaque-thinking-payload");
		expect(forkInput).not.toContain("Native final 2.");
		expect(JSON.stringify(endpoint.requests[3].messages)).toContain("Native final 2.");
		expect(JSON.stringify(endpoint.requests[3].messages)).not.toContain("Continue fork");
		expect(JSON.stringify(endpoint.requests[3].system)).toContain("Changed system prompt.");
		await Promise.all([branch.session.prompt("Fork again"), original.session.prompt("Original again")]);
		settled(branch.session);
		settled(original.session);
		expect(effects).toBe(2);
		expect(endpoint.requests).toHaveLength(6);
		for (const request of endpoint.requests.slice(4)) {
			const text = JSON.stringify(request.messages);
			expect(text.includes("Fork again") !== text.includes("Original again")).toBe(true);
		}
		expect(JSON.stringify(SessionManager.open(source).buildSessionContext().messages)).not.toContain("Continue fork");
		expect(JSON.stringify(SessionManager.open(forkFile).buildSessionContext().messages)).not.toContain(
			"Continue original",
		);
		const earlierFile = SessionManager.open(source).createBranchedSession(intermediate.id)!;
		active = SessionManager.open(earlierFile);
		const earlier = await host(active, root, endpoint.url, tool);
		await earlier.session.prompt("Continue before tools");
		settled(earlier.session);
		expect(effects).toBe(4);
		expect(endpoint.requests).toHaveLength(8);
		const earlyInput = JSON.stringify(endpoint.requests[6].messages);
		expect(earlyInput).toContain("Before native tools.");
		expect(earlyInput).toContain("fixture-signature");
		expect(earlyInput).toContain("opaque-thinking-payload");
		expect(earlyInput).not.toContain("Completed call-1");
		expect(earlyInput).not.toContain("Continue original");
		branch.close();
		original.close();
		earlier.close();
		// Without native resources, canonical history still reconstructs the conversation.
		rmSync(join(root, "native"), { recursive: true, force: true });
		const missing = await host(SessionManager.open(source), root, endpoint.url, tool);
		await missing.session.prompt("Continue without native resources");
		settled(missing.session);
		expect(endpoint.requests).toHaveLength(9);
		const rebuilt = JSON.stringify(endpoint.requests[8].messages);
		expect(rebuilt).toContain("Completed call-1-0.");
		expect(rebuilt).toContain("Native final 2.");
		expect(rebuilt).not.toContain("fixture-signature");
		expect(rebuilt).not.toContain("opaque-thinking-payload");
		expect(effects).toBe(4);
	}, 60_000);

	it("delivers steering queued during a native tool batch at that batch boundary", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-claude-steering-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const endpoint = await toolEndpoint();
		cleanups.push(endpoint.close);
		let state: Awaited<ReturnType<typeof host>> | undefined;
		let restored: ReturnType<AgentSession["clearQueue"]> | undefined;
		const tool: AgentTool = {
			name: "probe",
			label: "Probe",
			description: "Local effect",
			parameters: Type.Object({}),
			async execute(id) {
				if (id.endsWith("-0")) {
					const session = state!.session;
					await session.steer("Typed steering");
					await session.sendCustomMessage(
						{ customType: "inbox", content: "Inbox steering", display: true },
						{ triggerTurn: true, deliverAs: "steer" },
					);
					// Restoring typed input to the editor must not discard another producer's message.
					restored = session.clearQueue();
				}
				return { content: [{ type: "text", text: `Completed ${id}.` }], details: {} };
			},
		};
		const manager = SessionManager.create(root, join(root, "sessions"));
		state = await host(manager, root, endpoint.url, tool);
		await state.session.prompt("Run batch");
		settled(state.session);
		expect(restored).toEqual({ steering: ["Typed steering"], followUp: [] });
		// The steering reaches the request that follows the batch, not one after the model's final answer.
		expect(endpoint.requests).toHaveLength(2);
		const followup = JSON.stringify(endpoint.requests[1].messages);
		expect(followup).toContain("Completed call-1-1.");
		expect(followup).toContain("Inbox steering");
		expect(followup).not.toContain("Typed steering");
		const order = manager
			.buildSessionContext()
			.messages.map((message) => (message.role === "custom" ? message.customType : message.role));
		// The batch-boundary stop record follows the last result; the steering precedes the final answer.
		expect(order.slice(-4)).toEqual(["toolResult", "assistant", "inbox", "assistant"]);
		expect(order.filter((role) => role === "toolResult")).toHaveLength(2);
	}, 60_000);

	it.each(["tool", "blocked", "after", "mixed"] as const)(
		"honors %s batch termination and reopens the settled outcome",
		async (mode) => {
			const root = mkdtempSync(join(tmpdir(), "pi-claude-termination-"));
			cleanups.push(() => rmSync(root, { recursive: true, force: true }));
			const endpoint = await toolEndpoint();
			cleanups.push(endpoint.close);
			let effects = 0;
			const tool: AgentTool = {
				name: "probe",
				label: "Probe",
				description: "Local effect",
				parameters: Type.Object({}),
				async execute(id) {
					effects++;
					return {
						content: [{ type: "text", text: `Completed ${id}.` }],
						details: {},
						terminate: mode === "tool" || (mode === "mixed" && id.endsWith("-0")),
					};
				},
			};
			const manager = SessionManager.create(root, join(root, "sessions"));
			const state = await host(manager, root, endpoint.url, tool);
			if (mode === "blocked") state.agent.beforeToolCall = async () => ({ block: true, terminate: true });
			if (mode === "after") state.agent.afterToolCall = async () => ({ terminate: true });
			await state.session.prompt("Run batch");
			settled(state.session);
			expect(effects).toBe(mode === "blocked" ? 0 : 2);
			expect(endpoint.requests).toHaveLength(mode === "mixed" ? 2 : 1);
			const results = manager.buildSessionContext().messages.filter((message) => message.role === "toolResult");
			expect(results).toHaveLength(2);
			expect(results.filter((message) => message.terminate)).toHaveLength(mode === "mixed" ? 1 : 2);
			state.close();
			const resumed = await host(SessionManager.open(manager.getSessionFile()!), root, endpoint.url, tool);
			await resumed.session.prompt("Continue after batch");
			settled(resumed.session);
			expect(effects).toBe(mode === "blocked" ? 0 : 2);
			expect(endpoint.requests).toHaveLength(mode === "mixed" ? 3 : 2);
			const ids = endpoint.requests
				.at(-1)!
				.messages.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
				.filter((block) => block.type === "tool_result")
				.map((block) => block.tool_use_id)
				.sort();
			expect(ids).toEqual(["call-1-0", "call-1-1"]);
		},
		60_000,
	);
});
