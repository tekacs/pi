import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";

const googleGenAiMock = vi.hoisted(() => ({
	streamParams: [] as Array<Record<string, unknown>>,
	chunks: [] as Array<Record<string, unknown>>,
}));

vi.mock("@google/genai", () => {
	class GoogleGenAI {
		models = {
			generateContentStream: async function* (params: Record<string, unknown>) {
				googleGenAiMock.streamParams.push(params);
				for (const chunk of googleGenAiMock.chunks) {
					yield chunk;
				}
			},
		};
	}

	return {
		FinishReason: {
			STOP: "STOP",
			MAX_TOKENS: "MAX_TOKENS",
		},
		FunctionCallingConfigMode: {
			MODE_UNSPECIFIED: "MODE_UNSPECIFIED",
			AUTO: "AUTO",
			ANY: "ANY",
			NONE: "NONE",
			VALIDATED: "VALIDATED",
		},
		GoogleGenAI,
		ResourceScope: {
			COLLECTION: "COLLECTION",
		},
		ThinkingLevel: {
			THINKING_LEVEL_UNSPECIFIED: "THINKING_LEVEL_UNSPECIFIED",
			MINIMAL: "MINIMAL",
			LOW: "LOW",
			MEDIUM: "MEDIUM",
			HIGH: "HIGH",
		},
	};
});

import { GooglePartialArgsStream } from "../src/api/google-shared.ts";
import { stream as streamGoogleVertex } from "../src/api/google-vertex.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { AssistantMessageEvent, Tool } from "../src/types.ts";

const writeTool: Tool = {
	name: "write",
	description: "Write a file",
	parameters: Type.Object({
		path: Type.String(),
		content: Type.String(),
	}),
};

const editTool: Tool = {
	name: "edit",
	description: "Edit a file",
	parameters: Type.Object({
		path: Type.String(),
		edits: Type.Array(
			Type.Object({
				oldText: Type.String(),
				newText: Type.String(),
			}),
		),
		"a.b": Type.Optional(Type.String()),
	}),
};

const model = getModel("google-vertex", "gemini-4-argon");

beforeEach(() => {
	googleGenAiMock.streamParams.length = 0;
	googleGenAiMock.chunks = [];
});

describe("google-vertex streamFunctionCallArguments", () => {
	it("enables streamFunctionCallArguments and disables AFC for Gemini 3+ models with tools", async () => {
		googleGenAiMock.chunks = [
			{
				responseId: "v-stream-1",
				candidates: [
					{
						content: {
							parts: [
								{
									thoughtSignature: "AAAAAAAAAAAAAAAAAAAAAA==",
									functionCall: {
										name: "write",
										id: "call_1",
										willContinue: true,
									},
								},
							],
						},
					},
				],
			},
			{
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: {
										partialArgs: [
											{
												jsonPath: "$.content",
												stringValue: "hello ",
												willContinue: true,
											},
										],
										willContinue: true,
									},
								},
							],
						},
					},
				],
			},
			{
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: {
										partialArgs: [
											{
												jsonPath: "$.content",
												stringValue: "world",
												willContinue: true,
											},
										],
										willContinue: true,
									},
								},
							],
						},
					},
				],
			},
			{
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: {
										partialArgs: [
											{
												jsonPath: "$.content",
												stringValue: "",
											},
											{
												jsonPath: "$.path",
												stringValue: "/tmp/out.md",
												willContinue: true,
											},
										],
										willContinue: true,
									},
								},
							],
						},
					},
				],
			},
			{
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: {
										partialArgs: [
											{
												jsonPath: "$.path",
												stringValue: "",
											},
										],
										willContinue: true,
									},
								},
							],
						},
					},
				],
			},
			{
				candidates: [
					{
						content: {
							parts: [{ functionCall: {} }],
						},
						finishReason: "STOP",
					},
				],
				usageMetadata: {
					promptTokenCount: 100,
					candidatesTokenCount: 20,
					totalTokenCount: 120,
				},
			},
		];

		const context = normalizeContext({
			messages: [{ role: "user", content: "write file", timestamp: Date.now() }],
			tools: [writeTool],
		});

		const s = streamGoogleVertex(model, context, {
			project: "test-project",
			location: "global",
		});

		const events: AssistantMessageEvent[] = [];
		const partialSnapshots: Array<Record<string, unknown>> = [];
		const deltas: string[] = [];

		for await (const event of s) {
			events.push(event);
			if (event.type === "toolcall_delta") {
				deltas.push(event.delta);
				const block = event.partial.content[event.contentIndex];
				if (block?.type === "toolCall") {
					partialSnapshots.push(block.arguments);
				}
			}
		}

		const result = await s.result();
		expect(googleGenAiMock.streamParams).toHaveLength(1);
		expect(googleGenAiMock.streamParams[0]?.config).toMatchObject({
			automaticFunctionCalling: { disable: true },
			toolConfig: {
				functionCallingConfig: {
					streamFunctionCallArguments: true,
				},
			},
		});

		expect(events.filter((e) => e.type === "toolcall_start")).toHaveLength(1);
		expect(events.filter((e) => e.type === "toolcall_end")).toHaveLength(1);
		expect(deltas.length).toBeGreaterThan(2);
		expect(JSON.parse(deltas.join(""))).toEqual({
			content: "hello world",
			path: "/tmp/out.md",
		});

		// Each partial snapshot is a distinct immutable object showing growing content
		expect(partialSnapshots[0]).toEqual({ content: "hello " });
		expect(partialSnapshots[1]).toEqual({ content: "hello world" });
		expect(partialSnapshots[0]).not.toBe(partialSnapshots[1]);

		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			{
				type: "toolCall",
				id: "call_1",
				name: "write",
				arguments: {
					content: "hello world",
					path: "/tmp/out.md",
				},
				thoughtSignature: "AAAAAAAAAAAAAAAAAAAAAA==",
			},
		]);
	});

	it("assembles nested arrays, objects, container markers, and dotted schema keys", () => {
		const stream = new GooglePartialArgsStream(editTool.parameters);
		const chunks = [
			[{ jsonPath: "$.edits[0].newText", stringValue: "bar", willContinue: true }],
			[{ jsonPath: "$.edits[0].newText", stringValue: "" }],
			[{ jsonPath: "$.edits[0].oldText", stringValue: "foo", willContinue: true }],
			[{ jsonPath: "$.edits[0].oldText", stringValue: "" }],
			[{ jsonPath: "$.edits[0]{}" }, { jsonPath: "$.edits[]" }],
			[{ jsonPath: "$.a.b", stringValue: "dotted-value" }],
			[{ jsonPath: "$.path", stringValue: "src/index.ts" }],
		];

		let jsonText = "";
		for (const chunk of chunks) {
			const { delta } = stream.append(chunk);
			jsonText += delta;
		}
		const finished = stream.finish();
		jsonText += finished.delta;

		const expected = {
			edits: [{ newText: "bar", oldText: "foo" }],
			"a.b": "dotted-value",
			path: "src/index.ts",
		};
		expect(finished.arguments).toEqual(expected);
		expect(JSON.parse(jsonText)).toEqual(expected);
	});

	it("fails with an error when the stream cuts off before willContinue finishes", async () => {
		googleGenAiMock.chunks = [
			{
				responseId: "v-cutoff",
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: {
										name: "write",
										id: "call_cut",
										willContinue: true,
									},
								},
							],
						},
					},
				],
			},
			{
				candidates: [
					{
						content: {
							parts: [
								{
									functionCall: {
										partialArgs: [
											{
												jsonPath: "$.content",
												stringValue: "partial content",
												willContinue: true,
											},
										],
										willContinue: true,
									},
								},
							],
						},
					},
				],
			},
		];

		const context = normalizeContext({
			messages: [{ role: "user", content: "write file", timestamp: Date.now() }],
			tools: [writeTool],
		});

		const s = streamGoogleVertex(model, context, {
			project: "test-project",
			location: "global",
		});

		const events: AssistantMessageEvent[] = [];
		for await (const event of s) {
			events.push(event);
		}
		const result = await s.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("incomplete function call");
		expect(events.filter((e) => e.type === "toolcall_end")).toHaveLength(0);
		expect(result.content).toEqual([
			{
				type: "toolCall",
				id: "call_cut",
				name: "write",
				arguments: { content: "partial content" },
			},
		]);
	});
});
