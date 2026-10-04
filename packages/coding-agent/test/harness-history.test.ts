import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { type AgentToolRunOptions, runAgentTool } from "../src/core/harness.ts";
import { HarnessOutput } from "../src/core/harness-output.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

vi.mock("fs", { spy: true });
const model = getModel("anthropic", "claude-sonnet-4-5")!;
const result = { content: [{ type: "text" as const, text: "complete" }], details: { durable: true } };
const cleanups: (() => void)[] = [];
afterEach(() => {
	vi.resetAllMocks();
	while (cleanups.length) cleanups.pop()!();
});

function tool(execute: AgentTool["execute"]): AgentTool {
	return { name: "probe", label: "Probe", description: "Probe", parameters: Type.Object({}), execute };
}

async function host(probe: AgentTool, run: (options: AgentToolRunOptions) => Promise<void>) {
	const directory = fs.mkdtempSync(join(tmpdir(), "pi-harness-history-"));
	const manager = SessionManager.create(directory, directory);
	const auth = AuthStorage.inMemory();
	await auth.modify(model.provider, async () => ({ type: "api_key", key: "test-key" }));
	const { session } = await createAgentSession({
		cwd: directory,
		model,
		sessionManager: manager,
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
		modelRuntime: getModelRuntime(await createInMemoryModelRegistry(auth)),
		resourceLoader: createTestResourceLoader(),
		customTools: [probe],
		tools: [probe.name],
	});
	session.agent.streamFunction = () => {
		const stream = new HarnessOutput(session.agent.signal);
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
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
		stream.push({ type: "start", partial: output });
		void run({
			model,
			stream,
			context: { messages: session.agent.state.messages, tools: [probe] },
			callId: "native-1",
			signal: session.agent.signal,
		}).then(
			() => stream.push({ type: "done", reason: "stop", message: output }),
			(error: unknown) => {
				output.stopReason = "error";
				output.errorMessage = String(error);
				stream.push({ type: "error", reason: "error", error: output });
			},
		);
		return stream;
	};
	cleanups.push(() => {
		session.dispose();
		fs.rmSync(directory, { recursive: true, force: true });
	});
	const reload = () => SessionManager.open(manager.getSessionFile()!).buildSessionContext().messages;
	return { session, manager, reload };
}

describe("canonical harness execution", () => {
	it("persists original calls before effects and outcomes before native delivery, without changing v3", async () => {
		let effects = 0;
		let delivered = false;
		const probe = tool(async (id) => {
			effects++;
			expect(state.reload().at(-1)).toMatchObject({ role: "assistant", content: [{ type: "toolCall", id }] });
			return result;
		});
		const state = await host(probe, async (options) => {
			await runAgentTool(probe, {}, options);
			expect(state.reload().at(-1)).toMatchObject({ role: "toolResult", toolCallId: "native-1", ...result });
			delivered = true;
		});
		await state.session.prompt("run");
		expect(state.session.messages.at(-1)).toMatchObject({ stopReason: "stop" });
		expect(effects).toBe(1);
		expect(delivered).toBe(true);
		expect(state.manager.getHeader()?.version).toBe(3);
		expect(
			state
				.reload()
				.filter((message) => message.role !== "system")
				.map((message) => message.role),
		).toEqual(["user", "assistant", "toolResult", "assistant"]);
	});

	it.each(["call", "result"] as const)("does not cross a failed %s durability barrier", async (boundary) => {
		let effects = 0;
		let delivered = false;
		const fail = () =>
			vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {
				throw new Error("disk unavailable");
			});
		const probe = tool(async () => {
			effects++;
			if (boundary === "result") fail();
			return result;
		});
		const state = await host(probe, async (options) => {
			await runAgentTool(probe, {}, options);
			delivered = true;
		});
		const lifecycle: string[] = [];
		state.session.subscribe((event) => {
			if (event.type === "tool_execution_start" || event.type === "tool_execution_end") lifecycle.push(event.type);
		});
		if (boundary === "call") fail();
		await expect(state.session.prompt("run")).rejects.toThrow("reopen before continuing");
		expect(lifecycle).toEqual(boundary === "call" ? [] : ["tool_execution_start", "tool_execution_end"]);
		expect(effects).toBe(boundary === "call" ? 0 : 1);
		expect(delivered).toBe(false);
		expect(state.session.messages.some((message) => message.role === "toolResult")).toBe(false);
		expect(
			state.manager.getEntries().some((entry) => entry.type === "message" && entry.message.role === "toolResult"),
		).toBe(false);
		expect(() => state.manager.appendMessage({ role: "user", content: "retry", timestamp: 2 })).toThrow(
			"reopen before continuing",
		);
	});

	it("retires a cancelled tool without accepting an undurable result", async () => {
		const probe = tool(async () => {
			state.session.agent.abort();
			return result;
		});
		let rejected = false;
		const state = await host(probe, async (options) => {
			await expect(runAgentTool(probe, {}, options)).rejects.toThrow("Harness output is closed");
			rejected = true;
		});
		const active = new Set<string>();
		const lifecycle: string[] = [];
		state.session.subscribe((event) => {
			if (event.type === "tool_execution_start") active.add(event.toolCallId);
			if (event.type === "tool_execution_end") active.delete(event.toolCallId);
			if (event.type === "tool_execution_start" || event.type === "tool_execution_end") lifecycle.push(event.type);
		});
		await state.session.prompt("run");
		expect(rejected).toBe(true);
		expect(active.size).toBe(0);
		expect(lifecycle).toEqual(["tool_execution_start", "tool_execution_end"]);
		expect(state.reload().some((message) => message.role === "toolResult")).toBe(false);
	});

	it("rejects concurrent duplicate claims before a second effect", async () => {
		let effects = 0;
		const probe = tool(async () => {
			effects++;
			return result;
		});
		const outcomes: PromiseSettledResult<unknown>[] = [];
		const state = await host(probe, async (options) => {
			outcomes.push(
				...(await Promise.allSettled([runAgentTool(probe, {}, options), runAgentTool(probe, {}, options)])),
			);
		});
		await state.session.prompt("run");
		expect(effects).toBe(1);
		expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
	});

	it("reuses a durable outcome and refuses unresolved or conflicting identities", async () => {
		const execute = vi.fn(async () => ({ ...result, terminate: true }));
		const probe = tool(execute);
		const state = await host(probe, async (options) => {
			await runAgentTool(probe, {}, options);
		});
		await state.session.prompt("run");
		const options = { model, stream: new HarnessOutput(), context: { messages: state.reload() }, callId: "native-1" };
		expect(await runAgentTool(probe, {}, options)).toMatchObject({
			result: { ...result, terminate: true },
			isError: false,
		});
		await expect(runAgentTool(probe, { changed: true }, options)).rejects.toThrow("different arguments");
		options.context.messages = options.context.messages.filter((message) => message.role !== "toolResult");
		await expect(runAgentTool(probe, {}, options)).rejects.toThrow("unresolved outcome");
		expect(execute).toHaveBeenCalledTimes(1);
	});
});
