import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeHistory } from "../src/core/claude-history.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { nativeEndpoint } from "./claude-native-fixture.ts";
import { nativeSession, settled } from "./claude-session-fixture.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()!();
});

async function host(manager: SessionManager, root: string, url: string, tool: AgentTool) {
	const state = await nativeSession(manager, root, url, tool);
	cleanups.push(state.close);
	return state;
}

const cases = (["first", "completed", "tools"] as const).flatMap((base) =>
	(["thinking", "text"] as const).map((kind) => ({ base, kind })),
);

describe("interrupted native Claude continuation", () => {
	it.each(cases)(
		"resumes $kind after $base history, including cold reopen and navigation",
		async ({ base, kind }) => {
			const root = mkdtempSync(join(tmpdir(), "pi-claude-interruption-"));
			cleanups.push(() => rmSync(root, { recursive: true, force: true }));
			const endpoint = await nativeEndpoint((_body, index) => {
				if (index === 1 && base === "tools")
					return [{ type: "tool_use", id: "completed-call", name: "mcp__pi__probe", input: {} }];
				if (index === (base === "first" ? 1 : 2))
					return {
						partial:
							kind === "thinking"
								? { type: "thinking", thinking: "Unfinished display output.", signature: "" }
								: { type: "text", text: "Unfinished display output." },
					};
				return [{ type: "text", text: `Complete native reply ${index}.` }];
			});
			cleanups.push(endpoint.close);
			let effects = 0;
			const tool: AgentTool = {
				name: "probe",
				label: "Probe",
				description: "Local effect",
				parameters: Type.Object({}),
				async execute() {
					effects++;
					return { content: [{ type: "text", text: "Durable effect result." }], details: {} };
				},
			};
			const manager = SessionManager.create(root, join(root, "sessions"));
			let state = await host(manager, root, endpoint.url, tool);
			if (base === "completed") {
				await state.session.prompt("Earlier question.");
				settled(state.session);
			}
			const unsubscribe = state.session.subscribe((event) => {
				if (
					event.type === "message_update" &&
					(event.assistantMessageEvent.type === "text_delta" ||
						event.assistantMessageEvent.type === "thinking_delta") &&
					event.assistantMessageEvent.delta.includes("Unfinished display output.")
				)
					state.agent.abort();
			});
			await state.session.prompt("Original interrupted question.");
			unsubscribe();
			expect(state.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
			const partial = manager
				.getEntries()
				.find(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.stopReason === "aborted",
				);
			if (!partial || partial.type !== "message") throw new Error("Interrupted record absent");
			expect(JSON.stringify(partial.message)).toContain("Unfinished display output.");
			const saved = structuredClone(partial);
			const expectedEffects = base === "tools" ? 1 : 0;
			expect(effects).toBe(expectedEffects);
			if (kind === "text") {
				state.close();
				state = await host(SessionManager.open(manager.getSessionFile()!), root, endpoint.url, tool);
			}

			await state.session.prompt("Additional clarification.");
			settled(state.session);
			const resumed = JSON.stringify(endpoint.requests.at(-1)!.messages);
			expect(resumed).toContain("Original interrupted question.");
			expect(resumed.match(/Original interrupted question\./g)).toHaveLength(1);
			expect(resumed).toContain("Additional clarification.");
			expect(resumed).toContain("Unfinished display output.");
			expect(resumed).toContain("may be incomplete");
			if (base === "tools") expect(resumed).toContain("Durable effect result.");
			if (base === "completed") expect(resumed).toContain("Complete native reply 1.");
			expect(effects).toBe(expectedEffects);
			state.close();

			const reopened = SessionManager.open(manager.getSessionFile()!);
			expect(reopened.getEntry(partial.id)).toEqual(saved);
			const cold = await host(reopened, root, endpoint.url, tool);
			await cold.session.prompt("Cold continuation.");
			settled(cold.session);
			expect(JSON.stringify(endpoint.requests.at(-1)!.messages)).toContain("Additional clarification.");
			expect(JSON.stringify(endpoint.requests.at(-1)!.messages)).toContain("Unfinished display output.");
			await cold.session.navigateTree(partial.id);
			await cold.session.prompt("Different clarification after navigation.");
			settled(cold.session);
			const branch = JSON.stringify(endpoint.requests.at(-1)!.messages);
			expect(branch).toContain("Original interrupted question.");
			expect(branch).toContain("Different clarification after navigation.");
			expect(branch).not.toContain("Additional clarification.");
			expect(branch).not.toContain("Cold continuation.");
			expect(branch).toContain("Unfinished display output.");
			expect(effects).toBe(expectedEffects);
		},
		60_000,
	);

	it("resumes a durable result while the same native response is still streaming its next call", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-claude-streaming-effect-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const endpoint = await nativeEndpoint((_body, index) =>
			index === 1
				? {
						before: [{ type: "tool_use", id: "early-call", name: "mcp__pi__probe", input: {} }],
						partial: { type: "tool_use", id: "unfinished-call", name: "mcp__pi__probe", input: {} },
					}
				: [{ type: "text", text: "Continued without repeating the effect." }],
		);
		cleanups.push(endpoint.close);
		let effects = 0;
		let interrupt = () => {};
		const observe = ClaudeHistory.prototype.result;
		// Native outcome delivery precedes transcript flush; waiting for the flush to abort is circular.
		const mirror = vi.spyOn(ClaudeHistory.prototype, "result").mockImplementation(function (
			this: ClaudeHistory,
			sessionId,
			cursor,
			ids,
		) {
			observe.call(this, sessionId, cursor, ids);
			if (ids?.includes("early-call")) interrupt();
		});
		cleanups.push(() => mirror.mockRestore());
		const tool: AgentTool = {
			name: "probe",
			label: "Probe",
			description: "Local effect",
			parameters: Type.Object({}),
			async execute(id) {
				expect(id).toBe("early-call");
				effects++;
				return { content: [{ type: "text", text: "Completed streaming effect." }], details: {} };
			},
		};
		const manager = SessionManager.create(root, join(root, "sessions"));
		const state = await host(manager, root, endpoint.url, tool);
		interrupt = () => state.agent.abort();
		await state.session.prompt("Execute the first tool while generating the next.");
		mirror.mockRestore();
		expect(state.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
		const result = manager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
		if (!result) throw new Error("Completed result absent");
		expect(effects).toBe(1);
		state.close();
		const cold = await host(SessionManager.open(manager.getSessionFile()!), root, endpoint.url, tool);
		await cold.session.prompt("Stop after the completed effect.");
		settled(cold.session);
		const fork = SessionManager.open(manager.getSessionFile()!).createBranchedSession(result.id)!;
		const branch = await host(SessionManager.open(fork), root, endpoint.url, tool);
		await branch.session.prompt("Continue the result fork.");
		settled(branch.session);
		for (const request of endpoint.requests.slice(1)) {
			const input = JSON.stringify(request.messages);
			expect(input).toContain("early-call");
			expect(input).toContain("Completed streaming effect.");
			expect(input).not.toContain("unfinished-call");
		}
		expect(effects).toBe(1);
		expect(endpoint.requests).toHaveLength(3);
	}, 60_000);

	it("continues after an uncertain tool effect without repeating it, including cold reopen", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-claude-unresolved-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const endpoint = await nativeEndpoint((_body, index) =>
			index === 1
				? [{ type: "tool_use", id: "uncertain-call", name: "mcp__pi__probe", input: {} }]
				: [{ type: "text", text: "Acknowledged uncertain outcome without repeating the call." }],
		);
		cleanups.push(endpoint.close);
		let effects = 0;
		let interrupt = () => {};
		const tool: AgentTool = {
			name: "probe",
			label: "Probe",
			description: "Local effect",
			parameters: Type.Object({}),
			async execute() {
				effects++;
				interrupt();
				return { content: [{ type: "text", text: "Uncertified outcome." }], details: {} };
			},
		};
		const manager = SessionManager.create(root, join(root, "sessions"));
		const state = await host(manager, root, endpoint.url, tool);
		interrupt = () => state.agent.abort();
		const active = new Set<string>();
		const lifecycle: string[] = [];
		state.session.subscribe((event) => {
			if (event.type === "tool_execution_start") active.add(event.toolCallId);
			if (event.type === "tool_execution_end") active.delete(event.toolCallId);
			if (event.type === "tool_execution_start" || event.type === "tool_execution_end") lifecycle.push(event.type);
		});
		await state.session.prompt("Execute effect.");
		expect(effects).toBe(1);
		expect(lifecycle).toEqual(["tool_execution_start", "tool_execution_end"]);
		expect(active.size).toBe(0);
		await state.session.prompt("Continue after interruption.");
		settled(state.session);
		expect(JSON.stringify(endpoint.requests.at(-1)!.messages)).toContain("outcome unknown");
		state.close();
		const cold = await host(SessionManager.open(manager.getSessionFile()!), root, endpoint.url, tool);
		await cold.session.prompt("Retry after reopening.");
		settled(cold.session);
		expect(effects).toBe(1);
		expect(endpoint.requests).toHaveLength(3);
	}, 60_000);
});
