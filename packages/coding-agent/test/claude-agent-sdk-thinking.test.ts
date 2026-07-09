import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { CLAUDE_AGENT_SDK_MODELS } from "../src/core/claude-agent-sdk-models.ts";
import { findBundledClaude, resolveSdkThinking, sdkSystemPrompt } from "../src/core/claude-agent-sdk-stream.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function model(id: string) {
	const found = CLAUDE_AGENT_SDK_MODELS.find((candidate) => candidate.id === id);
	if (!found) throw new Error(`Missing Claude Agent SDK model: ${id}`);
	return { ...found, provider: "claude-agent-sdk" };
}

describe("Claude Agent SDK thinking", () => {
	it.each(["sonnet", "opus", "fable", "claude-opus-5"])("exposes xhigh and max for %s", (id) => {
		expect(getSupportedThinkingLevels(model(id))).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
	});

	it("advertises Fable's 128K output limit", () => {
		expect(model("fable").maxTokens).toBe(128000);
	});

	it.each(["opus", "claude-opus-5"])("advertises Opus 5 metadata for %s", (id) => {
		expect(model(id)).toMatchObject({
			contextWindow: 1000000,
			maxTokens: 128000,
			cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		});
	});

	it("does not advertise unsupported high tiers for Haiku or pinned older models", () => {
		expect(getSupportedThinkingLevels(model("haiku"))).toEqual(["off", "minimal", "low", "medium", "high"]);
		expect(getSupportedThinkingLevels(model("claude-opus-4-5-20251101"))).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
		]);
	});

	it("preserves pi's system prompt when using subscription auth", () => {
		const systemPrompt = "Project context from AGENTS.md";

		expect(sdkSystemPrompt(systemPrompt, false)).toBe(systemPrompt);
		expect(sdkSystemPrompt(systemPrompt, true)).toEqual({
			type: "preset",
			preset: "claude_code",
			append: `${systemPrompt}\n\nYou are running inside pi. Use the exposed mcp__pi__* tools for workspace actions.`,
		});
	});

	it("omits only pi's documentation block from subscription prompts", () => {
		const systemPrompt = [
			"Generic tool list and usage guidelines",
			"Pi documentation (read only when the user asks about pi itself):\n- Triggering documentation details",
			"<project_context>\nAGENTS.md instructions\n</project_context>\n\n<available_skills>skills</available_skills>",
		].join("\n\n");

		expect(sdkSystemPrompt(systemPrompt, true)).toEqual({
			type: "preset",
			preset: "claude_code",
			append:
				"Generic tool list and usage guidelines\n\n<project_context>\nAGENTS.md instructions\n</project_context>\n\n<available_skills>skills</available_skills>\n\nYou are running inside pi. Use the exposed mcp__pi__* tools for workspace actions.",
		});
	});

	it("finds packaged Unix and Windows CLI sidecars", () => {
		const packageDir = mkdtempSync(join(tmpdir(), "pi-claude-sdk-"));
		tempDirs.push(packageDir);

		expect(findBundledClaude(packageDir, "darwin")).toBeUndefined();

		const nativeDir = join(packageDir, "native", "claude-agent-sdk");
		mkdirSync(nativeDir, { recursive: true });
		writeFileSync(join(nativeDir, "claude"), "");
		writeFileSync(join(nativeDir, "claude.exe"), "");

		expect(findBundledClaude(packageDir, "darwin")).toBe(join(nativeDir, "claude"));
		expect(findBundledClaude(packageDir, "win32")).toBe(join(nativeDir, "claude.exe"));
	});

	it("maps pi thinking levels to Claude Agent SDK controls", () => {
		const opus = model("opus");

		expect(resolveSdkThinking(opus, undefined)).toEqual({
			thinking: { type: "disabled" },
			effort: undefined,
			extraArgs: undefined,
		});
		expect(resolveSdkThinking(opus, "minimal")).toEqual({
			thinking: undefined,
			effort: "low",
			extraArgs: { "thinking-display": "summarized" },
		});
		expect(resolveSdkThinking(opus, "xhigh")).toEqual({
			thinking: undefined,
			effort: "xhigh",
			extraArgs: { "thinking-display": "summarized" },
		});
		expect(resolveSdkThinking(opus, "max")).toEqual({
			thinking: undefined,
			effort: "max",
			extraArgs: { "thinking-display": "summarized" },
		});
	});
});
