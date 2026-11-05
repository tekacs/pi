import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../../src/core/agent-session-services.ts";
import { HarnessOutput } from "../../src/core/harness-output.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createHarness } from "./harness.ts";

it("does not prefetch a native harness past a commit before the session acknowledges it", async () => {
	const harness = await createHarness();
	const runtime = harness.session.modelRuntime;
	const model = harness.getModel();
	const unbind = runtime.registerAuthResolver(model.provider, async () => ({ auth: { apiKey: "test" } }));
	let committed = false;
	let session: AgentSession | undefined;
	try {
		runtime.registerHarness(model.provider, (_model, _context, options) => {
			const output = new HarnessOutput(options.signal);
			void (async () => {
				try {
					await output.commit(fauxAssistantMessage("persisted reply"));
					committed = true;
					output.push({ type: "done", reason: "stop", message: fauxAssistantMessage("") });
				} catch (error) {
					output.push({
						type: "error",
						reason: "error",
						error: {
							...fauxAssistantMessage(""),
							stopReason: "error",
							errorMessage: String(error),
						},
					});
				}
			})();
			return output;
		});
		const settings = SettingsManager.inMemory();
		settings.setRetryEnabled(false);
		settings.setCompactionEnabled(false);
		const services = await createAgentSessionServices({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
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
		session = (
			await createAgentSessionFromServices({
				services,
				sessionManager: SessionManager.inMemory(harness.tempDir),
				model,
				tools: [],
			})
		).session;
		await session.prompt("Reply once");
		expect(committed).toBe(true);
		expect(
			session.messages.some(
				(message) =>
					message.role === "assistant" &&
					message.content.some((block) => block.type === "text" && block.text === "persisted reply"),
			),
		).toBe(true);
		expect(session.messages.some((message) => message.role === "assistant" && message.stopReason === "error")).toBe(
			false,
		);
	} finally {
		session?.dispose();
		unbind();
		harness.cleanup();
	}
});
