import { describe, expect, it } from "vitest";
import { convertMessages as convertGoogleMessages, normalizeGoogleOutputAnsi } from "../src/api/google-shared.ts";
import { convertMessages as convertOpenAIMessages } from "../src/api/openai-completions.ts";
import { processResponsesStream } from "../src/api/openai-responses-shared.ts";
import { transformMessages } from "../src/api/transform-messages.ts";
import type { Api, AssistantMessage, Context, Model } from "../src/types.ts";
import {
	isGoogleFamilyModel,
	normalizeAssistantHistoryAnsi,
	normalizeOutputAnsi,
	OutputAnsiNormalizer,
} from "../src/utils/ansi-sgr.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const ESC = "\u001b";

function streamChunks(chunks: string[], healBareSgr = false): string {
	const normalizer = new OutputAnsiNormalizer({ healBareSgr });
	let out = "";
	for (const chunk of chunks) {
		out += normalizer.push(chunk);
	}
	out += normalizer.flush();
	return out;
}

function makeModel<TApi extends Api>(api: TApi, provider: string, id: string): Model<TApi> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
	};
}

function makeAssistantMessage(model: Model<Api>, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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
}

describe("OutputAnsiNormalizer", () => {
	it("translates printable \\e[...m in prose to real ESC SGR sequences", () => {
		const input = "Status: \\e[1;38;2;134;239;172mOK\\e[0m (\\e[2mready\\e[0m)";
		expect(normalizeOutputAnsi(input)).toBe(
			`Status: ${ESC}[1;38;2;134;239;172mOK${ESC}[0m (${ESC}[2mready${ESC}[0m)`,
		);
	});

	it("handles arbitrary 1-character chunk splits without losing or doubling ESC", () => {
		const input = `\\e[1;38;2;120;200;255mAlpha\\e[0m ${ESC}[1mBeta${ESC} [0m ${ESC}<0x1B>[2mGamma<0x1B>[0m`;
		const expected = `${ESC}[1;38;2;120;200;255mAlpha${ESC}[0m ${ESC}[1mBeta${ESC}[0m ${ESC}[2mGamma${ESC}[0m`;
		expect(streamChunks([...input], true)).toBe(expected);
	});

	it("never doubles ESC when raw ESC and [ arrive across chunk boundaries", () => {
		const chunks = [`Hello ${ESC}`, "[1;38;2;134;239;172mWorld", ESC, " [0m", ` ${ESC}`, `${ESC}[2mDim${ESC}`, "[0m"];
		expect(streamChunks(chunks, true)).toBe(`Hello ${ESC}[1;38;2;134;239;172mWorld${ESC}[0m ${ESC}[2mDim${ESC}[0m`);
		expect(normalizeGoogleOutputAnsi("[1;38;2;134;239;172mWorld", `Hello ${ESC}`)).toBe("[1;38;2;134;239;172mWorld");
		expect(normalizeGoogleOutputAnsi(" [0m", `World${ESC}`)).toBe("[0m");
	});

	it("preserves literal \\e[...m, \\x1b[...m, and bare SGR inside inline backticks", () => {
		const input =
			"Use `\\e[31mred\\e[0m` or ``\\x1b[1;32mgreen\\x1b[0m`` or `[0m` in code, then \\e[1mbold\\e[0m in prose.";
		const expected = `Use \`\\e[31mred\\e[0m\` or \`\`\\x1b[1;32mgreen\\x1b[0m\`\` or \`[0m\` in code, then ${ESC}[1mbold${ESC}[0m in prose.`;
		expect(normalizeOutputAnsi(input, { healBareSgr: true })).toBe(expected);
		expect(streamChunks([...input], true)).toBe(expected);
	});

	it("preserves literal ANSI escapes inside backtick and tilde fenced code blocks across chunks", () => {
		const input = [
			"\\e[1mBefore\\e[0m\n",
			"```ts\n",
			'const a = "\\x1b[31mred\\x1b[0m";\n',
			'const b = "\\e[1;38;2;100;200;255mcyan\\e[0m";\n',
			"const c = [0m;\n",
			"```\n",
			"\\e[2mMiddle\\e[0m\n",
			"~~~\n",
			"\\e[33myellow\\e[0m\n",
			"~~~\n",
			"\\e[1mAfter\\e[0m",
		].join("");

		const expected = [
			`${ESC}[1mBefore${ESC}[0m\n`,
			"```ts\n",
			'const a = "\\x1b[31mred\\x1b[0m";\n',
			'const b = "\\e[1;38;2;100;200;255mcyan\\e[0m";\n',
			"const c = [0m;\n",
			"```\n",
			`${ESC}[2mMiddle${ESC}[0m\n`,
			"~~~\n",
			"\\e[33myellow\\e[0m\n",
			"~~~\n",
			`${ESC}[1mAfter${ESC}[0m`,
		].join("");

		expect(normalizeOutputAnsi(input, { healBareSgr: true })).toBe(expected);
		// Split across awkward fence/escape boundaries.
		expect(streamChunks([...input], true)).toBe(expected);
	});

	it("supports nested 4-backtick fences and single-line triple-backtick inline spans", () => {
		const nested = ["````md\n", "```\n", "\\e[31mstill code\\e[0m\n", "```\n", "````\n", "\\e[1mOutside\\e[0m"].join(
			"",
		);
		expect(streamChunks([...nested], true)).toBe(
			`\`\`\`\`md\n\`\`\`\n\\e[31mstill code\\e[0m\n\`\`\`\n\`\`\`\`\n${ESC}[1mOutside${ESC}[0m`,
		);

		const inlineTriple = "```\\e[31mcode\\e[0m``` \\e[1mProse\\e[0m";
		expect(streamChunks([...inlineTriple], true)).toBe(`\`\`\`\\e[31mcode\\e[0m\`\`\` ${ESC}[1mProse${ESC}[0m`);
	});

	it("only heals bare SGR brackets when healBareSgr is enabled and after a prose boundary", () => {
		const input = " [1;38;2;110;231;249mColor [0m word[0m [100m";
		expect(normalizeOutputAnsi(input, { healBareSgr: true })).toBe(
			` ${ESC}[1;38;2;110;231;249mColor ${ESC}[0m word[0m [100m`,
		);
		expect(normalizeOutputAnsi(input, { healBareSgr: false })).toBe(input);
		// Chunk boundary after a word char must NOT trigger bare SGR healing.
		expect(streamChunks(["word", "[0m"], true)).toBe("word[0m");
	});

	it("identifies Google family models across direct and OpenRouter routes", () => {
		expect(isGoogleFamilyModel(makeModel("google-vertex", "google-vertex", "gemini-3-flash-preview"))).toBe(true);
		expect(isGoogleFamilyModel(makeModel("google-generative-ai", "google", "gemini-2.5-pro"))).toBe(true);
		expect(isGoogleFamilyModel(makeModel("openai-completions", "openrouter", "google/gemini-3-pro"))).toBe(true);
		expect(isGoogleFamilyModel(makeModel("openai-responses", "openai", "gpt-5"))).toBe(false);
		expect(isGoogleFamilyModel(makeModel("anthropic-messages", "anthropic", "claude-sonnet-4-5"))).toBe(false);
	});

	it("resets inline code mode across blank-line paragraph breaks without breaking single-newline inline spans", () => {
		const straySingle = "Paragraph 1 has a stray ` backtick.\n\nParagraph 2: \\e[1mBold\\e[0m";
		const expectedSingle = `Paragraph 1 has a stray \` backtick.\n\nParagraph 2: ${ESC}[1mBold${ESC}[0m`;
		expect(normalizeOutputAnsi(straySingle)).toBe(expectedSingle);
		expect(streamChunks([...straySingle])).toBe(expectedSingle);

		const strayCrlf = "First `unclosed\r\n  \r\nSecond \\e[2mDim\\e[0m";
		const expectedCrlf = `First \`unclosed\r\n  \r\nSecond ${ESC}[2mDim${ESC}[0m`;
		expect(normalizeOutputAnsi(strayCrlf)).toBe(expectedCrlf);
		expect(streamChunks([...strayCrlf])).toBe(expectedCrlf);

		const strayDouble = "Double ``unclosed\n\nRecovered \\e[1mOK\\e[0m";
		const expectedDouble = `Double \`\`unclosed\n\nRecovered ${ESC}[1mOK${ESC}[0m`;
		expect(normalizeOutputAnsi(strayDouble)).toBe(expectedDouble);
		expect(streamChunks([...strayDouble])).toBe(expectedDouble);

		// A valid multi-line inline span across a single newline must stay verbatim.
		const multiLineInline = "Inline `line1\n\\e[31mstill code\\e[0m` then \\e[1mProse\\e[0m";
		const expectedMultiLine = `Inline \`line1\n\\e[31mstill code\\e[0m\` then ${ESC}[1mProse${ESC}[0m`;
		expect(normalizeOutputAnsi(multiLineInline)).toBe(expectedMultiLine);
		expect(streamChunks([...multiLineInline])).toBe(expectedMultiLine);
	});

	it("clears unclosed backtick, fence, and pending buffer state on reset() between text blocks", () => {
		const normalizer = new OutputAnsiNormalizer();

		// Unclosed inline backtick in block 1 must not leak into block 2 after reset().
		const block1 = normalizer.push("Unclosed `inline \\e[31mraw\\e[0m") + normalizer.flush();
		expect(block1).toBe("Unclosed `inline \\e[31mraw\\e[0m");
		normalizer.reset();
		const block2 = normalizer.push("Block 2: \\e[1mStyled\\e[0m") + normalizer.flush();
		expect(block2).toBe(`Block 2: ${ESC}[1mStyled${ESC}[0m`);

		// Unclosed fenced block in block 3 must not leak into block 4 after reset().
		normalizer.reset();
		const block3 = normalizer.push("```ts\nconst s = '\\e[32mraw\\e[0m';") + normalizer.flush();
		expect(block3).toBe("```ts\nconst s = '\\e[32mraw\\e[0m';");
		normalizer.reset();
		const block4 = normalizer.push("Block 4: \\e[2mDim\\e[0m") + normalizer.flush();
		expect(block4).toBe(`Block 4: ${ESC}[2mDim${ESC}[0m`);
	});

	it("isolates multiple text blocks in streamed responses so an unclosed fence or backtick never leaks", async () => {
		const model = makeModel("openai-responses", "openai", "gpt-5");
		const output = makeAssistantMessage(model, "");
		output.content = [];
		const stream = new AssistantMessageEventStream();

		const events = [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.output_text.delta", output_index: 0, delta: "Block 1 `unclosed \\e[31mraw\\e[0m" },
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Block 1 `unclosed \\e[31mraw\\e[0m" }],
				},
			},
			{
				type: "response.output_item.added",
				output_index: 1,
				item: { type: "message", id: "msg_2", role: "assistant", status: "in_progress", content: [] },
			},
			{ type: "response.output_text.delta", output_index: 1, delta: "Block 2 \\e[1mBold\\e[0m" },
			{
				type: "response.output_item.done",
				output_index: 1,
				item: {
					type: "message",
					id: "msg_2",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Block 2 \\e[1mBold\\e[0m" }],
				},
			},
			{
				type: "response.completed",
				response: { id: "resp_1", status: "completed", output: [], usage: undefined },
			},
		];

		async function* source() {
			for (const event of events) {
				yield event as never;
			}
		}

		await processResponsesStream(source(), output, stream, model);
		expect(output.content).toHaveLength(2);
		expect(output.content[0]).toMatchObject({ type: "text", text: "Block 1 `unclosed \\e[31mraw\\e[0m" });
		expect(output.content[1]).toMatchObject({ type: "text", text: `Block 2 ${ESC}[1mBold${ESC}[0m` });
	});
});

describe("normalizeAssistantHistoryAnsi and provider replay round-trip", () => {
	it("round-trips \\e[...m -> terminal ESC -> \\e[...m while leaving code spans verbatim", () => {
		const authored = [
			"Result: \\e[1;38;2;134;239;172mPASS\\e[0m (`\\e[31mexample\\e[0m`)",
			"```sh",
			'printf "\\e[32mgreen\\e[0m"',
			"```",
		].join("\n");

		const terminal = normalizeOutputAnsi(authored);
		expect(terminal).toContain(`${ESC}[1;38;2;134;239;172mPASS${ESC}[0m`);
		expect(terminal).toContain("`\\e[31mexample\\e[0m`");
		expect(terminal).toContain('printf "\\e[32mgreen\\e[0m"');

		const replayed = normalizeAssistantHistoryAnsi(terminal);
		expect(replayed).toBe(authored);
	});

	it("replays assistant SGR as printable \\e[...m for Gemini, GPT, and Claude", () => {
		const gemini = makeModel("google-vertex", "google-vertex", "gemini-3-flash-preview");
		const gpt = makeModel("openai-completions", "openai", "gpt-5");
		const claude = makeModel("anthropic-messages", "anthropic", "claude-sonnet-4-5");
		const terminalText = `Header: ${ESC}[1;38;2;110;231;249mActive${ESC}[0m (\`\\x1b[31mcode\\x1b[0m\`)`;
		const expectedReplay = "Header: \\e[1;38;2;110;231;249mActive\\e[0m (`\\x1b[31mcode\\x1b[0m`)";

		const context: Context = {
			messages: [
				{ role: "user", content: "status", timestamp: 0 },
				makeAssistantMessage(gemini, terminalText),
				{ role: "user", content: "next", timestamp: 2 },
			],
		};

		// Gemini / Vertex replay
		const googleContents = convertGoogleMessages(gemini, normalizeContext(context));
		const googleModelTurn = googleContents.find((c) => c.role === "model");
		expect(googleModelTurn?.parts?.[0]?.text).toBe(expectedReplay);

		// OpenAI / OpenRouter replay
		const openaiMessages = convertOpenAIMessages(gpt, normalizeContext(context), {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			supportsUsageInStreaming: true,
			supportsFinishReason: true,
			maxTokensField: "max_tokens",
			requiresToolResultName: false,
			requiresAssistantAfterToolResult: false,
			requiresNonNullAssistantContent: false,
			requiresToolsWithToolHistory: false,
			requiresThinkingAsText: false,
			requiresReasoningContentOnAssistantMessages: false,
			thinkingFormat: "openai",
			openRouterRouting: {},
			vercelGatewayRouting: {},
			chatTemplateKwargs: {},
			chatTemplateArgs: {},
			zaiToolStream: false,
			supportsStrictMode: false,
			supportsOpenAIGrammarTools: false,
			sendSessionAffinityHeaders: false,
			sessionAffinityFormat: "openai",
			supportsLongCacheRetention: false,
		});
		const openaiAssistant = openaiMessages.find((m) => m.role === "assistant");
		expect(openaiAssistant?.content).toBe(expectedReplay);

		// Anthropic / Claude replay (via shared transformMessages)
		const claudeTransformed = transformMessages(context.messages, claude);
		const claudeAssistant = claudeTransformed.find((m) => m.role === "assistant") as AssistantMessage | undefined;
		expect(claudeAssistant?.content[0]).toEqual({ type: "text", text: expectedReplay });
	});
});
