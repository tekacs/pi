import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

const fixtures: Array<{ harness: Harness; directory: string }> = [];
const input = { customType: "receipt", content: "external result", display: false };
async function fixture(options: HarnessOptions = {}, bind = true) {
	const directory = mkdtempSync(join(tmpdir(), "pi-admission-runtime-"));
	const manager = SessionManager.open(join(directory, "session.jsonl"), directory, directory);
	const harness = await createHarness({ ...options, sessionManager: manager });
	fixtures.push({ harness, directory });
	if (bind) await harness.session.bindExtensions({});
	return harness;
}
function settled(harness: Harness) {
	return new Promise<void>((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "agent_settled") {
				unsubscribe();
				resolve();
			}
		});
	});
}
afterEach(() => {
	for (const { harness, directory } of fixtures.splice(0)) {
		harness.cleanup();
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("AgentSession durable input admission", () => {
	it("keeps one pending receipt across abort, tree navigation and repeated admission", async () => {
		const h = await fixture();
		const anchor = h.sessionManager.appendCustomEntry("anchor", {});
		let started!: () => void;
		let release!: () => void;
		const responding = new Promise<void>((resolve) => {
			started = resolve;
		});
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		h.setResponses([
			async () => {
				started();
				await released;
				return fauxAssistantMessage("interrupted");
			},
		]);
		const prompt = h.session.prompt("start");
		await responding;
		const request = h.session.admitMessage("receipt", input);
		const abort = h.session.abort();
		release();
		await Promise.all([prompt, abort]);
		await h.session.navigateTree(anchor, { summarize: false });
		expect(h.session.admitMessage("receipt", input)).toBe(request);
		await delay(250);
		expect(h.faux.state.callCount).toBe(1);
		expect(h.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toHaveLength(0);
		h.setResponses([fauxAssistantMessage("resumed")]);
		await h.session.prompt("resume explicitly");
		const entries = SessionManager.open(h.sessionManager.getSessionFile()!).getEntries();
		expect(entries.filter((entry) => entry.type === "custom_message" && entry.inputId === request)).toHaveLength(1);
		expect(h.session.admitMessage("receipt", input)).toBe(request);
	});

	it("retries a rejected context turn without consuming an unrelated nextTurn aside", async () => {
		const h = await fixture();
		await h.session.sendCustomMessage(
			{ customType: "aside", content: "next user only", display: false },
			{ deliverAs: "nextTurn" },
		);
		const original = h.session.agent.promptTransient.bind(h.session.agent);
		let rejected!: () => void;
		const rejection = new Promise<void>((resolve) => {
			rejected = resolve;
		});
		h.session.agent.promptTransient = async () => {
			throw new Error("temporary admission driver failure");
		};
		await h.session.bindExtensions({
			onError: (error) => {
				if (error.event === "admit_message") rejected();
				else throw new Error(error.error);
			},
		});
		h.setResponses([
			(context) => {
				expect(JSON.stringify(context.messages)).not.toContain("next user only");
				return fauxAssistantMessage("received");
			},
		]);
		const request = h.session.admitMessage("receipt", input);
		await rejection;
		h.session.agent.promptTransient = original;
		await settled(h);
		expect(h.faux.state.callCount).toBe(1);
		expect(
			h.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.inputId === request),
		).toHaveLength(1);
		expect(h.session.admitMessage("receipt", input)).toBe(request);
	});

	it("retains held custody without inference and delivers once after a policy change", async () => {
		let held = true;
		let accepted = 0;
		const h = await fixture({
			extensionFactories: [
				(pi) => {
					pi.registerInputPolicy("source", {
						check: () => (held ? "hold" : "allow"),
						accept: () => {
							accepted++;
						},
					});
				},
			],
		});
		const request = h.session.admitMessage("receipt", input, { policy: "source" });
		await delay(250);
		expect(h.faux.state.callCount).toBe(0);
		expect(accepted).toBe(0);
		h.setResponses([fauxAssistantMessage("received")]);
		const done = settled(h);
		held = false;
		h.session.refreshInputs();
		await done;
		expect(accepted).toBe(1);
		expect(h.faux.state.callCount).toBe(1);
		expect(
			h.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.inputId === request),
		).toHaveLength(1);
		h.session.refreshInputs();
		await delay(250);
		expect(h.faux.state.callCount).toBe(1);
	});

	it("retains input until its missing policy is registered", async () => {
		let register!: () => void;
		const h = await fixture({
			extensionFactories: [
				(pi) => {
					register = () => pi.registerInputPolicy("late", { check: () => "allow" });
				},
			],
		});
		h.session.admitMessage("receipt", input, { policy: "late" });
		await delay(250);
		expect(h.faux.state.callCount).toBe(0);
		h.setResponses([fauxAssistantMessage("received")]);
		const done = settled(h);
		register();
		await done;
		expect(h.faux.state.callCount).toBe(1);
	});

	it("checks policy again after a queued input reaches message hooks", async () => {
		let held = false;
		const h = await fixture({
			extensionFactories: [
				(pi) => {
					pi.registerInputPolicy("source", { check: () => (held ? "hold" : "allow") });
					pi.on("message_start", (event) => {
						if (event.message.role === "custom") held = true;
					});
				},
			],
		});
		h.setResponses([
			(context) => {
				expect(JSON.stringify(context.messages)).not.toContain("external result");
				return fauxAssistantMessage("no receipt delivered");
			},
		]);
		const done = settled(h);
		h.session.admitMessage("receipt", input, { policy: "source" });
		await done;
		expect(h.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toHaveLength(0);
	});

	it("keeps custody dormant when extension startup cannot complete", async () => {
		const h = await fixture(
			{
				extensionFactories: [
					(pi) => {
						pi.on("session_start", () => {
							throw new Error("authority unavailable");
						});
					},
				],
			},
			false,
		);
		h.session.admitMessage("receipt", input);
		await expect(h.session.bindExtensions({ onError: () => {} })).rejects.toThrow("authority unavailable");
		await delay(250);
		expect(h.faux.state.callCount).toBe(0);
		expect(h.session.agent.hasQueuedMessages()).toBe(false);
	});

	it("cancellation during a message hook removes unprojected input from provider context", async () => {
		const h = await fixture({
			extensionFactories: [
				(pi) => {
					pi.on("message_end", (event) => {
						if (event.message.role === "custom" && event.message.customType === "receipt")
							pi.cancelMessage("receipt");
					});
				},
			],
		});
		h.setResponses([
			(context) => {
				expect(JSON.stringify(context.messages)).not.toContain("external result");
				return fauxAssistantMessage("done");
			},
		]);
		const done = settled(h);
		h.session.admitMessage("receipt", input);
		await done;
		expect(h.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toHaveLength(0);
	});

	it("admits nested tool input but requires its own persisted result, not its parent's marker", async () => {
		const h = await fixture({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "inner",
						label: "Inner",
						description: "Fixture",
						parameters: Type.Object({}),
						execute: async (toolCallId) => {
							const id = pi.admitMessage("receipt", input, { toolCallId });
							return { content: [{ type: "text", text: "accepted" }], details: { inputIds: [id] } };
						},
					});
					pi.registerTool({
						name: "outer",
						label: "Outer",
						description: "Fixture",
						parameters: Type.Object({}),
						execute: async (_id, _args, _signal, _update, ctx) => (await ctx.executeTool("inner", {})).result,
					});
				},
			],
		});
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("outer", {}), { stopReason: "toolUse" }),
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("external result");
				return fauxAssistantMessage("receipt received after outer tool");
			},
		]);
		const projected = new Promise<void>((resolve) => {
			const off = h.session.subscribe((event) => {
				if (event.type === "message_end" && event.message.role === "custom") {
					off();
					resolve();
				}
			});
		});
		await h.session.prompt("call outer");
		await projected;
		await h.session.waitForIdle();
		expect(h.faux.state.callCount).toBe(2);
		expect(h.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toHaveLength(1);
	});

	it("rejects admission against a tool that is not executing", async () => {
		const h = await fixture();
		expect(() => h.session.admitMessage("receipt", input, { toolCallId: "absent" })).toThrow("currently executing");
		expect(
			h.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "pi-input"),
		).toHaveLength(0);
	});

	it.each([true, false])(
		"uses marked tool output or delivers unmarked input at the next request (marked=%s)",
		async (marked) => {
			let h!: Harness;
			h = await fixture({
				tools: [
					{
						name: "receive",
						label: "Receive",
						description: "Fixture",
						parameters: Type.Object({}),
						execute: async (toolCallId) => {
							const request = h.session.admitMessage("receipt", input, { toolCallId });
							return {
								content: [{ type: "text", text: "external result" }],
								details: marked ? { inputIds: [request] } : {},
							};
						},
					},
				],
			});
			h.setResponses([
				fauxAssistantMessage(fauxToolCall("receive", {}), { stopReason: "toolUse" }),
				(context) => {
					if (!marked) expect(JSON.stringify(context.messages)).toContain("external result");
					return fauxAssistantMessage("done");
				},
			]);
			await h.session.prompt("receive the result");
			const entries = SessionManager.open(h.sessionManager.getSessionFile()!).getEntries();
			expect(entries.filter((entry) => entry.type === "custom_message")).toHaveLength(marked ? 0 : 1);
			expect(
				entries.filter((entry) => entry.type === "message" && entry.message.role === "toolResult"),
			).toHaveLength(1);
			expect(h.faux.state.callCount).toBe(2);
		},
	);
});
