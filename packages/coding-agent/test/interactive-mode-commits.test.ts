import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { MarkdownTransformer } from "../src/core/extensions/types.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import type { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "claude-agent-sdk",
		provider: "claude-agent-sdk",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

function view() {
	const state = {
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		programStatus: { handleEvent: vi.fn() },
		ui: { requestRender: vi.fn() },
		chatContainer: new Container(),
		streamingComponent: undefined as AssistantMessageComponent | undefined,
		streamingMessage: undefined as AssistantMessage | undefined,
		streamingContentStart: 0,
		pendingTools: new Map<string, ToolExecutionComponent>(),
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		outputPad: 1,
		getMarkdownThemeWithSettings: getMarkdownTheme,
		getMarkdownTransformers: (): MarkdownTransformer[] => [],
		getRegisteredToolDefinition: () => undefined,
		settingsManager: { getShowImages: () => false, getImageWidthCells: () => undefined },
		sessionManager: { getCwd: () => process.cwd() },
		toolOutputExpanded: false,
		session: { retryAttempt: 0 },
		bugReportHintShown: false,
		maybeShowInstallChangeWarning: () => false,
		addMessageToChat: Reflect.get(InteractiveMode.prototype, "addMessageToChat") as (
			message: AssistantMessage,
		) => void,
		maybeSuggestBugReport: Reflect.get(InteractiveMode.prototype, "maybeSuggestBugReport") as (
			message: AssistantMessage,
		) => void,
		suggestBugReport: Reflect.get(InteractiveMode.prototype, "suggestBugReport") as () => void,
		maybeShowThinkingDropNotice: vi.fn(),
		maybeShowCacheMissNotice: vi.fn(),
	};
	const handle = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
		this: typeof state,
		event: AgentSessionEvent,
	) => Promise<void>;
	return {
		state,
		send: (event: AgentSessionEvent) => handle.call(state, event),
		text: () => stripAnsi(state.chatContainer.render(120).join("\n")),
	};
}

beforeEach(() => initTheme("dark"));

describe("committed assistant segments", () => {
	test.each(["error", "aborted"] as const)(
		"renders terminal %s after the preceding segment was committed",
		async (reason) => {
			const ui = view();
			const output = assistant([{ type: "text", text: "Now writing the large file." }]);
			await ui.send({ type: "message_start", message: output });
			await ui.send({ type: "message_commit", message: structuredClone(output) });
			output.content = [];
			output.stopReason = reason;
			output.errorMessage = "Native mirror is missing the observed boundary after turn completion";
			await ui.send({ type: "message_end", message: output });
			const text = ui.text();
			const error = reason === "error" ? output.errorMessage : "Operation aborted";
			expect(text.split("Now writing the large file.")).toHaveLength(2);
			expect(text.split(error)).toHaveLength(2);
			if (reason === "error") expect(text.indexOf(error)).toBeLessThan(text.indexOf("If this looks like a pi bug"));
		},
	);

	test.each(["thinking", "text"] as const)(
		"finalizes %s from the commit after queued partial mutation",
		async (kind) => {
			const ui = view();
			const output = assistant(
				kind === "thinking"
					? [{ type: "thinking", thinking: "Before the tool." }]
					: [{ type: "text", text: "Before the tool." }],
			);
			await ui.send({ type: "message_start", message: output });
			expect(ui.text()).toContain("Before the tool.");
			const queue = createAssistantMessageEventStream();
			queue.push(
				kind === "thinking"
					? { type: "thinking_end", contentIndex: 0, content: "Before the tool.", partial: output }
					: { type: "text_end", contentIndex: 0, content: "Before the tool.", partial: output },
			);
			const committed = structuredClone(output);
			queue.push({ type: "assistant_message_commit", message: committed });
			output.content.splice(0);
			queue.push({ type: "text_delta", contentIndex: 0, delta: "", partial: output });
			queue.end(output);
			for await (const event of queue) {
				if (event.type === "assistant_message_commit") {
					await ui.send({ type: "message_commit", message: event.message });
				} else if (event.type === "thinking_end" || event.type === "text_end" || event.type === "text_delta") {
					await ui.send({ type: "message_update", message: { ...event.partial }, assistantMessageEvent: event });
				}
			}
			expect(ui.text()).toContain("Before the tool.");
			expect(ui.state.chatContainer.children).toHaveLength(1);
			expect(ui.state.streamingComponent).toBeUndefined();
			const restored = new AssistantMessageComponent(committed, false, getMarkdownTheme());
			expect(ui.state.chatContainer.render(120)).toEqual(restored.render(120));
			ui.state.chatContainer.invalidate();
			expect(ui.text()).toContain("Before the tool.");
		},
	);

	test("keeps consecutive segments around tools once, in order", async () => {
		const ui = view();
		const output = assistant([]);
		await ui.send({ type: "message_start", message: output });
		for (const [index, text] of ["First segment.", "Second segment."].entries()) {
			output.content = [{ type: "text", text }];
			await ui.send({
				type: "message_update",
				message: output,
				assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: output },
			});
			await ui.send({ type: "message_commit", message: structuredClone(output) });
			output.content = [];
			await ui.send({ type: "tool_execution_start", toolCallId: `call-${index}`, toolName: "probe", args: {} });
			await ui.send({
				type: "tool_execution_end",
				toolCallId: `call-${index}`,
				toolName: "probe",
				result: { content: [{ type: "text", text: `Result ${index}.` }], details: {} },
				isError: false,
			});
		}
		output.content = [{ type: "text", text: "Final segment." }];
		await ui.send({
			type: "message_update",
			message: output,
			assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: output },
		});
		await ui.send({ type: "message_end", message: output });
		expect(ui.state.chatContainer.children.map((c) => c.constructor.name)).toEqual([
			"AssistantMessageComponent",
			"ToolExecutionComponent",
			"AssistantMessageComponent",
			"ToolExecutionComponent",
			"AssistantMessageComponent",
		]);
		const text = ui.text();
		for (const segment of ["First segment.", "Second segment.", "Final segment."]) {
			expect(text.split(segment)).toHaveLength(2);
		}
		expect(text.indexOf("First segment.")).toBeLessThan(text.indexOf("Result 0."));
		expect(text.indexOf("Result 0.")).toBeLessThan(text.indexOf("Second segment."));
		expect(text.indexOf("Result 1.")).toBeLessThan(text.indexOf("Final segment."));
	});

	test("inserts unstreamed commits without consuming the active segment", async () => {
		const ui = view();
		const current = assistant([{ type: "text", text: "Parent reply." }]);
		await ui.send({ type: "message_start", message: current });
		const active = ui.state.streamingComponent;
		await ui.send({
			type: "message_commit",
			alreadyStreamed: false,
			message: assistant([{ type: "text", text: "Child reply." }]),
		});
		expect(ui.state.streamingComponent).toBe(active);
		await ui.send({ type: "message_commit", message: structuredClone(current) });
		expect(ui.state.chatContainer.children).toHaveLength(2);
		expect(ui.text().indexOf("Child reply.")).toBeLessThan(ui.text().indexOf("Parent reply."));
	});

	test("renders a commit even without any preceding partial", async () => {
		const ui = view();
		await ui.send({ type: "message_commit", message: assistant([{ type: "text", text: "Complete reply." }]) });
		expect(ui.text()).toContain("Complete reply.");
	});
});
