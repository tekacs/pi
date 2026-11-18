import { describe, expect, it } from "vitest";
import { convertMessages, normalizeGoogleOutputAnsi } from "../src/api/google-shared.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// Gemini can attach `thoughtSignature` to a response part whose visible text is empty (e.g. a
// thought burst preceding a function call) and requires the signature echoed back on the next
// request. Dropping such blocks while rebuilding history silently breaks the reasoning chain:
// the model then intermittently ends a mid-task turn with a thought-only STOP and no tool call.
// These tests pin the rule: an empty text/thinking block is skipped only when it is UNSIGNED.

function makeModel(id = "gemini-3-pro-preview"): Model<"google-generative-ai"> {
	return {
		id,
		name: id,
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "https://example.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

const VALID_SIG = "AAAAAAAAAAAAAAAAAAAAAA==";

function makeContext(
	model: { api: string; provider: string; id: string },
	content: AssistantMessage["content"],
): Context {
	const now = Date.now();
	return {
		messages: [
			{ role: "user", content: "Hi", timestamp: now },
			{
				role: "assistant",
				content,
				api: model.api as AssistantMessage["api"],
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
				stopReason: "toolUse",
				timestamp: now,
			},
		],
	};
}

describe("google-shared convertMessages — signed empty blocks", () => {
	it("keeps a signed empty thinking block so its signature is echoed back", () => {
		const model = makeModel();
		const contents = convertMessages(
			model,
			normalizeContext(
				makeContext(model, [
					{ type: "thinking", thinking: "", thinkingSignature: VALID_SIG },
					{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
				]),
			),
		);
		const modelTurn = contents.find((c) => c.role === "model");
		const signed = modelTurn?.parts?.filter((p) => p.thoughtSignature === VALID_SIG) ?? [];
		expect(signed).toHaveLength(1);
		expect(signed[0]?.thought).toBe(true);
	});

	it("keeps a signed empty text block the same way", () => {
		const model = makeModel();
		const contents = convertMessages(
			model,
			normalizeContext(
				makeContext(model, [
					{ type: "text", text: "", textSignature: VALID_SIG },
					{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
				]),
			),
		);
		const modelTurn = contents.find((c) => c.role === "model");
		const signed = modelTurn?.parts?.filter((p) => p.thoughtSignature === VALID_SIG) ?? [];
		expect(signed).toHaveLength(1);
	});

	it("still drops unsigned empty blocks", () => {
		const model = makeModel();
		const contents = convertMessages(
			model,
			normalizeContext(
				makeContext(model, [
					{ type: "thinking", thinking: "" },
					{ type: "text", text: "   " },
					{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
				]),
			),
		);
		const modelTurn = contents.find((c) => c.role === "model");
		expect(modelTurn?.parts).toHaveLength(1);
		expect(modelTurn?.parts?.[0]?.functionCall).toBeTruthy();
	});

	it("still drops signed empty blocks from a different provider/model (signature unusable)", () => {
		const model = makeModel();
		const contents = convertMessages(
			model,
			normalizeContext(
				makeContext({ ...model, id: "other-model" }, [
					{ type: "thinking", thinking: "", thinkingSignature: VALID_SIG },
					{ type: "text", text: "", textSignature: VALID_SIG },
					{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
				]),
			),
		);
		const modelTurn = contents.find((c) => c.role === "model");
		expect(modelTurn?.parts).toHaveLength(1);
		expect(modelTurn?.parts?.[0]?.functionCall).toBeTruthy();
		expect(JSON.stringify(modelTurn)).not.toContain(VALID_SIG);
	});

	it("replays assistant SGR as printable \\e[...m while stripping bare broken SGR remnants in Google history", () => {
		const model = makeModel();
		const contents = convertMessages(
			model,
			normalizeContext(
				makeContext(model, [
					{
						type: "text",
						text: "\u001b[1;38;2;134;239;172mClean\u001b[0m and \u001b<0x1B>[1;38;2;245;205;120mBroken\u001b<0x1B>[0m and  [1;38;2;110;231;249mSpaceBroken [0m",
					},
				]),
			),
		);
		const modelTurn = contents.find((c) => c.role === "model");
		expect(modelTurn?.parts?.[0]?.text).toBe(
			"\\e[1;38;2;134;239;172mClean\\e[0m and \\e[1;38;2;245;205;120mBroken\\e[0m and  SpaceBroken ",
		);
	});

	it("strips raw ESC from tool results while preserving literal \\x1b[...] source code", () => {
		const model = makeModel();
		const now = Date.now();
		const contents = convertMessages(
			model,
			normalizeContext({
				messages: [
					{ role: "user", content: "run", timestamp: now },
					{
						role: "assistant",
						content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "echo" } }],
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
						stopReason: "toolUse",
						timestamp: now,
					},
					{
						role: "toolResult",
						toolCallId: "call_1",
						toolName: "bash",
						content: [{ type: "text", text: '\u001b[31mFAIL\u001b[0m const s = "\\x1b[4m";' }],
						isError: false,
						timestamp: now,
					},
				],
			}),
		);
		const toolTurn = contents.find((c) => c.parts?.some((p) => p.functionResponse));
		const output = (toolTurn?.parts?.[0]?.functionResponse?.response as { output?: string } | undefined)?.output;
		expect(output).toBe('FAIL const s = "\\x1b[4m";');
	});

	it("normalizes SentencePiece ESC+space+[ and malformed SGR prefixes in streamed Google output", () => {
		expect(
			normalizeGoogleOutputAnsi(
				"\u001b [1;38;2;134;239;172mA\u001b [0m \u001b<0x1B>[1mB\u001b\u001b[0m  [2;38;2;140;145;160mC [0m",
			),
		).toBe("\u001b[1;38;2;134;239;172mA\u001b[0m \u001b[1mB\u001b[0m  \u001b[2;38;2;140;145;160mC \u001b[0m");
	});
});
