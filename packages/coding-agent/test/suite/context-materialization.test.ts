import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { CACHE_CHECKPOINT, fauxAssistantMessage, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloneMessages } from "../../src/core/messages.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("context materialization", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.restoreAllMocks();
	});

	it("uses projected history, context transforms and prompt/tool deltas without generating or persisting", async () => {
		vi.spyOn(Date, "now").mockReturnValue(10_000);
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("context", (event) => ({
						messages: [
							...event.messages,
							{
								role: "custom",
								customType: "test.tail",
								content: "transformed tail",
								display: false,
								timestamp: 2,
							},
						],
					}));
				},
			],
		});
		harnesses.push(harness);
		const manager = harness.sessionManager;
		const hidden = manager.appendMessage({ role: "user", content: "hidden history", timestamp: 1 });
		manager.appendCustomMessageEntry("test.note", "retained note", false);
		manager.appendContextEdit(hidden, null);
		harness.session.setActiveToolsByName(["read"]);
		const candidate = { entries: manager.getBranch(), leafId: manager.getLeafId() };
		const before = structuredClone(manager.getEntries());
		const ctx = harness.session.extensionRunner.createContext();
		const { messages: materialized } = await ctx.materializeContext!(candidate);

		expect(JSON.stringify(materialized)).not.toContain("hidden history");
		expect(JSON.stringify(materialized)).toContain("retained note");
		expect(JSON.stringify(materialized)).toContain("transformed tail");
		expect(materialized.every((message) => message.role !== ("custom" as string))).toBe(true);
		expect(getCurrentSystemPrompt(materialized)).toBe(harness.session.systemPrompt);
		expect(getCurrentTools(materialized).map((tool) => tool.name)).toEqual(["read"]);
		expect(harness.events).toEqual([]);
		expect(manager.getEntries()).toEqual(before);

		harness.setResponses([
			(context) => {
				expect(context.messages).toEqual(materialized);
				return fauxAssistantMessage("preflight");
			},
		]);
		expect((await harness.session.countContextTokens(candidate)).ok).toBe(true);
		expect(manager.getEntries()).toEqual(before);
	});

	it("freezes the input before awaiting transforms and returns independently mutable messages", async () => {
		let release: (() => void) | undefined;
		let entered: (() => void) | undefined;
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("context", async () => {
						entered!();
						await barrier;
					});
				},
			],
		});
		harnesses.push(harness);
		const candidate: AgentMessage[] = [{ role: "user", content: [{ type: "text", text: "frozen" }], timestamp: 1 }];
		const pending = harness.session.materializeContext(candidate);
		await started;
		candidate[0] = { role: "user", content: "changed", timestamp: 2 };
		harness.sessionManager.appendMessage({ role: "user", content: "arrival", timestamp: 3 });
		release!();
		const { messages: materialized } = await pending;
		expect(materialized.filter((message) => message.role === "user")).toEqual([
			{ role: "user", content: [{ type: "text", text: "frozen" }], timestamp: 1 },
		]);
		materialized.splice(0);
		expect(candidate).toHaveLength(1);
		expect(harness.sessionManager.getBranch()).toHaveLength(1);
	});

	it("preserves multimodal and tool-protocol content for an independently configured session", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const candidate: AgentMessage[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "image" },
					{ type: "image", mimeType: "image/png", data: "AA==" },
				],
				timestamp: 1,
			},
			fauxAssistantMessage([{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "example.txt" } }], {
				stopReason: "toolUse",
			}),
			{
				role: "toolResult",
				toolCallId: "read-1",
				toolName: "read",
				content: [{ type: "text", text: "historical result" }],
				isError: false,
				timestamp: 3,
			},
		];
		const { messages } = await harness.session.materializeContext(candidate);
		const manager = SessionManager.inMemory();
		for (const message of messages) manager.appendMessage(message);
		const child = await createHarness({ sessionManager: manager, tools: [], initialActiveToolNames: [] });
		harnesses.push(child);
		expect(child.session.getCallableToolNames()).toEqual([]);
		expect(manager.buildSessionContext().messages).toEqual(messages);
		expect(JSON.stringify(messages)).toContain("AA==");
		expect(JSON.stringify(messages)).toContain("read-1");
		expect(JSON.stringify(messages)).toContain("historical result");
	});

	it("retains ephemeral cache checkpoints through cloning, conversion and provider preflight", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const candidate: AgentMessage[] = [
			{ role: "user", content: [{ type: "text", text: "prefix" }], timestamp: 1, [CACHE_CHECKPOINT]: true },
			{ role: "custom", customType: "test.note", content: "retained", display: false, timestamp: 2 },
		];
		Object.defineProperty(candidate[1], CACHE_CHECKPOINT, { value: true });
		const cloned = cloneMessages(candidate);
		expect(cloned).not.toBe(candidate);
		expect(cloned[0]).not.toBe(candidate[0]);
		expect(cloned.every((message) => CACHE_CHECKPOINT in message && message[CACHE_CHECKPOINT])).toBe(true);
		expect(JSON.stringify(cloned)).toBe(JSON.stringify(candidate));
		const materialized = await harness.session.materializeContext(cloned);
		const users = materialized.messages.filter((message) => message.role === "user");
		expect(users).toHaveLength(2);
		expect(users.every((message) => message[CACHE_CHECKPOINT])).toBe(true);
		users[0].content = "detached";
		expect(candidate[0]).toMatchObject({ content: [{ type: "text", text: "prefix" }] });
		harness.setResponses([
			(context) => {
				const sent = context.messages.filter((message) => message.role === "user");
				expect(sent).toHaveLength(2);
				expect(sent.every((message) => message[CACHE_CHECKPOINT])).toBe(true);
				return fauxAssistantMessage("preflight");
			},
		]);
		expect((await harness.session.countContextTokens(candidate)).ok).toBe(true);
	});

	it("rejects cancellation before or during materialization without invoking the provider", async () => {
		const controller = new AbortController();
		let transforms = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("context", () => {
						transforms++;
						controller.abort(new Error("cancelled"));
					});
				},
			],
		});
		harnesses.push(harness);
		await expect(harness.session.materializeContext([], { signal: controller.signal })).rejects.toThrow("cancelled");
		await expect(harness.session.materializeContext([], { signal: controller.signal })).rejects.toThrow("cancelled");
		expect(transforms).toBe(1);
		expect(harness.events).toEqual([]);
	});

	it("rejects materialization through a stale extension context", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const ctx = harness.session.extensionRunner.createContext();
		harness.session.extensionRunner.invalidate("stale context");
		await expect(ctx.materializeContext!([])).rejects.toThrow("stale context");
	});
});
