import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	normalizeContext,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../../src/core/agent-session-services.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createHarness } from "./harness.ts";

it.each([false, true])("borrows runtime and affinity without sharing session resources (native=%s)", async (native) => {
	const parent = await createHarness();
	const registry = parent.session.extensionRunner.createContext().modelRegistry;
	const runtime = registry.runtime;
	const model = parent.getModel();
	if (native)
		runtime.registerHarness(model.provider, (model, context, options) =>
			runtime.streamSimple(model, context, options),
		);
	const unbind = registry.registerAuthResolver(model.provider, async () => ({ auth: { apiKey: "shared-binding" } }));
	let child: AgentSession | undefined;
	try {
		expect(runtime).toBe(parent.session.modelRuntime);
		const provider = runtime.getRegisteredProviderConfig(model.provider);
		const settings = SettingsManager.inMemory();
		settings.setCompactionEnabled(false);
		settings.setRetryEnabled(false);
		const services = await createAgentSessionServices({
			cwd: parent.tempDir,
			agentDir: parent.tempDir,
			modelRuntime: runtime,
			settingsManager: settings,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		expect(services.modelRuntime).toBe(runtime);
		expect(runtime.getRegisteredProviderConfig(model.provider)).toEqual(provider);
		child = (
			await createAgentSessionFromServices({
				services,
				sessionManager: SessionManager.inMemory(parent.tempDir),
				model,
				cacheKey: parent.session.cacheKey,
				tools: [],
			})
		).session;
		expect(child.sessionId).not.toBe(parent.session.sessionId);
		expect(parent.session.cacheKey).toBe(parent.session.sessionId);
		expect(child.cacheKey).toBe(parent.session.cacheKey);
		const childContext = child.extensionRunner.createContext();
		expect(childContext.cacheKey).toBe(parent.session.cacheKey);
		expect(child.modelRuntime).toBe(runtime);
		expect(child.getCallableToolNames()).toEqual([]);
		const parentMessages = structuredClone(parent.session.messages);
		const requests: Array<SimpleStreamOptions | undefined> = [];
		const respond: FauxResponseFactory = (_context, options) => {
			requests.push(options);
			return fauxAssistantMessage("child response");
		};
		const requestCount = native ? 3 : 4;
		parent.setResponses(Array(requestCount).fill(respond));
		const candidate = [{ role: "user" as const, content: "A separate conversation", timestamp: 1 }];
		const count = await child.countContextTokens(candidate);
		expect(count.ok).toBe(!native);
		if (!count.ok) expect(count.message).toContain("measurement is unsupported");
		await child.prompt("A separate conversation");
		expect(child.getLastAssistantText()).toBe("child response");
		for (const request of requests) {
			expect(request?.sessionId).toBe(child.sessionId);
			expect(request?.cacheKey).toBe(parent.session.cacheKey);
		}
		await (
			await child.agent.streamFunction(model, normalizeContext({ messages: candidate }), { sessionId: "summary" })
		).result();
		await (
			await child.agent.streamFunction(model, normalizeContext({ messages: candidate }), {
				sessionId: child.sessionId,
				cacheKey: "explicit",
			})
		).result();
		expect(requests).toHaveLength(requestCount);
		expect(requests.map((request) => request?.apiKey)).toEqual(Array(requestCount).fill("shared-binding"));
		expect(requests.at(-2)?.cacheKey).toBeUndefined();
		expect(requests.at(-1)?.cacheKey).toBe("explicit");
		expect(parent.session.messages).toEqual(parentMessages);
		child.dispose();
		expect(() => childContext.cacheKey).toThrow();
		child = undefined;
		expect(runtime.getRegisteredProviderConfig(model.provider)).toEqual(provider);
		expect((await runtime.getAuth(model))?.auth.apiKey).toBe("shared-binding");
		expect(parent.session.messages).toEqual(parentMessages);
	} finally {
		child?.dispose();
		unbind();
		parent.cleanup();
	}
});
