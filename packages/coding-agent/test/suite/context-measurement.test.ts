import {
	type Api,
	fauxAssistantMessage,
	getCurrentTools,
	type Model,
	normalizeContext,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import * as claude from "../../src/core/claude-agent-sdk-stream.ts";
import type { HarnessStream } from "../../src/core/harness.ts";
import { HarnessOutput } from "../../src/core/harness-output.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const candidate = [{ role: "user" as const, content: "measurement-only input", timestamp: 1 }];
const harnesses: Harness[] = [];
const sessions: AgentSession[] = [];
afterEach(() => {
	for (const session of sessions.splice(0)) session.dispose();
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function fixture() {
	const parent = await createHarness();
	harnesses.push(parent);
	const runtime = parent.session.modelRuntime;
	const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "executed" }], details: {} }));
	const create = async (model: Model<Api>) => {
		const settings = SettingsManager.inMemory();
		settings.setCompactionEnabled(false);
		settings.setRetryEnabled(false);
		const { session } = await createAgentSession({
			cwd: parent.tempDir,
			agentDir: parent.tempDir,
			modelRuntime: runtime,
			model,
			cacheKey: "shared-prefix",
			resourceLoader: parent.session.resourceLoader,
			settingsManager: settings,
			sessionManager: SessionManager.inMemory(parent.tempDir),
			tools: ["effect"],
			customTools: [
				{ name: "effect", label: "Effect", description: "Synthetic effect", parameters: Type.Object({}), execute },
			],
		});
		sessions.push(session);
		return session;
	};
	return { parent, runtime, execute, create };
}

describe.each(["registered", "claude"] as const)("%s native measurement boundary", (kind) => {
	it.each([false, true])(
		"rejects before auth or dispatch, then preserves ordinary inference (virtual=%s)",
		async (virtual) => {
			const { parent, runtime, execute, create } = await fixture();
			const physical =
				kind === "registered" ? parent.getModel() : runtime.getModel("claude-agent-sdk-subscription", "sonnet")!;
			const registered = vi.fn<HarnessStream>((_model, context, options) =>
				runtime.streamSimple(parent.getModel(), context, options),
			);
			const builtin = vi.spyOn(claude, "streamClaudeAgentSdk").mockImplementation((model, _context, options) => {
				const output = new HarnessOutput(options.signal);
				const message = {
					...fauxAssistantMessage("ordinary native answer"),
					api: model.api,
					provider: model.provider,
					model: model.id,
				};
				output.push({ type: "start", partial: message });
				output.push({ type: "done", reason: "stop", message });
				return output;
			});
			if (kind === "registered") runtime.registerHarness(physical.provider, registered);
			const route = vi.fn(() => ({ model: physical, thinkingLevel: "off" as const, state: { probe: true } }));
			if (virtual)
				runtime.registerVirtualModel({ provider: "test-router", id: "auto", name: "Synthetic router", route });
			await runtime.refresh({ allowNetwork: false });
			const selected = virtual ? runtime.getModel("test-router", "auto")! : physical;
			const session = await create(selected);
			const auth = vi.spyOn(runtime, "getAuth").mockResolvedValue({ auth: { apiKey: "synthetic" } });
			const legacyAuth = vi.fn(() => "synthetic");
			if (!virtual) session.agent.getApiKey = legacyAuth;
			const entries = structuredClone(session.sessionManager.getEntries());
			const messages = structuredClone(session.messages);
			const events = vi.fn();
			session.subscribe(events);

			expect(await session.countContextTokens(candidate)).toMatchObject({
				ok: false,
				overflow: false,
				message: `Context measurement is unsupported for native provider: ${physical.provider}`,
			});
			expect(legacyAuth).not.toHaveBeenCalled();
			await expect(
				session.agent.streamFunction(physical, normalizeContext({ messages: candidate }), {
					purpose: "measurement",
				}),
			).rejects.toThrow("measurement is unsupported");
			// Direct runtime requests also fail closed; virtual requests must not fall through to the base provider.
			for (const model of [selected, physical]) {
				expect(
					(await runtime.streamSimple(model, { messages: candidate }, { purpose: "measurement" }).result())
						.errorMessage,
				).toContain("measurement is unsupported");
			}
			expect(
				(await runtime.stream(physical, { messages: candidate }, { purpose: "measurement" }).result()).errorMessage,
			).toContain("measurement is unsupported");
			expect(auth).not.toHaveBeenCalled();
			expect(registered).not.toHaveBeenCalled();
			expect(builtin).not.toHaveBeenCalled();
			expect(execute).not.toHaveBeenCalled();
			expect(events).not.toHaveBeenCalled();
			expect(session.sessionManager.getEntries()).toEqual(entries);
			expect(session.messages).toEqual(messages);
			expect(parent.faux.state.callCount).toBe(0);
			if (virtual) expect(route).toHaveBeenCalled();

			parent.setResponses([fauxAssistantMessage("ordinary native answer")]);
			await session.prompt("ordinary input");
			expect(session.getLastAssistantText()).toBe("ordinary native answer");
			const calls = kind === "registered" ? registered.mock.calls : builtin.mock.calls;
			expect(calls).toHaveLength(1);
			const options = calls[0][2];
			expect(options).toMatchObject({ sessionId: session.sessionId, cacheKey: "shared-prefix" });
			expect(options.purpose).toBeUndefined();
			expect(options.tools?.map((tool) => tool.name)).toEqual(["effect"]);
			expect(options.tools?.[0].execute).toBeTypeOf("function");
			expect(auth).toHaveBeenCalled();
			expect(
				session.sessionManager
					.getEntries()
					.some((entry) => entry.type === "message" && entry.message.role === "assistant"),
			).toBe(true);
		},
	);
});

it("retains registered native tool execution and canonical commits for ordinary inference", async () => {
	const { parent, runtime, execute, create } = await fixture();
	runtime.registerHarness(parent.getModel().provider, (model, _context, options) => {
		const output = new HarnessOutput(options.signal);
		const message = {
			...fauxAssistantMessage("native answer"),
			api: model.api,
			provider: model.provider,
			model: model.id,
		};
		output.push({ type: "start", partial: message });
		void options.runTool({ tool: options.tools[0], args: {}, callId: "native-call", stream: output }).then(
			() => output.push({ type: "done", reason: "stop", message }),
			(error: unknown) =>
				output.push({
					type: "error",
					reason: "error",
					error: { ...message, stopReason: "error", errorMessage: String(error) },
				}),
		);
		return output;
	});
	const session = await create(parent.getModel());
	await session.prompt("ordinary input");
	expect(execute).toHaveBeenCalledTimes(1);
	expect(session.getLastAssistantText()).toBe("native answer");
	expect(
		session.messages.some((message) => message.role === "toolResult" && message.toolCallId === "native-call"),
	).toBe(true);
});

it("keeps declarations but neither executes tool calls nor starts/replaces cache warming during measurement", async () => {
	const { parent, execute, create } = await fixture();
	const session = await create({
		...parent.getModel(),
		promptCache: { short: 60 },
		cost: { input: 100000, output: 0, cacheRead: 1, cacheWrite: 0 },
	});
	session.setCacheWarmingMode("idle");
	vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
	const toolCall = fauxAssistantMessage([{ type: "toolCall", name: "effect", id: "effect-call", arguments: {} }], {
		stopReason: "toolUse",
	});
	const requests: Array<{ text: string; options: SimpleStreamOptions | undefined }> = [];
	const measure = async () => {
		const before = structuredClone(session.sessionManager.getEntries());
		const messages = structuredClone(session.messages);
		parent.setResponses([
			(context, options) => {
				expect(options?.purpose).toBe("measurement");
				expect(options?.cacheKey).toBe("shared-prefix");
				expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual(["effect"]);
				return toolCall;
			},
		]);
		expect((await session.countContextTokens(candidate)).ok).toBe(true);
		expect(session.sessionManager.getEntries()).toEqual(before);
		expect(session.messages).toEqual(messages);
	};
	await measure();
	expect(execute).not.toHaveBeenCalled();
	expect(vi.getTimerCount()).toBe(0);
	expect(session.cacheWarmingStatus?.reason).toBe("waiting for first request");

	parent.setResponses([toolCall, fauxAssistantMessage("ordinary answer")]);
	await session.prompt("ordinary input");
	expect(execute).toHaveBeenCalledTimes(1);
	const warming = session.cacheWarmingStatus;
	expect(warming?.state).toBe("scheduled");
	const timers = vi.getTimerCount();
	await vi.advanceTimersByTimeAsync(1000);
	await measure();
	expect(execute).toHaveBeenCalledTimes(1);
	expect(session.cacheWarmingStatus).toEqual(warming);
	expect(vi.getTimerCount()).toBe(timers);

	parent.setResponses([
		(context, options) => {
			requests.push({ text: JSON.stringify(context.messages), options });
			return fauxAssistantMessage("warm response");
		},
	]);
	await vi.advanceTimersByTimeAsync(49000);
	expect(requests).toHaveLength(1);
	expect(requests[0].text).toContain("ordinary input");
	expect(requests[0].text).not.toContain("measurement-only input");
	expect(requests[0].options?.purpose).toBeUndefined();
	expect(session.getLastAssistantText()).toBe("ordinary answer");
});

it("cancels and reports failed measurements without agent events or persistence", async () => {
	const { parent, execute, create } = await fixture();
	const session = await create(parent.getModel());
	const controller = new AbortController();
	controller.abort(new Error("cancelled"));
	const before = structuredClone(session.sessionManager.getEntries());
	const events = vi.fn();
	session.subscribe(events);
	expect(await session.countContextTokens(candidate, { signal: controller.signal })).toMatchObject({
		ok: false,
		message: "cancelled",
	});
	expect(parent.faux.state.callCount).toBe(0);
	const active = new AbortController();
	let entered: (() => void) | undefined;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	parent.setResponses([
		(_context, options) =>
			new Promise((resolve) => {
				expect(options?.purpose).toBe("measurement");
				options?.signal?.addEventListener(
					"abort",
					() => resolve(fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "cancelled in flight" })),
					{ once: true },
				);
				entered!();
			}),
	]);
	const pending = session.countContextTokens(candidate, { signal: active.signal });
	await started;
	active.abort();
	expect(await pending).toMatchObject({ ok: false, overflow: false });
	parent.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "synthetic failure" })]);
	expect(await session.countContextTokens(candidate)).toMatchObject({ ok: false, message: "synthetic failure" });
	expect(execute).not.toHaveBeenCalled();
	expect(events).not.toHaveBeenCalled();
	expect(session.sessionManager.getEntries()).toEqual(before);
});
