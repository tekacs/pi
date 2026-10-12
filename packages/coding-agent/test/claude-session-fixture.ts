import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { expect } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { CLAUDE_AGENT_SDK_API } from "../src/core/claude-agent-sdk-models.ts";
import { findBundledClaude, streamClaudeAgentSdk } from "../src/core/claude-agent-sdk-stream.ts";
import { convertToLlm } from "../src/core/messages.ts";
import type { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { nativeEnv } from "./claude-native-fixture.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

export const nativeModel = { ...getModel("anthropic", "claude-sonnet-4-5")!, api: CLAUDE_AGENT_SDK_API };
export async function nativeSession(
	manager: SessionManager,
	root: string,
	url: string,
	tool: AgentTool,
	prompt = "Local fixture.",
) {
	const cwd = manager.getCwd();
	const config = mkdtempSync(join(root, "config-"));
	const auth = AuthStorage.inMemory();
	await auth.modify(nativeModel.provider, async () => ({ type: "api_key", key: "local-test-key" }));
	const agent = new Agent({
		initialState: { model: nativeModel, messages: manager.buildSessionContext().messages, thinkingLevel: "high" },
		sessionId: manager.getSessionId(),
		convertToLlm,
		getApiKey: () => "local-test-key",
		streamFn: (requestModel, context, options) =>
			streamClaudeAgentSdk(requestModel, context, {
				...options,
				cwd,
				tools: agent.state.tools,
				nativeRoot: join(root, "native"),
				executable: findBundledClaude(process.env.PI_TEST_PACKAGE_DIR),
				agentContext: { messages: agent.state.messages, tools: agent.state.tools },
				beforeToolCall: agent.beforeToolCall,
				afterToolCall: agent.afterToolCall,
				steeringPending: () => agent.hasSteeringMessages(),
				env: nativeEnv(config, url),
			}),
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		cwd,
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
		modelRuntime: getModelRuntime(await createInMemoryModelRegistry(auth)),
		resourceLoader: { ...createTestResourceLoader(), getSystemPrompt: () => prompt },
		customTools: [tool],
		initialActiveToolNames: [tool.name],
	});
	const close = () => {
		cleanupSessionResources(manager.getSessionId());
		session.dispose();
	};
	return { agent, session, close, auth };
}

export function settled(session: AgentSession): void {
	const last = session.messages.at(-1);
	expect(last, JSON.stringify(last)).toMatchObject({ role: "assistant", stopReason: "stop" });
}
