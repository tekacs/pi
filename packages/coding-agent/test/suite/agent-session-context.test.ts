import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { BeforeAgentStartEvent } from "../../src/core/extensions/types.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const noop: AgentTool = {
	name: "noop",
	label: "Noop",
	description: "Does nothing",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
};

describe("context-only runs", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("preserves request prefixes and startup sections across wakes, tool calls, and user prompts", async () => {
		const triggers: BeforeAgentStartEvent["messageType"][] = [];
		const harness = await createHarness({
			tools: [noop],
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						triggers.push(event.messageType);
						event.systemPromptOptions.sections.extension_rules = "Stable extension instructions.";
					});
				},
			],
		});
		harnesses.push(harness);
		const requests: TranscriptContext[] = [];
		const record = (response: ReturnType<typeof fauxAssistantMessage>) => (context: TranscriptContext) => {
			requests.push(structuredClone(context));
			return response;
		};
		harness.setResponses([
			record(fauxAssistantMessage("ready")),
			record(fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" })),
			record(fauxAssistantMessage("first handled")),
			record(fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" })),
			record(fauxAssistantMessage("second handled")),
			record(fauxAssistantMessage("done")),
		]);

		await harness.session.prompt("initial prompt");
		for (const content of ["first notification", "second notification"]) {
			await harness.session.sendCustomMessage({ customType: "notice", content, display: true });
			await harness.session.triggerTurn();
		}
		await harness.session.prompt("next prompt");

		expect(triggers).toEqual(["user", "context", "context", "user"]);
		expect(requests).toHaveLength(6);
		const prompts = requests.map((request) => getCurrentSystemPrompt(request.messages));
		expect(prompts[0]).toContain("Stable extension instructions.");
		expect(new Set(prompts).size).toBe(1);
		for (let i = 1; i < requests.length; i++) {
			const previous = requests[i - 1].messages;
			expect(requests[i].messages.slice(0, previous.length)).toEqual(previous);
		}
		expect(
			requests
				.at(-1)
				?.messages.filter((message) => message.role === "user")
				.map(getMessageText),
		).toEqual(["initial prompt", "first notification", "second notification", "next prompt"]);
		expect(harness.session.messages.filter((message) => message.role === "custom")).toHaveLength(2);
	});

	it("uses extension-projected input without manufacturing or persisting a prompt", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("context", (event) => ({
						messages: [...event.messages, { role: "user", content: "current operation", timestamp: 1 }],
					}));
				},
			],
		});
		harnesses.push(harness);
		const requests: TranscriptContext[] = [];
		harness.setResponses([
			(context) => {
				requests.push(context);
				return fauxAssistantMessage("noticed");
			},
		]);

		await harness.session.triggerTurn();

		expect(requests[0].messages.map((message) => message.role)).toEqual(["system", "user"]);
		expect(getMessageText(requests[0].messages.at(-1))).toBe("current operation");
		expect(harness.session.messages.map((message) => message.role)).toEqual(["system", "assistant"]);
		expect(harness.sessionManager.buildSessionContext().messages.map((message) => message.role)).toEqual([
			"system",
			"assistant",
		]);
	});

	it("runs startup preparation while busy and includes inputs queued during preparation once", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event, ctx) => {
						expect(event.messageType).toBe("context");
						expect(ctx.isIdle()).toBe(false);
						started.resolve();
						await release.promise;
						return { message: { customType: "prepared", content: "startup input", display: false } };
					});
				},
			],
		});
		harnesses.push(harness);
		const requests: TranscriptContext[] = [];
		harness.setResponses([
			(context) => {
				requests.push(context);
				return fauxAssistantMessage("handled");
			},
		]);
		await harness.session.sendCustomMessage({ customType: "notice", content: "stored input", display: true });
		await harness.session.sendCustomMessage(
			{ customType: "next", content: "next-turn input", display: true },
			{ deliverAs: "nextTurn" },
		);
		const run = harness.session.triggerTurn();
		await started.promise;
		await expect(harness.session.triggerTurn()).rejects.toThrow("already running");
		await harness.session.sendCustomMessage(
			{ customType: "queued", content: "queued input", display: true },
			{ triggerTurn: false },
		);
		release.resolve();
		await run;

		expect(requests).toHaveLength(1);
		expect(requests[0].messages.filter((message) => message.role === "user").map(getMessageText)).toEqual([
			"stored input",
			"queued input",
			"startup input",
		]);
	});
});
