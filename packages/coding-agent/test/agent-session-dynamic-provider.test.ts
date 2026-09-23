import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Provider } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { HarnessOutput } from "../src/core/harness-output.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import type { ExtensionFactory } from "../src/core/sdk.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function nativeAnthropicProvider(baseUrl: string): Provider {
	const model = { ...getModel("anthropic", "claude-sonnet-4-5")!, baseUrl };
	return {
		id: "anthropic",
		name: "Native Anthropic",
		baseUrl,
		auth: {
			apiKey: {
				name: "Test API key",
				resolve: async () => ({ auth: { apiKey: "test-key" }, source: "test" }),
			},
		},
		getModels: () => [model],
		stream: () => {
			throw new Error("unused");
		},
		streamSimple: () => {
			throw new Error("unused");
		},
	};
}

describe("AgentSession dynamic provider registration", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-dynamic-provider-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(extensionFactories: ExtensionFactory[]) {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(agentDir, "models.json"),
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			modelRuntime,
			resourceLoader,
		});

		return session;
	}

	async function capturePromptBaseUrl(
		session: Awaited<ReturnType<typeof createSession>>,
	): Promise<string | undefined> {
		let baseUrl: string | undefined;
		session.agent.streamFunction = async (model) => {
			baseUrl = model.baseUrl;
			throw new Error("stop");
		};
		await session.prompt("hello");
		return baseUrl;
	}

	it("applies top-level registerProvider overrides to the active model", async () => {
		const session = await createSession([
			(pi) => {
				pi.registerProvider("anthropic", { baseUrl: "http://localhost:8080/top-level" });
			},
		]);

		expect(session.model?.baseUrl).toBe("http://localhost:8080/top-level");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/top-level");

		session.dispose();
	});

	it("applies session_start registerProvider overrides to the active model", async () => {
		const session = await createSession([
			(pi) => {
				pi.on("session_start", () => {
					pi.registerProvider("anthropic", { baseUrl: "http://localhost:8080/session-start" });
				});
			},
		]);

		await session.bindExtensions({});

		expect(session.model?.baseUrl).toBe("http://localhost:8080/session-start");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/session-start");

		session.dispose();
	});

	it("registers native pi-ai providers during extension loading", async () => {
		const session = await createSession([
			(pi) => {
				pi.registerProvider(nativeAnthropicProvider("http://localhost:8080/native-top-level"));
			},
		]);

		expect(session.model?.baseUrl).toBe("http://localhost:8080/native-top-level");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/native-top-level");

		session.dispose();
	});

	it("applies command-time registerProvider overrides without reload", async () => {
		const session = await createSession([
			(pi) => {
				pi.registerCommand("use-proxy", {
					description: "Use proxy",
					handler: async () => {
						pi.registerProvider("anthropic", { baseUrl: "http://localhost:8080/command" });
					},
				});
			},
		]);

		await session.bindExtensions({});
		await session.prompt("/use-proxy");

		expect(session.model?.baseUrl).toBe("http://localhost:8080/command");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/command");

		session.dispose();
	});

	it("registers native pi-ai providers at command time", async () => {
		const session = await createSession([
			(pi) => {
				pi.registerCommand("use-native", {
					description: "Use native provider",
					handler: async () => {
						pi.registerProvider(nativeAnthropicProvider("http://localhost:8080/native-command"));
					},
				});
			},
		]);

		await session.bindExtensions({});
		await session.prompt("/use-native");

		expect(session.model?.baseUrl).toBe("http://localhost:8080/native-command");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/native-command");

		session.dispose();
	});

	it("routes a registered harness through Pi's live extension tool and hooks", async () => {
		const captured: Record<string, unknown> = {};
		const lifecycle: string[] = [];
		const session = await createSession([
			(pi) => {
				pi.registerTool({
					name: "host_echo",
					label: "Host echo",
					description: "Echo through Pi",
					parameters: Type.Object({ value: Type.String() }),
					prepareArguments: (args) => ({ value: String((args as { legacy?: unknown }).legacy ?? "") }),
					async execute(_id, args, _signal, onUpdate) {
						captured.executedArgs = { ...args };
						onUpdate?.({
							content: [{ type: "text", text: `partial:${args.value}` }],
							details: { partial: true },
						});
						return { content: [{ type: "text", text: `tool:${args.value}` }], details: { value: args.value } };
					},
				});
				pi.on("tool_call", (event) => {
					(event.input as { value: string }).value += ":before";
				});
				pi.on("tool_result", () => ({
					content: [{ type: "text", text: "after-hook" }],
					details: { patched: true },
				}));
				pi.registerHarness("anthropic", (model, _context, options) => {
					captured.auth = options.auth.auth.apiKey;
					captured.cwd = options.cwd;
					captured.systemPrompt = options.systemPrompt;
					captured.contextMessages = options.agentContext.messages.length;
					captured.sessionId = options.session.getSessionId();
					const stream = new HarnessOutput(options.signal);
					queueMicrotask(async () => {
						const tool = options.tools.find((candidate) => candidate.name === "host_echo");
						if (!tool) throw new Error("host_echo was not supplied to the harness");
						const execution = await options.runTool({
							tool,
							args: { legacy: "raw" },
							callId: "vendor-call",
							stream,
						});
						captured.execution = execution;
						const message: AssistantMessage = {
							role: "assistant",
							content: execution.result.content.filter((part) => part.type === "text"),
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: {
								input: 1,
								output: 1,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 2,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "stop",
							timestamp: Date.now(),
						};
						stream.push({ type: "done", reason: "stop", message });
					});
					return stream;
				});
			},
		]);

		await session.bindExtensions({});
		session.setActiveToolsByName(["host_echo"]);
		const unsubscribe = session.subscribe((event) => {
			if (event.type.startsWith("tool_execution_")) lifecycle.push(event.type);
		});
		await session.prompt("exercise the host harness");
		unsubscribe();

		expect(captured).toMatchObject({
			auth: "test-key",
			cwd: tempDir,
			executedArgs: { value: "raw:before" },
			execution: {
				isError: false,
				result: { content: [{ type: "text", text: "after-hook" }], details: { patched: true } },
			},
		});
		expect(captured.systemPrompt).toEqual(expect.any(String));
		expect(captured.contextMessages).toBeGreaterThan(0);
		expect(captured.sessionId).toBe(session.sessionManager.getSessionId());
		expect(
			session.state.messages.some(
				(message) =>
					message.role === "assistant" &&
					message.content.some((block) => block.type === "toolCall" && block.id === "vendor-call"),
			),
		).toBe(true);
		expect(session.state.messages.find((message) => message.role === "toolResult")).toMatchObject({
			toolCallId: "vendor-call",
			content: [{ type: "text", text: "after-hook" }],
		});
		expect(lifecycle).toEqual(["tool_execution_start", "tool_execution_update", "tool_execution_end"]);
		expect(session.state.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "after-hook" }],
			stopReason: "stop",
		});

		session.dispose();
	});
});
