import { Agent, type AgentMessage, type ToolExecutionMode } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { AgentSession, type ExtensionAPI, SessionManager } from "../../../src/index.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

const ORIGINAL = "original history payload";
const FOLDED = "selected fold marker";

function seed(harness: Harness): string[] {
	const sources = [
		harness.sessionManager.appendMessage({ role: "user", content: ORIGINAL, timestamp: 1 }),
		harness.sessionManager.appendMessage(fauxAssistantMessage("original answer")),
	];
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	return sources;
}

function project(pi: ExtensionAPI, sources: string[], collapsed: boolean, generation = 1): void {
	pi.appendEntry("pi.context-projection", {
		version: 2,
		key: "test:context",
		generation,
		fingerprint: `${collapsed}:${generation}`,
		directives: collapsed
			? [
					{
						key: "test:fold",
						sourceEntryIds: sources,
						replacement: {
							messages: [
								{ role: "custom", customType: "test-fold", content: FOLDED, display: false, timestamp: 1 },
							],
						},
					},
				]
			: [],
	});
}

function contents(context: TranscriptContext): string[] {
	return context.messages.map(getMessageText);
}

function assertExchange(messages: AgentMessage[]): void {
	const calls = new Set<string>();
	const results = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) if (block.type === "toolCall") calls.add(block.id);
		}
		if (message.role !== "toolResult") continue;
		expect(calls.has(message.toolCallId)).toBe(true);
		expect(results.has(message.toolCallId)).toBe(false);
		results.add(message.toolCallId);
	}
	expect(results).toEqual(calls);
}

describe("projection adoption before the next request", () => {
	it("restores executable coding tools from a folded compaction on resume", async () => {
		let api: ExtensionAPI | undefined;
		const harness = await createHarness({
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					api = pi;
				},
			],
		});
		let resumed: AgentSession | undefined;
		try {
			harness.session.setActiveToolsByName(["read", "bash", "edit", "write"]);
			harness.setResponses([fauxAssistantMessage("original answer")]);
			await harness.session.prompt("older work");
			const firstKept = harness.sessionManager.appendMessage({
				role: "user",
				content: "retained prompt",
				timestamp: 2,
			});
			const checkpoint = harness.sessionManager.appendCompaction("foldable summary", firstKept, 100);
			project(api!, [checkpoint], true);
			const manager = SessionManager.inMemory(harness.tempDir, {}, harness.sessionManager.getEntries());
			const agent = new Agent({
				streamFn: harness.session.agent.streamFunction,
				initialState: { model: harness.getModel(), messages: manager.buildSessionContext().messages },
			});
			resumed = new AgentSession({
				agent,
				sessionManager: manager,
				settingsManager: harness.settingsManager,
				cwd: harness.tempDir,
				modelRuntime: harness.session.modelRuntime,
				resourceLoader: harness.session.resourceLoader,
			});
			expect(resumed.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);
			expect(resumed.messages.map(getMessageText)).toContain(FOLDED);
			expect(resumed.messages.some((m) => m.role === "compactionSummary")).toBe(false);
		} finally {
			resumed?.dispose();
			harness.cleanup();
		}
	});

	it("does not drop the current assistant call when a message_end hook changes projection", async () => {
		let sources: string[] = [];
		let seenCall = false;
		let harness: Harness;
		harness = await createHarness({
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("message_end", ({ message }) => {
						if (message.role === "assistant") project(pi, sources, true);
					});
					pi.registerTool({
						name: "inspect",
						label: "Inspect",
						description: "Inspect current call state",
						parameters: Type.Object({}),
						execute: async (id) => {
							seenCall = harness.session.messages.some(
								(m) => m.role === "assistant" && m.content.some((b) => b.type === "toolCall" && b.id === id),
							);
							return { content: [{ type: "text", text: "observed" }], details: {} };
						},
					});
				},
			],
		});
		try {
			sources = seed(harness);
			harness.session.setActiveToolsByName(["inspect"]);
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("inspect", {}), { stopReason: "toolUse" }),
				(context) => {
					assertExchange(context.messages);
					return fauxAssistantMessage("done");
				},
			]);
			await harness.session.prompt("inspect");
			expect(seenCall).toBe(true);
			expect(harness.getPendingResponseCount()).toBe(0);
			expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
			assertExchange(harness.session.messages);
		} finally {
			harness.cleanup();
		}
	});

	it.each<ToolExecutionMode>(["parallel", "sequential"])(
		"folds and restores within one %s tool run, without compaction",
		async (toolExecution) => {
			let sources: string[] = [];
			let generation = 0;
			const harness = await createHarness({
				settings: { compaction: { enabled: false }, retry: { enabled: false } },
				extensionFactories: [
					(pi) => {
						pi.registerTool({
							name: "project",
							label: "Project",
							description: "Change context",
							parameters: Type.Object({ collapsed: Type.Boolean() }),
							execute: async (_id, { collapsed }) => {
								// Two writes must coalesce rather than exposing an intermediate frame.
								project(pi, sources, !collapsed, ++generation);
								project(pi, sources, collapsed, ++generation);
								return { content: [{ type: "text", text: collapsed ? "folded" : "restored" }], details: {} };
							},
						});
						pi.registerTool({
							name: "companion",
							label: "Companion",
							description: "Another tool in the batch",
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: "companion result" }], details: {} }),
						});
					},
				],
			});
			try {
				sources = seed(harness);
				harness.session.agent.toolExecution = toolExecution;
				harness.session.setActiveToolsByName(["project", "companion"]);
				harness.setResponses([
					(context) => {
						expect(contents(context)).toContain(ORIGINAL);
						return fauxAssistantMessage(
							[fauxToolCall("project", { collapsed: true }), fauxToolCall("companion", {})],
							{ stopReason: "toolUse" },
						);
					},
					(context) => {
						expect(contents(context)).not.toContain(ORIGINAL);
						expect(contents(context)).toContain(FOLDED);
						expect(contents(context)).toContain("companion result");
						assertExchange(context.messages);
						return fauxAssistantMessage(fauxToolCall("project", { collapsed: false }), { stopReason: "toolUse" });
					},
					(context) => {
						expect(contents(context)).toContain(ORIGINAL);
						expect(contents(context)).not.toContain(FOLDED);
						assertExchange(context.messages);
						return fauxAssistantMessage("done");
					},
				]);
				await harness.session.prompt("Fold and expand without ending this run");
				expect(harness.eventsOfType("agent_start")).toHaveLength(1);
				expect(harness.eventsOfType("agent_end")).toHaveLength(1);
				expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
				expect(harness.getPendingResponseCount()).toBe(0);
				expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
				assertExchange(harness.session.messages);
			} finally {
				harness.cleanup();
			}
		},
	);

	it.each(["turn_start", "assistant_end", "message_end", "turn_end"] as const)(
		"adopts %s writes after persistence and before the next request",
		async (event) => {
			let sources: string[] = [];
			let writes = 0;
			const requests: string[][] = [];
			const harness = await createHarness({
				settings: { compaction: { enabled: false } },
				extensionFactories: [
					(pi) => {
						if (event === "message_end" || event === "assistant_end") {
							pi.on("message_end", (message) => {
								if (
									message.message.role === (event === "assistant_end" ? "assistant" : "toolResult") &&
									writes++ === 0
								)
									project(pi, sources, true);
							});
						} else if (event === "turn_start") {
							pi.on(event, () => {
								if (writes++ === 0) project(pi, sources, true);
							});
						} else {
							pi.on(event, () => {
								if (writes++ === 0) project(pi, sources, true);
							});
						}
						pi.registerTool({
							name: "continue",
							label: "Continue",
							description: "Continue the run",
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: "current result" }], details: {} }),
						});
					},
				],
			});
			try {
				sources = seed(harness);
				harness.session.setActiveToolsByName(["continue"]);
				harness.setResponses([
					(context) => {
						requests.push(contents(context));
						return fauxAssistantMessage(fauxToolCall("continue", {}), { stopReason: "toolUse" });
					},
					(context) => {
						requests.push(contents(context));
						assertExchange(context.messages);
						return fauxAssistantMessage("done");
					},
				]);
				await harness.session.prompt("continue");
				expect(requests[event === "turn_start" ? 0 : 1]).toContain(FOLDED);
				expect(requests[1]).not.toContain(ORIGINAL);
				expect(requests[1]).toContain("current result");
				expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
				assertExchange(harness.session.messages);
			} finally {
				harness.cleanup();
			}
		},
	);

	it("catches turn_start writes after between-turn preparation and preserves transient inputs", async () => {
		let sources: string[] = [];
		const harness = await createHarness({
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("turn_start", ({ turnIndex }) => {
						project(pi, sources, turnIndex === 0, turnIndex);
					});
					pi.registerTool({
						name: "continue",
						label: "Continue",
						description: "Continue",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "result" }], details: {} }),
					});
				},
			],
		});
		try {
			sources = seed(harness);
			harness.session.setActiveToolsByName(["continue"]);
			harness.setResponses([
				(context) => {
					expect(contents(context)).toContain(FOLDED);
					expect(contents(context).filter((text) => text.includes("durable context changed"))).toHaveLength(1);
					return fauxAssistantMessage(fauxToolCall("continue", {}), { stopReason: "toolUse" });
				},
				(context) => {
					expect(contents(context)).toContain(ORIGINAL);
					expect(contents(context)).not.toContain(FOLDED);
					expect(contents(context).filter((text) => text.includes("durable context changed"))).toHaveLength(1);
					expect(contents(context).findIndex((text) => text.includes("durable context changed"))).toBeLessThan(
						context.messages.findIndex(
							(m) => m.role === "assistant" && m.content.some((b) => b.type === "toolCall"),
						),
					);
					assertExchange(context.messages);
					return fauxAssistantMessage("done");
				},
			]);
			await harness.session.triggerTurn();
			expect(harness.getPendingResponseCount()).toBe(0);
			expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
			expect(harness.session.messages.some((m) => getMessageText(m).includes("durable context changed"))).toBe(
				false,
			);
			expect(JSON.stringify(harness.sessionManager.getBranch())).not.toContain("durable context changed");
		} finally {
			harness.cleanup();
		}
	});

	it("settles a terminating run with its final projection and complete exchange", async () => {
		let sources: string[] = [];
		const harness = await createHarness({
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "finish",
						label: "Finish",
						description: "Finish after projecting",
						parameters: Type.Object({}),
						execute: async () => {
							project(pi, sources, true);
							return { content: [{ type: "text", text: "finished" }], details: {}, terminate: true };
						},
					});
				},
			],
		});
		try {
			sources = seed(harness);
			harness.session.setActiveToolsByName(["finish"]);
			harness.setResponses([fauxAssistantMessage(fauxToolCall("finish", {}), { stopReason: "toolUse" })]);
			await harness.session.prompt("finish");
			expect(harness.session.messages.map(getMessageText)).toContain(FOLDED);
			expect(harness.session.messages.map(getMessageText)).not.toContain(ORIGINAL);
			assertExchange(harness.session.messages);
			expect(harness.eventsOfType("turn_start")).toHaveLength(1);
		} finally {
			harness.cleanup();
		}
	});

	it("includes queued custom and steering messages once in the next request", async () => {
		let inject: (() => Promise<void>) | undefined;
		const harness = await createHarness({
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "notify",
						label: "Notify",
						description: "Inject a custom message",
						parameters: Type.Object({}),
						execute: async () => {
							await inject?.();
							return { content: [{ type: "text", text: "tool result" }], details: {} };
						},
					});
				},
			],
		});
		try {
			harness.session.setActiveToolsByName(["notify"]);
			inject = async () => {
				await harness.session.sendCustomMessage(
					{ customType: "notice", content: "notice payload", display: false },
					{ triggerTurn: false },
				);
				await harness.session.steer("steering payload");
			};
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("notify", {}), { stopReason: "toolUse" }),
				(context) => {
					const texts = contents(context);
					for (const text of ["notice payload", "steering payload", "tool result"])
						expect(texts.filter((t) => t === text)).toHaveLength(1);
					assertExchange(context.messages);
					return fauxAssistantMessage("done");
				},
				fauxAssistantMessage("unchanged request"),
			]);
			await harness.session.prompt("start");
			await harness.session.prompt("another request");
			expect(harness.getPendingResponseCount()).toBe(0);
			expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
		} finally {
			harness.cleanup();
		}
	});
});
