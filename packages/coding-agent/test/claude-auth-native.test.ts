import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupSessionResources, normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_AGENT_SDK_MODELS, CLAUDE_AGENT_SDK_SUBSCRIPTION_AUTH } from "../src/core/claude-agent-sdk-models.ts";
import { findBundledClaude, streamClaudeAgentSdk } from "../src/core/claude-agent-sdk-stream.ts";
import { oauthFixture } from "./claude-oauth-fixture.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	cleanupSessionResources();
	while (cleanups.length) await cleanups.pop()!();
	vi.unstubAllEnvs();
});

describe("native subscription refresh on resumed history", () => {
	it.each([1, 3])(
		"renews once and writes back for %i simultaneous SDK children",
		async (count) => {
			vi.stubEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR", undefined);
			const directory = mkdtempSync(join(tmpdir(), "pi-oauth-"));
			cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
			const fixture = await oauthFixture(directory);
			cleanups.push(fixture.close);
			const executable = findBundledClaude(process.env.PI_TEST_PACKAGE_DIR);
			expect(executable, "installed native fixture executable").toBeDefined();
			const model = {
				...CLAUDE_AGENT_SDK_MODELS[0],
				id: "claude-sonnet-4-5",
				provider: "claude-agent-sdk-subscription",
			};
			const results = await Promise.all(
				Array.from({ length: count }, async (_, index) => {
					const context = normalizeContext({
						messages: [
							{ role: "user", content: "Earlier message", timestamp: 0 },
							{
								role: "assistant",
								content: [{ type: "text", text: "Earlier reply" }],
								api: model.api,
								provider: model.provider,
								model: model.id,
								timestamp: 1,
								stopReason: "stop",
								usage: {
									input: 0,
									output: 0,
									totalTokens: 0,
									cacheRead: 0,
									cacheWrite: 0,
									cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
								},
							},
							{ role: "user", content: "Continue", timestamp: 2 },
						],
					});
					const stream = streamClaudeAgentSdk(model, context, {
						cwd: directory,
						tools: [],
						agentContext: { messages: [], tools: [] },
						sessionId: `oauth-${index}`,
						apiKey: CLAUDE_AGENT_SDK_SUBSCRIPTION_AUTH,
						executable,
						env: fixture.env,
						signal: AbortSignal.timeout(45_000),
					});
					for await (const event of stream) if (event.type === "assistant_message_commit") event.acknowledge?.();
					return stream.result();
				}),
			);
			for (const result of results) {
				expect(result.stopReason, result.errorMessage).toBe("stop");
				expect(result.content).toEqual([{ type: "text", text: "Authenticated locally." }]);
			}
			expect(fixture.exchanges()).toBe(1);
			expect(fixture.failures).toEqual([]);
			expect(fixture.authorizations).toHaveLength(count);
			expect(fixture.authorizations.every((auth) => auth === "Bearer fresh-access")).toBe(true);
			const stored = JSON.parse(readFileSync(fixture.credentials, "utf8"));
			expect(stored).toMatchObject({
				claudeAiOauth: { accessToken: "fresh-access", refreshToken: "rotated-refresh" },
				unrelated: { keep: true },
			});
			expect(stored.claudeAiOauth.expiresAt).toBeGreaterThan(Date.now());
		},
		60_000,
	);
});
