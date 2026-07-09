import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it, vi } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { processResponsesStream } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

vi.mock("openai", () => {
	async function* createMockResponsesStream(): AsyncIterable<ResponseStreamEvent> {
		yield {
			type: "response.created",
			sequence_number: 0,
			response: { id: "resp_wrapper_early_eof" },
		} as ResponseStreamEvent;
		yield {
			type: "response.output_item.added",
			sequence_number: 1,
			output_index: 0,
			item: { type: "reasoning", id: "rs_wrapper_early_eof", summary: [] },
		} as ResponseStreamEvent;
		yield {
			type: "response.reasoning_text.delta",
			sequence_number: 2,
			output_index: 0,
			content_index: 0,
			item_id: "rs_wrapper_early_eof",
			delta: "partial reasoning before the wrapper stream ends",
		} as ResponseStreamEvent;
	}

	class FakeOpenAI {
		responses = {
			create: () => {
				const responseStream = createMockResponsesStream();
				const promise = Promise.resolve(responseStream) as Promise<AsyncIterable<ResponseStreamEvent>> & {
					withResponse: () => Promise<{
						data: AsyncIterable<ResponseStreamEvent>;
						response: { status: number; headers: Headers };
					}>;
				};
				promise.withResponse = async () => ({
					data: responseStream,
					response: { status: 200, headers: new Headers() },
				});
				return promise;
			},
		};
	}

	return { default: FakeOpenAI };
});

function createModel(): Model<"openai-responses"> {
	return {
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
}

function createOutput(model: Model<"openai-responses">): AssistantMessage {
	return {
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
		timestamp: Date.now(),
	};
}

async function* createEarlyEofEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.created",
		sequence_number: 0,
		response: { id: "resp_early_eof" },
	} as ResponseStreamEvent;
	yield {
		type: "response.output_item.added",
		sequence_number: 1,
		output_index: 0,
		item: { type: "reasoning", id: "rs_early_eof", summary: [] },
	} as ResponseStreamEvent;
	yield {
		type: "response.reasoning_text.delta",
		sequence_number: 2,
		output_index: 0,
		content_index: 0,
		item_id: "rs_early_eof",
		delta: "partial reasoning before the stream ends",
	} as ResponseStreamEvent;
}

async function* createCompletedEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.completed",
		sequence_number: 0,
		response: {
			id: "resp_completed",
			status: "completed",
			usage: {
				input_tokens: 20,
				output_tokens: 7,
				total_tokens: 27,
				input_tokens_details: { cached_tokens: 2, cache_write_tokens: 3 },
			},
		},
	} as unknown as ResponseStreamEvent;
}

async function* createIncompleteEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.incomplete",
		sequence_number: 0,
		response: {
			id: "resp_incomplete",
			status: "incomplete",
			usage: {
				input_tokens: 30,
				output_tokens: 12,
				total_tokens: 42,
				input_tokens_details: { cached_tokens: 5 },
			},
		},
	} as ResponseStreamEvent;
}

async function* createFailedEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.failed",
		sequence_number: 0,
		response: {
			id: "resp_failed",
			status: "failed",
			error: { code: "server_error", message: "boom" },
		},
	} as ResponseStreamEvent;
}

async function* createReasoningSummaryEvents(summaryTexts: string[]): AsyncIterable<ResponseStreamEvent> {
	const summary = summaryTexts.map((text) => ({ type: "summary_text" as const, text }));
	let sequenceNumber = 0;
	yield {
		type: "response.output_item.added",
		sequence_number: sequenceNumber++,
		output_index: 0,
		item: { type: "reasoning", id: "rs_summary", summary: [] },
	} as ResponseStreamEvent;

	for (let summaryIndex = 0; summaryIndex < summary.length; summaryIndex++) {
		const part = summary[summaryIndex];
		yield {
			type: "response.reasoning_summary_text.delta",
			sequence_number: sequenceNumber++,
			output_index: 0,
			item_id: "rs_summary",
			summary_index: summaryIndex,
			delta: part.text,
		} as ResponseStreamEvent;
		yield {
			type: "response.reasoning_summary_part.done",
			sequence_number: sequenceNumber++,
			output_index: 0,
			item_id: "rs_summary",
			summary_index: summaryIndex,
			part,
		} as ResponseStreamEvent;
	}

	yield {
		type: "response.output_item.done",
		sequence_number: sequenceNumber++,
		output_index: 0,
		item: { type: "reasoning", id: "rs_summary", summary, status: "completed" },
	} as ResponseStreamEvent;
	yield {
		type: "response.completed",
		sequence_number: sequenceNumber,
		response: {
			id: "resp_summary",
			status: "completed",
			usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
		},
	} as ResponseStreamEvent;
}

describe("OpenAI Responses terminal event handling", () => {
	it("rejects streams that end before a terminal response event", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		await expect(processResponsesStream(createEarlyEofEvents(), output, stream, model)).rejects.toThrow(
			"OpenAI Responses stream ended before a terminal response event",
		);
	});

	it("emits an error final result when the wrapper stream ends before a terminal response event", async () => {
		const model = createModel();
		const context: Context = {
			systemPrompt: "",
			messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
			tools: [],
		};
		const stream = streamOpenAIResponses(model, context, { apiKey: "test" });
		const events: AssistantMessageEvent[] = [];

		for await (const event of stream) {
			events.push(event);
		}

		const result = await stream.result();
		const lastEvent = events.at(-1);
		expect(lastEvent?.type).toBe("error");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("OpenAI Responses stream ended before a terminal response event");
	});

	it("finalizes completed terminal events as stop", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		await processResponsesStream(createCompletedEvents(), output, stream, model);

		expect(output.responseId).toBe("resp_completed");
		expect(output.stopReason).toBe("stop");
		expect(output.usage).toMatchObject({
			input: 15,
			output: 7,
			cacheRead: 2,
			cacheWrite: 3,
			totalTokens: 27,
		});
	});

	it("finalizes incomplete terminal events as length stops", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		await processResponsesStream(createIncompleteEvents(), output, stream, model);

		expect(output.responseId).toBe("resp_incomplete");
		expect(output.stopReason).toBe("length");
		expect(output.usage).toMatchObject({
			input: 25,
			output: 12,
			cacheRead: 5,
			cacheWrite: 0,
			totalTokens: 42,
		});
	});

	it("rejects failed terminal events with the provider error", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		await expect(processResponsesStream(createFailedEvents(), output, stream, model)).rejects.toThrow(
			"server_error: boom",
		);
	});

	it("removes placeholder-only reasoning summary parts", async () => {
		const summaryTexts = ["**Checking the first thing**\n\n<!-- -->", "**Checking the second thing**\n\n<!-- -->"];
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();
		const pushSpy = vi.spyOn(stream, "push");

		await processResponsesStream(createReasoningSummaryEvents(summaryTexts), output, stream, model);

		const thinkingDeltas = pushSpy.mock.calls.flatMap(([event]) =>
			event.type === "thinking_delta" ? [event.delta] : [],
		);
		expect(thinkingDeltas).toEqual([]);
		expect(output.content).toEqual([
			{
				type: "thinking",
				thinking: "",
				thinkingSignature: expect.any(String),
			},
		]);
		const thinking = output.content[0];
		if (thinking?.type !== "thinking" || !thinking.thinkingSignature) throw new Error("Expected signed thinking");
		const signature = JSON.parse(thinking.thinkingSignature) as { summary: Array<{ text: string }> };
		expect(signature.summary.map((part) => part.text)).toEqual(summaryTexts);
	});

	it("preserves real summaries and literal HTML comments while removing empty parts", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();
		const pushSpy = vi.spyOn(stream, "push");
		const summaryTexts = [
			"**Plan**\n\nUse `<!-- -->` in JSX.",
			"**Checking tests**\n\n<!-- -->",
			"**Result**\n\nTests passed",
			"<!-- -->",
		];

		await processResponsesStream(createReasoningSummaryEvents(summaryTexts), output, stream, model);

		const thinkingDeltas = pushSpy.mock.calls.flatMap(([event]) =>
			event.type === "thinking_delta" ? [event.delta] : [],
		);
		expect(thinkingDeltas).toEqual(["**Plan**\n\nUse `<!-- -->` in JSX.", "\n\n**Result**\n\nTests passed"]);
		expect(output.content[0]).toMatchObject({
			type: "thinking",
			thinking: "**Plan**\n\nUse `<!-- -->` in JSX.\n\n**Result**\n\nTests passed",
		});
	});
});
